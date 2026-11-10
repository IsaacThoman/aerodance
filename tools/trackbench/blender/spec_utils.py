"""Scene specs: loading, variants (base + deep-merged overrides) and defaults. Plain Python."""
import copy
import hashlib
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
TB_DIR = os.path.dirname(HERE)
SCENES_DIR = os.path.join(TB_DIR, 'scenes')
DATA_ROOT = os.environ.get('TRACKBENCH_DATA', '/Volumes/development/aerodance-trackbench')
GENERATOR_VERSION = 'trackbench-gen 1.2'  # 1.1: Standard view transform + per-preset exposure; 1.2: calmer hold arms

# Table-tennis motion/paddle/hand-GT version: part of the render key of scenes with a pingpong
# segment only (other scenes' keys are unchanged).
PINGPONG_VERSION = 'pingpong 1.0'  # GT-only fixes don't change it (render.py --gt-only)

# Keys that don't change the rendered pixels or GT.
NON_RENDER_KEYS = ('id', 'description', 'category', 'phases', 'post', 'base', 'players')


def deep_merge(base, over):
    """Dicts merge recursively; lists are replaced, except that a dict applied to a list
    overrides elements by index ({"people": {"1": {"hair": null}}})."""
    if isinstance(base, dict) and isinstance(over, dict):
        out = dict(base)
        for k, v in over.items():
            out[k] = deep_merge(base[k], v) if k in base else copy.deepcopy(v)
        return out
    if isinstance(base, list) and isinstance(over, dict) and all(str(k).isdigit() for k in over):
        out = copy.deepcopy(base)
        for k, v in over.items():
            i = int(k)
            out[i] = deep_merge(out[i], v) if i < len(out) else copy.deepcopy(v)
        return out
    return copy.deepcopy(over)


def spec_path(spec_or_id):
    if os.path.exists(spec_or_id):
        return spec_or_id
    p = os.path.join(SCENES_DIR, spec_or_id + '.json')
    if os.path.exists(p):
        return p
    raise FileNotFoundError(f'no scene spec {spec_or_id!r} (looked in {SCENES_DIR})')


def load_raw(spec_or_id):
    with open(spec_path(spec_or_id)) as f:
        return json.load(f)


def resolve(spec_or_id, _seen=()):
    """The spec with its base chain merged in (no defaults yet)."""
    raw = load_raw(spec_or_id) if isinstance(spec_or_id, str) else spec_or_id
    if 'base' in raw:
        if raw['base'] in _seen:
            raise ValueError(f'variant cycle through {raw["base"]}')
        base = resolve(raw['base'], _seen + (raw['base'],))
        over = {k: v for k, v in raw.items() if k != 'base'}
        merged = deep_merge(base, over)
        merged.pop('id', None)
        if 'id' in raw:
            merged['id'] = raw['id']
        merged['base'] = raw['base']
        if 'post' not in raw:
            merged['post'] = base.get('post', [])
        return merged
    return copy.deepcopy(raw)


DEFAULT_CLOTHES = {'female': ['female_casualsuit01', 'shoes02'], 'male': ['male_casualsuit02', 'shoes01']}


def fill_defaults(spec):
    s = copy.deepcopy(spec)
    s.setdefault('category', 'baseline')
    s.setdefault('description', '')
    s.setdefault('seed', 1)
    s.setdefault('duration_s', 12)
    s.setdefault('fps', 30)
    s.setdefault('resolution', [640, 480])
    cam = s.setdefault('camera', {})
    for k, v in (('height_m', 1.0), ('distance_m', 3.2), ('yaw_deg', 0), ('look_at', [0, 0, 0.95]),
                 ('hfov_deg', 65), ('roll_deg', 0), ('orientation', 'landscape'), ('shake', None), ('events', [])):
        cam.setdefault(k, v)
    room = s.setdefault('room', {})
    room.setdefault('preset', 'living_room')
    room.setdefault('clutter', 0.5)
    room.setdefault('features', [])
    light = s.setdefault('lighting', {})
    for k, v in (('preset', 'bright_even'), ('exposure_ev', 0), ('color_temp_k', 4500), ('flicker_hz', 0)):
        light.setdefault(k, v)
    people = s.setdefault('people', [])
    for i, p in enumerate(people):
        p.setdefault('id', f'p{i + 1}')
        p.setdefault('role', 'player')
        body = p.setdefault('body', {})
        for k in ('gender', 'age', 'weight', 'muscle', 'height', 'proportions'):
            body.setdefault(k, 0.5)
        p.setdefault('skin', None)
        p.setdefault('hair', None)
        outfit = p.setdefault('outfit', {})
        outfit.setdefault('clothes', DEFAULT_CLOTHES['male' if body['gender'] >= 0.5 else 'female'])
        outfit.setdefault('recolor', {})
        place = p.setdefault('place', {})
        place.setdefault('x', 0.0)
        place.setdefault('y', 0.0)
        place.setdefault('facing_deg', 0.0)
        p.setdefault('travel', 0.3)
        p.setdefault('timeline', [{'type': 'hold', 'pose': 'neutral'}])
    s.setdefault('players', sum(1 for p in people if p.get('role', 'player') == 'player'))
    s.setdefault('phases', [])
    s.setdefault('post', [])
    return s


def load(spec_or_id):
    """Resolved spec with defaults."""
    s = resolve(spec_or_id)
    if 'id' not in s:
        s['id'] = os.path.splitext(os.path.basename(spec_path(spec_or_id)))[0] if isinstance(spec_or_id, str) else 'scene'
    return fill_defaults(s)


def render_key(spec):
    """Hash of everything that affects the render and GT."""
    s = {k: v for k, v in spec.items() if k not in NON_RENDER_KEYS}
    s['_generator'] = GENERATOR_VERSION  # renders from an older generator aren't reused
    if any(seg.get('type') == 'pingpong' for p in spec.get('people', []) for seg in p.get('timeline', [])):
        s['_pingpong'] = PINGPONG_VERSION
    return hashlib.sha1(json.dumps(s, sort_keys=True).encode()).hexdigest()[:16]


def frame_count(spec):
    return max(1, math.ceil(spec['duration_s'] * spec['fps'] - 1e-9))


def scene_dir(scene_id):
    return os.path.join(DATA_ROOT, 'scenes', scene_id)
