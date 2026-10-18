#!/usr/bin/env bash
# Frontend development: a headless node (`jhin serve --watch`) plus the Vite
# dev server with hot module reload, which proxies /rpc to the node.
# Open http://127.0.0.1:5180/#token=$JHIN_DEV_TOKEN.
source "$(dirname "$0")/env.sh"
ensure_deps
prepare_dev_home
cd "$JHIN_ROOT"
record_pid dev
JHIN_WEB_PORT="${JHIN_WEB_PORT:-5180}"

node apps/jhin/bin/jhin.js --home "$JHIN_DEV_HOME" --cwd "$JHIN_ROOT" serve --watch &
node_pid=$!
trap 'kill "$node_pid" 2>/dev/null || true' EXIT INT TERM

echo "jhin: open http://127.0.0.1:$JHIN_WEB_PORT/#token=$JHIN_DEV_TOKEN" >&2
JHIN_NODE_URL="http://127.0.0.1:$JHIN_PORT" pnpm --filter @jhin/web exec vp dev --host 127.0.0.1 --port "$JHIN_WEB_PORT" --strictPort
