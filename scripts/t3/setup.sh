#!/usr/bin/env bash
# Installs dependencies (Node 24 and pnpm are fetched when missing).
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
cd "$JHIN_ROOT" || exit 1
pnpm install --frozen-lockfile
