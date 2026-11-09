"""GT overlays: preview.mp4 and contact sheets. Runs in the trackbench venv (numpy, opencv).

python preview.py <scene_dir> [--video] [--sheet out.jpg --frames 1,30,60 | --every 15] [--src render|frames]
    [--mask] [--zoom]

Hands (hand-21 GT, table-tennis scenes): left hand orange, right hand blue lines, fingertips white;
the paddle's centre and forehand normal in green. `--hands out.jpg` makes close-ups of every hand.

Skeleton colours: person's left side orange, right side blue, centre white. Joint markers: filled
circle = visible (0), hollow = self-occluded (1), x = occluded by another person/object (2);
out-of-frame points (3) aren't drawn. The bbox is drawn in the person's colour.
"""
import argparse
import glob
import json
import os
import subprocess
import sys

import cv2
import numpy as np

EDGES = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24), (23, 25), (25, 27),
         (24, 26), (26, 28), (27, 29), (29, 31), (27, 31), (28, 30), (30, 32), (28, 32), (15, 17), (15, 19),
         (15, 21), (17, 19), (16, 18), (16, 20), (16, 22), (18, 20), (0, 2), (0, 5), (2, 7), (5, 8), (9, 10),
         (1, 2), (2, 3), (4, 5), (5, 6)]
LEFT = {1, 2, 3, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31}
RIGHT = {4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32}
PERSON_COLORS = [(80, 220, 80), (220, 80, 220), (80, 220, 220), (220, 220, 80), (160, 120, 255), (255, 160, 120)]
MASK_COLORS = np.array([(0, 0, 0)] + [c for c in PERSON_COLORS] * 3, np.uint8)


HAND_EDGES = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11), (11, 12),
              (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (0, 17), (17, 18), (18, 19), (19, 20)]
HAND_COLORS = {'left': (0, 200, 255), 'right': (255, 170, 60)}


def load_gt(scene_dir):
    out = {}
    with open(os.path.join(scene_dir, 'gt.jsonl')) as f:
        for line in f:
            d = json.loads(line)
            out[d['frame']] = d
    return out


def side_color(j):
    return (0, 140, 255) if j in LEFT else ((255, 120, 0) if j in RIGHT else (255, 255, 255))


def project_cam(meta, f, P, W, H):
    """Stage points (N, 3) -> pixel coordinates in a W x H picture, with frame f's camera."""
    if not meta:
        return None
    M = np.array(meta['camera_to_world'].get(str(f)) or next(iter(meta['camera_to_world'].values()))).reshape(4, 4)
    K = np.array(meta['camera']['K'])
    c = (np.asarray(P, float) - M[:3, 3]) @ M[:3, :3]
    sx, sy = W / meta['camera']['width'], H / meta['camera']['height']
    x = (K[0, 2] + K[0, 0] * c[:, 0] / -c[:, 2]) * sx
    y = (K[1, 2] - K[1, 1] * c[:, 1] / -c[:, 2]) * sy
    return np.stack([x, y], 1)


def draw_hands(img, p, scale=1, meta=None, f=None):
    """Hand-21 points (filled = visible, hollow = self-occluded, red x = behind the paddle or
    another person) and the paddle's centre and face normal (10 cm, the forehand side)."""
    H, W = img.shape[:2]
    for side, hd in (p.get('hands') or {}).items():
        kp = hd['kp']
        col = HAND_COLORS[side]
        pts = {i: (int(round(k[0] * W)), int(round(k[1] * H))) for i, k in enumerate(kp) if k[0] is not None and k[3] != 3}
        for a, b in HAND_EDGES:
            if a in pts and b in pts:
                cv2.line(img, pts[a], pts[b], col, 1, cv2.LINE_AA)
        for i, pt in pts.items():
            v = kp[i][3]
            r = max(1, scale) + (1 if i == 0 else 0)
            if v == 0:
                cv2.circle(img, pt, r, (255, 255, 255) if i in (4, 8, 12, 16, 20) else col, -1, cv2.LINE_AA)
            elif v == 1:
                cv2.circle(img, pt, r + 1, col, 1, cv2.LINE_AA)
            else:
                d = r + 1
                cv2.line(img, (pt[0] - d, pt[1] - d), (pt[0] + d, pt[1] + d), (0, 0, 255), 1)
                cv2.line(img, (pt[0] - d, pt[1] + d), (pt[0] + d, pt[1] - d), (0, 0, 255), 1)
    pad = p.get('paddle')
    if pad and meta is not None:
        c = np.array(pad['center'])
        uv = project_cam(meta, f, np.stack([c, c + 0.1 * np.array(pad['normal'])]), W, H)
        a, b = tuple(int(v) for v in uv[0]), tuple(int(v) for v in uv[1])
        cv2.circle(img, a, 3 * max(1, scale), (60, 255, 60), 1, cv2.LINE_AA)
        cv2.arrowedLine(img, a, b, (60, 255, 60), 1, cv2.LINE_AA, tipLength=0.25)


def draw(img, gtf, mask=None, scale=1, meta=None):
    H, W = img.shape[:2]
    if mask is not None:
        m = MASK_COLORS[np.minimum(mask, len(MASK_COLORS) - 1)]
        sel = mask > 0
        img[sel] = (0.55 * img[sel] + 0.45 * m[sel]).astype(np.uint8)
    for p in gtf['people']:
        kp = p['kp']
        pc = PERSON_COLORS[p['index'] % len(PERSON_COLORS)]
        if p.get('bbox'):
            x0, y0, x1, y1 = p['bbox']
            cv2.rectangle(img, (int(x0 * W), int(y0 * H)), (int(x1 * W) - 1, int(y1 * H) - 1), pc, 1)
            cv2.putText(img, f"{p['id']} {p['phase']} vf={p['visible_frac']}", (int(x0 * W), max(10, int(y0 * H) - 3)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.35 * scale, pc, 1, cv2.LINE_AA)
        pts = {j: (int(round(k[0] * W)), int(round(k[1] * H))) for j, k in enumerate(kp)
               if k[0] is not None and k[3] != 3}
        for a, b in EDGES:
            if a in pts and b in pts:
                col = side_color(a) if (a in LEFT) == (b in LEFT) and (a in RIGHT) == (b in RIGHT) else (255, 255, 255)
                cv2.line(img, pts[a], pts[b], col, max(1, scale), cv2.LINE_AA)
        for j, pt in pts.items():
            v = kp[j][3]
            col = side_color(j)
            r = 2 * scale + (1 if j in (11, 12, 23, 24) else 0)
            if v == 0:
                cv2.circle(img, pt, r, col, -1, cv2.LINE_AA)
            elif v == 1:
                cv2.circle(img, pt, r + 1, col, 1, cv2.LINE_AA)
            elif v == 2:
                d = r + 1
                cv2.line(img, (pt[0] - d, pt[1] - d), (pt[0] + d, pt[1] + d), (0, 0, 255), 1)
                cv2.line(img, (pt[0] - d, pt[1] + d), (pt[0] + d, pt[1] - d), (0, 0, 255), 1)
        draw_hands(img, p, scale, meta, gtf['frame'])
    return img


def load_meta(scene_dir):
    p = os.path.join(scene_dir, 'meta.json')
    if os.path.exists(p):
        return json.load(open(p))
    parts = sorted(glob.glob(os.path.join(scene_dir, 'meta.parts', '*.json')))
    if not parts:
        return None
    m = json.load(open(parts[0]))
    for q in parts[1:]:
        m['camera_to_world'].update(json.load(open(q))['camera_to_world'])
    return m


def load_gt_any(scene_dir):
    if os.path.exists(os.path.join(scene_dir, 'gt.jsonl')):
        return load_gt(scene_dir)
    out = {}
    for q in sorted(glob.glob(os.path.join(scene_dir, 'gt.parts', '*.jsonl'))):
        for line in open(q):
            d = json.loads(line)
            out[d['frame']] = d
    return out


def hand_sheet(scene_dir, frames, out, src='frames', cols=6, size=240):
    """Square crops round every visible hand (3x the hand's extent, like the game's cut for the
    Hand Landmarker), drawn on at 4x, one tile per hand."""
    gts = load_gt_any(scene_dir)
    meta = load_meta(scene_dir)
    tiles = []
    for f in frames:
        img = frame_image(scene_dir, f, src)
        if img is None or f not in gts:
            continue
        H, W = img.shape[:2]
        for p in gts[f]['people']:
            for side, hd in (p.get('hands') or {}).items():
                xy = np.array([[k[0] * W, k[1] * H] for k in hd['kp'] if k[3] != 3])
                if len(xy) < 5:
                    continue
                c = xy.mean(0)
                half = max(12, 1.5 * float(np.max(xy.max(0) - xy.min(0))))
                x0, y0 = int(c[0] - half), int(c[1] - half)
                n = int(2 * half)
                big = cv2.resize(img, (W * 4, H * 4), interpolation=cv2.INTER_CUBIC)
                q = dict(p)
                q['hands'] = {side: hd}
                if q.get('paddle') and q['paddle']['hand'] != side:
                    q.pop('paddle')
                draw_hands(big, q, 2, meta, f)
                crop = np.zeros((4 * n, 4 * n, 3), np.uint8)
                ys, xs = slice(max(0, 4 * y0), min(4 * H, 4 * (y0 + n))), slice(max(0, 4 * x0), min(4 * W, 4 * (x0 + n)))
                part = big[ys, xs]
                crop[ys.start - 4 * y0:ys.start - 4 * y0 + part.shape[0], xs.start - 4 * x0:xs.start - 4 * x0 + part.shape[1]] = part
                t = cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA)
                cv2.putText(t, f"#{f} {p['id']} {side[0]} {p['phase']}", (4, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1)
                tiles.append(t)
    if not tiles:
        print('no hands')
        return
    rows = []
    for i in range(0, len(tiles), cols):
        r = tiles[i:i + cols] + [np.zeros_like(tiles[0])] * (cols - len(tiles[i:i + cols]))
        rows.append(np.hstack(r))
    cv2.imwrite(out, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 90])
    print(out)


def frame_image(scene_dir, f, src):
    if src == 'frames':
        p = os.path.join(scene_dir, 'frames', f'{f:06d}.jpg')
        if os.path.exists(p):
            return cv2.imread(p)
    return cv2.imread(os.path.join(scene_dir, 'render', f'{f:06d}.png'))


def read_mask(scene_dir, f):
    p = os.path.join(scene_dir, 'masks', f'{f:06d}.png')
    return cv2.imread(p, cv2.IMREAD_UNCHANGED) if os.path.exists(p) else None


def sheet(scene_dir, frames, out, src='frames', with_mask=False, cols=4, zoom=False):
    gts = load_gt_any(scene_dir)
    meta = load_meta(scene_dir)
    tiles = []
    for f in frames:
        img = frame_image(scene_dir, f, src)
        if img is None or f not in gts:
            continue
        mask = read_mask(scene_dir, f) if with_mask else None
        scale = 1
        if zoom and gts[f]['people']:
            # crop around everyone's bbox, upscale 2x
            H, W = img.shape[:2]
            bx = [p['bbox'] for p in gts[f]['people'] if p.get('bbox')]
            if bx:
                x0 = max(0, int(min(b[0] for b in bx) * W) - 20)
                x1 = min(W, int(max(b[2] for b in bx) * W) + 20)
                y0 = max(0, int(min(b[1] for b in bx) * H) - 20)
                y1 = min(H, int(max(b[3] for b in bx) * H) + 20)
                img = cv2.resize(img, (W * 2, H * 2), interpolation=cv2.INTER_CUBIC)
                if mask is not None:
                    mask = cv2.resize(mask, (W * 2, H * 2), interpolation=cv2.INTER_NEAREST)
                img = draw(img, gts[f], mask, scale=2, meta=meta)[y0 * 2:y1 * 2, x0 * 2:x1 * 2]
                img = cv2.resize(img, (int(img.shape[1] * 480 / img.shape[0]), 480))
                cv2.putText(img, f'#{f}', (5, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
                tiles.append(img)
                continue
        img = draw(img, gts[f], mask, scale, meta=meta)
        cv2.putText(img, f'#{f}', (5, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
        tiles.append(img)
    if not tiles:
        print('no frames')
        return
    h = max(t.shape[0] for t in tiles)
    tiles = [cv2.copyMakeBorder(t, 0, h - t.shape[0], 0, 0, cv2.BORDER_CONSTANT) for t in tiles]
    rows = []
    for i in range(0, len(tiles), cols):
        row = tiles[i:i + cols]
        w = sum(t.shape[1] for t in row)
        r = np.hstack(row)
        rows.append(r)
    wmax = max(r.shape[1] for r in rows)
    rows = [cv2.copyMakeBorder(r, 0, 0, 0, wmax - r.shape[1], cv2.BORDER_CONSTANT) for r in rows]
    cv2.imwrite(out, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 88])
    print(out)


def video(scene_dir, src='frames', fps=None):
    gts = load_gt(scene_dir)
    meta = json.load(open(os.path.join(scene_dir, 'meta.json')))
    fps = fps or meta['fps']
    out = os.path.join(scene_dir, 'preview.mp4')
    first = frame_image(scene_dir, min(gts), src)
    H, W = first.shape[:2]
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}',
           '-r', str(fps), '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', out]
    pr = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    last = first
    for f in range(1, meta['frame_count'] + 1):
        img = frame_image(scene_dir, f, src)
        if img is None:
            img = last.copy()  # dropped by an fps post step
        last = img
        if f in gts:
            img = draw(img.copy(), gts[f], meta=meta)
        cv2.putText(img, f'{f}', (5, H - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1)
        pr.stdin.write(img.tobytes())
    pr.stdin.close()
    pr.wait()
    print(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('scene_dir')
    ap.add_argument('--video', action='store_true')
    ap.add_argument('--sheet')
    ap.add_argument('--frames')
    ap.add_argument('--every', type=int)
    ap.add_argument('--src', default='frames', help='frames (the camera picture, default; GT matches it) or render (pinhole PNGs)')
    ap.add_argument('--mask', action='store_true')
    ap.add_argument('--zoom', action='store_true')
    ap.add_argument('--cols', type=int, default=4)
    ap.add_argument('--hands', help='hand close-up sheet (crops round every hand with GT)')
    a = ap.parse_args()
    if a.video:
        video(a.scene_dir, a.src)
    if a.sheet:
        if a.frames:
            frames = [int(x) for x in a.frames.split(',')]
        else:
            frames = sorted(load_gt(a.scene_dir))[::a.every or 15]
        sheet(a.scene_dir, frames, a.sheet, a.src, a.mask, a.cols, a.zoom)
    if a.hands:
        frames = [int(x) for x in a.frames.split(',')] if a.frames else sorted(load_gt_any(a.scene_dir))[::a.every or 15]
        hand_sheet(a.scene_dir, frames, a.hands, a.src)


if __name__ == '__main__':
    sys.exit(main())
