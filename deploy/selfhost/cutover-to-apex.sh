#!/usr/bin/env bash
#
# Cut the self-host stack over from new.fibuki.com to the apex domain fibuki.com.
#
# RUN THIS ONLY AFTER the DNS A/AAAA records for fibuki.com point at this box.
# Caddy requests a certificate for every host it serves; asking for one while the
# name still resolves to Firebase App Hosting means failed ACME challenges, and
# Let's Encrypt rate-limits repeated failures per hostname. The script refuses to
# proceed unless DNS already resolves here, because recovering from a rate-limit is
# a much worse afternoon than waiting for a TTL.
#
# What it does NOT do, deliberately:
#   - change DNS (not ours to change, and the ordering above matters)
#   - register the Stripe webhook (separate script; it has live side effects)
#   - decommission Firebase App Hosting (keep the rollback for a few days)
#
# Rollback: re-run with FIBUKI_TARGET_HOST=new.fibuki.com, then point DNS back.
# The old stack keeps serving until you switch DNS, so the flip is reversible.
#
#   ./cutover-to-apex.sh              # to fibuki.com
#   FIBUKI_TARGET_HOST=new.fibuki.com ./cutover-to-apex.sh   # roll back
#
set -euo pipefail

cd "$(dirname "$0")"

TARGET="${FIBUKI_TARGET_HOST:-fibuki.com}"
KEEP="${FIBUKI_KEEP_HOST:-new.fibuki.com}"
ENV_FILE=".env"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)

[[ -f "$ENV_FILE" ]] || { echo "no $ENV_FILE here; run on the server"; exit 1; }

# --- Precondition: DNS actually points at this machine ----------------------
MY_IP="$(curl -fsS -4 ifconfig.me)"
RESOLVED="$(getent ahostsv4 "$TARGET" 2>/dev/null | awk '{print $1; exit}' || true)"
if [[ "$RESOLVED" != "$MY_IP" ]]; then
  echo "REFUSING: $TARGET resolves to '${RESOLVED:-nothing}', this box is $MY_IP."
  echo "Point the A record at $MY_IP and wait for the TTL, then re-run."
  echo "Override only if you know the resolver is stale: FIBUKI_FORCE=1"
  [[ "${FIBUKI_FORCE:-}" == "1" ]] || exit 1
fi

cp "$ENV_FILE" "$ENV_FILE.bak-$(date +%s)"

# --- Swap every origin that names the web host ------------------------------
# The API host is NOT touched: it stays new-api.fibuki.com, which keeps the Better
# Auth issuer, its JWKS and the Google sign-in callback URL stable. Changing it
# would invalidate every live session and require re-registering the OAuth client.
#
set_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    # Use a non-/ delimiter: values are URLs.
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
  echo "  ${key}=${val}"
}

echo "Rewriting origins to https://${TARGET}"
# The old name REDIRECTS, it does not serve. Serving it would render the app on an
# origin the api's CORS layer rejects, so every data call fails and it looks broken
# rather than moved.
set_env FIBUKI_WEB_HOST            "${TARGET}"
set_env FIBUKI_WEB_CANONICAL_HOST  "${TARGET}"
set_env FIBUKI_WEB_REDIRECT_HOSTS  "${KEEP}"
set_env FIBUKI_WEB_ORIGIN        "https://${TARGET}"
set_env APP_URL                  "https://${TARGET}"
set_env NEXT_PUBLIC_APP_URL      "https://${TARGET}"
set_env GOOGLE_OAUTH_REDIRECT_URI "https://${TARGET}/api/gmail/callback"
set_env TRUELAYER_REDIRECT_URL    "https://${TARGET}/api/truelayer/callback"

cat <<EOF

REMINDER, these are registered with third parties and will NOT work until updated
there too. Gmail reconnects and TrueLayer callbacks fail with a redirect_uri
mismatch otherwise:
  Google Cloud console  ->  https://${TARGET}/api/gmail/callback
  TrueLayer console     ->  https://${TARGET}/api/truelayer/callback

EOF

# NEXT_PUBLIC_* are inlined at build time, so the web image must be rebuilt for the
# new origin to reach the client bundle and the server-side link builders.
echo "Rebuilding fibuki-web (NEXT_PUBLIC_APP_URL is baked in at build time)"
"${COMPOSE[@]}" build fibuki-web

echo "Restarting web + caddy"
"${COMPOSE[@]}" up -d fibuki-web caddy

# --- Verify, rather than assume ---------------------------------------------
echo "Waiting for a certificate and a 200 on https://${TARGET} ..."
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://${TARGET}/" || true)"
  if [[ "$code" == "200" ]]; then
    echo "  https://${TARGET} -> 200"
    break
  fi
  [[ $i -eq 30 ]] && { echo "  still $code after 5min; check: docker logs selfhost-caddy-1"; exit 1; }
  sleep 10
done

echo "  https://${KEEP} -> $(curl -s -o /dev/null -w '%{http_code}' "https://${KEEP}/") (expect 308 to ${TARGET})"
echo
echo "Done. Firebase App Hosting is untouched and remains the rollback."
