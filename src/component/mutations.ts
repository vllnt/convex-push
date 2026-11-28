import { v } from "convex/values";
import {
  DEFAULT_PRUNE_BATCH,
  DEFAULT_RETENTION_MS,
  MAX_BATCH_DELIVERIES,
  MAX_BATCH_MESSAGES,
  MAX_DEVICES_PER_MESSAGE,
  MAX_PRUNE_BATCH,
  PRUNE_DEVICES_PER_PASS,
  PRUNE_GRACE_MS,
  PRUNE_MESSAGES_PER_PASS,
} from "../shared.js";
import { api } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { mutation } from "./_generated/server.js";
import { enqueueMessage, finishDelivery, forgetDevice, logger, scrubIfDone } from "./queue.js";
import { addressHash, checkAddress, checkRef, fail } from "./registry.js";
import { deviceAddress, sendConfig, sendInput, sendResultView } from "./validators.js";

/**
 * Register or refresh a device. A known address is updated in place; an address
 * that moves to another subject is reassigned to it; a rotated token with a
 * known `installRef` (same app) replaces its row. An invalid device
 * becomes active again. `lastSeenAt` is refreshed on every call, so Apple's 410
 * timestamp can tell a later registration apart.
 * A disabled device stays disabled unless it moves to another subject.
 */
export const register = mutation({
  args: {
    subjectRef: v.string(),
    appRef: v.string(),
    address: deviceAddress,
    installRef: v.optional(v.string()),
    locale: v.optional(v.string()),
  },
  returns: v.object({ deviceId: v.string(), created: v.boolean() }),
  handler: async (ctx, args) => {
    checkRef("subjectRef", args.subjectRef);
    checkRef("appRef", args.appRef);
    if (args.installRef !== undefined) checkRef("installRef", args.installRef);
    if (args.locale !== undefined && args.locale.length > 64) fail("INVALID_ARGUMENT", "locale must be at most 64 characters");
    checkAddress(args.address);
    const hash = await addressHash(args.address);
    const now = Date.now();
    const byAddress = await ctx.db
      .query("devices")
      .withIndex("by_address_hash", (q) => q.eq("addressHash", hash))
      .first();
    const byInstall =
      byAddress || args.installRef === undefined
        ? null
        : await ctx.db
            .query("devices")
            .withIndex("by_install", (q) => q.eq("installRef", args.installRef).eq("appRef", args.appRef))
            .first();
    const existing = byAddress ?? byInstall;
    if (!existing) {
      const deviceId = await ctx.db.insert("devices", {
        subjectRef: args.subjectRef,
        appRef: args.appRef,
        address: args.address,
        addressHash: hash,
        installRef: args.installRef,
        locale: args.locale,
        status: "active",
        lastSeenAt: now,
      });
      logger.info("device.registered", { deviceId });
      return { deviceId, created: true };
    }
    const reassigned = existing.subjectRef !== args.subjectRef;
    const status: Doc<"devices">["status"] = existing.status === "disabled" && !reassigned ? "disabled" : "active";
    await ctx.db.patch("devices", existing._id, {
      subjectRef: args.subjectRef,
      appRef: args.appRef,
      address: args.address,
      addressHash: hash,
      installRef: args.installRef ?? existing.installRef,
      locale: args.locale ?? existing.locale,
      status,
      invalidCode: undefined,
      lastSeenAt: now,
    });
    return { deviceId: existing._id, created: false };
  },
});

/**
 * Remove a device, for example on logout. Pass the device id or its address.
 * When `subjectRef` is given, only a device owned by that subject is removed.
 */
export const unregister = mutation({
  args: {
    deviceId: v.optional(v.string()),
    address: v.optional(deviceAddress),
    subjectRef: v.optional(v.string()),
  },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, args) => {
    if ((args.deviceId === undefined) === (args.address === undefined)) {
      fail("INVALID_ARGUMENT", "pass exactly one of deviceId or address");
    }
    const id = args.deviceId === undefined ? null : ctx.db.normalizeId("devices", args.deviceId);
    const hash = args.address === undefined ? null : await addressHash(args.address);
    const device = id
      ? await ctx.db.get("devices", id)
      : hash === null
        ? null
        : await ctx.db
            .query("devices")
            .withIndex("by_address_hash", (q) => q.eq("addressHash", hash))
            .first();
    const owned = device !== null && (args.subjectRef === undefined || device.subjectRef === args.subjectRef);
    if (owned) {
      await ctx.db.delete("devices", device._id);
      await forgetDevice(ctx, device._id);
    }
    return { removed: owned };
  },
});

/** Pause (`disabled`) or resume (`active`) one device. */
export const setDeviceStatus = mutation({
  args: {
    deviceId: v.string(),
    status: v.union(v.literal("active"), v.literal("disabled")),
    subjectRef: v.optional(v.string()),
  },
  returns: v.object({ updated: v.boolean() }),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("devices", args.deviceId);
    const device = id ? await ctx.db.get("devices", id) : null;
    if (!device || (args.subjectRef !== undefined && device.subjectRef !== args.subjectRef)) return { updated: false };
    await ctx.db.patch("devices", device._id, { status: args.status, invalidCode: undefined });
    return { updated: true };
  },
});

/** Enqueue one message and fan it out to the recipient's active devices. */
export const send = mutation({
  args: { message: sendInput, config: sendConfig },
  returns: sendResultView,
  handler: async (ctx, { message, config }) => enqueueMessage(ctx, message, config),
});

/**
 * Enqueue up to 100 messages and 100 deliveries in one transaction. If one
 * is refused, or the batch fans out to more deliveries, none is queued.
 */
export const sendBatch = mutation({
  args: { messages: v.array(sendInput), config: sendConfig },
  returns: v.array(sendResultView),
  handler: async (ctx, { messages, config }) => {
    if (messages.length > MAX_BATCH_MESSAGES) fail("INVALID_ARGUMENT", `sendBatch accepts at most ${String(MAX_BATCH_MESSAGES)} messages`);
    const results = [];
    let deliveries = 0;
    for (const message of messages) {
      const result = await enqueueMessage(ctx, message, config);
      deliveries += result.deduplicated ? 0 : result.deliveries;
      if (deliveries > MAX_BATCH_DELIVERIES) {
        fail("INVALID_ARGUMENT", `sendBatch fans out to more than ${String(MAX_BATCH_DELIVERIES)} deliveries; split it`);
      }
      results.push(result);
    }
    return results;
  },
});

/** Cancel a message: every queued delivery ends as failed with `CANCELLED`. */
export const cancel = mutation({
  args: { messageId: v.string() },
  returns: v.object({ cancelled: v.number() }),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("messages", args.messageId);
    const message = id ? await ctx.db.get("messages", id) : null;
    if (!message) return { cancelled: 0 };
    const queued = await ctx.db
      .query("deliveries")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .take(MAX_DEVICES_PER_MESSAGE);
    const now = Date.now();
    let cancelled = 0;
    for (const delivery of queued.filter((d) => d.status === "queued")) {
      const patch = { status: "failed", errorCode: "CANCELLED", nextAttemptAt: undefined, updatedAt: now } as const;
      await ctx.db.patch("deliveries", delivery._id, patch);
      await finishDelivery(ctx, { ...delivery, ...patch }, message);
      cancelled += 1;
    }
    await scrubIfDone(ctx, message._id);
    return { cancelled };
  },
});

/**
 * Delete messages older than the retention window (and expired more than a day
 * ago, so no send job is still on its way) with their deliveries, devices
 * invalid and unseen for that long, and expired cached tokens. One pass deletes
 * about `batch` rows (default and maximum 1,000; at most 100 devices) and
 * reschedules itself while there is more. Idempotent.
 */
export const prune = mutation({
  args: { retentionMs: v.optional(v.number()), batch: v.optional(v.number()) },
  returns: v.object({ deleted: v.number(), more: v.boolean() }),
  handler: async (ctx, args) => {
    const retentionMs = args.retentionMs ?? DEFAULT_RETENTION_MS;
    const batch = args.batch ?? DEFAULT_PRUNE_BATCH;
    if (!Number.isInteger(batch) || batch < 1 || batch > MAX_PRUNE_BATCH) {
      fail("INVALID_ARGUMENT", `batch must be an integer from 1 to ${String(MAX_PRUNE_BATCH)}`);
    }
    if (!Number.isFinite(retentionMs) || retentionMs < 0) fail("INVALID_ARGUMENT", "retentionMs must be a non-negative number");
    const now = Date.now();
    const cutoff = now - retentionMs;
    const pageSize = Math.min(batch, PRUNE_MESSAGES_PER_PASS);
    const old = await ctx.db
      .query("messages")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .take(pageSize);
    const doomed = old.filter((m) => m.expiresAt + PRUNE_GRACE_MS < now);
    const pages = await Promise.all(
      doomed.map(async (message) => ({
        message,
        deliveries: await ctx.db
          .query("deliveries")
          .withIndex("by_message", (q) => q.eq("messageId", message._id))
          .take(MAX_DEVICES_PER_MESSAGE + 1),
      })),
    );
    let deleted = 0;
    let stopped = false;
    const deletions: Promise<void>[] = [];
    for (const { message, deliveries } of pages) {
      if (deleted > 0 && deleted + deliveries.length + 1 > batch) {
        stopped = true;
        break;
      }
      deletions.push(...deliveries.map((d) => ctx.db.delete("deliveries", d._id)), ctx.db.delete("messages", message._id));
      deleted += deliveries.length + 1;
    }
    await Promise.all(deletions);
    const room = Math.max(batch - deleted, 0);
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_status_seen", (q) => q.eq("status", "invalid").lt("lastSeenAt", cutoff))
      .take(Math.min(room, PRUNE_DEVICES_PER_PASS));
    for (const device of devices) {
      await ctx.db.delete("devices", device._id);
      await forgetDevice(ctx, device._id);
    }
    const tokens = await ctx.db.query("providerTokens").take(PRUNE_MESSAGES_PER_PASS);
    const expiredTokens = tokens.filter((t) => t.expiresAt < now);
    await Promise.all(expiredTokens.map((t) => ctx.db.delete("providerTokens", t._id)));
    deleted += devices.length + expiredTokens.length;
    const more = stopped || devices.length === Math.min(room, PRUNE_DEVICES_PER_PASS) || (old.length === pageSize && doomed.length > 0);
    if (more) await ctx.scheduler.runAfter(0, api.mutations.prune, { retentionMs, batch });
    return { deleted, more };
  },
});
