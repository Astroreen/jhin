#!/usr/bin/env bash
# Builds the web client and runs the Playwright end-to-end tests.
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
ensure_deps
cd "$JHIN_ROOT" || exit 1
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  pnpm --filter @jhin/e2e exec playwright install chromium
fi
exec pnpm e2e "$@"
