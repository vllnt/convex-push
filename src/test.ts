/// <reference types="vite/client" />
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./component/schema.js";

/* v8 ignore next -- Vite rewrites import.meta.glob into a declaration-only module map */
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the component and its child components (four workpools and the rate limiter) with convex-test.
 * @param t - The test instance from `convexTest`.
 * @param name - The mount name used in `convex.config.ts`.
 */
export function register(t: TestConvex<SchemaDefinition<GenericSchema, boolean>>, name: string = "push"): void {
  t.registerComponent(name, schema, modules);
  for (const pool of ["apnsPool", "fcmPool", "webpushPool", "customPool"]) {
    workpoolTest.register(t, `${name}/${pool}`);
  }
  rateLimiterTest.register(t, `${name}/rateLimiter`);
}

/** The same helper as an object: `register`, the component `schema` and its `modules` map. */
/* v8 ignore next -- declaration-only compatibility export; properties are tested above */
export default { register, schema, modules };
