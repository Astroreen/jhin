#!/usr/bin/env bash
# Deletes the dev home (database, identity, token, logs, config); the next
# serve.sh or dev.sh starts a fresh node.
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
if [ ! -d "$JHIN_DEV_HOME" ]; then
  echo "jhin: no dev home at $JHIN_DEV_HOME"
  exit 0
fi
# Only a directory prepare_dev_home created, never e.g. ~/.jhin.
if [ ! -f "$JHIN_DEV_HOME/.jhin-dev-home" ]; then
  echo "jhin: $JHIN_DEV_HOME is not a dev home (no .jhin-dev-home marker); not deleting it" >&2
  exit 1
fi
bash "$(dirname "$0")/stop.sh"
rm -rf "$JHIN_DEV_HOME"
echo "jhin: removed $JHIN_DEV_HOME"
