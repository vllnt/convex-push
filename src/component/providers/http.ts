import { PROVIDER_REQUEST_TIMEOUT_MS, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS } from "../../shared.js";
import type { SendResult } from "../validators.js";

/** Bounds applied to any provider-supplied delay: one second to one day. */
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 86_400_000;

/**
 * Read a Retry-After header: delay seconds or an HTTP date.
 * @param value - The header value.
 * @param now - Current time in ms.
 * @returns The delay in ms, clamped to one second..one day, or `undefined`.
 */
export function parseRetryAfter(value: null | string, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now;
  if (Number.isNaN(ms)) return undefined;
  return clampDelay(ms);
}

/**
 * Bound a provider- or sender-supplied delay to one second..one day.
 * @param ms - The asked delay.
 * @returns The delay used.
 */
export function clampDelay(ms: number): number {
  return Math.min(Math.max(ms, MIN_DELAY_MS), MAX_DELAY_MS);
}

/**
 * Backoff before the next attempt: one minute, doubling per attempt, capped.
 * @param attempts - Attempts made so far (1 after the first).
 * @returns The delay in ms.
 */
export function backoffDelay(attempts: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(attempts - 1, 0), RETRY_MAX_DELAY_MS);
}

/** A response, or the retry result a network failure maps to. */
export type HttpOutcome = { ok: false; result: SendResult } | { ok: true; response: Response };

/**
 * POST to a provider with a time limit. Redirects are not followed (the 3xx is
 * returned as the answer), so a request and its credentials only go to the URL
 * given. A network error or timeout becomes a retry result; nothing about the
 * request is logged.
 * @param url - The provider URL.
 * @param init - Method, headers and body.
 * @returns The response, or a retry result.
 */
export async function providerFetch(url: string, init: RequestInit): Promise<HttpOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, PROVIDER_REQUEST_TIMEOUT_MS);
  try {
    return { ok: true, response: await fetch(url, { ...init, redirect: "manual", signal: controller.signal }) };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return { ok: false, result: { status: "retry", code: timedOut ? "TIMEOUT" : "NETWORK_ERROR" } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a response body as JSON without throwing.
 * @param response - A fetch response.
 * @returns The parsed value, or `null`.
 */
export async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}
