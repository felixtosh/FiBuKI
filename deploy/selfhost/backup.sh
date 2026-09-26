#!/usr/bin/env bash
#
# Nightly backup for the FiBuKI host: Postgres logical dump + MinIO
# objects, encrypted, retained locally with a rolling window.
#
# The compose stack has NO backup story of its own — just two named volumes. This
# plus Hetzner's server snapshots (enabled by provision-hetzner.sh) is the whole
# recovery story, so restore-test.sh exists to prove it actually works.
#
# Install as a root cron on the server:
#   10 3 * * *  /opt/fibuki/deploy/selfhost/backup.sh >> /var/log/fibuki-backup.log 2>&1
#
# Off-box copy is deliberately a separate step (OFFSITE_CMD) so the choice of
# Storage Box / B2 / S3 is yours and no credentials are baked in here.
set -euo pipefail

STACK_DIR="${STACK_DIR:-/opt/fibuki/deploy/selfhost}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/fibuki}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
# Age/gpg recipient. Unset = plaintext dumps, which is not acceptable for tax
# data at rest on a rented box, so we refuse rather than silently do it.
GPG_RECIPIENT="${GPG_RECIPIENT:-}"
OFFSITE_CMD="${OFFSITE_CMD:-}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/$TS"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

[[ -n "$GPG_RECIPIENT" ]] || die "GPG_RECIPIENT unset — refusing to write unencrypted dumps of customer data. Set it, or set GPG_RECIPIENT=NONE to override deliberately."
command -v docker >/dev/null || die "docker not found"

cd "$STACK_DIR" || die "no stack dir at $STACK_DIR"
mkdir -p "$DEST"

compose() { docker compose -f docker-compose.yml -f docker-compose.prod.yml "$@"; }

# --- Postgres ----------------------------------------------------------------
# pg_dump inside the container, so no client version skew and no exposed port.
# --clean --if-exists makes the dump self-sufficient for a restore into a
# non-empty database.
log "dumping postgres"
PGUSER="$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2-)"
PGDB="$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2-)"
[[ -n "$PGUSER" && -n "$PGDB" ]] || die "could not read POSTGRES_USER/POSTGRES_DB from .env"

compose exec -T postgres pg_dump \
  --username="$PGUSER" --dbname="$PGDB" \
  --format=custom --clean --if-exists --no-owner \
  > "$DEST/postgres.dump"

[[ -s "$DEST/postgres.dump" ]] || die "postgres dump is empty"
log "postgres: $(du -h "$DEST/postgres.dump" | cut -f1)"

# --- Blob objects -------------------------------------------------------------
# Tar the data volume rather than talking S3: it needs no credentials and
# captures the store's on-disk layout verbatim, which is what a volume restore
# wants.
#
# The volume name MUST be discovered, not assumed. Compose prefixes volumes with
# the project name (selfhost_fibuki-seaweeddata), and `docker run -v` silently
# CREATES an empty volume for a name that does not exist — so a hardcoded name
# produces a valid, well-formed, empty archive. That is the worst possible
# failure: a backup that looks fine and restores nothing.
#
# The service is resolved by name so this keeps working either side of the
# MinIO -> SeaweedFS migration, and so a half-migrated host is loud rather than
# quietly backing up the wrong store.
BLOB_SVC=""
for candidate in seaweedfs minio; do
  if [[ -n "$(compose ps -q "$candidate" 2>/dev/null)" ]]; then BLOB_SVC="$candidate"; break; fi
done
[[ -n "$BLOB_SVC" ]] || die "neither a seaweedfs nor a minio service is running — is the stack up?"
log "resolving the $BLOB_SVC data volume"
BLOB_VOL="$(docker inspect "$(compose ps -q "$BLOB_SVC")" \
  --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' 2>/dev/null)"
[[ -n "$BLOB_VOL" ]] || die "could not resolve the $BLOB_SVC /data volume — is the stack up?"
docker volume inspect "$BLOB_VOL" >/dev/null 2>&1 || die "volume $BLOB_VOL does not exist"
log "blob volume: $BLOB_VOL ($BLOB_SVC)"

log "archiving blob objects"
docker run --rm \
  -v "$BLOB_VOL":/data:ro \
  -v "$DEST":/backup \
  alpine:3 \
  tar czf /backup/blob-data.tar.gz -C /data .

# Measure the volume, not the archive. An empty tar.gz is ~45 bytes and passes
# any `-s` test, which is exactly how the hardcoded-name bug went unnoticed.
#
# BYTES rather than a file count, because the two stores disagree about what a
# file is: MinIO wrote one file per object, while SeaweedFS packs objects into
# a handful of .dat volume files. Counting files under SeaweedFS would report
# single digits for a healthy store and could not tell "packed" from "empty".
BLOB_BYTES="$(docker run --rm -v "$BLOB_VOL":/data:ro alpine:3 \
  sh -c 'du -sb /data 2>/dev/null | cut -f1' | tr -d ' ')"
log "blob: $(du -h "$DEST/blob-data.tar.gz" | cut -f1) archived, ${BLOB_BYTES} B on disk"
[[ "${BLOB_BYTES:-0}" -gt 1048576 ]] || die "blob volume $BLOB_VOL holds under 1 MiB — refusing to record this as a backup"

# --- Images -------------------------------------------------------------------
# The stack is only restorable if its images can still be pulled, and in
# September 2026 MinIO's simply stopped being published: archived upstream,
# binaries gone, images withdrawn from Docker Hub and quay.io within days. The
# running container kept working, so nothing looked wrong until a rebuild was
# attempted. Hetzner snapshots would have covered it; a fresh host would not.
#
# So the images travel with the data. Saved once per run, deduplicated by
# digest, so a week of backups costs one copy of each unchanged image.
log "saving images"
mkdir -p "$BACKUP_DIR/images"
for ref in $(compose config --images | sort -u); do
  safe="$(printf '%s' "$ref" | tr '/:' '__')"
  out="$BACKUP_DIR/images/${safe}.tar.gz"
  if [[ -f "$out" ]]; then
    have="$(cat "$BACKUP_DIR/images/${safe}.id" 2>/dev/null || true)"
    now="$(docker image inspect "$ref" --format '{{.Id}}' 2>/dev/null || true)"
    [[ -n "$now" && "$have" == "$now" ]] && { log "  $ref unchanged"; continue; }
  fi
  docker image inspect "$ref" >/dev/null 2>&1 || { log "  $ref not present locally, skipping"; continue; }
  docker save "$ref" | gzip -1 > "$out"
  docker image inspect "$ref" --format '{{.Id}}' > "$BACKUP_DIR/images/${safe}.id"
  log "  saved $ref ($(du -h "$out" | cut -f1))"
done

# --- Manifest ----------------------------------------------------------------
# Checksums so restore-test.sh can prove the artefacts are the ones it verified.
( cd "$DEST" && sha256sum postgres.dump blob-data.tar.gz > SHA256SUMS )
cat > "$DEST/manifest.txt" <<EOF
created_utc=$TS
host=$(hostname)
postgres_db=$PGDB
blob_service=$BLOB_SVC
blob_volume=$BLOB_VOL
blob_bytes=$BLOB_BYTES
images=$(compose images --quiet | tr '\n' ' ')
EOF

# --- Encrypt -----------------------------------------------------------------
if [[ "$GPG_RECIPIENT" != "NONE" ]]; then
  log "encrypting to $GPG_RECIPIENT"
  command -v gpg >/dev/null || die "gpg not found but GPG_RECIPIENT is set"
  for f in postgres.dump blob-data.tar.gz; do
    gpg --batch --yes --trust-model always \
        --recipient "$GPG_RECIPIENT" --encrypt "$DEST/$f"
    shred -u "$DEST/$f" 2>/dev/null || rm -f "$DEST/$f"
  done
else
  log "WARNING: GPG_RECIPIENT=NONE — dumps left unencrypted at rest"
fi

# --- Off-box copy ------------------------------------------------------------
# A backup on the same disk as the data is not a backup.
if [[ -n "$OFFSITE_CMD" ]]; then
  log "offsite: $OFFSITE_CMD"
  # shellcheck disable=SC2086
  eval "$OFFSITE_CMD \"$DEST\"" || die "offsite copy failed — NOT pruning old backups"
  # The images live outside the dated run, because they are deduplicated across
  # runs, so the line above does not carry them. Sending them separately is the
  # whole point of saving them: an image mirror that dies with the box restores
  # nothing, which is exactly the hole MinIO's withdrawal opened.
  if [[ -d "$BACKUP_DIR/images" ]]; then
    log "offsite: images"
    # shellcheck disable=SC2086
    eval "$OFFSITE_CMD \"$BACKUP_DIR/images\"" || die "offsite copy of images failed — NOT pruning old backups"
  fi
else
  log "WARNING: OFFSITE_CMD unset — this backup exists only on this disk."
  log "         e.g. OFFSITE_CMD='rclone copy --to-remote storagebox:fibuki/'"
fi

# --- Prune -------------------------------------------------------------------
# Only after a successful offsite copy, so a broken upload never eats history.
log "pruning backups older than $RETAIN_DAYS days"
find "$BACKUP_DIR" -maxdepth 1 -type d -name '20*' -mtime "+$RETAIN_DAYS" \
  -exec rm -rf {} + 2>/dev/null || true

log "done: $DEST"
