#!/usr/bin/env bash
#
# Prove a backup restores. An untested backup is a guess.
#
# Restores the newest (or a named) backup into a THROWAWAY Postgres container and
# a throwaway volume, then asserts the row counts of the collections that matter.
# Never touches the live stack, the live volumes, or the live database.
#
# Usage:
#   ./restore-test.sh                        # newest backup in /var/backups/fibuki
#   ./restore-test.sh 20260729T031000Z       # a specific one
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/fibuki}"
STACK_DIR="${STACK_DIR:-/opt/fibuki/deploy/selfhost}"
WHICH="${1:-}"
SCRATCH_PG="fibuki-restoretest-pg"
SCRATCH_VOL="fibuki-restoretest-vol"

log() { echo "[restore-test] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

cleanup() {
  docker rm -f "$SCRATCH_PG" >/dev/null 2>&1 || true
  docker volume rm "$SCRATCH_VOL" >/dev/null 2>&1 || true
  [[ -n "${TMPD:-}" ]] && rm -rf "$TMPD"
}
trap cleanup EXIT

if [[ -n "$WHICH" ]]; then
  SRC="$BACKUP_DIR/$WHICH"
else
  SRC="$(find "$BACKUP_DIR" -maxdepth 1 -type d -name '20*' | sort | tail -1)"
fi
[[ -d "$SRC" ]] || die "no backup found at ${SRC:-$BACKUP_DIR}"
log "source: $SRC"

TMPD="$(mktemp -d)"

# --- Decrypt / stage ---------------------------------------------------------
if [[ -f "$SRC/postgres.dump.gpg" ]]; then
  log "decrypting"
  command -v gpg >/dev/null || die "gpg needed to read this backup"
  gpg --batch --yes --decrypt "$SRC/postgres.dump.gpg" > "$TMPD/postgres.dump"
  gpg --batch --yes --decrypt "$SRC/minio-data.tar.gz.gpg" > "$TMPD/minio-data.tar.gz"
elif [[ -f "$SRC/postgres.dump" ]]; then
  cp "$SRC/postgres.dump" "$SRC/minio-data.tar.gz" "$TMPD/"
  # Only meaningful for unencrypted backups; the gpg path already authenticates.
  if [[ -f "$SRC/SHA256SUMS" ]]; then
    log "verifying checksums"
    ( cd "$SRC" && sha256sum -c SHA256SUMS >/dev/null ) || die "checksum mismatch — backup is corrupt"
  fi
else
  die "no postgres dump (encrypted or plain) in $SRC"
fi

# --- Restore Postgres into a scratch container -------------------------------
PGPASS="restoretest"
log "starting scratch postgres"
docker run -d --name "$SCRATCH_PG" \
  -e POSTGRES_PASSWORD="$PGPASS" \
  -e POSTGRES_USER=fibuki \
  -e POSTGRES_DB=fibuki \
  postgres:16-alpine >/dev/null

for _ in $(seq 1 40); do
  docker exec "$SCRATCH_PG" pg_isready -U fibuki -d fibuki >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$SCRATCH_PG" pg_isready -U fibuki -d fibuki >/dev/null 2>&1 \
  || die "scratch postgres never became ready"

log "restoring dump"
docker cp "$TMPD/postgres.dump" "$SCRATCH_PG:/tmp/postgres.dump"
# pg_restore exits non-zero on benign notices (e.g. DROP of an absent object from
# --clean), so capture output and judge by the assertions below instead.
docker exec "$SCRATCH_PG" pg_restore \
  --username=fibuki --dbname=fibuki --no-owner --clean --if-exists \
  /tmp/postgres.dump > "$TMPD/restore.log" 2>&1 || log "pg_restore reported warnings (see below if assertions fail)"

# --- Assert the data is actually there ---------------------------------------
# The flattened collections from Phase 1 are the ones with real row counts.
log "row counts:"
FAIL=0
for tbl in transactions files partners sources; do
  n="$(docker exec "$SCRATCH_PG" psql -U fibuki -d fibuki -tAc \
        "SELECT count(*) FROM ${tbl}" 2>/dev/null || echo "ERR")"
  printf '  %-14s %s\n' "$tbl" "$n"
  [[ "$n" == "ERR" ]] && FAIL=1
done

# A dump that restores but holds nothing is the failure mode this catches.
TOTAL="$(docker exec "$SCRATCH_PG" psql -U fibuki -d fibuki -tAc \
  "SELECT coalesce(sum(n_live_tup),0) FROM pg_stat_user_tables" 2>/dev/null || echo 0)"
log "total live tuples: $TOTAL"
[[ "$TOTAL" -gt 0 ]] || { log "restore produced an EMPTY database"; FAIL=1; }

# --- Verify the MinIO archive is readable ------------------------------------
log "verifying minio archive"
docker volume create "$SCRATCH_VOL" >/dev/null
if docker run --rm -v "$SCRATCH_VOL":/data -v "$TMPD":/b:ro alpine:3 \
     tar xzf /b/minio-data.tar.gz -C /data 2>/dev/null; then
  OBJS="$(docker run --rm -v "$SCRATCH_VOL":/data:ro alpine:3 \
           sh -c 'find /data -type f ! -path "*/.minio.sys/*" | wc -l' | tr -d ' ')"
  log "minio objects restored: $OBJS"
  [[ "${OBJS:-0}" -gt 0 ]] || { log "minio archive extracted but contains no objects"; FAIL=1; }

  # Cross-check against what the backup recorded. Catches an archive that is
  # internally valid but was taken against the wrong (or an empty) volume — the
  # failure mode that a bytes-only check cannot see.
  EXPECTED="$(sed -n 's/^minio_objects=//p' "$SRC/manifest.txt" 2>/dev/null)"
  if [[ -n "$EXPECTED" ]]; then
    if [[ "$OBJS" -ne "$EXPECTED" ]]; then
      log "object count mismatch: archive has $OBJS, manifest recorded $EXPECTED"
      FAIL=1
    else
      log "object count matches the manifest ($EXPECTED)"
    fi
  else
    log "note: manifest has no minio_objects line (backup predates that field)"
  fi
else
  log "minio archive failed to extract"; FAIL=1
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo; log "RESTORE TEST FAILED"; sed -n '1,40p' "$TMPD/restore.log" >&2; exit 1
fi

echo; log "RESTORE TEST PASSED — $SRC is recoverable"
