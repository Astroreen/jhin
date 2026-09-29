#!/usr/bin/env bash
# QA helper: build one plugin jar and print its path.
# Usage: scripts/qa/build-plugin.sh <plugin-name>
set -euo pipefail

if [ "$#" -lt 1 ]; then
    echo "usage: $0 <plugin-name>" >&2
    exit 2
fi

# Always run from the repository root.
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

./gradlew ":jhin-plugin-$1:jar"
jar_path=$(ls plugins/"$1"/build/libs/jhin-plugin-"$1"-*.jar)
echo "jar: $jar_path"
