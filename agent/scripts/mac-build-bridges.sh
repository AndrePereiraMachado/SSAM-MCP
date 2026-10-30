#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/mac-build-bridges.mjs
