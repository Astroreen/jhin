#!/usr/bin/env bash
# Deletes the dev home (database, identity, logs, config); the next serve.sh
# or dev.sh starts a fresh node.
source "$(dirname "$0")/env.sh"
bash "$(dirname "$0")/stop.sh"
rm -rf "$JHIN_DEV_HOME"
echo "jhin: removed $JHIN_DEV_HOME"
