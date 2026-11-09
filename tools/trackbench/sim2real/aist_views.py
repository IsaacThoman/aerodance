#!/usr/bin/env python3
"""AIST camera geometry relative to the dancer, for picking real-aist sequences and placing twins.

  aist_views.py [seq ...]   -> prints, per sequence and camera, the view angle (camera direction
                               relative to the dancer's mean facing, CCW from above, 0 = frontal),
                               horizontal distance, lens height, and whether a 4:3 crop keeps the
                               dancer in the picture over the window.

Uses only the CC BY 4.0 AIST++ annotations (keypoints3d, cameras).
"""
import json
import math
import os
import pickle
import sys

import cv2
import numpy as np

AIST = os.environ.get('AIST_DIR', '/Volumes/development/aerodance-trackbench/downloads/aist')
WINDOW = (4.0, 19.0)  # seconds of the clip each real-aist sequence uses
C = np.array([[1.0, 0, 0], [0, 0, -1.0], [0, 1.0, 0]])  # AIST/SMPL y-up -> stage z-up (as blender/smpl.py)


def setting_of(seq):
    for line in open(os.path.join(AIST, 'cameras', 'mapping.txt')):
        a, b = line.split()
        if a == seq:
            return b
    raise KeyError(seq)


def cameras(seq):
    return {c['name']: c for c in json.load(open(os.path.join(AIST, 'cameras', setting_of(seq) + '.json')))}


def keypoints(seq):
    """(N, 17, 3) AIST world (cm, y up) at 60 fps; keypoints3d_optim."""
    k = pickle.load(open(os.path.join(AIST, 'keypoints3d', seq + '.pkl'), 'rb'))
    return np.asarray(k.get('keypoints3d_optim', k['keypoints3d']), float)


def project(kp, cam):
    """AIST world points (..., 3) -> pixel coordinates (..., 2) and camera depth (...), with the camera's lens distortion."""
    shp = kp.shape[:-1]
    pts = kp.reshape(-1, 3)
    rvec, tvec = np.array(cam['rotation'], float), np.array(cam['translation'], float)
    px, _ = cv2.projectPoints(pts, rvec, tvec, np.array(cam['matrix'], float), np.array(cam['distortions'], float))
    R, _ = cv2.Rodrigues(rvec)
    depth = (pts @ R.T + tvec)[:, 2]
    return px.reshape(*shp, 2), depth.reshape(shp)


def geometry(seq, cam, kp=None):
    kp = keypoints(seq) if kp is None else kp
    a, b = int(WINDOW[0] * 60), int(WINDOW[1] * 60)
    k = kp[a:b] / 100.0 @ C.T  # stage frame, metres
    hip = (k[:, 11] + k[:, 12]) / 2
    centre = hip.mean(0)
    left = (k[:, 5] - k[:, 6])  # subject's left shoulder minus right
    fwd = np.stack([-left[:, 1], left[:, 0]], -1)  # z-up: facing = up x left... rotate left by -90 deg
    # Facing is perpendicular to the shoulder line, toward the nose.
    nose = k[:, 0, :2] - (k[:, 5, :2] + k[:, 6, :2]) / 2
    sign = np.sign(np.sum(fwd * nose, 1, keepdims=True))
    fwd = fwd * np.where(sign == 0, 1, sign)
    f = fwd.mean(0)
    heading = math.atan2(f[1], f[0])
    R, _ = cv2.Rodrigues(np.array(cam['rotation'], float))
    cpos = (-R.T @ np.array(cam['translation'], float)) / 100.0 @ C.T
    d = cpos[:2] - centre[:2]
    view = math.degrees((math.atan2(d[1], d[0]) - heading + math.pi) % (2 * math.pi) - math.pi)
    floor = np.percentile(np.minimum(k[:, 15, 2], k[:, 16, 2]), 5) - 0.08  # ankles sit ~8 cm above the floor
    axis = R.T @ np.array([0, 0, 1.0]) @ C.T  # optical axis in stage frame
    pitch = math.degrees(math.atan2(axis[2], np.hypot(axis[0], axis[1])))
    px, _ = project(kp[a:b], cam)
    xs = px[..., 0]
    cx = float(np.clip(np.median(xs), 720, 1920 - 720))
    inside = float(np.mean((xs > cx - 720) & (xs < cx + 720) & (px[..., 1] > 0) & (px[..., 1] < 1080)))
    height_px = float(np.median(px[..., 1].max(1) - px[..., 1].min(1)))
    return {'view_deg': round(view, 1), 'distance_m': round(float(np.hypot(*d)), 2), 'cam_height_m': round(float(cpos[2] - floor), 2),
            'pitch_deg': round(pitch, 1), 'crop_cx': round(cx), 'inside_frac': round(inside, 4), 'person_h_frac': round(height_px / 1080, 3),
            'fx': cam['matrix'][0][0], 'travel_m': round(float(np.ptp(hip[:, 0]) + np.ptp(hip[:, 1])), 2)}


if __name__ == '__main__':
    seqs = sys.argv[1:] or sorted(f[:-4] for f in os.listdir(os.path.join(AIST, 'motions')) if '_sFM_' in f)
    for s in seqs:
        kp = keypoints(s)
        for name, cam in sorted(cameras(s).items()):
            g = geometry(s, cam, kp)
            print(s, name, json.dumps(g))
