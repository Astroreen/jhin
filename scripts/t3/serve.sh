#!/usr/bin/env bash
# Builds the web client and runs a node with the UI (`jhin serve --ui --watch`)
# in the isolated dev home; prints the URL to open, with the access token.
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
ensure_deps
prepare_dev_home
cd "$JHIN_ROOT" || exit 1
record_pid serve
pnpm --filter @jhin/web build

start_dev_node --ui --watch
echo "jhin: open $NODE_URL/#token=$(dev_token)" >&2
wait "$NODE_PID"
