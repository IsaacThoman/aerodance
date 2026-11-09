#!/bin/bash
# Runs the Python/native candidate estimators over every scene of a sim2real root.
#   run_estimators.sh <root: real|syn> [scene-glob]
# Detections land in $S2R/<root>/runs/<estimator>/<scene>/ (never the main runs/, so the
# harness's per-estimator offsets there aren't mixed with pseudo-GT scenes).
S2R=${S2R:-/Volumes/development/aerodance-trackbench/sim2real}
ROOT=$1; GLOB=${2:-*}
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
export TRACKBENCH_DATA=$S2R/$ROOT
PY=/Volumes/development/aerodance-trackbench/.venv/bin/python
ESTS=${ESTS:-"rtmo-s rtmpose-s movenet-multipose apple-vision yolo26n-pose yolo26s-pose rtmo-t rtmpose-m mp-full mp-lite mp-heavy"}
for s in $TRACKBENCH_DATA/scenes/$GLOB; do
  id=$(basename $s)
  [ -f $s/READY ] || continue
  for e in $ESTS; do
    [ -f $TRACKBENCH_DATA/runs/$e/$id/detections.jsonl ] && continue
    $PY "$REPO/tools/trackbench/sim2real/run_limited.py" $e $id > /dev/null 2> $S2R/logs-$ROOT-$e-$id.err || echo "FAIL $e $id"
    echo "$(date +%T) $e $id"
  done
done
