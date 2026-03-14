#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SYSTEM_TEST_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
NOSTREAM_ROOT="$(cd -- "${SYSTEM_TEST_ROOT}/.." && pwd)"
SEEDER_BOT_ROOT="${NOSTREAM_ROOT}/nostream-seeder-bot"

if [[ ! -d "${SEEDER_BOT_ROOT}" ]]; then
  echo "[rebuild-and-run-sintel] Missing repo: ${SEEDER_BOT_ROOT}" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[rebuild-and-run-sintel] docker is not installed or not in PATH." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[rebuild-and-run-sintel] Cannot access Docker daemon." >&2
  echo "[rebuild-and-run-sintel] Add your user to docker group or use sudo for docker commands." >&2
  exit 1
fi

echo "[rebuild-and-run-sintel] 1/4 Install nostream-seeder-bot dependencies"
cd "${SEEDER_BOT_ROOT}"
npm install

echo "[rebuild-and-run-sintel] 2/4 Build nostream-seeder-bot (creates dist/preload.cjs)"
npm run build

echo "[rebuild-and-run-sintel] 3/4 Install nostream-system-test dependencies"
cd "${SYSTEM_TEST_ROOT}"
npm install

echo "[rebuild-and-run-sintel] 4/4 Run Sintel E2E (KEEP_STACK=1)"
KEEP_STACK=1 npm run test:sintel

echo
echo "[rebuild-and-run-sintel] Done. Stack is kept running."
echo "[rebuild-and-run-sintel] Open UI: http://nostream-ui:5173/view/imdb/tt1727587"
echo "[rebuild-and-run-sintel] Start browser helper if needed: ./scripts/start-ui-browser.sh"
