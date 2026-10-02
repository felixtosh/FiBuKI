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
# What counts is a command that RUNS the tool: the word in command position
# (start of a line, or after && || ; | & ( $( or a backtick), past any env
# assignments, wrappers (sudo, env, time, timeout, xargs, sh -c) and runners
# (npx, npm exec, pnpm, yarn, bunx, node). The word as an argument
# (`grep vitest`, `ls vitest*`, `cat vitest.config.ts`) is not a run.
# Separators inside quotes still split, so a quoted `; npx vitest` in a commit
# message is blocked: wrong in the safe direction.
#
# The guard is host-aware and silent where it isn't needed:
#   MemTotal    <= 8 GiB  -> this host can never run the full thing
#   MemAvailable < 4 GiB  -> this host is too loaded right now
# On a normal workstation both checks pass and the hook never fires.
# GUARD_MEMORY_ASSUME_SMALL_HOST=1 skips the host check (for the tests; it can
# only make the guard stricter).
#
# Cases: guard-memory.test.sh beside this file.
#
# Exit 0 always: deny is expressed via permissionDecision JSON, never via a
# nonzero exit (which would surface as a broken hook rather than a decision).

set -uo pipefail

payload=$(cat)
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0

q="'"
ws='[[:space:]]'
word='[^[:space:]]+'
# Ends a command word: whitespace, a closing quote, or end of segment.
end="([[:space:]\"$q]|\$)"

# One leading wrapper, env assignment or runner; stripped repeatedly.
prefix="^$ws*(\\{|!|if|then|else|elif|do|while|until"
prefix+="|[A-Za-z_][A-Za-z0-9_]*=(\"[^\"]*\"|$q[^$q]*$q|[^[:space:]]*)"
prefix+="|sudo($ws+-$word)*|env($ws+-$word)*|time|nohup|setsid|exec|command"
prefix+="|nice($ws+-n$ws*-?[0-9]+|$ws+-[0-9]+)?"
prefix+="|timeout($ws+-$word)*$ws+[0-9.]+[smhd]?"
prefix+="|xargs($ws+-$word)*"
prefix+="|(ba|z|da)?sh$ws+-[A-Za-z]*c"
prefix+="|npx($ws+(-y|--yes|--no-install|-p$ws+$word|--package[=[:space:]]$word))*"
prefix+="|npm$ws+(exec|x)($ws+--)?|pnpm($ws+(exec|dlx))?|yarn($ws+(exec|dlx))?|bunx"
prefix+="|node($ws+-$word)*"
prefix+=")$ws+[\"$q]?"

# npm and its global options, up to the subcommand.
npm_opts="^npm($ws+(--prefix|-C|--workspace|-w)[=[:space:]]$word|$ws+-$word)*$ws+"

is_vitest="^([^[:space:]]*/)?vitest(\\.m?js)?$end"
is_npm_test="${npm_opts}(run(-script)?$ws+test|test|tst|t)$end"
is_tsc="^([^[:space:]]*/)?tsc$end"
is_next_build="^([^[:space:]]*/)?next$ws+build$end"
is_npm_build="${npm_opts}run(-script)?$ws+build"

# Split into command-position segments. Redirections (2>&1, &>) are not
# separators, and a backslash-newline continues the line.
segments=$(printf '%s\n' "$cmd" | awk '
  { buf = buf $0 "\n" }
  END {
    gsub(/\\\n/, " ", buf)
    gsub(/[<>]&|&>/, ">", buf)
    gsub(/&&|\|\||[;|&(`]/, "\n", buf)
    printf "%s", buf
  }')

ran_vitest=0 ran_npm_test=0 ran_tsc=0 ran_build=0
while IFS= read -r seg; do
  while [[ $seg =~ $prefix ]]; do
    seg=${seg:${#BASH_REMATCH[0]}}
  done
  seg=${seg#"${seg%%[![:space:]]*}"}
  [[ $seg =~ $is_vitest ]] && ran_vitest=1
  [[ $seg =~ $is_npm_test ]] && ran_npm_test=1
  [[ $seg =~ $is_tsc ]] && ran_tsc=1
  [[ $seg =~ $is_next_build || $seg =~ $is_npm_build ]] && ran_build=1
done <<< "$segments"

danger=""
fix=""

# vitest with no worker cap = one full heap per CPU
if [ "$ran_vitest" -eq 1 ]; then
  if ! printf '%s' "$cmd" | grep -qE -- '--(maxWorkers|pool=forks|poolOptions)'; then
    danger="vitest without a worker cap"
    fix='npx vitest run <one-file> --pool=forks --maxWorkers=1'
  fi
fi

# npm test / npm run test -> the whole vitest suite
if [ "$ran_npm_test" -eq 1 ]; then
  danger="npm test (runs the full vitest suite)"
  fix='npx vitest run <one-file> --pool=forks --maxWorkers=1'
fi

# project-wide tsc with no heap cap
if [ "$ran_tsc" -eq 1 ]; then
  if ! printf '%s' "$cmd" | grep -q -- '--max-old-space-size'; then
    danger="tsc without --max-old-space-size"
    fix='npx tsc --noEmit --max-old-space-size=900 <explicit files>'
  fi
fi

# full Next.js build
if [ "$ran_build" -eq 1 ]; then
  danger="a full Next.js build"
  fix='build on a bigger host — this one cannot'
fi

[ -z "$danger" ] && exit 0

if [ "${GUARD_MEMORY_ASSUME_SMALL_HOST:-}" = 1 ]; then
  total_gb="?" avail_gb="?"
else
  # Not Linux, or no /proc — don't guess, let it through.
  [ -r /proc/meminfo ] || exit 0

  mem_total_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
  mem_avail_kb=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)

  [ -z "$mem_total_kb" ] && exit 0
  [ -z "$mem_avail_kb" ] && exit 0

  small_host=$(( mem_total_kb <= 8388608 ))  # <= 8 GiB total
  low_now=$(( mem_avail_kb < 4194304 ))     # < 4 GiB available

  # Plenty of headroom — this hook has no opinion.
  if [ "$small_host" -eq 0 ] && [ "$low_now" -eq 0 ]; then
    exit 0
  fi

  total_gb=$(awk -v k="$mem_total_kb" 'BEGIN{printf "%.1f", k/1048576}')
  avail_gb=$(awk -v k="$mem_avail_kb" 'BEGIN{printf "%.1f", k/1048576}')
fi

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
