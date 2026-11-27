# Spec: @vllnt/convex-push v0.1.0 (canary)

**Status:** built, in review. **Date:** 2026-11-27.
**Source:** the convex-push design doc, revision 2 (27 Nov 2026), converted into
this spec, `README.md`, `docs/API.md`, `ROADMAP.md` and `llms.txt`.

## Outcome

A sandboxed Convex component, id `push`, that sends push notifications from a
Convex backend straight to APNs, FCM HTTP v1 and Web Push. It owns the device
registry, the message queue, retries, dead-device cleanup and cached provider
tokens. Hosts extend it with a custom provider, a delivery hook and `rawJson`.

## Definition of done

| Check | Result |
|---|---|
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | green |
| `pnpm test:coverage` | 100% statements, branches, functions, lines |
| Behaviour tests: each sender result, a throw, retry to the limit and to expiry, invalidation, token cache and refresh, size after `rawJson`, a failing hook, a custom provider end to end | `example/convex/example.test.ts`, `src/component/component.test.ts`, `src/component/providers/providers.test.ts` |
| No key, token, content or address stored in plaintext, returned by a query or logged | `example.test.ts` › provider tokens and secrets |
| Crypto against published vectors | `src/component/crypto/crypto.test.ts`, and again in a real Convex runtime (Proof 3) |
| Example app mounts a built-in and a custom provider | `example/convex/convex.config.ts`, `example/convex/example.ts` |

## Proofs

Both open points the design doc names were settled before the build, in a real
Convex runtime: a local backend (`convex` CLI 1.51.0, local backend release
`precompiled-2026-11-21-cf39368`). Re-run on 2026-11-27 with the same results.
No credential was sent: the only provider traffic is a request without a token.

### Proof 1: HTTP/2 to Apple from a Convex action — holds

An action in the default runtime POSTs to `/3/device/00` with no
`authorization` header.

| Caller | Host | Answer |
|---|---|---|
| App action | `api.sandbox.push.apple.com` | `403 {"reason":"MissingProviderToken"}`, `apns-id` header present |
| App action | `api.push.apple.com` | `403 {"reason":"MissingProviderToken"}`, `apns-id` header present |
| Component action, env bound at mount | `api.sandbox.push.apple.com` | `403 {"reason":"MissingProviderToken"}`, component read its env (`envBound: true`) |

Control, from the same machine with curl:

| Request | Answer |
|---|---|
| `curl --http1.1` | no HTTP answer (code 000; APNs refuses HTTP/1.1) |
| `curl --http2` | `403`, `http_version=2` |

APNs answers only over HTTP/2, and a JSON reason with an `apns-id` is an APNs
answer. So the Convex action's `fetch` negotiated HTTP/2 with Apple, from an app
and from inside a component. Design fallback B (a host Node sender) is not
needed on this evidence.

Not covered: hosted Convex (its outbound proxy), Apple's per-connection rules
under Convex's connection pooling, and a signed request reaching a device.

### Proof 2: a component action calls a host function by handle — holds

- Real runtime: a component action received two handles made with
  `createFunctionHandle` in the host, called a host internal action through
  `ctx.runAction(handle)` (returned `"sent:abc"`) and scheduled a host internal
  mutation through its handle.
- In this package, real runtime (Proof 4) and `convex-test`: the component's
  `deliver` action runs the host's `webhookSender` through the stored handle,
  and the component schedules the host's `onDelivery` mutation.

### Proof 3: the crypto runs on Web Crypto in the real runtime — holds

A temporary action in the example app (not committed) imported the package's
crypto modules and returned:

| Check | Result |
|---|---|
| ES256 JWT from a PKCS#8 `.p8` key, verified with the public key | true |
| RS256 JWT from a PKCS#8 service-account key, verified with the public key | true |
| RFC 8291 Appendix A: header and ciphertext byte for byte | true |
| Fresh Web Push encryption decrypted with the browser's key | true |
| HKDF, RFC 5869 test case 1 | true |
| AES-256-GCM, GCM spec test case 16 | true |
| Token seal and open; wrong additional data opens nothing | true |

The same vectors (plus RFC 7515 A.2 RS256 and A.3 ES256, verified with the
published public keys) run in the unit tests.

### Proof 4: a custom provider end to end in the real runtime — holds

The example app was pushed to the local backend with a temporary local HTTP
endpoint standing in for a webhook. `registerDevice` → `send` → workpool →
`deliver` action → host `webhookSender` by handle → `fetch` → `200`. The
delivery ended `sent`, attempt 1, with the endpoint's `x-message-id` as
`providerMessageId`, and the hook recorded one `sent` event.

One more observation: a job that was running when the backend process was
stopped was marked failed by workpool on restart. The component counted it as a
retry (`SENDER_ERROR`) and the second attempt ended `sent`.

## What was not verified

- **Delivery to real devices.** No Apple or Google credentials and no test
  devices were used. Every sender is tested against recorded response shapes
  only. See `ROADMAP.md` › real-device-smoke.
- Hosted Convex and a self-hosted deployment other than the local backend.
- Apple's token-churn behaviour (`TooManyProviderTokenUpdates`) over 30 minutes
  of real sends.
- The cost and concurrency of 1,000 queued deliveries (`ROADMAP.md` ›
  load-check).
- UnifiedPush endpoints (Web Push protocol; not listed as supported).

## Data model

| Table | Fields | Indexes |
|---|---|---|
| `devices` | `subjectRef`, `appRef`, `address`, `addressHash`, `installRef?`, `locale?`, `status`, `invalidCode?`, `lastSeenAt` | `by_address_hash`, `by_subject_status`, `by_install`, `by_status_seen` |
| `messages` | `to`, `title?`, `body?`, `data`, `options`, `overrides?`, `onDeliveryHandle?`, `idempotencyKey?`, `expiresAt`, `scrubbedAt?`, `maxAttempts`, `maxParallelism`, `scrub` | `by_idempotency_key`, `by_subject_created` |
| `deliveries` | `messageId`, `deviceId`, `platform`, `provider?`, `senderHandle?`, `apns?`, `status`, `attempts`, `providerMessageId?`, `errorCode?`, `httpStatus?`, `nextAttemptAt?`, `sentAt?`, `updatedAt` | `by_message`, `by_device_created`, `by_status_updated` |
| `providerTokens` | `credentialRef`, `audience?`, `cipher`, `iv`, `mintedAt`, `refreshAfter`, `expiresAt` | `by_credential_audience` |

Differences from the doc's schema:

- `messages` also stores `maxAttempts`, `maxParallelism` and `scrub`: the
  settings in force when the message was sent, so a retry uses them.
- `deliveries.apns` stores the APNs topic and environment chosen at fan-out.
- The doc's `by_created` index is Convex's built-in `by_creation_time`.

## Decisions assumed (owner to confirm)

The doc's open decisions, built as it recommends:

1. Name `@vllnt/convex-push`, component id `push`.
2. Credentials from component env bound at mount; the custom-provider slot is
   the route for other providers and for an APNs fallback.
3. Providers in v1: APNs, FCM, Web Push. UnifiedPush is not listed as supported
   until a real-device test.
4. One component; registry (`registry.ts`, device mutations) and queue
   (`queue.ts`) in separate modules.
5. Rule of Three: no first adopter is named. The build went ahead on the owner's
   brief; the first adopter and a likely second are still the owner's call.

Defaults and choices the doc marks proposed or leaves open:

- Token reuse: APNs JWT 45 minutes (lifetime 60), Google access token
  `min(50 min, lifetime / 2)`, VAPID JWT 12 hours (signed for 24 hours less one
  minute), per push-service origin.
- Defaults: TTL one day; priority `high` for visible, `normal` for silent;
  5 attempts; 10 sends in parallel per provider; 30-day retention; scrub on.
- Retry: 1 minute doubling to 30 minutes; `Retry-After` honoured (1 s to 1 day);
  APNs 5xx without `Retry-After` waits 15 minutes; 15 s request timeout.
- Rate controls: 60 sends a minute per device (later sends delayed, not
  dropped); more than 20 APNs `BadDeviceToken` per app in 10 minutes pauses that
  app (`APP_PAUSED`); only `BadDeviceToken` counts.
- A silent message is not refused as a whole: its Web Push deliveries fail with
  `SILENT_NOT_SUPPORTED`, the others send.
- `ttlSeconds: 0` means "now or never": the message stays sendable for 30
  seconds, and the providers receive a zero TTL.
- Queries never return device addresses (the doc's views do not list them).
- The custom sender receives `messageId` and `deliveryId` beyond the doc's list,
  so it can pass an idempotency key to its provider.
- Stored function handles must have the `function://` form; a plain function
  name is refused, so a stored value cannot call the component's own functions.
- `convex-helpers` is a runtime dependency because `@convex-dev/workpool` 0.5
  requires it as a peer. Peer `convex@^1.47.0` follows workpool 0.5's peer range.
- `publish.yml` keeps the `CANARY_ENABLED` repository-variable gate (as in
  `convex-email`; the reference no longer has it) so nothing publishes until the
  owner sets it.

## Gaps against the doc

- **Retention for the daily cron.** Cron definitions are static per deployment,
  so the daily prune uses the default 30 days; the client's `retentionMs` applies
  when the host calls `push.prune()`. Options: (a) keep this and document it
  (built); (b) store retention in a component config row written by the client
  on each send; (c) drop the cron and require the host to schedule `prune`.
  Recommendation: (a) until a consumer needs another window, then (b).
- **Real-device smoke tests and the 1,000-delivery load test** from the doc's
  build order are not done (no credentials or devices). They are the next
  roadmap items.

## Package evaluation

| Package | Used | Why |
|---|---|---|
| `@vllnt/eslint-config` | yes | `convex` preset, as the reference |
| `@vllnt/typescript` | yes | shared tsconfig, as the reference |
| `@vllnt/logger` | yes | `createConvexLogger` for structured, content-free logs |
| `@vllnt/testing` | no | not published to npm, and it is a Playwright end-to-end framework; this package has no UI |
| `@vllnt/convex-helpers` | no | host-side auth, cookie and MCP helpers; nothing here needs them |
| `@convex-dev/workpool` | yes | per-provider queues, `runAt` for delayed retries, completion callbacks |
| `@convex-dev/rate-limiter` | yes | per-device fuse and per-app burst breaker |
| `@convex-dev/action-retrier` | no | retries only thrown errors with its own backoff; cannot honour `Retry-After`, message expiry or the four-result contract |

## Front-end tooling

Backend-only, no user-facing surface (analysis in `AGENTS.md`).
