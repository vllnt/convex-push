import { defineSchema, defineTable } from "convex/server";
import { deliveryEvent } from "../../src/client/index.js";

/** The example host's own table. */
export default defineSchema({
  /** Events the onDelivery hook received, as a host would forward them to telemetry. */
  pushEvents: defineTable(deliveryEvent),
});
