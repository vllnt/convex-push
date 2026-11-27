import { base64Decode, sha256Base64Url, utf8 } from "../crypto/codec.js";
import { importRawP256PrivateKey, signJwt } from "../crypto/jwt.js";
import { encryptWebPush } from "../crypto/web_push_crypto.js";
import type { SendResult } from "../validators.js";
import { parseRetryAfter, providerFetch } from "./http.js";
import { type PushEnv, readVapid } from "./keys.js";
import { buildWebPushPayload, type PushContent } from "./payload.js";
import type { TokenCache } from "./token_cache.js";

/** A VAPID JWT may live 24 hours. Sign for 24 hours minus a minute, reuse for 12 hours. */
const VAPID_LIFETIME_MS = 86_340_000;
const VAPID_REUSE_MS = 43_200_000;

/** One Web Push delivery. */
export interface WebPushJob {
  messageId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  content: PushContent;
  expiresAt: number;
}

/**
 * The Topic header: the collapse key (or the message id) hashed to 32 URL-safe
 * characters, the most Web Push allows.
 * @param job - The delivery.
 * @returns The header value.
 */
export async function webPushTopic(job: Pick<WebPushJob, "content" | "messageId">): Promise<string> {
  return (await sha256Base64Url(job.content.options.collapseKey ?? job.messageId)).slice(0, 32);
}

/**
 * Map a push service response to a sender result.
 * @param status - HTTP status.
 * @param headers - Response headers.
 * @param now - Clock.
 * @returns The result.
 */
export function classifyWebPush(status: number, headers: Headers, now: number): SendResult {
  if (status >= 200 && status < 300) {
    return { status: "sent", providerMessageId: headers.get("location") ?? undefined, httpStatus: status };
  }
  if (status === 404 || status === 410) return { status: "invalid", code: status === 404 ? "NOT_FOUND" : "GONE", httpStatus: status };
  if (status === 429 || status >= 500) {
    return { status: "retry", code: `HTTP_${String(status)}`, httpStatus: status, delayMs: parseRetryAfter(headers.get("retry-after"), now) };
  }
  return { status: "failed", code: status === 413 ? "PAYLOAD_TOO_LARGE" : `HTTP_${String(status)}`, httpStatus: status };
}

/**
 * Encrypt and send one Web Push message, signed with VAPID (RFC 8292).
 * @param job - The delivery.
 * @param env - Component env with the VAPID keys.
 * @param cache - Provider-token cache; one VAPID JWT per push service origin.
 * @param now - Clock.
 * @returns The sender result.
 */
export async function sendWebPush(job: WebPushJob, env: PushEnv, cache: TokenCache, now: () => number): Promise<SendResult> {
  const key = await readVapid(env);
  if (!key.ok) return { status: "failed", code: key.code };
  const audience = new URL(job.endpoint).origin;
  const jwt = await cache.get({ credentialRef: key.value.credentialRef, audience }, key.value.privateKey, async () => {
    const signingKey = await importRawP256PrivateKey(key.value.privateKey, key.value.publicKey, "sign");
    if (!signingKey) return { ok: false, result: { status: "failed", code: "CREDENTIALS_INVALID" } };
    const issuedAt = now();
    const expiresAt = issuedAt + VAPID_LIFETIME_MS;
    const token = await signJwt({}, { aud: audience, exp: Math.floor(expiresAt / 1000), sub: key.value.subject }, signingKey, "ES256");
    return { ok: true, token, refreshAfter: issuedAt + VAPID_REUSE_MS, expiresAt };
  });
  if (!jwt.ok) return jwt.result;
  const uaPublic = base64Decode(job.p256dh);
  const authSecret = base64Decode(job.auth);
  if (!uaPublic || !authSecret) return { status: "invalid", code: "BAD_SUBSCRIPTION_KEYS" };
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = await encryptWebPush({ plaintext: utf8(JSON.stringify(buildWebPushPayload(job.content))), uaPublic, authSecret });
  } catch {
    return { status: "invalid", code: "BAD_SUBSCRIPTION_KEYS" };
  }
  const ttl = job.content.options.ttlSeconds === 0 ? 0 : Math.max(Math.floor((job.expiresAt - now()) / 1000), 0);
  const http = await providerFetch(job.endpoint, {
    method: "POST",
    headers: {
      authorization: `vapid t=${jwt.token}, k=${key.value.publicKey}`,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(ttl),
      urgency: job.content.options.priority === "high" ? "high" : "normal",
      topic: await webPushTopic(job),
    },
    body,
  });
  if (!http.ok) return http.result;
  return classifyWebPush(http.response.status, http.response.headers, now());
}
