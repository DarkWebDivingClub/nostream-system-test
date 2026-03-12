#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

cd "$PROJECT_ROOT"

echo "[run-sintel-keep] Running Sintel E2E and keeping stack up (KEEP_STACK=1)..."
KEEP_STACK=1 npm run test:sintel

echo

echo "[run-sintel-keep] E2E finished. Stack should still be running."
echo "[run-sintel-keep] Open: http://nostream-ui:5173/view/imdb/tt1727587"
echo "[run-sintel-keep] If browser is not running, start it with: ./scripts/start-ui-browser.sh"
