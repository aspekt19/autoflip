#!/usr/bin/env bash
# Local merge gate: types, unit tests, golden replay.
# Golden replay is offline. Known failures on main do not fail this gate.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run typecheck
npm test
npm run golden
