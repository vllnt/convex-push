/// <reference types="vite/client" />
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import type { WorkId } from "@convex-dev/workpool";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import crons from "./crons.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const t = convexTest(schema, modules);
  for (const pool of ["apnsPool", "fcmPool", "webpushPool", "customPool"]) workpoolTest.register(t, pool);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}
type T = ReturnType<typeof setup>;

/** One queued delivery to one custom device, written straight to the tables. */
async function seed(t: T, maxAttempts = 5, onDeliveryHandle?: string): Promise<{ deliveryId: Id<"deliveries">; messageId: Id<"messages"> }> {
  return t.run(async (ctx) => {
    const now = Date.now();
    const deviceId = await ctx.db.insert("devices", {
      subjectRef: "u1",
      appRef: "desktop",
      address: { platform: "custom", provider: "webhook", address: "https://hook.example/d/1" },
      addressHash: "hash",
      status: "active",
      lastSeenAt: now,
    });
    const messageId = await ctx.db.insert("messages", {
      to: { subjectRef: "u1" },
      title: "Hi",
      data: {},
      options: { ttlSeconds: 3600, priority: "high" },
      expiresAt: now + 3_600_000,
      maxAttempts,
      maxParallelism: 10,
      scrub: true,
      onDeliveryHandle,
    });
    const deliveryId = await ctx.db.insert("deliveries", {
      messageId,
      deviceId,
      platform: "custom",
      provider: "webhook",
      status: "queued",
      attempts: 0,
      updatedAt: now,
    });
    return { deliveryId, messageId };
  });
}

function isWorkId(value: string): value is WorkId {
  return value.length > 0;
}

/** A work id for completion callbacks invoked directly, outside a pool run. */
function workId(value: string): WorkId {
  if (!isWorkId(value)) throw new Error("empty work id");
  return value;
}

async function delivery(t: T, id: Id<"deliveries">) {
  return t.run((ctx) => ctx.db.get("deliveries", id));
}

describe("workpool completion", () => {
  test("a send action that threw is a retry; a cancelled job ends as CANCELLED", async () => {
    const t = setup();
    const a = await seed(t);
    await t.mutation(internal.internal_mutations.onSendComplete, {
      workId: workId("w1"),
      context: { deliveryId: a.deliveryId },
      result: { kind: "failed", error: "boom" },
    });
    expect(await delivery(t, a.deliveryId)).toMatchObject({ status: "queued", attempts: 1, errorCode: "SENDER_ERROR" });
    const b = await seed(t);
    await t.mutation(internal.internal_mutations.onSendComplete, {
      workId: workId("w2"),
      context: { deliveryId: b.deliveryId },
      result: { kind: "canceled" },
    });
    expect(await delivery(t, b.deliveryId)).toMatchObject({ status: "failed", errorCode: "CANCELLED" });
  });

  test("a malformed action result fails the delivery; outcomes without a code get a default one", async () => {
    const t = setup();
    const cases: [unknown, string, number][] = [
      [{ nope: true }, "SENDER_BAD_RESULT", 5],
      [null, "SENDER_BAD_RESULT", 5],
      [{ status: "invalid" }, "INVALID", 5],
      [{ status: "failed" }, "FAILED", 5],
      [{ status: "retry" }, "RETRY_LIMIT", 1],
    ];
    for (const [returnValue, code, maxAttempts] of cases) {
      const { deliveryId } = await seed(t, maxAttempts);
      await t.mutation(internal.internal_mutations.onSendComplete, {
        workId: workId("w"),
        context: { deliveryId },
        result: { kind: "success", returnValue },
      });
      expect((await delivery(t, deliveryId))?.errorCode).toBe(code);
    }
  });

  test("an outcome for a delivery whose message is gone changes nothing", async () => {
    const t = setup();
    const { deliveryId, messageId } = await seed(t);
    await t.run((ctx) => ctx.db.delete("messages", messageId));
    await t.mutation(internal.internal_mutations.onSendComplete, {
      workId: workId("w"),
      context: { deliveryId },
      result: { kind: "success", returnValue: { status: "sent" } },
    });
    expect(await delivery(t, deliveryId)).toMatchObject({ status: "queued", attempts: 0 });
    expect(await t.query(internal.queries.loadJob, { deliveryId })).toBeNull();
  });


  test("a hook that cannot be scheduled is logged and the delivery is still recorded", async () => {
    const t = setup();
    const lines: unknown[] = [];
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => lines.push(...args));
    }
    const { deliveryId } = await seed(t, 5, "function://unmounted;hooks:onDelivery");
    await t.mutation(internal.internal_mutations.onSendComplete, {
      workId: workId("w"),
      context: { deliveryId },
      result: { kind: "success", returnValue: { status: "sent" } },
    });
    expect(await delivery(t, deliveryId)).toMatchObject({ status: "sent", attempts: 1 });
    expect(JSON.stringify(lines)).toContain("hook.schedule_failed");
    vi.restoreAllMocks();
  });
});

describe("token rows", () => {
  const slot = { credentialRef: "ref", audience: "https://push.example" };
  const row = (byte: number, refreshAfter: number) => ({
    ...slot,
    cipher: new Uint8Array([byte]).buffer,
    iv: new Uint8Array(12).buffer,
    mintedAt: Date.now(),
    refreshAfter,
    expiresAt: refreshAfter + 1000,
  });

  test("a fresh stored token wins over a newer mint; a stale one is replaced", async () => {
    const t = setup();
    const first = await t.mutation(internal.internal_mutations.storeToken, row(1, Date.now() + 1000));
    const second = await t.mutation(internal.internal_mutations.storeToken, row(2, Date.now() + 5000));
    expect(new Uint8Array(second.cipher)).toEqual(new Uint8Array(first.cipher));
    vi.advanceTimersByTime(2000);
    const third = await t.mutation(internal.internal_mutations.storeToken, row(3, Date.now() + 5000));
    expect([...new Uint8Array(third.cipher)]).toEqual([3]);
    expect(await t.query(internal.queries.loadToken, slot)).toMatchObject({ refreshAfter: Date.now() + 5000 });
  });

  test("dropping a token that is not stored is a no-op", async () => {
    const t = setup();
    await expect(t.mutation(internal.internal_mutations.dropToken, slot)).resolves.toBeNull();
  });
});

describe("prune", () => {
  test("runs with default settings and refuses a negative retention", async () => {
    const t = setup();
    await seed(t);
    expect(await t.mutation(api.mutations.prune, {})).toEqual({ deleted: 0, more: false });
    await expect(t.mutation(api.mutations.prune, { retentionMs: -1 })).rejects.toThrow(/retentionMs/);
    await expect(t.mutation(api.mutations.prune, { retentionMs: Number.NaN })).rejects.toThrow(/retentionMs/);
  });

  test("a daily cron prunes with the defaults", () => {
    expect(Object.keys(crons.crons)).toEqual(["push:prune"]);
    expect(crons.crons["push:prune"]).toMatchObject({ schedule: { type: "interval", hours: 24 } });
  });
});
