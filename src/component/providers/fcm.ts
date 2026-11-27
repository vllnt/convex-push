import { RETRY_BASE_DELAY_MS } from "../../shared.js";
import { importSigningKey, signJwt } from "../crypto/jwt.js";
import type { SendResult } from "../validators.js";
import { parseRetryAfter, providerFetch, readJson } from "./http.js";
import { type FcmKey, type PushEnv, readFcm } from "./keys.js";
import { buildFcmMessage, isJsonObject, type JsonObject, type PushContent } from "./payload.js";
import type { Minted, TokenCache } from "./token_cache.js";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/**
 * Google access tokens live 3600 seconds. Reuse for 50 minutes, or for the
 * lifetime less 10 minutes (at least half of it) when Google grants less.
 */
const FCM_TOKEN_REUSE_MS = 3_000_000;
const FCM_TOKEN_MARGIN_MS = 600_000;

/** One FCM delivery. */
export interface FcmJob {
  token: string;
  content: PushContent;
  expiresAt: number;
}

/**
 * Exchange a signed RS256 assertion for a Google OAuth access token.
 * @param key - Service-account key.
 * @param now - Clock.
 * @returns The token, or the sender result to return.
 */
export async function mintGoogleToken(key: FcmKey, now: () => number): Promise<Minted> {
  const signingKey = await importSigningKey(key.privateKey, "RS256");
  if (!signingKey) return { ok: false, result: { status: "failed", code: "CREDENTIALS_INVALID" } };
  const issuedAt = Math.floor(now() / 1000);
  const assertion = await signJwt(
    {},
    { iss: key.clientEmail, scope: FCM_SCOPE, aud: key.tokenUri, iat: issuedAt, exp: issuedAt + 3600 },
    signingKey,
    "RS256",
  );
  const http = await providerFetch(key.tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!http.ok) return { ok: false, result: http.result };
  const { status } = http.response;
  const body = await readJson(http.response);
  if (status === 200 && isJsonObject(body) && typeof body.access_token === "string") {
    const lifetimeMs = typeof body.expires_in === "number" ? body.expires_in * 1000 : 3_600_000;
    const minted = now();
    return {
      ok: true,
      token: body.access_token,
      refreshAfter: minted + Math.min(FCM_TOKEN_REUSE_MS, Math.max(lifetimeMs - FCM_TOKEN_MARGIN_MS, lifetimeMs / 2)),
      expiresAt: minted + lifetimeMs,
    };
  }
  if (status === 429 || status >= 500) return { ok: false, result: { status: "retry", code: "TOKEN_EXCHANGE_UNAVAILABLE", httpStatus: status } };
  return { ok: false, result: { status: "failed", code: "CREDENTIALS_INVALID", httpStatus: status } };
}

function fcmErrorCode(body: unknown, status: number): { code: string; tokenField: boolean } {
  const error = isJsonObject(body) && isJsonObject(body.error) ? body.error : {};
  const details = Array.isArray(error.details) ? error.details.filter(isJsonObject) : [];
  const fcmDetail = details.find((d: JsonObject) => typeof d.errorCode === "string");
  const code =
    typeof fcmDetail?.errorCode === "string"
      ? fcmDetail.errorCode
      : typeof error.status === "string"
        ? error.status
        : `HTTP_${String(status)}`;
  const tokenField = details.some(
    (d: JsonObject) =>
      Array.isArray(d.fieldViolations) &&
      d.fieldViolations.some((f: unknown) => isJsonObject(f) && f.field === "message.token"),
  );
  return { code, tokenField };
}

/**
 * Map an FCM HTTP v1 response to a sender result.
 * @param status - HTTP status.
 * @param headers - Response headers.
 * @param body - Parsed JSON body.
 * @param now - Clock.
 * @returns The result. A 401 is a retry; the caller drops the cached token.
 */
export function classifyFcm(status: number, headers: Headers, body: unknown, now: number): SendResult {
  if (status === 200) {
    const name = isJsonObject(body) && typeof body.name === "string" ? body.name : undefined;
    return { status: "sent", providerMessageId: name, httpStatus: 200 };
  }
  const { code, tokenField } = fcmErrorCode(body, status);
  if (code === "UNREGISTERED" || (status === 400 && code === "INVALID_ARGUMENT" && tokenField)) {
    return { status: "invalid", code, httpStatus: status };
  }
  if (status === 401) return { status: "retry", code, httpStatus: status };
  if (status === 429) {
    return { status: "retry", code, httpStatus: status, delayMs: parseRetryAfter(headers.get("retry-after"), now) ?? RETRY_BASE_DELAY_MS };
  }
  if (status >= 500) return { status: "retry", code, httpStatus: status, delayMs: parseRetryAfter(headers.get("retry-after"), now) };
  return { status: "failed", code, httpStatus: status };
}

/**
 * Send one FCM HTTP v1 message to one registration token.
 * @param job - The delivery.
 * @param env - Component env with the service-account key.
 * @param cache - Provider-token cache.
 * @param now - Clock.
 * @returns The sender result.
 */
export async function sendFcm(job: FcmJob, env: PushEnv, cache: TokenCache, now: () => number): Promise<SendResult> {
  const key = await readFcm(env);
  if (!key.ok) return { status: "failed", code: key.code };
  const slot = { credentialRef: key.value.credentialRef };
  const access = await cache.get(slot, key.value.privateKey, () => mintGoogleToken(key.value, now));
  if (!access.ok) return access.result;
  const ttlSeconds = job.content.options.ttlSeconds === 0 ? 0 : Math.max(Math.floor((job.expiresAt - now()) / 1000), 0);
  const http = await providerFetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(key.value.projectId)}/messages:send`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: buildFcmMessage(job.content, job.token, ttlSeconds) }),
    },
  );
  if (!http.ok) return http.result;
  const result = classifyFcm(http.response.status, http.response.headers, await readJson(http.response), now());
  if (result.httpStatus === 401) await cache.drop(slot);
  return result;
}
