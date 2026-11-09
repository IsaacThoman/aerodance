#!/bin/bash
# Replays one run's detections through the game's tracker (as it is in the working tree) into a
# new estimator id, then scores it: for measuring tracker changes on identical detections.
#   tools/trackbench/studies/retrack.sh <from-estimator> <to-id> [scene-prefix...]
set -u
cd "$(dirname "$0")/../../.."
DATA=${TRACKBENCH_DATA:-/Volumes/development/aerodance-trackbench}
from=$1 to=$2; shift 2
for d in "$DATA/runs/$from"/*/; do
  s=$(basename "$d"); [ -f "$d/detections.jsonl" ] || continue
  if [ $# -gt 0 ]; then ok=0; for p in "$@"; do case $s in $p*) ok=1;; esac; done; [ $ok = 1 ] || continue; fi
  mkdir -p "$DATA/runs/$to/$s"; ln -sf "$d/detections.jsonl" "$DATA/runs/$to/$s/detections.jsonl"
  node tools/trackbench/harness/track.ts "$to" "$s" > /dev/null || echo "FAIL track $s"
done
node tools/trackbench/harness/metrics.ts "$to" > "$DATA/logs/metrics-$to.log" 2>&1 || echo "FAIL metrics"
