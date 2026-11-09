#!/usr/bin/env python3
"""Builds sim2real scenes in the trackbench scene layout.

  make_scenes.py real  [seq-id...]   real video segments -> $S2R/real/scenes/real-<id>/ (frames, spec, meta; gt.jsonl comes from fuse_pgt.py)
  make_scenes.py twins [seq-id...]   rendered twins ($S2R/syn/scenes/twin-*) -> $S2R/syn/scenes/syn-<id>/ (frames, exact GT reframed)

$S2R defaults to $TRACKBENCH_DATA/sim2real. Both use reframe.py, so the two domains get the same
picture geometry, resampling and JPEG quality (95). Run with the trackbench venv.
"""
import json
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import reframe  # noqa: E402

DATA = os.environ.get('TRACKBENCH_DATA_MAIN', '/Volumes/development/aerodance-trackbench')
S2R = os.environ.get('S2R', os.path.join(DATA, 'sim2real'))
SEQ = json.load(open(os.path.join(HERE, 'sequences.json')))
SOURCES = SEQ['sources']


def write_json(path, obj):
    with open(path, 'w') as f:
        json.dump(obj, f, indent=1)
        f.write('\n')


def scene_spec(sid, seq, out_w, out_h, category, description, extra=None):
    return {
        'id': sid, 'category': category, 'description': description, 'fps': 30,
        'duration_s': seq['duration_s'], 'resolution': [out_w, out_h], 'players': seq['players'],
        'camera': {'orientation': 'portrait' if out_h > out_w else 'landscape'},
        'room': {'features': []},
        'phases': [{'name': 'dance', 'start_s': 0, 'end_s': seq['duration_s']}],
        **(extra or {}),
    }


def make_real(seq):
    src = SOURCES[seq['source']]
    path = os.path.expanduser(src['path'])
    w, h = src['size']
    op = src['op']
    sid = 'real-' + seq['id']
    out = os.path.join(S2R, 'real', 'scenes', sid)
    if os.path.exists(os.path.join(out, 'frames')):
        shutil.rmtree(os.path.join(out, 'frames'))
    os.makedirs(os.path.join(out, 'frames'), exist_ok=True)
    n = round(seq['duration_s'] * 30)
    # Decode exactly n frames from start (sources are 30 fps constant; -ss before -i seeks to the
    # nearest frame, then frames are taken in order).
    cmd = ['ffmpeg', '-v', 'error', '-ss', str(seq['start_s']), '-i', path, '-frames:v', str(n), '-fps_mode', 'passthrough',
           '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    k = 0
    while True:
        buf = proc.stdout.read(w * h * 3)
        if len(buf) < w * h * 3:
            break
        k += 1
        img = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
        Image.fromarray(reframe.apply(img, op)).save(os.path.join(out, 'frames', f'{k:06d}.jpg'), quality=95)
    proc.wait()
    ow, oh = op['out']
    write_json(os.path.join(out, 'spec.json'), scene_spec(sid, seq, ow, oh, 'sim2real-real', src['what']))
    write_json(os.path.join(out, 'meta.json'), {
        'id': sid, 'fps': 30, 'frame_count': k, 'resolution': [ow, oh],
        'source': {'video': os.path.basename(path), 'start_s': seq['start_s'], 'duration_s': seq['duration_s'], 'size': [w, h], 'reframe': op,
                   'content_box': reframe.content_box(op, w, h)},
        'gt': 'pseudo-GT (fuse_pgt.py); no camera intrinsics',
    })
    print(sid, k, 'frames')


def make_twin(seq):
    src = SOURCES[seq['source']]
    op = src['twin_op']
    tdir = os.path.join(S2R, 'syn', 'scenes', seq['twin'])
    if not os.path.exists(os.path.join(tdir, 'READY')):
        print(seq['twin'], 'not READY; skipped')
        return
    sid = 'syn-' + seq['id']
    out = os.path.join(S2R, 'syn', 'scenes', sid)
    if os.path.exists(os.path.join(out, 'frames')):
        shutil.rmtree(os.path.join(out, 'frames'))
    os.makedirs(os.path.join(out, 'frames'), exist_ok=True)
    meta = json.load(open(os.path.join(tdir, 'meta.json')))
    spec = json.load(open(os.path.join(tdir, 'spec.json')))
    w, h = meta['camera']['width'], meta['camera']['height']
    renders = sorted(os.listdir(os.path.join(tdir, 'render')))
    for name in renders:
        img = np.asarray(Image.open(os.path.join(tdir, 'render', name)).convert('RGB'))
        assert img.shape[:2] == (h, w), (img.shape, w, h)
        Image.fromarray(reframe.apply(img, op)).save(os.path.join(out, 'frames', name.replace('.png', '.jpg')), quality=95)
    s, ox, oy, ow, oh, _ = reframe.geometry(op, w, h)
    with open(os.path.join(tdir, 'gt.jsonl')) as f, open(os.path.join(out, 'gt.jsonl'), 'w') as g:
        for line in f:
            d = json.loads(line)
            for p in d['people']:
                kp = np.array(p['kp'], np.float64)
                xy = reframe.map_points(kp[:, :2], op, w, h)
                outside = (xy[:, 0] < 0) | (xy[:, 0] > 1) | (xy[:, 1] < 0) | (xy[:, 1] > 1)
                p['kp'] = [[round(float(x), 5), round(float(y), 5), j[2], 3 if o else j[3]] for (x, y), j, o in zip(xy, p['kp'], outside)]
                if p.get('bbox'):
                    b = reframe.map_points(np.array(p['bbox'], np.float64).reshape(2, 2), op, w, h).clip(0, 1).reshape(-1)
                    p['bbox'] = [round(float(v), 5) for v in b]
            g.write(json.dumps(d) + '\n')
    K = meta['camera']['K']
    write_json(os.path.join(out, 'spec.json'), scene_spec(sid, seq, ow, oh, 'sim2real-syn', spec.get('description', ''),
                                                          {'twin_of': 'real-' + seq['id'], 'rendered_spec': seq['twin']}))
    write_json(os.path.join(out, 'meta.json'), {
        'id': sid, 'fps': meta['fps'], 'frame_count': len(renders), 'resolution': [ow, oh],
        'camera': {'width': ow, 'height': oh, 'K': [[K[0][0] * s, 0, K[0][2] * s + ox], [0, K[1][1] * s, K[1][2] * s + oy], [0, 0, 1]]},
        'source': {'render': seq['twin'], 'size': [w, h], 'reframe': op, 'content_box': reframe.content_box(op, w, h)},
    })
    print(sid, len(renders), 'frames')


if __name__ == '__main__':
    mode, ids = sys.argv[1], sys.argv[2:]
    for seq in SEQ['sequences']:
        if ids and seq['id'] not in ids:
            continue
        (make_real if mode == 'real' else make_twin)(seq)
