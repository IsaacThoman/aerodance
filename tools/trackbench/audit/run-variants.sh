#!/bin/sh
# Track and score derived estimator ids over every scene they have detections for:
#   tools/trackbench/audit/run-variants.sh <id> [<id> ...]      (from the repository root)
set -e
DATA=${TRACKBENCH_DATA:-/Volumes/development/aerodance-trackbench}
mkdir -p "$DATA/audit/cal"
for id in "$@"; do
  for s in $(ls "$DATA/runs/$id"); do
    [ -f "$DATA/runs/$id/$s/detections.jsonl" ] || continue
    node tools/trackbench/harness/track.ts "$id" "$s" > /dev/null
  done
  node tools/trackbench/harness/metrics.ts "$id" > "$DATA/audit/cal/metrics-$id.log" 2>&1
  echo "$id done"
done
