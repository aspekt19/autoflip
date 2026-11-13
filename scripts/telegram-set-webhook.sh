#!/usr/bin/env bash
# Owner-only: point Lemonless Radar (@autoflip_radar_bot) at production webhook.
# Do NOT run this from cloud agents against prod. Values come from your secrets store.
#
# Required env (names only — never commit values):
#   TELEGRAM_BOT_TOKEN
#   TELEGRAM_WEBHOOK_SECRET
#   NEXT_PUBLIC_APP_URL   e.g. https://your-prod-host
#
set -euo pipefail
: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"
: "${TELEGRAM_WEBHOOK_SECRET:?set TELEGRAM_WEBHOOK_SECRET}"
: "${NEXT_PUBLIC_APP_URL:?set NEXT_PUBLIC_APP_URL}"

ROOT="${NEXT_PUBLIC_APP_URL%/}"
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${ROOT}/api/telegram/webhook" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]'
echo
