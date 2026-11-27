import { internalQueryGeneric } from "convex/server";
import { v } from "convex/values";

function asText(_key: string, value: unknown): unknown {
  if (value instanceof ArrayBuffer) return new TextDecoder("latin1").decode(value);
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Test-only: every row of the named tables, plus the component's scheduled
 * functions (their stored arguments), as one JSON string, so tests can scan
 * everything Convex persists for secrets. Bytes are rendered as latin1 text, 64-bit integers as decimal text.
 * It lives outside `src/component/` so Convex codegen and deploys never include
 * it; `registerForTests` mounts it in the component and in its child
 * components under `testing/inspect`. Excluded from the build and the package.
 */
export const dumpTables = internalQueryGeneric({
  args: { tables: v.array(v.string()) },
  returns: v.string(),
  handler: async (ctx, { tables }) => {
    const rows = await Promise.all(tables.map(async (table) => [table, await ctx.db.query(table).take(1000)] as const));
    const scheduled = await ctx.db.system.query("_scheduled_functions").take(1000);
    return JSON.stringify({ ...Object.fromEntries(rows), _scheduled_functions: scheduled }, asText);
  },
});
