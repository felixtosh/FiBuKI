#!/usr/bin/env bash
# Cases for guard-memory.sh. Run: bash .claude/hooks/guard-memory.test.sh
# (or pass another hook path as $1, e.g. to compare against an older version).
# Exits nonzero if any case is decided wrong.

set -uo pipefail

hook=${1:-"$(dirname "$0")/guard-memory.sh"}

# Each must be denied: they run a memory-hungry tool without a cap.
block=(
  'vitest'
  'vitest run'
  'npx vitest run'
  'npx vitest run functions/src/foo.test.ts'
  'npx -y vitest run'
  'cd functions && npx vitest run'
  'cd functions; npx vitest run'
  '(cd functions && npx vitest run)'
  'echo $(npx vitest run)'
  'FOO=1 npx vitest run'
  'NODE_OPTIONS="--max-old-space-size=900" npx vitest run'
  'sudo npx vitest run'
  'timeout 600 npx vitest run'
  'time npx vitest run'
  'bash -c "npx vitest run"'
  "sh -c 'cd functions && npx vitest run'"
  './node_modules/.bin/vitest run'
  'node node_modules/vitest/vitest.mjs run'
  'npm exec vitest run'
  'pnpm vitest run'
  'yarn vitest'
  'npx vitest run 2>&1 | tail -20'
  'npx vitest run &'
  $'git status\nnpx vitest run'
  'for f in a b; do npx vitest run $f; done'
  'if true; then npx vitest run; fi'
  'setsid nohup npx vitest run > log 2>&1 &'
  'env -i PATH=/usr/bin npx vitest run'
  'npm test'
  'npm run test'
  'npm t'
  'npm test -- --maxWorkers=1'
  'cd functions && npm test'
  'npm --prefix functions test'
  'npm run test 2>&1 | tail'
  'tsc'
  'tsc --noEmit'
  'npx tsc --noEmit'
  'npx tsc -p functions'
  'cd functions && npx tsc'
  'next build'
  'npx next build'
  'npm run build'
  'npm run build:selfhost'
  'cd functions && npm run build'
)

# Each must pass: the tool name is an argument, or the run is capped.
allow=(
  'ls | grep -i vitest'
  "grep -n 'selfhost' package.json | grep -i test"
  'grep -rn vitest functions/package.json'
  'cat vitest.config.ts'
  'ls vitest*'
  'git log --oneline -- vitest.selfhost.config.ts'
  'rg "npx vitest" docs/'
  'echo use vitest here'
  'grep -n "tsc" package.json'
  'grep "next build" CLAUDE.md'
  'git diff -- docs/ | grep "npm test"'
  'npx vitest run functions/src/foo.test.ts --pool=forks --maxWorkers=1'
  $'npx vitest run functions/src/foo.test.ts \\\n  --maxWorkers=1'
  'cd functions && npx vitest run src/a.test.ts --maxWorkers=1 2>&1 | tail -5'
  'npx tsc --noEmit --max-old-space-size=900 lib/a.ts'
  'node --max-old-space-size=900 node_modules/.bin/tsc --noEmit lib/a.ts'
  # The form CLAUDE.md documents: the cap is a Node flag, the files come from a config
  'NODE_OPTIONS=--max-old-space-size=900 npx tsc --noEmit -p functions/tsconfig.scoped.json'
  'npm run test:node'
  'npm ci'
  'test -f vitest.config.ts && echo yes'
  'git status'
)

fail=0
decide() {
  jq -nc --arg c "$1" '{tool_input: {command: $c}}' \
    | GUARD_MEMORY_ASSUME_SMALL_HOST=1 bash "$hook" \
    | grep -q '"permissionDecision":"deny"' && echo deny || echo allow
}

for c in "${block[@]}"; do
  [ "$(decide "$c")" = deny ] || { echo "FAIL (should block): $c"; fail=1; }
done
for c in "${allow[@]}"; do
  [ "$(decide "$c")" = allow ] || { echo "FAIL (should allow): $c"; fail=1; }
done

total=$(( ${#block[@]} + ${#allow[@]} ))
[ "$fail" -eq 0 ] && echo "ok: $total cases" || exit 1
