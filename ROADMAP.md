# Roadmap — convex-push

> Push notifications sent straight from a Convex backend to APNs, FCM and Web
> Push, as a Convex component — device registry, durable send queue, retries,
> dead-device cleanup and an encrypted token cache; no relay service.

**Now:** `v0-1-canary` built, waiting for owner review. Next: `real-device-smoke`.
**Last updated:** 2026-11-27

> **Canary:** every push to `main` that touches the package or its shipped docs
> publishes `{version}-canary.{sha7}` through npm trusted publishing. Stable
> `0.1.0` waits for the owner's `v0.1.0` tag.

## v0-1-canary [BUILT 2026-11, in review]

**Goal:** Ship everything the design doc puts in v1, following its build order,
with the three extension points.

**Exit criteria:** `pnpm lint`, `pnpm typecheck`, `pnpm build` and
`pnpm test:coverage` green at 100% coverage; CI green; two feasibility proofs
recorded in `specs/active/2026-11-27-convex-push-v0.1.md`.

- [x] v0-1-canary.1 Feasibility: HTTP/2 to Apple from a Convex action, and a component action calling a host action by function handle — check: spec § Proofs
- [x] v0-1-canary.2 Registry: `devices`, register / unregister / setDeviceStatus / listDevices, dedupe, reassignment, `installRef` rotation, multi-mount isolation — check: `example.test.ts` › device registry
- [x] v0-1-canary.3 Queue: messages, deliveries, fan-out, idempotency, TTL, size checks, retry and invalidation — check: `example.test.ts` › retries, expiry and dead devices
- [x] v0-1-canary.4 Extension points: custom provider, `onDelivery`, `rawJson` — check: `example.test.ts` › extension points, validation at enqueue
- [x] v0-1-canary.5 Token cache and signing: ES256, RS256, Google exchange, sealed cache — check: `crypto.test.ts` vectors, `providers.test.ts` › token cache
- [x] v0-1-canary.6 APNs sender against recorded responses (200, 400, 403, 410 with timestamp, 429, 503) — check: `providers.test.ts` › APNs
- [x] v0-1-canary.7 FCM sender against recorded responses (success, UNREGISTERED, INVALID_ARGUMENT, QUOTA_EXCEEDED, UNAVAILABLE with Retry-After) — check: `providers.test.ts` › FCM
- [x] v0-1-canary.8 Web Push sender: RFC 8291 vector, 201, 404, 410, 413 — check: `crypto.test.ts`, `providers.test.ts` › Web Push
- [x] v0-1-canary.9 Limits and upkeep: per-provider workpools, per-device fuse, burst breaker, prune cron — check: `example.test.ts` › cancel, scrub and prune

## real-device-smoke

**Goal:** Prove delivery to real devices, which v0.1 has not done.

**Exit criteria:** each item reaches a real device and `status` shows `sent`.
Needs real Apple and Google credentials and test devices (owner).

- [ ] real-device-smoke.1 APNs sandbox and production: one iPhone buzzes from a mounted component — check: `status` shows `sent` with an `apns-id`
- [ ] real-device-smoke.2 APNs token churn: 200 sends over 30 minutes with one cached token, no `TooManyProviderTokenUpdates` — check: no such code in `status`
- [ ] real-device-smoke.3 FCM: one Android phone — check: `status` shows `sent`
- [ ] real-device-smoke.4 Web Push: Chrome, Firefox, Safari and one iPhone Home Screen web app — check: notification shown, `status` `sent`
- [ ] real-device-smoke.5 Repeat .1 on hosted Convex and on a self-hosted backend — check: same as .1
- [ ] real-device-smoke.6 UnifiedPush: one real device before it is listed as supported — check: `status` `sent`

## load-check

**Goal:** Measure workpool cost and confirm the concurrency cap holds.

- [ ] load-check.1 1,000 queued deliveries respect `maxParallelism` and leave nothing queued — check: script against a dev deployment, all deliveries final
- [ ] load-check.2 Record writes per delivery (component + workpool rows) in the spec — check: numbers in spec

## first-adopter

**Goal:** One real app sends through the component (Rule of Three: the owner
names the first adopter and a likely second).

- [ ] first-adopter.1 Wire one real send path in the first adopting app — check: a reply reaches a phone; `status` shows `sent`
- [x] first-adopter.2 Canary publishing on, from every push to `main` — check: `npm view @vllnt/convex-push@canary`

## Later

Waits for a named consumer or a failed check.

- Host Node sender (`./node` entry, `node:http2`) — only if APNs over `fetch`
  fails on hosted Convex (design fallback B).
- Several deliveries per action — only if `load-check` shows the per-job cost
  matters.
- WNS, ADM, HMS, Live Activities, VoIP, Wallet — through a custom provider until
  a consumer asks for a built-in one.
- Per-tenant keys at runtime — waits for a vault component.
