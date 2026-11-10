"""Render one trackbench scene (or a chunk of its frames) with ground truth.

blender -b -P tools/trackbench/blender/generate.py -- <spec.json|id> --out <dir> [--frames a-b]
        [--no-render] [--save-blend <file>] [--samples N]

Writes into <dir>: render/NNNNNN.png, masks/NNNNNN.png, gt.parts/<a>-<b>.jsonl and
meta.parts/<a>-<b>.json (tools/trackbench/render.py merges the parts).
"""
import argparse
import json
import math
import os
import random
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import spec_utils  # noqa: E402
import humans  # noqa: E402
import motion  # noqa: E402
import gt  # noqa: E402


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser(prog='generate.py')
    ap.add_argument('spec')
    ap.add_argument('--out', required=True)
    ap.add_argument('--frames', default=None, help='a-b (1-based, inclusive)')
    ap.add_argument('--no-render', action='store_true', help='GT only (no images or masks)')
    ap.add_argument('--gt-only', action='store_true', help='recompute GT using the masks already in <out>/masks')
    ap.add_argument('--save-blend', default=None)
    ap.add_argument('--samples', type=int, default=None, help='override EEVEE samples')
    ap.add_argument('--step', type=int, default=1, help='every Nth frame (for quick looks)')
    return ap.parse_args(argv)


def _import_env():
    try:
        import environment
        env_mod = environment
    except ImportError as e:
        print(f'[generate] environment.py unavailable ({e}); using fallback room')
        import _fallback_env as env_mod
    try:
        import camera
        cam_mod = camera
    except ImportError as e:
        print(f'[generate] camera.py unavailable ({e}); using fallback camera')
        import _fallback_env as cam_mod
    return env_mod, cam_mod


def build_scene(spec):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    seed = int(spec['seed'])
    env_mod, cam_mod = _import_env()
    t0 = time.time()
    env_info = env_mod.build_environment(spec, random.Random(seed))
    cam = cam_mod.setup_camera(spec, scene)
    t_env = time.time() - t0
    fps = spec['fps']
    n = spec_utils.frame_count(spec)
    scene.frame_start, scene.frame_end = 1, n
    people, results = [], []
    t0 = time.time()
    for k, ps in enumerate(spec['people']):
        rng = random.Random(seed * 7919 + k)
        p = humans.build_person(ps, k, rng)
        p.paddle, p.paddle_hand = None, None
        if ps.get('paddle'):
            humans.make_paddle(p, ps.get('hand', 'right'), ps['paddle'] if isinstance(ps['paddle'], dict) else None)
        rm = motion.rig_model_from_blender(p.rig)
        contacts = humans.contact_points(p)
        res = motion.evaluate_person(ps, rm, contacts, fps, n, seed=rng.random() * 6.28)
        motion.apply_to_rig(p.rig, p.objects + ([p.paddle] if p.paddle else []), res)
        p.rig_model = rm
        people.append(p)
        results.append(res)
    t_people = time.time() - t0
    env_mod.render_settings(spec, scene)
    scene.render.image_settings.media_type = 'IMAGE'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.image_settings.color_depth = '8'
    scene.render.film_transparent = False
    scene.render.use_persistent_data = True
    return scene, cam, env_info, people, results, {'env_s': round(t_env, 2), 'people_s': round(t_people, 2)}


def camera_meta(scene, cam):
    W, H = scene.render.resolution_x, scene.render.resolution_y
    c = gt.Camera(scene)
    fx = W / (c.right - c.left) * abs(c.z0)
    fy = H / (c.top - c.bottom) * abs(c.z0)
    cx = W * (-c.left) / (c.right - c.left)
    cy = H * (c.top) / (c.top - c.bottom)
    return {'width': W, 'height': H, 'K': [[fx, 0, cx], [0, fy, cy], [0, 0, 1]],
            'hfov_deg': math.degrees(2 * math.atan(W / 2 / fx)), 'vfov_deg': math.degrees(2 * math.atan(H / 2 / fy)),
            'note': 'K in pixels for the unmirrored frame; camera looks down its -Z (Blender convention); '
                    'world_to_camera = inverse(camera_to_world)'}


def main():
    args = parse_args()
    spec = spec_utils.load(args.spec)
    out = os.path.abspath(args.out)
    n = spec_utils.frame_count(spec)
    a, b = 1, n
    if args.frames:
        a, b = (int(x) for x in args.frames.split('-'))
        b = min(b, n)
    t_start = time.time()
    scene, cam, env_info, people, results, timings = build_scene(spec)
    samples = args.samples or spec.get('render', {}).get('samples')
    if samples:
        scene.eevee.taa_render_samples = int(samples)
    for d in ('render', 'masks', 'gt.parts', 'meta.parts', 'tmp'):
        os.makedirs(os.path.join(out, d), exist_ok=True)
    tmp = os.path.join(out, 'tmp', f'{a}-{b}')
    os.makedirs(tmp, exist_ok=True)
    fo = names = None
    rendering = not (args.no_render or args.gt_only)
    if rendering:
        fo, names = gt.setup_masks(scene, people, tmp)
    scene.frame_set(a)
    fgt = gt.FrameGT(scene, people, results, spec)
    if args.save_blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.save_blend))
    t_setup = time.time() - t_start
    gt_path = os.path.join(out, 'gt.parts', f'{a:06d}-{b:06d}.jsonl')
    render_s = gt_s = 0.0
    extr = {}
    frames = list(range(a, b + 1, args.step))
    with open(gt_path, 'w') as gf:
        for f in frames:
            scene.frame_set(f)
            mask = None
            if args.gt_only:
                t0 = time.time()
                mask = gt.read_png8(os.path.join(out, 'masks', f'{f:06d}.png'))
            elif rendering:
                t0 = time.time()
                gt.set_mask_frame(fo, f)
                scene.render.filepath = os.path.join(out, 'render', f'{f:06d}.png')
                bpy.ops.render.render(write_still=True)
                render_s += time.time() - t0
                t0 = time.time()
                mask = gt.read_mask(tmp, f, names, len(people))
                gt.write_png8(os.path.join(out, 'masks', f'{f:06d}.png'), mask)
            else:
                t0 = time.time()
            line = fgt.frame(f, mask)
            gf.write(json.dumps(line, separators=(',', ':')) + '\n')
            gf.flush()
            gt_s += time.time() - t0
            extr[f] = [round(v, 6) for row in scene.camera.matrix_world for v in row]
            if f == frames[0] or f % 30 == 0:
                print(f'[generate] frame {f}/{b} render {render_s / (frames.index(f) + 1):.2f}s/f gt {gt_s / (frames.index(f) + 1):.3f}s/f', flush=True)
    try:
        os.rmdir(tmp)
    except OSError:
        pass
    meta = {
        'id': spec['id'], 'generator_version': spec_utils.GENERATOR_VERSION,
        'blender': bpy.app.version_string, 'fps': spec['fps'], 'frame_count': n,
        'resolution': [scene.render.resolution_x, scene.render.resolution_y],
        'camera': camera_meta(scene, cam), 'camera_to_world': {str(k): v for k, v in extr.items()},
        'environment': env_info,
        'people': [{'id': p.spec['id'], 'role': p.spec.get('role', 'player'), 'index': p.index,
                    'mask_value': p.index + 1,
                    'height_m': round(float(_height(p)), 3), 'leg_length_m': round(p.rig_model.leg_length, 3),
                    'mocap_scale': round(p.rig_model.scale, 4),
                    'clothes': p.spec.get('outfit', {}).get('clothes', []), 'hair': p.spec.get('hair'),
                    'skin': p.spec.get('skin') or humans.default_skin(p.spec.get('body', {})),
                    **_pingpong_meta(p, r)} for p, r in zip(people, results)],
        'phases': spec.get('phases', []),
        'chunk': [a, b], 'frames_done': len(frames),
        'timing': dict(timings, setup_s=round(t_setup, 2), render_s=round(render_s, 2), gt_s=round(gt_s, 2),
                       render_s_per_frame=round(render_s / max(1, len(frames)), 3),
                       gt_s_per_frame=round(gt_s / max(1, len(frames)), 3)),
        'render': {'engine': scene.render.engine, 'samples': scene.eevee.taa_render_samples,
                   'motion_blur': scene.render.use_motion_blur},
    }
    with open(os.path.join(out, 'meta.parts', f'{a:06d}-{b:06d}.json'), 'w') as f:
        json.dump(meta, f, indent=1)
    print(f'[generate] done {a}-{b}: {meta["timing"]}', flush=True)


def _pingpong_meta(p, res):
    """Table-tennis players: paddle hand, paddle prop, and every stroke (scene seconds; contact =
    the paddle wrist's fastest point; peak_speed_mps measured on the rig's wrist targets)."""
    segs = [s for s in res.get('segments', []) if s.kind == 'pingpong']
    if not segs and not p.paddle:
        return {}
    out = {'hand': segs[0].hand if segs else p.paddle_hand, 'paddle': bool(p.paddle)}
    if p.paddle:
        out['paddle_size_m'] = [humans.PADDLE['blade_w'], humans.PADDLE['blade_h']]
    out['strokes'] = [e for s in segs for e in s.events()]
    return out


def _height(p):
    """Standing height of the rest body (basemesh 'body' vertices, shape keys mixed in)."""
    g = p.body.vertex_groups['body'].index
    me = p.body.data
    idx = [v.index for v in me.vertices if any(x.group == g and x.weight > 0.5 for x in v.groups)]
    z = p.rest[idx, 2]
    return z.max() - z.min()


if __name__ == '__main__':
    main()
