import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import workpool from "@convex-dev/workpool/convex.config.js";
import { defineComponent } from "convex/server";
import { v } from "convex/values";

/**
 * Every variable is optional. A provider without its keys is switched off and
 * its deliveries fail with `PROVIDER_NOT_CONFIGURED`. The host binds them at
 * mount: `app.use(push, { env: { APNS_KEY_P8: app.env.APNS_KEY_P8, ... } })`.
 */
const component = defineComponent("push", {
  env: {
    APNS_KEY_P8: v.optional(v.string()),
    APNS_KEY_ID: v.optional(v.string()),
    APNS_TEAM_ID: v.optional(v.string()),
    APNS_SANDBOX_KEY_P8: v.optional(v.string()),
    APNS_SANDBOX_KEY_ID: v.optional(v.string()),
    FCM_SERVICE_ACCOUNT_JSON: v.optional(v.string()),
    VAPID_PUBLIC_KEY: v.optional(v.string()),
    VAPID_PRIVATE_KEY: v.optional(v.string()),
    VAPID_SUBJECT: v.optional(v.string()),
  },
});

/** One queue per provider, so a slow or throttled provider never holds up the others. */
component.use(workpool, { name: "apnsPool" });
component.use(workpool, { name: "fcmPool" });
component.use(workpool, { name: "webpushPool" });
component.use(workpool, { name: "customPool" });
component.use(rateLimiter);

export default component;
