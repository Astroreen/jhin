#!/usr/bin/env bash
# Installs dependencies (Node 24 and pnpm are fetched when missing).
source "$(dirname "$0")/env.sh"
cd "$JHIN_ROOT"
pnpm install --frozen-lockfile
