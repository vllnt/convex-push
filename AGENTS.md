# @vllnt/convex-push

Push notifications sent straight from a Convex backend to APNs, FCM HTTP v1 and
Web Push, as a sandboxed Convex component: device registry, durable send queue,
retries, dead-device cleanup and encrypted provider-token cache. No relay
service.

A sandboxed Convex component following the vllnt Component Standard.

## Agent instructions

`AGENTS.md` is the sole agent-instruction source for this repository. Do not add
`CLAUDE.md` or `.claude` content.

## Architecture

```
src/
├── shared.ts                  # constants, limits, defaults, error code lists (no Convex imports)
├── test.ts                    # convex-test register() helper (component + 4 workpools + rate limiter)
├── client/index.ts            # Push class (consumer API); re-exports validators and types
└── component/
    ├── convex.config.ts       # defineComponent("push", { env }); children: apnsPool, fcmPool, webpushPool, customPool, rateLimiter
    ├── schema.ts              # devices, messages, deliveries, providerTokens
    ├── validators.ts          # every arg/return validator, the custom-sender and hook contracts
    ├── mutations.ts           # register, unregister, setDeviceStatus, send, sendBatch, cancel, prune
    ├── queries.ts             # status, listDevices, listBySubject; internal loadJob, loadToken
    ├── internal_mutations.ts  # onSendComplete (workpool callback), scrub, storeToken, dropToken
    ├── actions.ts             # internal deliver action: load job, send, return the outcome
    ├── crons.ts               # daily prune
    ├── registry.ts            # coded errors, ref and address checks, address hash, device view
    ├── checks.ts              # send input/config checks, function-handle form
    ├── queue.ts               # fan-out, planning, workpool enqueue, outcome handling, hook, scrub
    ├── senders.ts             # dispatch one job to APNs, FCM, Web Push or a custom sender
    ├── crypto/                # Web Crypto only: codec, JWT (ES256/RS256), RFC 8291 encryption, token sealing
    └── providers/             # payload builders, keys from env, HTTP helpers, token cache, apns/fcm/web_push senders
src/testing/                   # test-only, outside src/component so codegen never deploys it:
                               # key fixtures, table dump query, registerForTests (excluded from build and package)
```

## Ownership boundary

- **Component owns:** the four tables; device dedupe, rotation and
  invalidation; fan-out; per-provider queues; retries, expiry and the rate fuse;
  provider signing and token caching; content scrubbing; pruning.
- **Host owns:** auth and the `subjectRef` it passes; which apps exist
  (`apps` map); when to send and to whom; consent, quiet hours and preferences;
  the text; custom senders and the delivery hook (its own code); reading tokens
  from devices in its client apps.
- **Keys:** only from component env bound at mount. Never in arguments, tables,
  return values or logs.

## Key design decisions

- **Plain `fetch` in the default runtime.** Components cannot hold Node
  actions. APNs over HTTP/2 works from a Convex action (see the spec's proof).
- **One workpool per built-in provider** (custom providers share `customPool`).
  A slow or throttled provider cannot starve the others.
  `retryActionsByDefault: false`: the component decides retries from the
  provider's answer, not from a throw. `maxParallelism` is pool-wide: only a
  live send passes it; a retry passes `undefined` so it never rewrites the pool.
- **Transaction budgets.** Each delivery costs several nested component calls,
  so `sendBatch` stops at 100 deliveries, and `prune` deletes about `batch`
  rows (max 1,000) plus up to 100 devices per pass. Numbers come from runs on a
  local backend; `load-check` confirms them on hosted Convex.
- **Scrub in its own transaction.** A finished delivery schedules
  `internal_mutations.scrub`, so recording it does not read its siblings.
- **Retry decision in one place.** `applyOutcome` in `queue.ts` handles every
  result: sent, invalid, failed, retry (attempt limit, expiry).
- **Hook is scheduled, never inline.** A hook that throws cannot undo the
  delivery record.
- **Cached tokens sealed.** AES-256-GCM with an HKDF key from the private key;
  `storeToken` keeps a fresh existing row so concurrent senders converge (Apple
  rejects frequent token changes).
- **`invalid` is reversible.** The next registration restores the device. An APNs
  `BadDeviceToken`/`DeviceTokenNotForTopic` burst per app pauses the app (wrong
  environment), via `@convex-dev/rate-limiter`.
- **Deliveries record the subject.** A device reassigned after enqueue ends
  `DEVICE_REASSIGNED` instead of receiving the old subject's message.
- **Outbound requests stay put.** `providerFetch` never follows redirects; Web
  Push endpoints must pass `isPublicHttpsUrl` (`registry.ts`).
- **Addresses never leave the component** except in the send action
  (`loadJob` is internal).

## Front-end tooling analysis

Backend-only, no user-facing surface in v0.1. Usage: sends happen from host
mutations; the only reactive read is `status`, which the host re-exports behind
its own auth. Device tokens come from platform SDKs (APNs, FCM, Expo,
`pushManager.subscribe`), not from this package. The official
`@convex-dev/expo-push-notifications` ships no client layer either. Re-run when
a consumer asks for a web subscription helper.

## Conventions

- Mutations in `mutations.ts`, queries in `queries.ts`, internal mutations in
  `internal_mutations.ts`, actions in `actions.ts` (enforced by
  `@vllnt/eslint-config/convex`).
- Explicit `args` + `returns` on every Convex function.
- Thrown errors are `ConvexError({ code, message })` with a code from
  `ERROR_CODES`. Delivery codes come from `DELIVERY_ERROR_CODES` or the provider.
- Logs carry ids, platforms, statuses and codes only (`@vllnt/logger`).
- No `as` assertions, no `any`, TSDoc on exports.
- 100% test coverage is BLOCKING (`vitest.config.mts` thresholds).
- Runtime deps: `@convex-dev/workpool`, `@convex-dev/rate-limiter`,
  `@vllnt/logger`, and `convex-helpers` (a required peer of workpool).
- Tests generate keys at run time (`src/testing/fixtures.ts`). Never
  commit a key, token or real-looking credential.
- Provider calls are tested against recorded response shapes with `fetch`
  stubbed. No test sends to a real provider.
- Never put test helpers under `src/component/` (only `*.test.ts` files): Convex
  codegen treats every other file there as a component module and deploys it. `pnpm test:package` fails if
  any `testing/` path ships.

## Generated code

- Every `**/_generated/**` file is owned exclusively by Convex CLI codegen.
- Never create, edit, lint, or format generated files manually.
- Run `pnpm codegen` to regenerate them and commit the generated output
  unchanged. Without a Convex project, `CONVEX_AGENT_MODE=anonymous npx convex
  dev --once` runs codegen against a local backend.

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:coverage
```

## Docs sync (MANDATORY)

When any of these change, update the matching docs in the SAME commit (then
`pnpm generate:llms`):

| Change | Update |
|--------|--------|
| Client method args or return types | `docs/API.md`, README Usage |
| Schema table added/removed/modified | this file (Architecture), `specs/active/` |
| Child component added/removed | README, this file (Architecture) |
| Provider answer handling | `docs/API.md` Provider answers |
| Error codes | `src/shared.ts` lists, `docs/API.md` Errors |
| Custom-sender or hook contract | README Extending it, `docs/API.md`, `CHANGELOG.md` (breaking) |
| New feature / breaking change | `CHANGELOG.md`, README Features |
| Security model | README Security, `docs/API.md` Security model |
| `peerDependencies.convex` range | `llms.txt` context line, `docs/API.md` Compatibility line |
