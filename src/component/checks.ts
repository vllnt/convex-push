import {
  MAX_COLLAPSE_KEY_BYTES,
  MAX_DATA_KEYS,
  MAX_DEVICES_PER_MESSAGE,
  MAX_MAX_ATTEMPTS,
  MAX_MAX_PARALLELISM,
  MAX_REF_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TTL_SECONDS,
} from "../shared.js";
import { byteLength } from "./crypto/codec.js";
import { parseRawJson } from "./providers/payload.js";
import { checkRef, fail } from "./registry.js";
import type { PushData, SendConfig, SendInput } from "./validators.js";

/** Data keys APNs or FCM reserve for themselves. */
const RESERVED_DATA_KEYS = new Set(["aps", "from", "notification", "message_type", "collapse_key"]);

function checkText(field: string, value: string | undefined, max = MAX_TEXT_LENGTH): void {
  if (value !== undefined && value.length > max) {
    fail("INVALID_ARGUMENT", `${field} must be at most ${String(max)} characters`);
  }
}

function checkInteger(field: string, value: number | undefined, min: number, max: number): void {
  if (value !== undefined && !(Number.isInteger(value) && value >= min && value <= max)) {
    fail("INVALID_ARGUMENT", `${field} must be an integer from ${String(min)} to ${String(max)}`);
  }
}

/**
 * Check flat data: at most 100 keys, no reserved keys, finite numbers, bounded strings.
 * @param data - The data record.
 */
export function checkData(data: PushData): void {
  const entries = Object.entries(data);
  if (entries.length > MAX_DATA_KEYS) fail("INVALID_DATA", `data must have at most ${String(MAX_DATA_KEYS)} keys`);
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > MAX_REF_LENGTH) fail("INVALID_DATA", "data keys must be 1 to 256 characters");
    if (RESERVED_DATA_KEYS.has(key) || key.startsWith("google.") || key.startsWith("gcm.")) {
      fail("INVALID_DATA", `data key "${key}" is reserved by a provider`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) fail("INVALID_DATA", `data value for "${key}" must be finite`);
    if (typeof value === "string" && value.length > MAX_TEXT_LENGTH) {
      fail("INVALID_DATA", `data value for "${key}" must be at most ${String(MAX_TEXT_LENGTH)} characters`);
    }
  }
}

/**
 * Validate one message before anything is written. Bad `rawJson` is refused here.
 * @param input - The message.
 */
export function checkSendInput(input: SendInput): void {
  if ("subjectRef" in input.to) checkRef("to.subjectRef", input.to.subjectRef);
  else if (input.to.deviceIds.length === 0 || input.to.deviceIds.length > MAX_DEVICES_PER_MESSAGE) {
    fail("INVALID_ARGUMENT", `to.deviceIds must list 1 to ${String(MAX_DEVICES_PER_MESSAGE)} devices`);
  }
  checkText("title", input.title);
  checkText("body", input.body);
  checkData(input.data ?? {});
  if (input.collapseKey !== undefined && (input.collapseKey.length === 0 || byteLength(input.collapseKey) > MAX_COLLAPSE_KEY_BYTES)) {
    fail("INVALID_ARGUMENT", `collapseKey must be 1 to ${String(MAX_COLLAPSE_KEY_BYTES)} bytes`);
  }
  checkInteger("ttlSeconds", input.ttlSeconds, 0, MAX_TTL_SECONDS);
  checkInteger("badge", input.badge, 0, 1_000_000);
  checkText("sound", input.sound, MAX_REF_LENGTH);
  checkText("category", input.category, MAX_REF_LENGTH);
  if (input.idempotencyKey !== undefined) checkRef("idempotencyKey", input.idempotencyKey);
  const { apns, fcm, webpush } = input.overrides ?? {};
  checkText("overrides.apns.threadId", apns?.threadId, MAX_REF_LENGTH);
  checkText("overrides.fcm.channelId", fcm?.channelId, MAX_REF_LENGTH);
  checkText("overrides.webpush.icon", webpush?.icon, MAX_TEXT_LENGTH);
  checkText("overrides.webpush.url", webpush?.url, MAX_TEXT_LENGTH);
  for (const [slot, raw] of [["apns", apns?.rawJson], ["fcm", fcm?.rawJson], ["webpush", webpush?.rawJson]] as const) {
    if (parseRawJson(raw) === null) fail("INVALID_RAW_JSON", `overrides.${slot}.rawJson must be a JSON object of at most 4096 characters`);
  }
}

/**
 * Validate the mount-wide settings the client passes with every send.
 * @param config - Send settings.
 */
export function checkSendConfig(config: SendConfig): void {
  checkInteger("maxAttempts", config.maxAttempts, 1, MAX_MAX_ATTEMPTS);
  checkInteger("maxParallelism", config.maxParallelism, 1, MAX_MAX_PARALLELISM);
  for (const { appRef } of config.apps) checkRef("appRef", appRef);
  for (const { provider, handle } of config.providers) {
    checkRef("provider", provider);
    if (!isHandleString(handle)) fail("INVALID_ARGUMENT", `provider ${provider} needs a function handle`);
  }
  if (config.onDeliveryHandle !== undefined && !isHandleString(config.onDeliveryHandle)) {
    fail("INVALID_ARGUMENT", "onDeliveryHandle must be a function handle");
  }
}

/**
 * Whether a string has the form of a Convex function handle. Handles are made
 * by `createFunctionHandle` in the host; a plain function name is refused so a
 * stored value can never call one of the component's own functions by name.
 * @param value - The stored or supplied string.
 * @returns Whether it starts with `function://`.
 */
export function isHandleString(value: string): boolean {
  return value.startsWith("function://");
}
