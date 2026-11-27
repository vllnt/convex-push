/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actions from "../actions.js";
import type * as checks from "../checks.js";
import type * as crons from "../crons.js";
import type * as crypto_codec from "../crypto/codec.js";
import type * as crypto_jwt from "../crypto/jwt.js";
import type * as crypto_token_seal from "../crypto/token_seal.js";
import type * as crypto_web_push_crypto from "../crypto/web_push_crypto.js";
import type * as internal_mutations from "../internal_mutations.js";
import type * as mutations from "../mutations.js";
import type * as providers_apns from "../providers/apns.js";
import type * as providers_fcm from "../providers/fcm.js";
import type * as providers_http from "../providers/http.js";
import type * as providers_keys from "../providers/keys.js";
import type * as providers_payload from "../providers/payload.js";
import type * as providers_token_cache from "../providers/token_cache.js";
import type * as providers_web_push from "../providers/web_push.js";
import type * as queries from "../queries.js";
import type * as queue from "../queue.js";
import type * as registry from "../registry.js";
import type * as senders from "../senders.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  actions: typeof actions;
  checks: typeof checks;
  crons: typeof crons;
  "crypto/codec": typeof crypto_codec;
  "crypto/jwt": typeof crypto_jwt;
  "crypto/token_seal": typeof crypto_token_seal;
  "crypto/web_push_crypto": typeof crypto_web_push_crypto;
  internal_mutations: typeof internal_mutations;
  mutations: typeof mutations;
  "providers/apns": typeof providers_apns;
  "providers/fcm": typeof providers_fcm;
  "providers/http": typeof providers_http;
  "providers/keys": typeof providers_keys;
  "providers/payload": typeof providers_payload;
  "providers/token_cache": typeof providers_token_cache;
  "providers/web_push": typeof providers_web_push;
  queries: typeof queries;
  queue: typeof queue;
  registry: typeof registry;
  senders: typeof senders;
  validators: typeof validators;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {
  apnsPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"apnsPool">;
  fcmPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"fcmPool">;
  webpushPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"webpushPool">;
  customPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"customPool">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
