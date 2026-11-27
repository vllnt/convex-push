/** Shared constants used by both `client/` and `component/`. */

/** Default component id, as passed to `defineComponent`. */
export const COMPONENT_NAME = "push";

/** Platforms a device address can belong to. */
export const PLATFORMS = ["apns", "fcm", "webpush", "custom"] as const;
/** One platform. */
export type Platform = (typeof PLATFORMS)[number];

/** Device lifecycle states. `invalid` is reversible: the next registration restores the row. */
export const DEVICE_STATUSES = ["active", "disabled", "invalid"] as const;
/** One device status. */
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/** Delivery lifecycle states. `queued` is the only non-terminal one. */
export const DELIVERY_STATUSES = ["queued", "sent", "failed", "invalid"] as const;
/** One delivery status. */
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Default number of send attempts per delivery before it ends as `failed`. */
export const DEFAULT_MAX_ATTEMPTS = 5;
/** Upper bound accepted for `maxAttempts`. */
export const MAX_MAX_ATTEMPTS = 20;

/** Default time to live of a message: one day. */
export const DEFAULT_TTL_SECONDS = 86_400;
/** Longest TTL accepted: four weeks, FCM's maximum. Always shorter than the default retention. */
export const MAX_TTL_SECONDS = 2_419_200;
/**
 * A TTL of 0 means "deliver now or drop it". Providers receive 0; the queue
 * keeps the message sendable for this short window so the first attempt can run.
 */
export const ZERO_TTL_WINDOW_MS = 30_000;

/** Default sends in flight per provider queue. */
export const DEFAULT_MAX_PARALLELISM = 10;
/** Upper bound accepted for `maxParallelism`. */
export const MAX_MAX_PARALLELISM = 100;

/** Default retention of finished messages, their deliveries and long-invalid devices: 30 days. */
export const DEFAULT_RETENTION_MS = 2_592_000_000;
/**
 * Default rows one prune pass deletes before the sweep reschedules itself. A
 * pass always finishes the message it started, so it may go over by up to 100.
 */
export const DEFAULT_PRUNE_BATCH = 1000;
/** Upper bound accepted for a prune batch, well inside Convex's per-transaction read and time limits. */
export const MAX_PRUNE_BATCH = 1000;
/** Most invalid devices one prune pass deletes (each also resets its rate-limit row, a nested call). */
export const PRUNE_DEVICES_PER_PASS = 100;
/** Most messages one prune pass looks at (each reads up to 100 deliveries). */
export const PRUNE_MESSAGES_PER_PASS = 100;
/** A message is pruned only once it expired this long ago, so no send job can still be on its way. */
export const PRUNE_GRACE_MS = 86_400_000;

/** Most active devices one message fans out to. */
export const MAX_DEVICES_PER_MESSAGE = 100;
/** Most messages accepted by one `sendBatch` call. */
export const MAX_BATCH_MESSAGES = 100;
/**
 * Most deliveries one `sendBatch` call may create across its messages. Each
 * delivery makes several nested component calls (rate limiter, queue), and a
 * transaction with about 150 timed out on a local backend, so one call stays at 100.
 */
export const MAX_BATCH_DELIVERIES = 100;
/** Most rows returned by one list query. */
export const MAX_LIST_LIMIT = 100;

/** Longest opaque ref (subject, app, install, provider, idempotency key, stored provider id or code), in characters. */
export const MAX_REF_LENGTH = 256;
/** Longest title, body or data string, in characters. */
export const MAX_TEXT_LENGTH = 1024;
/** Longest APNs or FCM device token, in characters. */
export const MAX_TOKEN_LENGTH = 512;
/** Longest Web Push endpoint, in characters. */
export const MAX_ENDPOINT_LENGTH = 2048;
/** Longest custom-provider address, in characters. */
export const MAX_CUSTOM_ADDRESS_LENGTH = 2048;
/** Longest `rawJson` override, in characters. */
export const MAX_RAW_JSON_LENGTH = 4096;
/** Most keys in a message's `data`. */
export const MAX_DATA_KEYS = 100;
/** APNs limits `apns-collapse-id` to 64 bytes. */
export const MAX_COLLAPSE_KEY_BYTES = 64;

/** APNs payload limit, in bytes. */
export const APNS_MAX_PAYLOAD_BYTES = 4096;
/** FCM message limit, in bytes. */
export const FCM_MAX_PAYLOAD_BYTES = 4096;
/** 4096 bytes of encrypted body minus 103 bytes of aes128gcm overhead (RFC 8291). */
export const WEBPUSH_MAX_PLAINTEXT_BYTES = 3993;

/** First retry delay when the provider gives no Retry-After. Doubles per attempt. */
export const RETRY_BASE_DELAY_MS = 60_000;
/** Longest computed backoff between attempts. */
export const RETRY_MAX_DELAY_MS = 1_800_000;
/** Apple asks to wait 15 minutes before retrying a 5xx. */
export const APNS_SERVER_ERROR_DELAY_MS = 900_000;
/** Time limit for one provider HTTP request. */
export const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

/** Per-device fuse: sends to one device per minute before deliveries are delayed. */
export const DEVICE_SENDS_PER_MINUTE = 60;
/**
 * Burst breaker: `BadDeviceToken` answers for one APNs app within ten minutes
 * before that app's sends pause. A burst usually means sandbox tokens are going
 * to the production host (or the reverse).
 */
export const BAD_TOKEN_BURST_LIMIT = 20;

/** Error codes thrown as `ConvexError({ code, message })` by the component and the client class. */
export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "INVALID_ADDRESS",
  "INVALID_DATA",
  "INVALID_RAW_JSON",
  "PAYLOAD_TOO_LARGE",
  "UNKNOWN_APP",
  "PLATFORM_MISMATCH",
] as const;
/** One thrown error code. */
export type PushErrorCode = (typeof ERROR_CODES)[number];

/**
 * Codes the component writes to `deliveries.errorCode` itself. Provider codes
 * (for example `BadDeviceToken` or `UNREGISTERED`) are stored as the provider sent them.
 */
export const DELIVERY_ERROR_CODES = [
  "APP_NOT_CONFIGURED",
  "APP_PAUSED",
  "BAD_SUBSCRIPTION_KEYS",
  "CANCELLED",
  "CREDENTIALS_INVALID",
  "DEVICE_DISABLED",
  "DEVICE_GONE",
  "DEVICE_INVALID",
  "DEVICE_REASSIGNED",
  "FAILED",
  "GONE",
  "INVALID",
  "NETWORK_ERROR",
  "NOT_FOUND",
  "PAYLOAD_TOO_LARGE",
  "PROVIDER_NOT_CONFIGURED",
  "RETRY_LIMIT",
  "SENDER_BAD_RESULT",
  "SENDER_ERROR",
  "SILENT_NOT_SUPPORTED",
  "TIMEOUT",
  "TOKEN_EXCHANGE_UNAVAILABLE",
  "TTL_EXPIRED",
] as const;
/** One component-written delivery error code. */
export type DeliveryErrorCode = (typeof DELIVERY_ERROR_CODES)[number];
