#!/usr/bin/env bash
#
# first-canary-publish.sh — claim the npm name with one manual canary, then
# link the trusted publisher so every later publish runs tokenless from
# .github/workflows/publish.yml.
#
# npm can only attach a trusted publisher to a package that already exists,
# so the very first version has to come from a maintainer's own npm login.
# Run this once, from a clean checkout of main, after the PR that adds it is
# merged.
#
# Usage: bash scripts/first-canary-publish.sh [--dry-run|--publish|--trust]
#   --dry-run  (default) every check, the version stamp and
#              `npm publish --dry-run`; nothing is published (it still
#              reads from git, npm and the pnpm store).
#   --publish  publish {version}-canary.{sha7} on the canary dist-tag, then
#              link the trusted publisher (same as --trust).
#   --trust    only link the trusted publisher, for a package that already
#              exists (use it if --publish stopped after the publish).
#
# Needs npm >= 11.15.0 (for `npm trust`), an npm login with 2FA and write
# access to the scope; a granular token that bypasses 2FA cannot run
# `npm trust`. npm asks for a one-time password when it needs one.
#
# Exit codes: 0 done, 1 a check failed, 2 misuse.

set -euo pipefail

WORKFLOW_FILE="publish.yml"
MIN_NPM="11.15.0"

MODE="dry-run"
case "${1:-}" in
  "" | --dry-run) MODE="dry-run" ;;
  --publish) MODE="publish" ;;
  --trust) MODE="trust" ;;
  -h | --help)
    sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "error: unknown option $1 (use --dry-run, --publish or --trust)" >&2
    exit 2
    ;;
esac

fail() {
  echo "error: $*" >&2
  exit 1
}

step() {
  printf '\n==> %s\n' "$*"
}

ROOT="$(git rev-parse --show-toplevel)" || exit 2
cd "$ROOT"

PKG="$(node -p "require('./package.json').name")"
BASE="$(node -p "require('./package.json').version")"
REPO_URL="$(node -p "(require('./package.json').repository || {}).url || ''")"
REPO="$(printf '%s' "$REPO_URL" | sed -E 's#^(git\+)?https://github\.com/##; s#\.git$##')"
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || fail "package.json repository.url must be https://github.com/<owner>/<repo>"
[[ -f ".github/workflows/$WORKFLOW_FILE" ]] || fail ".github/workflows/$WORKFLOW_FILE is missing"

step "Checking the checkout"
[[ -z "$(git status --porcelain)" ]] || fail "the working tree has changes; commit or remove them first"
BRANCH="$(git branch --show-current)"
[[ "$BRANCH" == "main" ]] || fail "run this on main (current: ${BRANCH:-detached HEAD})"
git fetch --quiet origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] \
  || fail "local main is not origin/main; run git pull --ff-only first"

step "Checking npm"
NPM_VERSION="$(npm --version)"
[[ "$(printf '%s\n%s\n' "$MIN_NPM" "$NPM_VERSION" | sort -V | head -1)" == "$MIN_NPM" ]] \
  || fail "npm $NPM_VERSION is too old; npm trust needs $MIN_NPM or newer (npm install -g npm@^$MIN_NPM)"

registry_name() {
  local out
  if out="$(npm view "$1" name 2>&1)"; then
    printf '%s' "$out"
  elif ! grep -q "E404" <<<"$out"; then
    fail "could not ask npm about $1: $(tail -1 <<<"$out")"
  fi
}

PUBLISHED="$(registry_name "$PKG")"
if [[ "$MODE" == "trust" ]]; then
  [[ -n "$PUBLISHED" ]] || fail "$PKG is not on npm yet; run --publish instead"
else
  [[ -z "$PUBLISHED" ]] \
    || fail "$PKG is already on npm; the name is claimed, so publish through $WORKFLOW_FILE (or run --trust)"
fi

if [[ "$MODE" != "dry-run" ]]; then
  WHO="$(npm whoami 2>/dev/null)" || fail "not logged in to npm; run npm login first"
  echo "npm user: $WHO"
fi

link_trust() {
  step "Linking the trusted publisher: $REPO, workflow $WORKFLOW_FILE"
  npm trust github "$PKG" --repo "$REPO" --file "$WORKFLOW_FILE" --allow-publish --yes \
    || fail "${1:-}linking the trusted publisher failed; fix the npm login (2FA, no bypass-2FA token), then run: bash scripts/first-canary-publish.sh --trust"
  npm trust list "$PKG"
}

if [[ "$MODE" == "trust" ]]; then
  link_trust
else
  step "Running the quality gates"
  pnpm install --frozen-lockfile
  pnpm lint
  pnpm typecheck:ci
  pnpm test:coverage
  pnpm build
  bash scripts/check-package-contents.sh

  SHA="$(git rev-parse HEAD)"
  STAMP="${BASE}-canary.${SHA:0:7}"
  step "Stamping $PKG@$STAMP (package.json is restored on exit)"
  trap 'git checkout --quiet -- package.json' EXIT
  npm version "$STAMP" --no-git-tag-version --ignore-scripts
  VERSION="$(node -p "require('./package.json').version")"

  if [[ "$MODE" == "dry-run" ]]; then
    step "Dry run: npm publish --dry-run"
    npm publish --dry-run --tag canary --access public --ignore-scripts
    printf '\nDry run passed. Nothing was published. Next: bash scripts/first-canary-publish.sh --publish\n'
    exit 0
  fi

  step "Publishing $PKG@$VERSION on the canary dist-tag"
  npm publish --tag canary --access public --ignore-scripts
  git checkout --quiet -- package.json
  trap - EXIT

  link_trust "published $PKG@$VERSION, but "
  [[ "$(npm view "$PKG@canary" version 2>/dev/null || true)" == "$VERSION" ]] \
    || echo "warning: npm does not show $VERSION on @canary yet; check again in a minute" >&2
fi

printf '\nDone. Turn on canary publishing from CI with:\n  gh variable set CANARY_ENABLED --body true --repo %s\n' "$REPO"
