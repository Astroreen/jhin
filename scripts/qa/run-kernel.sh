#!/usr/bin/env bash
# QA helper: build the kernel boot jar and run it in the foreground, capturing
# the console stream as kernel.log inside the evidence directory.
# Usage: scripts/qa/run-kernel.sh <evidence-dir> [kernel-args...]
set -euo pipefail

# Always run from the repository root.
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

evidence=${1:?usage: run-kernel.sh <evidence-dir> [kernel-args...]}
shift
mkdir -p "$evidence"

./gradlew :kernel:bootJar
# The plain classifier jar (when `build` ran earlier) also matches kernel-*.jar;
# select only the executable boot jar for `java -jar`.
jar_path=$(ls kernel/build/libs/kernel-*.jar | grep -v -- '-plain\.jar$')
# The kernel stays the exec'd process (kill-able, runs its shutdown hook), tee
# mirrors its combined output into the evidence file.
exec java -jar "$jar_path" "$@" > >(tee "$evidence/kernel.log") 2>&1
