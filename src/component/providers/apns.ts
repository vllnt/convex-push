import { APNS_SERVER_ERROR_DELAY_MS } from "../../shared.js";
import { importSigningKey, signJwt } from "../crypto/jwt.js";
import type { SendResult } from "../validators.js";
import { parseRetryAfter, providerFetch, readJson } from "./http.js";
import type { PushEnv } from "./keys.js";
import { readApns } from "./keys.js";
import { buildApnsPayload, isJsonObject, isSilent, type PushContent } from "./payload.js";
import type { TokenCache } from "./token_cache.js";

/** Apple's documented token lifetime is 60 minutes, with no replacement within 20. Reuse for 45. */
const APNS_TOKEN_REUSE_MS = 2_700_000;
const APNS_TOKEN_LIFETIME_MS = 3_600_000;

/** Apple reasons that mean the device address is dead. */
const DEAD_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "ExpiredToken", "Unregistered"]);

/** One APNs delivery. */
export interface ApnsJob {
  messageId: string;
  token: string;
  topic: string;
  environment: "production" | "sandbox";
  content: PushContent;
  expiresAt: number;
}

/**
 * The Apple host for an environment.
 * @param environment - production or sandbox.
 * @returns The host name.
 */
export function apnsHost(environment: "production" | "sandbox"): string {
  return environment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
}

/**
 * Build the request headers. Silent pushes use push type `background` at priority 5, as Apple requires.
 * The default collapse id is the message id, so a duplicate send replaces the original.
 * @param job - The delivery.
 * @param jwt - The provider token.
 * @returns Header map.
 */
export function apnsHeaders(job: ApnsJob, jwt: string): Record<string, string> {
  const silent = isSilent(job.content);
  const ttl = job.content.options.ttlSeconds;
  return {
    authorization: `bearer ${jwt}`,
    "apns-topic": job.topic,
    "apns-push-type": silent ? "background" : "alert",
    "apns-priority": !silent && job.content.options.priority === "high" ? "10" : "5",
    "apns-expiration": ttl === 0 ? "0" : String(Math.floor(job.expiresAt / 1000)),
    "apns-collapse-id": job.content.options.collapseKey ?? job.messageId,
    "content-type": "application/json",
  };
}

/**
 * Map an APNs response to a sender result.
 * @param status - HTTP status.
 * @param headers - Response headers.
 * @param body - Parsed JSON body (`{ reason, timestamp? }` on errors).
 * @param now - Clock.
 * @returns The result. `ExpiredProviderToken` is a retry; the caller drops the cached token.
 */
export function classifyApns(status: number, headers: Headers, body: unknown, now: number): SendResult {
  if (status === 200) return { status: "sent", providerMessageId: headers.get("apns-id") ?? undefined, httpStatus: 200 };
  const reason = isJsonObject(body) && typeof body.reason === "string" ? body.reason : `HTTP_${String(status)}`;
  const timestamp = isJsonObject(body) && typeof body.timestamp === "number" ? body.timestamp : undefined;
  if ((status === 400 || status === 410) && DEAD_REASONS.has(reason)) {
    return { status: "invalid", code: reason, httpStatus: status, invalidSince: timestamp };
  }
  if (status === 403 && reason === "ExpiredProviderToken") return { status: "retry", code: reason, httpStatus: status };
  if (status === 429) {
    return { status: "retry", code: reason, httpStatus: status, delayMs: parseRetryAfter(headers.get("retry-after"), now) };
  }
  if (status >= 500) {
    return {
      status: "retry",
      code: reason,
      httpStatus: status,
      delayMs: parseRetryAfter(headers.get("retry-after"), now) ?? APNS_SERVER_ERROR_DELAY_MS,
    };
  }
  return { status: "failed", code: reason, httpStatus: status };
}

/**
 * Send one APNs notification over HTTP/2 with plain fetch.
 * @param job - The delivery.
 * @param env - Component env with the Apple key.
 * @param cache - Provider-token cache.
 * @param now - Clock.
 * @returns The sender result.
 */
export async function sendApns(job: ApnsJob, env: PushEnv, cache: TokenCache, now: () => number): Promise<SendResult> {
  const key = await readApns(env, job.environment);
  if (!key.ok) return { status: "failed", code: key.code };
  const slot = { credentialRef: key.value.credentialRef };
  const jwt = await cache.get(slot, key.value.pemText, async () => {
    const signingKey = await importSigningKey(key.value.pemText, "ES256");
    if (!signingKey) return { ok: false, result: { status: "failed", code: "CREDENTIALS_INVALID" } };
    const issuedAt = now();
    const token = await signJwt({ kid: key.value.keyId }, { iss: key.value.teamId, iat: Math.floor(issuedAt / 1000) }, signingKey, "ES256");
    return { ok: true, token, refreshAfter: issuedAt + APNS_TOKEN_REUSE_MS, expiresAt: issuedAt + APNS_TOKEN_LIFETIME_MS };
  });
  if (!jwt.ok) return jwt.result;
  const http = await providerFetch(`https://${apnsHost(job.environment)}/3/device/${encodeURIComponent(job.token)}`, {
    method: "POST",
    headers: apnsHeaders(job, jwt.token),
    body: JSON.stringify(buildApnsPayload(job.content)),
  });
  if (!http.ok) return http.result;
  const result = classifyApns(http.response.status, http.response.headers, await readJson(http.response), now());
  if (result.status === "retry" && result.code === "ExpiredProviderToken") await cache.drop(slot);
  return result;
}
