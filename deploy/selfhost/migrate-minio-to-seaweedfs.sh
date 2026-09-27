#!/usr/bin/env bash
#
# One-time migration of the blob store from MinIO to SeaweedFS.
#
# Run this on an existing self-host deployment AFTER pulling the code that
# introduces the `seaweedfs` service, and BEFORE bringing the app up on it:
#
#   git pull                       # or rsync, per README-hetzner.md
#   ./migrate-minio-to-seaweedfs.sh
#   docker compose -f docker-compose.yml -f docker-compose.prod.yml \
#     --env-file .env up -d --build
#
# ## Why this exists
#
# MinIO's server was archived upstream in April 2026 and its images were then
# withdrawn from Docker Hub and quay.io, so the stack moved to SeaweedFS. The
# two speak the same S3 API and the application code is unchanged, but they do
# NOT share a data volume: SeaweedFS starts empty.
#
# Upgrading without this script leaves every uploaded document unreachable.
# Nothing is deleted — the MinIO volume is untouched and the app simply looks
# in the wrong place — but a user sees an account whose Files have all
# vanished, which is indistinguishable from data loss until someone explains it.
#
# ## What it does
#
# Brings up ONLY the seaweedfs service, so compose creates the volume under the
# right project-prefixed name rather than this script guessing it, then mirrors
# the bucket across with the `mc` already inside the MinIO image, and verifies
# the copy before saying so. The app keeps serving from MinIO throughout; it
# switches over on the `up -d` you run afterwards.
#
# Safe to re-run: it refuses to mirror into a destination that already holds
# objects, rather than overwriting a store that may have moved on.
set -euo pipefail

STACK_DIR="${STACK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$STACK_DIR"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

compose() { docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env "$@"; }

command -v docker >/dev/null || die "docker not found"
[[ -f .env ]] || die "no .env in $STACK_DIR"

AK="$(grep -m1 '^FIBUKI_S3_ACCESS_KEY=' .env | cut -d= -f2-)"
SK="$(grep -m1 '^FIBUKI_S3_SECRET_KEY=' .env | cut -d= -f2-)"
BUCKET="$(grep -m1 '^FIBUKI_STORAGE_BUCKET=' .env | cut -d= -f2-)"
[[ -n "$AK" && -n "$SK" && -n "$BUCKET" ]] \
  || die "FIBUKI_S3_ACCESS_KEY / FIBUKI_S3_SECRET_KEY / FIBUKI_STORAGE_BUCKET must all be set in .env"

# --- Preconditions ------------------------------------------------------------
MINIO_ID="$(compose ps -q minio 2>/dev/null || true)"
[[ -n "$MINIO_ID" ]] || die "no running minio service — nothing to migrate from. If this is a fresh install, skip this script."

grep -q 'seaweedfs:' docker-compose.yml \
  || die "this docker-compose.yml has no seaweedfs service — pull the code that introduces it first"

log "source: minio ($(docker inspect "$MINIO_ID" --format '{{.Config.Image}}'))"

# --- Bring up the destination, and only the destination -----------------------
# Only the one service, so the app keeps reading MinIO while the copy runs, and
# so exactly one SeaweedFS process ever touches the volume: two of them fight
# over the filer's leveldb lock and the loser crash-loops.
log "starting seaweedfs (compose creates its volume with the correct project prefix)"
compose up -d seaweedfs >/dev/null

log "waiting for the S3 gateway"
ready=0
for _ in $(seq 1 60); do
  if compose exec -T minio sh -c \
       "mc alias set dst http://seaweedfs:8333 '$AK' '$SK' >/dev/null 2>&1" </dev/null; then
    ready=1; break
  fi
  sleep 2
done
[[ "$ready" -eq 1 ]] || die "seaweedfs did not answer on :8333 — check \`compose logs seaweedfs\`"

# --- Refuse to clobber ---------------------------------------------------------
DST_COUNT="$(compose exec -T minio sh -c "
  mc alias set dst http://seaweedfs:8333 '$AK' '$SK' >/dev/null
  mc ls --recursive dst/$BUCKET 2>/dev/null | wc -l
" </dev/null | tr -d ' \r')"
if [[ "${DST_COUNT:-0}" -gt 0 ]]; then
  die "seaweedfs already holds $DST_COUNT objects in $BUCKET — refusing to mirror over a store that has moved on. Inspect it, and delete the volume only if you are certain."
fi

# --- Mirror --------------------------------------------------------------------
log "mirroring $BUCKET: minio -> seaweedfs"
compose exec -T minio sh -c "
  set -e
  mc alias set src http://127.0.0.1:9000 '$AK' '$SK' >/dev/null
  mc alias set dst http://seaweedfs:8333 '$AK' '$SK' >/dev/null
  mc mb --ignore-existing dst/$BUCKET >/dev/null
  mc mirror --overwrite src/$BUCKET dst/$BUCKET
" </dev/null

# --- Verify, do not assume -----------------------------------------------------
# Counts, then a content diff. `mc diff` prints a line per object that differs
# or is missing, so silence is the pass condition.
log "verifying"
SRC_N="$(compose exec -T minio sh -c "mc ls --recursive src/$BUCKET | wc -l" </dev/null | tr -d ' \r')"
DST_N="$(compose exec -T minio sh -c "mc ls --recursive dst/$BUCKET | wc -l" </dev/null | tr -d ' \r')"
log "  objects: source $SRC_N, destination $DST_N"
[[ "$SRC_N" == "$DST_N" ]] || die "object counts differ — NOT safe to switch over"

DIFF="$(compose exec -T minio sh -c "mc diff src/$BUCKET dst/$BUCKET | head -20" </dev/null || true)"
if [[ -n "${DIFF//[[:space:]]/}" ]]; then
  echo "$DIFF" >&2
  die "mc diff reported differences — NOT safe to switch over"
fi
log "  mc diff: clean"

cat <<DONE

Migration complete. $SRC_N objects are now in SeaweedFS and verified.

Next, switch the app over:

  docker compose -f docker-compose.yml -f docker-compose.prod.yml \\
    --env-file .env up -d --build

The MinIO service and its volume are untouched, so that command is also your
rollback: put FIBUKI_S3_ENDPOINT back to minio and the port back to 9000.
Keep both until SeaweedFS has served long enough to trust, then remove the
minio service and \`docker volume rm <project>_fibuki-miniodata\`.

One more thing worth doing while MinIO's image is still on this host: it can no
longer be pulled from any registry, so save a copy before it is ever pruned.

  docker save minio/minio:latest | gzip > minio-image-backup.tar.gz

DONE
