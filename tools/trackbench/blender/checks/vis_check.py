"""Cross-check GT visibility codes against the instance masks (independent: masks come from the
renderer, codes from ray casts).

$TRACKBENCH_DATA/.venv/bin/python tools/trackbench/blender/checks/vis_check.py <scene_dir> [--json out]

For each in-frame keypoint, looks at the mask in a 3x3 pixel neighbourhood of its projection:
  own   = any pixel is the person's own label
  other = the centre pixel is another person's label
Expected: vis 0 -> own (nearly always); vis 2 by a person -> other at the centre (unless the
point is at the very edge of the occluder); vis 1 -> own (the person's own body is in front).
Also lists the frames with the most vis-2 points (look at those images).
"""
import argparse
import collections
import json
import os
import sys

import cv2
import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('scene_dir')
    ap.add_argument('--json')
    a = ap.parse_args()
    stats = collections.defaultdict(collections.Counter)
    occl_frames = collections.Counter()
    bad = []
    with open(os.path.join(a.scene_dir, 'gt.jsonl')) as f:
        for line in f:
            d = json.loads(line)
            fr = d['frame']
            mp = os.path.join(a.scene_dir, 'masks', f'{fr:06d}.png')
            if not os.path.exists(mp):
                continue
            m = cv2.imread(mp, cv2.IMREAD_UNCHANGED)
            H, W = m.shape
            for p in d['people']:
                lab = p['index'] + 1
                for j, (x, y, z, v) in enumerate(p['kp']):
                    if v == 3 or x is None:
                        continue
                    px, py = min(W - 1, int(x * W)), min(H - 1, int(y * H))
                    win = m[max(0, py - 1):py + 2, max(0, px - 1):px + 2]
                    own = bool((win == lab).any())
                    c = int(m[py, px])
                    other = c not in (0, lab)
                    key = 'own' if own else ('other_person' if other else 'background/env')
                    stats[v][key] += 1
                    if v == 2:
                        occl_frames[fr] += 1
                    if (v == 0 and not own) or (v == 2 and own and not other):
                        bad.append((fr, p['id'], j, v, key))
    names = {0: 'visible', 1: 'self-occluded', 2: 'occluded by other'}
    rep = {}
    for v in (0, 1, 2):
        tot = sum(stats[v].values())
        if tot:
            rep[names[v]] = {k: [n, round(n / tot, 4)] for k, n in stats[v].items()}
            print(f'vis {v} ({names[v]}): n={tot} ' + ', '.join(f'{k} {n} ({n / tot:.1%})' for k, n in stats[v].most_common()))
    rep['most_occluded_frames'] = occl_frames.most_common(8)
    rep['disagreements_sample'] = bad[:40]
    rep['disagreements'] = len(bad)
    print('frames with most vis-2 points:', occl_frames.most_common(8))
    print(f'{len(bad)} disagreements (vis 0 off the own mask, or vis 2 on the own mask); first:', bad[:12])
    if a.json:
        json.dump(rep, open(a.json, 'w'), indent=1)


if __name__ == '__main__':
    sys.exit(main())
