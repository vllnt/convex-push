/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    mutations: {
      cancel: FunctionReference<
        "mutation",
        "internal",
        { messageId: string },
        { cancelled: number },
        Name
      >;
      prune: FunctionReference<
        "mutation",
        "internal",
        { batch?: number; retentionMs?: number },
        { deleted: number; more: boolean },
        Name
      >;
      register: FunctionReference<
        "mutation",
        "internal",
        {
          address:
            | { platform: "apns"; token: string }
            | { platform: "fcm"; token: string }
            | {
                auth: string;
                endpoint: string;
                p256dh: string;
                platform: "webpush";
              }
            | { address: string; platform: "custom"; provider: string };
          appRef: string;
          installRef?: string;
          locale?: string;
          subjectRef: string;
        },
        { created: boolean; deviceId: string },
        Name
      >;
      send: FunctionReference<
        "mutation",
        "internal",
        {
          config: {
            apps: Array<{
              app:
                | {
                    environment: "production" | "sandbox";
                    platform: "apns";
                    topic: string;
                  }
                | { platform: "fcm" }
                | { platform: "webpush" }
                | { platform: "custom"; provider: string };
              appRef: string;
            }>;
            maxAttempts: number;
            maxParallelism: number;
            onDeliveryHandle?: string;
            providers: Array<{ handle: string; provider: string }>;
            scrub: boolean;
          };
          message: {
            badge?: number;
            body?: string;
            category?: string;
            collapseKey?: string;
            data?: Record<string, string | number | boolean>;
            idempotencyKey?: string;
            overrides?: {
              apns?: {
                interruptionLevel?:
                  "passive" | "active" | "time-sensitive" | "critical";
                mutableContent?: boolean;
                rawJson?: string;
                threadId?: string;
              };
              fcm?: { channelId?: string; rawJson?: string };
              webpush?: { icon?: string; rawJson?: string; url?: string };
            };
            priority?: "high" | "normal";
            sound?: string;
            title?: string;
            to: { subjectRef: string } | { deviceIds: Array<string> };
            ttlSeconds?: number;
          };
        },
        { deduplicated: boolean; deliveries: number; messageId: string },
        Name
      >;
      sendBatch: FunctionReference<
        "mutation",
        "internal",
        {
          config: {
            apps: Array<{
              app:
                | {
                    environment: "production" | "sandbox";
                    platform: "apns";
                    topic: string;
                  }
                | { platform: "fcm" }
                | { platform: "webpush" }
                | { platform: "custom"; provider: string };
              appRef: string;
            }>;
            maxAttempts: number;
            maxParallelism: number;
            onDeliveryHandle?: string;
            providers: Array<{ handle: string; provider: string }>;
            scrub: boolean;
          };
          messages: Array<{
            badge?: number;
            body?: string;
            category?: string;
            collapseKey?: string;
            data?: Record<string, string | number | boolean>;
            idempotencyKey?: string;
            overrides?: {
              apns?: {
                interruptionLevel?:
                  "passive" | "active" | "time-sensitive" | "critical";
                mutableContent?: boolean;
                rawJson?: string;
                threadId?: string;
              };
              fcm?: { channelId?: string; rawJson?: string };
              webpush?: { icon?: string; rawJson?: string; url?: string };
            };
            priority?: "high" | "normal";
            sound?: string;
            title?: string;
            to: { subjectRef: string } | { deviceIds: Array<string> };
            ttlSeconds?: number;
          }>;
        },
        Array<{ deduplicated: boolean; deliveries: number; messageId: string }>,
        Name
      >;
      setDeviceStatus: FunctionReference<
        "mutation",
        "internal",
        {
          deviceId: string;
          status: "active" | "disabled";
          subjectRef?: string;
        },
        { updated: boolean },
        Name
      >;
      unregister: FunctionReference<
        "mutation",
        "internal",
        {
          address?:
            | { platform: "apns"; token: string }
            | { platform: "fcm"; token: string }
            | {
                auth: string;
                endpoint: string;
                p256dh: string;
                platform: "webpush";
              }
            | { address: string; platform: "custom"; provider: string };
          deviceId?: string;
          subjectRef?: string;
        },
        { removed: boolean },
        Name
      >;
    };
    queries: {
      listBySubject: FunctionReference<
        "query",
        "internal",
        { limit?: number; subjectRef: string },
        Array<{
          createdAt: number;
          expiresAt: number;
          failed: number;
          invalid: number;
          messageId: string;
          queued: number;
          scrubbedAt?: number;
          sent: number;
        }>,
        Name
      >;
      listDevices: FunctionReference<
        "query",
        "internal",
        {
          limit?: number;
          status?: "active" | "disabled" | "invalid";
          subjectRef: string;
        },
        Array<{
          appRef: string;
          deviceId: string;
          installRef?: string;
          invalidCode?: string;
          lastSeenAt: number;
          locale?: string;
          platform: "apns" | "fcm" | "webpush" | "custom";
          provider?: string;
          status: "active" | "disabled" | "invalid";
          subjectRef: string;
        }>,
        Name
      >;
      status: FunctionReference<
        "query",
        "internal",
        { messageId: string },
        {
          createdAt: number;
          deliveries: Array<{
            attempts: number;
            deliveryId: string;
            deviceId: string;
            errorCode?: string;
            httpStatus?: number;
            nextAttemptAt?: number;
            platform: "apns" | "fcm" | "webpush" | "custom";
            provider?: string;
            providerMessageId?: string;
            sentAt?: number;
            status: "queued" | "sent" | "failed" | "invalid";
            updatedAt: number;
          }>;
          expiresAt: number;
          messageId: string;
          scrubbedAt?: number;
        } | null,
        Name
      >;
    };
  };
