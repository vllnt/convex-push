# Changelog

## [Unreleased]

## [0.1.0] - 2026-11-27

First canary. Delivery to real devices is not verified yet.

### Added

- Sandboxed component `push` with `devices`, `messages`, `deliveries` and
  `providerTokens` tables.
- Keys bound at mount through component environment variables (`APNS_*`,
  `FCM_SERVICE_ACCOUNT_JSON`, `VAPID_*`). A provider without keys is off.
- Device registry: `register` (dedupe by address hash, reassignment, token
  rotation by `installRef` within one app, restore of invalid devices; a
  device that moves to another subject is not sent that subject's queued
  messages), `unregister`,
  `setDeviceStatus`, `listDevices`.
- Send queue: `send` and `sendBatch` (fan-out to up to 100 devices, up to
  1,000 deliveries per batch, idempotency key, TTL, payload size check after
  `rawJson`), `status`, `listBySubject`, `cancel`, `prune` (row-budgeted, keeps
  a message until a day after it expires) and a daily prune cron.
- Senders for APNs (ES256 provider token, HTTP/2), FCM HTTP v1 (RS256 assertion,
  OAuth token exchange) and Web Push (RFC 8291 aes128gcm, RFC 8292 VAPID), all
  on Web Crypto in the default runtime.
- One `@convex-dev/workpool` per provider; retries with `Retry-After` and
  exponential backoff, stopped at the attempt limit or the message's expiry.
- Dead-device handling with Apple's 410 timestamp guard, and a per-app
  `BadDeviceToken`/`DeviceTokenNotForTopic` burst breaker plus a per-device
  rate fuse (`@convex-dev/rate-limiter`).
- Outbound safety: provider requests never follow redirects; Web Push
  endpoints must be https to a public host name; a service account's
  `token_uri` must be a `*.googleapis.com` host.
- Encrypted provider-token cache (AES-256-GCM, HKDF key from the private key),
  shared by concurrent senders.
- Extension points: custom providers (`customSendArgs` → `sendResult`), the
  `onDelivery` hook (`deliveryEvent`) and `rawJson` overrides.
- Content scrubbed from messages once every delivery has finished (on by
  default).
- `@vllnt/convex-push/test` `register()` helper for `convex-test`.
