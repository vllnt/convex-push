import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { Workpool } from "@convex-dev/workpool";
import { createConvexLogger } from "@vllnt/logger/convex";
import type { FunctionHandle } from "convex/server";
import {
  BAD_TOKEN_BURST_LIMIT,
  DEFAULT_TTL_SECONDS,
  DEVICE_SENDS_PER_MINUTE,
  MAX_DEVICES_PER_MESSAGE,
  type Platform,
  ZERO_TTL_WINDOW_MS,
} from "../shared.js";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { env, type MutationCtx } from "./_generated/server.js";
import { checkSendConfig, checkSendInput, isHandleString } from "./checks.js";
import { backoffDelay } from "./providers/http.js";
import { isConfigured } from "./providers/keys.js";
import { findOversize, isSilent } from "./providers/payload.js";
import { fail } from "./registry.js";
import type { AppConfig, DeliverOutcome, DeliveryEvent, SendConfig, SendInput } from "./validators.js";

/** Component logger. Only ids, platforms and codes are ever logged. */
export const logger: ReturnType<typeof createConvexLogger> = createConvexLogger("push");

const limiter = new RateLimiter(components.rateLimiter, {
  device: { kind: "token bucket", rate: DEVICE_SENDS_PER_MINUTE, period: MINUTE, capacity: DEVICE_SENDS_PER_MINUTE },
  badDeviceToken: { kind: "fixed window", rate: BAD_TOKEN_BURST_LIMIT, period: 10 * MINUTE },
});

const POOLS = {
  apns: components.apnsPool,
  fcm: components.fcmPool,
  webpush: components.webpushPool,
  custom: components.customPool,
} as const;

/**
 * Narrow a stored handle string to a function handle. Handles are created by
 * the client with `createFunctionHandle`; the component treats them as opaque.
 * @param handle - The stored string.
 * @returns Whether it has the function-handle form.
 */
export function isMutationHandle(handle: string): handle is FunctionHandle<"mutation", DeliveryEvent, null> {
  return isHandleString(handle);
}

async function enqueueJob(
  ctx: MutationCtx,
  delivery: Pick<Doc<"deliveries">, "_id" | "platform">,
  maxParallelism: number,
  runAt: number,
): Promise<void> {
  const pool = new Workpool(POOLS[delivery.platform], { maxParallelism, retryActionsByDefault: false });
  await pool.enqueueAction(
    ctx,
    internal.actions.deliver,
    { deliveryId: delivery._id },
    { onComplete: internal.internal_mutations.onSendComplete, context: { deliveryId: delivery._id }, runAt },
  );
}

/**
 * Erase title, body, data and overrides once no delivery is queued, when scrubbing is on.
 * @param ctx - Mutation context.
 * @param messageId - The message.
 */
export async function scrubIfDone(ctx: MutationCtx, messageId: Id<"messages">): Promise<void> {
  const message = await ctx.db.get("messages", messageId);
  if (!message?.scrub || message.scrubbedAt !== undefined) return;
  const pending = await ctx.db
    .query("deliveries")
    .withIndex("by_message", (q) => q.eq("messageId", message._id))
    .take(MAX_DEVICES_PER_MESSAGE + 1);
  if (pending.some((d) => d.status === "queued")) return;
  await ctx.db.patch("messages", message._id, {
    title: undefined,
    body: undefined,
    data: {},
    overrides: undefined,
    scrubbedAt: Date.now(),
  });
}

/** The delivery fields the hook event and the log need. */
export type FinishedDelivery = Pick<Doc<"deliveries">, "_id" | "deviceId" | "platform" | "provider" | "status" | "errorCode" | "updatedAt">;

/** The message fields `finishDelivery` needs. */
export type MessageRef = Pick<Doc<"messages">, "_id" | "onDeliveryHandle">;

/**
 * A delivery reached sent, failed or invalid: schedule the host hook (never
 * inline, so a hook that throws cannot undo the record) and scrub when done.
 * @param ctx - Mutation context.
 * @param delivery - The delivery after its final patch.
 * @param message - Its message.
 */
export async function finishDelivery(ctx: MutationCtx, delivery: FinishedDelivery, message: MessageRef): Promise<void> {
  logger.info("delivery.finished", {
    deliveryId: delivery._id,
    platform: delivery.platform,
    status: delivery.status,
    errorCode: delivery.errorCode,
  });
  const handle = message.onDeliveryHandle;
  if (handle !== undefined && isMutationHandle(handle) && delivery.status !== "queued") {
    const event: DeliveryEvent = {
      messageId: message._id,
      deliveryId: delivery._id,
      deviceId: delivery.deviceId,
      platform: delivery.platform,
      provider: delivery.provider,
      status: delivery.status,
      errorCode: delivery.errorCode,
      at: delivery.updatedAt,
    };
    try {
      await ctx.scheduler.runAfter(0, handle, event);
    } catch {
      logger.warn("hook.schedule_failed", { deliveryId: delivery._id });
    }
  }
  await scrubIfDone(ctx, message._id);
}

async function setDelivery(
  ctx: MutationCtx,
  delivery: Doc<"deliveries">,
  patch: Partial<Doc<"deliveries">>,
): Promise<Doc<"deliveries">> {
  await ctx.db.patch("deliveries", delivery._id, patch);
  return { ...delivery, ...patch };
}

async function resolveDevices(ctx: MutationCtx, to: SendInput["to"]): Promise<{
  devices: Doc<"devices">[];
  to: Doc<"messages">["to"];
}> {
  if ("subjectRef" in to) {
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_subject_status", (q) => q.eq("subjectRef", to.subjectRef).eq("status", "active"))
      .take(MAX_DEVICES_PER_MESSAGE);
    return { devices, to: { subjectRef: to.subjectRef } };
  }
  const ids = [...new Set(to.deviceIds)]
    .map((id) => ctx.db.normalizeId("devices", id))
    .filter((id) => id !== null);
  const rows = await Promise.all(ids.map((id) => ctx.db.get("devices", id)));
  return { devices: rows.filter((d) => d?.status === "active").filter((d) => d !== null), to: { deviceIds: ids } };
}

function appMatches(app: AppConfig | undefined, address: Doc<"devices">["address"]): app is AppConfig {
  if (app?.platform !== address.platform) return false;
  return app.platform !== "custom" || (address.platform === "custom" && app.provider === address.provider);
}

interface Plan {
  status: "failed" | "queued";
  errorCode?: string;
  provider?: string;
  senderHandle?: string;
  apns?: { topic: string; environment: "production" | "sandbox" };
}

async function planDelivery(
  ctx: MutationCtx,
  device: Doc<"devices">,
  silent: boolean,
  apps: ReadonlyMap<string, AppConfig>,
  providers: ReadonlyMap<string, string>,
): Promise<Plan> {
  const app = apps.get(device.appRef);
  if (!appMatches(app, device.address)) return { status: "failed", errorCode: "APP_NOT_CONFIGURED" };
  if (app.platform === "custom") {
    const senderHandle = providers.get(app.provider);
    if (!senderHandle) return { status: "failed", errorCode: "PROVIDER_NOT_CONFIGURED", provider: app.provider };
    return { status: "queued", provider: app.provider, senderHandle };
  }
  if (!isConfigured(env, app.platform)) return { status: "failed", errorCode: "PROVIDER_NOT_CONFIGURED" };
  if (app.platform === "webpush" && silent) return { status: "failed", errorCode: "SILENT_NOT_SUPPORTED" };
  if (app.platform === "apns") {
    const target = { topic: app.topic, environment: app.environment };
    const breaker = await limiter.check(ctx, "badDeviceToken", { key: device.appRef });
    return breaker.ok ? { status: "queued", apns: target } : { status: "failed", errorCode: "APP_PAUSED", apns: target };
  }
  return { status: "queued" };
}

/**
 * Enqueue one message: validate, dedupe on the idempotency key, fan out to the
 * recipient's active devices, check each provider's payload size after
 * `rawJson` is merged, write one delivery per device and queue one job per
 * delivery in its provider's pool. Any error rolls the whole send back.
 * @param ctx - Mutation context.
 * @param input - The message.
 * @param config - Send settings from the client.
 * @returns The message id, how many deliveries it has, and whether it was a duplicate.
 */
export async function enqueueMessage(
  ctx: MutationCtx,
  input: SendInput,
  config: SendConfig,
): Promise<{ messageId: Id<"messages">; deliveries: number; deduplicated: boolean }> {
  checkSendInput(input);
  checkSendConfig(config);
  if (input.idempotencyKey !== undefined) {
    const existing = await ctx.db
      .query("messages")
      .withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", input.idempotencyKey))
      .first();
    if (existing) {
      const deliveries = await ctx.db
        .query("deliveries")
        .withIndex("by_message", (q) => q.eq("messageId", existing._id))
        .take(MAX_DEVICES_PER_MESSAGE);
      return { messageId: existing._id, deliveries: deliveries.length, deduplicated: true };
    }
  }
  const silent = isSilent(input);
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const options = {
    collapseKey: input.collapseKey,
    ttlSeconds,
    priority: input.priority ?? (silent ? "normal" : "high"),
    badge: input.badge,
    sound: input.sound,
    category: input.category,
  } as const;
  const content = { title: input.title, body: input.body, data: input.data ?? {}, options, overrides: input.overrides };
  const { devices, to } = await resolveDevices(ctx, input.to);
  const oversize = findOversize(content, new Set<Platform>(devices.map((d) => d.address.platform)));
  if (oversize) {
    fail("PAYLOAD_TOO_LARGE", `${oversize.platform} payload is ${String(oversize.bytes)} bytes, over its ${String(oversize.limit)}-byte limit`);
  }
  const now = Date.now();
  const messageId = await ctx.db.insert("messages", {
    to,
    ...content,
    onDeliveryHandle: config.onDeliveryHandle,
    idempotencyKey: input.idempotencyKey,
    expiresAt: now + (ttlSeconds === 0 ? ZERO_TTL_WINDOW_MS : ttlSeconds * 1000),
    maxAttempts: config.maxAttempts,
    maxParallelism: config.maxParallelism,
    scrub: config.scrub,
  });
  const apps = new Map(config.apps.map((a) => [a.appRef, a.app]));
  const providers = new Map(config.providers.map((p) => [p.provider, p.handle]));
  const message = { _id: messageId, onDeliveryHandle: config.onDeliveryHandle };
  const finished: FinishedDelivery[] = [];
  await Promise.all(
    devices.map(async (device) => {
      const plan = await planDelivery(ctx, device, silent, apps, providers);
      const fuse = plan.status === "queued" ? await limiter.limit(ctx, "device", { key: device._id, reserve: true }) : null;
      const retryAfter = fuse?.retryAfter ?? 0;
      const platform = device.address.platform;
      const deliveryId = await ctx.db.insert("deliveries", {
        messageId,
        deviceId: device._id,
        platform,
        ...plan,
        attempts: 0,
        nextAttemptAt: retryAfter > 0 ? now + retryAfter : undefined,
        updatedAt: now,
      });
      if (plan.status === "queued") {
        await enqueueJob(ctx, { _id: deliveryId, platform }, config.maxParallelism, now + retryAfter);
      } else {
        finished.push({ _id: deliveryId, deviceId: device._id, platform, provider: plan.provider, status: plan.status, errorCode: plan.errorCode, updatedAt: now });
      }
    }),
  );
  for (const delivery of finished) await finishDelivery(ctx, delivery, message);
  await scrubIfDone(ctx, messageId);
  logger.info("message.enqueued", { messageId, deliveries: devices.length });
  return { messageId, deliveries: devices.length, deduplicated: false };
}

/**
 * Apply one send outcome to a queued delivery: record it, invalidate a dead
 * device, or queue a retry until the attempt limit or the message's expiry.
 * A delivery that is no longer queued (cancelled, pruned) is left alone.
 * @param ctx - Mutation context.
 * @param deliveryId - The delivery.
 * @param outcome - What the send action returned.
 */
export async function applyOutcome(ctx: MutationCtx, deliveryId: Id<"deliveries">, outcome: DeliverOutcome): Promise<void> {
  const delivery = await ctx.db.get("deliveries", deliveryId);
  if (delivery?.status !== "queued" || outcome.status === "skip") return;
  const message = await ctx.db.get("messages", delivery.messageId);
  if (!message) return;
  const now = Date.now();
  const attempts = delivery.attempts + 1;
  const base = { attempts, updatedAt: now, httpStatus: outcome.httpStatus, nextAttemptAt: undefined };
  switch (outcome.status) {
    case "sent": {
      const done = await setDelivery(ctx, delivery, {
        ...base,
        status: "sent",
        providerMessageId: outcome.providerMessageId,
        errorCode: undefined,
        sentAt: now,
      });
      await finishDelivery(ctx, done, message);
      return;
    }
    case "invalid": {
      await recordInvalid(ctx, delivery, message, { ...base, code: outcome.code ?? "INVALID", invalidSince: outcome.invalidSince });
      return;
    }
    case "failed": {
      const done = await setDelivery(ctx, delivery, { ...base, status: "failed", errorCode: outcome.code ?? "FAILED" });
      await finishDelivery(ctx, done, message);
      return;
    }
    case "retry": {
      const nextAttemptAt = now + (outcome.delayMs ?? backoffDelay(attempts));
      const stop = attempts >= message.maxAttempts ? (outcome.code ?? "RETRY_LIMIT") : nextAttemptAt >= message.expiresAt ? "TTL_EXPIRED" : null;
      if (stop) {
        const done = await setDelivery(ctx, delivery, { ...base, status: "failed", errorCode: stop });
        await finishDelivery(ctx, done, message);
        return;
      }
      await ctx.db.patch("deliveries", deliveryId, { ...base, errorCode: outcome.code, nextAttemptAt });
      await enqueueJob(ctx, delivery, message.maxParallelism, nextAttemptAt);
      logger.info("delivery.retry", { deliveryId, platform: delivery.platform, attempts, errorCode: outcome.code });
    }
  }
}

async function recordInvalid(
  ctx: MutationCtx,
  delivery: Doc<"deliveries">,
  message: Doc<"messages">,
  info: { attempts: number; updatedAt: number; httpStatus?: number; code: string; invalidSince?: number },
): Promise<void> {
  const { code, invalidSince, ...base } = info;
  const device = await ctx.db.get("devices", delivery.deviceId);
  if (device && delivery.platform === "apns" && code === "BadDeviceToken") {
    const breaker = await limiter.limit(ctx, "badDeviceToken", { key: device.appRef });
    if (!breaker.ok) {
      logger.warn("app.paused", { appRef: device.appRef });
      const done = await setDelivery(ctx, delivery, { ...base, status: "failed", errorCode: "APP_PAUSED" });
      await finishDelivery(ctx, done, message);
      return;
    }
  }
  const done = await setDelivery(ctx, delivery, { ...base, status: "invalid", errorCode: code });
  const registeredSince = invalidSince !== undefined && device !== null && device.lastSeenAt > invalidSince;
  if (device?.status === "active" && !registeredSince) {
    await ctx.db.patch("devices", device._id, { status: "invalid", invalidCode: code });
  }
  await finishDelivery(ctx, done, message);
}
