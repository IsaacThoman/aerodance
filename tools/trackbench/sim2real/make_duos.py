"""Real two-player scenes from the real multi-dancer clips: crops two neighbouring dancers (with
whatever of their neighbours falls inside, who become bystanders) out of each sim2real `real-*`
scene, transforming its pseudo ground truth, at the clip's own aspect ratio and 640 px on the long
side. Used to check, on real footage, what the synthetic suite says about two-player tracking.

  python make_duos.py [--src $TRACKBENCH_DATA/sim2real/real/scenes] [--out $TRACKBENCH_DATA/sim2real/duo/scenes]
"""
import argparse, json, os
from pathlib import Path
import cv2

DATA = Path(os.environ.get('TRACKBENCH_DATA', '/Volumes/development/aerodance-trackbench'))
TORSO = [11, 12, 23, 24]


def torso_x(p):
    pts = [p['kp'][i] for i in TORSO if p['kp'][i] is not None]
    return sum(q[0] for q in pts) / len(pts) if pts else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=str(DATA / 'sim2real/real/scenes'))
    ap.add_argument('--out', default=str(DATA / 'sim2real/duo/scenes'))
    a = ap.parse_args()
    for sd in sorted(Path(a.src).iterdir()):
        spec = json.loads((sd / 'spec.json').read_text())
        if spec.get('players', 1) < 3:
            continue
        gt = [json.loads(l) for l in (sd / 'gt.jsonl').read_text().splitlines() if l.strip()]
        # The two middle dancers, by where they stand on average.
        xs = {}
        for f in gt:
            for p in f['people']:
                if p.get('role', 'player') == 'player' and (x := torso_x(p)) is not None:
                    xs.setdefault(p['id'], []).append(x)
        order = sorted(xs, key=lambda i: sum(xs[i]) / len(xs[i]))
        mid = len(order) // 2
        pair = order[mid - 1:mid + 1]
        frames = sorted((sd / 'frames').glob('*.jpg'))
        h, w = cv2.imread(str(frames[0])).shape[:2]
        # The pair's extent over the clip (their joints, 2-98th percentile), with a margin.
        px, py = [], []
        for f in gt:
            for p in f['people']:
                if p['id'] in pair:
                    for q in p['kp']:
                        if q is not None and 0 <= q[0] <= 1 and 0 <= q[1] <= 1:
                            px.append(q[0] * w); py.append(q[1] * h)
        px.sort(); py.sort()
        q = lambda v, t: v[int(t * (len(v) - 1))]
        x0, x1, y0, y1 = q(px, .02), q(px, .98), q(py, .02), q(py, .98)
        mx, my = (x1 - x0) * 0.15, (y1 - y0) * 0.12
        x0, x1, y0, y1 = x0 - mx, x1 + mx, y0 - my, y1 + my
        # Grow to the clip's aspect ratio, then clamp inside the picture.
        aspect = w / h
        cw, ch = x1 - x0, y1 - y0
        if cw / ch < aspect: cw = ch * aspect
        else: ch = cw / aspect
        cw, ch = min(cw, w), min(ch, h)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        x0 = min(max(0, cx - cw / 2), w - cw); y0 = min(max(0, cy - ch / 2), h - ch)
        ow, oh = (640, round(640 / aspect)) if aspect >= 1 else (round(640 * aspect), 640)
        out = Path(a.out) / f"real-duo-{sd.name.removeprefix('real-')}"
        (out / 'frames').mkdir(parents=True, exist_ok=True)
        for fp in frames:
            img = cv2.imread(str(fp))[int(y0):int(y0 + ch), int(x0):int(x0 + cw)]
            cv2.imwrite(str(out / 'frames' / fp.name), cv2.resize(img, (ow, oh), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 95])
        def tx(p):
            kp = [None if k is None else [(k[0] * w - x0) / cw, (k[1] * h - y0) / ch, *k[2:3], 3 if k[3] != 3 and not (0 <= (k[0] * w - x0) / cw <= 1 and 0 <= (k[1] * h - y0) / ch <= 1) else k[3]] for k in p['kp']]
            role = 'player' if p['id'] in pair else 'bystander'
            inside = any(k is not None and k[3] != 3 for k in kp)
            return {**p, 'kp': kp, 'role': role, 'in_frame': inside, 'bbox': None}
        with open(out / 'gt.jsonl', 'w') as fo:
            for f in gt:
                people = [tx(p) for p in f['people']]
                fo.write(json.dumps({**f, 'people': [p for p in people if p['in_frame']]}) + '\n')
        nspec = {**spec, 'id': out.name, 'players': 2, 'category': 'sim2real-duo', 'resolution': [ow, oh],
                 'description': f"{spec.get('description', '')} — cropped to the middle two dancers"}
        (out / 'spec.json').write_text(json.dumps(nspec, indent=1))
        meta = json.loads((sd / 'meta.json').read_text()) if (sd / 'meta.json').exists() else {}
        (out / 'meta.json').write_text(json.dumps({**meta, 'players': 2, 'resolution': [ow, oh], 'crop': [x0 / w, y0 / h, cw / w, ch / h], 'source': sd.name}, indent=1))
        (out / 'READY').write_text('')
        print(out.name, f'pair {pair}', f'crop {int(x0)},{int(y0)} {int(cw)}x{int(ch)} -> {ow}x{oh}')


if __name__ == '__main__':
    main()
