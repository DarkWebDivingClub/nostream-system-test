#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

SELENIUM_URL="${SELENIUM_URL:-http://localhost:4444/wd/hub}"
BROWSER_UI_BASE_URL="${BROWSER_UI_BASE_URL:-http://nostream-ui:5173}"
HOST_UI_HEALTH_URL="${HOST_UI_HEALTH_URL:-}"
DEFAULT_PATH="/"

TARGET="${1:-$DEFAULT_PATH}"
if [[ "$TARGET" =~ ^https?:// ]]; then
  TARGET_URL="$TARGET"
else
  TARGET_URL="${BROWSER_UI_BASE_URL}${TARGET}"
fi

cd "$PROJECT_DIR"

echo "[start-ui-browser] Starting UI + browser services (profile: sintel)..."
docker compose --profile sintel up -d nostream-ui browser

echo "[start-ui-browser] Waiting for Selenium at ${SELENIUM_URL}/status ..."
for _ in $(seq 1 60); do
  if curl -fsS "${SELENIUM_URL}/status" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "${SELENIUM_URL}/status" >/dev/null

if [[ -n "${HOST_UI_HEALTH_URL}" ]]; then
  echo "[start-ui-browser] Waiting for UI (host health URL) at ${HOST_UI_HEALTH_URL} ..."
  for _ in $(seq 1 60); do
    if curl -fsS "${HOST_UI_HEALTH_URL}" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  curl -fsS "${HOST_UI_HEALTH_URL}" >/dev/null
else
  echo "[start-ui-browser] Skipping host UI curl check (container hostname is not host-resolvable)."
fi

echo "[start-ui-browser] Creating Selenium session..."
SESSION_JSON="$(
  curl -fsS -X POST "${SELENIUM_URL}/session" \
    -H "Content-Type: application/json" \
    -d '{"capabilities":{"alwaysMatch":{"browserName":"chrome"}}}'
)"

SESSION_ID="$(printf '%s' "$SESSION_JSON" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  const x = JSON.parse(s);
  const id = x?.value?.sessionId || x?.sessionId || "";
  if (!id) process.exit(1);
  process.stdout.write(id);
});
')"

echo "[start-ui-browser] Navigating to ${TARGET_URL} ..."
NAV_OK=0
for _ in $(seq 1 60); do
  if curl --max-time 10 -fsS -X POST "${SELENIUM_URL}/session/${SESSION_ID}/url" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"${TARGET_URL}\"}" >/dev/null 2>&1; then
    NAV_OK=1
    break
  fi
  sleep 1
done
if [[ "$NAV_OK" -ne 1 ]]; then
  echo "[start-ui-browser] ERROR: failed to navigate browser to ${TARGET_URL}" >&2
  exit 1
fi

echo "[start-ui-browser] Done."
echo "Session: ${SESSION_ID}"
echo "Target:  ${TARGET_URL}"
echo "VNC:     http://localhost:7900/?autoconnect=1&resize=scale"
