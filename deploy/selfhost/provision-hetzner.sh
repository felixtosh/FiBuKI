#!/usr/bin/env bash
#
# Provision a FiBuKI host on Hetzner Cloud.
#
# The host name comes from FIBUKI_WEB_HOST (see .env.hetzner.example); it was
# new.fibuki.com during the migration off Firebase and is fibuki.com now.
#
# Idempotent: every hcloud object is created only if absent, so a re-run after a
# partial failure converges instead of erroring. Creates nothing chargeable
# beyond the single server unless SIZE is raised.
#
# Prereq: an hcloud context with a Read/Write project token —
#   hcloud context create fibuki      (paste token from Console > Security > API Tokens)
#
# Usage:
#   ./provision-hetzner.sh                 # create/converge
#   SIZE=cx42 ./provision-hetzner.sh       # override instance type
#   DRY_RUN=1 ./provision-hetzner.sh       # print the plan, touch nothing
#
set -euo pipefail

NAME="${NAME:-fibuki-selfhost}"
# cx33: 4 vCPU x86 / 8 GB / 80 GB, ~EUR 8.49/mo gross in fsn1 — the cheapest 8 GB
# type Hetzner offers. 8 GB is the floor, not headroom: Chromium sits ~400 MB
# resident plus ~50-100 MB per concurrent PDF page, on top of Postgres, MinIO,
# Next and the API.
#
# x86 rather than ARM for two independent reasons: @sparticuz/chromium ships an
# x86_64-only binary (we sidestep that with Debian's Chromium in api.Dockerfile,
# so arm64 would build), but as of this writing cax21 is ~EUR 10.49 against
# cx33's ~8.49 — ARM is no longer the cheaper option here, so there is nothing
# to trade off. Re-check with `hcloud server-type list` before changing.
SIZE="${SIZE:-cx33}"
LOCATION="${LOCATION:-fsn1}" # Falkenstein, DE. EU requirement. nbg1 also fine.
IMAGE="${IMAGE:-debian-12}"
FW="${FW:-fibuki-selfhost-fw}"
SSH_KEY_NAME="${SSH_KEY_NAME:-fibuki-deploy}"
SSH_PUB="${SSH_PUB:-$HOME/.ssh/fibuki_deploy.pub}"
DRY_RUN="${DRY_RUN:-}"

run() {
  if [[ -n "$DRY_RUN" ]]; then echo "  [dry-run] $*"; else "$@"; fi
}

need() { command -v "$1" >/dev/null || { echo "missing: $1" >&2; exit 1; }; }
need hcloud

if ! hcloud context list 2>/dev/null | tail -n +2 | grep -q .; then
  cat >&2 <<'EOF'
No hcloud context. Create one first:

  1. Hetzner Cloud Console > your project > Security > API Tokens
  2. Generate token, permission: Read & Write
  3. hcloud context create fibuki      (paste when prompted)

hcloud has no OAuth flow; it is a project-scoped API token.
EOF
  exit 1
fi

echo "==> Project: $(hcloud context active)"

# --- SSH key -----------------------------------------------------------------
# Password auth is disabled below, so a key must exist before the server does or
# you lock yourself out.
if [[ ! -f "$SSH_PUB" ]]; then
  echo "No public key at $SSH_PUB — generate one with:" >&2
  echo "  ssh-keygen -t ed25519 -C fibuki-deploy" >&2
  exit 1
fi

if hcloud ssh-key describe "$SSH_KEY_NAME" >/dev/null 2>&1; then
  echo "==> ssh-key $SSH_KEY_NAME exists"
else
  echo "==> creating ssh-key $SSH_KEY_NAME"
  run hcloud ssh-key create --name "$SSH_KEY_NAME" --public-key-from-file "$SSH_PUB"
fi

# --- Firewall ----------------------------------------------------------------
# This is the layer that actually protects the box. Docker publishes ports by
# writing its own iptables rules, which sit BEFORE ufw/firewalld in the chain —
# a host firewall does not reliably contain a published container port. The
# Hetzner Cloud Firewall runs outside the host, so it does.
#
# Inbound: SSH + HTTP + HTTPS. Nothing else. In particular NOT 8788 (api),
# 3000 (web), 5432 (postgres), 9000/9001 (MinIO) — those stay internal.
if hcloud firewall describe "$FW" >/dev/null 2>&1; then
  echo "==> firewall $FW exists (not modifying rules; delete it to re-create)"
else
  echo "==> creating firewall $FW"
  run hcloud firewall create --name "$FW"
  for spec in "22:SSH" "80:HTTP (ACME challenge + redirect to 443)" "443:HTTPS"; do
    port="${spec%%:*}"; desc="${spec#*:}"
    run hcloud firewall add-rule "$FW" \
      --direction in --protocol tcp --port "$port" \
      --source-ips 0.0.0.0/0 --source-ips ::/0 \
      --description "$desc"
  done
  # ICMP for reachability debugging. Harmless.
  run hcloud firewall add-rule "$FW" \
    --direction in --protocol icmp \
    --source-ips 0.0.0.0/0 --source-ips ::/0 \
    --description "ping"
fi

# --- cloud-init --------------------------------------------------------------
# Hardens SSH and installs Docker. Deliberately does NOT open any host firewall
# ports: the Cloud Firewall above is the boundary, and Docker would punch through
# ufw anyway.
CLOUD_INIT="$(mktemp)"
trap 'rm -f "$CLOUD_INIT"' EXIT
cat >"$CLOUD_INIT" <<'YAML'
#cloud-config
package_update: true
package_upgrade: true
packages:
  - ca-certificates
  - curl
  - gnupg
  - git
  - fail2ban
  # fail2ban's systemd backend (see jail.local below) needs this binding, and
  # without it the service starts, prints "Server ready", then exits 255.
  - python3-systemd
  - unattended-upgrades
write_files:
  - path: /etc/fail2ban/jail.local
    content: |
      [DEFAULT]
      # Debian 12 logs sshd to the journal and ships no /var/log/auth.log, which
      # the stock sshd jail reads — fail2ban otherwise refuses to start with
      # "Have not found any log file for sshd jail".
      backend = systemd
      bantime = 1h
      findtime = 10m
      maxretry = 5

      [sshd]
      enabled = true
  - path: /etc/ssh/sshd_config.d/99-fibuki.conf
    content: |
      PasswordAuthentication no
      PermitRootLogin prohibit-password
      KbdInteractiveAuthentication no
      X11Forwarding no
  - path: /etc/apt/apt.conf.d/20auto-upgrades
    content: |
      APT::Periodic::Update-Package-Lists "1";
      APT::Periodic::Unattended-Upgrade "1";
runcmd:
  - install -m 0755 -d /etc/apt/keyrings
  - curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  - chmod a+r /etc/apt/keyrings/docker.asc
  - echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list
  - apt-get update
  - DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  - systemctl enable --now docker
  - systemctl enable --now fail2ban
  - systemctl restart ssh
YAML

# --- Server ------------------------------------------------------------------
if hcloud server describe "$NAME" >/dev/null 2>&1; then
  echo "==> server $NAME already exists"
else
  echo "==> creating server $NAME ($SIZE, $LOCATION, $IMAGE)"
  run hcloud server create \
    --name "$NAME" \
    --type "$SIZE" \
    --image "$IMAGE" \
    --location "$LOCATION" \
    --ssh-key "$SSH_KEY_NAME" \
    --firewall "$FW" \
    --user-data-from-file "$CLOUD_INIT" \
    --label "app=fibuki,role=selfhost,env=new"
fi

if [[ -n "$DRY_RUN" ]]; then
  echo; echo "dry run complete — nothing created."; exit 0
fi

IP4="$(hcloud server ip "$NAME")"
# The API returns the assigned /64 NETWORK in PublicNet.IPv6.IP (e.g.
# 2a01:4f8:1c16:9b30::), not a host address. Hetzner routes the whole block, and
# ::1 is the conventional host address to use — publishing the bare network in an
# AAAA record would not answer.
IP6_NET="$(hcloud server describe "$NAME" -o format='{{.PublicNet.IPv6.IP}}' 2>/dev/null || true)"
IP6="${IP6_NET:+${IP6_NET%::}::1}"

# Hetzner's own snapshot/backup add-on. ~20% of instance cost, and it is the
# cheapest possible rollback for the whole box. Separate from the Postgres dumps
# in backup.sh — that covers data, this covers the machine.
echo "==> enabling Hetzner backups for $NAME"
run hcloud server enable-backup "$NAME" || echo "    (backup may already be enabled)"

cat <<EOF

==> Provisioned.

  server   $NAME ($SIZE, $LOCATION)
  IPv4     $IP4
  IPv6     ${IP6:-n/a}
  firewall $FW  (inbound: 22, 80, 443, icmp — nothing else)

Next, in order:

1. DNS at GoDaddy (fibuki.com nameservers are ns23/ns24.domaincontrol.com):

     ${FIBUKI_WEB_HOST:-fibuki.com}      A     $IP4
     new-api.fibuki.com  A     $IP4
$( [[ -n "${IP6:-}" ]] && echo "     ${FIBUKI_WEB_HOST:-fibuki.com}      AAAA  $IP6
     new-api.fibuki.com  AAAA  $IP6" )

   Both names must resolve BEFORE first boot — Caddy's ACME challenge fails
   otherwise and it will back off.

2. Wait for cloud-init, then confirm Docker:

     until ssh root@$IP4 'test -f /var/lib/cloud/instance/boot-finished' 2>/dev/null; do sleep 10; done
     ssh root@$IP4 'docker --version && docker compose version'

3. Ship the code and env, then bring it up (see README-hetzner.md).

EOF
