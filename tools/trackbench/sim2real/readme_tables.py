#!/usr/bin/env python3
"""Compact tables for README.md from results.json (python readme_tables.py > /tmp/tables.md)."""
import json
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, 'results.json')))
REFS = {'ref-yolo26x', 'ref-vitpose-h', 'ref-rtmw-x', 'ref-fused'}
DUP = {'mp-lite', 'mp-full', 'mp-heavy'}


def f(v, d=3):
    return '–' if v is None or (isinstance(v, float) and not np.isfinite(v)) else f'{v:.{d}f}'


def gap(study, key, pair, e, d=3):
    g = R[study]['gap'][key].get(pair, {}).get(e)
    return f"{f(g['mean'], d)} [{f(g['ci'][0], d)}, {f(g['ci'][1], d)}]" if g else '–'


def rank(study, key, pair, group='all'):
    x = R[study]['rank'][key].get(pair, {}).get(group)
    if not x or x['spearman'] is None or not np.isfinite(x['spearman']):
        return '–'
    return f"{x['spearman']:.2f} [{x['spearman_ci'][0]:.2f}, {x['spearman_ci'][1]:.2f}]"


def main_table(study, a, b, pa, pb, label_a, label_b, keys):
    M = R[study]['metrics']
    ests = [e for e in R[study]['estimators'] if e not in DUP]
    ests.sort(key=lambda e: (M['err_c'][e]['all'][a] is None, M['err_c'][e]['all'][a] or 0))
    head = ['estimator']
    for k, lab, dg in keys:
        head += [f'{lab} {label_a}', f'{lab} {label_b}', f'{lab} {label_a} − {label_b} [95% CI]']
    print('| ' + ' | '.join(head) + ' |')
    print('|' + '---|' * len(head))
    for e in ests:
        row = [e + (' (ref)' if e in REFS else '')]
        for k, lab, dg in keys:
            row += [f(M[k][e]['all'][a], dg), f(M[k][e]['all'][b], dg), gap(study, k, f'{a}_vs_{b}', e, dg)]
        print('| ' + ' | '.join(row) + ' |')


if __name__ == '__main__':
    print('\n#### AIST: real video (AIST++ GT) vs twin (exact GT)\n')
    main_table('aist', 'aist', 'aistsyn', None, None, 'real', 'twin',
               [('err_c', 'err', 3), ('limb_c', 'limb°', 1), ('score_lost', 'score lost', 3)])
    print('\n#### AIST: same GT kind on both sides (pseudo-GT from the same ensemble)\n')
    main_table('aist', 'aistpgt', 'aistsynpgt', None, None, 'real', 'twin', [('err_c', 'err', 3), ('score_lost', 'score lost', 3)])
    print('\n#### Rank correlations (Spearman ρ [95% CI], bootstrap over sequence pairs)\n')
    print('| metric | AIST real vs twin (n=18) | AIST real vs twin, both pseudo-GT | AIST pseudo-GT vs AIST++ GT, same real frames | eval real vs twin (exact GT) | eval real vs twin, both pseudo-GT |')
    print('|---|---|---|---|---|---|')
    for k in ('pck20c', 'pck10c', 'err_c', 'limb', 'limb_c', 'usable', 'sure_wrong', 'jitter', 'swaps', 'recall', 'fp', 'lost', 'id_acc', 'score_lost'):
        print(f"| {k} | {rank('aist', k, 'aist_vs_aistsyn')} | {rank('aist', k, 'aistpgt_vs_aistsynpgt')} | {rank('aist', k, 'aistpgt_vs_aist')} | {rank('eval', k, 'evreal_vs_evsyn')} | {rank('eval', k, 'evreal_vs_evsynpgt')} |")
    print('\n#### AIST by view (Spearman ρ, real vs twin exact)\n')
    print('| metric | front (9) | angled (7) | back (2) |')
    print('|---|---|---|---|')
    for k in ('err_c', 'limb_c', 'score_lost'):
        print(f"| {k} | {rank('aist', k, 'aist_vs_aistsyn', 'front')} | {rank('aist', k, 'aist_vs_aistsyn', 'angled')} | {rank('aist', k, 'aist_vs_aistsyn', 'back')} |")
    print('\n#### Eval clips: real (pseudo-GT) vs twin (exact and pseudo-GT)\n')
    main_table('eval', 'evreal', 'evsynpgt', None, None, 'real', 'twin pGT', [('err_c', 'err', 3), ('score_lost', 'score lost', 3), ('id_acc', 'id acc', 3)])
    pdiff = R['aist'].get('paired_difficulty')
    if pdiff:
        print(f"\npaired difficulty: frames {pdiff['frames']} pooled {pdiff['frame_spearman_pooled']:.2f}, within-seq median {pdiff['frame_spearman_within_seq_median']:.2f}, sequences {pdiff['seq_spearman']:.2f} {pdiff['seq_spearman_ci']}")
