#!/usr/bin/env bash
# QA helper: run the Flutter test suite for the frontend.
# Usage: scripts/qa/flutter-test.sh [options] [flutter-test-args...]
#
# Runs `flutter test` inside frontend/ and forwards every extra argument to
# flutter test unchanged (e.g. `test/store`, `--plain-name foo`).
#
# On hosts where `flutter` is not on PATH (this NixOS host without a manual
# install) the same command runs inside the devenv shell:
#   devenv shell -- flutter test ...
# so QA needs no hand-installed toolchain.
#
# Options:
#   -h, --help   print this usage text and exit 0
#
# Examples:
#   scripts/qa/flutter-test.sh                    # whole suite
#   scripts/qa/flutter-test.sh test/store         # one directory
#   scripts/qa/flutter-test.sh test/sdui test/boot
set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

# Always run from the frontend directory: flutter test is workspace-relative.
cd "$(dirname "${BASH_SOURCE[0]}")/../../frontend"

if command -v flutter > /dev/null 2>&1; then
  exec flutter test "$@"
else
  exec devenv shell -- flutter test "$@"
fi
