#!/bin/bash
# Keep the existing entry point for scripts calling retrack.sh.
cd "$(dirname "$0")/../../.." || exit 1
exec node tools/trackbench/studies/retrack.ts "$@"
