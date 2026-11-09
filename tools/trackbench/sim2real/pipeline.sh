#!/bin/bash
# sim2real pipeline steps. Data stays in $S2R (default $TRACKBENCH_DATA/sim2real); each root
# (aist, aistsyn, aistpgt, real, syn, synpgt) is its own TRACKBENCH_DATA, so an estimator's
# learnt offsets never mix GT kinds and nothing reaches the main runs/.
#
#   pipeline.sh refs <root> [glob]                      reference ensemble (refs.py) over the root's READY scenes
#   pipeline.sh fuse-real                               eval clips: pseudo-GT into real/ (colour identity for c1-c3)
#   pipeline.sh twins                                   eval twins: reframe rendered syn/twin-* into syn/syn-*
#   pipeline.sh pgt-copy <src-root> <dst-root> [glob]   copy scenes (frames linked) with pseudo-GT from the same fusion
#   pipeline.sh refdets <root> [glob] [pgt-root]        the references (and ref-fused, from pgt-root) as estimators
#   pipeline.sh link <src-root> <dst-root>              dst reuses src's detections and tracking (they don't depend on GT)
#   pipeline.sh track <root>                            detections without tracking through the game's tracker
#   pipeline.sh metrics <root>                          s2r_metrics.ts for every estimator in the root
set -u
S2R=${S2R:-/Volumes/development/aerodance-trackbench/sim2real}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
PY=/Volumes/development/aerodance-trackbench/.venv/bin/python
REFPY=$S2R/.venv-ref/bin/python
EVAL_SEQS=$(python3 -c "import json;print(' '.join(s['id'] for s in json.load(open('$HERE/sequences.json'))['sequences']))")
ident() { python3 -c "import json;print(next((s.get('identity','') for s in json.load(open('$HERE/sequences.json'))['sequences'] if s['id']=='$1'),''))"; }

case $1 in
  refs)
    for d in $S2R/$2/scenes/${3:-*}; do
      s=$(basename $d); [ -f $d/READY ] || continue; [ -f $S2R/refs/$2/$s.npz ] && continue
      # A .claim marks a scene another refs process has taken (several can share the GPU).
      [ -f $S2R/refs/$2/$s.npz.claim ] && continue; mkdir -p $S2R/refs/$2; touch $S2R/refs/$2/$s.npz.claim
      (cd $S2R/ul && HF_HOME=$S2R/hf caffeinate -dimsu $REFPY -I $HERE/refs.py $d $S2R/refs/$2/$s.npz 2>&1 | grep -E "^done|Error")
    done ;;
  fuse-real)
    for s in $EVAL_SEQS; do
      [ -f $S2R/refs/real/real-$s.npz ] || continue
      id=$(ident $s)
      $PY $HERE/fuse_pgt.py $S2R/refs/real/real-$s.npz $S2R/real/scenes/real-$s ${id:+--identity $id}
    done ;;
  twins) $PY $HERE/make_scenes.py twins; for s in $EVAL_SEQS; do [ -d $S2R/syn/scenes/syn-$s ] && touch $S2R/syn/scenes/syn-$s/READY; done ;;
  pgt-copy)
    for src in $S2R/$2/scenes/${4:-*}; do
      s=$(basename $src); dst=$S2R/$3/scenes/$s
      [ -f $S2R/refs/$2/$s.npz ] && [ -f $src/gt.jsonl ] || continue
      mkdir -p $dst; ln -sfn $src/frames $dst/frames; cp $src/spec.json $src/meta.json $dst/; touch $dst/READY
      $PY $HERE/fuse_pgt.py $S2R/refs/$2/$s.npz $dst --exact-gt $src/gt.jsonl
    done ;;
  refdets)
    for npz in $S2R/refs/$2/${3:-*}.npz; do
      s=$(basename $npz .npz); fg=${4:+$S2R/$4/scenes/$s/gt.jsonl}
      TRACKBENCH_DATA=$S2R/$2 $PY $HERE/refdets.py $npz $s ${fg:+--fused-gt $fg}
    done ;;
  link)
    for d in $S2R/$2/runs/*/*; do
      [ -d $d ] || continue
      e=$(basename $(dirname $d)); s=$(basename $d)
      [ -d $S2R/$3/scenes/$s ] || continue
      mkdir -p $S2R/$3/runs/$e/$s
      for f in detections.jsonl tracked.jsonl run.json track.json; do [ -f $d/$f ] && ln -sfn $d/$f $S2R/$3/runs/$e/$s/$f; done
    done ;;
  track)
    export TRACKBENCH_DATA=$S2R/$2
    for d in $TRACKBENCH_DATA/runs/*/*/detections.jsonl; do
      dir=$(dirname $d); e=$(basename $(dirname $dir)); s=$(basename $dir)
      [ -f $dir/tracked.jsonl ] && continue
      node $REPO/tools/trackbench/harness/track.ts $e $s > /dev/null 2>> $S2R/track-$2.err || echo "FAIL track $e $s"
    done ;;
  metrics)
    export TRACKBENCH_DATA=$S2R/$2
    for e in $(ls $TRACKBENCH_DATA/runs); do node $HERE/s2r_metrics.ts $e > $S2R/metrics-$2-$e.log 2>&1 || echo "FAIL metrics $2 $e"; done ;;
  *) echo "unknown step $1"; exit 2 ;;
esac
