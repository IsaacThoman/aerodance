#!/usr/bin/env python3
"""Runs the three pseudo-GT reference models over a scene's frames (on the GPU, MPS).

  refs.py <scene-dir> <out.npz> [--limit N]

- Y: YOLO26x-pose (Ultralytics, AGPL: a local reference only, never shipped), one-stage. Its
  person boxes (conf >= 0.25) are the people the other two look at.
- V: ViTPose++-H (usyd-community/vitpose-plus-huge, Hugging Face transformers), COCO head
  (dataset_index 0), top-down on Y's boxes.
- W: RTMW-x (the 384x288 whole-body model, ~/wmyb-blender/models/rtmw-x-b8.onnx, run through
  onnx2torch), top-down on Y's boxes with rtmlib's pre-processing; body 17 + feet 6 kept.

Three architectures, three training mixes; top-down V and W share Y's boxes. Output arrays are
per detection (frame index, box, keypoints in source pixels with score). Run with the
sim2real reference venv ($TRACKBENCH_DATA/sim2real/.venv-ref) and `-I`.
"""
import glob
import os
import sys
import time

import cv2
import numpy as np
import onnx
import torch
from onnx2torch import convert
from PIL import Image
from rtmlib.tools.pose_estimation.pre_processings import bbox_xyxy2cs, top_down_affine
from transformers import AutoProcessor, VitPoseForPoseEstimation
from ultralytics import YOLO

S2R = os.environ.get('S2R', '/Volumes/development/aerodance-trackbench/sim2real')
RTMW = os.path.expanduser('~/wmyb-blender/models/rtmw-x-b8.onnx')
DEV = 'mps'
BATCH, SIZE = 8, (288, 384)
MEAN, STD = np.array([123.675, 116.28, 103.53]), np.array([58.395, 57.12, 57.375])


def main():
    scene, out = sys.argv[1], sys.argv[2]
    limit = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else None
    frames = sorted(glob.glob(os.path.join(scene, 'frames', '*.jpg')))[:limit]
    yolo = YOLO(os.path.join(S2R, 'ul', 'yolo26x-pose.pt'))
    proc = AutoProcessor.from_pretrained('usyd-community/vitpose-plus-huge')
    vit = VitPoseForPoseEstimation.from_pretrained('usyd-community/vitpose-plus-huge').to(DEV).eval()
    rtmw = convert(onnx.load(RTMW)).eval().to(DEV)

    rec = {'frame': [], 'box': [], 'y': [], 'v': [], 'w': []}
    t0 = time.time()
    for fi, path in enumerate(frames):
        bgr = cv2.imread(path)
        H, W = bgr.shape[:2]
        r = yolo(bgr, device=DEV, verbose=False, conf=0.25)[0]
        boxes = r.boxes.xyxy.cpu().numpy()
        bconf = r.boxes.conf.cpu().numpy()
        ykp = np.concatenate([r.keypoints.xy.cpu().numpy(), r.keypoints.conf.cpu().numpy()[..., None]], -1) if len(boxes) else np.zeros((0, 17, 3))
        keep = (boxes[:, 3] - boxes[:, 1]) >= 0.06 * H if len(boxes) else np.zeros(0, bool)
        boxes, bconf, ykp = boxes[keep], bconf[keep], ykp[keep]
        n = len(boxes)
        if not n:
            continue
        # ViTPose (boxes as x, y, w, h).
        img = Image.fromarray(bgr[..., ::-1])
        xywh = [[[float(b[0]), float(b[1]), float(b[2] - b[0]), float(b[3] - b[1])] for b in boxes]]
        inp = proc(img, boxes=xywh, return_tensors='pt').to(DEV)
        with torch.no_grad():
            o = vit(**inp, dataset_index=torch.zeros(n, dtype=torch.long, device=DEV))
        res = proc.post_process_pose_estimation(o, boxes=xywh)[0]
        vkp = np.stack([np.concatenate([q['keypoints'].cpu().numpy(), q['scores'].cpu().numpy()[:, None]], -1) for q in res])
        # RTMW-x (BGR, as rtmlib and the trackbench runner feed it).
        crops, cs = [], []
        for b in boxes:
            c, s = bbox_xyxy2cs(np.array(b[:4]), padding=1.25)
            crop, s = top_down_affine(SIZE, s, c, bgr)
            crops.append(((crop - MEAN) / STD).transpose(2, 0, 1).astype(np.float32))
            cs.append((c, s))
        wkp = []
        for a in range(0, n, BATCH):
            chunk = crops[a:a + BATCH]
            x = np.stack(chunk + [chunk[0]] * (BATCH - len(chunk)))
            with torch.no_grad():
                sx, sy = (t.float().cpu().numpy()[:len(chunk)] for t in rtmw(torch.from_numpy(x).to(DEV)))
            m, k, _ = sx.shape
            xi, yi = sx.reshape(m * k, -1).argmax(1), sy.reshape(m * k, -1).argmax(1)
            val = ((sx.reshape(m * k, -1).max(1) + sy.reshape(m * k, -1).max(1)) / 2).reshape(m, k)
            loc = np.stack([xi, yi], -1).astype(np.float32).reshape(m, k, 2) / 2.0
            for j in range(m):
                c, s = cs[a + j]
                p = loc[j] / np.array(SIZE) * s + c - s / 2
                wkp.append(np.concatenate([p[:23], val[j, :23, None]], -1))
        for i in range(n):
            rec['frame'].append(fi + 1)
            rec['box'].append(np.r_[boxes[i], bconf[i]])
            rec['y'].append(ykp[i])
            rec['v'].append(vkp[i])
            rec['w'].append(wkp[i])
        if (fi + 1) % 100 == 0:
            print(f'{os.path.basename(scene)} {fi + 1}/{len(frames)} {time.time() - t0:.0f}s', flush=True)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    np.savez_compressed(out + '.tmp.npz', frame=np.array(rec['frame'], np.int32), box=np.array(rec['box'], np.float32).reshape(-1, 5),
                        y=np.array(rec['y'], np.float32).reshape(-1, 17, 3), v=np.array(rec['v'], np.float32).reshape(-1, 17, 3),
                        w=np.array(rec['w'], np.float32).reshape(-1, 23, 3), width=W, height=H, n_frames=len(frames))
    os.replace(out + '.tmp.npz', out)
    print('done', scene, len(frames), 'frames', len(rec['frame']), 'people', f'{time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
