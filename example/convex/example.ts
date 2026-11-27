import { v } from "convex/values";
import {
  customSendArgs,
  deliveryEvent,
  deviceAddress,
  deviceView,
  messageStatus,
  messageSummary,
  overrides,
  Push,
  type SendResult,
  sendResult,
} from "../../src/client/index.js";
import { components, internal } from "./_generated/api.js";
import { internalAction, internalMutation, mutation, query } from "./_generated/server.js";

/**
 * Host wiring. Real apps resolve `subjectRef` from their own auth (ctx.auth) inside these wrappers;
 * the example takes it as an argument so tests can drive it.
 */
const apps = {
  ios: { platform: "apns", topic: "com.example.app", environment: "production" },
  "ios-dev": { platform: "apns", topic: "com.example.app", environment: "sandbox" },
  android: { platform: "fcm" },
  web: { platform: "webpush" },
  desktop: { platform: "custom", provider: "webhook" },
} as const;

const push = new Push(components.push, {
  apps,
  providers: { webhook: { send: internal.example.webhookSender } },
  onDelivery: internal.example.onDelivery,
  maxAttempts: 3,
});

/** Same mount, but with a hook that always throws, to show it cannot undo a delivery record. */
const pushWithFailingHook = new Push(components.push, {
  apps,
  providers: { webhook: { send: internal.example.webhookSender } },
  onDelivery: internal.example.failingHook,
});

/** The second mount, without custom providers or keys. */
const partner = new Push(components.pushPartner, { apps, scrubContent: false, retentionMs: 1000 });

const sendArgs = {
  subjectRef: v.optional(v.string()),
  deviceIds: v.optional(v.array(v.string())),
  title: v.optional(v.string()),
  body: v.optional(v.string()),
  data: v.optional(v.record(v.string(), v.union(v.string(), v.number(), v.boolean()))),
  collapseKey: v.optional(v.string()),
  ttlSeconds: v.optional(v.number()),
  priority: v.optional(v.union(v.literal("high"), v.literal("normal"))),
  badge: v.optional(v.number()),
  sound: v.optional(v.string()),
  category: v.optional(v.string()),
  overrides: v.optional(overrides),
  idempotencyKey: v.optional(v.string()),
  failingHook: v.optional(v.boolean()),
};
const sendReturns = v.object({ messageId: v.string(), deliveries: v.number(), deduplicated: v.boolean() });

/** Register a device for a subject (on the main mount, or the partner mount). */
export const registerDevice = mutation({
  args: {
    subjectRef: v.string(),
    appRef: v.string(),
    address: deviceAddress,
    installRef: v.optional(v.string()),
    locale: v.optional(v.string()),
    partner: v.optional(v.boolean()),
  },
  returns: v.object({ deviceId: v.string(), created: v.boolean() }),
  handler: async (ctx, { partner: usePartner, ...args }) => (usePartner ? partner : push).register(ctx, args),
});

/** Remove a device by id or address, optionally only if the subject owns it. */
export const unregisterDevice = mutation({
  args: {
    target: v.union(v.object({ deviceId: v.string() }), v.object({ address: deviceAddress })),
    subjectRef: v.optional(v.string()),
  },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, { target, subjectRef }) => push.unregister(ctx, { ...target, subjectRef }),
});

/** Test-only: calls the component directly, bypassing the client's app checks, to exercise the component's own guards. Never deploy. */
export const registerRaw = mutation({
  args: { subjectRef: v.string(), appRef: v.string(), address: deviceAddress, installRef: v.optional(v.string()), locale: v.optional(v.string()) },
  returns: v.object({ deviceId: v.string(), created: v.boolean() }),
  handler: async (ctx, args) => ctx.runMutation(components.push.mutations.register, args),
});

/** Test-only: calls the component's send directly with explicit settings, to exercise its config checks. Never deploy. */
export const sendRaw = mutation({
  args: {
    subjectRef: v.string(),
    title: v.string(),
    maxAttempts: v.number(),
    maxParallelism: v.number(),
    appRef: v.string(),
    provider: v.string(),
    handle: v.string(),
    onDeliveryHandle: v.optional(v.string()),
  },
  returns: sendReturns,
  handler: async (ctx, args) =>
    ctx.runMutation(components.push.mutations.send, {
      message: { to: { subjectRef: args.subjectRef }, title: args.title },
      config: {
        apps: [{ appRef: args.appRef, app: { platform: "fcm" } }],
        providers: [{ provider: args.provider, handle: args.handle }],
        onDeliveryHandle: args.onDeliveryHandle,
        maxAttempts: args.maxAttempts,
        maxParallelism: args.maxParallelism,
        scrub: true,
      },
    }),
});

/** Test-only: calls the component directly to exercise its own argument checks. Never deploy. */
export const unregisterRaw = mutation({
  args: { deviceId: v.optional(v.string()), address: v.optional(deviceAddress) },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, args) => ctx.runMutation(components.push.mutations.unregister, args),
});

/** Pause or resume one device. */
export const setDeviceStatus = mutation({
  args: { deviceId: v.string(), status: v.union(v.literal("active"), v.literal("disabled")), subjectRef: v.optional(v.string()) },
  returns: v.object({ updated: v.boolean() }),
  handler: async (ctx, args) => push.setDeviceStatus(ctx, args),
});

/** A subject's devices, without addresses. */
export const listDevices = query({
  args: {
    subjectRef: v.string(),
    status: v.optional(v.union(v.literal("active"), v.literal("disabled"), v.literal("invalid"))),
    limit: v.optional(v.number()),
    partner: v.optional(v.boolean()),
  },
  returns: v.array(deviceView),
  handler: async (ctx, { partner: usePartner, ...args }) => (usePartner ? partner : push).listDevices(ctx, args),
});

/** Send one message to a subject or to named devices. */
export const send = mutation({
  args: { ...sendArgs, partner: v.optional(v.boolean()) },
  returns: sendReturns,
  handler: async (ctx, { subjectRef, deviceIds, failingHook, partner: usePartner, ...rest }) => {
    const client = usePartner ? partner : failingHook ? pushWithFailingHook : push;
    const to = deviceIds ? { deviceIds } : { subjectRef: subjectRef ?? "" };
    return client.send(ctx, { to, ...rest });
  },
});

/** Send the same message to several subjects in one transaction. */
export const sendBatch = mutation({
  args: {
    subjectRefs: v.array(v.string()),
    title: v.string(),
    body: v.optional(v.string()),
    ttlSeconds: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.array(sendReturns),
  handler: async (ctx, { subjectRefs, ...message }) =>
    push.sendBatch(
      ctx,
      subjectRefs.map((subjectRef) => ({ to: { subjectRef }, ...message })),
    ),
});

/** One message's delivery status. */
export const status = query({
  args: { messageId: v.string(), partner: v.optional(v.boolean()) },
  returns: v.union(messageStatus, v.null()),
  handler: async (ctx, args) => (args.partner ? partner : push).status(ctx, args.messageId),
});

/** A subject's recent messages, newest first. */
export const listBySubject = query({
  args: { subjectRef: v.string(), limit: v.optional(v.number()) },
  returns: v.array(messageSummary),
  handler: async (ctx, args) => push.listBySubject(ctx, args),
});

/** Cancel a message's queued deliveries. */
export const cancel = mutation({
  args: { messageId: v.string() },
  returns: v.object({ cancelled: v.number() }),
  handler: async (ctx, args) => push.cancel(ctx, args.messageId),
});

/** Run the retention sweep now. */
export const prune = mutation({
  args: { partner: v.optional(v.boolean()), batch: v.optional(v.number()) },
  returns: v.object({ deleted: v.number(), more: v.boolean() }),
  handler: async (ctx, args) => (args.partner ? partner.prune(ctx, { batch: args.batch }) : push.prune(ctx)),
});

/** The delivery events the hook stored. */
export const hookEvents = query({
  args: {},
  returns: v.array(deliveryEvent),
  handler: async (ctx) => {
    const rows = await ctx.db.query("pushEvents").take(100);
    return rows.map(({ _id, _creationTime, ...event }) => event);
  },
});

/** The delivery hook: a host would forward this to telemetry or fall back to email. */
export const onDelivery = internalMutation({
  args: deliveryEvent,
  returns: v.null(),
  handler: async (ctx, event) => {
    await ctx.db.insert("pushEvents", event);
    return null;
  },
});

/** Test-only: a delivery hook that always throws. */
export const failingHook = internalMutation({
  args: deliveryEvent,
  returns: v.null(),
  handler: async () => {
    throw new Error("hook failed");
  },
});

/**
 * A custom provider: POST the notification as JSON to an https webhook address
 * (for example a desktop agent). The component keeps the queue, retries and
 * dead-address cleanup; this action only sends one notification.
 */
export const webhookSender = internalAction({
  args: customSendArgs,
  returns: sendResult,
  handler: async (_ctx, args): Promise<SendResult> => {
    const res = await fetch(args.address, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": args.deliveryId },
      body: JSON.stringify({ title: args.title, body: args.body, data: args.data }),
    });
    if (res.ok) return { status: "sent", providerMessageId: res.headers.get("x-message-id") ?? undefined, httpStatus: res.status };
    if (res.status === 404 || res.status === 410) return { status: "invalid", code: "GONE", httpStatus: res.status };
    if (res.status === 429 || res.status >= 500) return { status: "retry", code: String(res.status), httpStatus: res.status };
    return { status: "failed", code: String(res.status), httpStatus: res.status };
  },
});
