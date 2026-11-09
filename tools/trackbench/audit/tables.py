#!/usr/bin/env python3
"""Markdown tables for estimators-audit.md from the derived runs (confcal.py) and their metrics.json.

  tables.py sweep            fit-split score lost % per gate T (thr<T> ids), and the best T per model
  tables.py results          test-split before/after table (needs the -thrbest ids written and scored)
  tables.py calib            confidence calibration on the test split (from $DATA/audit/cal/calibration.json)
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from confcal import DATA, ESTIMATORS, OUT, is_fit, scenes_for  # noqa: E402

THRESHOLDS = ['0.05', '0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7']
SCENES = scenes_for(ESTIMATORS)


def metrics(run_id, split):
    rows = []
    for s in SCENES:
        if is_fit(s) != (split == 'fit'):
            continue
        p = DATA / 'runs' / run_id / s / 'metrics.json'
        if p.exists():
            rows.append(json.loads(p.read_text()))
    return rows


def mean(rows, f):
    v = [f(m) for m in rows]
    v = [x for x in v if x is not None]
    return float(np.mean(v)) if v else None


def lost_pct(run_id, split):
    rows = metrics(run_id, split)
    return mean(rows, lambda m: m['score']['score_lost_frac'] if m['score'] else None), len(rows)


def thr_id(e, t):
    return f'{e}-fix' if t == '0.5' else f'{e}-thr{t}'


def sweep():
    best = {}
    print('| estimator | ' + ' | '.join(f'T={t}' for t in THRESHOLDS) + ' | best T |')
    print('|---|' + '---|' * (len(THRESHOLDS) + 1))
    for e in ESTIMATORS:
        vals = {t: lost_pct(thr_id(e, t), 'fit')[0] for t in THRESHOLDS}
        ok = {t: v for t, v in vals.items() if v is not None}
        b = min(ok, key=ok.get)
        best[e] = b
        print(f'| {e} | ' + ' | '.join('–' if vals[t] is None else f'{100 * vals[t]:.1f}'  if t != b else f'**{100 * vals[t]:.1f}**' for t in THRESHOLDS) + f' | {b} |')
    (OUT / 'best-thresholds.json').write_text(json.dumps(best, indent=1))


def results():
    best = json.loads((OUT / 'best-thresholds.json').read_text())
    cols = [('orig', '{e}-fix'), ('one', '{e}-one'), ('cal', '{e}-cal'), (f'thr*', '{e}-thrbest'), ('top', '{e}-top'), ('cal+top', '{e}-caltop'), ('drop-if-wrong', '{e}-oracle')]
    out = {}
    print('| estimator | ' + ' | '.join(f'lost % {c}' for c, _ in cols) + ' | share of loss from the 0.5 gate | PCK@0.2 | PCK@0.2 corr | limbs usable orig → cal |')
    print('|---|' + '---|' * (len(cols) + 4))
    for e in ESTIMATORS:
        mp = e.startswith('mp-')
        row = {}
        for c, pat in cols:
            rid = pat.format(e=e)
            if mp and c in ('top', 'cal+top'):
                rid = f'{e}-fix' if c == 'top' else f'{e}-cal'  # MediaPipe already returns num_poses = players
            if not (DATA / 'runs' / rid).exists() and rid.endswith('-fix'):
                rid = e  # no placeholder joints to drop: the original run is the same
            row[c] = lost_pct(rid, 'test')[0]
        base = 'fix' if (DATA / 'runs' / f'{e}-fix').exists() else ''
        rid = f'{e}-{base}' if base else f'{e}-cal'
        test = metrics(rid, 'test')
        pck = mean(test, lambda m: m['detection']['keypoints']['body']['pck20'])
        pckc = mean(test, lambda m: m['detection']['keypoints']['body']['pck20_corrected'])
        use0 = mean(metrics(f'{e}-fix' if base else e, 'test'), lambda m: m['detection']['keypoints']['limbs']['usable_frac'])
        use1 = mean(metrics(f'{e}-cal', 'test'), lambda m: m['detection']['keypoints']['limbs']['usable_frac'])
        out[e] = row | {'pck20': pck, 'pck20c': pckc, 'best_T': best[e]}
        f = lambda v: '–' if v is None else f'{100 * v:.1f}'
        gate = (row['orig'] - row['thr*']) / row['orig']
        print(f'| {e} | ' + ' | '.join(f(row[c]) for c, _ in cols) + f' | {100 * gate:.0f}% | {pck:.3f} | {pckc:.3f} | {use0:.3f} → {use1:.3f} |')
    (OUT / 'results.json').write_text(json.dumps(out, indent=1))
    print()
    for c, _ in cols:
        order = sorted(ESTIMATORS, key=lambda e: out[e][c] if out[e][c] is not None else 9)
        print(f'- **{c}**: ' + ' < '.join(f'{e} {100 * out[e][c]:.1f}' for e in order if out[e][c] is not None))


def calib():
    m = json.loads((OUT / 'calibration.json').read_text())
    print('| estimator | correct (≤0.2 torso) | kept at 0.5 | right but dropped | wrong but kept | median conf of right joints | ECE before → after | isotonic gate (raw conf ↦ P=0.5) |')
    print('|---|---|---|---|---|---|---|---|')
    for e in ESTIMATORS:
        b, a = m[e]['test']['before'], m[e]['test']['after']
        print(f"| {e} | {100 * b['correct']:.1f}% | {100 * b['kept']:.1f}% | {100 * b['dropped_correct']:.1f}% | {100 * b['kept_wrong']:.1f}% | {b['median_conf_correct']} | {b['ece']:.3f} → {a['ece']:.3f} | {m[e]['gate_raw']:.3f} |")


if __name__ == '__main__':
    {'sweep': sweep, 'results': results, 'calib': calib}[sys.argv[1]]()
