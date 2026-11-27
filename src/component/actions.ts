import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { env, internalAction } from "./_generated/server.js";
import { createTokenCache } from "./providers/token_cache.js";
import { actionDeps, type Job, runSender } from "./senders.js";
import { type DeliverOutcome, deliverOutcome } from "./validators.js";

/**
 * Send one queued delivery. Runs in the default runtime (components cannot use
 * Node actions): signing, encryption and HTTP/2 to Apple all use Web APIs.
 * Returns `skip` when the delivery is no longer queued.
 */
export const deliver = internalAction({
  args: { deliveryId: v.id("deliveries") },
  returns: deliverOutcome,
  handler: async (ctx, args): Promise<DeliverOutcome> => {
    const job: Job | null = await ctx.runQuery(internal.queries.loadJob, { deliveryId: args.deliveryId });
    if (!job) return { status: "skip" };
    const cache = createTokenCache(
      {
        load: (slot) => ctx.runQuery(internal.queries.loadToken, slot),
        store: (slot, row) => ctx.runMutation(internal.internal_mutations.storeToken, { ...slot, ...row }),
        drop: async (slot) => {
          await ctx.runMutation(internal.internal_mutations.dropToken, slot);
        },
      },
      () => Date.now(),
    );
    return runSender(job, actionDeps(ctx, env, cache));
  },
});
