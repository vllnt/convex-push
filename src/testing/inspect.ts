import { v } from "convex/values";
import { internalQuery } from "../component/_generated/server.js";

/**
 * Test-only: every row of every table as one JSON string, so tests can scan
 * stored data for secrets. It lives outside `src/component/` so Convex codegen
 * and deploys never include it; `registerForTests` adds it to the component's
 * modules under `testing/inspect`. Excluded from the build and the npm package.
 */
export const dumpTables = internalQuery({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const [devices, messages, deliveries, providerTokens] = await Promise.all([
      ctx.db.query("devices").take(1000),
      ctx.db.query("messages").take(1000),
      ctx.db.query("deliveries").take(1000),
      ctx.db.query("providerTokens").take(1000),
    ]);
    const bytes = (b: ArrayBuffer): string => new TextDecoder("latin1").decode(b);
    return JSON.stringify({
      devices,
      messages,
      deliveries,
      providerTokens: providerTokens.map((t) => ({ ...t, cipher: bytes(t.cipher), iv: bytes(t.iv) })),
    });
  },
});
