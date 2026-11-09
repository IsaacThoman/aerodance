#!/usr/bin/env python3
"""Pairwise estimator decisions real vs synthetic (from results.json per-sequence values):
for every pair (a, b) the per-sequence difference a - b, bootstrapped over sequences in each
domain; a decision is 'clear' in a domain when its 95% CI excludes 0, and 'flipped' when it is
clear in both with opposite signs. python pairflips.py [study] [domA] [domB]"""
import itertools
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, 'results.json')))
study, da, db = (sys.argv[1:4] + ['aist', 'aist', 'aistsyn'][len(sys.argv[1:4]):])
EXCL = {'ref-yolo26x', 'ref-vitpose-h', 'ref-rtmw-x', 'ref-fused', 'mp-lite', 'mp-full', 'mp-heavy'}
rng = np.random.default_rng(2)
out = {}
for key in ('err_c', 'pck20c', 'limb_c', 'score_lost'):
    ps = R[study]['per_seq'][key]
    ests = sorted(e for e in ps[da] if e in ps[db] and e not in EXCL and all(v is not None for v in ps[da][e]) and all(v is not None for v in ps[db][e]))
    n = len(ps[da][ests[0]])
    def ci(d):
        bs = [np.mean(d[rng.integers(0, n, n)]) for _ in range(2000)]
        return np.mean(d), np.percentile(bs, 2.5), np.percentile(bs, 97.5)
    agree = flip = clear_a = clear_b = total = 0
    flips = []
    for a, b in itertools.combinations(ests, 2):
        x = ci(np.array(ps[da][a]) - np.array(ps[da][b]))
        y = ci(np.array(ps[db][a]) - np.array(ps[db][b]))
        total += 1
        ca, cb = x[1] > 0 or x[2] < 0, y[1] > 0 or y[2] < 0
        clear_a += ca; clear_b += cb
        if np.sign(x[0]) == np.sign(y[0]):
            agree += 1
        if ca and cb and np.sign(x[0]) != np.sign(y[0]):
            flip += 1; flips.append(f'{a} vs {b}')
    out[key] = {'pairs': int(total), 'same_sign': int(agree), f'clear_in_{da}': int(clear_a), f'clear_in_{db}': int(clear_b), 'clear_flips': int(flip), 'flipped_pairs': flips}
    print(key, json.dumps(out[key]))
