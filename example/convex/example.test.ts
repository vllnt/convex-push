/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { FunctionHandle } from "convex/server";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { generateP8, generateRsa, generateSubscription, generateVapid } from "../../src/testing/fixtures.js";
import testSupport, { register } from "../../src/test.js";
import { registerForTests } from "../../src/testing/register.js";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const ACCESS_TOKEN = "ya29.test-access-token-value";
let keys: { p8: string; rsa: string; vapidPublic: string; vapidPrivate: string };
let sub: Awaited<ReturnType<typeof generateSubscription>>;

beforeAll(async () => {
  const [p8, rsa, vapid] = await Promise.all([generateP8(), generateRsa(), generateVapid()]);
  keys = { p8: p8.pem, rsa: rsa.pem, vapidPublic: vapid.publicKey, vapidPrivate: vapid.privateKey };
  sub = await generateSubscription();
});

/** Recorded provider responses, queued per host. Anything not queued gets a success. */
type Item = Error | Response;
const queues = new Map<string, Item[]>();
const calls: { url: URL; init: RequestInit }[] = [];
function respond(host: string, ...items: Item[]): void {
  queues.set(host, [...(queues.get(host) ?? []), ...items]);
}
function defaultResponse(url: URL): Response {
  if (url.host === "oauth2.googleapis.com") return Response.json({ access_token: ACCESS_TOKEN, expires_in: 3600 });
  if (url.host === "fcm.googleapis.com") return Response.json({ name: "projects/demo/messages/1" });
  if (url.host.endsWith("push.apple.com")) return new Response("", { status: 200, headers: { "apns-id": "apns-1" } });
  if (url.host === "push.example") return new Response("", { status: 201, headers: { location: "https://push.example/m/1" } });
  return new Response("", { status: 200, headers: { "x-message-id": "hook-1" } });
}
const hits = (host: string): number => calls.filter((c) => c.url.host === host).length;

function withKeys(): void {
  vi.stubEnv("APNS_KEY_P8", keys.p8);
  vi.stubEnv("APNS_KEY_ID", "KEYID12345");
  vi.stubEnv("APNS_TEAM_ID", "TEAMID1234");
  vi.stubEnv(
    "FCM_SERVICE_ACCOUNT_JSON",
    JSON.stringify({ project_id: "demo", client_email: "svc@demo.example", private_key: keys.rsa, private_key_id: "k1" }),
  );
  vi.stubEnv("VAPID_PUBLIC_KEY", keys.vapidPublic);
  vi.stubEnv("VAPID_PRIVATE_KEY", keys.vapidPrivate);
  vi.stubEnv("VAPID_SUBJECT", "mailto:ops@example.com");
}

let logs: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  queues.clear();
  calls.length = 0;
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const next = queues.get(url.host)?.shift() ?? defaultResponse(url);
    if (next instanceof Error) throw next;
    return next;
  });
  withKeys();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup() {
  const t = convexTest(schema, modules);
  registerForTests(t, "push");
  registerForTests(t, "pushPartner");
  return t;
}
type T = ReturnType<typeof setup>;

/**
 * Run scheduled work one simulated second at a time until no timer is left, so retry and
 * expiry times match what a deployment would see. Capped at three simulated hours.
 */
async function drain(t: T): Promise<void> {
  for (let elapsed = 0; elapsed < 3 * 3_600_000; elapsed += 1000) {
    await t.finishInProgressScheduledFunctions();
    if (vi.getTimerCount() === 0) return;
    vi.advanceTimersByTime(1000);
  }
  throw new Error("scheduled work did not settle");
}

function isQueryHandle(h: string): h is FunctionHandle<"query", Record<string, never>, string> {
  return h.startsWith("function://");
}
async function dumpTables(t: T, mount = "push"): Promise<string> {
  const handle = `function://${mount};testing/inspect:dumpTables`;
  if (!isQueryHandle(handle)) throw new Error("bad handle");
  return t.run((ctx) => ctx.runQuery(handle, {}));
}

const apns = (n: number) => ({ platform: "apns" as const, token: n.toString(16).padStart(64, "a") });
const fcm = (n: number) => ({ platform: "fcm" as const, token: `fcm-token-${String(n)}` });
const web = (n: number) => ({ platform: "webpush" as const, endpoint: `https://push.example/sub/${String(n)}`, p256dh: sub.p256dh, auth: sub.auth });
const hook = (n: number) => ({ platform: "custom" as const, provider: "webhook", address: `https://hook.example/d/${String(n)}` });

async function registerAll(t: T, subjectRef = "u1") {
  const ios = await t.mutation(api.example.registerDevice, { subjectRef, appRef: "ios", address: apns(1) });
  const android = await t.mutation(api.example.registerDevice, { subjectRef, appRef: "android", address: fcm(1) });
  const browser = await t.mutation(api.example.registerDevice, { subjectRef, appRef: "web", address: web(1) });
  const desktop = await t.mutation(api.example.registerDevice, { subjectRef, appRef: "desktop", address: hook(1) });
  return { ios: ios.deviceId, android: android.deviceId, browser: browser.deviceId, desktop: desktop.deviceId };
}

async function statusOf(t: T, messageId: string) {
  const s = await t.query(api.example.status, { messageId });
  if (!s) throw new Error("no status");
  return s;
}

test("published test support exposes registration assets", () => {
  expect(testSupport.register).toBe(register);
  expect(testSupport.schema).toBeDefined();
  expect(testSupport.modules).toBeDefined();
});

describe("device registry", () => {
  test("dedupes by address, reassigns to a new subject, and never returns addresses", async () => {
    const t = setup();
    const first = await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "ios", address: apns(1), locale: "fr-FR" });
    expect(first.created).toBe(true);
    const again = await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "ios", address: apns(1) });
    expect(again).toEqual({ deviceId: first.deviceId, created: false });
    const moved = await t.mutation(api.example.registerDevice, { subjectRef: "u2", appRef: "ios", address: apns(1) });
    expect(moved.deviceId).toBe(first.deviceId);
    expect(await t.query(api.example.listDevices, { subjectRef: "u1" })).toEqual([]);
    const listed = await t.query(api.example.listDevices, { subjectRef: "u2" });
    expect(listed).toEqual([
      expect.objectContaining({ deviceId: first.deviceId, appRef: "ios", platform: "apns", status: "active", locale: "fr-FR" }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(apns(1).token);
  });

  test("a rotated token with a known installRef replaces its row", async () => {
    const t = setup();
    const a = await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "android", address: fcm(1), installRef: "install-1" });
    const b = await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "android", address: fcm(2), installRef: "install-1" });
    expect(b).toEqual({ deviceId: a.deviceId, created: false });
    expect(await t.query(api.example.listDevices, { subjectRef: "u1" })).toHaveLength(1);
    const c = await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "android", address: fcm(3) });
    expect(c.created).toBe(true);
  });

  test("a changed installRef or locale updates the row", async () => {
    const t = setup();
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "web", address: web(1), locale: "en" });
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "web", address: web(1), installRef: "i-2" });
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "web", address: web(1), locale: "de" });
    expect((await t.query(api.example.listDevices, { subjectRef: "u1" }))[0]).toMatchObject({ locale: "de", installRef: "i-2" });
  });

  test("lastSeenAt is refreshed at most once a day", async () => {
    const t = setup();
    const { deviceId } = await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "web", address: web(1) });
    const [before] = await t.query(api.example.listDevices, { subjectRef: "u1" });
    vi.advanceTimersByTime(3_600_000);
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "web", address: web(1) });
    expect((await t.query(api.example.listDevices, { subjectRef: "u1" }))[0]?.lastSeenAt).toBe(before?.lastSeenAt);
    vi.advanceTimersByTime(86_400_000);
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "web", address: web(1) });
    const [after] = await t.query(api.example.listDevices, { subjectRef: "u1" });
    expect(after?.deviceId).toBe(deviceId);
    expect(after?.lastSeenAt).toBeGreaterThan(before?.lastSeenAt ?? 0);
  });

  test("disabled stays disabled for the same subject, resets on reassignment; status filter", async () => {
    const t = setup();
    const { deviceId } = await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "android", address: fcm(1) });
    expect(await t.mutation(api.example.setDeviceStatus, { deviceId, status: "disabled", subjectRef: "other" })).toEqual({ updated: false });
    expect(await t.mutation(api.example.setDeviceStatus, { deviceId, status: "disabled" })).toEqual({ updated: true });
    expect(await t.mutation(api.example.setDeviceStatus, { deviceId: "bogus", status: "active" })).toEqual({ updated: false });
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "android", address: fcm(1) });
    expect(await t.query(api.example.listDevices, { subjectRef: "u1", status: "disabled" })).toHaveLength(1);
    await t.mutation(api.example.registerDevice, { subjectRef: "u9", appRef: "android", address: fcm(1) });
    expect(await t.query(api.example.listDevices, { subjectRef: "u9", status: "active" })).toHaveLength(1);
  });

  test("unregister by id or address, with an owner check", async () => {
    const t = setup();
    const { deviceId } = await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "android", address: fcm(1) });
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "web", address: web(1) });
    expect(await t.mutation(api.example.unregisterDevice, { target: { deviceId }, subjectRef: "u2" })).toEqual({ removed: false });
    expect(await t.mutation(api.example.unregisterDevice, { target: { deviceId } })).toEqual({ removed: true });
    expect(await t.mutation(api.example.unregisterDevice, { target: { address: web(1) }, subjectRef: "u1" })).toEqual({ removed: true });
    expect(await t.mutation(api.example.unregisterDevice, { target: { address: web(1) } })).toEqual({ removed: false });
    expect(await t.mutation(api.example.unregisterDevice, { target: { deviceId: "not-an-id" } })).toEqual({ removed: false });
    await expect(t.mutation(api.example.unregisterRaw, {})).rejects.toThrow(/exactly one/);
    await expect(t.mutation(api.example.unregisterRaw, { deviceId: "x", address: fcm(1) })).rejects.toThrow(/exactly one/);
  });

  test("refuses unknown apps, mismatched platforms and malformed addresses", async () => {
    const t = setup();
    const reg = (appRef: string, address: Parameters<typeof t.mutation<typeof api.example.registerDevice>>[1]["address"], extra = {}) =>
      t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef, address, ...extra });
    await expect(reg("watch", apns(1))).rejects.toThrow(/UNKNOWN_APP|not configured/);
    await expect(reg("ios", fcm(1))).rejects.toThrow(/does not fit/);
    await expect(reg("desktop", { platform: "custom", provider: "other", address: "x" })).rejects.toThrow(/does not fit/);
    await expect(reg("android", { platform: "fcm", token: "has space" })).rejects.toThrow(/without whitespace/);
    await expect(reg("web", { ...web(1), endpoint: "http://push.example/x" })).rejects.toThrow(/https URL/);
    await expect(reg("web", { ...web(1), endpoint: "not a url" })).rejects.toThrow(/whitespace|https/);
    await expect(reg("web", { ...web(1), endpoint: "https://%zz" })).rejects.toThrow(/https URL/);
    await expect(reg("web", { ...web(1), auth: "AAAA" })).rejects.toThrow(/16-byte/);
    await expect(reg("desktop", { ...hook(1), address: "" })).rejects.toThrow(/address must be/);
    await expect(reg("android", fcm(1), { locale: "x".repeat(65) })).rejects.toThrow(/locale/);
    await expect(reg("android", fcm(1), { installRef: "" })).rejects.toThrow(/installRef/);
    await expect(t.mutation(api.example.registerDevice, { subjectRef: "", appRef: "android", address: fcm(1) })).rejects.toThrow(/subjectRef/);
    await expect(t.mutation(api.example.registerRaw, { subjectRef: "u1", appRef: "x".repeat(300), address: fcm(1) })).rejects.toThrow(/appRef/);
    await expect(t.query(api.example.listDevices, { subjectRef: "u1", limit: 0 })).rejects.toThrow(/limit/);
  });

  test("two mounts are isolated", async () => {
    const t = setup();
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "android", address: fcm(1) });
    expect(await t.query(api.example.listDevices, { subjectRef: "u1", partner: true })).toEqual([]);
    const partnerDevice = await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "android", address: fcm(1), partner: true });
    expect(partnerDevice.created).toBe(true);
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi", partner: true });
    expect(sent.deliveries).toBe(1);
    expect(await t.query(api.example.status, { messageId: sent.messageId })).toBeNull();
    expect(await t.query(api.example.status, { messageId: sent.messageId, partner: true })).not.toBeNull();
  });
});

describe("sending through the built-in providers and a custom provider", () => {
  test("fans out to APNs, FCM, Web Push and the custom provider; all end sent", async () => {
    const t = setup();
    const devices = await registerAll(t);
    const sent = await t.mutation(api.example.send, {
      subjectRef: "u1",
      title: "Support replied",
      body: "Your ticket has an answer",
      data: { ticketRef: "42" },
      collapseKey: "ticket:42",
      ttlSeconds: 3600,
      overrides: { apns: { threadId: "42" }, fcm: { channelId: "support" }, webpush: { icon: "/icon.png" } },
    });
    expect(sent).toMatchObject({ deliveries: 4, deduplicated: false });
    await drain(t);
    const status = await statusOf(t, sent.messageId);
    expect(status.deliveries.map((d) => [d.platform, d.status, d.attempts])).toEqual(
      expect.arrayContaining([
        ["apns", "sent", 1],
        ["fcm", "sent", 1],
        ["webpush", "sent", 1],
        ["custom", "sent", 1],
      ]),
    );
    expect(status.deliveries.find((d) => d.deviceId === devices.ios)?.providerMessageId).toBe("apns-1");
    expect(status.scrubbedAt).toBeDefined();
    const apnsCall = calls.find((c) => c.url.host === "api.push.apple.com");
    expect(apnsCall?.url.pathname).toBe(`/3/device/${apns(1).token}`);
    expect(new Headers(apnsCall?.init.headers).get("apns-collapse-id")).toBe("ticket:42");
    expect(hits("oauth2.googleapis.com")).toBe(1);
    const events = await t.query(api.example.hookEvents, {});
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.status === "sent" && e.messageId === sent.messageId)).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/Support replied|ticketRef|answer/);
    const summary = await t.query(api.example.listBySubject, { subjectRef: "u1" });
    expect(summary).toEqual([expect.objectContaining({ messageId: sent.messageId, sent: 4, queued: 0, failed: 0, invalid: 0 })]);
  });

  test("the idempotency key returns the first message", async () => {
    const t = setup();
    await registerAll(t);
    const a = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi", idempotencyKey: "reply:1" });
    const b = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi", idempotencyKey: "reply:1" });
    expect(b).toEqual({ messageId: a.messageId, deliveries: 4, deduplicated: true });
  });

  test("named devices: only active ones, unknown ids ignored", async () => {
    const t = setup();
    const d = await registerAll(t);
    await t.mutation(api.example.setDeviceStatus, { deviceId: d.android, status: "disabled" });
    const sent = await t.mutation(api.example.send, { deviceIds: [d.ios, d.android, d.ios, "nope"], title: "Hi" });
    expect(sent.deliveries).toBe(1);
    await expect(t.mutation(api.example.send, { deviceIds: [], title: "Hi" })).rejects.toThrow(/deviceIds/);
  });

  test("a subject with no device gets zero deliveries", async () => {
    const t = setup();
    expect(await t.mutation(api.example.send, { subjectRef: "nobody", title: "Hi" })).toMatchObject({ deliveries: 0 });
  });

  test("a silent push is background on APNs, data-only on FCM, refused on Web Push", async () => {
    const t = setup();
    await registerAll(t);
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", data: { sync: true } });
    await drain(t);
    const byPlatform = Object.fromEntries((await statusOf(t, sent.messageId)).deliveries.map((d) => [d.platform, d]));
    expect(byPlatform.webpush).toMatchObject({ status: "failed", errorCode: "SILENT_NOT_SUPPORTED", attempts: 0 });
    expect(byPlatform.apns?.status).toBe("sent");
    const apnsCall = calls.find((c) => c.url.host === "api.push.apple.com");
    expect(new Headers(apnsCall?.init.headers).get("apns-push-type")).toBe("background");
    const fcmBody = JSON.parse(String(calls.find((c) => c.url.host === "fcm.googleapis.com")?.init.body));
    expect(fcmBody.message.notification).toBeUndefined();
    expect(fcmBody.message.data).toEqual({ sync: "true" });
  });

  test("a provider without keys fails its deliveries with PROVIDER_NOT_CONFIGURED", async () => {
    const t = setup();
    vi.unstubAllEnvs();
    await registerAll(t);
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi" });
    await drain(t);
    const codes = (await statusOf(t, sent.messageId)).deliveries.map((d) => [d.platform, d.status, d.errorCode]);
    expect(codes).toEqual(
      expect.arrayContaining([
        ["apns", "failed", "PROVIDER_NOT_CONFIGURED"],
        ["fcm", "failed", "PROVIDER_NOT_CONFIGURED"],
        ["webpush", "failed", "PROVIDER_NOT_CONFIGURED"],
        ["custom", "sent", undefined],
      ]),
    );
    expect(await t.query(api.example.hookEvents, {})).toHaveLength(4);
  });

  test("keys removed after enqueue, or malformed, fail at send time", async () => {
    const t = setup();
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "android", address: fcm(1) });
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "ios", address: apns(1) });
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi" });
    vi.stubEnv("FCM_SERVICE_ACCOUNT_JSON", "{not json");
    vi.stubEnv("APNS_KEY_P8", "not a key");
    await drain(t);
    const codes = (await statusOf(t, sent.messageId)).deliveries.map((d) => d.errorCode).sort();
    expect(codes).toEqual(["CREDENTIALS_INVALID", "CREDENTIALS_INVALID"]);
  });

  test("a device whose appRef the client does not know fails with APP_NOT_CONFIGURED", async () => {
    const t = setup();
    await t.mutation(api.example.registerRaw, { subjectRef: "u1", appRef: "legacy", address: fcm(1) });
    await t.mutation(api.example.registerRaw, { subjectRef: "u1", appRef: "desktop", address: { platform: "custom", provider: "other", address: "x" } });
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi" });
    await drain(t);
    expect((await statusOf(t, sent.messageId)).deliveries.map((d) => d.errorCode)).toEqual(["APP_NOT_CONFIGURED", "APP_NOT_CONFIGURED"]);
  });

  test("a custom app whose provider has no sender fails with PROVIDER_NOT_CONFIGURED", async () => {
    const t = setup();
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "desktop", address: hook(1), partner: true });
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi", partner: true });
    const status = await t.query(api.example.status, { messageId: sent.messageId, partner: true });
    expect(status?.deliveries[0]).toMatchObject({ status: "failed", errorCode: "PROVIDER_NOT_CONFIGURED", provider: "webhook" });
  });

  test("sendBatch enqueues several messages in one transaction", async () => {
    const t = setup();
    await registerAll(t, "u1");
    await registerAll(t, "u2");
    const results = await t.mutation(api.example.sendBatch, { subjectRefs: ["u1", "u2"], title: "Hi" });
    expect(results.map((r) => r.deliveries)).toEqual([0, 4]);
    await expect(t.mutation(api.example.sendBatch, { subjectRefs: Array.from({ length: 101 }, (_, i) => `s${String(i)}`), title: "Hi" })).rejects.toThrow(
      /at most 100/,
    );
  });

  test("listBySubject is newest first with a limit", async () => {
    const t = setup();
    const first = await t.mutation(api.example.send, { subjectRef: "u1", title: "1" });
    const second = await t.mutation(api.example.send, { subjectRef: "u1", title: "2" });
    const list = await t.query(api.example.listBySubject, { subjectRef: "u1", limit: 1 });
    expect(list.map((m) => m.messageId)).toEqual([second.messageId]);
    expect(first.messageId).not.toBe(second.messageId);
    await expect(t.query(api.example.listBySubject, { subjectRef: "u1", limit: 101 })).rejects.toThrow(/limit/);
    expect(await t.query(api.example.status, { messageId: "nope" })).toBeNull();
  });
});

describe("validation at enqueue", () => {
  test("rawJson must be a JSON object and the size check runs after it is merged", async () => {
    const t = setup();
    await registerAll(t);
    await expect(t.mutation(api.example.send, { subjectRef: "u1", title: "Hi", overrides: { apns: { rawJson: "{bad" } } })).rejects.toThrow(/INVALID_RAW_JSON|rawJson/);
    await expect(t.mutation(api.example.send, { subjectRef: "u1", title: "Hi", overrides: { fcm: { rawJson: "[1]" } } })).rejects.toThrow(/rawJson/);
    await expect(t.mutation(api.example.send, { subjectRef: "u1", title: "Hi", overrides: { webpush: { rawJson: "3" } } })).rejects.toThrow(/rawJson/);
    const pad = JSON.stringify({ pad: "x".repeat(4070) });
    await expect(t.mutation(api.example.send, { subjectRef: "u1", title: "Hi", overrides: { apns: { rawJson: pad } } })).rejects.toThrow(
      /apns payload is \d+ bytes, over its 4096-byte limit/,
    );
    expect(await t.query(api.example.listBySubject, { subjectRef: "u1" })).toEqual([]);
    const ok = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi", overrides: { apns: { rawJson: '{"aps":{"relevance-score":0.8}}' } } });
    await drain(t);
    expect(JSON.parse(String(calls.find((c) => c.url.host === "api.push.apple.com")?.init.body)).aps["relevance-score"]).toBe(0.8);
    expect(ok.deliveries).toBe(4);
  });

  test("refuses bad fields with coded errors", async () => {
    const t = setup();
    const send = (args: Record<string, unknown>) => t.mutation(api.example.send, { subjectRef: "u1", title: "Hi", ...args });
    await expect(send({ subjectRef: "" })).rejects.toThrow(/subjectRef/);
    await expect(send({ subjectRef: undefined })).rejects.toThrow(/subjectRef/);
    await expect(send({ title: "x".repeat(1025) })).rejects.toThrow(/title/);
    await expect(send({ data: { aps: "x" } })).rejects.toThrow(/reserved/);
    await expect(send({ data: { "google.x": "x" } })).rejects.toThrow(/reserved/);
    await expect(send({ data: { n: Number.POSITIVE_INFINITY } })).rejects.toThrow(/finite/);
    await expect(send({ data: { s: "x".repeat(1025) } })).rejects.toThrow(/at most/);
    await expect(send({ data: { ["k".repeat(257)]: 1 } })).rejects.toThrow(/data keys/);
    await expect(send({ data: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${String(i)}`, i])) })).rejects.toThrow(/at most 100 keys/);
    await expect(send({ collapseKey: "x".repeat(65) })).rejects.toThrow(/collapseKey/);
    await expect(send({ collapseKey: "" })).rejects.toThrow(/collapseKey/);
    await expect(send({ ttlSeconds: -1 })).rejects.toThrow(/ttlSeconds/);
    await expect(send({ ttlSeconds: 2_419_201 })).rejects.toThrow(/ttlSeconds/);
    await expect(send({ badge: 1.5 })).rejects.toThrow(/badge/);
    await expect(send({ idempotencyKey: "" })).rejects.toThrow(/idempotencyKey/);
    await expect(send({ deviceIds: Array.from({ length: 101 }, (_, i) => String(i)) })).rejects.toThrow(/deviceIds/);
    const raw = { subjectRef: "u1", title: "Hi", maxAttempts: 5, maxParallelism: 10, appRef: "android", provider: "p", handle: "function://;example:webhookSender" };
    await expect(t.mutation(api.example.sendRaw, { ...raw, maxAttempts: 0 })).rejects.toThrow(/maxAttempts/);
    await expect(t.mutation(api.example.sendRaw, { ...raw, maxParallelism: 101 })).rejects.toThrow(/maxParallelism/);
    await expect(t.mutation(api.example.sendRaw, { ...raw, appRef: "" })).rejects.toThrow(/appRef/);
    await expect(t.mutation(api.example.sendRaw, { ...raw, provider: "" })).rejects.toThrow(/provider/);
    await expect(t.mutation(api.example.sendRaw, { ...raw, handle: "example:webhookSender" })).rejects.toThrow(/needs a function handle/);
    await expect(t.mutation(api.example.sendRaw, { ...raw, onDeliveryHandle: "example:onDelivery" })).rejects.toThrow(/onDeliveryHandle/);
    expect(await t.mutation(api.example.sendRaw, raw)).toMatchObject({ deliveries: 0 });
  });
});

describe("retries, expiry and dead devices", () => {
  test("retry until the attempt limit, then failed with the last code; the hook runs once", async () => {
    const t = setup();
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "desktop", address: hook(1) });
    respond("hook.example", new Response("", { status: 503 }), new Response("", { status: 503 }), new Response("", { status: 503 }));
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi" });
    await drain(t);
    expect((await statusOf(t, sent.messageId)).deliveries[0]).toMatchObject({ status: "failed", attempts: 3, errorCode: "503", httpStatus: 503 });
    expect(hits("hook.example")).toBe(3);
    expect(await t.query(api.example.hookEvents, {})).toEqual([expect.objectContaining({ status: "failed", errorCode: "503" })]);
  });

  test("a throttle then success ends sent on the second attempt after a one-minute backoff", async () => {
    const t = setup();
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "desktop", address: hook(1) });
    respond("hook.example", new Response("", { status: 429 }), new Response("", { status: 202 }));
    const start = Date.now();
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi" });
    for (let i = 0; i < 30; i++) {
      await t.finishInProgressScheduledFunctions();
      vi.advanceTimersByTime(1000);
    }
    const mid = (await statusOf(t, sent.messageId)).deliveries[0];
    expect(mid).toMatchObject({ status: "queued", attempts: 1, errorCode: "429" });
    expect((mid?.nextAttemptAt ?? 0) - start).toBeGreaterThanOrEqual(60_000);
    await drain(t);
    const done = (await statusOf(t, sent.messageId)).deliveries[0];
    expect(done).toMatchObject({ status: "sent", attempts: 2, httpStatus: 202 });
    expect(done).not.toHaveProperty("providerMessageId");
  });

  test("a retry that would land after the message expires ends as TTL_EXPIRED", async () => {
    const t = setup();
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "desktop", address: hook(1) });
    respond("hook.example", new Response("", { status: 503 }), new Response("", { status: 503 }));
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi", ttlSeconds: 90 });
    await drain(t);
    expect((await statusOf(t, sent.messageId)).deliveries[0]).toMatchObject({ status: "failed", attempts: 2, errorCode: "TTL_EXPIRED" });
  });

  test("a message whose window passed before its first attempt is never sent", async () => {
    const t = setup();
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "desktop", address: hook(1) });
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi", ttlSeconds: 0 });
    vi.advanceTimersByTime(60_000);
    await drain(t);
    expect((await statusOf(t, sent.messageId)).deliveries[0]).toMatchObject({ status: "failed", errorCode: "TTL_EXPIRED" });
    expect(hits("hook.example")).toBe(0);
  });

  test("a custom sender that throws counts as a retry", async () => {
    const t = setup();
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "desktop", address: hook(1) });
    respond("hook.example", new TypeError("connection reset"), new TypeError("connection reset"), new TypeError("connection reset"));
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi" });
    await drain(t);
    expect((await statusOf(t, sent.messageId)).deliveries[0]).toMatchObject({ status: "failed", attempts: 3, errorCode: "SENDER_ERROR" });
  });

  test("custom sender results: invalid marks the device invalid; failed is final; next registration restores", async () => {
    const t = setup();
    const { deviceId } = await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "desktop", address: hook(1) });
    respond("hook.example", new Response("", { status: 410 }));
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi" });
    await drain(t);
    expect((await statusOf(t, sent.messageId)).deliveries[0]).toMatchObject({ status: "invalid", errorCode: "GONE", attempts: 1 });
    expect(await t.query(api.example.listDevices, { subjectRef: "u1" })).toEqual([expect.objectContaining({ deviceId, status: "invalid", invalidCode: "GONE" })]);
    expect((await t.mutation(api.example.send, { subjectRef: "u1", title: "Again" })).deliveries).toBe(0);
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "desktop", address: hook(1) });
    const [restored] = await t.query(api.example.listDevices, { subjectRef: "u1" });
    expect(restored?.status).toBe("active");
    expect(restored).not.toHaveProperty("invalidCode");
    respond("hook.example", new Response("", { status: 400 }));
    const failed = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi" });
    await drain(t);
    expect((await statusOf(t, failed.messageId)).deliveries[0]).toMatchObject({ status: "failed", errorCode: "400", attempts: 1 });
  });

  test("APNs 410 marks the device invalid unless it registered again after Apple's timestamp", async () => {
    const t = setup();
    const { deviceId } = await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "ios", address: apns(1) });
    respond("api.push.apple.com", Response.json({ reason: "Unregistered", timestamp: Date.now() - 86_400_000 }, { status: 410 }));
    const kept = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi" });
    await drain(t);
    expect((await statusOf(t, kept.messageId)).deliveries[0]).toMatchObject({ status: "invalid", errorCode: "Unregistered" });
    expect((await t.query(api.example.listDevices, { subjectRef: "u1" }))[0]).toMatchObject({ deviceId, status: "active" });
    respond("api.push.apple.com", Response.json({ reason: "Unregistered", timestamp: Date.now() }, { status: 410 }));
    await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi" });
    await drain(t);
    expect((await t.query(api.example.listDevices, { subjectRef: "u1" }))[0]).toMatchObject({ status: "invalid", invalidCode: "Unregistered" });
  });

  test("FCM UNREGISTERED and Web Push 410 invalidate; FCM 503 honours Retry-After", async () => {
    const t = setup();
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "android", address: fcm(1) });
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "web", address: web(1) });
    respond("fcm.googleapis.com", Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503, headers: { "retry-after": "10" } }));
    respond("fcm.googleapis.com", Response.json({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }, { status: 404 }));
    respond("push.example", new Response("", { status: 410 }));
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi" });
    await drain(t);
    const byPlatform = Object.fromEntries((await statusOf(t, sent.messageId)).deliveries.map((d) => [d.platform, d]));
    expect(byPlatform.fcm).toMatchObject({ status: "invalid", errorCode: "UNREGISTERED", attempts: 2 });
    expect(byPlatform.webpush).toMatchObject({ status: "invalid", errorCode: "GONE" });
    expect((await t.query(api.example.listDevices, { subjectRef: "u1", status: "invalid" })).length).toBe(2);
  });

  test("a burst of BadDeviceToken for one APNs app pauses that app instead of killing every device", async () => {
    /** The limiter opens a fixed window at a random offset; pin it so the window spans the whole test. */
    vi.spyOn(Math, "random").mockReturnValue(0);
    const t = setup();
    for (let i = 0; i < 21; i++) {
      await t.mutation(api.example.registerDevice, { subjectRef: `u${String(i)}`, appRef: "ios", address: apns(i) });
      respond("api.push.apple.com", Response.json({ reason: "BadDeviceToken" }, { status: 400 }));
    }
    for (let i = 0; i < 21; i++) await t.mutation(api.example.send, { subjectRef: `u${String(i)}`, title: "Hi" });
    await drain(t);
    const all = await Promise.all(Array.from({ length: 21 }, (_, i) => t.query(api.example.listDevices, { subjectRef: `u${String(i)}` })));
    const statuses = all.flat().map((d) => d.status);
    expect(statuses.filter((s) => s === "invalid")).toHaveLength(20);
    expect(statuses.filter((s) => s === "active")).toHaveLength(1);
    const next = await t.mutation(api.example.send, { subjectRef: "u20", title: "Hi" });
    const status = await statusOf(t, next.messageId);
    expect(status.deliveries[0]).toMatchObject({ status: "failed", errorCode: "APP_PAUSED" });
    expect(logs.join("\n")).toContain("app.paused");
  });

  test("a device disabled after enqueue is skipped; a device removed after enqueue is gone", async () => {
    const t = setup();
    const a = await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "android", address: fcm(1) });
    const b = await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "web", address: web(1) });
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi" });
    await t.mutation(api.example.setDeviceStatus, { deviceId: a.deviceId, status: "disabled" });
    await t.mutation(api.example.unregisterDevice, { target: { deviceId: b.deviceId } });
    await drain(t);
    const codes = (await statusOf(t, sent.messageId)).deliveries.map((d) => d.errorCode).sort();
    expect(codes).toEqual(["DEVICE_DISABLED", "DEVICE_GONE"]);
  });

  test("the per-device fuse delays sends to one device past 60 a minute", async () => {
    const t = setup();
    const { deviceId } = await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "desktop", address: hook(1) });
    let last = "";
    for (let i = 0; i < 61; i++) last = (await t.mutation(api.example.send, { deviceIds: [deviceId], title: String(i) })).messageId;
    const delayed = (await statusOf(t, last)).deliveries[0];
    expect(delayed?.nextAttemptAt).toBeGreaterThan(Date.now());
  });
});

describe("extension points", () => {
  test("a hook that throws leaves the delivery record in place", async () => {
    const t = setup();
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "desktop", address: hook(1) });
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi", failingHook: true });
    await drain(t);
    expect((await statusOf(t, sent.messageId)).deliveries[0]).toMatchObject({ status: "sent", attempts: 1 });
  });

  test("the custom sender receives the contract arguments and an idempotency key", async () => {
    const t = setup();
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "desktop", address: hook(7) });
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi", body: "There", data: { k: 1 } });
    await drain(t);
    const call = calls.find((c) => c.url.host === "hook.example");
    expect(call?.url.pathname).toBe("/d/7");
    expect(JSON.parse(String(call?.init.body))).toEqual({ title: "Hi", body: "There", data: { k: 1 } });
    const status = await statusOf(t, sent.messageId);
    expect(new Headers(call?.init.headers).get("idempotency-key")).toBe(status.deliveries[0]?.deliveryId);
    expect(status.deliveries[0]?.providerMessageId).toBe("hook-1");
  });
});

describe("cancel, scrub and prune", () => {
  test("cancel ends queued deliveries as CANCELLED and the queued job then does nothing", async () => {
    const t = setup();
    await registerAll(t);
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi" });
    expect(await t.mutation(api.example.cancel, { messageId: sent.messageId })).toEqual({ cancelled: 4 });
    expect(await t.mutation(api.example.cancel, { messageId: sent.messageId })).toEqual({ cancelled: 0 });
    expect(await t.mutation(api.example.cancel, { messageId: "nope" })).toEqual({ cancelled: 0 });
    await drain(t);
    expect(calls).toHaveLength(0);
    const status = await statusOf(t, sent.messageId);
    expect(status.deliveries.every((d) => d.status === "failed" && d.errorCode === "CANCELLED")).toBe(true);
    expect(status.scrubbedAt).toBeDefined();
    expect(await t.query(api.example.hookEvents, {})).toHaveLength(4);
  });

  test("content is kept when scrubbing is off, erased when on", async () => {
    const t = setup();
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "android", address: fcm(1), partner: true });
    const kept = await t.mutation(api.example.send, { subjectRef: "u1", title: "Keep me", partner: true });
    expect(await dumpTables(t, "pushPartner")).toContain("Keep me");
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "android", address: fcm(1) });
    await t.mutation(api.example.send, { subjectRef: "u1", title: "Erase me", body: "secret body", data: { secretData: "x" } });
    await drain(t);
    const dump = await dumpTables(t);
    expect(dump).not.toMatch(/Erase me|secret body|secretData/);
    expect(kept.deliveries).toBe(1);
  });

  test("prune deletes old messages, deliveries, long-invalid devices and expired tokens, in batches", async () => {
    const t = setup();
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "android", address: fcm(1), partner: true });
    await t.mutation(api.example.send, { subjectRef: "u1", title: "1", partner: true });
    await t.mutation(api.example.send, { subjectRef: "u1", title: "2", partner: true });
    vi.advanceTimersByTime(5000);
    expect(await t.mutation(api.example.prune, { partner: true, batch: 1 })).toEqual({ deleted: 2, more: true });
    await drain(t);
    expect(await dumpTables(t, "pushPartner")).toMatch(/"messages":\[\]/);
    await expect(t.mutation(api.example.prune, { partner: true, batch: 0 })).rejects.toThrow(/batch/);

    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "ios", address: apns(1) });
    respond("api.push.apple.com", Response.json({ reason: "Unregistered" }, { status: 410 }));
    await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi" });
    await drain(t);
    expect(await dumpTables(t)).toMatch(/"providerTokens":\[\{/);
    vi.advanceTimersByTime(31 * 86_400_000);
    const pruned = await t.mutation(api.example.prune, {});
    expect(pruned.more).toBe(false);
    expect(await dumpTables(t)).toBe('{"devices":[],"messages":[],"deliveries":[],"providerTokens":[]}');
  });

  test("the daily cron prunes with the default retention", async () => {
    const t = setup();
    await t.mutation(api.example.send, { subjectRef: "u1", title: "old" });
    await expect(t.mutation(api.example.prune, {})).resolves.toEqual({ deleted: 0, more: false });
  });
});

describe("provider tokens and secrets", () => {
  test("one cached APNs token serves many sends; ExpiredProviderToken mints a new one", async () => {
    const t = setup();
    const ios = await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "ios", address: apns(1) });
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "ios-dev", address: apns(2) });
    await t.mutation(api.example.send, { subjectRef: "u1", title: "1" });
    await drain(t);
    await t.mutation(api.example.send, { subjectRef: "u1", title: "2" });
    await drain(t);
    const auth = calls.map((c) => new Headers(c.init.headers).get("authorization"));
    expect(new Set(auth).size).toBe(1);
    expect(calls.map((c) => c.url.host).sort()).toEqual(["api.push.apple.com", "api.push.apple.com", "api.sandbox.push.apple.com", "api.sandbox.push.apple.com"]);
    vi.advanceTimersByTime(10_000);
    respond("api.push.apple.com", Response.json({ reason: "ExpiredProviderToken" }, { status: 403 }));
    const again = await t.mutation(api.example.send, { deviceIds: [ios.deviceId], title: "3" });
    await drain(t);
    expect((await statusOf(t, again.messageId)).deliveries[0]).toMatchObject({ status: "sent", attempts: 2 });
    const after = calls.slice(4).map((c) => new Headers(c.init.headers).get("authorization"));
    expect(after[0]).toBe(auth[0]);
    expect(after[1]).not.toBe(auth[0]);
  });

  test("the Google access token is exchanged once and reused", async () => {
    const t = setup();
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "android", address: fcm(1) });
    await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi" });
    await drain(t);
    await t.mutation(api.example.registerDevice, { subjectRef: "u1", appRef: "android", address: fcm(2) });
    await t.mutation(api.example.send, { subjectRef: "u1", title: "Hi" });
    await drain(t);
    expect(hits("oauth2.googleapis.com")).toBe(1);
    expect(hits("fcm.googleapis.com")).toBe(3);
  });

  test("no key, token or content is stored in plaintext, returned by a query, or logged", async () => {
    const t = setup();
    const d = await registerAll(t);
    const sent = await t.mutation(api.example.send, { subjectRef: "u1", title: "Private title", body: "Private body", data: { privateKey: "private-value" } });
    await drain(t);
    const jwt = new Headers(calls.find((c) => c.url.host === "api.push.apple.com")?.init.headers).get("authorization")?.replace("bearer ", "") ?? "";
    const vapidJwt = /t=([^,]+)/.exec(new Headers(calls.find((c) => c.url.host === "push.example")?.init.headers).get("authorization") ?? "")?.[1] ?? "";
    expect(jwt.length).toBeGreaterThan(20);
    expect(vapidJwt.length).toBeGreaterThan(20);
    const secrets = [keys.p8.split("\n")[1] ?? "", keys.rsa.split("\n")[1] ?? "", keys.vapidPrivate, ACCESS_TOKEN, jwt, vapidJwt];
    const content = ["Private title", "Private body", "private-value"];
    const addresses = [apns(1).token, fcm(1).token, web(1).endpoint, hook(1).address];
    const stored = await dumpTables(t);
    for (const s of secrets) expect(stored).not.toContain(s);
    expect(stored).toMatch(/"providerTokens":\[\{.*"cipher"/);
    const returned = JSON.stringify([
      await t.query(api.example.status, { messageId: sent.messageId }),
      await t.query(api.example.listDevices, { subjectRef: "u1" }),
      await t.query(api.example.listBySubject, { subjectRef: "u1" }),
      await t.query(api.example.hookEvents, {}),
    ]);
    for (const s of [...secrets, ...content, ...addresses]) expect(returned).not.toContain(s);
    const logged = logs.join("\n");
    expect(logged).toContain("push.delivery.finished");
    for (const s of [...secrets, ...content, ...addresses]) expect(logged).not.toContain(s);
    expect(d.ios).toBeDefined();
  });
});
