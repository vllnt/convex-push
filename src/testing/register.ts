/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "../component/schema.js";
import { register } from "../test.js";

/**
 * Test-only: register the component like `register`, plus the `testing/inspect`
 * module, so a test can call `function://<name>;testing/inspect:dumpTables`.
 * @param t - The test instance from `convexTest`.
 * @param name - The mount name.
 */
export function registerForTests(t: TestConvex<SchemaDefinition<GenericSchema, boolean>>, name: string): void {
  register(t, name);
  t.registerComponent(name, schema, {
    ...import.meta.glob("../component/**/*.ts"),
    "../component/testing/inspect.ts": async () => import("./inspect.js"),
  });
}
