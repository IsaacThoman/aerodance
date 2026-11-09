#!/bin/bash
# Keeps running a runner over a root until every expected scene is READY and done (twins appear as they render).
#   run_all.sh <estimators|game> <root> <n-expected-scenes> [scene-glob]
S2R=${S2R:-/Volumes/development/aerodance-trackbench/sim2real}
HERE=$(cd "$(dirname "$0")" && pwd)
KIND=$1; ROOT=$2; N=$3; GLOB=${4:-*}
while true; do
  if [ $KIND = game ]; then $HERE/run_game.sh $ROOT "$GLOB"; else $HERE/run_estimators.sh $ROOT "$GLOB"; fi
  ready=$(ls $S2R/$ROOT/scenes/$GLOB/READY 2>/dev/null | wc -l)
  [ $ready -ge $N ] && break
  sleep 60
done
