# Contributing to @vllnt/convex-push

Thanks for your interest in contributing!

## Development Setup

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Use `pnpm build:codegen` only when you need to regenerate checked-in Convex
`_generated` files and have access to the selected Convex project.

## Testing

Tests use [`convex-test`](https://docs.convex.dev/testing) with the
`@edge-runtime/vm` environment:

```bash
pnpm test          # single run
pnpm test:watch    # watch mode
```

## Code Style

- Prettier + ESLint (run `pnpm lint` before submitting)
- `@vllnt/eslint-config/convex` enforces: namespace separation, snake_case
  filenames, no bare `v.any()`, require returns validators, no N+1 queries
- No `any` — use `unknown` + type guards
- Explicit return types on public APIs
- Mutations in `mutations.ts`, queries in `queries.ts`, validators in
  `validators.ts`

## Pull Requests

- Target `main`
- One logical change per PR
- Include tests for new behavior or bug fixes
- Ensure all checks pass:
  `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

## Releases

Maintainers only. Every publish runs in `.github/workflows/publish.yml` with npm
trusted publishing (no npm token). Provenance is added once the repository is
public; npm rejects it from a private one.

The one exception is the very first version: npm links a trusted publisher only
to a package that already exists, so a maintainer claims the name once by hand.
From a clean, up-to-date `main`, logged in to npm with 2FA:

```bash
bash scripts/first-canary-publish.sh            # every check plus npm publish --dry-run
bash scripts/first-canary-publish.sh --publish  # publish the canary, link publish.yml as trusted publisher
gh variable set CANARY_ENABLED --body true --repo vllnt/convex-push
```

If `--publish` stops after the publish, `--trust` links the trusted publisher
alone. After that, nothing is published from a local machine.

- Canary (`@canary`): every push to `main` that touches the package or its
  shipped docs publishes one while the repository variable `CANARY_ENABLED` is
  `true`. A manual run on `main` publishes only under the same condition.
- Stable (`@latest`): merge a PR that sets `package.json` `version` and adds a
  matching `## [X.Y.Z]` entry to `CHANGELOG.md`, then push the tag `vX.Y.Z` on
  that `main` commit.

## Reporting Issues

Use [GitHub Issues](https://github.com/vllnt/convex-push/issues). For
security vulnerabilities, see [SECURITY.md](./SECURITY.md).
