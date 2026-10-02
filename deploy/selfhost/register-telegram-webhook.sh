#!/usr/bin/env bash
#
# Point the Telegram bot at the API's /telegramWebhook and print the result.
# Run once after the five TELEGRAM_* values are in /opt/fibuki/.env and the
# api container was rebuilt. See docs/community-telegram.md.
#
#   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
#   FIBUKI_API_HOST=new-api.fibuki.com deploy/selfhost/register-telegram-webhook.sh
set -euo pipefail
: "${TELEGRAM_BOT_TOKEN:?}" "${TELEGRAM_WEBHOOK_SECRET:?}" "${FIBUKI_API_HOST:?}"

# Only the two update types the bot handles; Telegram sends the secret back in a
# header so the endpoint can refuse anyone else.
curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=https://${FIBUKI_API_HOST}/telegramWebhook" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message","chat_join_request"]'
echo
curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
echo
