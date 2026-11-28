# @vllnt/convex-push

Convex component that sends push notifications from your backend straight to APNs, FCM and Web Push, with a device registry, retries and no relay service.

## For coding agents

`node_modules/@vllnt/convex-push/` ships `llms.txt`, `docs/API.md`, `CHANGELOG.md` and the TypeScript `src/` of the installed version; read them before writing code.
Call the `Push` class from host functions; keys are component env bound in `convex/convex.config.ts`, never function arguments.
Thrown errors are `ConvexError` with `data.code`; failed deliveries carry `errorCode` in `push.status()`; both are in [Errors and fixes](#errors-and-fixes).

## When to use

- Use it when your Convex backend sends push notifications to iOS (APNs), Android (FCM HTTP v1) or browsers (Web Push) with your own Apple key, Firebase service account or VAPID keys.
- Use it when you want the device registry, per-device delivery status, retries and dead-device cleanup inside your Convex deployment, with no third-party relay.
- Use it when another channel (for example a webhook) should share the same queue and retries: a custom provider is one host action.
- Do not use it when you want Expo's push service to hold your Apple and Google credentials and send for you: use `@convex-dev/expo-push-notifications`.
- Do not use it when you send to FCM topics or conditions instead of registered devices (this package removes `topic` and `condition` from FCM payloads): use `firebase-admin` in a `"use node"` action.

## Install

```bash
pnpm add @vllnt/convex-push@canary convex
```

Use the `canary` tag until 0.1.0 is released: npm `latest` still points at an older first canary build.

## Quick start

```ts
// convex/convex.config.ts
import push from "@vllnt/convex-push/convex.config";
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({ env: { FCM_SERVICE_ACCOUNT_JSON: v.optional(v.string()) } });
app.use(push, { env: { FCM_SERVICE_ACCOUNT_JSON: app.env.FCM_SERVICE_ACCOUNT_JSON } });
export default app;
```

```ts
// convex/push.ts
import { Push } from "@vllnt/convex-push";
import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import { internalMutation, mutation } from "./_generated/server";

const push = new Push(components.push, { apps: { android: { platform: "fcm" } } });

export const registerDevice = mutation({
  args: { token: v.string() },
  returns: v.object({ deviceId: v.string(), created: v.boolean() }),
  handler: async (ctx, { token }) => {
    const user = await ctx.auth.getUserIdentity();
    if (user === null) throw new ConvexError("not signed in");
    return push.register(ctx, { subjectRef: user.subject, appRef: "android", address: { platform: "fcm", token } });
  },
});

export const notify = internalMutation({
  args: { subjectRef: v.string(), title: v.string(), body: v.string() },
  returns: v.object({ messageId: v.string(), deliveries: v.number(), deduplicated: v.boolean() }),
  handler: async (ctx, { subjectRef, title, body }) => push.send(ctx, { to: { subjectRef }, title, body }),
});
```

```bash
npx convex env set FCM_SERVICE_ACCOUNT_JSON "$(cat service-account.json)"
npx convex dev
```

`npx convex dev` generates `components.push`. The app sends its FCM
registration token to `registerDevice`. Your own mutations call `notify`, for
example `ctx.runMutation(internal.push.notify, { subjectRef, title, body })`;
the send is part of that mutation's transaction, so if it fails nothing is
queued. Without the env value the delivery ends at once with
`PROVIDER_NOT_CONFIGURED`.

## API

Full reference: [docs/API.md](./docs/API.md). `push.` below is an instance of `Push`.

| Export | Import from | What it is |
|---|---|---|
| [`Push`](./docs/API.md#push) | `@vllnt/convex-push` | Class bound to one mount: `new Push(components.push, options)` |
| [`push.register(ctx, args)`](./docs/API.md#register) | `@vllnt/convex-push` | Register or refresh a device; returns `{ deviceId, created }` |
| [`push.unregister(ctx, args)`](./docs/API.md#unregister) | `@vllnt/convex-push` | Delete a device by id or address; returns `{ removed }` |
| [`push.setDeviceStatus(ctx, args)`](./docs/API.md#setdevicestatus) | `@vllnt/convex-push` | Pause (`disabled`) or resume (`active`) a device; returns `{ updated }` |
| [`push.listDevices(ctx, args)`](./docs/API.md#listdevices) | `@vllnt/convex-push` | A subject's devices, without addresses |
| [`push.send(ctx, message)`](./docs/API.md#send) | `@vllnt/convex-push` | Queue one message; returns `{ messageId, deliveries, deduplicated }` |
| [`push.sendBatch(ctx, messages)`](./docs/API.md#sendbatch) | `@vllnt/convex-push` | Queue up to 100 messages and 100 deliveries in one call |
| [`push.status(ctx, messageId)`](./docs/API.md#status) | `@vllnt/convex-push` | A message's per-device delivery state, or `null` |
| [`push.listBySubject(ctx, args)`](./docs/API.md#listbysubject) | `@vllnt/convex-push` | A subject's recent messages with counts per status |
| [`push.cancel(ctx, messageId)`](./docs/API.md#cancel) | `@vllnt/convex-push` | End the queued deliveries of a message; returns `{ cancelled }` |
| [`push.prune(ctx, args)`](./docs/API.md#prune) | `@vllnt/convex-push` | Delete data older than `retentionMs`; returns `{ deleted, more }` |
| [`PushOptions`](./docs/API.md#pushoptions) | `@vllnt/convex-push` | Type: options of `new Push` (`apps` required) |
| [`RegisterArgs`](./docs/API.md#register) | `@vllnt/convex-push` | Type: argument of `push.register` |
| [`SendMessage`](./docs/API.md#send) | `@vllnt/convex-push` | Type: one message for `push.send` (same as `SendInput`) |
| [`SendInput`](./docs/API.md#send) | `@vllnt/convex-push` | Type: one message as validated by the component |
| [`CustomSender`](./docs/API.md#custom-sender) | `@vllnt/convex-push` | Type: reference to a host action that sends for a custom provider |
| [`DeliveryHook`](./docs/API.md#delivery-hook) | `@vllnt/convex-push` | Type: reference to a host mutation run once per finished delivery |
| [`RunMutationCtx`](./docs/API.md#context-types) | `@vllnt/convex-push` | Type: any context with `runMutation` |
| [`RunQueryCtx`](./docs/API.md#context-types) | `@vllnt/convex-push` | Type: any context with `runQuery` (query or mutation) |
| [`AnyQueryCtx`](./docs/API.md#context-types) | `@vllnt/convex-push` | Type: a query, mutation or action context |
| [`appConfig`](./docs/API.md#validators-and-types) | `@vllnt/convex-push` | Validator: what one `appRef` means |
| [`AppConfig`](./docs/API.md#validators-and-types) | `@vllnt/convex-push` | Type of `appConfig` |
| [`deviceAddress`](./docs/API.md#validators-and-types) | `@vllnt/convex-push` | Validator: an APNs, FCM, Web Push or custom address |
| [`DeviceAddress`](./docs/API.md#validators-and-types) | `@vllnt/convex-push` | Type of `deviceAddress` |
| [`data`](./docs/API.md#validators-and-types) | `@vllnt/convex-push` | Validator: flat `data` record of strings, numbers and booleans |
| [`PushData`](./docs/API.md#validators-and-types) | `@vllnt/convex-push` | Type of `data` |
| [`overrides`](./docs/API.md#validators-and-types) | `@vllnt/convex-push` | Validator: per-provider settings and `rawJson` |
| [`Overrides`](./docs/API.md#validators-and-types) | `@vllnt/convex-push` | Type of `overrides` |
| [`customSendArgs`](./docs/API.md#custom-sender) | `@vllnt/convex-push` | Validator: arguments of a custom provider's action |
| [`CustomSendArgs`](./docs/API.md#custom-sender) | `@vllnt/convex-push` | Type of `customSendArgs` |
| [`sendResult`](./docs/API.md#custom-sender) | `@vllnt/convex-push` | Validator: what a custom provider's action returns |
| [`SendResult`](./docs/API.md#custom-sender) | `@vllnt/convex-push` | Type of `sendResult` |
| [`deliveryEvent`](./docs/API.md#delivery-hook) | `@vllnt/convex-push` | Validator: the event the delivery hook receives |
| [`DeliveryEvent`](./docs/API.md#delivery-hook) | `@vllnt/convex-push` | Type of `deliveryEvent` |
| [`deviceView`](./docs/API.md#validators-and-types) | `@vllnt/convex-push` | Validator: a device as `listDevices` returns it |
| [`DeviceView`](./docs/API.md#validators-and-types) | `@vllnt/convex-push` | Type of `deviceView` |
| [`deliveryView`](./docs/API.md#validators-and-types) | `@vllnt/convex-push` | Validator: one delivery inside `messageStatus` |
| [`DeliveryView`](./docs/API.md#validators-and-types) | `@vllnt/convex-push` | Type of `deliveryView` |
| [`messageStatus`](./docs/API.md#validators-and-types) | `@vllnt/convex-push` | Validator: what `status` returns |
| [`MessageStatus`](./docs/API.md#validators-and-types) | `@vllnt/convex-push` | Type of `messageStatus` |
| [`messageSummary`](./docs/API.md#validators-and-types) | `@vllnt/convex-push` | Validator: one row of `listBySubject` |
| [`MessageSummary`](./docs/API.md#validators-and-types) | `@vllnt/convex-push` | Type of `messageSummary` |
| [`COMPONENT_NAME`](./docs/API.md#statuses-and-platforms) | `@vllnt/convex-push` | `"push"`: the default mount name |
| [`PLATFORMS`](./docs/API.md#statuses-and-platforms) | `@vllnt/convex-push` | `["apns", "fcm", "webpush", "custom"]` |
| [`Platform`](./docs/API.md#statuses-and-platforms) | `@vllnt/convex-push` | Type: one of `PLATFORMS` |
| [`DEVICE_STATUSES`](./docs/API.md#statuses-and-platforms) | `@vllnt/convex-push` | `["active", "disabled", "invalid"]` |
| [`DeviceStatus`](./docs/API.md#statuses-and-platforms) | `@vllnt/convex-push` | Type: one of `DEVICE_STATUSES` |
| [`DELIVERY_STATUSES`](./docs/API.md#statuses-and-platforms) | `@vllnt/convex-push` | `["queued", "sent", "failed", "invalid"]` |
| [`DeliveryStatus`](./docs/API.md#statuses-and-platforms) | `@vllnt/convex-push` | Type: one of `DELIVERY_STATUSES` |
| [`ERROR_CODES`](./docs/API.md#errors) | `@vllnt/convex-push` | Codes thrown as `ConvexError({ code, message })` |
| [`PushErrorCode`](./docs/API.md#errors) | `@vllnt/convex-push` | Type: one of `ERROR_CODES` |
| [`DELIVERY_ERROR_CODES`](./docs/API.md#delivery-error-codes) | `@vllnt/convex-push` | Codes the component writes to a delivery's `errorCode` |
| [`DeliveryErrorCode`](./docs/API.md#delivery-error-codes) | `@vllnt/convex-push` | Type: one of `DELIVERY_ERROR_CODES` |
| [`DEFAULT_MAX_ATTEMPTS`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `5` attempts per delivery |
| [`MAX_MAX_ATTEMPTS`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `20`: highest `maxAttempts` |
| [`DEFAULT_TTL_SECONDS`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `86_400` (one day) |
| [`MAX_TTL_SECONDS`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `2_419_200` (28 days) |
| [`ZERO_TTL_WINDOW_MS`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `30_000`: how long a `ttlSeconds: 0` message stays sendable |
| [`DEFAULT_MAX_PARALLELISM`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `10` sends in flight per provider pool |
| [`MAX_MAX_PARALLELISM`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `100`: highest `maxParallelism` |
| [`DEFAULT_RETENTION_MS`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `2_592_000_000` (30 days) |
| [`DEFAULT_PRUNE_BATCH`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `1000` rows per prune pass |
| [`MAX_PRUNE_BATCH`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `1000`: highest prune `batch` |
| [`PRUNE_DEVICES_PER_PASS`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `100` invalid devices per prune pass |
| [`PRUNE_MESSAGES_PER_PASS`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `100` messages looked at per prune pass |
| [`PRUNE_GRACE_MS`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `86_400_000`: a message is pruned only a day after it expires |
| [`MAX_DEVICES_PER_MESSAGE`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `100` devices per message |
| [`MAX_BATCH_MESSAGES`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `100` messages per `sendBatch` |
| [`MAX_BATCH_DELIVERIES`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `100` deliveries per `sendBatch` |
| [`MAX_LIST_LIMIT`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `100` rows per list query |
| [`MAX_REF_LENGTH`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `256` characters per ref, idempotency key or stored code |
| [`MAX_TEXT_LENGTH`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `1024` characters per title, body or data string |
| [`MAX_TOKEN_LENGTH`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `512` characters per APNs or FCM token |
| [`MAX_ENDPOINT_LENGTH`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `2048` characters per Web Push endpoint |
| [`MAX_CUSTOM_ADDRESS_LENGTH`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `2048` characters per custom address |
| [`MAX_RAW_JSON_LENGTH`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `4096` characters per `rawJson` |
| [`MAX_DATA_KEYS`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `100` keys in `data` |
| [`MAX_COLLAPSE_KEY_BYTES`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `64` bytes per `collapseKey` |
| [`APNS_MAX_PAYLOAD_BYTES`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `4096` bytes per APNs payload |
| [`FCM_MAX_PAYLOAD_BYTES`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `4096` bytes per FCM message |
| [`WEBPUSH_MAX_PLAINTEXT_BYTES`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `3993` bytes per Web Push plaintext |
| [`RETRY_BASE_DELAY_MS`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `60_000`: first backoff, doubled per attempt |
| [`RETRY_MAX_DELAY_MS`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `1_800_000`: longest computed backoff |
| [`APNS_SERVER_ERROR_DELAY_MS`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `900_000`: wait after an APNs 5xx without `Retry-After` |
| [`PROVIDER_REQUEST_TIMEOUT_MS`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `15_000`: time limit per provider request |
| [`DEVICE_SENDS_PER_MINUTE`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `60` sends per device per minute before delay |
| [`BAD_TOKEN_BURST_LIMIT`](./docs/API.md#limits-and-defaults) | `@vllnt/convex-push` | `20` APNs bad-token answers per app in 10 minutes before the app pauses |
| [`default`](./docs/API.md#component-definition) | `@vllnt/convex-push/convex.config` | The component definition for `app.use()` (also `/convex.config.js`) |
| [`register`](./docs/API.md#test-helper) | `@vllnt/convex-push/test` | `register(t, name = "push")`: mount the component in `convex-test` |
| [`default`](./docs/API.md#test-helper) | `@vllnt/convex-push/test` | `{ register, schema, modules }` |
| [`ComponentApi`](./docs/API.md#componentapi) | `@vllnt/convex-push/_generated/component` | Type of `components.push` (also `/_generated/component.js`) |

## Common tasks

### Bind keys for APNs, FCM and Web Push

Every variable is optional. A provider without its keys is off, and its
deliveries end with `PROVIDER_NOT_CONFIGURED`.

```ts
// convex/convex.config.ts
import push from "@vllnt/convex-push/convex.config";
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({
  env: {
    APNS_KEY_P8: v.optional(v.string()),
    APNS_KEY_ID: v.optional(v.string()),
    APNS_TEAM_ID: v.optional(v.string()),
    FCM_SERVICE_ACCOUNT_JSON: v.optional(v.string()),
    VAPID_PUBLIC_KEY: v.optional(v.string()),
    VAPID_PRIVATE_KEY: v.optional(v.string()),
    VAPID_SUBJECT: v.optional(v.string()),
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

```bash
npx convex env set APNS_KEY_P8 "$(cat AuthKey_ABC123DEFG.p8)"
npx convex env set APNS_KEY_ID ABC123DEFG
npx convex env set APNS_TEAM_ID TEAM123456
```

`APNS_SANDBOX_KEY_P8` and `APNS_SANDBOX_KEY_ID` add an Apple key used only for
`environment: "sandbox"` apps. Values for every variable:
[environment variables](./docs/API.md#environment-variables).

### Name your apps

An `appRef` is your name for one app on one platform. The settings travel with
every call, so a change takes effect on the next send.

```ts
// convex/pushClient.ts
import { Push } from "@vllnt/convex-push";
import { components } from "./_generated/api";

export const push = new Push(components.push, {
  apps: {
    ios: { platform: "apns", topic: "com.example.app", environment: "production" },
    "ios-dev": { platform: "apns", topic: "com.example.app", environment: "sandbox" },
    android: { platform: "fcm" },
    web: { platform: "webpush" },
  },
});
```

### Register and remove devices

Your app owns auth: resolve the user in your function and pass an opaque
`subjectRef`. Register on every app launch.

```ts
// convex/devices.ts
import { deviceAddress } from "@vllnt/convex-push";
import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { push } from "./pushClient";

export const registerDevice = mutation({
  args: { appRef: v.string(), address: deviceAddress, installRef: v.optional(v.string()), locale: v.optional(v.string()) },
  returns: v.object({ deviceId: v.string(), created: v.boolean() }),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    if (user === null) throw new ConvexError("not signed in");
    return push.register(ctx, { subjectRef: user.subject, ...args });
  },
});

export const removeDevice = mutation({
  args: { deviceId: v.string() },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, { deviceId }) => {
    const user = await ctx.auth.getUserIdentity();
    if (user === null) throw new ConvexError("not signed in");
    return push.unregister(ctx, { deviceId, subjectRef: user.subject });
  },
});
```

| Platform | Address | Where the client gets it |
|---|---|---|
| `apns` | `{ platform: "apns", token }` | `registerForRemoteNotifications()`, or `getDevicePushTokenAsync()` in Expo (`type: "ios"`) |
| `fcm` | `{ platform: "fcm", token }` | `FirebaseMessaging.getToken()`, or `getDevicePushTokenAsync()` in Expo (`type: "android"`) |
| `webpush` | `{ platform: "webpush", endpoint, p256dh, auth }` | `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` |
| `custom` | `{ platform: "custom", provider, address }` | Your own provider (see below) |

### Send to a user

```ts
// convex/replies.ts
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { push } from "./pushClient";

export const notifyReply = internalMutation({
  args: { customerRef: v.string(), ticketRef: v.string(), replyRef: v.string(), preview: v.string() },
  returns: v.object({ messageId: v.string(), deliveries: v.number(), deduplicated: v.boolean() }),
  handler: async (ctx, args) =>
    push.send(ctx, {
      to: { subjectRef: args.customerRef },
      title: "Support replied",
      body: args.preview,
      data: { kind: "ticket.reply", ticketRef: args.ticketRef },
      collapseKey: `ticket:${args.ticketRef}`,
      ttlSeconds: 3600,
      idempotencyKey: `reply:${args.replyRef}`,
      overrides: { apns: { threadId: args.ticketRef }, fcm: { channelId: "support" } },
    }),
});
```

`to` is `{ subjectRef }` (that subject's active devices) or `{ deviceIds }`. A
second send with the same `idempotencyKey` returns the first message with
`deduplicated: true`. A message with neither `title` nor `body` is silent: a
background push on APNs, a data-only message on FCM, and refused per delivery
on Web Push (`SILENT_NOT_SUPPORTED`).

### Show delivery state and cancel

```ts
// convex/pushStatus.ts
import { messageStatus } from "@vllnt/convex-push";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { push } from "./pushClient";

export const deliveryState = query({
  args: { messageId: v.string() },
  returns: v.union(messageStatus, v.null()),
  handler: async (ctx, { messageId }) => {
    if ((await ctx.auth.getUserIdentity()) === null) throw new ConvexError("not signed in");
    return push.status(ctx, messageId);
  },
});

export const cancelMessage = mutation({
  args: { messageId: v.string() },
  returns: v.object({ cancelled: v.number() }),
  handler: async (ctx, { messageId }) => {
    if ((await ctx.auth.getUserIdentity()) === null) throw new ConvexError("not signed in");
    return push.cancel(ctx, messageId);
  },
});
```

`status` is reactive in a query. Each delivery ends `sent`, `failed` or
`invalid`, with the provider's message id or an `errorCode`. Queries never
return a device address, a token or message content. The component reads no
auth: check who may read or cancel in your own function.

### Add a custom provider and a delivery hook

A custom provider is one host action that sends one notification to one
address. The component keeps the device, queue, retries, expiry and
dead-address handling. The hook is one host mutation, scheduled once per
delivery when it reaches `sent`, `failed` or `invalid`.

```ts
// convex/pushSenders.ts
import { customSendArgs, type SendResult, sendResult } from "@vllnt/convex-push";
import { internalAction } from "./_generated/server";

export const webhook = internalAction({
  args: customSendArgs,
  returns: sendResult,
  handler: async (_ctx, args): Promise<SendResult> => {
    const response = await fetch(args.address, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": args.deliveryId },
      body: JSON.stringify({ title: args.title, body: args.body, data: args.data }),
    });
    if (response.ok) return { status: "sent", providerMessageId: response.headers.get("x-message-id") ?? undefined };
    if (response.status === 404 || response.status === 410) return { status: "invalid", code: "GONE" };
    if (response.status === 429 || response.status >= 500) return { status: "retry", code: String(response.status) };
    return { status: "failed", code: String(response.status) };
  },
});
```

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  pushEvents: defineTable({ deliveryId: v.string(), status: v.string(), at: v.number() }),
});
```

```ts
// convex/pushHooks.ts
import { deliveryEvent } from "@vllnt/convex-push";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

export const onDelivery = internalMutation({
  args: deliveryEvent,
  returns: v.null(),
  handler: async (ctx, event) => {
    await ctx.db.insert("pushEvents", { deliveryId: event.deliveryId, status: event.status, at: event.at });
    return null;
  },
});
```

```ts
// convex/pushCustom.ts
import { Push } from "@vllnt/convex-push";
import { components, internal } from "./_generated/api";

// The annotation breaks the type cycle through `internal`.
export const pushWithWebhook: Push = new Push(components.push, {
  apps: { desktop: { platform: "custom", provider: "webhook" } },
  providers: { webhook: { send: internal.pushSenders.webhook } },
  onDelivery: internal.pushHooks.onDelivery,
});
```

What the sender returns decides the next step:
[custom sender contract](./docs/API.md#custom-sender). Delivery is at least
once: pass `deliveryId` as an idempotency key where your provider takes one.

### Set provider fields that have no typed option

```ts
// convex/rawPayload.ts
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { push } from "./pushClient";

export const sendRanked = internalMutation({
  args: { subjectRef: v.string(), title: v.string() },
  returns: v.object({ messageId: v.string(), deliveries: v.number(), deduplicated: v.boolean() }),
  handler: async (ctx, { subjectRef, title }) =>
    push.send(ctx, {
      to: { subjectRef },
      title,
      overrides: { apns: { rawJson: JSON.stringify({ aps: { "relevance-score": 0.8 } }) } },
    }),
});
```

`rawJson` must parse to a JSON object of at most 4096 characters. It is merged
into the built payload last; payload size is checked after the merge, when the
message is queued. It reaches payload fields only, never headers.

### Change retention or prune now

```ts
// convex/maintenance.ts
import { Push } from "@vllnt/convex-push";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const shortRetention = new Push(components.push, { apps: {}, retentionMs: 7 * 86_400_000 });

export const pruneWeek = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), more: v.boolean() }),
  handler: async (ctx) => shortRetention.prune(ctx, { batch: 500 }),
});
```

The component's own daily cron always prunes with the 30-day default; schedule
your own call (as above) for another window.

### Use a second Apple team or Firebase project

Each mount has its own tables, queues and keys.

```ts
// convex/convex.config.ts
import push from "@vllnt/convex-push/convex.config";
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({ env: { PARTNER_FCM_SERVICE_ACCOUNT_JSON: v.optional(v.string()) } });
app.use(push);
app.use(push, { name: "pushPartner", env: { FCM_SERVICE_ACCOUNT_JSON: app.env.PARTNER_FCM_SERVICE_ACCOUNT_JSON } });
export default app;
```

The second mount is `components.pushPartner`: `new Push(components.pushPartner, options)`.

## Errors and fixes

Thrown errors are `ConvexError` with `data.code`; the call changes nothing.

| Code | Thrown by | Cause | Fix |
|---|---|---|---|
| `INVALID_ARGUMENT` | `register`, `unregister`, `send`, `sendBatch`, `listDevices`, `listBySubject`, `prune` | A ref (`subjectRef`, `appRef`, `installRef`, a custom address's `provider`, a `providers` name, `idempotencyKey`) is empty or over 256 characters; `locale` is over 64; `title` or `body` is over 1024; `to.deviceIds` lists 0 or over 100 ids; `sound`, `category`, `threadId` or `channelId` is over 256, Web Push `icon` or `url` over 1024; `collapseKey`, `ttlSeconds`, `badge`, `maxAttempts`, `maxParallelism`, list `limit`, `batch` or `retentionMs` is out of range; an APNs `topic` is empty or not printable ASCII without spaces; a `providers` sender or `onDelivery` is not a function handle; `sendBatch` is over 100 messages or 100 deliveries; `unregister` got both or neither of `deviceId` and `address` | Fix the value; split the batch; pass function references (`internal.module.fn`) for senders and the hook. Ranges: [Limits and gotchas](#limits-and-gotchas) |
| `INVALID_ADDRESS` | `register` | A token is empty, over 512 characters or has whitespace; a Web Push endpoint is not https to a public host on the default port; `p256dh` is not 65 bytes or `auth` not 16; a custom address is empty or over 2048 characters | Pass the address the platform SDK returned, unchanged |
| `INVALID_DATA` | `send`, `sendBatch` | `data` has over 100 keys, a key that is empty, over 256 characters or reserved (`aps`, `from`, `notification`, `message_type`, `collapse_key`, `google.*`, `gcm.*`), a non-finite number or a string over 1024 characters | Rename or shorten the keys and values |
| `INVALID_RAW_JSON` | `send`, `sendBatch` | An `overrides.*.rawJson` is not a JSON object or is over 4096 characters | Pass `JSON.stringify` of an object |
| `PAYLOAD_TOO_LARGE` | `send`, `sendBatch` | A provider's payload is over its limit after `rawJson` is merged (4096 bytes APNs and FCM, 3993 bytes Web Push plaintext) | Shorten text or `data`; send an id and fetch the rest in the app |
| `UNKNOWN_APP` | `register` | `appRef` is not a key of `apps` in `PushOptions` | Add the app to `apps` or fix the name |
| `PLATFORM_MISMATCH` | `register` | The address platform (or custom `provider`) differs from the app's | Register with the `appRef` of that platform |

Delivery codes are not thrown: they end one delivery and show in
`push.status()`, `listBySubject` counts and the hook's `errorCode`.

| Code | Delivery | Cause | Fix |
|---|---|---|---|
| `APP_NOT_CONFIGURED` | `failed` | The device's `appRef` is not in this `Push` instance's `apps`, or its platform or provider no longer matches | Use one `apps` map for every `Push` instance of a mount |
| `APP_PAUSED` | `failed` | 20 APNs `BadDeviceToken` or `DeviceTokenNotForTopic` answers for one `appRef` within a 10-minute window; later answers and new sends for that app end here, and their devices are not marked invalid | Check the app's `environment` (sandbox or production) and `topic`; sends resume when the 10-minute window ends |
| `BAD_SUBSCRIPTION_KEYS` | `invalid` | A Web Push subscription's keys cannot encrypt | The browser must subscribe again and register the new subscription |
| `CANCELLED` | `failed` | `push.cancel` ended it, or its queued job was cancelled | None; send again if needed |
| `CREDENTIALS_INVALID` | `failed` | A key in env cannot be used: the `.p8` or service-account key does not import, the service-account JSON lacks `project_id`, `client_email` or `private_key`, `VAPID_SUBJECT` is not `mailto:` or `https:`, the VAPID keys do not import, or Google refused the token exchange (not 429 or 5xx) | Fix the env value with `npx convex env set` |
| `DEVICE_DISABLED` | `failed` | The device was set `disabled` after the message was queued | None, or `setDeviceStatus(..., "active")` |
| `DEVICE_GONE` | `failed` | The device was deleted (`unregister`, `prune`) after the message was queued | None |
| `DEVICE_INVALID` | `failed` | The device was marked invalid after the message was queued | Wait for the app to register again |
| `DEVICE_REASSIGNED` | `failed` | The device moved to another subject after the message was queued | None: the old subject's message is not sent to the new owner |
| `FAILED` | `failed` | A custom sender returned `failed` without a `code` | Return a `code` from your sender |
| `GONE` | `invalid` | Web Push answered 410: the subscription ended | The browser must subscribe again |
| `INVALID` | `invalid` | A custom sender returned `invalid` without a `code` | Return a `code` from your sender |
| `NETWORK_ERROR` | retried | The provider request failed before an answer | None: it is retried until the attempt limit or expiry |
| `NOT_FOUND` | `invalid` | Web Push answered 404 | The browser must subscribe again |
| `PAYLOAD_TOO_LARGE` | `failed` | Web Push answered 413 | Shorten the message |
| `PROVIDER_NOT_CONFIGURED` | `failed` | The provider's env keys are not set, or a custom provider has no entry in `providers` | Bind and set the keys ([Bind keys](#bind-keys-for-apns-fcm-and-web-push)), or add the sender to `providers` |
| `RETRY_LIMIT` | `failed` | The attempt limit (`maxAttempts`) was reached with no provider code (otherwise the last code stays) | Raise `maxAttempts` (at most 20) or fix the cause |
| `SENDER_BAD_RESULT` | `failed` | A custom sender returned a value that is not a `sendResult` | Return one of the four `sendResult` shapes |
| `SENDER_ERROR` | retried | A custom sender threw or timed out, or the send action failed | Fix the sender; it is retried until the attempt limit or expiry |
| `SILENT_NOT_SUPPORTED` | `failed` | A message with neither `title` nor `body` to a Web Push device | Give Web Push messages a `title` or `body` |
| `TIMEOUT` | retried | The provider did not answer within 15 seconds | None: it is retried |
| `TOKEN_EXCHANGE_UNAVAILABLE` | retried | Google's token endpoint answered 429 or 5xx | None: it is retried |
| `TTL_EXPIRED` | `failed` | The message expired before the send, the next retry would land after expiry, or the per-device fuse would delay it past expiry | Raise `ttlSeconds`, or send to that device less often |

Provider codes are stored as the provider sent them:

| Code | Provider | Delivery | Fix |
|---|---|---|---|
| `BadDeviceToken`, `DeviceTokenNotForTopic`, `ExpiredToken`, `Unregistered` | APNs (400 or 410) | `invalid`; the device is marked invalid unless it registered after Apple's timestamp | Wait for the app to register again; check `environment` and `topic` |
| `ExpiredProviderToken` | APNs (403) | retried; the cached token is dropped | None |
| `UNREGISTERED` | FCM | `invalid` | Wait for the app to register again |
| The reason as sent (for example `UNAUTHENTICATED`) | FCM (401) | retried; the cached access token is dropped | Check the service account if it repeats |
| `INVALID_ARGUMENT` | FCM (400 on `message.token`) | `invalid` | Wait for the app to register again |
| `HTTP_401`, `HTTP_403` | Web Push | retried; the cached VAPID token is dropped | Check the VAPID key pair if it repeats |
| `HTTP_<status>` or the provider's reason | any | `failed` (4xx), retried (429, 5xx) | Read the provider's reason |

## Limits and gotchas

| Limit | Value | Over the limit |
|---|---|---|
| Devices per message | 100 | A subject send reaches its first 100 active devices; the rest get nothing (logged as `message.device_cap`) |
| `to.deviceIds` | 1 to 100 | `INVALID_ARGUMENT`; unknown or inactive ids are skipped silently |
| `sendBatch` | 100 messages and 100 deliveries | `INVALID_ARGUMENT`, nothing queued; deduplicated messages count 0 |
| `title`, `body`, `data` strings | 1024 characters | `INVALID_ARGUMENT` / `INVALID_DATA` |
| `data` keys | 100 | `INVALID_DATA` |
| Refs (`subjectRef`, `appRef`, `installRef`, provider names, `idempotencyKey`) | 1 to 256 characters | `INVALID_ARGUMENT` |
| `locale` | 64 characters | `INVALID_ARGUMENT` |
| `collapseKey` | 1 to 64 printable ASCII bytes | `INVALID_ARGUMENT` |
| `badge` | integer 0 to 1,000,000 | `INVALID_ARGUMENT` |
| `sound`, `category`, `threadId`, `channelId` | 256 characters | `INVALID_ARGUMENT` |
| Web Push `icon`, `url` | 1024 characters | `INVALID_ARGUMENT` |
| `rawJson` | 4096 characters, a JSON object | `INVALID_RAW_JSON` |
| Payload | 4096 bytes APNs and FCM, 3993 bytes Web Push plaintext | `PAYLOAD_TOO_LARGE` |
| Token / endpoint / custom address | 512 / 2048 / 2048 characters | `INVALID_ADDRESS` |
| `ttlSeconds` | integer 0 to 2,419,200 (28 days), default 86,400 | `INVALID_ARGUMENT`; `0` means sendable for 30 seconds |
| `maxAttempts` | 1 to 20, default 5 | `INVALID_ARGUMENT` at the next send |
| `maxParallelism` | 1 to 100, default 10 | `INVALID_ARGUMENT` at the next send |
| List `limit` | 1 to 100, default 20 | `INVALID_ARGUMENT` |
| `status` deliveries | first 100 | Not returned |
| Sends to one device | 60 per minute | Delayed, or `TTL_EXPIRED` if the delay passes expiry |
| APNs bad-token burst per `appRef` | 20 in 10 minutes | That app's deliveries end `APP_PAUSED` until the window ends |
| Retry delay | 1 minute doubling to 30 minutes; `Retry-After` honoured within 1 second to 1 day; 15 minutes after an APNs 5xx and 60 seconds after an FCM 429 when no `Retry-After` | Retries stop at `maxAttempts` or expiry |
| Provider request | 15 seconds | Retried as `TIMEOUT` |
| `prune` `batch` | 1 to 1,000, default 1,000 | `INVALID_ARGUMENT` |
| Prune pass | about `batch` message and delivery rows (oldest `min(batch, 100)` messages looked at), 100 invalid devices, 100 cached tokens looked at | Reschedules itself while there is more |
| Retention | 30 days (`retentionMs`); a message is kept until a day after it expires | Daily cron uses 30 days |

- `new Push(...)` checks nothing: `apps`, `maxAttempts`, `maxParallelism` and handles are checked by the component on each send.
- No keys is not an error: deliveries end `PROVIDER_NOT_CONFIGURED` and `send` still returns their count.
- `apps` travel with each call. Two `Push` instances on one mount with different `apps` fail each other's devices with `APP_NOT_CONFIGURED`.
- `maxParallelism` is pool-wide per provider: the last live send's value wins for every sender on that mount.
- A silent message (no `title`, no `body`) never reaches Web Push devices (`SILENT_NOT_SUPPORTED`).
- FCM receives every `data` value as a string. `category` is the FCM Android channel unless `overrides.fcm.channelId` is set.
- The default collapse id on APNs and Web Push is the message id, so a resend of the same message replaces the first.
- `rawJson` cannot change who receives an FCM message: `topic` and `condition` are removed.
- `cancel` cannot stop a job already running; if that job learns the device is dead, the device is still marked invalid.
- Re-registering an `invalid` device makes it `active`; a `disabled` device stays disabled unless another subject registers it.
- `scrubContent` is on by default: title, body, data and overrides are erased once no delivery is queued.
- The daily cron ignores `retentionMs`. With `retentionMs` under 29 days, a message past the cutoff but not yet a day past expiry is skipped; if every message a pass looks at (the oldest `min(batch, 100)`) is still inside expiry plus one day, the pass deletes no messages.
- `unregister` and `setDeviceStatus` with `subjectRef` return `false` for another subject's device; this guards host bugs, not hostile callers.
- Version 0.1.0 is a canary: senders are tested against recorded provider responses, not real devices.

## Compatibility

- Peer `convex` `^1.47.0`; the package test installs `convex@1.47.0`, the low end.
- Runtime: the Convex default runtime. Sends use `fetch` and Web Crypto; no Node action is needed. Apple accepts only HTTP/2; an action's `fetch` reached Apple over HTTP/2 on a local Convex backend. Hosted Convex has not been checked yet.
- TypeScript: the package test type-checks a consumer with TypeScript 5.9 under `moduleResolution` `Bundler` and `NodeNext`.
- Node: `engines.node` is `>=18`.
- `@vllnt/convex-push/test` is TypeScript source that needs Vite's `import.meta.glob` (Vitest) and `convex-test` (tested with 0.0.73).

## Testing

`register(t, name = "push")` from `@vllnt/convex-push/test` mounts the
component, its four workpools and its rate limiter in a `convex-test`
instance. This test runs in CI against the Quick start code above:

```ts
// convex/push.test.ts
/// <reference types="vite/client" />
import { register } from "@vllnt/convex-push/test";
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

test("a send reaches the registered device", async () => {
  const t = convexTest(schema, import.meta.glob("./**/*.ts"));
  register(t);
  await t.withIdentity({ subject: "user_1" }).mutation(api.push.registerDevice, { token: "fcm-token-1" });
  const sent = await t.mutation(internal.push.notify, { subjectRef: "user_1", title: "Hi", body: "Test" });
  expect(sent).toMatchObject({ deliveries: 1, deduplicated: false });
});
```

Run it with the `edge-runtime` environment and `convex-test` inlined
(`test: { environment: "edge-runtime", server: { deps: { inline: ["convex-test", "@vllnt/convex-push"] } } }`
in `vitest.config.mts`): the helper is TypeScript source that Vite must transform. Stub `fetch` with `vi.stubGlobal` to script provider
answers, and set keys with `vi.stubEnv`.

## Security

- Keys come only from component env bound at mount. They are read inside the send action and never written to a table, returned or logged.
- Cached provider tokens are stored encrypted (AES-256-GCM, key derived with HKDF from your private key inside the action).
- Queries return ids, statuses and codes, never a device address, token or message content. Logs carry ids, platforms, statuses and codes.
- Device tokens and Web Push subscriptions are stored in plain text, because sending needs them.
- Provider requests never follow redirects. Web Push endpoints must be https to a public host name (no IP literals, `localhost` or private suffixes); DNS answers are not checked. The Google token exchange always goes to `oauth2.googleapis.com`.
- A custom sender fetches whatever address you stored: validate it in your sender.
- Apple and Google read what you send them. For private content, send a neutral title and an id, and let the app fetch the text after it wakes. Web Push payloads are encrypted end to end (RFC 8291).

Full model: [security model](./docs/API.md#security-model).

## Related packages

- [`@vllnt/logger`](https://oss.vllnt.com/packages/logger): runtime dependency; the component logs through `createConvexLogger("push")` with ids, platforms, statuses and codes only.
- [`@convex-dev/workpool`](https://github.com/get-convex/workpool): runtime dependency; one pool per provider runs the send jobs.
- [`@convex-dev/rate-limiter`](https://github.com/get-convex/rate-limiter): runtime dependency; the per-device fuse and the APNs bad-token breaker.

## Contributing

See [CONTRIBUTING.md](https://github.com/vllnt/convex-push/blob/main/CONTRIBUTING.md)
for setup, checks and pull request rules.

## Links

- Docs and changelog: [oss.vllnt.com/packages/convex-push](https://oss.vllnt.com/packages/convex-push) · [release feed](https://oss.vllnt.com/packages/convex-push/rss.xml)
- All @vllnt packages: [oss.vllnt.com](https://oss.vllnt.com) · [search packages and docs on index.vllnt.com](https://index.vllnt.com)
- Source and issues: [GitHub](https://github.com/vllnt/convex-push) · [issues](https://github.com/vllnt/convex-push/issues) · [npm](https://www.npmjs.com/package/@vllnt/convex-push)
- Questions and updates: [Discord](https://bntvllnt.com/discord) · [X @bntvllnt](https://x.com/bntvllnt)
- Company and author: [vllnt.com](https://vllnt.com) · [bntvllnt.com](https://bntvllnt.com) · [GitHub @bntvllnt](https://github.com/bntvllnt) · [LinkedIn](https://linkedin.com/in/bntvllnt)
- Sponsor: [GitHub Sponsors](https://github.com/sponsors/bntvllnt)

## License

MIT. See [LICENSE](./LICENSE).

---

Part of [vllnt open source](https://oss.vllnt.com) · [Package page](https://oss.vllnt.com/packages/convex-push) · [vllnt.com](https://vllnt.com) · Built by [bntvllnt](https://bntvllnt.com)
