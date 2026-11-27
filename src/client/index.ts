import {
  createFunctionHandle,
  type FunctionReference,
  type FunctionVisibility,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
} from "convex/server";
import { ConvexError } from "convex/values";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_PARALLELISM,
  DEFAULT_PRUNE_BATCH,
  DEFAULT_RETENTION_MS,
  type DeviceStatus,
} from "../shared.js";
import type { ComponentApi } from "../component/_generated/component.js";
import type {
  AppConfig,
  CustomSendArgs,
  DeliveryEvent,
  DeviceAddress,
  DeviceView,
  MessageStatus,
  MessageSummary,
  SendConfig,
  SendInput,
} from "../component/validators.js";

export {
  appConfig,
  customSendArgs,
  data,
  deliveryEvent,
  deliveryView,
  deviceAddress,
  deviceView,
  messageStatus,
  messageSummary,
  overrides,
  sendResult,
} from "../component/validators.js";
export type {
  AppConfig,
  CustomSendArgs,
  DeliveryEvent,
  DeliveryView,
  DeviceAddress,
  DeviceView,
  MessageStatus,
  MessageSummary,
  Overrides,
  PushData,
  SendInput,
  SendResult,
} from "../component/validators.js";
export * from "../shared.js";

/** A context that can run component mutations. */
export type RunMutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;
/** A context that can run component queries. */
export type RunQueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
/** Any context that can run component queries (query, mutation or action). */
export type AnyQueryCtx = RunQueryCtx | Pick<GenericActionCtx<GenericDataModel>, "runQuery">;

/** A host action that sends one notification for a custom provider. */
export type CustomSender = FunctionReference<"action", FunctionVisibility, CustomSendArgs>;
/** A host mutation told once per finished delivery. */
export type DeliveryHook = FunctionReference<"mutation", FunctionVisibility, DeliveryEvent>;

/** Settings of one mount. Only `apps` is required. */
export interface PushOptions {
  /** What each `appRef` means: platform, and for APNs the bundle id and Apple host. */
  apps: Readonly<Record<string, AppConfig>>;
  /** Custom providers by name, each with the host action that sends. */
  providers?: Readonly<Record<string, { send: CustomSender }>>;
  /** Host mutation run once per delivery when it reaches sent, failed or invalid. */
  onDelivery?: DeliveryHook;
  /** Time to live when a send gives none. Default one day. */
  defaultTtlSeconds?: number;
  /** Attempts per delivery. Default 5. */
  maxAttempts?: number;
  /** Sends in flight per provider queue. Default 10. */
  maxParallelism?: number;
  /** Erase title, body and data once every delivery has finished. Default true. */
  scrubContent?: boolean;
  /** Retention used by {@link Push.prune}. Default 30 days. */
  retentionMs?: number;
}

/** One message to send. */
export type SendMessage = SendInput;

/** Arguments of {@link Push.register}. */
export interface RegisterArgs {
  subjectRef: string;
  appRef: string;
  address: DeviceAddress;
  installRef?: string;
  locale?: string;
}

function clientError(code: "PLATFORM_MISMATCH" | "UNKNOWN_APP", message: string): never {
  throw new ConvexError({ code, message });
}

/**
 * Typed entry point to a mounted push component.
 *
 * @example
 * const push = new Push(components.push, {
 *   apps: { ios: { platform: "apns", topic: "com.example.app", environment: "production" } },
 * });
 * await push.send(ctx, { to: { subjectRef: userId }, title: "Support replied", body: preview });
 */
export class Push {
  /**
   * @param component - `components.push` from the host's `_generated/api`.
   * @param options - Apps, providers, hook and defaults.
   */
  constructor(
    public readonly component: ComponentApi,
    private readonly options: PushOptions,
  ) {}

  private async config(): Promise<SendConfig> {
    const providers = await Promise.all(
      Object.entries(this.options.providers ?? {}).map(async ([provider, { send }]) => ({
        provider,
        handle: await createFunctionHandle(send),
      })),
    );
    return {
      apps: Object.entries(this.options.apps).map(([appRef, app]) => ({ appRef, app })),
      providers,
      onDeliveryHandle: this.options.onDelivery ? await createFunctionHandle(this.options.onDelivery) : undefined,
      maxAttempts: this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      maxParallelism: this.options.maxParallelism ?? DEFAULT_MAX_PARALLELISM,
      scrub: this.options.scrubContent ?? true,
    };
  }

  private withDefaults(message: SendMessage): SendMessage {
    return { ...message, ttlSeconds: message.ttlSeconds ?? this.options.defaultTtlSeconds };
  }

  /**
   * Register or refresh a device. The host resolves `subjectRef` from its own auth.
   * @param ctx - A mutation context.
   * @param args - Owner, app, address and optional install id and locale.
   * @returns The device id and whether a new row was created.
   * @throws `UNKNOWN_APP` when `appRef` is not in `apps`; `PLATFORM_MISMATCH` when the address does not fit the app.
   */
  async register(ctx: RunMutationCtx, args: RegisterArgs): Promise<{ deviceId: string; created: boolean }> {
    const app = this.options.apps[args.appRef];
    if (!app) return clientError("UNKNOWN_APP", `appRef "${args.appRef}" is not configured`);
    const fits =
      app.platform === args.address.platform &&
      (app.platform !== "custom" || (args.address.platform === "custom" && args.address.provider === app.provider));
    if (!fits) return clientError("PLATFORM_MISMATCH", `the address does not fit appRef "${args.appRef}"`);
    return ctx.runMutation(this.component.mutations.register, { ...args });
  }

  /**
   * Remove a device, for example on logout.
   * @param ctx - A mutation context.
   * @param args - `deviceId` or `address`, and optionally the owner to check.
   * @returns Whether a device was removed.
   */
  async unregister(
    ctx: RunMutationCtx,
    args: { deviceId: string; subjectRef?: string } | { address: DeviceAddress; subjectRef?: string },
  ): Promise<{ removed: boolean }> {
    return ctx.runMutation(this.component.mutations.unregister, args);
  }

  /**
   * Pause or resume one device.
   * @param ctx - A mutation context.
   * @param args - Device, new status, and optionally the owner to check.
   * @returns Whether the device was updated.
   */
  async setDeviceStatus(
    ctx: RunMutationCtx,
    args: { deviceId: string; status: Exclude<DeviceStatus, "invalid">; subjectRef?: string },
  ): Promise<{ updated: boolean }> {
    return ctx.runMutation(this.component.mutations.setDeviceStatus, args);
  }

  /**
   * List a subject's devices. Addresses are never returned.
   * @param ctx - Any context that can run queries.
   * @param args - Owner, optional status filter and limit (default 20, max 100).
   * @returns Device views.
   */
  async listDevices(
    ctx: AnyQueryCtx,
    args: { subjectRef: string; status?: DeviceStatus; limit?: number },
  ): Promise<DeviceView[]> {
    return ctx.runQuery(this.component.queries.listDevices, args);
  }

  /**
   * Enqueue one message. Call it from a mutation: if the mutation fails, nothing is queued.
   * @param ctx - A mutation context.
   * @param message - Recipient, content, options, overrides and idempotency key.
   * @returns The message id, how many deliveries were created, and whether the idempotency key matched an earlier send.
   */
  async send(
    ctx: RunMutationCtx,
    message: SendMessage,
  ): Promise<{ messageId: string; deliveries: number; deduplicated: boolean }> {
    return ctx.runMutation(this.component.mutations.send, { message: this.withDefaults(message), config: await this.config() });
  }

  /**
   * Enqueue up to 100 messages in one transaction.
   * @param ctx - A mutation context.
   * @param messages - The messages.
   * @returns One result per message, in order.
   */
  async sendBatch(
    ctx: RunMutationCtx,
    messages: SendMessage[],
  ): Promise<{ messageId: string; deliveries: number; deduplicated: boolean }[]> {
    return ctx.runMutation(this.component.mutations.sendBatch, {
      messages: messages.map((m) => this.withDefaults(m)),
      config: await this.config(),
    });
  }

  /**
   * A message's delivery state. Reactive in a query. Never returns content.
   * @param ctx - Any context that can run queries.
   * @param messageId - The id `send` returned.
   * @returns The status, or `null` for an unknown id.
   */
  async status(ctx: AnyQueryCtx, messageId: string): Promise<MessageStatus | null> {
    return ctx.runQuery(this.component.queries.status, { messageId });
  }

  /**
   * A subject's recent messages, newest first, with delivery counts.
   * @param ctx - Any context that can run queries.
   * @param args - Subject and optional limit (default 20, max 100).
   * @returns Message summaries.
   */
  async listBySubject(ctx: AnyQueryCtx, args: { subjectRef: string; limit?: number }): Promise<MessageSummary[]> {
    return ctx.runQuery(this.component.queries.listBySubject, args);
  }

  /**
   * Cancel a message's queued deliveries.
   * @param ctx - A mutation context.
   * @param messageId - The message.
   * @returns How many deliveries were cancelled.
   */
  async cancel(ctx: RunMutationCtx, messageId: string): Promise<{ cancelled: number }> {
    return ctx.runMutation(this.component.mutations.cancel, { messageId });
  }

  /**
   * Delete data older than the retention window. The component also runs this daily with the default window.
   * @param ctx - A mutation context.
   * @param args - Optional batch size.
   * @returns Rows deleted, and whether another pass was scheduled.
   */
  async prune(ctx: RunMutationCtx, args: { batch?: number } = {}): Promise<{ deleted: number; more: boolean }> {
    return ctx.runMutation(this.component.mutations.prune, {
      retentionMs: this.options.retentionMs ?? DEFAULT_RETENTION_MS,
      batch: args.batch ?? DEFAULT_PRUNE_BATCH,
    });
  }
}
