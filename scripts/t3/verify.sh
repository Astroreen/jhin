#!/usr/bin/env bash
# Typecheck, lint and tests for what changed since origin/main. Pass `--all`
# for the full run that CI does.
source "$(dirname "$0")/env.sh"
ensure_deps
cd "$JHIN_ROOT"
if [ "${1:-}" = "--all" ]; then
  shift
  exec pnpm verify "$@"
fi
exec pnpm verify --affected "$@"
