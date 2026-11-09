"""Agreement of MediaPipe Pose Landmarker Lite (the game's model) with the GT of a rendered scene.

$TRACKBENCH_DATA/.venv/bin/python tools/trackbench/blender/checks/mp_check.py <scene_dir> [--json out]
    [--src frames|render] [--every 1]

Runs Lite in VIDEO mode on the whole frame asking for as many people as the GT has in view (max
of the scene), matches detections to GT people (Hungarian on torso distance), and reports per
joint, on frames where GT says the joint is visible (vis 0) and MediaPipe's confidence
(min(visibility, presence)) is >= 0.5:
  - median error in GT torso lengths (shoulder midpoint to hip midpoint, in pixels);
  - mean signed offset (x, y) in torso lengths (definition differences show up here);
  - L/R swap rate: frames where swapping the left/right labels of a pair fits clearly better;
and per scored limb (docs/scoring.md) the median angle between MediaPipe's and GT's 2D direction.
This is a sanity check of the GT, not a benchmark (the harness does that).
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment

DATA = os.environ.get('TRACKBENCH_DATA', '/Volumes/development/aerodance-trackbench')
MODEL = os.path.join(DATA, 'models', 'pose_landmarker_lite.task')
NAMES = ['nose', 'l_eye_in', 'l_eye', 'l_eye_out', 'r_eye_in', 'r_eye', 'r_eye_out', 'l_ear', 'r_ear',
         'mouth_l', 'mouth_r', 'l_shoulder', 'r_shoulder', 'l_elbow', 'r_elbow', 'l_wrist', 'r_wrist',
         'l_pinky', 'r_pinky', 'l_index', 'r_index', 'l_thumb', 'r_thumb', 'l_hip', 'r_hip', 'l_knee',
         'r_knee', 'l_ankle', 'r_ankle', 'l_heel', 'r_heel', 'l_foot_index', 'r_foot_index']
PAIRS = [(1, 4), (2, 5), (3, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16), (17, 18), (19, 20), (21, 22),
         (23, 24), (25, 26), (27, 28), (29, 30), (31, 32)]
LIMBS = {'l_upperarm': (11, 13), 'l_forearm': (13, 15), 'r_upperarm': (12, 14), 'r_forearm': (14, 16),
         'l_thigh': (23, 25), 'l_shin': (25, 27), 'r_thigh': (24, 26), 'r_shin': (26, 28),
         'torso': ('sh', 'hip'), 'shoulders': (11, 12)}


def run_mp(scene_dir, src, n_people, every):
    import mediapipe as mp
    from mediapipe.tasks import python as mpt
    from mediapipe.tasks.python import vision
    opts = vision.PoseLandmarkerOptions(
        base_options=mpt.BaseOptions(model_asset_path=MODEL),
        running_mode=vision.RunningMode.VIDEO, num_poses=n_people,
        min_pose_detection_confidence=0.5, min_pose_presence_confidence=0.5, min_tracking_confidence=0.5)
    det = vision.PoseLandmarker.create_from_options(opts)
    meta = json.load(open(os.path.join(scene_dir, 'meta.json')))
    fps = meta['fps']
    out = {}
    for f in range(1, meta['frame_count'] + 1, every):
        p = os.path.join(scene_dir, 'frames', f'{f:06d}.jpg') if src == 'frames' else \
            os.path.join(scene_dir, 'render', f'{f:06d}.png')
        if not os.path.exists(p):
            continue
        img = cv2.cvtColor(cv2.imread(p), cv2.COLOR_BGR2RGB)
        r = det.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=img), int(round((f - 1) * 1000 / fps)))
        people = []
        for lm in r.pose_landmarks:
            people.append(np.array([[l.x, l.y, min(l.visibility, l.presence)] for l in lm]))
        out[f] = people
    return out, meta


def torso(kp, W, H):
    sh = (kp[11, :2] + kp[12, :2]) / 2
    hp = (kp[23, :2] + kp[24, :2]) / 2
    return np.linalg.norm((sh - hp) * [W, H]), sh, hp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('scene_dir')
    ap.add_argument('--json')
    ap.add_argument('--src', default='frames')
    ap.add_argument('--every', type=int, default=1)
    ap.add_argument('--num-poses', type=int)
    a = ap.parse_args()
    gts = {}
    with open(os.path.join(a.scene_dir, 'gt.jsonl')) as f:
        for line in f:
            d = json.loads(line)
            gts[d['frame']] = d
    n_people = a.num_poses or max(len(d['people']) for d in gts.values())
    dets, meta = run_mp(a.scene_dir, a.src, n_people, a.every)
    W, H = meta['resolution']
    err = {j: [] for j in range(33)}
    off = {j: [] for j in range(33)}
    swaps = {p: [0, 0] for p in PAIRS}
    limb_err = {k: [] for k in LIMBS}
    found = total = 0
    for f, people in dets.items():
        g = [p for p in gts[f]['people'] if p['in_frame']]
        gk = [np.array([[np.nan if v is None else v for v in k] for k in p['kp']], float) for p in g]
        total += len(g)
        if not g or not people:
            continue
        C = np.zeros((len(g), len(people)))
        for i, k in enumerate(gk):
            t, sh, hp = torso(k, W, H)
            for j, d in enumerate(people):
                _, dsh, dhp = torso(d, W, H)
                C[i, j] = (np.linalg.norm((dsh - sh) * [W, H]) + np.linalg.norm((dhp - hp) * [W, H])) / max(t, 1)
        rows, cols = linear_sum_assignment(C)
        for i, j in zip(rows, cols):
            if C[i, j] > 1.0:
                continue
            found += 1
            k, d = gk[i], people[j]
            t, _, _ = torso(k, W, H)
            if t < 5:
                continue
            ok = (k[:, 3] == 0) & (d[:, 2] >= 0.5)
            dv = (d[:, :2] - k[:, :2]) * [W, H] / t
            for jj in range(33):
                if ok[jj]:
                    err[jj].append(float(np.linalg.norm(dv[jj])))
                    off[jj].append(dv[jj].tolist())
            for (l, r) in PAIRS:
                if ok[l] and ok[r]:
                    same = np.linalg.norm((d[l, :2] - k[l, :2]) * [W, H]) + np.linalg.norm((d[r, :2] - k[r, :2]) * [W, H])
                    sw = np.linalg.norm((d[l, :2] - k[r, :2]) * [W, H]) + np.linalg.norm((d[r, :2] - k[l, :2]) * [W, H])
                    swaps[(l, r)][1] += 1
                    if sw < same - 0.15 * t:
                        swaps[(l, r)][0] += 1

            def pt(arr, x):
                if x == 'sh':
                    return (arr[11, :2] + arr[12, :2]) / 2
                if x == 'hip':
                    return (arr[23, :2] + arr[24, :2]) / 2
                return arr[x, :2]
            for name, (x, y) in LIMBS.items():
                need = [11, 12, 23, 24] if name == 'torso' else [x, y]
                if all(ok[n] for n in need):
                    u = (pt(k, y) - pt(k, x)) * [W, H]
                    v = (pt(d, y) - pt(d, x)) * [W, H]
                    c = np.dot(u, v) / (np.linalg.norm(u) * np.linalg.norm(v) + 1e-9)
                    limb_err[name].append(float(np.degrees(np.arccos(np.clip(c, -1, 1)))))
    rep = {'scene': os.path.basename(os.path.normpath(a.scene_dir)), 'frames': len(dets),
           'people_found_frac': round(found / max(total, 1), 3), 'joints': {}, 'swaps': {}, 'limbs_deg': {}}
    print(f"{rep['scene']}: {len(dets)} frames, found {found}/{total} GT people-frames in view")
    print(f"{'joint':14s} {'n':>5s} {'median':>7s} {'p90':>6s} {'mean dx':>8s} {'mean dy':>8s}  (torso lengths)")
    for j in range(33):
        if not err[j]:
            continue
        e = np.array(err[j])
        o = np.array(off[j]).mean(0)
        rep['joints'][NAMES[j]] = {'n': len(e), 'median': round(float(np.median(e)), 3),
                                   'p90': round(float(np.percentile(e, 90)), 3),
                                   'mean_dx': round(float(o[0]), 3), 'mean_dy': round(float(o[1]), 3)}
        print(f'{NAMES[j]:14s} {len(e):5d} {np.median(e):7.3f} {np.percentile(e, 90):6.3f} {o[0]:8.3f} {o[1]:8.3f}')
    print('L/R swaps (swapped labels fit better by > 0.15 torso):')
    for (l, r), (s, n) in swaps.items():
        if n:
            rep['swaps'][f'{NAMES[l]}/{NAMES[r]}'] = [s, n]
    print('  ' + ', '.join(f'{k} {v[0]}/{v[1]}' for k, v in rep['swaps'].items()))
    print('limb direction error (deg, median / p90):')
    for k, v in limb_err.items():
        if v:
            rep['limbs_deg'][k] = {'median': round(float(np.median(v)), 1), 'p90': round(float(np.percentile(v, 90)), 1), 'n': len(v)}
    print('  ' + ', '.join(f"{k} {v['median']}/{v['p90']}" for k, v in rep['limbs_deg'].items()))
    if a.json:
        json.dump(rep, open(a.json, 'w'), indent=1)


if __name__ == '__main__':
    sys.exit(main())
