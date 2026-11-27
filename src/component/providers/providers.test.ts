import { afterEach, describe, expect, type Mock, test, vi } from "vitest";
import {
  decryptWebPush,
  generateP8,
  generateRsa,
  generateSubscription,
  generateVapid,
  reply,
  verifyJwt,
} from "../../testing/fixtures.js";
import { toBytes } from "../crypto/codec.js";
import type { Sealed } from "../crypto/token_seal.js";
import { actionDeps, type Job, parseSendResult, runSender, type SenderDeps } from "../senders.js";
import { apnsHeaders, apnsHost, classifyApns, sendApns } from "./apns.js";
import { classifyFcm, mintGoogleToken, sendFcm } from "./fcm.js";
import { backoffDelay, parseRetryAfter, providerFetch, readJson } from "./http.js";
import { isConfigured, type PushEnv, readApns, readFcm, readVapid } from "./keys.js";
import {
  buildApnsPayload,
  buildFcmMessage,
  buildWebPushPayload,
  deepMerge,
  findOversize,
  isSilent,
  parseRawJson,
  type PushContent,
} from "./payload.js";
import { createTokenCache, type StoredToken, type TokenCache, type TokenSlot, type TokenStorage } from "./token_cache.js";
import { classifyWebPush, sendWebPush, webPushTopic } from "./web_push.js";

const NOW = 1_800_000_000_000;
const now = (): number => NOW;
const content = (over: Partial<PushContent> = {}): PushContent => ({
  title: "Support replied",
  body: "Ticket 42",
  data: { ticketRef: "42", count: 2, urgent: true },
  options: { priority: "high", ttlSeconds: 3600 },
  ...over,
});

/** In-memory token storage that behaves like the storeToken mutation. */
function memoryStorage(clock: () => number = now): TokenStorage & { rows: Map<string, StoredToken & { mintedAt: number }> } {
  const rows = new Map<string, StoredToken & { mintedAt: number }>();
  const key = (slot: TokenSlot): string => `${slot.credentialRef}|${slot.audience ?? ""}`;
  return {
    rows,
    load: async (slot) => rows.get(key(slot)) ?? null,
    store: async (slot, row): Promise<Sealed> => {
      const existing = rows.get(key(slot));
      if (existing && existing.refreshAfter > clock()) return existing;
      rows.set(key(slot), row);
      return row;
    },
    drop: async (slot) => {
      rows.delete(key(slot));
    },
  };
}

type FetchMock = Mock<(url: string, init: RequestInit) => Promise<Response>>;

function stubFetch(...responses: (Error | Response)[]): FetchMock {
  const fn: FetchMock = vi.fn(async () => {
    const next = responses.shift() ?? reply(500);
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The url and init of one recorded fetch call. */
function fetchCall(mock: FetchMock, index: number): [string, RequestInit] {
  const call = mock.mock.calls[index];
  if (!call) throw new Error(`no fetch call ${String(index)}`);
  return call;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("payload builders", () => {
  test("APNs: alert, data beside aps, typed overrides, rawJson merged last", () => {
    const payload = buildApnsPayload(
      content({
        options: { priority: "high", badge: 3, sound: "ping", category: "REPLY" },
        overrides: { apns: { threadId: "42", interruptionLevel: "time-sensitive", mutableContent: true, rawJson: '{"aps":{"relevance-score":0.8}}' } },
      }),
    );
    expect(payload).toEqual({
      ticketRef: "42",
      count: 2,
      urgent: true,
      aps: {
        alert: { title: "Support replied", body: "Ticket 42" },
        badge: 3,
        sound: "ping",
        category: "REPLY",
        "thread-id": "42",
        "interruption-level": "time-sensitive",
        "mutable-content": 1,
        "relevance-score": 0.8,
      },
    });
    expect(buildApnsPayload(content({ title: undefined, body: undefined, data: {} }))).toEqual({ aps: { "content-available": 1 } });
  });

  test("FCM: strings for data, android options, data-only when silent, rawJson cannot retarget", () => {
    const message = buildFcmMessage(
      content({
        options: { priority: "normal", collapseKey: "ticket:42", sound: "ping", category: "support" },
        overrides: { fcm: { channelId: "replies", rawJson: '{"android":{"notification":{"color":"#ff0000"}},"topic":"all","condition":"x"}' } },
      }),
      "device-token",
      60,
    );
    expect(message).toEqual({
      notification: { title: "Support replied", body: "Ticket 42" },
      data: { ticketRef: "42", count: "2", urgent: "true" },
      android: { priority: "NORMAL", ttl: "60s", collapse_key: "ticket:42", notification: { sound: "ping", channel_id: "replies", color: "#ff0000" } },
      token: "device-token",
    });
    expect(buildFcmMessage(content({ title: undefined, body: undefined, data: {} }), "t", 0)).toEqual({
      android: { priority: "HIGH", ttl: "0s" },
      token: "t",
    });
    expect(buildFcmMessage(content({ options: { priority: "high" } }), "t", 1).android).toEqual({ priority: "HIGH", ttl: "1s" });
  });

  test("Web Push: JSON for the service worker", () => {
    expect(
      buildWebPushPayload(
        content({ options: { priority: "high", badge: 1, collapseKey: "k" }, overrides: { webpush: { icon: "/i.png", url: "/t/42", rawJson: '{"actions":[]}' } } }),
      ),
    ).toEqual({
      title: "Support replied",
      body: "Ticket 42",
      data: { ticketRef: "42", count: 2, urgent: true },
      icon: "/i.png",
      url: "/t/42",
      badge: 1,
      tag: "k",
      actions: [],
    });
  });

  test("rawJson parsing, merging and silence", () => {
    expect(parseRawJson(undefined)).toBeUndefined();
    expect(parseRawJson("[1]")).toBeNull();
    expect(parseRawJson("{bad")).toBeNull();
    expect(parseRawJson(`{"a":"${"x".repeat(5000)}"}`)).toBeNull();
    expect(deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { b: 3 }, d: [2], e: null })).toEqual({ a: { b: 3, c: 2 }, d: [2], e: null });
    expect(isSilent({ title: "", body: "" })).toBe(true);
    expect(isSilent({ body: "x" })).toBe(false);
  });

  test("size is checked per platform after rawJson is merged", () => {
    const all = new Set(["apns", "fcm", "webpush"]);
    expect(findOversize(content(), all)).toBeNull();
    expect(findOversize(content({ options: { priority: "high" } }), all)).toBeNull();
    const big = `{"pad":"${"x".repeat(4000)}"}`;
    expect(findOversize(content({ overrides: { apns: { rawJson: big } } }), all)).toMatchObject({ platform: "apns", limit: 4096 });
    expect(findOversize(content({ overrides: { apns: { rawJson: big } } }), new Set(["fcm"]))).toBeNull();
    expect(findOversize(content({ overrides: { fcm: { rawJson: big } } }), all)).toMatchObject({ platform: "fcm" });
    const nearLimit = `{"pad":"${"x".repeat(3990)}"}`;
    expect(findOversize(content({ data: {}, title: undefined, overrides: { webpush: { rawJson: nearLimit } } }), all)).toMatchObject({
      platform: "webpush",
      limit: 3993,
    });
  });
});

describe("http helpers", () => {
  test("Retry-After as seconds or a date, clamped", () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter("120", NOW)).toBe(120_000);
    expect(parseRetryAfter("0", NOW)).toBe(1000);
    expect(parseRetryAfter(new Date(NOW + 30_000).toUTCString(), NOW)).toBe(30_000);
    expect(parseRetryAfter("9999999", NOW)).toBe(86_400_000);
    expect(parseRetryAfter("soon", NOW)).toBeUndefined();
  });

  test("backoff starts at one minute and doubles, capped at 30 minutes", () => {
    expect([0, 1, 2, 3, 10].map((n) => backoffDelay(n))).toEqual([60_000, 60_000, 120_000, 240_000, 1_800_000]);
  });

  test("a network error and a timeout become retries", async () => {
    stubFetch(new TypeError("connection reset"));
    expect(await providerFetch("https://x.test", {})).toEqual({ ok: false, result: { status: "retry", code: "NETWORK_ERROR" } });
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    );
    const pending = providerFetch("https://x.test", {});
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toEqual({ ok: false, result: { status: "retry", code: "TIMEOUT" } });
    expect(await readJson(reply(200, "not json"))).toBeNull();
  });
});

describe("keys from component env", () => {
  test("presence and parsing", async () => {
    expect(isConfigured({}, "apns")).toBe(false);
    expect(isConfigured({ APNS_TEAM_ID: "T", APNS_SANDBOX_KEY_P8: "k", APNS_SANDBOX_KEY_ID: "S" }, "apns")).toBe(true);
    expect(isConfigured({ FCM_SERVICE_ACCOUNT_JSON: "{}" }, "fcm")).toBe(true);
    expect(isConfigured({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b" }, "webpush")).toBe(false);
    const env: PushEnv = { APNS_TEAM_ID: "T", APNS_KEY_P8: "main", APNS_KEY_ID: "M", APNS_SANDBOX_KEY_P8: "sand", APNS_SANDBOX_KEY_ID: "S" };
    expect(await readApns(env, "sandbox")).toMatchObject({ ok: true, value: { pemText: "sand", keyId: "S" } });
    expect(await readApns(env, "production")).toMatchObject({ ok: true, value: { pemText: "main", keyId: "M" } });
    expect(await readApns({ APNS_TEAM_ID: "T", APNS_KEY_P8: "main", APNS_KEY_ID: "M" }, "sandbox")).toMatchObject({ value: { keyId: "M" } });
    expect(await readApns({}, "production")).toEqual({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
    expect(await readFcm({})).toEqual({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
    expect(await readFcm({ FCM_SERVICE_ACCOUNT_JSON: "not json" })).toEqual({ ok: false, code: "CREDENTIALS_INVALID" });
    expect(await readFcm({ FCM_SERVICE_ACCOUNT_JSON: "[]" })).toEqual({ ok: false, code: "CREDENTIALS_INVALID" });
    expect(await readFcm({ FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: "p", client_email: "e", private_key: "k", token_uri: "http://x" }) })).toEqual({
      ok: false,
      code: "CREDENTIALS_INVALID",
    });
    expect(await readFcm({ FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: "p", client_email: "e", private_key: "k", private_key_id: "kid" }) })).toMatchObject({
      ok: true,
      value: { tokenUri: "https://oauth2.googleapis.com/token" },
    });
    expect(await readFcm({ FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: "p", client_email: "e", private_key: "k" }) })).toMatchObject({ ok: true });
    expect(await readVapid({})).toEqual({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
    expect(await readVapid({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b", VAPID_SUBJECT: "someone" })).toEqual({ ok: false, code: "CREDENTIALS_INVALID" });
    expect(await readVapid({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b", VAPID_SUBJECT: "https://example.com" })).toMatchObject({ ok: true });
  });
});

describe("token cache", () => {
  test("reuses until refreshAfter, refreshes after, falls back to an unexpired token when a refresh fails", async () => {
    let clock = NOW;
    const storage = memoryStorage(() => clock);
    const cache = createTokenCache(storage, () => clock);
    const slot = { credentialRef: "ref" };
    let n = 0;
    const mint = vi.fn(async () => ({ ok: true as const, token: `token-${String(++n)}`, refreshAfter: clock + 1000, expiresAt: clock + 2000 }));
    expect(await cache.get(slot, "secret", mint)).toEqual({ ok: true, token: "token-1" });
    expect(await cache.get(slot, "secret", mint)).toEqual({ ok: true, token: "token-1" });
    expect(mint).toHaveBeenCalledTimes(1);
    const stored = storage.rows.get("ref|");
    expect(new TextDecoder().decode(toBytes(stored?.cipher ?? new ArrayBuffer(0)))).not.toContain("token-1");
    clock += 1500;
    const failing = async () => ({ ok: false as const, result: { status: "retry" as const, code: "X" } });
    expect(await cache.get(slot, "secret", failing)).toEqual({ ok: true, token: "token-1" });
    clock += 1000;
    expect(await cache.get(slot, "secret", failing)).toEqual({ ok: false, result: { status: "retry", code: "X" } });
    expect(await cache.get(slot, "secret", mint)).toEqual({ ok: true, token: "token-2" });
    await cache.drop(slot);
    expect(storage.rows.size).toBe(0);
  });

  test("two senders minting at once converge on the first stored token", async () => {
    const storage = memoryStorage();
    const a = createTokenCache(storage, now);
    const b = createTokenCache(storage, now);
    const slot = { credentialRef: "ref", audience: "https://push.example" };
    const minted = (token: string) => async () => ({ ok: true as const, token, refreshAfter: NOW + 1000, expiresAt: NOW + 2000 });
    const [first, second] = await Promise.all([a.get(slot, "s", minted("A")), b.get(slot, "s", minted("B"))]);
    expect(first).toEqual(second);
    expect(storage.rows.size).toBe(1);
  });

  test("a stored token that cannot be opened (another secret) falls back to the one just minted", async () => {
    const storage: TokenStorage = { ...memoryStorage(), store: async () => ({ cipher: new ArrayBuffer(32), iv: new ArrayBuffer(12) }) };
    const cache = createTokenCache(storage, now);
    const minted = async () => ({ ok: true as const, token: "A", refreshAfter: NOW + 1000, expiresAt: NOW + 2000 });
    expect(await cache.get({ credentialRef: "ref" }, "s", minted)).toEqual({ ok: true, token: "A" });
  });
});

function fakeCache(token = "cached-token"): TokenCache & { drop: ReturnType<typeof vi.fn> } {
  return {
    get: async (_slot, _secret, mint) => {
      const minted = await mint();
      return minted.ok ? { ok: true, token } : minted;
    },
    drop: vi.fn(async () => {}),
  };
}

describe("APNs sender", () => {
  const job = { messageId: "msg1", token: "abc123", topic: "com.example.app", environment: "sandbox" as const, content: content(), expiresAt: NOW + 3_600_000 };

  test("headers and hosts", () => {
    expect(apnsHost("production")).toBe("api.push.apple.com");
    expect(apnsHeaders(job, "jwt")).toEqual({
      authorization: "bearer jwt",
      "apns-topic": "com.example.app",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor((NOW + 3_600_000) / 1000)),
      "apns-collapse-id": "msg1",
      "content-type": "application/json",
    });
    const silent = apnsHeaders({ ...job, content: content({ title: undefined, body: undefined, options: { priority: "high", ttlSeconds: 0, collapseKey: "k" } }) }, "jwt");
    expect(silent).toMatchObject({ "apns-push-type": "background", "apns-priority": "5", "apns-expiration": "0", "apns-collapse-id": "k" });
  });

  test("classifies recorded responses", () => {
    const h = (o: Record<string, string> = {}): Headers => new Headers(o);
    expect(classifyApns(200, h({ "apns-id": "eabeae54" }), null, NOW)).toEqual({ status: "sent", providerMessageId: "eabeae54", httpStatus: 200 });
    expect(classifyApns(200, h(), null, NOW)).toEqual({ status: "sent", providerMessageId: undefined, httpStatus: 200 });
    expect(classifyApns(400, h(), { reason: "BadDeviceToken" }, NOW)).toEqual({ status: "invalid", code: "BadDeviceToken", httpStatus: 400, invalidSince: undefined });
    expect(classifyApns(410, h(), { reason: "Unregistered", timestamp: 1234 }, NOW)).toEqual({ status: "invalid", code: "Unregistered", httpStatus: 410, invalidSince: 1234 });
    expect(classifyApns(400, h(), { reason: "BadTopic" }, NOW)).toEqual({ status: "failed", code: "BadTopic", httpStatus: 400 });
    expect(classifyApns(403, h(), { reason: "ExpiredProviderToken" }, NOW)).toEqual({ status: "retry", code: "ExpiredProviderToken", httpStatus: 403 });
    expect(classifyApns(403, h(), { reason: "InvalidProviderToken" }, NOW).status).toBe("failed");
    expect(classifyApns(413, h(), { reason: "PayloadTooLarge" }, NOW).status).toBe("failed");
    expect(classifyApns(429, h({ "retry-after": "30" }), { reason: "TooManyRequests" }, NOW)).toEqual({ status: "retry", code: "TooManyRequests", httpStatus: 429, delayMs: 30_000 });
    expect(classifyApns(503, h(), { reason: "ServiceUnavailable" }, NOW)).toEqual({ status: "retry", code: "ServiceUnavailable", httpStatus: 503, delayMs: 900_000 });
    expect(classifyApns(502, h(), "garbage", NOW)).toMatchObject({ status: "retry", code: "HTTP_502" });
  });

  test("signs a token with the .p8 key and posts to the right host", async () => {
    const p8 = await generateP8();
    const env = { APNS_KEY_P8: p8.pem, APNS_KEY_ID: "KEYID", APNS_TEAM_ID: "TEAMID" };
    const fetchMock = stubFetch(reply(200, "", { "apns-id": "id-1" }));
    let signed = "";
    const cache: TokenCache = {
      get: async (_slot, _secret, mint) => {
        const minted = await mint();
        if (minted.ok) signed = minted.token;
        return minted.ok ? { ok: true, token: minted.token } : minted;
      },
      drop: async () => {},
    };
    expect(await sendApns(job, env, cache, now)).toEqual({ status: "sent", providerMessageId: "id-1", httpStatus: 200 });
    const verified = await verifyJwt(signed, p8.publicKey);
    expect(verified).toMatchObject({ valid: true, header: { alg: "ES256", kid: "KEYID" }, claims: { iss: "TEAMID", iat: NOW / 1000 } });
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("https://api.sandbox.push.apple.com/3/device/abc123");
    expect(JSON.parse(String(init.body))).toMatchObject({ aps: { alert: { title: "Support replied" } } });
  });

  test("drops the cached token on ExpiredProviderToken; refuses a broken key; reports missing keys", async () => {
    const p8 = await generateP8();
    const env = { APNS_KEY_P8: p8.pem, APNS_KEY_ID: "K", APNS_TEAM_ID: "T" };
    stubFetch(reply(403, { reason: "ExpiredProviderToken" }));
    const cache = fakeCache();
    expect(await sendApns(job, env, cache, now)).toMatchObject({ status: "retry", code: "ExpiredProviderToken" });
    expect(cache.drop).toHaveBeenCalledTimes(1);
    expect(await sendApns(job, { ...env, APNS_KEY_P8: "garbage" }, fakeCache(), now)).toEqual({ status: "failed", code: "CREDENTIALS_INVALID" });
    expect(await sendApns(job, {}, fakeCache(), now)).toEqual({ status: "failed", code: "PROVIDER_NOT_CONFIGURED" });
    stubFetch(new TypeError("reset"));
    expect(await sendApns(job, env, fakeCache(), now)).toEqual({ status: "retry", code: "NETWORK_ERROR" });
  });
});

describe("FCM sender", () => {
  async function serviceAccount(): Promise<{ env: PushEnv; publicKey: CryptoKey }> {
    const rsa = await generateRsa();
    const json = JSON.stringify({ project_id: "demo-project", client_email: "svc@demo.example", private_key: rsa.pem, private_key_id: "k1" });
    return { env: { FCM_SERVICE_ACCOUNT_JSON: json }, publicKey: rsa.publicKey };
  }

  test("classifies recorded responses", () => {
    const h = (o: Record<string, string> = {}): Headers => new Headers(o);
    const err = (status: string, details: unknown[] = []) => ({ error: { status, details } });
    expect(classifyFcm(200, h(), { name: "projects/p/messages/1" }, NOW)).toEqual({ status: "sent", providerMessageId: "projects/p/messages/1", httpStatus: 200 });
    expect(classifyFcm(200, h(), {}, NOW)).toMatchObject({ status: "sent", providerMessageId: undefined });
    const fcmError = (code: string) => ({ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: code });
    expect(classifyFcm(404, h(), err("NOT_FOUND", [fcmError("UNREGISTERED")]), NOW)).toEqual({ status: "invalid", code: "UNREGISTERED", httpStatus: 404 });
    const badToken = err("INVALID_ARGUMENT", [fcmError("INVALID_ARGUMENT"), { fieldViolations: [{ field: "message.token" }] }]);
    expect(classifyFcm(400, h(), badToken, NOW)).toEqual({ status: "invalid", code: "INVALID_ARGUMENT", httpStatus: 400 });
    expect(classifyFcm(400, h(), err("INVALID_ARGUMENT", [{ fieldViolations: [{ field: "message.android.ttl" }] }]), NOW)).toEqual({ status: "failed", code: "INVALID_ARGUMENT", httpStatus: 400 });
    expect(classifyFcm(429, h(), err("RESOURCE_EXHAUSTED", [fcmError("QUOTA_EXCEEDED")]), NOW)).toEqual({ status: "retry", code: "QUOTA_EXCEEDED", httpStatus: 429, delayMs: 60_000 });
    expect(classifyFcm(503, h({ "retry-after": "20" }), err("UNAVAILABLE", [fcmError("UNAVAILABLE")]), NOW)).toEqual({ status: "retry", code: "UNAVAILABLE", httpStatus: 503, delayMs: 20_000 });
    expect(classifyFcm(401, h(), err("UNAUTHENTICATED"), NOW)).toEqual({ status: "retry", code: "UNAUTHENTICATED", httpStatus: 401 });
    expect(classifyFcm(403, h(), "x", NOW)).toEqual({ status: "failed", code: "HTTP_403", httpStatus: 403 });
  });

  test("exchanges an RS256 assertion for an access token, then sends", async () => {
    const { env, publicKey } = await serviceAccount();
    const fetchMock = stubFetch(reply(200, { access_token: "ya29.fake", expires_in: 3599 }), reply(200, { name: "projects/demo-project/messages/7" }));
    const cache = createTokenCache(memoryStorage(), now);
    const result = await sendFcm({ token: "fcm-token", content: content(), expiresAt: NOW + 600_000 }, env, cache, now);
    expect(result).toEqual({ status: "sent", providerMessageId: "projects/demo-project/messages/7", httpStatus: 200 });
    const [tokenUrl, tokenInit] = fetchCall(fetchMock, 0);
    expect(tokenUrl).toBe("https://oauth2.googleapis.com/token");
    const assertion = new URLSearchParams(String(tokenInit.body)).get("assertion") ?? "";
    expect(await verifyJwt(assertion, publicKey)).toMatchObject({
      valid: true,
      claims: { iss: "svc@demo.example", scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token" },
    });
    const [sendUrl, sendInit] = fetchCall(fetchMock, 1);
    expect(sendUrl).toBe("https://fcm.googleapis.com/v1/projects/demo-project/messages:send");
    expect(new Headers(sendInit.headers).get("authorization")).toBe("Bearer ya29.fake");
    expect(JSON.parse(String(sendInit.body))).toMatchObject({ message: { token: "fcm-token", android: { ttl: "600s" } } });
  });

  test("token exchange failures, 401 drops the token, zero TTL", async () => {
    const { env } = await serviceAccount();
    const key = await readFcm(env);
    if (!key.ok) throw new Error("fixture");
    stubFetch(reply(400, { error: "invalid_grant" }));
    expect(await mintGoogleToken(key.value, now)).toEqual({ ok: false, result: { status: "failed", code: "CREDENTIALS_INVALID", httpStatus: 400 } });
    stubFetch(reply(503));
    expect(await mintGoogleToken(key.value, now)).toMatchObject({ ok: false, result: { status: "retry" } });
    stubFetch(new TypeError("reset"));
    expect(await mintGoogleToken(key.value, now)).toMatchObject({ ok: false, result: { status: "retry", code: "NETWORK_ERROR" } });
    stubFetch(reply(200, { access_token: "t" }));
    expect(await mintGoogleToken(key.value, now)).toMatchObject({ ok: true, expiresAt: NOW + 3_600_000 });
    expect(await mintGoogleToken({ ...key.value, privateKey: "garbage" }, now)).toEqual({ ok: false, result: { status: "failed", code: "CREDENTIALS_INVALID" } });

    const cache = fakeCache();
    const fetchMock = stubFetch(reply(200, { access_token: "t" }), reply(401, { error: { status: "UNAUTHENTICATED" } }));
    expect(await sendFcm({ token: "x", content: content({ options: { priority: "normal", ttlSeconds: 0 } }), expiresAt: NOW + 1 }, env, cache, now)).toMatchObject({ status: "retry" });
    expect(cache.drop).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchCall(fetchMock, 1)[1].body)).message.android.ttl).toBe("0s");
    expect(await sendFcm({ token: "x", content: content(), expiresAt: NOW }, {}, cache, now)).toEqual({ status: "failed", code: "PROVIDER_NOT_CONFIGURED" });
    stubFetch(reply(500));
    expect(await sendFcm({ token: "x", content: content(), expiresAt: NOW }, env, createTokenCache(memoryStorage(), now), now)).toMatchObject({ status: "retry" });
    stubFetch(reply(200, { access_token: "t" }), new TypeError("reset"));
    expect(await sendFcm({ token: "x", content: content(), expiresAt: NOW - 5000 }, env, fakeCache(), now)).toEqual({ status: "retry", code: "NETWORK_ERROR" });
  });
});

describe("Web Push sender", () => {
  test("classifies recorded responses", () => {
    const h = (o: Record<string, string> = {}): Headers => new Headers(o);
    expect(classifyWebPush(201, h({ location: "https://push.example/m/1" }), NOW)).toEqual({ status: "sent", providerMessageId: "https://push.example/m/1", httpStatus: 201 });
    expect(classifyWebPush(201, h(), NOW).status).toBe("sent");
    expect(classifyWebPush(404, h(), NOW)).toEqual({ status: "invalid", code: "NOT_FOUND", httpStatus: 404 });
    expect(classifyWebPush(410, h(), NOW)).toEqual({ status: "invalid", code: "GONE", httpStatus: 410 });
    expect(classifyWebPush(413, h(), NOW)).toEqual({ status: "failed", code: "PAYLOAD_TOO_LARGE", httpStatus: 413 });
    expect(classifyWebPush(429, h({ "retry-after": "5" }), NOW)).toEqual({ status: "retry", code: "HTTP_429", httpStatus: 429, delayMs: 5000 });
    expect(classifyWebPush(400, h(), NOW)).toEqual({ status: "failed", code: "HTTP_400", httpStatus: 400 });
  });

  test("encrypts for the browser and signs VAPID for the push service origin", async () => {
    const vapid = await generateVapid();
    const sub = await generateSubscription();
    const env = { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: "mailto:ops@example.com" };
    const fetchMock = stubFetch(reply(201, "", { location: "https://push.example/m/9" }));
    const job = { messageId: "msg1", endpoint: "https://push.example/sub/abc", p256dh: sub.p256dh, auth: sub.auth, content: content(), expiresAt: NOW + 120_000 };
    let signed = "";
    const cache: TokenCache = {
      get: async (slot, _s, mint) => {
        expect(slot.audience).toBe("https://push.example");
        const minted = await mint();
        if (minted.ok) signed = minted.token;
        return minted.ok ? { ok: true, token: minted.token } : minted;
      },
      drop: async () => {},
    };
    expect(await sendWebPush(job, env, cache, now)).toMatchObject({ status: "sent", providerMessageId: "https://push.example/m/9" });
    expect(await verifyJwt(signed, vapid.verifyKey)).toMatchObject({ valid: true, claims: { aud: "https://push.example", sub: "mailto:ops@example.com" } });
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("https://push.example/sub/abc");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`vapid t=${signed}, k=${vapid.publicKey}`);
    expect(headers.get("ttl")).toBe("120");
    expect(headers.get("urgency")).toBe("high");
    expect(headers.get("topic")).toBe(await webPushTopic(job));
    expect(headers.get("topic")).toHaveLength(32);
    if (!(init.body instanceof Uint8Array)) throw new Error("expected a byte body");
    const plaintext = await decryptWebPush(init.body, sub);
    expect(JSON.parse(plaintext)).toMatchObject({ title: "Support replied", body: "Ticket 42" });
  });

  test("bad subscription keys, missing or broken VAPID keys, network errors", async () => {
    const vapid = await generateVapid();
    const sub = await generateSubscription();
    const env = { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: "https://example.com" };
    const job = { messageId: "m", endpoint: "https://push.example/s", p256dh: sub.p256dh, auth: sub.auth, content: content({ options: { priority: "normal", ttlSeconds: 0 } }), expiresAt: NOW };
    expect(await sendWebPush({ ...job, p256dh: "!!" }, env, fakeCache(), now)).toEqual({ status: "invalid", code: "BAD_SUBSCRIPTION_KEYS" });
    expect(await sendWebPush({ ...job, p256dh: "AAAA" }, env, fakeCache(), now)).toEqual({ status: "invalid", code: "BAD_SUBSCRIPTION_KEYS" });
    expect(await sendWebPush(job, {}, fakeCache(), now)).toEqual({ status: "failed", code: "PROVIDER_NOT_CONFIGURED" });
    expect(await sendWebPush(job, { ...env, VAPID_PRIVATE_KEY: "AAAA" }, fakeCache(), now)).toEqual({ status: "failed", code: "CREDENTIALS_INVALID" });
    const fetchMock = stubFetch(new TypeError("reset"));
    expect(await sendWebPush(job, env, fakeCache(), now)).toEqual({ status: "retry", code: "NETWORK_ERROR" });
    const headers = new Headers(fetchCall(fetchMock, 0)[1].headers);
    expect(headers.get("ttl")).toBe("0");
    expect(headers.get("urgency")).toBe("normal");
  });
});

describe("sender dispatch and the custom-provider contract", () => {
  const base: Job = {
    deliveryId: "d1",
    messageId: "m1",
    attempts: 0,
    expiresAt: NOW + 1000,
    title: "t",
    data: {},
    options: { priority: "high" },
    device: { status: "active", address: { platform: "custom", provider: "wns", address: "https://wns.example/c" } },
    senderHandle: "function://handle",
    provider: "wns",
  };
  const deps = (runCustom: SenderDeps["runCustom"]): SenderDeps => ({ env: {}, cache: fakeCache(), now, runCustom });

  test("parses each sender result and refuses anything else", () => {
    expect(parseSendResult({ status: "sent", providerMessageId: "x", httpStatus: 200, extra: 1 })).toEqual({ status: "sent", providerMessageId: "x", httpStatus: 200 });
    expect(parseSendResult({ status: "retry", code: "503", delayMs: 5000 })).toEqual({ status: "retry", code: "503", delayMs: 5000, httpStatus: undefined });
    expect(parseSendResult({ status: "retry", delayMs: -5 })).toMatchObject({ delayMs: undefined });
    expect(parseSendResult({ status: "invalid", code: "GONE", invalidSince: 5 })).toMatchObject({ status: "invalid", code: "GONE", invalidSince: 5 });
    expect(parseSendResult({ status: "failed", code: 7 })).toEqual({ status: "failed", code: undefined, httpStatus: undefined });
    expect(parseSendResult({ status: "maybe" })).toBeNull();
    expect(parseSendResult(null)).toBeNull();
    expect(parseSendResult("sent")).toBeNull();
  });

  test("custom: passes the contract args, maps a throw to retry and a bad result to failed", async () => {
    const run = vi.fn(async () => ({ status: "sent" }));
    expect(await runSender(base, deps(run))).toEqual({ status: "sent", providerMessageId: undefined, httpStatus: undefined });
    expect(run).toHaveBeenCalledWith("function://handle", {
      provider: "wns",
      address: "https://wns.example/c",
      title: "t",
      body: undefined,
      data: {},
      options: { priority: "high" },
      attempt: 1,
      messageId: "m1",
      deliveryId: "d1",
    });
    expect(await runSender(base, deps(async () => { throw new Error("boom"); }))).toEqual({ status: "retry", code: "SENDER_ERROR" });
    expect(await runSender(base, deps(async () => 42))).toEqual({ status: "failed", code: "SENDER_BAD_RESULT" });
    expect(await runSender({ ...base, senderHandle: undefined }, deps(run))).toEqual({ status: "failed", code: "PROVIDER_NOT_CONFIGURED" });
  });

  test("never sends after expiry or to a device that is gone, disabled or invalid", async () => {
    const run = vi.fn();
    expect(await runSender({ ...base, expiresAt: NOW }, deps(run))).toEqual({ status: "failed", code: "TTL_EXPIRED" });
    expect(await runSender({ ...base, device: null }, deps(run))).toEqual({ status: "failed", code: "DEVICE_GONE" });
    expect(await runSender({ ...base, device: { status: "disabled", address: { platform: "fcm", token: "t" } } }, deps(run))).toEqual({ status: "failed", code: "DEVICE_DISABLED" });
    expect(await runSender({ ...base, device: { status: "invalid", address: { platform: "fcm", token: "t" } } }, deps(run))).toEqual({ status: "failed", code: "DEVICE_INVALID" });
    expect(await runSender({ ...base, device: { status: "active", address: { platform: "apns", token: "t" } } }, deps(run))).toEqual({ status: "failed", code: "APP_NOT_CONFIGURED" });
    expect(run).not.toHaveBeenCalled();
  });

  test("built-in platforms dispatch to their senders", async () => {
    const run = vi.fn();
    const active = (address: NonNullable<Job["device"]>["address"]): Job => ({ ...base, device: { status: "active", address } });
    expect(await runSender({ ...active({ platform: "apns", token: "t" }), apns: { topic: "x", environment: "production" } }, deps(run))).toEqual({ status: "failed", code: "PROVIDER_NOT_CONFIGURED" });
    expect(await runSender(active({ platform: "fcm", token: "t" }), deps(run))).toEqual({ status: "failed", code: "PROVIDER_NOT_CONFIGURED" });
    expect(await runSender(active({ platform: "webpush", endpoint: "https://p.example/s", p256dh: "a", auth: "b" }), deps(run))).toEqual({ status: "failed", code: "PROVIDER_NOT_CONFIGURED" });
  });

  test("actionDeps wires the clock and custom runner", async () => {
    const runAction = vi.fn(async () => ({ status: "sent" }));
    const wired = actionDeps({ runAction }, {}, fakeCache());
    expect(wired.now()).toBeGreaterThan(0);
    expect(await wired.runCustom("function://host;senders:send", { provider: "p", address: "a", data: {}, options: { priority: "high" }, attempt: 1, messageId: "m", deliveryId: "d" })).toEqual({ status: "sent" });
    expect(await wired.runCustom("senders:send", { provider: "p", address: "a", data: {}, options: { priority: "high" }, attempt: 1, messageId: "m", deliveryId: "d" })).toBeNull();
  });
});
