#!/usr/bin/env bash
# QA for T81: full-bundle lifecycle e2e, upgrade path and contract-level
# downgrade. Thin wrapper around scripts/qa/e2e-lifecycle.sh (the whole QA
# body lives there).
# Usage: scripts/qa/t81.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T81. Happy path exits 0 after the
# full e2e (lifecycle + sidebar + bootstrap downgrade + upgrade path);
# --fail exits non-zero on the deliberately wrong expectation (see
# scripts/qa/e2e-lifecycle.sh).
set -euo pipefail

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.."

if [ "${1:-}" = "--fail" ]; then
  shift
  exec scripts/qa/e2e-lifecycle.sh --fail "${1:-.sisyphus/evidence/T81}"
fi
exec scripts/qa/e2e-lifecycle.sh "${1:-.sisyphus/evidence/T81}"
