/// <reference types="vite/client" />
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "../component/schema.js";
import { register } from "../test.js";

/** One mounted component the test inspector can read, with its tables. */
export interface InspectedMount {
  mount: string;
  tables: string[];
}

const inspector = async (): Promise<unknown> => import("./inspect.js");
const POOLS = ["apnsPool", "fcmPool", "webpushPool", "customPool"] as const;

/**
 * Test-only: register the component like `register`, then add the
 * `testing/inspect` module to it and to its child components (the four
 * workpools and the rate limiter), so a test can read everything they persist.
 * @param t - The test instance from `convexTest`.
 * @param name - The mount name.
 * @returns Every inspectable mount with its table names.
 */
export function registerForTests(t: TestConvex<SchemaDefinition<GenericSchema, boolean>>, name: string): InspectedMount[] {
  register(t, name);
  t.registerComponent(name, schema, {
    ...import.meta.glob("../component/**/*.ts"),
    "../component/testing/inspect.ts": inspector,
  });
  const children = [
    ...POOLS.map((pool) => ({ mount: `${name}/${pool}`, child: workpoolTest })),
    { mount: `${name}/rateLimiter`, child: rateLimiterTest },
  ];
  for (const { mount, child } of children) {
    t.registerComponent(mount, child.schema, { ...child.modules, "./component/testing/inspect.ts": inspector });
  }
  return [
    { mount: name, tables: Object.keys(schema.tables) },
    ...children.map(({ mount, child }) => ({ mount, tables: Object.keys(child.schema.tables) })),
  ];
}
