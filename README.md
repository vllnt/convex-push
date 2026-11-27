<!-- Badges -->

[![Convex Component](https://img.shields.io/badge/convex-component-EE342F.svg)](https://www.convex.dev/components)
[![npm version](https://img.shields.io/npm/v/@vllnt/convex-push.svg)](https://www.npmjs.com/package/@vllnt/convex-push)
[![CI](https://github.com/vllnt/convex-push/actions/workflows/ci.yml/badge.svg)](https://github.com/vllnt/convex-push/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/@vllnt/convex-push.svg)](./LICENSE)

# @vllnt/convex-push

Push notifications sent straight from a Convex backend to Apple (APNs), Google
(FCM HTTP v1) and browser push services (Web Push), as a
[Convex component](https://docs.convex.dev/components). No relay company sits in
the path: the component signs and sends each request itself.

```ts
const push = new Push(components.push, {
  apps: { ios: { platform: "apns", topic: "com.example.app", environment: "production" }, android: { platform: "fcm" } },
});

await push.register(ctx, { subjectRef: userId, appRef: "ios", address: { platform: "apns", token } });
const { messageId } = await push.send(ctx, {
  to: { subjectRef: userId },
  title: "Support replied",
  data: { ticketRef: "42" },
  idempotencyKey: `reply:${replyId}`,
});
const status = await push.status(ctx, messageId);
```

> **Status: 0.1.0 canary.** Every sender is tested against recorded provider
> responses and published crypto test vectors, and the crypto also passes in a
> real Convex runtime. **Delivery to real devices has not been verified yet**
> (no Apple or Google credentials were used). Treat the first real send on each
> platform as a smoke test.

## Features

- **Direct to the provider.** APNs over HTTP/2, FCM HTTP v1 and Web Push
  (RFC 8030/8291/8292) from a default-runtime action. UnifiedPush endpoints
  speak Web Push.
- **Device registry.** One row per device address, deduplicated by a hash of
  the address. A rotated token with the same `installRef` (same app) replaces
  its row. A device moves to a new subject when another user registers it, and
  messages queued for the old subject are not sent to it.
- **Durable queue.** One delivery per device. One [workpool](https://www.convex.dev/components/workpool)
  per built-in provider, so a slow provider cannot starve the others (custom
  providers share one pool).
- **Retries that follow the provider.** Exponential backoff from one minute,
  `Retry-After` honoured, stop at the attempt limit or at the message's expiry.
- **Dead-device cleanup.** Provider "gone" answers mark the device `invalid`;
  the next registration restores it. A burst of APNs `BadDeviceToken` or
  `DeviceTokenNotForTopic` for one app pauses that app instead of killing every
  device (wrong environment or topic).
- **Cached provider tokens.** APNs and VAPID JWTs and the Google access token
  are reused, stored encrypted (AES-256-GCM, key derived from your private key,
  never stored).
- **Extensible without a fork.** A custom provider (one host action), a
  delivery hook (one host mutation) and `rawJson` for payload fields that have
  no typed option yet.
- **Content scrubbed at rest.** Title, body and data are erased once every
  delivery has finished (on by default).

## Installation

Requires `convex@^1.47.0` (component environment variables).

```bash
npm install convex @vllnt/convex-push
```

Prereleases are published under the `canary` dist-tag
(`npm install @vllnt/convex-push@canary`); pin the resolved version for
reproducible installs.

Bind your keys at mount in `convex/convex.config.ts`. Every variable is
optional: a provider without keys is switched off and its deliveries fail with
`PROVIDER_NOT_CONFIGURED`.

```ts
import { defineApp } from "convex/server";
import { v } from "convex/values";
import push from "@vllnt/convex-push/convex.config";

const app = defineApp({
  env: {
    APNS_KEY_P8: v.optional(v.string()), // contents of the .p8 file
    APNS_KEY_ID: v.optional(v.string()),
    APNS_TEAM_ID: v.optional(v.string()),
    FCM_SERVICE_ACCOUNT_JSON: v.optional(v.string()),
    VAPID_PUBLIC_KEY: v.optional(v.string()),
    VAPID_PRIVATE_KEY: v.optional(v.string()),
    VAPID_SUBJECT: v.optional(v.string()), // mailto: or https: contact
  },
});

app.use(push, {
  env: {
    APNS_KEY_P8: app.env.APNS_KEY_P8,
    APNS_KEY_ID: app.env.APNS_KEY_ID,
    APNS_TEAM_ID: app.env.APNS_TEAM_ID,
    FCM_SERVICE_ACCOUNT_JSON: app.env.FCM_SERVICE_ACCOUNT_JSON,
    VAPID_PUBLIC_KEY: app.env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: app.env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: app.env.VAPID_SUBJECT,
  },
});

export default app;
```

Then set the values with `npx convex env set APNS_KEY_P8 "$(cat AuthKey_ABC123.p8)"`
and so on. Two more optional variables, `APNS_SANDBOX_KEY_P8` and
`APNS_SANDBOX_KEY_ID`, cover an Apple key limited to the sandbox environment.
A second Apple team or Firebase project is a second mount:
`app.use(push, { name: "pushPartner", env: { … } })`.

## For coding agents

The npm package bundles its docs at `node_modules/@vllnt/convex-push/`:
`docs/API.md`, `CHANGELOG.md`, `llms.txt` and the TypeScript source in `src/`.
They match the installed version. Read them before writing code against this
package.

## Usage

### Name your apps

The non-secret part of each app is plain config on the client class. An
`appRef` is your name for one app on one platform.

```ts
import { Push } from "@vllnt/convex-push";
import { components, internal } from "./_generated/api";

export const push = new Push(components.push, {
  apps: {
    ios: { platform: "apns", topic: "com.example.app", environment: "production" },
    "ios-dev": { platform: "apns", topic: "com.example.app", environment: "sandbox" },
    android: { platform: "fcm" },
    web: { platform: "webpush" },
  },
});
```

### Register devices

Your app owns auth. Resolve the user in your own function and pass an opaque
`subjectRef`.

```ts
import { deviceAddress } from "@vllnt/convex-push";

export const registerDevice = mutation({
  args: { appRef: v.string(), address: deviceAddress, installRef: v.optional(v.string()), locale: v.optional(v.string()) },
  returns: v.object({ deviceId: v.string(), created: v.boolean() }),
  handler: async (ctx, args) => push.register(ctx, { subjectRef: await requireUserId(ctx), ...args }),
});
```

Addresses by platform:

| Platform | Address | Where it comes from |
|---|---|---|
| `apns` | `{ platform: "apns", token }` | `registerForRemoteNotifications()`, or `getDevicePushTokenAsync()` in Expo (`type: "ios"`) |
| `fcm` | `{ platform: "fcm", token }` | `FirebaseMessaging.getToken()`, or `getDevicePushTokenAsync()` in Expo (`type: "android"`) |
| `webpush` | `{ platform: "webpush", endpoint, p256dh, auth }` | `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` |
| `custom` | `{ platform: "custom", provider, address }` | Your own provider, see below |

Register on every app launch. Call `unregister` on logout and
`setDeviceStatus` to pause one device.

### Send

```ts
export const notifyReply = internalMutation({
  args: { customerRef: v.string(), ticketRef: v.string(), replyRef: v.string(), preview: v.string() },
  returns: v.object({ messageId: v.string(), deliveries: v.number(), deduplicated: v.boolean() }),
  handler: async (ctx, a) =>
    push.send(ctx, {
      to: { subjectRef: a.customerRef },
      title: "Support replied",
      body: a.preview,
      data: { kind: "ticket.reply", ticketRef: a.ticketRef },
      collapseKey: `ticket:${a.ticketRef}`,
      ttlSeconds: 3600,
      idempotencyKey: `reply:${a.replyRef}`,
      overrides: { apns: { threadId: a.ticketRef }, fcm: { channelId: "support" } },
    }),
});
```

`send` runs in your mutation's transaction: if the mutation fails, nothing is
queued. `to` is either `{ subjectRef }` (every active device of that subject) or
`{ deviceIds }`. A message without title and body is silent: a background push
on APNs and a data-only message on FCM. Web Push has no silent push, so those
deliveries fail with `SILENT_NOT_SUPPORTED`. `sendBatch` queues up to 100
messages in one call.

### Watch delivery

```ts
import { messageStatus } from "@vllnt/convex-push";

export const pushStatus = query({
  args: { messageId: v.string() },
  returns: v.union(messageStatus, v.null()),
  handler: async (ctx, { messageId }) => {
    await requireAgent(ctx);
    return push.status(ctx, messageId);
  },
});
```

Each delivery ends `sent`, `failed` or `invalid`, with the provider's message id
or an error code. `listBySubject` lists a subject's recent messages with counts.
`cancel` stops the deliveries still queued. Queries never return a device
address, a token or message content.

## Extending it

| You want to | Use |
|---|---|
| Change TTL, attempt limit, sends in parallel, retention | `defaultTtlSeconds`, `maxAttempts`, `maxParallelism`, `retentionMs` on the client |
| Keep content after delivery | `scrubContent: false` |
| Use a payload field with no typed option | `rawJson` in that provider's `overrides` slot |
| Add a provider this package does not ship | A custom provider: one action in your app |
| Act when a delivery ends | The `onDelivery` hook: one mutation in your app |
| Consent, quiet hours, who may send | Your own function around `push.send` |

### A custom provider

A custom provider is one action in your app that sends one notification to one
address. The component keeps the device row, the queue, retries, expiry and
dead-address cleanup.

```ts
import { customSendArgs, sendResult, type SendResult } from "@vllnt/convex-push";

const push = new Push(components.push, {
  apps: { desktop: { platform: "custom", provider: "webhook" } },
  providers: { webhook: { send: internal.pushSenders.webhook } },
});

export const webhook = internalAction({
  args: customSendArgs,
  returns: sendResult,
  handler: async (_ctx, a): Promise<SendResult> => {
    const res = await fetch(a.address, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": a.deliveryId },
      body: JSON.stringify({ title: a.title, body: a.body, data: a.data }),
    });
    if (res.ok) return { status: "sent", providerMessageId: res.headers.get("x-message-id") ?? undefined };
    if (res.status === 404 || res.status === 410) return { status: "invalid", code: "GONE" };
    if (res.status === 429 || res.status >= 500) return { status: "retry", code: String(res.status) };
    return { status: "failed", code: String(res.status) };
  },
});
```

| The sender returns | The component then |
|---|---|
| `sent` (optional `providerMessageId`) | Marks the delivery sent |
| `retry` (optional `delayMs`, bounded to 1 s..1 day) | Queues it again, until the attempt limit or the message's expiry |
| `invalid` | Marks the delivery and the device invalid; the next registration restores the device |
| `failed` | Marks the delivery failed, no retry |
| Throws or times out | Counts as `retry` with code `SENDER_ERROR` |
| Anything else | Fails the delivery with `SENDER_BAD_RESULT` |

The sender may live in a `"use node"` file and read its own environment
variables. Delivery is at least once: use `deliveryId` as an idempotency key
where your provider supports one.

### The delivery hook

```ts
import { deliveryEvent } from "@vllnt/convex-push";

export const onDelivery = internalMutation({
  args: deliveryEvent,
  returns: v.null(),
  handler: async (ctx, e) => {
    await ctx.db.insert("pushEvents", e);
    return null;
  },
});
```

Pass it as `onDelivery: internal.push.onDelivery`. It runs once per delivery,
when it reaches `sent`, `failed` or `invalid`, never on a retry. The event holds
ids, platform, status and error code, never title, body or data. The component
schedules the hook instead of calling it inline, so a hook that throws cannot
undo the delivery record.

### Raw payload fields

```ts
overrides: { apns: { rawJson: JSON.stringify({ aps: { "relevance-score": 0.8 } }) } }
```

`rawJson` must parse to a JSON object. It is merged into the built payload last
and the size limit (4096 bytes for APNs and FCM, 3993 bytes of plaintext for
Web Push) is checked after the merge. Bad JSON or an oversized result is refused
when the message is queued. It reaches payload fields only, not headers.

## Composition at the host

Components never call each other. Your app wires them. The ticket reply flow
from sibling packages: inbox first, a push if the customer has not read it after
two minutes, email if there is no device.

```ts
export const nudge = internalMutation({
  args: nudgeArgs,
  returns: v.null(),
  handler: async (ctx, a) => {
    const item = await inbox.get(ctx, a.notificationId, { subjectRef: a.customerRef });
    if (!item || item.readAt) return null;
    const { deliveries } = await push.send(ctx, {
      to: { subjectRef: a.customerRef },
      title: "Support replied",
      data: { ticketRef: a.ticketRef },
      idempotencyKey: `reply:${a.notificationId}`,
    });
    if (deliveries === 0) await email.enqueue(ctx, a.notificationId, a.customerEmail, "support@example.com", "smtp");
    return null;
  },
});
```

`inbox` is `@vllnt/convex-notifications` and `email` is `@vllnt/convex-email`.

## Security

- **Keys stay in environment variables.** They are bound at mount, read inside
  the send action, and never written to a table, returned or logged.
- **Cached tokens are encrypted.** AES-256-GCM, with a key derived by HKDF from
  your private key inside the action. A database export holds no usable
  credential.
- **No content or address in queries or logs.** Queries return ids, statuses and
  codes. Logs carry ids, platforms and codes.
- **Content-free pushes are the private option.** Apple and Google read what you
  send them. Send a neutral title plus an id, and let the app fetch the text from
  Convex after it wakes. Web Push payloads are encrypted end to end.
- **Device tokens are stored in the clear,** because sending needs them. A token
  is useless without the provider key, except a Web Push endpoint without VAPID.
- **Requests go only where they should.** Provider requests never follow
  redirects. Web Push endpoints must be https to a public host name (no IP
  literals, `localhost` or private suffixes); DNS answers are not checked. A
  custom sender fetches whatever address you store, so validate it there.
- **Your app owns auth.** The optional `subjectRef` on `unregister` and
  `setDeviceStatus` guards against cross-user bugs in an honest host, not a
  hostile one.

## Limits

| Limit | Value |
|---|---|
| Devices per message | 100 (a subject's first 100 active devices) |
| Messages per `sendBatch` | 100, and 1,000 deliveries in total |
| Payload | 4096 bytes (APNs, FCM), 3993 bytes plaintext (Web Push) |
| `rawJson` | 4096 characters |
| `ttlSeconds` | 0 to 2,419,200 (28 days), default 86,400 |
| Attempts per delivery | default 5, at most 20 |
| Sends to one device | 60 per minute, then delayed |
| Retention | 30 days by the daily prune; `prune()` uses the client's `retentionMs`. A message is kept until a day after it expires |

## Testing your app

`@vllnt/convex-push/test` exports `register(t, name = "push")`. It mounts the
component and its child components (four workpools and a rate limiter) in a
`convex-test` instance. It needs `convex-test` and `vitest` (with Vite's
`import.meta.glob`).

```ts
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { register } from "@vllnt/convex-push/test";
import schema from "./schema";

const t = convexTest(schema, import.meta.glob("./**/*.ts"));
register(t, "push");
```

Stub `fetch` with `vi.stubGlobal` to script provider answers, and set keys with
`vi.stubEnv`. See [`example/convex/example.test.ts`](https://github.com/vllnt/convex-push/blob/main/example/convex/example.test.ts).

## Related packages

- [`@convex-dev/expo-push-notifications`](https://www.npmjs.com/package/@convex-dev/expo-push-notifications)
  — sends through Expo's push service. Use it if you want Expo to hold your
  Apple and Google credentials; use this package to send direct.
- `@vllnt/convex-notifications` — the in-app inbox with read state. A push can
  be lost; the inbox cannot. Use both.
- `@vllnt/convex-email` — the email channel, with its own queue.

## Contributing

See
[CONTRIBUTING.md](https://github.com/vllnt/convex-push/blob/main/CONTRIBUTING.md)
for development setup, testing, and PR guidelines.

## Author

Built by [bntvllnt](https://github.com/bntvllnt) ·
[bntvllnt.com](https://bntvllnt.com) · [X @bntvllnt](https://x.com/bntvllnt)

If this is useful, [sponsor the work](https://github.com/sponsors/bntvllnt).

## License

MIT — see [LICENSE](LICENSE).

---

Part of vllnt oss: https://oss.vllnt.com
