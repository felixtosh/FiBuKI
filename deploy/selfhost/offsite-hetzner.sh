#!/usr/bin/env bash
#
# OFFSITE_CMD implementation for a Hetzner Storage Box.
#
#   OFFSITE_CMD=/opt/fibuki/deploy/selfhost/offsite-hetzner.sh
#
# backup.sh appends the finished backup directory as the final argument, and dies
# WITHOUT pruning if this exits non-zero — so a broken upload can never silently
# eat backup history.
#
# A wrapper rather than a bare `rsync` in OFFSITE_CMD because rsync needs its
# destination AFTER the source, and the contract supplies the source last. It also
# gives somewhere to verify the upload, which matters: an earlier version of
# backup.sh "succeeded" while archiving an empty volume, so exit codes alone are
# not evidence.
#
# Setup (done once):
#   hcloud storage-box create --name fibuki-backup --type bx11 --location fsn1 \
#     --password <...> --enable-ssh --reachable-externally --ssh-key "$(cat /root/.ssh/id_ed25519.pub)"
#
# Storage Boxes speak SSH on port 23 and run a RESTRICTED shell — arbitrary remote
# commands silently no-op and exit 0, so never verify with `ssh <box> some-command`.
# rsync and sftp both work.
set -euo pipefail

SB_USER="${SB_USER:-u642524}"
SB_HOST="${SB_HOST:-u642524.your-storagebox.de}"
SB_PORT="${SB_PORT:-23}"
SB_PATH="${SB_PATH:-fibuki}"

SRC="${1:?usage: offsite-hetzner.sh <backup-dir>}"
[[ -d "$SRC" ]] || { echo "offsite: not a directory: $SRC" >&2; exit 2; }

NAME="$(basename "$SRC")"
REMOTE="${SB_USER}@${SB_HOST}"
SSH_OPTS="-p ${SB_PORT} -o BatchMode=yes -o ConnectTimeout=30"

echo "offsite: $SRC -> ${REMOTE}:${SB_PATH}/${NAME}/"

# Trailing slash on the source: copy the directory's CONTENTS into a like-named
# remote directory, so a partial previous run is overwritten rather than nested.
rsync -a --delete -e "ssh ${SSH_OPTS}" "${SRC}/" "${REMOTE}:${SB_PATH}/${NAME}/"

# --- Verify, do not assume ----------------------------------------------------
# Compare the file count and total byte size actually present remotely against
# local. rsync exiting 0 means the transfer it attempted worked; it says nothing
# about whether the source was what we meant.
local_files=$(find "$SRC" -type f | wc -l | tr -d ' ')
local_bytes=$(find "$SRC" -type f -exec stat -c%s {} + | awk '{s+=$1} END {print s+0}')

listing=$(printf 'ls -l %s/%s\nbye\n' "$SB_PATH" "$NAME" \
  | sftp -P "$SB_PORT" -o BatchMode=yes "$REMOTE" 2>/dev/null || true)

remote_files=$(printf '%s\n' "$listing" | awk '/^-/ {n++} END {print n+0}')
remote_bytes=$(printf '%s\n' "$listing" | awk '/^-/ {s+=$5} END {print s+0}')

echo "offsite: local ${local_files} files / ${local_bytes} B — remote ${remote_files} files / ${remote_bytes} B"

if [[ "$remote_files" -ne "$local_files" || "$remote_bytes" -ne "$local_bytes" ]]; then
  echo "offsite: VERIFY FAILED — remote does not match local; not treating this as a backup" >&2
  exit 1
fi

echo "offsite: verified"
