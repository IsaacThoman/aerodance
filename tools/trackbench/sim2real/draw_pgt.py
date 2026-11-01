#!/usr/bin/env python3
"""Contact sheet of a scene's frames with its gt.jsonl drawn (agreed pseudo-GT joints green,
unagreed red, exact GT blue), for eyeball checks. Writes outside the repository only.

  draw_pgt.py <scene-dir> <out.jpg> [frame ...]
"""
import json
import os
import sys

from PIL import Image, ImageDraw

EDGES = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24), (23, 25), (25, 27), (24, 26), (26, 28), (0, 2), (0, 5)]


def main():
    scene, out = sys.argv[1], sys.argv[2]
    assert not os.path.abspath(out).startswith(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))), 'never write derived images into the repo'
    gt = {json.loads(l)['frame']: json.loads(l) for l in open(os.path.join(scene, 'gt.jsonl'))}
    frames = [int(f) for f in sys.argv[3:]] or [1, len(gt) // 4, len(gt) // 2, 3 * len(gt) // 4, len(gt)]
    tiles = []
    for f in frames:
        im = Image.open(os.path.join(scene, 'frames', f'{f:06d}.jpg')).convert('RGB')
        W, H = im.size
        d = ImageDraw.Draw(im)
        for p in gt[f]['people']:
            k = p['kp']
            ok = p.get('pgt_ok')
            col = lambda j: (0, 120, 255) if ok is None else ((0, 255, 0) if ok[j] else (255, 40, 40))
            for a, b in EDGES:
                if k[a][3] != 3 and k[b][3] != 3:
                    d.line([(k[a][0] * W, k[a][1] * H), (k[b][0] * W, k[b][1] * H)], fill=col(a) if (ok is None or (ok[a] and ok[b])) else (255, 40, 40), width=2)
            for j in [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]:
                if k[j][3] != 3:
                    d.ellipse([k[j][0] * W - 3, k[j][1] * H - 3, k[j][0] * W + 3, k[j][1] * H + 3], fill=col(j))
            x0, y0 = (p['bbox'][0] * W, p['bbox'][1] * H) if p.get('bbox') else (k[0][0] * W, k[0][1] * H)
            d.text((x0 + 2, y0 + 2), f"{p['id']} {p['role'][0]}", fill=(255, 255, 0))
        d.text((4, 4), f'frame {f}', fill=(255, 255, 255))
        tiles.append(im)
    w, h = tiles[0].size
    cols = min(len(tiles), 3)
    sheet = Image.new('RGB', (cols * w, -(-len(tiles) // cols) * h))
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols) * w, (i // cols) * h))
    sheet.save(out, quality=88)


if __name__ == '__main__':
    main()
