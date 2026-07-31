#!/usr/bin/env bash
#
# Point Stripe at the self-host API and store the resulting signing secret.
#
# WHY THIS IS SEPARATE FROM THE CUTOVER, AND RUN AT CUTOVER TIME RATHER THAN BEFORE:
#
# The account's only webhook endpoint today is the Firebase Cloud Function. Register
# a second one early and BOTH receive every live event, so a subscription change is
# processed twice against two different databases — duplicate emails, and billing
# state that diverges between Firestore and Postgres with no error anywhere. The key
# here is sk_live, so these are real customers' real subscriptions.
#
# So: register at the moment traffic moves, and disable the Firebase endpoint in the
# same sitting. This script does the first half and prints the second.
#
# The signing secret is per ENDPOINT — production's whsec_ will not validate a
# delivery to new-api.fibuki.com. Stripe returns the new one exactly once, at
# creation, which is why this writes it straight into .env.
#
#   ./register-stripe-webhook.sh
#
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=".env"
URL="${FIBUKI_WEBHOOK_URL:-https://new-api.fibuki.com/stripeWebhook}"

[[ -f "$ENV_FILE" ]] || { echo "no $ENV_FILE here; run on the server"; exit 1; }
set -a; . "$ENV_FILE"; set +a
[[ -n "${STRIPE_SECRET_KEY:-}" ]] || { echo "STRIPE_SECRET_KEY not set"; exit 1; }

echo "Stripe mode: $(echo "$STRIPE_SECRET_KEY" | grep -oE '^sk_(live|test)')"
echo "Registering:  $URL"

if curl -fsS https://api.stripe.com/v1/webhook_endpoints -u "$STRIPE_SECRET_KEY:" \
     | grep -q "\"url\": \"$URL\""; then
  echo "Already registered. Not creating a duplicate."
  echo "If you need the secret again, roll it in the dashboard: Stripe issues it once."
  exit 0
fi

# Event set mirrors what functions/src/billing/stripeWebhook.ts actually handles.
RESP="$(curl -fsS https://api.stripe.com/v1/webhook_endpoints \
  -u "$STRIPE_SECRET_KEY:" \
  -d "url=$URL" \
  -d "description=FiBuKI self-host (new-api)" \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=customer.subscription.created" \
  -d "enabled_events[]=customer.subscription.updated" \
  -d "enabled_events[]=customer.subscription.deleted" \
  -d "enabled_events[]=invoice.paid" \
  -d "enabled_events[]=invoice.payment_failed")"

SECRET="$(printf '%s' "$RESP" | grep -oE '"secret": "whsec_[^"]+"' | grep -oE 'whsec_[^"]+')"
[[ -n "$SECRET" ]] || { echo "No secret in response:"; printf '%s\n' "$RESP" | head -20; exit 1; }

cp "$ENV_FILE" "$ENV_FILE.bak-$(date +%s)"
if grep -q '^STRIPE_WEBHOOK_SECRET=' "$ENV_FILE"; then
  sed -i "s|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=${SECRET}|" "$ENV_FILE"
else
  printf 'STRIPE_WEBHOOK_SECRET=%s\n' "$SECRET" >> "$ENV_FILE"
fi
echo "Stored STRIPE_WEBHOOK_SECRET in $ENV_FILE (${SECRET:0:12}...)"

# --force-recreate is REQUIRED. A plain `up -d` left the container Running with the
# PREVIOUS secret still in its environment, so every real delivery would have failed
# signature verification with the new endpoint looking correctly configured. Verified
# by comparing .env against `docker exec printenv` and finding them different.
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate fibuki-api

# Prove the process actually has it, rather than trusting the restart.
sleep 5
LIVE="$(docker exec selfhost-fibuki-api-1 printenv STRIPE_WEBHOOK_SECRET 2>/dev/null || true)"
if [[ "$LIVE" != "$SECRET" ]]; then
  echo "WARNING: container secret still does not match .env — deliveries will 400."
  echo "  .env:      ${SECRET:0:14}..."
  echo "  container: ${LIVE:0:14}..."
  exit 1
fi
echo "Verified: the running api has the new signing secret."

cat <<EOF

NOW DISABLE THE OLD ENDPOINT, or every event is processed twice against two
databases:
  Stripe dashboard -> Developers -> Webhooks
  disable: https://europe-west1-taxstudio-f12fb.cloudfunctions.net/stripeWebhook

Then confirm with a test event and check:  docker logs -f selfhost-fibuki-api-1
EOF
