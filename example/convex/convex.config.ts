import { defineApp } from "convex/server";
import { v } from "convex/values";
import push from "../../src/component/convex.config.js";

const app = defineApp({
  env: {
    APNS_KEY_P8: v.optional(v.string()),
    APNS_KEY_ID: v.optional(v.string()),
    APNS_TEAM_ID: v.optional(v.string()),
    FCM_SERVICE_ACCOUNT_JSON: v.optional(v.string()),
    VAPID_PUBLIC_KEY: v.optional(v.string()),
    VAPID_PRIVATE_KEY: v.optional(v.string()),
    VAPID_SUBJECT: v.optional(v.string()),
  },
});

app.use(push, {
  env: {
    APNS_KEY_P8: app.env.APNS_KEY_P8,
    APNS_KEY_ID: app.env.APNS_KEY_ID,
    APNS_TEAM_ID: app.env.APNS_TEAM_ID,
    FCM_SERVICE_ACCOUNT_JSON: app.env.FCM_SERVICE_ACCOUNT_JSON,
    VAPID_PUBLIC_KEY: app.env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: app.env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: app.env.VAPID_SUBJECT,
  },
});

/** A second mount: its own registry and queue, for a second Apple team or Firebase project. */
app.use(push, { name: "pushPartner", env: {} });

export default app;
