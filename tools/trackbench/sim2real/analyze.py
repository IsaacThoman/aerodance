#!/usr/bin/env python3
"""Real vs synthetic: per-estimator metrics, rank correlations with bootstrap CIs, domain gaps,
per-joint profiles, failure modes and the pseudo-GT's own error. Reads the metrics.json and
s2r-frames.jsonl files s2r_metrics.ts wrote in the sim2real roots ($S2R/<root>/runs):

  study aist (primary): AIST Dance DB videos with AIST++ GT, and their twins
    aist        real-aist-<id>   real video, projected keypoints3d (real triangulated GT, COCO conventions)
    aistsyn     twin-aist-<id>   synthetic twin (same motion and camera), exact GT (anatomical joint centres)
    aistpgt     real-aist-<id>   the same real video, pseudo-GT
    aistsynpgt  twin-aist-<id>   the same twin, pseudo-GT (same fusion): aistpgt vs aistsynpgt compares
                                 the domains with the same GT kind, isolating appearance from GT conventions
  study eval (second): tracking-eval clips (pseudo-GT only) and their twins
    evreal    real-<seq>       real clip, pseudo-GT
    evsyn     syn-<seq>        twin, exact GT
    evsynpgt  syn-<seq>        twin, pseudo-GT

python analyze.py [--boot 2000]  -> results.json and results.md next to this file.
"""
import argparse
import json
import os
import warnings

import numpy as np
from scipy.stats import kendalltau, spearmanr

warnings.filterwarnings('ignore')
HERE = os.path.dirname(os.path.abspath(__file__))
S2R = os.environ.get('S2R', '/Volumes/development/aerodance-trackbench/sim2real')
AIST = json.load(open(os.path.join(HERE, 'aist.json')))['sequences']
EVAL = json.load(open(os.path.join(HERE, 'sequences.json')))['sequences']
BODY = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
NAMES = {11: 'L shoulder', 12: 'R shoulder', 13: 'L elbow', 14: 'R elbow', 15: 'L wrist', 16: 'R wrist',
         23: 'L hip', 24: 'R hip', 25: 'L knee', 26: 'R knee', 27: 'L ankle', 28: 'R ankle'}
# The models that make up the pseudo-GT: biased wherever the GT is pseudo-GT; never in rank statistics.
REFS = {'ref-yolo26x', 'ref-vitpose-h', 'ref-rtmw-x', 'ref-fused'}
# Python CPU MediaPipe duplicates the game's own MediaPipe runs (same weights): reported, but
# kept out of rank statistics so near-identical pairs don't inflate the correlations.
DUPLICATES = {'mp-lite', 'mp-full', 'mp-heavy'}

DOMAINS = {
    'aist': ('aist', 'real-aist-', 'real AIST video, AIST++ GT'),
    'aistsyn': ('aistsyn', 'twin-aist-', 'synthetic twin, exact GT'),
    'aistpgt': ('aistpgt', 'real-aist-', 'real AIST video, pseudo-GT'),
    'aistsynpgt': ('aistsynpgt', 'twin-aist-', 'synthetic twin, pseudo-GT'),
    'evreal': ('real', 'real-', 'real eval clip, pseudo-GT'),
    'evsyn': ('syn', 'syn-', 'eval twin, exact GT'),
    'evsynpgt': ('synpgt', 'syn-', 'eval twin, pseudo-GT'),
}
STUDIES = {
    'aist': {'seqs': [e['id'] for e in AIST], 'groups': {
        'all': [e['id'] for e in AIST],
        'front': [e['id'] for e in AIST if e['view'].startswith('front')],
        'angled': [e['id'] for e in AIST if e['view'] in ('diagonal', 'side')],
        'back': [e['id'] for e in AIST if e['view'] == 'back']},
        'pairs': [('aist', 'aistsyn'), ('aistpgt', 'aistsynpgt'), ('aistpgt', 'aist'), ('aistsynpgt', 'aistsyn')]},
    'eval': {'seqs': [e['id'] for e in EVAL], 'groups': {
        'all': [e['id'] for e in EVAL],
        'solo': [e['id'] for e in EVAL if e['players'] == 1],
        'multi': [e['id'] for e in EVAL if e['players'] > 1]},
        'pairs': [('evreal', 'evsyn'), ('evreal', 'evsynpgt'), ('evsynpgt', 'evsyn')]},
}

METRICS = {
    'pck20c': ('PCK@0.2 torso (offset-corrected)', lambda m: m['detection']['keypoints']['body']['pck20_corrected'], +1, 3),
    'pck10c': ('PCK@0.1 torso (offset-corrected)', lambda m: m['detection']['keypoints']['body']['pck10_corrected'], +1, 3),
    'err_c': ('body joint error, torso lengths (offset-corrected)', lambda m: m['detection']['keypoints']['body']['error_corrected']['mean'], -1, 3),
    'limb': ('scored-limb angle error, deg (weighted)', lambda m: m['detection']['keypoints']['limbs']['mean_deg_weighted'], -1, 1),
    'limb_c': ('scored-limb angle error, deg (weighted, convention-corrected)', None, -1, 1),
    'usable': ('scored limbs usable', lambda m: m['detection']['keypoints']['limbs']['usable_frac'], +1, 3),
    'recall': ('player recall', lambda m: m['detection']['recall']['players'], +1, 3),
    'fp': ('false positives / 100 frames', lambda m: sum(v or 0 for v in m['detection']['false_positives_per_100_frames'].values()), -1, 1),
    'swaps': ('left/right swapped frames', lambda m: m['detection']['keypoints']['swaps']['body'], -1, 3),
    'sure_wrong': ('confident-but-wrong joints', lambda m: m['detection']['keypoints']['confidence']['sure_wrong'], -1, 3),
    'jitter': ('acceleration error (torso/frame²)', lambda m: m['detection']['jitter']['accel_error']['mean'], -1, 4),
    'id_acc': ('identity accuracy (after numbering)', lambda m: m['tracking']['after_numbering']['identity_accuracy'], +1, 3),
    'switches': ('identity switches', lambda m: sum(m['tracking']['identity_switches'].values()) if isinstance(m['tracking']['identity_switches'], dict) else m['tracking']['identity_switches'], -1, 1),
    'lost': ('tracked player lost (whole scene)', lambda m: m['tracking']['whole_scene']['lost'], -1, 3),
    'score_lost': ('score lost to tracking, fraction of GT score', lambda m: m['score']['score_lost_frac'] if m.get('score') else None, -1, 3),
}


LIMB_W = [1, 1, 1, 1, 0.7, 0.7, 0.7, 0.7, 0.6, 0.4]
FRAME_METRICS = {
    'limb_raw_f': ('scored-limb angle error, deg (weighted, raw, from frame rows)', 'limb'),
    'limb_c': ('scored-limb angle error, deg (weighted, convention-corrected)', 'limb_c'),
}


def frame_metric(domain, est, seq, field):
    rows = frames_rows(domain, est, [seq])
    if not rows:
        return None
    per = [[r[field][i] for r in rows if r.get(field) and r[field][i] is not None] for i in range(len(LIMB_W))]
    num = sum(w * np.mean(v) for w, v in zip(LIMB_W, per) if v)
    den = sum(w for w, v in zip(LIMB_W, per) if v)
    return float(num / den) if den else None


def load(domain, seqs):
    root, prefix, _ = DOMAINS[domain]
    runs = os.path.join(S2R, root, 'runs')
    out = {}
    if not os.path.isdir(runs):
        return out
    for est in sorted(os.listdir(runs)):
        for s in seqs:
            p = os.path.join(runs, est, prefix + s, 'metrics.json')
            if os.path.exists(p):
                out.setdefault(est, {})[s] = json.load(open(p))
    return out


def value(m, key):
    try:
        v = METRICS[key][1](m)
        return None if v is None else float(v)
    except (KeyError, TypeError, AttributeError):
        return None


def table(data, key, seqs, domain=None):
    """estimator -> array over seqs (nan where missing)."""
    out = {}
    if key in FRAME_METRICS:
        for e, d in data.items():
            out[e] = np.array([v if s in d and (v := frame_metric(domain, e, s, FRAME_METRICS[key][1])) is not None else np.nan for s in seqs], float)
        return out
    for e, d in data.items():
        out[e] = np.array([v if (s in d and (v := value(d[s], key)) is not None) else np.nan for s in seqs], float)
    return out


def rank_stat(a, b, ests, idx):
    # Only estimators that ran on (nearly) every sequence of the resample in both domains.
    ests = [e for e in ests if e in a and e in b and np.isfinite(a[e][idx]).mean() >= 0.8 and np.isfinite(b[e][idx]).mean() >= 0.8]
    xa = np.array([np.nanmean(a[e][idx]) if e in a else np.nan for e in ests])
    xb = np.array([np.nanmean(b[e][idx]) if e in b else np.nan for e in ests])
    ok = np.isfinite(xa) & np.isfinite(xb)
    if ok.sum() < 4 or np.ptp(xa[ok]) == 0 or np.ptp(xb[ok]) == 0:
        return np.nan, np.nan, int(ok.sum())
    return spearmanr(xa[ok], xb[ok])[0], kendalltau(xa[ok], xb[ok])[0], int(ok.sum())


def boot_rank(a, b, ests, idx, n_boot, rng):
    """Spearman/Kendall of per-estimator means, with a bootstrap over sequences (resampled jointly in both domains)."""
    rho, tau, n = rank_stat(a, b, ests, idx)
    bs = np.array([rank_stat(a, b, ests, rng.choice(idx, len(idx)))[:2] for _ in range(n_boot)])
    ci = lambda col: [float(v) for v in np.nanpercentile(bs[:, col], [2.5, 97.5])] if np.isfinite(bs[:, col]).any() else [np.nan, np.nan]
    return {'spearman': float(rho), 'spearman_ci': ci(0), 'kendall': float(tau), 'kendall_ci': ci(1), 'n_est': n, 'n_seq': int(len(idx))}


def boot_mean(d, rng, n_boot):
    ok = d[np.isfinite(d)]
    if not len(ok):
        return None
    bs = [np.mean(rng.choice(ok, len(ok))) for _ in range(n_boot)]
    return {'mean': float(np.mean(ok)), 'ci': [float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))], 'n': int(len(ok))}


def frames_rows(domain, est, seqs):
    root, prefix, _ = DOMAINS[domain]
    rows = []
    for s in seqs:
        p = os.path.join(S2R, root, 'runs', est, prefix + s, 's2r-frames.jsonl')
        if os.path.exists(p):
            for line in open(p):
                r = json.loads(line)
                r['seq'] = s
                rows.append(r)
    return rows


def cond_stats(rows):
    """Mean corrected body-joint error and PCK@0.2 with and without each pose condition."""
    out = {}
    for c in ('arms_up', 'back', 'low'):
        for flag in (True, False):
            e = np.array([v for r in rows if r[c] == flag for v in r['err'] if v is not None])
            out[f'{c}={int(flag)}'] = {'n_frames': sum(1 for r in rows if r[c] == flag), 'err': float(e.mean()) if len(e) else None,
                                       'pck20': float((e < 0.2).mean()) if len(e) else None}
    return out


def fmt(v, d=3):
    return '–' if v is None or (isinstance(v, float) and not np.isfinite(v)) else f'{v:.{d}f}'


def ci_txt(x, d=2):
    return f"{fmt(x['spearman'], d)} [{fmt(x['spearman_ci'][0], d)}, {fmt(x['spearman_ci'][1], d)}]"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--boot', type=int, default=2000)
    a = ap.parse_args()
    rng = np.random.default_rng(1)
    res, md = {}, []
    for study, cfg in STUDIES.items():
        seqs = cfg['seqs']
        data = {dom: load(dom, seqs) for dom in {d for p in cfg['pairs'] for d in p}}
        doms = [d for d in DOMAINS if d in data and data[d]]
        if len(doms) < 2:
            continue
        ests = sorted(set.union(*[set(data[d]) for d in doms]))
        # The references are fair estimators against real (AIST++) and exact GT; on pseudo-GT they define the GT.
        R = res[study] = {'domains': doms, 'estimators': ests, 'metrics': {}, 'rank': {}, 'gap': {}, 'joints': {}, 'conditions': {}, 'per_seq': {}}
        md.append(f'\n## Study: {study}\n')
        for key, (label, _, sign, dg) in METRICS.items():
            T = {d: table(data[d], key, seqs, d) for d in doms}
            # Identity and score need the GT's identities; in eval clip c2 the pseudo-GT tracks
            # exchange dancers when they swap places (checked by eye), so c2 is left out of those
            # metrics in every eval domain (paired).
            if study == 'eval' and key in ('id_acc', 'switches', 'lost', 'score_lost'):
                for d in doms:
                    for e in T[d]:
                        T[d][e][seqs.index('c2')] = np.nan
            R['per_seq'][key] = {d: {e: [None if not np.isfinite(v) else float(v) for v in T[d][e]] for e in T[d]} for d in doms}
            R['metrics'][key] = {e: {g: {d: (float(np.nanmean(T[d][e][[seqs.index(s) for s in gs]])) if e in T[d] and np.isfinite(T[d][e][[seqs.index(s) for s in gs]]).any() else None)
                                         for d in doms} for g, gs in cfg['groups'].items()} for e in ests}
            R['rank'][key], R['gap'][key] = {}, {}
            for da, db in cfg['pairs']:
                if da not in T or db not in T:
                    continue
                ranked = [e for e in ests if e not in DUPLICATES and e not in REFS]  # same estimator set for every pair
                pk = f'{da}_vs_{db}'
                R['rank'][key][pk] = {g: boot_rank(T[da], T[db], ranked, np.array([seqs.index(s) for s in gs]), a.boot, rng)
                                      for g, gs in cfg['groups'].items() if len(gs) >= 2}
                R['gap'][key][pk] = {e: boot_mean(T[da][e] - T[db][e], rng, a.boot) for e in ests if e in T[da] and e in T[db]}
        for e in ests:
            R['joints'][e] = {}
            for d in doms:
                pj = np.full((len(seqs), 33), np.nan)
                for i, s in enumerate(seqs):
                    m = data[d].get(e, {}).get(s)
                    if m:
                        for j, v in enumerate(m['detection']['keypoints']['per_joint']):
                            if v and v[1] is not None:
                                pj[i, j] = v[1]
                R['joints'][e][d] = [float(np.nanmean(pj[:, j])) if np.isfinite(pj[:, j]).any() else None for j in BODY]
            R['conditions'][e] = {d: cond_stats(frames_rows(d, e, seqs)) for d in doms}

        # ---- paired difficulty (AIST: same motion, same frame numbers in both domains): are the
        # sequences and frames that are hard in real footage also hard in the twin?
        first = cfg['pairs'][0]
        ranked_main = [e for e in ests if e not in DUPLICATES and e not in REFS]
        if study == 'aist':
            da, db = first
            per = {}
            for dom in (da, db):
                acc = {}
                for e in ranked_main:
                    for r in frames_rows(dom, e, seqs):
                        v = [x for x in r['err'] if x is not None]
                        if v:
                            acc.setdefault((r['seq'], r['frame']), []).append(np.mean(v))
                per[dom] = {k: np.mean(v) for k, v in acc.items() if len(v) >= max(3, len(ranked_main) // 2)}
            keys = sorted(set(per[da]) & set(per[db]))
            fa, fb = np.array([per[da][k] for k in keys]), np.array([per[db][k] for k in keys])
            seq_a = np.array([np.mean([per[da][k] for k in keys if k[0] == s]) for s in seqs if any(k[0] == s for k in keys)])
            seq_b = np.array([np.mean([per[db][k] for k in keys if k[0] == s]) for s in seqs if any(k[0] == s for k in keys)])
            within = [spearmanr([per[da][k] for k in keys if k[0] == s], [per[db][k] for k in keys if k[0] == s])[0] for s in seqs if sum(k[0] == s for k in keys) > 30]
            bs = []
            sidx = np.arange(len(seq_a))
            for _ in range(a.boot):
                pick = rng.choice(sidx, len(sidx))
                bs.append(spearmanr(seq_a[pick], seq_b[pick])[0])
            R['paired_difficulty'] = {
                'frames': len(keys), 'frame_spearman_pooled': float(spearmanr(fa, fb)[0]) if len(keys) > 10 else None,
                'frame_spearman_within_seq_median': float(np.nanmedian(within)) if within else None,
                'frame_spearman_within_seq': [float(x) for x in within],
                'seq_spearman': float(spearmanr(seq_a, seq_b)[0]) if len(seq_a) > 3 else None,
                'seq_spearman_ci': [float(v) for v in np.nanpercentile(bs, [2.5, 97.5])] if bs else None,
                'seq_err': {'real': [float(v) for v in seq_a], 'twin': [float(v) for v in seq_b]},
            }

        # ---- markdown for this study
        if R.get('paired_difficulty'):
            p = R['paired_difficulty']
            md.append(f"\n### {study}: paired difficulty (same motion, same frames)\n")
            md.append(f"Mean over ranked estimators of each frame's offset-corrected body-joint error, real vs twin: Spearman over {p['frames']} paired frames {fmt(p['frame_spearman_pooled'], 2)} pooled, median {fmt(p['frame_spearman_within_seq_median'], 2)} within a sequence; over sequences {fmt(p['seq_spearman'], 2)} [{fmt(p['seq_spearman_ci'][0], 2)}, {fmt(p['seq_spearman_ci'][1], 2)}].")
        for key in ('pck20c', 'err_c', 'limb', 'limb_c', 'recall', 'fp', 'swaps', 'jitter', 'id_acc', 'score_lost'):
            label, _, sign, dg = METRICS[key]
            if not any(R['metrics'][key][e]['all'][d] is not None for e in ests for d in doms):
                continue
            groups = [g for g in cfg['groups'] if g != 'all']
            md.append(f'\n### {study}: {label}\n')
            head = ['estimator'] + [f'{d} (all)' for d in doms] + [f'{first[0]} {g} / {first[1]} {g}' for g in groups] + [f'{first[0]} − {first[1]} (95% CI)']
            md.append('| ' + ' | '.join(head) + ' |')
            md.append('|' + '---|' * len(head))
            key_dom = first[0]
            order = sorted(ests, key=lambda e: (R['metrics'][key][e]['all'][key_dom] is None, -sign * (R['metrics'][key][e]['all'][key_dom] or 0)))
            for e in order:
                m = R['metrics'][key][e]
                gp = R['gap'][key].get(f'{first[0]}_vs_{first[1]}', {}).get(e)
                name = e + (' (ref)' if e in REFS else '') + (' (dup)' if e in DUPLICATES else '')
                cells = [name] + [fmt(m['all'][d], dg) for d in doms] + [f"{fmt(m[g][first[0]], dg)} / {fmt(m[g][first[1]], dg)}" for g in groups]
                cells.append(f"{fmt(gp['mean'], dg)} [{fmt(gp['ci'][0], dg)}, {fmt(gp['ci'][1], dg)}]" if gp else '–')
                md.append('| ' + ' | '.join(cells) + ' |')
        md.append(f'\n### {study}: rank correlation of estimators between domains (Spearman ρ [95% CI], bootstrap over sequences)\n')
        pairs = [f'{da}_vs_{db}' for da, db in cfg['pairs'] if f'{da}_vs_{db}' in R['rank']['pck20c']]
        groups = list(cfg['groups'])
        head = ['metric'] + [f'{p} {g}' for p in pairs for g in groups]
        md.append('| ' + ' | '.join(head) + ' |')
        md.append('|' + '---|' * len(head))
        for key in METRICS:
            cells = [key]
            for p in pairs:
                for g in groups:
                    x = R['rank'][key].get(p, {}).get(g)
                    cells.append(ci_txt(x) if x and np.isfinite(x['spearman']) else '–')
            md.append('| ' + ' | '.join(cells) + ' |')
        md.append(f'\n### {study}: per-joint offset-corrected error (torso lengths), mean over ranked estimators\n')
        md.append('| joint | ' + ' | '.join(doms) + ' |')
        md.append('|---|' + '---:|' * len(doms))
        for k, j in enumerate(BODY):
            vals = [np.nanmean([R['joints'][e][d][k] if R['joints'][e][d][k] is not None else np.nan for e in ranked_main]) for d in doms]
            md.append(f'| {NAMES[j]} | ' + ' | '.join(fmt(v) for v in vals) + ' |')
        md.append(f'\n### {study}: pose conditions, mean offset-corrected body-joint error with / without, mean over ranked estimators\n')
        md.append('| condition | ' + ' | '.join(f'{d} with / without (frames)' for d in doms) + ' |')
        md.append('|---|' + '---|' * len(doms))
        for c in ('arms_up', 'back', 'low'):
            cells = []
            for d in doms:
                w = np.nanmean([R['conditions'][e][d][f'{c}=1']['err'] or np.nan for e in ranked_main])
                wo = np.nanmean([R['conditions'][e][d][f'{c}=0']['err'] or np.nan for e in ranked_main])
                nf = R['conditions'][ranked_main[0]][d][f'{c}=1']['n_frames'] if ranked_main else 0
                cells.append(f'{fmt(w)} / {fmt(wo)} ({nf})')
            md.append(f'| {c} | ' + ' | '.join(cells) + ' |')
    json.dump(res, open(os.path.join(HERE, 'results.json'), 'w'), indent=1, default=lambda o: None)
    open(os.path.join(HERE, 'results.md'), 'w').write('\n'.join(md) + '\n')
    print('\n'.join(md))


if __name__ == '__main__':
    main()
