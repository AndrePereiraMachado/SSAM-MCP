#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  printf 'Run this candidate on an Apple Silicon Mac.\n' >&2; exit 1
fi
command -v node >/dev/null || { printf 'Node.js 24 is required for build tests.\n' >&2; exit 1; }
command -v dotnet >/dev/null || { printf '.NET SDK 10 is required to compile.\n' >&2; exit 1; }
xcode-select -p >/dev/null
node scripts/build-native.mjs osx-arm64
native/Ssam.Agent/bin/Release/net10.0/osx-arm64/publish/ssam-agent mac-inspect > mac-report.json
printf '\nBuild and isolated tests completed. Read-only Studio report: mac-report.json\n'
printf 'Full report path: %s/mac-report.json\n' "$PWD"
/usr/bin/open -R "$PWD/mac-report.json" || true
