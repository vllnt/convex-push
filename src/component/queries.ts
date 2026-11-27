import { v } from "convex/values";
import { MAX_DEVICES_PER_MESSAGE, MAX_LIST_LIMIT } from "../shared.js";
import type { Doc } from "./_generated/dataModel.js";
import { internalQuery, query } from "./_generated/server.js";
import { checkRef, fail, toDeviceView } from "./registry.js";
import {
  apnsTarget,
  data,
  deviceAddress,
  deviceStatus,
  deviceView,
  type DeliveryView,
  messageOptions,
  messageStatus,
  messageSummary,
  overrides,
  platform,
} from "./validators.js";

function checkLimit(limit: number | undefined): number {
  const value = limit ?? 20;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    fail("INVALID_ARGUMENT", `limit must be an integer from 1 to ${String(MAX_LIST_LIMIT)}`);
  }
  return value;
}

function toDeliveryView(d: Doc<"deliveries">): DeliveryView {
  return {
    deliveryId: d._id,
    deviceId: d.deviceId,
    platform: d.platform,
    provider: d.provider,
    status: d.status,
    attempts: d.attempts,
    providerMessageId: d.providerMessageId,
    errorCode: d.errorCode,
    httpStatus: d.httpStatus,
    nextAttemptAt: d.nextAttemptAt,
    sentAt: d.sentAt,
    updatedAt: d.updatedAt,
  };
}

/** A message and the state of each delivery. Never returns title, body, data or device addresses. */
export const status = query({
  args: { messageId: v.string() },
  returns: v.union(messageStatus, v.null()),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("messages", args.messageId);
    const message = id ? await ctx.db.get("messages", id) : null;
    if (!message) return null;
    const deliveries = await ctx.db
      .query("deliveries")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .take(MAX_DEVICES_PER_MESSAGE);
    return {
      messageId: message._id,
      createdAt: message._creationTime,
      expiresAt: message.expiresAt,
      scrubbedAt: message.scrubbedAt,
      deliveries: deliveries.map(toDeliveryView),
    };
  },
});

/** A subject's devices, optionally filtered by status. Addresses are never returned. */
export const listDevices = query({
  args: { subjectRef: v.string(), status: v.optional(deviceStatus), limit: v.optional(v.number()) },
  returns: v.array(deviceView),
  handler: async (ctx, args) => {
    checkRef("subjectRef", args.subjectRef);
    const limit = checkLimit(args.limit);
    const rows = await ctx.db
      .query("devices")
      .withIndex("by_subject_status", (q) =>
        args.status === undefined ? q.eq("subjectRef", args.subjectRef) : q.eq("subjectRef", args.subjectRef).eq("status", args.status),
      )
      .take(limit);
    return rows.map(toDeviceView);
  },
});

/** A subject's recent messages, newest first, with delivery counts. */
export const listBySubject = query({
  args: { subjectRef: v.string(), limit: v.optional(v.number()) },
  returns: v.array(messageSummary),
  handler: async (ctx, args) => {
    checkRef("subjectRef", args.subjectRef);
    const limit = checkLimit(args.limit);
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_subject_created", (q) => q.eq("to.subjectRef", args.subjectRef))
      .order("desc")
      .take(limit);
    return Promise.all(
      messages.map(async (m) => {
        const deliveries = await ctx.db
          .query("deliveries")
          .withIndex("by_message", (q) => q.eq("messageId", m._id))
          .take(MAX_DEVICES_PER_MESSAGE);
        const count = (s: Doc<"deliveries">["status"]): number => deliveries.filter((d) => d.status === s).length;
        return {
          messageId: m._id,
          createdAt: m._creationTime,
          expiresAt: m.expiresAt,
          scrubbedAt: m.scrubbedAt,
          queued: count("queued"),
          sent: count("sent"),
          failed: count("failed"),
          invalid: count("invalid"),
        };
      }),
    );
  },
});

/**
 * Everything the send action needs for one queued delivery. Internal: the host
 * cannot call it, and it is the only function that reads content and addresses.
 */
export const loadJob = internalQuery({
  args: { deliveryId: v.id("deliveries") },
  returns: v.union(
    v.null(),
    v.object({
      deliveryId: v.string(),
      messageId: v.string(),
      platform: platform,
      provider: v.optional(v.string()),
      senderHandle: v.optional(v.string()),
      apns: v.optional(apnsTarget),
      attempts: v.number(),
      expiresAt: v.number(),
      title: v.optional(v.string()),
      body: v.optional(v.string()),
      data: data,
      options: messageOptions,
      overrides: v.optional(overrides),
      device: v.union(v.null(), v.object({ status: deviceStatus, address: deviceAddress, reassigned: v.boolean() })),
    }),
  ),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get("deliveries", args.deliveryId);
    if (delivery?.status !== "queued") return null;
    const message = await ctx.db.get("messages", delivery.messageId);
    if (!message) return null;
    const device = await ctx.db.get("devices", delivery.deviceId);
    return {
      deliveryId: delivery._id,
      messageId: message._id,
      platform: delivery.platform,
      provider: delivery.provider,
      senderHandle: delivery.senderHandle,
      apns: delivery.apns,
      attempts: delivery.attempts,
      expiresAt: message.expiresAt,
      title: message.title,
      body: message.body,
      data: message.data,
      options: message.options,
      overrides: message.overrides,
      device: device ? { status: device.status, address: device.address, reassigned: device.subjectRef !== delivery.subjectRef } : null,
    };
  },
});

/** A cached provider token row (ciphertext). Internal. */
export const loadToken = internalQuery({
  args: { credentialRef: v.string(), audience: v.optional(v.string()) },
  returns: v.union(
    v.null(),
    v.object({ cipher: v.bytes(), iv: v.bytes(), refreshAfter: v.number(), expiresAt: v.number() }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("providerTokens")
      .withIndex("by_credential_audience", (q) => q.eq("credentialRef", args.credentialRef).eq("audience", args.audience))
      .first();
    return row ? { cipher: row.cipher, iv: row.iv, refreshAfter: row.refreshAfter, expiresAt: row.expiresAt } : null;
  },
});
