#!/usr/bin/env python3
"""Writes the pseudo-GT references as estimator detections in $TRACKBENCH_DATA/runs:

  refdets.py <refs.npz> <scene-id> [--fused-gt <pseudo-GT gt.jsonl>]

ref-yolo26x, ref-vitpose-h, ref-rtmw-x (each reference alone; RTMW confidence = clip(raw / 5, 0, 1),
so the fusion's "confident" raw 2.5 sits at the game's 0.5 gate) and ref-fused (the fused
pseudo-GT itself: agreed joints conf 1, the rest 0.4). On exact-GT twins these measure the
pseudo-GT's own error; on pseudo-GT scenes they're biased (they define the GT).
"""
import json
import os
import sys

import numpy as np

COCO_TO_33 = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
DATA = os.environ['TRACKBENCH_DATA']


def write(est, scene, lines, info):
    d = os.path.join(DATA, 'runs', est, scene)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, 'detections.jsonl'), 'w') as f:
        for line in lines:
            f.write(json.dumps(line) + '\n')
    json.dump({'estimator': est, 'scene': scene, **info}, open(os.path.join(d, 'run.json'), 'w'), indent=1)


def main():
    refs, scene = sys.argv[1], sys.argv[2]
    fused_gt = sys.argv[sys.argv.index('--fused-gt') + 1] if '--fused-gt' in sys.argv else os.path.join(DATA, 'scenes', scene, 'gt.jsonl')
    R = np.load(refs)
    W, H, n = int(R['width']), int(R['height']), int(R['n_frames'])
    for est, key, conf in (('ref-yolo26x', 'y', lambda c: c), ('ref-vitpose-h', 'v', lambda c: c), ('ref-rtmw-x', 'w', lambda c: np.clip(c / 5, 0, 1))):
        lines = []
        for f in range(1, n + 1):
            people = []
            for i in np.where(R['frame'] == f)[0]:
                if R['box'][i, 4] < 0.3:
                    continue
                kp = [None] * 33
                for c, j in enumerate(COCO_TO_33):
                    x, y, s = R[key][i, c]
                    kp[j] = [round(float(x / W), 5), round(float(y / H), 5), 0, round(float(conf(s)), 4)]
                people.append({'kp': kp, 'score': round(float(R['box'][i, 4]), 4)})
            lines.append({'frame': f, 't_ms': round((f - 1) * 1000 / 30, 3), 'people': people})
        write(est, scene, lines, {'model': est, 'note': 'pseudo-GT reference (sim2real/refs.py), YOLO26x boxes >= 0.3'})
    if os.path.exists(fused_gt):
        lines = []
        for line in open(fused_gt):
            d = json.loads(line)
            people = []
            for p in d['people']:
                kp = [None] * 33
                for j in COCO_TO_33:
                    x, y = p['kp'][j][:2]
                    kp[j] = [x, y, 0, 1.0 if p['pgt_ok'][j] else 0.4]
                people.append({'kp': kp, 'score': 1.0})
            lines.append({'frame': d['frame'], 't_ms': d['t_ms'], 'people': people})
        write('ref-fused', scene, lines, {'model': 'fused pseudo-GT', 'source': fused_gt})
    print(scene, 'refdets written')


if __name__ == '__main__':
    main()
