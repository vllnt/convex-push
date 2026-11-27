#!/usr/bin/env bash
#
# test-first-canary-publish.sh — guard, dry-run, publish and trust paths of
# first-canary-publish.sh in a throwaway repo. npm and pnpm are stubs that
# record their arguments, so nothing reaches a registry.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ORIGIN="$WORK/origin.git"
REPO="$WORK/repo"
BIN="$WORK/bin"
LOG="$WORK/calls.log"
mkdir -p "$BIN"

cat > "$BIN/npm" <<'STUB'
#!/usr/bin/env bash
echo "npm $*" >> "$CALLS_LOG"
case "$1" in
  --version) echo "${FAKE_NPM_VERSION:-11.19.1}" ;;
  view)
    if [[ "$2" == *@canary ]]; then cat "$CALLS_LOG.version" 2>/dev/null; exit 0; fi
    if [[ -n "${FAKE_NPM_DOWN:-}" ]]; then echo "npm error code ECONNRESET" >&2; exit 1; fi
    if [[ -n "${FAKE_PUBLISHED:-}" ]]; then echo "$2"; exit 0; fi
    echo "npm error code E404" >&2
    exit 1
    ;;
  trust) [[ "$2" == github && -n "${FAKE_TRUST_FAIL:-}" ]] && exit 1 ;;
  whoami) [[ -z "${FAKE_LOGGED_OUT:-}" ]] && echo maintainer || exit 1 ;;
  version)
    echo "$2" > "$CALLS_LOG.version"
    node -e "const f=require('fs');const p=JSON.parse(f.readFileSync('package.json','utf8'));p.version=process.argv[1];f.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')" "$2"
    ;;
  publish)
    grep -q '"version": "0.1.0-canary' package.json || { echo "unstamped" >&2; exit 1; }
    [[ -z "${FAKE_PUBLISH_FAIL:-}" ]] || exit 1
    ;;
esac
exit 0
STUB
cat > "$BIN/pnpm" <<'STUB'
#!/usr/bin/env bash
echo "pnpm $*" >> "$CALLS_LOG"
[[ "$1" != "${FAKE_FAIL_PNPM:-}" ]]
STUB
chmod +x "$BIN/npm" "$BIN/pnpm"

git init -q --bare -b main "$ORIGIN"
git clone -q "$ORIGIN" "$REPO" 2>/dev/null
git -C "$REPO" config user.email test@example.invalid
git -C "$REPO" config user.name test
git -C "$REPO" config commit.gpgsign false
git -C "$REPO" checkout -q -b main
mkdir -p "$REPO/scripts" "$REPO/.github/workflows"
cp "$ROOT/scripts/first-canary-publish.sh" "$REPO/scripts/"
printf 'echo "contents $*" >> "$CALLS_LOG"\n' > "$REPO/scripts/check-package-contents.sh"
printf 'name: Publish\n' > "$REPO/.github/workflows/publish.yml"
cat > "$REPO/package.json" <<'JSON'
{
  "name": "@example/pkg",
  "version": "0.1.0",
  "repository": { "type": "git", "url": "https://github.com/example/pkg" }
}
JSON
git -C "$REPO" add -A
git -C "$REPO" commit -q -m fixture
git -C "$REPO" push -q origin main 2>/dev/null
SHA="$(git -C "$REPO" rev-parse --short=7 HEAD)"

failures=0
OUT=""
STATUS=0

run() {
  : > "$LOG"
  rm -f "$LOG.version"
  OUT="$(cd "$REPO" && env PATH="$BIN:$PATH" CALLS_LOG="$LOG" "$@" bash scripts/first-canary-publish.sh "${MODE_ARG[@]}" 2>&1)"
  STATUS=$?
}

expect() {
  local name="$1" status="$2" needle="$3"
  if [[ "$STATUS" -ne "$status" ]] || ! grep -qF -- "$needle" <<<"$OUT$(cat "$LOG")"; then
    echo "FAIL: $name (status $STATUS, wanted $status and '$needle')"
    printf '%s\n' "$OUT" | tail -5
    failures=$((failures + 1))
  else
    echo "ok: $name"
  fi
}

refute_call() {
  local name="$1" needle="$2"
  if grep -qF -- "$needle" "$LOG"; then
    echo "FAIL: $name (unexpected call '$needle')"
    failures=$((failures + 1))
  else
    echo "ok: $name"
  fi
}

clean_tree() {
  if [[ -n "$(git -C "$REPO" status --porcelain)" ]]; then
    echo "FAIL: $1 (package.json not restored)"
    failures=$((failures + 1))
  else
    echo "ok: $1"
  fi
}

MODE_ARG=(--bogus)
run
expect "unknown option is misuse" 2 "unknown option"

MODE_ARG=()
run
expect "dry run stamps the canary version" 0 "npm version 0.1.0-canary.$SHA --no-git-tag-version --ignore-scripts"
for gate in "pnpm install --frozen-lockfile" "pnpm lint" "pnpm typecheck:ci" "pnpm test:coverage" "pnpm build"; do
  expect "dry run runs $gate" 0 "$gate"
done
expect "dry run checks package contents" 0 "contents"
expect "dry run uses npm publish --dry-run" 0 "npm publish --dry-run --tag canary --access public --ignore-scripts"
refute_call "dry run needs no login" "npm whoami"
refute_call "dry run links no publisher" "npm trust"
clean_tree "dry run restores package.json"

MODE_ARG=(--publish)
run
expect "publish publishes on the canary tag" 0 "npm publish --tag canary --access public --ignore-scripts"
expect "publish links the trusted publisher" 0 "npm trust github @example/pkg --repo example/pkg --file publish.yml --allow-publish --yes"
expect "publish prints the next step" 0 "gh variable set CANARY_ENABLED --body true --repo example/pkg"
refute_call "publish never dry-runs" "--dry-run"
clean_tree "publish restores package.json"

run FAKE_FAIL_PNPM=lint
expect "a failing gate stops the run" 1 "pnpm lint"
refute_call "no stamp after a failing gate" "npm version"
refute_call "no publish after a failing gate" "npm publish"

run FAKE_PUBLISH_FAIL=1
expect "a failed publish exits non-zero" 1 "npm publish --tag canary"
refute_call "no trust link after a failed publish" "npm trust"
clean_tree "a failed publish restores package.json"

run FAKE_TRUST_FAIL=1
expect "a failed trust link names the recovery step" 1 "published @example/pkg@0.1.0-canary.$SHA, but linking the trusted publisher failed"
expect "the recovery step is --trust" 1 "first-canary-publish.sh --trust"
clean_tree "a failed trust link leaves package.json restored"

run FAKE_NPM_DOWN=1
expect "a registry error is not read as a free name" 1 "could not ask npm"
refute_call "no publish when npm is unreachable" "npm publish"

run FAKE_LOGGED_OUT=1
expect "publish needs an npm login" 1 "not logged in to npm"
refute_call "no publish without a login" "npm publish"

run FAKE_PUBLISHED=0.1.0-canary.abc1234
expect "publish refuses a claimed name" 1 "already on npm"
refute_call "no publish for a claimed name" "npm publish"

run FAKE_NPM_VERSION=11.5.1
expect "old npm is refused" 1 "too old"

MODE_ARG=(--trust)
run FAKE_PUBLISHED=0.1.0-canary.abc1234
expect "trust links an existing package" 0 "npm trust github @example/pkg --repo example/pkg --file publish.yml --allow-publish --yes"
refute_call "trust publishes nothing" "npm publish"

run
expect "trust needs a published package" 1 "not on npm yet"

run FAKE_PUBLISHED=0.1.0-canary.abc1234 FAKE_TRUST_FAIL=1
expect "a failed --trust names the retry" 1 "first-canary-publish.sh --trust"

MODE_ARG=()
printf 'x\n' > "$REPO/stray.txt"
run
expect "dirty tree is refused" 1 "working tree has changes"
rm "$REPO/stray.txt"

git -C "$REPO" checkout -q -b feature
run
expect "a branch other than main is refused" 1 "run this on main"
git -C "$REPO" checkout -q main

git -C "$REPO" commit -q --allow-empty -m ahead
run
expect "main ahead of origin is refused" 1 "not origin/main"

if [[ "$failures" -gt 0 ]]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "all passed"
