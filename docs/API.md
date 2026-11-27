# API Reference — @vllnt/convex-push

**Compatibility:** requires `convex@^1.47.0` (component environment variables).

## Package exports

| Import path | Exports |
|---|---|
| `@vllnt/convex-push` | `Push` class; validators `appConfig`, `customSendArgs`, `data`, `deliveryEvent`, `deliveryView`, `deviceAddress`, `deviceView`, `messageStatus`, `messageSummary`, `overrides`, `sendResult`; types `AppConfig`, `CustomSendArgs`, `DeliveryEvent`, `DeliveryView`, `DeviceAddress`, `DeviceView`, `MessageStatus`, `MessageSummary`, `Overrides`, `PushData`, `SendInput`, `SendMessage`, `SendResult`, `PushOptions`, `RegisterArgs`, `CustomSender`, `DeliveryHook`, `RunMutationCtx`, `RunQueryCtx`, `AnyQueryCtx`; every constant in `shared` (limits, defaults, `ERROR_CODES`, `DELIVERY_ERROR_CODES`, `PLATFORMS`, statuses) |
| `@vllnt/convex-push/convex.config` (`.js`) | default: the component definition, passed to `app.use()` |
| `@vllnt/convex-push/test` | `register(t, name = "push")` mounts the component, its four workpools and its rate limiter in `convex-test`; default export `{ register, schema, modules }` (TypeScript source; needs Vite's `import.meta.glob`) |
| `@vllnt/convex-push/_generated/component` (`.js`) | type `ComponentApi` (the type of `components.push`) |

## Environment variables

Bound at mount with `app.use(push, { env: { NAME: app.env.NAME } })`. All
optional. A provider is on when its required variables are set.

| Variable | Provider | Required for it | Value |
|---|---|---|---|
| `APNS_KEY_P8` | APNs | yes | Contents of the `.p8` key file (PEM; literal `\n` is accepted) |
| `APNS_KEY_ID` | APNs | yes | The key's 10-character id |
| `APNS_TEAM_ID` | APNs | yes | Your Apple team id |
| `APNS_SANDBOX_KEY_P8`, `APNS_SANDBOX_KEY_ID` | APNs | no | A second key used for `environment: "sandbox"` apps |
| `FCM_SERVICE_ACCOUNT_JSON` | FCM | yes | The service-account JSON (`project_id`, `client_email`, `private_key`, optional `private_key_id`). Its `token_uri` is ignored: the token exchange always goes to `https://oauth2.googleapis.com/token` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web Push | yes | Raw P-256 key pair, base64url (the form `web-push generate-vapid-keys` prints) |
| `VAPID_SUBJECT` | Web Push | yes | `mailto:` or `https:` contact |

## Push class

```ts
import { Push } from "@vllnt/convex-push";
import { components, internal } from "./_generated/api";

const push = new Push(components.push, {
  apps: { ios: { platform: "apns", topic: "com.example.app", environment: "production" } },
  providers: { webhook: { send: internal.pushSenders.webhook } }, // optional
  onDelivery: internal.pushHooks.onDelivery, // optional
  defaultTtlSeconds: 86_400, // default 1 day, max 28 days
  maxAttempts: 5, // per delivery, 1 to 20
  maxParallelism: 10, // concurrent sends per provider pool, 1 to 100; pool-wide, the last send's value wins
  scrubContent: true, // erase title, body, data and overrides once every delivery has finished
  retentionMs: 30 * 86_400_000, // used by prune()
});
```

`apps` maps your `appRef` names to `appConfig`:
`{ platform: "apns", topic, environment: "production" | "sandbox" }` (`topic`
is printable ASCII without spaces),
`{ platform: "fcm" }`, `{ platform: "webpush" }` or
`{ platform: "custom", provider }`. The settings travel with each call, so a
change takes effect on the next send. `RunMutationCtx` is any context with
`runMutation`; `AnyQueryCtx` is any context with `runQuery`.

## Methods

### register(ctx, { subjectRef, appRef, address, installRef?, locale? })

Registers or refreshes one device. Returns `{ deviceId, created }`.

- The same address (by hash) updates its row; it moves to `subjectRef` if
  another subject held it.
- Otherwise a known `installRef` for the same `appRef` replaces that row's
  address (token rotation).
- An `invalid` device becomes `active` again. A `disabled` device stays
  disabled unless it moves to a new subject.
- `lastSeenAt` is refreshed on every call, so Apple's 410 timestamp can tell a
  later registration apart.
- A Web Push `endpoint` must be `https` on the default port, with no
  credentials, to a public host name: IP literals, a trailing dot, `localhost`
  and private suffixes (`.localhost`, `.local`, `.localdomain`, `.internal`,
  `.intranet`, `.lan`, `.corp`, `.svc`, `.test`, `.arpa`) are refused with
  `INVALID_ADDRESS`. DNS answers are not checked.
- Throws `UNKNOWN_APP` (appRef not in `apps`), `PLATFORM_MISMATCH` (address
  does not fit the app), `INVALID_ADDRESS`, `INVALID_ARGUMENT`.

### unregister(ctx, { deviceId } | { address }, subjectRef?)

Pass `{ deviceId, subjectRef? }` or `{ address, subjectRef? }`. Deletes the
device. Returns `{ removed }`; `false` when no device matched or it belongs to
another `subjectRef`.

### setDeviceStatus(ctx, { deviceId, status: "active" | "disabled", subjectRef? })

Pauses or resumes one device. Returns `{ updated }`.

### listDevices(ctx, { subjectRef, status?, limit? })

A subject's devices (`deviceView[]`; `limit` default 20, max 100). The address
is never returned.

### send(ctx, message)

Queues one message. Returns `{ messageId, deliveries, deduplicated }`.

| Field | Type | Notes |
|---|---|---|
| `to` | `{ subjectRef }` or `{ deviceIds }` | The subject's active devices (the first 100 registered; more logs `message.device_cap`), or up to 100 named devices (unknown or inactive ids are skipped) |
| `title`, `body` | `string?` | Up to 1024 characters. Neither means a silent push |
| `data` | `Record<string, string \| number \| boolean>?` | Up to 100 keys. `aps`, `from`, `notification`, `message_type`, `collapse_key`, `google.*`, `gcm.*` are reserved. FCM receives values as strings |
| `collapseKey` | `string?` | 1 to 64 printable ASCII characters. APNs `apns-collapse-id`, FCM `collapse_key`, Web Push `Topic` (hashed). Default: the message id on APNs and Web Push, so a duplicate send replaces the first |
| `ttlSeconds` | `number?` | 0 to 2,419,200. 0 means "now or never" (sendable for 30 seconds) |
| `priority` | `"high" \| "normal"?` | Default `high` for visible, `normal` for silent |
| `badge`, `sound`, `category` | `number?`, `string?`, `string?` | APNs `aps` fields; `sound` also on FCM Android |
| `overrides` | `overrides?` | `apns: { threadId?, interruptionLevel?, mutableContent?, rawJson? }`, `fcm: { channelId?, rawJson? }`, `webpush: { icon?, url?, rawJson? }` |
| `idempotencyKey` | `string?` | A second send with the same key returns the first message (`deduplicated: true`) |

Throws `INVALID_ARGUMENT`, `INVALID_DATA`, `INVALID_RAW_JSON` (not a JSON
object, over 4096 characters) or `PAYLOAD_TOO_LARGE` (a provider's payload over
its limit after `rawJson` is merged). A throw rolls the whole send back.

Some deliveries end at once, without a send: `APP_NOT_CONFIGURED` (the device's
`appRef` is not in `apps`, or no longer matches), `PROVIDER_NOT_CONFIGURED`
(keys or custom sender missing), `SILENT_NOT_SUPPORTED` (silent Web Push) and
`APP_PAUSED` (see below), and `TTL_EXPIRED` when the per-device rate fuse
would delay the send past the message's expiry.

### sendBatch(ctx, messages)

Queues up to 100 messages and up to 100 deliveries in one transaction
(deduplicated messages count zero; each delivery makes several nested component
calls, and about 150 timed out on a local backend). Over that it throws `INVALID_ARGUMENT` and
queues nothing; split the batch. Returns one result per message.

### status(ctx, messageId)

`messageStatus` or `null`: `{ messageId, createdAt, expiresAt, scrubbedAt?,
deliveries: deliveryView[] }`. Each delivery has `deliveryId`, `deviceId`,
`platform`, `provider?`, `status`, `attempts`, `providerMessageId?`,
`errorCode?`, `httpStatus?`, `nextAttemptAt?`, `sentAt?`, `updatedAt`.

### listBySubject(ctx, { subjectRef, limit? })

A subject's messages sent with `to: { subjectRef }`, newest first, with counts
per status (`messageSummary[]`; `limit` default 20, max 100).

### cancel(ctx, messageId)

Ends every queued delivery as `failed` with `CANCELLED`. A job already running
may still send; if its answer says the device is dead, the device is still
marked invalid. Returns `{ cancelled }`.

### prune(ctx, { batch? })

Deletes messages older than `retentionMs` that also expired more than a day ago
(so no send job is still on its way), with their deliveries; devices that are
`invalid` and unseen for `retentionMs`; and expired cached tokens. `batch` is the
number of message and delivery rows one pass deletes (default and max 1,000; a
pass finishes the message it started and looks at the 100 oldest messages). A
pass also deletes up to 100 invalid devices and expired tokens. It reschedules
itself while there is more. With `retentionMs` under 29 days, a message with a
long TTL holds back the messages created after it until it has expired. Returns `{ deleted, more }`. A daily cron prunes with the
default 30 days.

## Extension contracts

### Custom sender: `customSendArgs` → `sendResult`

The action receives `{ provider, address, title?, body?, data, options,
attempt, messageId, deliveryId }` and returns one of:

- `{ status: "sent", providerMessageId?, httpStatus? }`
- `{ status: "retry", code?, delayMs?, httpStatus? }`
- `{ status: "invalid", code?, httpStatus?, invalidSince? }`
- `{ status: "failed", code?, httpStatus? }`

A throw or timeout counts as `retry` with `SENDER_ERROR`. Any other value fails
the delivery with `SENDER_BAD_RESULT`. A missing code becomes `INVALID`,
`FAILED` or, at the attempt limit, `RETRY_LIMIT`. `delayMs` is bounded to one
second..one day; `providerMessageId` and `code` are stored up to 256
characters. Every custom provider shares one pool (`customPool`), so a slow
sender holds slots the others could use.

### Delivery hook: `deliveryEvent`

The mutation receives `{ messageId, deliveryId, deviceId, platform, provider?,
status: "sent" | "failed" | "invalid", errorCode?, at }` once per finished
delivery. It is scheduled, never inline.

## Delivery lifecycle

```
queued ──► sent
   │  ├──► invalid   (device marked invalid unless it registered after the provider's timestamp)
   │  └──► failed    (final error, attempt limit, expiry, cancel, device moved to another subject)
   └─ retry: queued again at now + delay (Retry-After, or 1 min doubling to 30 min)
```

A retry stops at the attempt limit (keeping the last code, or `RETRY_LIMIT`) or
when the next attempt would land after `expiresAt` (`TTL_EXPIRED`). Nothing is
sent to a device that moved to another subject after the message was queued
(`DEVICE_REASSIGNED`). Content is scrubbed as soon as no delivery is queued: in
the same transaction for `send` and `cancel`, and in a scheduled mutation right
after a send job's result is recorded.

## Provider answers

| Provider | Answer | Delivery |
|---|---|---|
| APNs | 200 | `sent`, `providerMessageId` = `apns-id` |
| APNs | 400/410 `BadDeviceToken`, `DeviceTokenNotForTopic`, `ExpiredToken`, `Unregistered` | `invalid` (410 timestamp kept) |
| APNs | 403 `ExpiredProviderToken` | `retry`, cached JWT dropped |
| APNs | 429, 5xx | `retry` (`Retry-After`, or 15 min on 5xx) |
| FCM | 200 | `sent`, `providerMessageId` = message name |
| FCM | `UNREGISTERED`, 400 `INVALID_ARGUMENT` on `message.token` | `invalid` |
| FCM | 401 | `retry`, cached access token dropped |
| FCM | 429, 5xx | `retry` (`Retry-After`, or 60 s on 429) |
| Web Push | 2xx | `sent`, `providerMessageId` = `Location` |
| Web Push | 404, 410 | `invalid` (`NOT_FOUND`, `GONE`) |
| Web Push | 413 | `failed` (`PAYLOAD_TOO_LARGE`) |
| Web Push | 401, 403 | `retry` (`HTTP_401`, `HTTP_403`), cached VAPID JWT dropped |
| Web Push | 429, 5xx | `retry` |
| Any | network error, 15 s timeout | `retry` (`NETWORK_ERROR`, `TIMEOUT`) |
| Any | 3xx | not followed; handled as that provider's other answers |

Other answers end `failed` with the provider's reason. A burst of more than 20
APNs `BadDeviceToken` or `DeviceTokenNotForTopic` answers for one `appRef` in 10
minutes pauses that app:
its deliveries fail with `APP_PAUSED` until the window ends, and the devices are
not marked invalid (this is how a sandbox/production mix-up shows).

## Errors

Thrown as `ConvexError({ code, message })`; `ERROR_CODES` lists them.

| Code | When |
|---|---|
| `INVALID_ARGUMENT` | A ref, limit, option or setting out of range |
| `INVALID_ADDRESS` | A token, endpoint or key that cannot be right (whitespace, not https to a public host, wrong key length) |
| `INVALID_DATA` | Reserved, too many, too long or non-finite `data` |
| `INVALID_RAW_JSON` | `rawJson` is not a JSON object or is over 4096 characters |
| `PAYLOAD_TOO_LARGE` | A provider's payload is over its limit after the merge |
| `UNKNOWN_APP` | `register` with an `appRef` not in `apps` (client) |
| `PLATFORM_MISMATCH` | `register` with an address that does not fit the app (client) |

Delivery error codes written by the component are in `DELIVERY_ERROR_CODES`;
provider reasons (`BadDeviceToken`, `UNREGISTERED`, …) are stored as sent.

## Security model

- Keys are read from the component's environment inside the send action and are
  never stored, returned or logged.
- Cached provider tokens are sealed with AES-256-GCM. The key comes from HKDF
  over the private key, with the credential as `info`; the credential and
  audience are the additional data.
- Queries return no address, token or content. Logs carry ids, platforms,
  statuses and codes only.
- Tests check that after a send (including error and retry paths) no key, JWT,
  access token or message content is left in plaintext in any table or
  scheduled-function argument of the component and its child components.
  Device addresses are stored, since sending needs them.
- Provider requests never follow redirects, so credentials only go to the URL
  given. Web Push endpoints are limited to public https host names (see
  `register`); custom senders fetch whatever address you store, so check those
  in your own sender.
- Stored function handles must have the `function://` form; a plain function
  name is refused. This is a form check, not a security boundary: the host
  passes its own handles and is trusted.
