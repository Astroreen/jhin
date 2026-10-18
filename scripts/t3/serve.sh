#!/usr/bin/env bash
# Builds the web client and runs a node with the UI (`jhin serve --ui --watch`)
# in the isolated dev home. Open http://127.0.0.1:$JHIN_PORT/#token=$JHIN_DEV_TOKEN.
source "$(dirname "$0")/env.sh"
ensure_deps
prepare_dev_home
cd "$JHIN_ROOT"
pnpm --filter @jhin/web build
record_pid serve
echo "jhin: open http://127.0.0.1:$JHIN_PORT/#token=$JHIN_DEV_TOKEN" >&2
exec node apps/jhin/bin/jhin.js --home "$JHIN_DEV_HOME" --cwd "$JHIN_ROOT" serve --ui --watch
