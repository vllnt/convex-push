import { type Infer, v } from "convex/values";

/** Platform of a device address. */
export const platform = v.union(
  v.literal("apns"),
  v.literal("fcm"),
  v.literal("webpush"),
  v.literal("custom"),
);

/**
 * Where one app install receives pushes. `apns` and `fcm` carry the native
 * token; `webpush` carries the browser subscription; `custom` carries one opaque
 * address string for a host-supplied provider.
 */
export const deviceAddress = v.union(
  v.object({ platform: v.literal("apns"), token: v.string() }),
  v.object({ platform: v.literal("fcm"), token: v.string() }),
  v.object({
    platform: v.literal("webpush"),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
  }),
  v.object({ platform: v.literal("custom"), provider: v.string(), address: v.string() }),
);
/** A device address. */
export type DeviceAddress = Infer<typeof deviceAddress>;

/** Device lifecycle status. */
export const deviceStatus = v.union(v.literal("active"), v.literal("disabled"), v.literal("invalid"));
/** Delivery status; `queued` is the only non-final one. */
export const deliveryStatus = v.union(
  v.literal("queued"),
  v.literal("sent"),
  v.literal("failed"),
  v.literal("invalid"),
);
/** Statuses a delivery ends in. */
export const finalDeliveryStatus = v.union(v.literal("sent"), v.literal("failed"), v.literal("invalid"));

/** Which Apple host: production or sandbox. */
export const apnsEnvironment = v.union(v.literal("production"), v.literal("sandbox"));

/**
 * What one `appRef` means: which platform, and for APNs which bundle id and
 * which Apple host. For a custom platform, which provider sends.
 */
export const appConfig = v.union(
  v.object({ platform: v.literal("apns"), topic: v.string(), environment: apnsEnvironment }),
  v.object({ platform: v.literal("fcm") }),
  v.object({ platform: v.literal("webpush") }),
  v.object({ platform: v.literal("custom"), provider: v.string() }),
);
/** One app's configuration. */
export type AppConfig = Infer<typeof appConfig>;

/** A flat data value. */
export const dataValue = v.union(v.string(), v.number(), v.boolean());
/** Flat key/value data delivered beside the notification. */
export const data = v.record(v.string(), dataValue);
/** Flat data. */
export type PushData = Infer<typeof data>;

/** Delivery priority, mapped to each provider's own field. */
export const priority = v.union(v.literal("high"), v.literal("normal"));

/** Neutral options every provider maps to its own fields. */
export const messageOptions = v.object({
  collapseKey: v.optional(v.string()),
  ttlSeconds: v.optional(v.number()),
  priority: priority,
  badge: v.optional(v.number()),
  sound: v.optional(v.string()),
  category: v.optional(v.string()),
});
/** Stored message options. */
export type MessageOptions = Infer<typeof messageOptions>;

/**
 * Provider-only settings. Each slot has a few typed fields plus `rawJson`: a
 * JSON object string merged into the built payload last.
 */
export const overrides = v.object({
  apns: v.optional(
    v.object({
      threadId: v.optional(v.string()),
      interruptionLevel: v.optional(
        v.union(
          v.literal("passive"),
          v.literal("active"),
          v.literal("time-sensitive"),
          v.literal("critical"),
        ),
      ),
      mutableContent: v.optional(v.boolean()),
      rawJson: v.optional(v.string()),
    }),
  ),
  fcm: v.optional(
    v.object({
      channelId: v.optional(v.string()),
      rawJson: v.optional(v.string()),
    }),
  ),
  webpush: v.optional(
    v.object({
      icon: v.optional(v.string()),
      url: v.optional(v.string()),
      rawJson: v.optional(v.string()),
    }),
  ),
});
/** Provider overrides. */
export type Overrides = Infer<typeof overrides>;

/** Recipient: every active device of one subject, or named devices. */
export const recipient = v.union(
  v.object({ subjectRef: v.string() }),
  v.object({ deviceIds: v.array(v.string()) }),
);

/** One message as the client passes it to `send`. */
export const sendInput = v.object({
  to: recipient,
  title: v.optional(v.string()),
  body: v.optional(v.string()),
  data: v.optional(data),
  collapseKey: v.optional(v.string()),
  ttlSeconds: v.optional(v.number()),
  priority: v.optional(priority),
  badge: v.optional(v.number()),
  sound: v.optional(v.string()),
  category: v.optional(v.string()),
  overrides: v.optional(overrides),
  idempotencyKey: v.optional(v.string()),
});
/** One message to send. */
export type SendInput = Infer<typeof sendInput>;

/** Mount-wide settings the client passes with every send. */
export const sendConfig = v.object({
  apps: v.array(v.object({ appRef: v.string(), app: appConfig })),
  providers: v.array(v.object({ provider: v.string(), handle: v.string() })),
  onDeliveryHandle: v.optional(v.string()),
  maxAttempts: v.number(),
  maxParallelism: v.number(),
  scrub: v.boolean(),
});
/** Send settings. */
export type SendConfig = Infer<typeof sendConfig>;

/** What `send` returns for one message. */
export const sendResultView = v.object({
  messageId: v.string(),
  deliveries: v.number(),
  deduplicated: v.boolean(),
});

/**
 * What a sender returns for one delivery. A custom provider's action must
 * return one of these; a throw or timeout counts as `retry`.
 */
export const sendResult = v.union(
  v.object({
    status: v.literal("sent"),
    providerMessageId: v.optional(v.string()),
    httpStatus: v.optional(v.number()),
  }),
  v.object({
    status: v.literal("retry"),
    code: v.optional(v.string()),
    delayMs: v.optional(v.number()),
    httpStatus: v.optional(v.number()),
  }),
  v.object({
    status: v.literal("invalid"),
    code: v.optional(v.string()),
    httpStatus: v.optional(v.number()),
    invalidSince: v.optional(v.number()),
  }),
  v.object({
    status: v.literal("failed"),
    code: v.optional(v.string()),
    httpStatus: v.optional(v.number()),
  }),
);
/** One sender result. */
export type SendResult = Infer<typeof sendResult>;

/** What the internal send action returns: a sender result, or `skip` when the delivery is no longer queued. */
export const deliverOutcome = v.union(sendResult, v.object({ status: v.literal("skip") }));
/** Send action outcome. */
export type DeliverOutcome = Infer<typeof deliverOutcome>;

/** Arguments a custom provider's action receives: one notification to one address. */
export const customSendArgs = v.object({
  provider: v.string(),
  address: v.string(),
  title: v.optional(v.string()),
  body: v.optional(v.string()),
  data: data,
  options: messageOptions,
  attempt: v.number(),
  messageId: v.string(),
  deliveryId: v.string(),
});
/** Custom sender arguments. */
export type CustomSendArgs = Infer<typeof customSendArgs>;

/** The event the `onDelivery` hook receives once per finished delivery. Carries no content. */
export const deliveryEvent = v.object({
  messageId: v.string(),
  deliveryId: v.string(),
  deviceId: v.string(),
  platform: platform,
  provider: v.optional(v.string()),
  status: finalDeliveryStatus,
  errorCode: v.optional(v.string()),
  at: v.number(),
});
/** Delivery hook event. */
export type DeliveryEvent = Infer<typeof deliveryEvent>;

/** A device as queries return it. The address is never returned. */
export const deviceView = v.object({
  deviceId: v.string(),
  subjectRef: v.string(),
  appRef: v.string(),
  platform: platform,
  provider: v.optional(v.string()),
  status: deviceStatus,
  invalidCode: v.optional(v.string()),
  installRef: v.optional(v.string()),
  locale: v.optional(v.string()),
  lastSeenAt: v.number(),
});
/** Device view. */
export type DeviceView = Infer<typeof deviceView>;

/** A delivery as queries return it. */
export const deliveryView = v.object({
  deliveryId: v.string(),
  deviceId: v.string(),
  platform: platform,
  provider: v.optional(v.string()),
  status: deliveryStatus,
  attempts: v.number(),
  providerMessageId: v.optional(v.string()),
  errorCode: v.optional(v.string()),
  httpStatus: v.optional(v.number()),
  nextAttemptAt: v.optional(v.number()),
  sentAt: v.optional(v.number()),
  updatedAt: v.number(),
});
/** Delivery view. */
export type DeliveryView = Infer<typeof deliveryView>;

/** A message and its deliveries. Title, body and data are never returned. */
export const messageStatus = v.object({
  messageId: v.string(),
  createdAt: v.number(),
  expiresAt: v.number(),
  scrubbedAt: v.optional(v.number()),
  deliveries: v.array(deliveryView),
});
/** Message status. */
export type MessageStatus = Infer<typeof messageStatus>;

/** A message summary for subject listings. */
export const messageSummary = v.object({
  messageId: v.string(),
  createdAt: v.number(),
  expiresAt: v.number(),
  scrubbedAt: v.optional(v.number()),
  queued: v.number(),
  sent: v.number(),
  failed: v.number(),
  invalid: v.number(),
});
/** Message summary. */
export type MessageSummary = Infer<typeof messageSummary>;

/** APNs target for one delivery, copied from the app config at fan-out. */
export const apnsTarget = v.object({ topic: v.string(), environment: apnsEnvironment });
