#!/bin/bash
# Brings every run up to date after harness changes: fills missing runs, re-tracks every
# non-game estimator (the tracker stage is cheap and deterministic), then re-scores everything.
#   caffeinate -dimsu tools/trackbench/finalize.sh
set -u
cd "$(dirname "$0")/../.."
DATA=${TRACKBENCH_DATA:-/Volumes/development/aerodance-trackbench}
python3 tools/trackbench/matrix.py --cpu-jobs 3
# Extra candidates on a representative subset (genres, the multiplayer bases, motion and camera sweeps, 4 players).
python3 tools/trackbench/matrix.py --cpu-jobs 3 --estimators rtmo-t rtmpose-m yolo26s-pose \
  --scenes base-genre- base-duo base-trio base-quad mot- cam- mp4-
for est in "$DATA"/runs/*; do
  e=$(basename "$est")
  case "$e" in *-game|*-game-*) ;; *)
    for s in "$est"/*/; do
      s=$(basename "$s"); [ -f "$DATA/scenes/$s/READY" ] && [ -f "$est/$s/detections.jsonl" ] || continue
      node tools/trackbench/harness/track.ts "$e" "$s" > /dev/null || echo "FAIL track $e $s"
    done;;
  esac
  node tools/trackbench/harness/metrics.ts "$e" > "$DATA/logs/metrics-$e.log" 2>&1 || echo "FAIL metrics $e"
  echo "$(date +%H:%M:%S) rescored $e"
done
echo finalize done
