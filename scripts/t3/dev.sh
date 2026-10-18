#!/usr/bin/env bash
# Frontend development: a headless node (`jhin serve --watch`) plus the Vite
# dev server with hot module reload, which proxies /rpc to the node. Prints
# the URL to open, with the access token. Stops when either process exits.
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
ensure_deps
prepare_dev_home
cd "$JHIN_ROOT" || exit 1
record_pid dev
JHIN_WEB_PORT="${JHIN_WEB_PORT:-7780}"

start_dev_node --watch
echo "jhin: open http://127.0.0.1:$JHIN_WEB_PORT/#token=$(dev_token)" >&2
JHIN_NODE_URL="$NODE_URL" pnpm --filter @jhin/web exec vp dev --host 127.0.0.1 --port "$JHIN_WEB_PORT" --strictPort &
web_pid=$!

wait -n "$NODE_PID" "$web_pid" || true
