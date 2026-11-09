#!/bin/bash
# The game's own worker (MediaPipe lite/full/heavy in Chromium on the GPU, tracker in the loop)
# over every scene of a sim2real root:  run_game.sh <root: real|syn> [scene-glob]
S2R=${S2R:-/Volumes/development/aerodance-trackbench/sim2real}
ROOT=$1; GLOB=${2:-*}
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
export TRACKBENCH_DATA=$S2R/$ROOT
for s in $TRACKBENCH_DATA/scenes/$GLOB; do
  id=$(basename $s)
  [ -f $s/READY ] && [ -f $s/gt.jsonl ] || continue
  for m in ${MODELS:-lite full heavy}; do
    [ -f $TRACKBENCH_DATA/runs/mp-$m-game/$id/tracked.jsonl ] && continue
    node "$REPO/tools/trackbench/harness/run-game.ts" $id --model $m > $S2R/logs-$ROOT-game-$m-$id.log 2>&1 || echo "FAIL mp-$m-game $id"
    echo "$(date +%T) mp-$m-game $id"
  done
done
