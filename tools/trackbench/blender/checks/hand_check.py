"""Agreement of MediaPipe's Hand Landmarker (the game's hand model) with a scene's hand-21 GT.

$TRACKBENCH_DATA/.venv/bin/python tools/trackbench/blender/checks/hand_check.py <scene_dir> [--json out]
    [--scale 0.5] [--every 2] [--src frames|render]

For every GT person and hand whose wrist is in view, the hand is cut out of the picture the way
the game's worker cuts it (pose.worker.ts cutFor: a square a little past the wrist towards the
fingers, max(96 px, 1.1 x shoulder width, 4 x wrist-to-knuckles) wide, resized to 256 px), but
from the GT's pose points rather than a tracked pose, so this checks the hand GT and the
pictures, not the game's tracking. The Hand Landmarker (IMAGE mode, two hands) runs on the cut;
the hand nearest the wrist within 0.45 of the cut counts as found. Reported per side (paddle hand
vs free hand) and overall:
  - found rate;
  - median error of the 21 points in palm lengths (GT wrist to middle-finger knuckle, in pixels)
    and of the wrist alone in pixels of the full frame;
  - handedness agreement (MediaPipe's label, which on unmirrored pictures names the person's own
    hand; see the game's NAMED);
  - the same split by the GT's phase (ready, swing, serve).
--scale 0.5 runs on the picture downscaled first (1280x960 -> 640x480, the game's webcam size).
This is a sanity check of the GT, not a benchmark (the harness does that).
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np

DATA = os.environ.get('TRACKBENCH_DATA', '/Volumes/development/aerodance-trackbench')
MODEL = os.path.join(DATA, 'models', 'hand_landmarker.task')
POSE = {'left': {'wrist': 15, 'index': 19, 'pinky': 17}, 'right': {'wrist': 16, 'index': 20, 'pinky': 18}}


def cut_for(kp, side, W, H):
    j = POSE[side]
    w, i, p = kp[j['wrist']], kp[j['index']], kp[j['pinky']]
    l, r = kp[11], kp[12]
    shoulders = np.hypot((l[0] - r[0]) * W, (l[1] - r[1]) * H)
    fx, fy = ((i[0] + p[0]) / 2 - w[0]) * W, ((i[1] + p[1]) / 2 - w[1]) * H
    size = max(96.0, shoulders * 1.1, np.hypot(fx, fy) * 4)
    return w[0] * W + fx * 0.6 - size / 2, w[1] * H + fy * 0.6 - size / 2, size


def crop(img, x, y, size, out=256):
    """Square crop (padded with black past the edges) resized to out x out."""
    H, W = img.shape[:2]
    x, y, s = int(round(x)), int(round(y)), int(round(size))
    canvas = np.zeros((s, s, 3), img.dtype)
    x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + s), min(H, y + s)
    if x1 > x0 and y1 > y0:
        canvas[y0 - y:y1 - y, x0 - x:x1 - x] = img[y0:y1, x0:x1]
    return cv2.resize(canvas, (out, out), interpolation=cv2.INTER_AREA if s > out else cv2.INTER_LINEAR)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('scene_dir')
    ap.add_argument('--json')
    ap.add_argument('--scale', type=float, default=1.0)
    ap.add_argument('--every', type=int, default=2)
    ap.add_argument('--src', default='frames')
    a = ap.parse_args()
    import mediapipe as mp
    from mediapipe.tasks import python as mpt
    from mediapipe.tasks.python import vision
    lm = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
        base_options=mpt.BaseOptions(model_asset_path=MODEL), running_mode=vision.RunningMode.IMAGE, num_hands=2,
        min_hand_detection_confidence=0.5, min_hand_presence_confidence=0.5))
    meta = json.load(open(os.path.join(a.scene_dir, 'meta.json')))
    hands_of = {p['id']: p.get('hand') for p in meta['people']}
    rows = []
    with open(os.path.join(a.scene_dir, 'gt.jsonl')) as f:
        gts = [json.loads(l) for l in f]
    for g in gts[::a.every]:
        fn = g['frame']
        path = os.path.join(a.scene_dir, 'frames', f'{fn:06d}.jpg') if a.src == 'frames' else \
            os.path.join(a.scene_dir, 'render', f'{fn:06d}.png')
        if not os.path.exists(path):
            continue
        img = cv2.imread(path)
        if a.scale != 1:
            img = cv2.resize(img, None, fx=a.scale, fy=a.scale, interpolation=cv2.INTER_AREA)
        H, W = img.shape[:2]
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        for p in g['people']:
            if 'hands' not in p or p.get('role') != 'player':
                continue
            for side in ('left', 'right'):
                gtk = np.array([[k[0] * W, k[1] * H] for k in p['hands'][side]['kp']])
                if p['kp'][POSE[side]['wrist']][3] == 3:
                    continue
                x, y, s = cut_for(p['kp'], side, W, H)
                pic = crop(rgb, x, y, s)
                res = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(pic)))
                best, bd = None, 1e9
                wx, wy = p['kp'][POSE[side]['wrist']][0] * W, p['kp'][POSE[side]['wrist']][1] * H
                for hi, hand in enumerate(res.hand_landmarks):
                    d = np.hypot(x + hand[0].x * s - wx, y + hand[0].y * s - wy)
                    if d < bd:
                        best, bd = hi, d
                palm = max(1.0, float(np.hypot(*(gtk[9] - gtk[0]))))
                role = 'paddle' if hands_of.get(p['id']) == side else 'free'
                row = {'frame': fn, 'person': p['id'], 'side': side, 'role': role, 'phase': p['phase'],
                       'palm_px': palm, 'found': False}
                if best is not None and bd < s * 0.45:
                    pts = np.array([[x + q.x * s, y + q.y * s] for q in res.hand_landmarks[best]])
                    err = np.linalg.norm(pts - gtk, axis=1)
                    label = res.handedness[best][0].category_name.lower()
                    row.update(found=True, err_palm=float(np.median(err) / palm), wrist_px=float(err[0]),
                               named_ok=label == side)
                rows.append(row)

    def summ(sel):
        if not sel:
            return None
        found = [r for r in sel if r['found']]
        return {'n': len(sel), 'found_rate': round(len(found) / len(sel), 3),
                'median_err_palm': round(float(np.median([r['err_palm'] for r in found])), 3) if found else None,
                'median_wrist_px': round(float(np.median([r['wrist_px'] for r in found])), 1) if found else None,
                'handedness_ok': round(float(np.mean([r['named_ok'] for r in found])), 3) if found else None,
                'median_palm_px': round(float(np.median([r['palm_px'] for r in sel])), 1)}
    out = {'scene': os.path.basename(a.scene_dir.rstrip('/')), 'scale': a.scale, 'all': summ(rows),
           'by_role': {k: summ([r for r in rows if r['role'] == k]) for k in ('paddle', 'free')},
           'by_phase': {k: summ([r for r in rows if r['phase'] == k]) for k in ('ready', 'swing', 'serve', 'walk')}}
    print(json.dumps(out, indent=1))
    if a.json:
        json.dump({'summary': out, 'rows': rows}, open(a.json, 'w'))


if __name__ == '__main__':
    sys.exit(main())
