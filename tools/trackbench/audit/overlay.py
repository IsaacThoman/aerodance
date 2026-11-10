#!/usr/bin/env python3
"""Contact sheets of estimator detections over the frame, with GT, for eyeballing mappings.

  overlay.py <scene> [--estimators a,b,...] [--frames 200,400] [--crop] [--out DIR] [--gt-only]

GT is white (thin). Detections: subject-left limbs orange, subject-right limbs cyan, centre
limbs yellow; filled dots are joints with conf >= 0.5, hollow ones below it. Joints a runner
wrote at exactly (0, 0) are drawn as a red cross at the corner (placeholders, not detections).
"""
import argparse
import json
import os
from pathlib import Path

import cv2
import numpy as np

DATA = Path(os.environ.get('TRACKBENCH_DATA', '/Volumes/development/aerodance-trackbench'))
DEFAULT = ['mp-lite-game', 'mp-full-game', 'mp-heavy-game', 'rtmo-s', 'rtmpose-s', 'movenet-multipose', 'apple-vision']
LEFT = [(11, 13), (13, 15), (23, 25), (25, 27), (27, 29), (27, 31), (15, 17), (15, 19), (15, 21), (2, 7)]
RIGHT = [(12, 14), (14, 16), (24, 26), (26, 28), (28, 30), (28, 32), (16, 18), (16, 20), (16, 22), (5, 8)]
MID = [(11, 12), (23, 24), (11, 23), (12, 24), (0, 2), (0, 5)]
ALL = LEFT + RIGHT + MID


def read_jsonl(path):
    return {r['frame']: r for r in map(json.loads, open(path)) if r}


def draw_pose(img, kp, w, h, colours, thick=2, gate=0.5, radius=3):
    def pt(j):
        k = kp[j]
        return None if k is None else (int(round(k[0] * w)), int(round(k[1] * h)))
    for edges, colour in colours:
        for a, b in edges:
            pa, pb = pt(a), pt(b)
            if pa and pb and kp[a][:2] != [0, 0] and kp[b][:2] != [0, 0]:
                cv2.line(img, pa, pb, colour, thick, cv2.LINE_AA)
    for j, k in enumerate(kp):
        if k is None:
            continue
        p = pt(j)
        if k[0] == 0 and k[1] == 0:
            cv2.drawMarker(img, (4, 4), (0, 0, 255), cv2.MARKER_TILTED_CROSS, 8, 1)
            continue
        conf = k[3] if len(k) > 3 and k[3] is not None else 1
        colour = (0, 160, 255) if j in {a for e in LEFT for a in e} else (255, 220, 0) if j in {a for e in RIGHT for a in e} else (0, 255, 255)
        cv2.circle(img, p, radius, colour, -1 if conf >= gate else 1, cv2.LINE_AA)


def gt_overlay(img, gt, w, h):
    for person in gt['people']:
        kp = [[k[0], k[1], 0, 1] for k in person['kp']]
        draw_pose(img, kp, w, h, [(ALL, (255, 255, 255))], thick=1, radius=2)
        if person.get('bbox'):
            x0, y0, x1, y1 = person['bbox']
            cv2.rectangle(img, (int(x0 * w), int(y0 * h)), (int(x1 * w), int(y1 * h)), (90, 90, 90), 1)


def tile(scene, est, frame, crop, gt_rows):
    img = cv2.imread(str(DATA / 'scenes' / scene / 'frames' / f'{frame:06d}.jpg'))
    h, w = img.shape[:2]
    gt = gt_rows.get(frame)
    if gt:
        gt_overlay(img, gt, w, h)
    label = est or 'GT'
    if est:
        det = read_jsonl(DATA / 'runs' / est / scene / 'detections.jsonl').get(frame)
        if det is None:
            label += ' (no line)'
        else:
            for p in det['people']:
                draw_pose(img, p['kp'], w, h, [(LEFT, (0, 160, 255)), (RIGHT, (255, 220, 0)), (MID, (0, 255, 255))])
            label += f" n={len(det['people'])}"
    if crop and gt and gt['people']:
        boxes = [p['bbox'] for p in gt['people'] if p.get('bbox')]
        if boxes:
            x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
            x1, y1 = max(b[2] for b in boxes), max(b[3] for b in boxes)
            pad = 0.08
            X0, Y0 = max(0, int((x0 - pad) * w)), max(0, int((y0 - pad) * h))
            X1, Y1 = min(w, int((x1 + pad) * w)), min(h, int((y1 + pad) * h))
            img = img[Y0:Y1, X0:X1]
            s = 360 / img.shape[0]
            img = cv2.resize(img, (int(img.shape[1] * s), 360), interpolation=cv2.INTER_CUBIC)
    else:
        s = 360 / img.shape[0]
        img = cv2.resize(img, (int(img.shape[1] * s), 360))
    cv2.rectangle(img, (0, 0), (img.shape[1], 18), (0, 0, 0), -1)
    cv2.putText(img, f'{label} f{frame}', (3, 13), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1, cv2.LINE_AA)
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('scene')
    ap.add_argument('--estimators', default=','.join(DEFAULT))
    ap.add_argument('--frames', default='')
    ap.add_argument('--crop', action='store_true')
    ap.add_argument('--gt-only', action='store_true')
    ap.add_argument('--out', default=str(DATA / 'audit'))
    args = ap.parse_args()
    gt_rows = read_jsonl(DATA / 'scenes' / args.scene / 'gt.jsonl')
    n = max(gt_rows)
    frames = [int(f) for f in args.frames.split(',')] if args.frames else [int(n * q) for q in (0.45, 0.65, 0.85)]
    ests = [''] if args.gt_only else args.estimators.split(',')
    rows = []
    for est in ests:
        tiles = [tile(args.scene, est, f, args.crop, gt_rows) for f in frames]
        hmax = max(t.shape[0] for t in tiles)
        rows.append(np.hstack([cv2.copyMakeBorder(t, 0, hmax - t.shape[0], 0, 2, cv2.BORDER_CONSTANT) for t in tiles]))
    wmax = max(r.shape[1] for r in rows)
    sheet = np.vstack([cv2.copyMakeBorder(r, 0, 2, 0, wmax - r.shape[1], cv2.BORDER_CONSTANT) for r in rows])
    out = Path(args.out) / f"overlay-{args.scene}{'-gt' if args.gt_only else ''}.jpg"
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), sheet, [cv2.IMWRITE_JPEG_QUALITY, 88])
    print(out)


if __name__ == '__main__':
    main()
