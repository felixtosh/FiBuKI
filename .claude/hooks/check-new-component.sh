#!/usr/bin/env bash
# PreToolUse/Write guard: before a NEW component file under components/ is
# written, show the components that already exist and ask once whether one of
# them should be extended instead.
#
# Why: components were duplicated (filter-primitives.tsx next to ChoiceFilter,
# hand-made chips next to Pill) and the design system drifted. A script cannot
# tell that a new StatusChip is a Pill in disguise; the agent writing it can,
# if it sees the list at the moment it creates the file.
#
# The first Write of a given new file in a session is denied with the list
# (title, file, layer, one-line purpose, from the *.examples.tsx files via
# scripts/check-design-system.mjs --list). Writing the same file again goes
# through, so a deliberate new component costs one retry, never a dead end.
# Edits to existing files, examples files and tests are never stopped.
#
# Exit 0 always: deny is expressed via permissionDecision JSON, as in
# guard-memory.sh.

set -uo pipefail

payload=$(cat)
file=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
session=$(printf '%s' "$payload" | jq -r '.session_id // "none"' 2>/dev/null)

case "$file" in
  */components/*.tsx) ;;
  *) exit 0 ;;
esac
case "$file" in
  *.examples.tsx | *.test.tsx) exit 0 ;;
esac
[ -e "$file" ] && exit 0

# Asked once per file per session; the second attempt is the answer.
marker_dir="${TMPDIR:-/tmp}/fibuki-new-component"
mkdir -p "$marker_dir" 2>/dev/null
marker="$marker_dir/$(printf '%s:%s' "$session" "$file" | shasum | cut -c1-16)"
if [ -e "$marker" ]; then
  exit 0
fi
touch "$marker" 2>/dev/null

root="${file%%/components/*}"
[ -f "$root/scripts/check-design-system.mjs" ] || root="${CLAUDE_PROJECT_DIR:-.}"
list=$(node "$root/scripts/check-design-system.mjs" --list 2>/dev/null)

reason="New component file: ${file#"$root"/}

Before writing it, check whether one of the existing components/ui components already does this job. If one fits, extend it (a variant or a prop) instead of creating a new file. If the new one is a near-copy of a component in a feature folder, move that one to components/ui and reuse it.

Existing components (title, file, layer: purpose):
$list

If none fits, write the same file again and it will go through. A new file in components/ui/ also needs a <name>.examples.tsx next to it and an import in app/(dashboard)/design-system/registry.ts, or CI fails (npm run lint:design-system)."

jq -nc --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
exit 0
