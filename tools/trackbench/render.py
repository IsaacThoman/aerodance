#!/usr/bin/env python3
"""Render a trackbench scene: spec -> frames, GT, masks, meta (and an optional preview).

python tools/trackbench/render.py <spec-or-id> [--jobs N] [--preview] [--force] [--samples N]
                                  [--frames a-b] [--keep-render]

Output: $TRACKBENCH_DATA/scenes/<id>/ (see CONTRACT.md). Variants that change only `post` reuse
their base's render (rendering the base first if needed). Blender runs in N parallel processes
over contiguous frame chunks, under `caffeinate -dimsu` so the GPU isn't throttled. After post,
post/geometric_gt.py warps GT and masks onto the picture when the lens (hfov > 90) or a rolling
shutter moves it (keeping the pinhole ones as gt.pinhole.jsonl and masks.pinhole/).
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'blender'))
import spec_utils  # noqa: E402

BLENDER = shutil.which('blender') or '/Applications/Blender.app/Contents/MacOS/Blender'
VENV_PY = os.path.join(spec_utils.DATA_ROOT, '.venv', 'bin', 'python')
GENERATE = os.path.join(HERE, 'blender', 'generate.py')
PREVIEW = os.path.join(HERE, 'blender', 'preview.py')
DEGRADE = os.path.join(HERE, 'post', 'degrade.py')
GEOMETRIC_GT = os.path.join(HERE, 'post', 'geometric_gt.py')


def log(*a):
    print('[render]', *a, flush=True)


def chunks(n, jobs):
    jobs = max(1, min(jobs, n))
    size = -(-n // jobs)
    return [(a, min(n, a + size - 1)) for a in range(1, n + 1, size)]


def run_blender(spec_file, out, frames, samples, logf, gt_only=False):
    cmd = [BLENDER, '-b', '--python-exit-code', '1', '-P', GENERATE, '--', spec_file, '--out', out,
           '--frames', f'{frames[0]}-{frames[1]}'] + (['--gt-only'] if gt_only else [])
    if samples:
        cmd += ['--samples', str(samples)]
    if shutil.which('caffeinate'):
        cmd = ['caffeinate', '-dimsu'] + cmd
    return subprocess.Popen(cmd, stdout=open(logf, 'w'), stderr=subprocess.STDOUT)


def merge_parts(out, n):
    lines = {}
    for p in sorted(glob.glob(os.path.join(out, 'gt.parts', '*.jsonl'))):
        with open(p) as f:
            for line in f:
                d = json.loads(line)
                lines[d['frame']] = line if line.endswith('\n') else line + '\n'
    missing = [f for f in range(1, n + 1) if f not in lines]
    if missing:
        raise RuntimeError(f'GT missing for {len(missing)} frames (first {missing[:5]})')
    with open(os.path.join(out, 'gt.jsonl'), 'w') as f:
        for k in sorted(lines):
            f.write(lines[k])
    metas = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(out, 'meta.parts', '*.json')))]
    meta = dict(metas[0])
    meta.pop('chunk', None)
    meta.pop('frames_done', None)
    c2w = {}
    for m in metas:
        c2w.update(m['camera_to_world'])
    meta['camera_to_world'] = {k: c2w[k] for k in sorted(c2w, key=int)}
    tim = [m['timing'] for m in metas]
    frames = sum(m['frames_done'] for m in metas)
    meta['timing'] = {
        'processes': len(metas),
        'render_s_per_frame': round(sum(t['render_s'] for t in tim) / frames, 3),
        'gt_s_per_frame': round(sum(t['gt_s'] for t in tim) / frames, 3),
        'setup_s_per_process': round(sum(t['setup_s'] for t in tim) / len(tim), 2),
    }
    return meta


def to_jpeg(out):
    code = (
        "import cv2,glob,os,sys\n"
        "d=sys.argv[1]; os.makedirs(d+'/frames',exist_ok=True)\n"
        "for p in sorted(glob.glob(d+'/render/*.png')):\n"
        "    cv2.imwrite(d+'/frames/'+os.path.basename(p)[:-4]+'.jpg', cv2.imread(p), [cv2.IMWRITE_JPEG_QUALITY,95])\n")
    subprocess.run([VENV_PY, '-c', code, out], check=True)


def run_post(out, spec):
    if os.path.exists(DEGRADE):
        log('post: degrade.py')
        r = subprocess.run([VENV_PY, DEGRADE, out], cwd=os.path.dirname(HERE))
        if r.returncode == 0:
            return
        if spec.get('post'):
            raise RuntimeError('post/degrade.py failed')
        log('degrade.py failed; plain JPEG conversion instead')
    elif spec.get('post'):
        log('warning: post/degrade.py missing; post steps NOT applied')
    to_jpeg(out)


def run_geometric_gt(out):
    """Lens distortion (hfov > 90) and rolling shutter move the picture: warp GT and masks to
    match (the pinhole ones are kept as gt.pinhole.jsonl and masks.pinhole/)."""
    subprocess.run([VENV_PY, GEOMETRIC_GT, out], check=True)


def _remove(p):
    if os.path.islink(p) or os.path.isfile(p):
        os.remove(p)
    elif os.path.isdir(p):
        shutil.rmtree(p)


def render_scene(spec_or_id, jobs=1, preview=False, force=False, samples=None, keep_render=True, gt_only=False):
    spec = spec_utils.load(spec_or_id)
    sid = spec['id']
    out = spec_utils.scene_dir(sid)
    os.makedirs(out, exist_ok=True)
    ready = os.path.join(out, 'READY')
    if os.path.exists(ready):
        os.remove(ready)
    n = spec_utils.frame_count(spec)
    base_id = spec.get('base')
    if base_id:
        base = spec_utils.load(base_id)
        if spec_utils.render_key(base) == spec_utils.render_key(spec):
            log(f'{sid}: post-only variant of {base_id}; reusing its render')
            bdir = spec_utils.scene_dir(base['id'])
            bmeta = os.path.join(bdir, 'meta.json')
            if force or not os.path.exists(bmeta) or json.load(open(bmeta)).get('render_key') != spec_utils.render_key(base):
                render_scene(base_id, jobs, False, force, samples, True)
            for name in ('render', 'masks', 'masks.pinhole', 'gt.pinhole.jsonl'):
                _remove(os.path.join(out, name))
            # The base's pinhole masks/GT if its own geometry warped them.
            bmasks = os.path.join(bdir, 'masks.pinhole')
            bgt = os.path.join(bdir, 'gt.pinhole.jsonl')
            os.symlink(os.path.join(bdir, 'render'), os.path.join(out, 'render'))
            os.symlink(bmasks if os.path.exists(bmasks) else os.path.join(bdir, 'masks'), os.path.join(out, 'masks'))
            shutil.copy(bgt if os.path.exists(bgt) else os.path.join(bdir, 'gt.jsonl'), os.path.join(out, 'gt.jsonl'))
            meta = json.load(open(bmeta))
            meta.update(id=sid, base=base['id'], phases=spec.get('phases', []))
            _write_json(os.path.join(out, 'spec.json'), spec)
            _write_json(os.path.join(out, 'meta.json'), meta)
            if os.path.isdir(os.path.join(out, 'frames')):
                shutil.rmtree(os.path.join(out, 'frames'))
            run_post(out, spec)
            run_geometric_gt(out)
            if preview:
                subprocess.run([VENV_PY, PREVIEW, out, '--video'], check=True)
            open(ready, 'w').close()
            return out
    old_meta = None
    if gt_only:
        if not os.path.isdir(os.path.join(out, 'masks')):
            raise SystemExit(f'{sid}: --gt-only needs an earlier render (no masks/)')
        old_meta = json.load(open(os.path.join(out, 'meta.json')))
        if os.path.exists(os.path.join(out, 'masks.pinhole')):
            # GT is recomputed from the pinhole masks, then warped again.
            _remove(os.path.join(out, 'masks'))
            os.rename(os.path.join(out, 'masks.pinhole'), os.path.join(out, 'masks'))
        _remove(os.path.join(out, 'gt.pinhole.jsonl'))
    for d in (('gt.parts', 'meta.parts', 'tmp', 'logs') if gt_only else
              ('render', 'masks', 'masks.pinhole', 'gt.pinhole.jsonl', 'frames', 'gt.parts', 'meta.parts', 'tmp', 'logs')):
        _remove(os.path.join(out, d))
    os.makedirs(os.path.join(out, 'logs'))
    spec_file = os.path.join(out, 'spec.json')
    _write_json(spec_file, spec)
    t0 = time.time()
    procs = []
    for a, b in chunks(n, jobs):
        logf = os.path.join(out, 'logs', f'generate-{a:06d}-{b:06d}.log')
        procs.append(((a, b), logf, run_blender(spec_file, out, (a, b), samples, logf, gt_only)))
    log(f'{sid}: {n} frames in {len(procs)} Blender process(es)')
    failed = []
    for fr, logf, p in procs:
        if p.wait() != 0:
            failed.append((fr, logf))
    if failed:
        for fr, logf in failed:
            log(f'chunk {fr} failed; tail of {logf}:')
            print(''.join(open(logf).readlines()[-25:]))
        raise SystemExit(1)
    wall = time.time() - t0
    meta = merge_parts(out, n)
    meta['render_key'] = spec_utils.render_key(spec)
    meta['timing']['wall_s'] = round(wall, 1)
    meta['timing']['wall_s_per_frame'] = round(wall / n, 3)
    meta['timing']['jobs'] = jobs
    if gt_only and old_meta:
        meta['timing'] = dict(old_meta['timing'], gt_s_per_frame=meta['timing']['gt_s_per_frame'],
                              gt_recomputed=True)
        meta['render'] = old_meta.get('render', meta['render'])
    _write_json(os.path.join(out, 'meta.json'), meta)
    shutil.rmtree(os.path.join(out, 'gt.parts'))
    shutil.rmtree(os.path.join(out, 'meta.parts'))
    if os.path.isdir(os.path.join(out, 'tmp')):
        shutil.rmtree(os.path.join(out, 'tmp'), ignore_errors=True)
    if not (gt_only and os.path.isdir(os.path.join(out, 'frames'))):
        run_post(out, spec)
    run_geometric_gt(out)
    if preview:
        subprocess.run([VENV_PY, PREVIEW, out, '--video'], check=True)
    if not keep_render:
        shutil.rmtree(os.path.join(out, 'render'))
    open(ready, 'w').close()
    log(f'{sid}: done in {wall:.0f} s ({meta["timing"]["render_s_per_frame"]} s/frame render, '
        f'{meta["timing"]["gt_s_per_frame"]} s/frame GT) -> {out}')
    return out


def _write_json(path, obj):
    with open(path, 'w') as f:
        json.dump(obj, f, indent=1)
        f.write('\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('spec', nargs='+', help='scene ids or spec paths')
    ap.add_argument('--jobs', type=int, default=2)
    ap.add_argument('--preview', action='store_true')
    ap.add_argument('--force', action='store_true', help='re-render a post-only variant\'s base too')
    ap.add_argument('--samples', type=int)
    ap.add_argument('--no-keep-render', action='store_true', help='delete render/ PNGs after post')
    ap.add_argument('--gt-only', action='store_true', help='recompute GT from the existing render\'s masks')
    a = ap.parse_args()
    for s in a.spec:
        render_scene(s, a.jobs, a.preview, a.force, a.samples, not a.no_keep_render, a.gt_only)


if __name__ == '__main__':
    main()
