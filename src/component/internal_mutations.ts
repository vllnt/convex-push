import { vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";
import { applyOutcome } from "./queue.js";
import type { DeliverOutcome } from "./validators.js";

/**
 * Workpool completion callback for one send job. A success carries the send
 * action's result (validated by the action's `returns`); a throw or timeout of
 * the action counts as a retry; a cancelled job ends the delivery as failed.
 */
export const onSendComplete = internalMutation({
  args: vOnCompleteArgs(v.object({ deliveryId: v.id("deliveries") })),
  returns: v.null(),
  handler: async (ctx, { context, result }) => {
    const outcome: DeliverOutcome =
      result.kind === "success"
        ? parseOutcome(result.returnValue)
        : result.kind === "failed"
          ? { status: "retry", code: "SENDER_ERROR" }
          : { status: "failed", code: "CANCELLED" };
    await applyOutcome(ctx, context.deliveryId, outcome);
    return null;
  },
});

function parseOutcome(value: unknown): DeliverOutcome {
  return isOutcome(value) ? value : { status: "failed", code: "SENDER_BAD_RESULT" };
}

const OUTCOME_STATUSES = new Set<unknown>(["sent", "retry", "invalid", "failed", "skip"]);

function isOutcome(value: unknown): value is DeliverOutcome {
  return typeof value === "object" && value !== null && "status" in value && OUTCOME_STATUSES.has(value.status);
}

const slot = { credentialRef: v.string(), audience: v.optional(v.string()) };

/**
 * Store a freshly minted provider token. When another sender already stored a
 * token that is still fresh, that one is kept and returned, so concurrent
 * senders converge on one token (Apple rejects frequent token changes).
 */
export const storeToken = internalMutation({
  args: {
    ...slot,
    cipher: v.bytes(),
    iv: v.bytes(),
    mintedAt: v.number(),
    refreshAfter: v.number(),
    expiresAt: v.number(),
  },
  returns: v.object({ cipher: v.bytes(), iv: v.bytes() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("providerTokens")
      .withIndex("by_credential_audience", (q) => q.eq("credentialRef", args.credentialRef).eq("audience", args.audience))
      .first();
    if (existing && existing.refreshAfter > Date.now()) return { cipher: existing.cipher, iv: existing.iv };
    if (existing) await ctx.db.delete("providerTokens", existing._id);
    await ctx.db.insert("providerTokens", args);
    return { cipher: args.cipher, iv: args.iv };
  },
});

/** Forget a cached token the provider refused as expired. */
export const dropToken = internalMutation({
  args: slot,
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("providerTokens")
      .withIndex("by_credential_audience", (q) => q.eq("credentialRef", args.credentialRef).eq("audience", args.audience))
      .first();
    if (existing) await ctx.db.delete("providerTokens", existing._id);
    return null;
  },
});
