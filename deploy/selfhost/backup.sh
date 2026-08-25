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

# --- MinIO objects -----------------------------------------------------------
# Tar the data volume rather than using `mc mirror`: it needs no credentials and
# captures MinIO's on-disk layout verbatim, which is what a volume restore wants.
#
# The volume name MUST be discovered, not assumed. Compose prefixes volumes with
# the project name (selfhost_fibuki-miniodata), and `docker run -v` silently
# CREATES an empty volume for a name that does not exist — so a hardcoded
# "fibuki-miniodata" produces a valid, well-formed, empty archive. That is the
# worst possible failure: a backup that looks fine and restores nothing.
log "resolving the minio data volume"
MINIO_VOL="$(docker inspect "$(compose ps -q minio)" \
  --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' 2>/dev/null)"
[[ -n "$MINIO_VOL" ]] || die "could not resolve the minio /data volume — is the stack up?"
docker volume inspect "$MINIO_VOL" >/dev/null 2>&1 || die "volume $MINIO_VOL does not exist"
log "minio volume: $MINIO_VOL"

log "archiving minio objects"
docker run --rm \
  -v "$MINIO_VOL":/data:ro \
  -v "$DEST":/backup \
  alpine:3 \
  tar czf /backup/minio-data.tar.gz -C /data .

# Count real objects, not archive bytes. An empty tar.gz is ~45 bytes and passes
# any `-s` test, which is exactly how the hardcoded-name bug above went unnoticed.
OBJ_COUNT="$(docker run --rm -v "$MINIO_VOL":/data:ro alpine:3 \
  sh -c 'find /data -type f ! -path "*/.minio.sys/*" | wc -l' | tr -d ' ')"
log "minio: $(du -h "$DEST/minio-data.tar.gz" | cut -f1), $OBJ_COUNT objects"
[[ "${OBJ_COUNT:-0}" -gt 0 ]] || die "minio volume $MINIO_VOL holds no objects — refusing to record this as a backup"

# --- Manifest ----------------------------------------------------------------
# Checksums so restore-test.sh can prove the artefacts are the ones it verified.
( cd "$DEST" && sha256sum postgres.dump minio-data.tar.gz > SHA256SUMS )
cat > "$DEST/manifest.txt" <<EOF
created_utc=$TS
host=$(hostname)
postgres_db=$PGDB
minio_volume=$MINIO_VOL
minio_objects=$OBJ_COUNT
images=$(compose images --quiet | tr '\n' ' ')
EOF

# --- Encrypt -----------------------------------------------------------------
if [[ "$GPG_RECIPIENT" != "NONE" ]]; then
  log "encrypting to $GPG_RECIPIENT"
  command -v gpg >/dev/null || die "gpg not found but GPG_RECIPIENT is set"
  for f in postgres.dump minio-data.tar.gz; do
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
