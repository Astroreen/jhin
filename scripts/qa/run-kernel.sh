#!/usr/bin/env bash
# QA helper: build the kernel boot jar and run it in the foreground.
# Usage: scripts/qa/run-kernel.sh [kernel-args...]
set -euo pipefail

# Always run from the repository root.
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

./gradlew :kernel:bootJar
# The plain classifier jar (when `build` ran earlier) also matches kernel-*.jar;
# select only the executable boot jar for `java -jar`.
jar_path=$(ls kernel/build/libs/kernel-*.jar | grep -v -- '-plain\.jar$')
exec java -jar "$jar_path" "$@"
