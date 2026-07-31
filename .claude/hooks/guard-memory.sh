#!/usr/bin/env bash
# PreToolUse/Bash guard — refuse memory-exhausting test/build commands on hosts
# that cannot survive them.
#
# Why this exists: a full `vitest run` spawns one worker per CPU, each with its
# own V8 heap; `tsc --noEmit` over this project and `next build` are similarly
# hungry. On a 4 GiB box (the claude-audit LXC) any of them OOM-freezes the
# host hard enough to need a reset. Prose in CLAUDE.md did not prevent this
# three times over, so it is enforced here instead.
#
# The guard is host-aware and silent where it isn't needed:
#   MemTotal     < 8 GiB  -> this host can never run the full thing
#   MemAvailable < 4 GiB  -> this host is too loaded right now
# On a normal workstation both checks pass and the hook never fires.
#
# Exit 0 always: deny is expressed via permissionDecision JSON, never via a
# nonzero exit (which would surface as a broken hook rather than a decision).

set -uo pipefail

payload=$(cat)
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0

danger=""
fix=""

# vitest with no worker cap = one full heap per CPU
if printf '%s' "$cmd" | grep -qE '(^|[^a-zA-Z-])vitest'; then
  if ! printf '%s' "$cmd" | grep -qE -- '--(maxWorkers|pool=forks|poolOptions)'; then
    danger="vitest without a worker cap"
    fix='npx vitest run <one-file> --pool=forks --maxWorkers=1'
  fi
fi

# npm test / npm run test -> the whole vitest suite
if printf '%s' "$cmd" | grep -qE '(^|&&|;|\|)[[:space:]]*npm[[:space:]]+(run[[:space:]]+)?test([[:space:]]|$)'; then
  danger="npm test (runs the full vitest suite)"
  fix='npx vitest run <one-file> --pool=forks --maxWorkers=1'
fi

# project-wide tsc with no heap cap
if printf '%s' "$cmd" | grep -qE '(^|[^a-zA-Z-])tsc([[:space:]]|$)'; then
  if ! printf '%s' "$cmd" | grep -q -- '--max-old-space-size'; then
    danger="tsc without --max-old-space-size"
    fix='npx tsc --noEmit --max-old-space-size=900 <explicit files>'
  fi
fi

# full Next.js build
if printf '%s' "$cmd" | grep -qE '(next[[:space:]]+build|npm[[:space:]]+run[[:space:]]+build)'; then
  danger="a full Next.js build"
  fix='build on a bigger host — this one cannot'
fi

[ -z "$danger" ] && exit 0

# Not Linux, or no /proc — don't guess, let it through.
[ -r /proc/meminfo ] || exit 0

mem_total_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
mem_avail_kb=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)

[ -z "$mem_total_kb" ] && exit 0
[ -z "$mem_avail_kb" ] && exit 0

small_host=$(( mem_total_kb < 8388608 ))  # < 8 GiB total
low_now=$(( mem_avail_kb < 4194304 ))     # < 4 GiB available

# Plenty of headroom — this hook has no opinion.
if [ "$small_host" -eq 0 ] && [ "$low_now" -eq 0 ]; then
  exit 0
fi

total_gb=$(awk -v k="$mem_total_kb" 'BEGIN{printf "%.1f", k/1048576}')
avail_gb=$(awk -v k="$mem_avail_kb" 'BEGIN{printf "%.1f", k/1048576}')

reason="Blocked: ${danger}.

Host has ${total_gb} GiB total / ${avail_gb} GiB available. Commands of this shape
OOM-freeze small hosts hard enough to need a reset.

Scoped alternative:
  ${fix}

Full suites and full builds belong on a bigger host (CT 999), not here.
See docs/rewrite-goals.md, Phase 0."

jq -nc --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
exit 0
