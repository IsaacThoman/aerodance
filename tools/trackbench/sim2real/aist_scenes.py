#!/usr/bin/env python3
"""real-aist scenes: AIST Dance DB video + AIST++ keypoints3d projected through the camera.

  aist_scenes.py [id ...]   -> $S2R/aist/scenes/real-aist-<id>/ (frames, gt.jsonl, spec.json, meta.json, READY)
                               and prints each sequence's twin camera (used by aist_twins.py)

Frames: video frames 240, 242, ... (clip seconds 4-19 at 30 fps) cropped to a 4:3 window that
holds the dancer for the whole window (960x720 if they fit with margin, else 1200x900 or
1440x1080), scaled to 640x480. GT: keypoints3d_optim (COCO-17, triangulated from all nine
views and smoothed) projected with the camera's intrinsics, extrinsics and lens distortion,
mapped through the crop, in pose-33 slots; unmapped slots are filled from neighbours and
flagged `pgt_ok` 0 so the keypoint metrics ignore them. `vis` 3 outside the picture, else 0
(self-occlusion unknown). `kp3d` the keypoints in metres (stage axes), depth the camera depth,
so the harness's torso scale is the projected 3D torso, as for trackbench's own GT.
"""
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import aist_views as av  # noqa: E402

S2R = os.environ.get('S2R', '/Volumes/development/aerodance-trackbench/sim2real')
VIDEOS = os.environ.get('AIST_VIDEO', '/Volumes/development/aerodance-trackbench/downloads/aist-video')
CFG = json.load(open(os.path.join(HERE, 'aist.json')))
COCO_TO_33 = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
FILL = {1: 2, 3: 2, 4: 5, 6: 5, 9: 0, 10: 0, 17: 15, 19: 15, 21: 15, 18: 16, 20: 16, 22: 16, 29: 27, 31: 27, 30: 28, 32: 28}


def choose_crop(px):
    """A 4:3 crop (x0, y0, w, h) in 1920x1080 holding every projected keypoint with a margin."""
    xs, ys = px[..., 0], px[..., 1]
    for w in (960, 1200, 1440):
        h = w * 3 // 4
        x0 = float(np.clip((np.percentile(xs, 0.5) + np.percentile(xs, 99.5)) / 2 - w / 2, 0, 1920 - w))
        top, bot = np.min(ys), np.max(ys)
        y0 = float(np.clip((top + bot) / 2 - h / 2, 0, 1080 - h))
        mx, my = 0.04 * w, 0.04 * h
        inside = np.mean((xs > x0 + mx) & (xs < x0 + w - mx) & (ys > y0 + my) & (ys < y0 + h - my))
        if inside >= 0.999 or w == 1440:
            return int(round(x0)), int(round(y0)), w, h, float(inside)


def make(entry):
    seq, camname = entry['seq'], entry['cam']
    cam = av.cameras(seq)[camname]
    kp = av.keypoints(seq)
    start, n = int(CFG['start_s'] * 60), int(CFG['duration_s'] * 30)
    idx = start + 2 * np.arange(n)
    px, depth = av.project(kp[idx], cam)
    x0, y0, w, h, inside = choose_crop(px)
    s = 640 / w
    sid = 'real-aist-' + entry['id']
    out = os.path.join(S2R, 'aist', 'scenes', sid)
    os.makedirs(os.path.join(out, 'frames'), exist_ok=True)
    video = os.path.join(VIDEOS, seq.replace('cAll', camname) + '.mp4')
    cap = cv2.VideoCapture(video)
    i, k = 0, 0
    want = set(idx.tolist())
    while k < n:
        ok, img = cap.read()
        if not ok:
            raise RuntimeError(f'{video}: ran out at frame {i}')
        if i in want:
            k += 1
            crop = cv2.resize(img[y0:y0 + h, x0:x0 + w], (640, 480), interpolation=cv2.INTER_AREA)
            Image.fromarray(crop[..., ::-1]).save(os.path.join(out, 'frames', f'{k:06d}.jpg'), quality=95)
        i += 1
    kst = kp[idx] / 100.0 @ av.C.T  # metres, stage axes
    with open(os.path.join(out, 'gt.jsonl'), 'w') as g:
        for f in range(n):
            xy = (px[f] - [x0, y0]) * s / [640, 480]
            slots = np.zeros((33, 2))
            slots[COCO_TO_33] = xy
            d33 = np.zeros(33)
            d33[COCO_TO_33] = depth[f] / 100.0
            k3 = np.zeros((33, 3))
            k3[COCO_TO_33] = kst[f]
            for dst, src in FILL.items():
                slots[dst], d33[dst], k3[dst] = slots[src], d33[src], k3[src]
            ok = np.zeros(33, int)
            ok[COCO_TO_33] = 1
            inside_pt = (slots[:, 0] >= 0) & (slots[:, 0] <= 1) & (slots[:, 1] >= 0) & (slots[:, 1] <= 1)
            kpl = [[round(float(a), 5), round(float(b), 5), round(float(z), 4), 0 if ins else 3] for (a, b), z, ins in zip(slots, d33, inside_pt)]
            bx0, by0 = xy.min(0)
            bx1, by1 = xy.max(0)
            mh = 0.08 * (by1 - by0)
            bbox = [float(np.clip(v, 0, 1)) for v in (bx0 - mh * 0.75, by0 - mh * 1.5, bx1 + mh * 0.75, by1 + mh)]
            person = {'id': 'p1', 'role': 'player', 'index': 0, 'kp': kpl, 'kp3d': np.round(k3, 4).tolist(),
                      'bbox': [round(v, 5) for v in bbox], 'visible_frac': None, 'in_frame': bool(inside_pt[COCO_TO_33].any()),
                      'phase': 'dance', 'pgt_ok': ok.tolist()}
            g.write(json.dumps({'frame': f + 1, 't_ms': round(f * 1000 / 30, 3), 'people': [person]}) + '\n')
    K = np.array(cam['matrix'], float)
    geo = av.geometry(seq, cam, kp)
    spec = {'id': sid, 'category': 'sim2real-aist', 'description': f'AIST Dance DB {seq} camera {camname} ({entry["view"]}), clip {CFG["start_s"]}-{CFG["start_s"] + CFG["duration_s"]} s',
            'fps': 30, 'duration_s': CFG['duration_s'], 'resolution': [640, 480], 'players': 1,
            'camera': {'orientation': 'landscape'}, 'room': {'features': []},
            'phases': [{'name': 'dance', 'start_s': 0, 'end_s': CFG['duration_s']}]}
    meta = {'id': sid, 'fps': 30, 'frame_count': n, 'resolution': [640, 480],
            'camera': {'width': 640, 'height': 480, 'K': [[K[0][0] * s, 0, (K[0][2] - x0) * s], [0, K[1][1] * s, (K[1][2] - y0) * s], [0, 0, 1]],
                       'distortions': cam['distortions'], 'note': 'AIST camera through the crop/scale; GT projected with lens distortion'},
            'source': {'video': os.path.basename(video), 'seq': seq, 'camera': camname, 'view': entry['view'], 'video_frames': [int(idx[0]), int(idx[-1]), 2],
                       'crop': [x0, y0, w, h], 'crop_inside_frac': round(inside, 4), 'geometry': geo},
            'gt': 'AIST++ keypoints3d_optim (CC BY 4.0) projected; COCO-17 conventions'}
    json.dump(spec, open(os.path.join(out, 'spec.json'), 'w'), indent=1)
    json.dump(meta, open(os.path.join(out, 'meta.json'), 'w'), indent=1)
    open(os.path.join(out, 'READY'), 'w').close()
    # The twin camera: same height, distance and view angle; FOV of the crop; aimed so the crop centre's ray matches.
    R, _ = cv2.Rodrigues(np.array(cam['rotation'], float))
    vc = y0 + h / 2
    pitch_c = geo['pitch_deg'] - np.degrees(np.arctan((vc - K[1][2]) / K[1][1]))
    twin = {'height_m': geo['cam_height_m'], 'distance_m': geo['distance_m'], 'yaw_deg': geo['view_deg'],
            'hfov_deg': round(float(np.degrees(2 * np.arctan(w / 2 / K[0][0]))), 2),
            'look_at_z': round(float(geo['cam_height_m'] + geo['distance_m'] * np.tan(np.radians(pitch_c))), 3)}
    print(json.dumps({'id': entry['id'], 'crop': [x0, y0, w, h], 'inside': round(inside, 4), 'twin_camera': twin}))
    return twin


if __name__ == '__main__':
    ids = sys.argv[1:]
    cams = {}
    for e in CFG['sequences']:
        if ids and e['id'] not in ids:
            continue
        cams[e['id']] = make(e)
    path = os.path.join(HERE, 'aist_cameras.json')
    old = json.load(open(path)) if os.path.exists(path) else {}
    old.update(cams)
    json.dump(old, open(path, 'w'), indent=1)
