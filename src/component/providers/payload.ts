import {
  APNS_MAX_PAYLOAD_BYTES,
  FCM_MAX_PAYLOAD_BYTES,
  MAX_RAW_JSON_LENGTH,
  WEBPUSH_MAX_PLAINTEXT_BYTES,
} from "../../shared.js";
import { byteLength } from "../crypto/codec.js";
import type { MessageOptions, Overrides, PushData } from "../validators.js";

/** The provider-neutral content of one message. */
export interface PushContent {
  title?: string;
  body?: string;
  data: PushData;
  options: MessageOptions;
  overrides?: Overrides;
}

/** A JSON object. */
export type JsonObject = { [key: string]: unknown };

/**
 * Narrow an unknown value to a plain JSON object.
 * @param value - Any value.
 * @returns Whether it is a non-array object.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A message with neither title nor body is silent: a background push on APNs,
 * a data-only message on FCM, and refused on Web Push.
 * @param content - The message.
 * @returns Whether it is silent.
 */
export function isSilent(content: Pick<PushContent, "body" | "title">): boolean {
  return !content.title && !content.body;
}

/**
 * Parse a `rawJson` override.
 * @param raw - The string, or undefined.
 * @returns The object, `undefined` when absent, or `null` when it is too long, not JSON, or not an object.
 */
export function parseRawJson(raw: string | undefined): JsonObject | null | undefined {
  if (raw === undefined) return undefined;
  if (raw.length > MAX_RAW_JSON_LENGTH) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Merge `source` into `target`: objects merge key by key, anything else replaces.
 * @param target - The built payload.
 * @param source - The override.
 * @returns A new merged object.
 */
export function deepMerge(target: JsonObject, source: JsonObject): JsonObject {
  const out: JsonObject = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const current = out[key];
    out[key] = isJsonObject(current) && isJsonObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}

function withRaw(built: JsonObject, raw: string | undefined): JsonObject {
  const parsed = parseRawJson(raw);
  return parsed ? deepMerge(built, parsed) : built;
}

function compact(object: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/**
 * Build the APNs JSON payload: `aps` plus the data keys beside it.
 * @param content - The message.
 * @returns The payload object, with `rawJson` merged last.
 */
export function buildApnsPayload(content: PushContent): JsonObject {
  const apns = content.overrides?.apns;
  const silent = isSilent(content);
  const aps = compact({
    alert: silent ? undefined : compact({ title: content.title, body: content.body }),
    badge: content.options.badge,
    sound: content.options.sound,
    category: content.options.category,
    "thread-id": apns?.threadId,
    "interruption-level": apns?.interruptionLevel,
    "mutable-content": apns?.mutableContent ? 1 : undefined,
    "content-available": silent ? 1 : undefined,
  });
  return withRaw({ ...content.data, aps }, apns?.rawJson);
}

/**
 * Build the FCM HTTP v1 `message` object without its target. Data values become
 * strings, as FCM requires. Topic and condition targets set by `rawJson` are
 * removed and the token is added afterwards, so an override can never change
 * who receives the message.
 * @param content - The message.
 * @param ttlSeconds - Remaining time to live.
 * @returns The `message` object minus `token`.
 */
export function buildFcmBody(content: PushContent, ttlSeconds: number): JsonObject {
  const fcm = content.overrides?.fcm;
  const silent = isSilent(content);
  const dataEntries = Object.entries(content.data);
  const channelId = fcm?.channelId ?? content.options.category;
  const androidNotification = silent ? undefined : compact({ sound: content.options.sound, channel_id: channelId });
  const built = compact({
    notification: silent ? undefined : compact({ title: content.title, body: content.body }),
    data: dataEntries.length > 0 ? Object.fromEntries(dataEntries.map(([k, v]) => [k, String(v)])) : undefined,
    android: compact({
      priority: content.options.priority === "high" ? "HIGH" : "NORMAL",
      ttl: `${String(ttlSeconds)}s`,
      collapse_key: content.options.collapseKey,
      notification: androidNotification && Object.keys(androidNotification).length > 0 ? androidNotification : undefined,
    }),
  });
  const { topic: _topic, condition: _condition, ...merged } = withRaw(built, fcm?.rawJson);
  return merged;
}

/**
 * The FCM `message` for one token: {@link buildFcmBody} plus the token.
 * @param content - The message.
 * @param token - The device's FCM registration token.
 * @param ttlSeconds - Remaining time to live.
 * @returns The `message` object.
 */
export function buildFcmMessage(content: PushContent, token: string, ttlSeconds: number): JsonObject {
  return { ...buildFcmBody(content, ttlSeconds), token };
}

/**
 * Build the JSON the service worker receives for a Web Push message.
 * @param content - The message.
 * @returns The payload object, with `rawJson` merged last.
 */
export function buildWebPushPayload(content: PushContent): JsonObject {
  const webpush = content.overrides?.webpush;
  return withRaw(
    compact({
      title: content.title,
      body: content.body,
      data: content.data,
      icon: webpush?.icon,
      url: webpush?.url,
      badge: content.options.badge,
      tag: content.options.collapseKey,
    }),
    webpush?.rawJson,
  );
}

/** A platform whose payload is over its limit, with the measured size. */
export interface Oversize {
  platform: "apns" | "fcm" | "webpush";
  bytes: number;
  limit: number;
}

/**
 * Check each built-in provider's payload against its limit, after `rawJson` is merged.
 * @param content - The message.
 * @param platforms - The platforms this message fans out to.
 * @returns The first platform over its limit, or `null`.
 */
export function findOversize(
  content: PushContent,
  platforms: ReadonlySet<string>,
): Oversize | null {
  const ttl = content.options.ttlSeconds ?? 0;
  const checks: Oversize[] = [];
  if (platforms.has("apns")) {
    checks.push({ platform: "apns", bytes: byteLength(JSON.stringify(buildApnsPayload(content))), limit: APNS_MAX_PAYLOAD_BYTES });
  }
  if (platforms.has("fcm")) {
    checks.push({
      platform: "fcm",
      bytes: byteLength(JSON.stringify(buildFcmBody(content, ttl))),
      limit: FCM_MAX_PAYLOAD_BYTES,
    });
  }
  if (platforms.has("webpush")) {
    checks.push({
      platform: "webpush",
      bytes: byteLength(JSON.stringify(buildWebPushPayload(content))),
      limit: WEBPUSH_MAX_PLAINTEXT_BYTES,
    });
  }
  return checks.find((check) => check.bytes > check.limit) ?? null;
}
