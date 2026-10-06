#!/usr/bin/env bash
# Replay one PR against the accounts on this box (docs/replay.md).
#
#   replay.sh <pr-number> <head-sha> <base-sha>
#
# Expects, under /opt/fibuki-replay (outside /opt/fibuki, which the deploy
# rsyncs with --delete):
#
#   accounts              one account per line: <uid> <label> [months]
#   src/<pr>/head/functions   the PR's functions/ tree (rsynced by the workflow)
#   src/<pr>/base/functions   the base commit's functions/ tree
#
# and writes reports/<pr>/<uid>.md and <uid>.json (the diff), plus
# reports/<pr>/summary.json, which the workflow turns into the PR comment and
# /admin/replay lists. The sets are exported fresh on every run through the
# running fibuki-api container (read-only), so a report always reflects the
# account as it is today. The sheets are built in throwaway node containers
# with no DATABASE_URL, so a set never reaches a deployment.
#
# Prints REPLAY_SUMMARY=<json> as its last line. Exit 0 whatever the verdict:
# the verdict is the comment, not a failed check.

set -euo pipefail

PR="${1:?pr number}"
HEAD_SHA="${2:?head sha}"
BASE_SHA="${3:?base sha}"
[[ "$PR" =~ ^[0-9]+$ ]] || { echo "pr number must be digits" >&2; exit 2; }

ROOT=/opt/fibuki-replay
ACCOUNTS="$ROOT/accounts"
SRC="$ROOT/src/$PR"
SETS="$ROOT/sets"
OUT="$ROOT/reports/$PR"
COMPOSE_DIR=/opt/fibuki/deploy/selfhost
NODE_IMAGE=node:22-slim

[[ -f "$ACCOUNTS" ]] || { echo "no accounts file at $ACCOUNTS" >&2; exit 2; }
[[ -d "$SRC/head/functions" && -d "$SRC/base/functions" ]] || { echo "missing $SRC/{head,base}/functions" >&2; exit 2; }
mkdir -p "$SETS" "$OUT"
chmod 700 "$ROOT" "$SETS"

compose() {
  docker compose -f "$COMPOSE_DIR/docker-compose.yml" -f "$COMPOSE_DIR/docker-compose.prod.yml" \
    --env-file "$COMPOSE_DIR/.env" "$@"
}

# One sheet: the given side's functions/ tree, deps installed into the tree
# (cached npm store in a named volume), the set mounted read-only, no database.
sheet() {
  local side="$1" uid="$2" label="$3"
  docker run --rm \
    -e DATABASE_URL= -e NODE_ENV=development \
    -v "$SRC/$side/functions:/work" \
    -v fibuki-replay-npm:/root/.npm \
    -v "$SETS:/sets:ro" -v "$OUT:/out" \
    -w /work "$NODE_IMAGE" sh -euc "
      npm ci --no-audit --no-fund --prefer-offline > /dev/null
      npm run -s selfhost:replay -- sheet --set /sets/$uid.replay-set.json --out /out/$uid.$side.sheet.json --label '$label'
    "
}

echo "replay PR #$PR: head $HEAD_SHA, base $BASE_SHA"
while read -r uid label months; do
  [[ -z "$uid" || "$uid" == \#* ]] && continue
  months="${months:-12}"
  echo "== $label ($uid), last $months months"

  compose exec -T fibuki-api npm run -s selfhost:replay -- export \
    --user "$uid" --label "$label" --months "$months" --out "/tmp/$uid.replay-set.json"
  compose cp "fibuki-api:/tmp/$uid.replay-set.json" "$SETS/$uid.replay-set.json"
  compose exec -T fibuki-api rm -f "/tmp/$uid.replay-set.json"
  chmod 600 "$SETS/$uid.replay-set.json"

  sheet base "$uid" "main@${BASE_SHA:0:7}"
  sheet head "$uid" "PR #$PR@${HEAD_SHA:0:7}"

  # The diff's exit code 1 means a ❌ row; that is the report's job to say.
  docker run --rm -v "$SRC/head/functions:/work" -v "$OUT:/out" -w /work "$NODE_IMAGE" \
    sh -c "npm run -s selfhost:replay -- diff /out/$uid.base.sheet.json /out/$uid.head.sheet.json --md /out/$uid.md --json /out/$uid.json > /dev/null" \
    || true
  rm -f "$OUT/$uid.base.sheet.json" "$OUT/$uid.head.sheet.json"
done < "$ACCOUNTS"

# One summary for the PR comment and the admin page: counts per account, no rows.
export PR HEAD_SHA BASE_SHA
summary=$(docker run --rm -e PR -e HEAD_SHA -e BASE_SHA -v "$OUT:/out" -w /out "$NODE_IMAGE" node -e '
  const fs = require("fs");
  const accounts = fs.readdirSync(".").filter((f) => f.endsWith(".json") && f !== "summary.json").map((f) => {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    return {
      uid: f.slice(0, -5), label: d.head.setLabel, builtAt: d.head.builtAt,
      head: d.head.gitSha, base: d.base.gitSha,
      files: { total: d.files.total, changed: d.files.rows.length },
      transactions: { total: d.transactions.total, changed: d.transactions.rows.length },
      counts: d.counts,
    };
  });
  const summary = { pr: Number(process.env.PR), head: process.env.HEAD_SHA, base: process.env.BASE_SHA, ranAt: new Date().toISOString(), accounts };
  fs.writeFileSync("summary.json", JSON.stringify(summary, null, 1));
  process.stdout.write(JSON.stringify(summary));
')
echo "REPLAY_SUMMARY=$summary"
