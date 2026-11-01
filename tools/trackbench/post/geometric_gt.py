"""Bring image-space GT onto the camera picture's geometry: lens distortion (hfov > 90) and
rolling shutter (post). Blender renders, masks and GT are pinhole; post warps the picture, so
GT's 2D points, visibility codes 3, bboxes, in_frame and visible_frac have to follow.

python geometric_gt.py <scene_dir>

When the spec's geometry warps the picture: the pinhole GT is kept as `gt.pinhole.jsonl` and the
pinhole masks as `masks.pinhole/` (a directory or a symlink to a base's), and `gt.jsonl` and
`masks/` are rewritten through `degrade.distort_points` / `degrade.distort_mask`. Idempotent: it
always starts from the pinhole copies. When it doesn't, nothing changes.

- kp x, y: distorted (depth and vis kept), vis 3 where the distorted point leaves [0, 1].
  Points outside the raw render stay 3 even if the lens pulls them into a corner (the picture
  there is replicated border pixels, not them).
- bbox: from the warped mask. in_frame: false if the warp leaves none of the person's mask
  pixels and no keypoint in the picture (and they had some before).
- visible_frac: the pinhole value times the share of the person's pinhole mask pixels that the
  warp keeps in the picture (the occlusion itself doesn't change).
"""
import json
import os
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from degrade import distort_mask, distort_points, lens_k  # noqa: E402


def is_geometric(spec):
    return lens_k(spec) > 0 or any(op.get('type') == 'rolling_shutter' for op in spec.get('post', []))


def _r(v, n=5):
    return round(float(v), n)


def process(scene_dir):
    d = Path(scene_dir)
    spec = json.loads((d / 'spec.json').read_text())
    raw_gt, raw_masks = d / 'gt.pinhole.jsonl', d / 'masks.pinhole'
    if not is_geometric(spec):
        return False
    if not raw_gt.exists():
        (d / 'gt.jsonl').rename(raw_gt)
    if not (raw_masks.exists() or raw_masks.is_symlink()):
        (d / 'masks').rename(raw_masks)
    masks = d / 'masks'
    if masks.is_symlink():
        masks.unlink()
    elif masks.exists():
        shutil.rmtree(masks)
    masks.mkdir()
    out_lines = []
    with open(raw_gt) as f:
        lines = [json.loads(line) for line in f]
    for g in lines:
        fr = g['frame']
        mp = raw_masks / f'{fr:06d}.png'
        mask = np.asarray(Image.open(mp)) if mp.exists() else None
        if mask is not None:
            H, W = mask.shape
            warped = distort_mask(mask, spec, frame=fr)
            Image.fromarray(warped).save(masks / f'{fr:06d}.png')
            # Where each pinhole pixel lands, to see which leave the picture.
            ys, xs = np.mgrid[:H, :W]
            land = distort_points(np.stack([(xs + .5) / W, (ys + .5) / H], -1), spec, frame=fr)
            kept = (land[..., 0] >= 0) & (land[..., 0] <= 1) & (land[..., 1] >= 0) & (land[..., 1] <= 1)
        for p in g['people']:
            lab = p['index'] + 1
            kp = p['kp']
            ok = [j for j, k in enumerate(kp) if k[0] is not None and k[1] is not None]
            if ok:
                xy = distort_points(np.array([[kp[j][0], kp[j][1]] for j in ok]), spec, frame=fr)
                for j, (x, y) in zip(ok, xy):
                    vis = kp[j][3]
                    if not (0 <= x <= 1 and 0 <= y <= 1):
                        vis = 3
                    kp[j] = [_r(x), _r(y), kp[j][2], vis]
            if mask is None:
                continue
            own = mask == lab
            n_own = int(own.sum())
            ys2, xs2 = np.nonzero(warped == lab)
            p['bbox'] = ([_r(xs2.min() / W), _r(ys2.min() / H), _r((xs2.max() + 1) / W), _r((ys2.max() + 1) / H)]
                         if len(xs2) else None)
            if n_own:
                share = float(kept[own].mean())
                if p.get('visible_frac') is not None:
                    p['visible_frac'] = _r(p['visible_frac'] * share, 4)
                if not len(xs2) and all(k[3] == 3 for k in kp):
                    p['in_frame'] = False
        out_lines.append(json.dumps(g, separators=(',', ':')))
    tmp = d / 'gt.jsonl.tmp'
    tmp.write_text('\n'.join(out_lines) + '\n')
    tmp.replace(d / 'gt.jsonl')
    return True


if __name__ == '__main__':
    done = process(sys.argv[1])
    print('[geometric_gt]', 'warped GT and masks' if done else 'pinhole geometry; nothing to do')
