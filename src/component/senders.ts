import type { FunctionHandle } from "convex/server";
import type { ActionCtx } from "./_generated/server.js";
import { isHandleString } from "./checks.js";
import { sendApns } from "./providers/apns.js";
import { sendFcm } from "./providers/fcm.js";
import type { PushEnv } from "./providers/keys.js";
import type { PushContent } from "./providers/payload.js";
import type { TokenCache } from "./providers/token_cache.js";
import { sendWebPush } from "./providers/web_push.js";
import { clampDelay } from "./providers/http.js";
import type { CustomSendArgs, DeviceAddress, SendResult } from "./validators.js";

/** What the send action loads for one queued delivery. */
export interface Job {
  deliveryId: string;
  messageId: string;
  provider?: string;
  senderHandle?: string;
  apns?: { topic: string; environment: "production" | "sandbox" };
  attempts: number;
  expiresAt: number;
  title?: string;
  body?: string;
  data: PushContent["data"];
  options: PushContent["options"];
  overrides?: PushContent["overrides"];
  /** `reassigned`: the device moved to another subject after the message was sent. */
  device: { status: "active" | "disabled" | "invalid"; address: DeviceAddress; reassigned: boolean } | null;
}

/** Everything a sender needs besides the job. */
export interface SenderDeps {
  env: PushEnv;
  cache: TokenCache;
  now: () => number;
  runCustom: (handle: string, args: CustomSendArgs) => Promise<unknown>;
}

/**
 * Narrow a stored handle string to an action handle.
 * @param handle - The stored string.
 * @returns Whether it has the function-handle form.
 */
export function isActionHandle(handle: string): handle is FunctionHandle<"action", CustomSendArgs> {
  return isHandleString(handle);
}

/**
 * Check what a custom sender returned against the sender contract.
 * @param value - The host action's return value.
 * @returns The result, or `null` when it does not match.
 */
export function parseSendResult(value: unknown): SendResult | null {
  if (typeof value !== "object" || value === null || !("status" in value)) return null;
  const text = (key: string): string | undefined => {
    const field: unknown = Reflect.get(value, key);
    return typeof field === "string" ? field : undefined;
  };
  const count = (key: string): number | undefined => {
    const field: unknown = Reflect.get(value, key);
    return typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : undefined;
  };
  switch (value.status) {
    case "sent": {
      return { status: "sent", providerMessageId: text("providerMessageId"), httpStatus: count("httpStatus") };
    }
    case "retry": {
      const delayMs = count("delayMs");
      return { status: "retry", code: text("code"), delayMs: delayMs === undefined ? undefined : clampDelay(delayMs), httpStatus: count("httpStatus") };
    }
    case "invalid": {
      return { status: "invalid", code: text("code"), httpStatus: count("httpStatus"), invalidSince: count("invalidSince") };
    }
    case "failed": {
      return { status: "failed", code: text("code"), httpStatus: count("httpStatus") };
    }
    default: {
      return null;
    }
  }
}

async function sendCustom(job: Job, address: Extract<DeviceAddress, { platform: "custom" }>, deps: SenderDeps): Promise<SendResult> {
  if (!job.senderHandle) return { status: "failed", code: "PROVIDER_NOT_CONFIGURED" };
  let returned: unknown;
  try {
    returned = await deps.runCustom(job.senderHandle, {
      provider: address.provider,
      address: address.address,
      title: job.title,
      body: job.body,
      data: job.data,
      options: job.options,
      attempt: job.attempts + 1,
      messageId: job.messageId,
      deliveryId: job.deliveryId,
    });
  } catch {
    return { status: "retry", code: "SENDER_ERROR" };
  }
  return parseSendResult(returned) ?? { status: "failed", code: "SENDER_BAD_RESULT" };
}

/**
 * Send one queued delivery with the right sender. Nothing is sent after the
 * message expires, to a device that is no longer active, or to a device that
 * moved to another subject since the message was sent.
 * @param job - The delivery, its message content and its device.
 * @param deps - Env, token cache, clock and the custom-sender runner.
 * @returns The sender result.
 */
export async function runSender(job: Job, deps: SenderDeps): Promise<SendResult> {
  if (deps.now() >= job.expiresAt) return { status: "failed", code: "TTL_EXPIRED" };
  if (!job.device) return { status: "failed", code: "DEVICE_GONE" };
  if (job.device.reassigned) return { status: "failed", code: "DEVICE_REASSIGNED" };
  if (job.device.status !== "active") {
    return { status: "failed", code: job.device.status === "disabled" ? "DEVICE_DISABLED" : "DEVICE_INVALID" };
  }
  const content: PushContent = { title: job.title, body: job.body, data: job.data, options: job.options, overrides: job.overrides };
  const { address } = job.device;
  switch (address.platform) {
    case "apns": {
      if (!job.apns) return { status: "failed", code: "APP_NOT_CONFIGURED" };
      return sendApns({ messageId: job.messageId, token: address.token, ...job.apns, content, expiresAt: job.expiresAt }, deps.env, deps.cache, deps.now);
    }
    case "fcm": {
      return sendFcm({ token: address.token, content, expiresAt: job.expiresAt }, deps.env, deps.cache, deps.now);
    }
    case "webpush": {
      return sendWebPush({ messageId: job.messageId, ...address, content, expiresAt: job.expiresAt }, deps.env, deps.cache, deps.now);
    }
    case "custom": {
      return sendCustom(job, address, deps);
    }
  }
}

/**
 * Wire the sender dependencies to a Convex action context.
 * @param ctx - The action context.
 * @param env - Component env.
 * @param cache - Provider-token cache.
 * @returns The dependencies.
 */
export function actionDeps(ctx: Pick<ActionCtx, "runAction">, env: PushEnv, cache: TokenCache): SenderDeps {
  return {
    env,
    cache,
    now: () => Date.now(),
    runCustom: async (handle, args) => (isActionHandle(handle) ? ctx.runAction(handle, args) : null),
  };
}
