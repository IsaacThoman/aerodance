#!/usr/bin/env python3
"""Confidence-calibration audit: how much of each estimator's score loss is its confidence scale.

  confcal.py collect   [--estimators a,b]   per-joint (conf, error) for matched players -> $DATA/audit/cal/<est>.npz
  confcal.py fit                            fit split: offsets, isotonic P(correct | conf); calibration stats
  confcal.py write <variant> [--estimators] write runs/<est>-<variant>/<scene>/detections.jsonl (originals untouched)
  confcal.py table [--ids a,b]              score lost / PCK per id on the fit and test splits

Variants (only `conf` changes; positions are copied bit for bit, `looks` dropped so track.ts
resamples them with the new confidences, the same way for every model):
  cal      conf' = isotonic P(joint within 0.2 torso lengths | conf), fitted on the fit split only.
           The game's 0.5 gate then means "more likely right than wrong" for every model.
  thr<T>   piecewise-linear remap sending raw conf T to 0.5 (0->0, 1->1): a per-model gate of T.
  thrbest  thr<T> with each model's T chosen on the fit split (tables.py sweep, best-thresholds.json).
  one      every joint conf 1 (no gate at all): what the positions alone are worth.
  top      conf unchanged, but only the `players` highest-scoring people per frame (by the
           runner's person score), as the game asks MediaPipe for num_poses = players.
  caltop   cal and top together.
  oracle   conf 1 for a matched player's joint inside the picture within 0.2 torso lengths of the
           GT (offset-corrected), else 0; unmatched detections unchanged. An upper bound no
           calibration can beat; uses the GT, so it is a diagnostic, not a candidate.
Joints written as exactly (0, 0) with conf 0 (Apple Vision's undetected joints) become null
in every variant, and in the `fix` variant (conf otherwise unchanged).

Fit split: base-genre-* (10 solo baseline scenes). Test split: every other scene all seven
estimators ran. Matching mirrors harness/common.ts (Hungarian on mean body-joint distance in
torso lengths, either side, gate 1.0).
"""
import argparse
import json
import math
import os
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment

DATA = Path(os.environ.get('TRACKBENCH_DATA', '/Volumes/development/aerodance-trackbench'))
OUT = DATA / 'audit' / 'cal'
ESTIMATORS = ['mp-lite-game', 'mp-full-game', 'mp-heavy-game', 'rtmo-s', 'rtmpose-s', 'movenet-multipose', 'apple-vision']
BODY = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
PAIRS = [(1, 4), (2, 5), (3, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16), (17, 18), (19, 20), (21, 22), (23, 24), (25, 26), (27, 28), (29, 30), (31, 32)]
MIRROR = list(range(33))
for a, b in PAIRS:
    MIRROR[a], MIRROR[b] = b, a
CORRECT = 0.2
GATE = 1.0


def is_fit(scene):
    return scene.startswith('base-genre-')


def read_jsonl(p):
    return [json.loads(l) for l in open(p) if l.strip()]


def scenes_for(estimators):
    sets = [{s for s in os.listdir(DATA / 'runs' / e) if (DATA / 'runs' / e / s / 'metrics.json').exists()} for e in estimators]
    return sorted(set.intersection(*sets))


class Scene:
    def __init__(self, sid):
        d = DATA / 'scenes' / sid
        self.id = sid
        self.gt = {r['frame']: r for r in read_jsonl(d / 'gt.jsonl')}
        meta = json.loads((d / 'meta.json').read_text())
        cam = meta.get('camera', {})
        w, h = cam.get('width'), cam.get('height')
        if not w:
            w, h = meta['resolution']
        self.aspect = w / h
        # common.ts focalOf: meta K first (it is present for every rendered scene).
        self.focal = cam['K'][0][0] / h

    def scale(self, p):
        k, k3 = p['kp'], p['kp3d']
        z = (k[11][2] + k[12][2] + k[23][2] + k[24][2]) / 4
        s = [(k3[11][c] + k3[12][c]) / 2 for c in range(3)]
        hh = [(k3[23][c] + k3[24][c]) / 2 for c in range(3)]
        ln = math.dist(s, hh)
        if ln > 0.05 and z > 0.05:
            return self.focal * ln / z
        sx, sy = (k[11][0] + k[12][0]) / 2, (k[11][1] + k[12][1]) / 2
        hx, hy = (k[23][0] + k[24][0]) / 2, (k[23][1] + k[24][1]) / 2
        return max(math.hypot((sx - hx) * self.aspect, sy - hy), math.hypot((k[11][0] - k[12][0]) * self.aspect, k[11][1] - k[12][1]) / 0.75, 0.01)

    def frame_axes(self, p):
        k, A = p['kp'], self.aspect
        sx, sy = (k[11][0] + k[12][0]) / 2 * A, (k[11][1] + k[12][1]) / 2
        hx, hy = (k[23][0] + k[24][0]) / 2 * A, (k[23][1] + k[24][1]) / 2
        vx, vy = sx - hx, sy - hy
        ln = math.hypot(vx, vy)
        vx, vy = (0, -1) if ln < 1e-6 else (vx / ln, vy / ln)
        ux, uy = -vy, vx
        lx = ((k[11][0] - k[12][0]) + (k[23][0] - k[24][0])) * A
        ly = (k[11][1] - k[12][1]) + (k[23][1] - k[24][1])
        if ux * lx + uy * ly < 0:
            ux, uy = -ux, -uy
        return ux, uy, vx, vy

    def match(self, frame, people):
        g = self.gt.get(frame)
        if not g or not people or not g['people']:
            return [-1] * len(people), g
        scales = [self.scale(p) for p in g['people']]
        cost = np.full((len(people), len(g['people'])), 1e9)
        for i, d in enumerate(people):
            kp = d['kp']
            for j, p in enumerate(g['people']):
                best = math.inf
                for mirror in (False, True):
                    s = n = 0
                    for b in BODY:
                        q = kp[MIRROR[b] if mirror else b]
                        gj = p['kp'][b]
                        if q is None or gj[3] == 3:
                            continue
                        s += math.hypot((q[0] - gj[0]) * self.aspect, q[1] - gj[1]); n += 1
                    if n >= 3:
                        best = min(best, s / n / scales[j])
                if best <= GATE:
                    cost[i, j] = best
        rows, cols = linear_sum_assignment(cost)
        out = [-1] * len(people)
        for r, c in zip(rows, cols):
            if cost[r, c] < 1e9:
                out[r] = c
        return out, g


def placeholder(k):
    return k is not None and k[0] == 0 and k[1] == 0 and (k[3] or 0) == 0


def collect(estimators, scenes):
    OUT.mkdir(parents=True, exist_ok=True)
    cache = {s: Scene(s) for s in scenes}
    for e in estimators:
        rec = {k: [] for k in ('scene', 'frame', 'joint', 'conf', 'ex', 'ey', 'u', 'v', 'vis', 'placeholder', 'role')}
        for si, s in enumerate(scenes):
            sc = cache[s]
            for row in read_jsonl(DATA / 'runs' / e / s / 'detections.jsonl'):
                people = row['people']
                m, g = sc.match(row['frame'], people)
                for i, d in enumerate(people):
                    if m[i] < 0:
                        continue
                    p = g['people'][m[i]]
                    sc_ = sc.scale(p)
                    ux, uy, vx, vy = sc.frame_axes(p)
                    for j, k in enumerate(d['kp']):
                        if k is None:
                            continue
                        gj = p['kp'][j]
                        ex = (k[0] - gj[0]) * sc.aspect / sc_
                        ey = (k[1] - gj[1]) / sc_
                        rec['scene'].append(si); rec['frame'].append(row['frame']); rec['joint'].append(j)
                        rec['conf'].append(k[3] if k[3] is not None else 1.0)
                        rec['ex'].append(ex); rec['ey'].append(ey)
                        rec['u'].append(ex * ux + ey * uy); rec['v'].append(ex * vx + ey * vy)
                        rec['vis'].append(gj[3]); rec['placeholder'].append(placeholder(k))
                        rec['role'].append(p['role'] == 'player')
        np.savez_compressed(OUT / f'{e}.npz', scenes=np.array(scenes), **{k: np.array(v) for k, v in rec.items()})
        print(e, len(rec['conf']), 'joints')


def load(e):
    z = np.load(OUT / f'{e}.npz')
    d = {k: z[k] for k in z.files}
    d['fit'] = np.array([is_fit(s) for s in d['scenes']])[d['scene']]
    return d


def offsets(d):
    """Mean per-joint (u, v) offset on the fit split (visible or self-occluded joints of players), as metrics.ts learns them."""
    o = np.zeros((33, 2))
    sel = d['fit'] & (d['vis'] <= 1) & d['role'] & ~d['placeholder']
    for j in range(33):
        s = sel & (d['joint'] == j)
        if s.any():
            o[j] = d['u'][s].mean(), d['v'][s].mean()
    return o


def corrected_error(d, o):
    du, dv = o[d['joint'], 0], o[d['joint'], 1]
    return np.hypot(d['u'] - du, d['v'] - dv)


def pav(x, y):
    """Isotonic (non-decreasing) regression of y on x; returns knot xs and fitted ys."""
    order = np.argsort(x, kind='mergesort')
    x, y = x[order], y[order].astype(float)
    # Pool equal x first.
    ux, idx = np.unique(x, return_inverse=True)
    sums = np.bincount(idx, y); counts = np.bincount(idx).astype(float)
    vals, wts, xs = [], [], []
    for v, w, xx in zip(sums / counts, counts, ux):
        vals.append(v); wts.append(w); xs.append([xx])
        while len(vals) > 1 and vals[-2] > vals[-1]:
            v2, w2, x2 = vals.pop(), wts.pop(), xs.pop()
            v1, w1 = vals[-1], wts[-1]
            vals[-1] = (v1 * w1 + v2 * w2) / (w1 + w2); wts[-1] = w1 + w2; xs[-1] = xs[-1] + x2
    kx, ky = [], []
    for v, xx in zip(vals, xs):
        kx += [xx[0], xx[-1]]; ky += [v, v]
    return np.array(kx), np.array(ky)


def apply_iso(model, c):
    kx, ky = np.array(model['x']), np.array(model['y'])
    return float(np.interp(c, kx, ky))


def body_sel(d, fit):
    return (d['fit'] == fit) & np.isin(d['joint'], BODY) & (d['vis'] != 3) & d['role'] & ~d['placeholder']


def calib_stats(conf, correct):
    sure = conf >= 0.5
    n = len(conf)
    # Expected calibration error over 10 equal-width bins.
    bins = np.clip((conf * 10).astype(int), 0, 9)
    ece = sum(abs(correct[bins == b].mean() - conf[bins == b].mean()) * (bins == b).sum() for b in range(10) if (bins == b).any()) / n
    return {
        'n': int(n), 'correct': round(float(correct.mean()), 4),
        'kept': round(float(sure.mean()), 4),
        'dropped_correct': round(float((~sure & correct).sum() / n), 4),  # right joints the gate throws away
        'kept_wrong': round(float((sure & ~correct).sum() / n), 4),       # wrong joints the gate trusts
        'correct_unsure': round(float((~sure & correct).sum() / max(1, correct.sum())), 4),
        'sure_wrong': round(float((sure & ~correct).sum() / max(1, sure.sum())), 4),
        'median_conf_correct': round(float(np.median(conf[correct])), 3) if correct.any() else None,
        'ece': round(float(ece), 4),
    }


def fit(estimators):
    models = {}
    for e in estimators:
        d = load(e)
        o = offsets(d)
        err = corrected_error(d, o)
        f, t = body_sel(d, True), body_sel(d, False)
        kx, ky = pav(d['conf'][f], (err[f] <= CORRECT).astype(float))
        model = {'x': kx.tolist(), 'y': ky.tolist(), 'offsets': o.tolist()}
        # Raw conf where calibrated P(correct) first reaches 0.5: the effective gate.
        above = kx[ky >= 0.5]
        model['gate_raw'] = float(above.min()) if len(above) else None
        cal = np.interp(d['conf'], kx, ky)
        model['fit'] = {'before': calib_stats(d['conf'][f], err[f] <= CORRECT), 'after': calib_stats(cal[f], err[f] <= CORRECT)}
        model['test'] = {'before': calib_stats(d['conf'][t], err[t] <= CORRECT), 'after': calib_stats(cal[t], err[t] <= CORRECT)}
        models[e] = model
        print(e, 'gate_raw', model['gate_raw'], 'test before', model['test']['before'], '\n   after', model['test']['after'])
    (OUT / 'calibration.json').write_text(json.dumps(models, indent=1))


def thr_map(c, t):
    return c * 0.5 / t if c < t else 0.5 + (c - t) * 0.5 / (1 - t)


def write(variant, estimators, scenes):
    models = json.loads((OUT / 'calibration.json').read_text()) if variant in ('cal', 'caltop', 'oracle') else None
    best = json.loads((OUT / 'best-thresholds.json').read_text()) if variant == 'thrbest' else None
    top = variant.endswith('top')
    conf_variant = variant[:-3] if top else variant
    cache = {}
    for e in estimators:
        for s in scenes:
            players = json.loads((DATA / 'scenes' / s / 'spec.json').read_text()).get('players', 1)
            src = DATA / 'runs' / e / s / 'detections.jsonl'
            dst = DATA / 'runs' / f'{e}-{variant}' / s / 'detections.jsonl'
            assert dst.parent.parent.name != e
            dst.parent.mkdir(parents=True, exist_ok=True)
            lines = []
            if variant == 'oracle':
                sc = cache.setdefault(s, Scene(s))
                o = np.array(models[e]['offsets'])
            for row in read_jsonl(src):
                row.pop('looks', None)
                if top and len(row['people']) > players:
                    def person_score(p):
                        if p.get('score') is not None:
                            return p['score']
                        return float(np.mean([k[3] for k in p['kp'] if k is not None and k[3] is not None] or [0]))
                    row['people'] = sorted(row['people'], key=person_score, reverse=True)[:players]
                if variant == 'oracle':
                    m, g = sc.match(row['frame'], row['people'])
                for i, p in enumerate(row['people']):
                    kp = p['kp']
                    for j, k in enumerate(kp):
                        if k is None:
                            continue
                        if placeholder(k):
                            kp[j] = None
                            continue
                        c = k[3] if k[3] is not None else 1.0
                        if conf_variant == 'cal':
                            c = apply_iso(models[e], c)
                        elif variant == 'thrbest':
                            c = thr_map(c, float(best[e]))
                        elif variant.startswith('thr'):
                            c = thr_map(c, float(variant[3:]))
                        elif variant == 'one':
                            c = 1.0
                        elif variant == 'oracle' and m[i] >= 0:
                            gp = g['people'][m[i]]
                            gj = gp['kp'][j]
                            if gj[3] == 3:
                                c = 0.0
                            else:
                                scl = sc.scale(gp); ux, uy, vx, vy = sc.frame_axes(gp)
                                ex = (k[0] - gj[0]) * sc.aspect / scl; ey = (k[1] - gj[1]) / scl
                                u, v = ex * ux + ey * uy - o[j, 0], ex * vx + ey * vy - o[j, 1]
                                c = 1.0 if math.hypot(u, v) <= CORRECT else 0.0
                        k[3] = float(c)
                lines.append(json.dumps(row))
            dst.write_text('\n'.join(lines) + '\n')
            (dst.parent / 'run.json').write_text(json.dumps({'derived_from': str(src), 'variant': variant, 'script': 'tools/trackbench/audit/confcal.py'}, indent=1) + '\n')
        print(f'{e}-{variant}: {len(scenes)} scenes')


def table(ids, scenes):
    out = {}
    for i in ids:
        rows = {'fit': [], 'test': []}
        for s in scenes:
            p = DATA / 'runs' / i / s / 'metrics.json'
            if not p.exists():
                continue
            m = json.loads(p.read_text())
            sc, kp = m.get('score'), m['detection']['keypoints']
            rows['fit' if is_fit(s) else 'test'].append({
                'lost': sc['score_lost'] if sc else None, 'frac': sc['score_lost_frac'] if sc else None,
                'pck20': kp['body']['pck20'], 'pck20c': kp['body']['pck20_corrected'], 'usable': kp['limbs']['usable_frac'],
                'recall': m['detection']['recall']['players'], 'id': m['tracking']['after_numbering']['identity_accuracy']})
        def avg(rs, k):
            v = [r[k] for r in rs if r[k] is not None]
            return round(float(np.mean(v)), 4) if v else None
        out[i] = {split: {k: avg(rs, k) for k in ('lost', 'frac', 'pck20', 'pck20c', 'usable', 'recall', 'id')} | {'scenes': len(rs)} for split, rs in rows.items()}
        print(i, json.dumps(out[i]))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cmd', choices=['collect', 'fit', 'write', 'table'])
    ap.add_argument('variant', nargs='?')
    ap.add_argument('--estimators', default=','.join(ESTIMATORS))
    ap.add_argument('--ids', default='')
    ap.add_argument('--scenes', default='')
    ap.add_argument('--json', default='')
    a = ap.parse_args()
    ests = a.estimators.split(',')
    scenes = a.scenes.split(',') if a.scenes else scenes_for(ESTIMATORS)
    if a.scenes in ('fit', 'test'):
        scenes = [s for s in scenes_for(ESTIMATORS) if is_fit(s) == (a.scenes == 'fit')]
    if a.cmd == 'collect':
        collect(ests, scenes)
    elif a.cmd == 'fit':
        fit(ests)
    elif a.cmd == 'write':
        write(a.variant, ests, scenes)
    else:
        res = table(a.ids.split(',') if a.ids else ests, scenes)
        if a.json:
            Path(a.json).write_text(json.dumps(res, indent=1))


if __name__ == '__main__':
    main()
