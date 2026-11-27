import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  apnsTarget,
  data,
  deliveryStatus,
  deviceAddress,
  deviceStatus,
  messageOptions,
  overrides,
  platform,
} from "./validators.js";

/** The component's four tables. */
export default defineSchema({
  /** One row per app install: the device registry. */
  devices: defineTable({
    subjectRef: v.string(),
    appRef: v.string(),
    address: deviceAddress,
    addressHash: v.string(),
    installRef: v.optional(v.string()),
    locale: v.optional(v.string()),
    status: deviceStatus,
    invalidCode: v.optional(v.string()),
    lastSeenAt: v.number(),
  })
    .index("by_address_hash", ["addressHash"])
    .index("by_subject_status", ["subjectRef", "status"])
    .index("by_install", ["installRef", "appRef"])
    .index("by_status_seen", ["status", "lastSeenAt"]),

  /** One logical notification to one subject or to named devices. */
  messages: defineTable({
    to: v.union(v.object({ subjectRef: v.string() }), v.object({ deviceIds: v.array(v.id("devices")) })),
    title: v.optional(v.string()),
    body: v.optional(v.string()),
    data: data,
    options: messageOptions,
    overrides: v.optional(overrides),
    onDeliveryHandle: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    expiresAt: v.number(),
    scrubbedAt: v.optional(v.number()),
    maxAttempts: v.number(),
    scrub: v.boolean(),
  })
    .index("by_idempotency_key", ["idempotencyKey"])
    .index("by_subject_created", ["to.subjectRef"]),

  /** One row per device per message. What the status query reads. */
  deliveries: defineTable({
    messageId: v.id("messages"),
    deviceId: v.id("devices"),
    /** The device's subject when the message was sent; a device that moved since is not sent to. */
    subjectRef: v.string(),
    platform: platform,
    provider: v.optional(v.string()),
    senderHandle: v.optional(v.string()),
    apns: v.optional(apnsTarget),
    status: deliveryStatus,
    attempts: v.number(),
    providerMessageId: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    httpStatus: v.optional(v.number()),
    nextAttemptAt: v.optional(v.number()),
    sentAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_message", ["messageId"]),

  /** Shared cache of short-lived provider tokens. Ciphertext only. */
  providerTokens: defineTable({
    credentialRef: v.string(),
    audience: v.optional(v.string()),
    cipher: v.bytes(),
    iv: v.bytes(),
    mintedAt: v.number(),
    refreshAfter: v.number(),
    expiresAt: v.number(),
  }).index("by_credential_audience", ["credentialRef", "audience"]),
});
