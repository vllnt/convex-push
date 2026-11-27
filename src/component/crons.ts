import { cronJobs } from "convex/server";
import { DEFAULT_PRUNE_BATCH, DEFAULT_RETENTION_MS } from "../shared.js";
import { api } from "./_generated/api.js";

/**
 * Daily prune with the default 30-day retention. Cron definitions are static
 * per deployment; a host that wants another window calls `prune` itself.
 */
const crons = cronJobs();

crons.interval("push:prune", { hours: 24 }, api.mutations.prune, {
  retentionMs: DEFAULT_RETENTION_MS,
  batch: DEFAULT_PRUNE_BATCH,
});

/** The component's cron jobs. */
export default crons;
