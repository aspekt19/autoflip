#!/usr/bin/env bash
# CI: local Next + labelled STUB Auto.dev/SERV upstreams → scripts/e2e-find-radar.ts
# Fixture responses are never presented as live market/SERV results.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pick_port() {
  node -e 'const n=require("node:net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{const a=s.address();process.stdout.write(String(a.port));s.close();});'
}

STUB_PORT="${E2E_STUB_PORT:-$(pick_port)}"
APP_PORT="${E2E_APP_PORT:-$(pick_port)}"
AUTH_SECRET="${AUTH_SECRET:-e2e-stub-auth-secret-at-least-32-chars!!}"
STUB_URL="http://127.0.0.1:${STUB_PORT}"
BASE_URL="http://127.0.0.1:${APP_PORT}"

DATA_DIR=""
cleanup() {
  if [[ -n "${STUB_PID:-}" ]]; then kill "$STUB_PID" 2>/dev/null || true; fi
  if [[ -n "${APP_PID:-}" ]]; then kill "$APP_PID" 2>/dev/null || true; fi
  if [[ -n "${DATA_DIR}" && -d "${DATA_DIR}" ]]; then rm -rf "${DATA_DIR}"; fi
}
trap cleanup EXIT

echo "[e2e-ci] starting STUB upstreams on ${STUB_PORT}"
PORT="$STUB_PORT" node scripts/e2e-find-radar-stub-upstreams.mjs &
STUB_PID=$!

for i in $(seq 1 50); do
  if curl -sf "${STUB_URL}/health" >/dev/null; then break; fi
  sleep 0.1
done
curl -sf "${STUB_URL}/health" >/dev/null

DATA_DIR="$(mktemp -d /tmp/lemonless-e2e-XXXXXX)"
export DATA_DIR
echo "[e2e-ci] starting Next on ${APP_PORT} (STUB upstreams wired, DATA_DIR=${DATA_DIR})"
LEMONLESS_E2E_STUB=1 \
AUTH_SECRET="$AUTH_SECRET" \
AUTH_GOOGLE_ID=e2e-stub-google-id \
AUTH_GOOGLE_SECRET=e2e-stub-google-secret \
SERV_API_KEY=e2e-stub-serv-key \
SERV_BASE_URL="${STUB_URL}/v1" \
AUTODEV_API_KEY=e2e-stub-autodev-key \
AUTODEV_BASE_URL="$STUB_URL" \
AUTOFLIP_DEV_CREDITS=5 \
AUTOFLIP_DATA_DIR="$DATA_DIR" \
npx next dev -p "$APP_PORT" -H 127.0.0.1 &
APP_PID=$!

ready=0
for i in $(seq 1 120); do
  # Wait until THIS server answers bootstrap (proves LEMONLESS_E2E_STUB=1).
  code=$(curl -s -o /tmp/e2e-boot.json -w "%{http_code}" -X POST "${BASE_URL}/api/e2e/bootstrap" || true)
  if [[ "$code" == "200" ]] && grep -q '"stub":true' /tmp/e2e-boot.json 2>/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then
  echo "[e2e-ci] Next did not expose stub bootstrap on ${BASE_URL}"
  cat /tmp/e2e-boot.json 2>/dev/null || true
  exit 1
fi

echo "[e2e-ci] running HTTP chain against ${BASE_URL}"
# Fresh cookie from the script's own bootstrap call (previous probe cookie discarded).
BASE_URL="$BASE_URL" npx tsx scripts/e2e-find-radar.ts
echo "[e2e-ci] OK"
