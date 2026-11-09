#!/usr/bin/env python3
"""Fuses the three reference models (refs.py) into a pseudo-GT gt.jsonl in the contract layout.

  fuse_pgt.py <refs.npz> <scene-dir> [--identity c1|c2|c3] [--exact-gt <gt.jsonl>] [--tau 0.1]

People: YOLO26x boxes (conf >= 0.3), duplicates merged, linked over time into tracks
(Hungarian on torso joints, gaps up to 0.5 s). The scene's `players` most present, largest
tracks are players, the rest bystanders. Identity: with --identity, each track's majority
label from the colour oracle (~/aerodance-tracking-eval/gt-<clip>.json centroids, the same
features as harness/gt.ts); with --exact-gt (synthetic twins), the exact GT person the track
matches most; otherwise the track number.

Joints (COCO-17 -> pose-33 slots 0,2,5,7,8,11-16,23-28): the median of the references that
are confident (YOLO/ViTPose >= 0.5, RTMW raw >= 2.5). A joint is *agreed* (`pgt_ok` 1) when
all three are confident and each lies within tau person-scales of the median. Other slots
(eye corners, mouth, hands, feet) are filled from neighbours or RTMW only and never agreed.
`vis` is 3 outside the picture or in reframe padding, else 0 (self-occlusion is unknown).

Scale: a person's size is their robust 2D torso (max of shoulder-hip midline length and
shoulder width / 0.75, the 90th percentile over +-1 s of their track), written as a fake 3D
torso (`kp3d` shoulders 1 m above hips, depth 1/scale, meta focal 1 picture height) so the
harness's torsoScale returns it unchanged and doesn't shrink when the person bends or turns.
"""
import argparse
import json
import os

import numpy as np
from PIL import Image
from scipy.optimize import linear_sum_assignment

COCO_TO_33 = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
FILL = {1: 2, 3: 2, 4: 5, 6: 5, 9: 0, 10: 0, 17: 15, 19: 15, 21: 15, 18: 16, 20: 16, 22: 16}
# RTMW whole-body feet (indices into refs' w[:, 17:23]: left big toe, small toe, heel, right big toe, small toe, heel)
FEET = {29: 19, 30: 22, 31: 17, 32: 20}
TORSO = [11, 12, 23, 24]
BODY = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
THRESH = {'y': 0.5, 'v': 0.5, 'w': 2.5}
EVAL = os.path.expanduser('~/aerodance-tracking-eval')


def scale2d(kp, aspect):
    """Per-frame person size in picture heights from 33-slot normalized coordinates."""
    s = (kp[11] + kp[12]) / 2
    h = (kp[23] + kp[24]) / 2
    d = lambda a, b: np.hypot((a[0] - b[0]) * aspect, a[1] - b[1])
    return max(d(s, h), d(kp[11], kp[12]) / 0.75, 1e-3)


def oracle_label(img, kp_px, centroids):
    """harness/gt.ts identify(): rgb-normalized 5x5 colour means at shoulders, hips, knees."""
    h, w = img.shape[:2]
    f = []
    for j in (11, 12, 23, 24, 25, 26):
        cx, cy = int(round(kp_px[j][0])), int(round(kp_px[j][1]))
        patch = img[max(0, cy - 2):cy + 3, max(0, cx - 2):cx + 3].reshape(-1, 3).astype(np.float64)
        if not len(patch) or not (0 <= cx < w and 0 <= cy < h):
            return None
        c = np.round(patch.mean(0))
        s = c.sum() + 1
        f += [c[0] / s, c[1] / s, c.sum() / 765 * 0.7]
    d = np.linalg.norm(np.array(centroids) - np.array(f), axis=1)
    o = np.argsort(d)
    return f'id{o[0]}' if d[o[0]] < 0.75 * d[o[1]] else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('refs'); ap.add_argument('scene')
    ap.add_argument('--identity'); ap.add_argument('--exact-gt'); ap.add_argument('--tau', type=float, default=0.1)
    a = ap.parse_args()
    R = np.load(a.refs)
    spec = json.load(open(os.path.join(a.scene, 'spec.json')))
    meta = json.load(open(os.path.join(a.scene, 'meta.json')))
    W, H = int(R['width']), int(R['height'])
    aspect = W / H
    n_frames = int(R['n_frames'])
    cb = meta.get('source', {}).get('content_box', [0, 0, 1, 1])
    players = spec['players']

    # ---- per detection: fused coordinates and agreement
    frame, box = R['frame'], R['box']
    refs = {'y': R['y'], 'v': R['v'], 'w': R['w'][:, :17]}
    n = len(frame)
    xy = {k: refs[k][..., :2] / [W, H] for k in refs}
    conf = {k: refs[k][..., 2] >= THRESH[k] for k in refs}
    allxy = np.stack([xy['y'], xy['v'], xy['w']])            # 3, n, 17, 2
    allok = np.stack([conf['y'], conf['v'], conf['w']])       # 3, n, 17
    masked = np.where(allok[..., None], allxy, np.nan)
    with np.errstate(all='ignore'):
        med_conf = np.nanmedian(masked, 0)
    med_all = np.median(allxy, 0)
    nconf = allok.sum(0)
    fused = np.where((nconf >= 2)[..., None], med_conf, med_all)  # n, 17, 2
    kp33 = np.zeros((n, 33, 2))
    kp33[:, COCO_TO_33] = fused
    for dst, src in FILL.items():
        kp33[:, dst] = kp33[:, src]
    feet = R['w'][:, 17:23, :2] / [W, H]
    for dst, src in FEET.items():
        kp33[:, dst] = feet[:, src - 17]
    fscale = np.array([scale2d(k, aspect) for k in kp33])

    # ---- duplicates: two boxes on one person (fused poses within 0.2 scales) keep the more confident
    keep = np.ones(n, bool)
    for f in np.unique(frame):
        idx = np.where(frame == f)[0]
        idx = idx[np.argsort(-box[idx, 4])]
        for i, p in enumerate(idx):
            if not keep[p]:
                continue
            for q in idx[i + 1:]:
                if keep[q]:
                    d = np.mean(np.hypot((kp33[p, BODY, 0] - kp33[q, BODY, 0]) * aspect, kp33[p, BODY, 1] - kp33[q, BODY, 1])) / fscale[p]
                    if d < 0.2:
                        keep[q] = False
    keep &= box[:, 4] >= 0.3

    # ---- tracks
    by_frame = {f: [i for i in np.where((frame == f) & keep)[0]] for f in range(1, n_frames + 1)}
    track = -np.ones(n, int)
    active = {}  # track id -> (last det index, last frame)
    next_id = 0
    for f in range(1, n_frames + 1):
        dets = by_frame[f]
        tids = [t for t, (_, lf) in active.items() if f - lf <= 15]
        if dets and tids:
            cost = np.full((len(dets), len(tids)), 1e6)
            for i, p in enumerate(dets):
                for j, t in enumerate(tids):
                    q = active[t][0]
                    d = np.mean(np.hypot((kp33[p, TORSO, 0] - kp33[q, TORSO, 0]) * aspect, kp33[p, TORSO, 1] - kp33[q, TORSO, 1])) / max(fscale[p], fscale[q])
                    if d < 0.6:
                        cost[i, j] = d
            ri, ci = linear_sum_assignment(cost)
            matched = {i: tids[j] for i, j in zip(ri, ci) if cost[i, j] < 1e6}
        else:
            matched = {}
        for i, p in enumerate(dets):
            t = matched.get(i)
            if t is None:
                t = next_id
                next_id += 1
            track[p] = t
            active[t] = (p, f)

    # ---- stitch tracklets: a track that starts within 2 s after another ended, near where it ended
    # (torso centre within 1.2 person scales), continues it; nearest gaps first.
    def centre(p):
        return np.array([kp33[p, TORSO, 0].mean() * aspect, kp33[p, TORSO, 1].mean()])
    while True:
        ids = np.unique(track[track >= 0])
        span = {t: (frame[track == t].min(), frame[track == t].max()) for t in ids}
        best = None
        for ta in ids:
            pa = np.where((track == ta) & (frame == span[ta][1]))[0][0]
            for tb in ids:
                if tb == ta or not (0 < span[tb][0] - span[ta][1] <= 60):
                    continue
                pb = np.where((track == tb) & (frame == span[tb][0]))[0][0]
                d = np.linalg.norm(centre(pa) - centre(pb)) / max(fscale[pa], fscale[pb])
                if d < 1.2 and (best is None or (span[tb][0] - span[ta][1], d) < best[0]):
                    best = ((span[tb][0] - span[ta][1], d), ta, tb)
        if best is None:
            break
        track[track == best[2]] = best[1]

    # ---- robust scale per track (90th percentile over +-30 frames)
    rscale = fscale.copy()
    for t in np.unique(track[track >= 0]):
        idx = np.where(track == t)[0]
        fr = frame[idx]
        for k, p in enumerate(idx):
            win = idx[np.abs(fr - fr[k]) <= 30]
            rscale[p] = np.percentile(fscale[win], 90)

    # ---- agreement
    dev = np.hypot((allxy[..., 0] - fused[None, ..., 0]) * aspect, allxy[..., 1] - fused[None, ..., 1]) / rscale[None, :, None]
    agreed = allok.all(0) & (dev.max(0) <= a.tau)  # n, 17

    # ---- identity per track
    label = {}
    tids = [t for t in np.unique(track[track >= 0])]
    if a.identity:
        centroids = json.load(open(os.path.join(EVAL, f'gt-{a.identity}.json')))
        votes = {t: {} for t in tids}
        for f in range(1, n_frames + 1):
            dets = by_frame[f]
            if not dets:
                continue
            img = np.asarray(Image.open(os.path.join(a.scene, 'frames', f'{f:06d}.jpg')).convert('RGB'))
            for p in dets:
                if not agreed[p, 5:7].all() or not agreed[p, 11:13].all():
                    continue
                l = oracle_label(img, kp33[p] * [W, H], centroids)
                if l:
                    votes[track[p]][l] = votes[track[p]].get(l, 0) + 1
        for t in tids:
            v = votes[t]
            tot = sum(v.values())
            if tot >= 5:
                best = max(v, key=v.get)
                if v[best] / tot >= 0.7:
                    label[t] = best
    elif a.exact_gt:
        egt = {}
        for line in open(a.exact_gt):
            d = json.loads(line)
            egt[d['frame']] = d['people']
        votes = {t: {} for t in tids}
        for p in np.where(keep)[0]:
            best, bd = None, 0.5
            for g in egt.get(int(frame[p]), []):
                gk = np.array(g['kp'])[:, :2]
                d = np.mean(np.hypot((gk[TORSO, 0] - kp33[p, TORSO, 0]) * aspect, gk[TORSO, 1] - kp33[p, TORSO, 1])) / rscale[p]
                if d < bd:
                    best, bd = g['id'], d
            if best:
                votes[track[p]][best] = votes[track[p]].get(best, 0) + 1
        for t in tids:
            v = votes[t]
            if v:
                best = max(v, key=v.get)
                if v[best] / sum(v.values()) >= 0.7:
                    label[t] = best
    # Tracks with the same label that never overlap in time are one person; others keep their track id.
    person = {t: label.get(t, f't{t}') for t in tids}
    for lbl in set(label.values()):
        ts = [t for t in tids if label.get(t) == lbl]
        frames_of = {t: set(frame[track == t]) for t in ts}
        ts.sort(key=lambda t: -len(frames_of[t]))
        used = set()
        for t in ts:
            if frames_of[t] & used:
                person[t] = f'{lbl}-t{t}'  # overlapping duplicate label: a conflict, keep apart
            else:
                used |= frames_of[t]

    # ---- players: the most present (frames x size) persons
    presence = {}
    for p in np.where(keep)[0]:
        presence[person[track[p]]] = presence.get(person[track[p]], 0) + rscale[p]
    ranked = sorted(presence, key=lambda k: -presence[k])
    roles = {k: ('player' if i < players else 'bystander') for i, k in enumerate(ranked)}
    order = {k: i for i, k in enumerate(ranked)}

    # ---- write
    stats = {'tau': a.tau, 'frames': n_frames, 'detections': int(keep.sum()), 'tracks': len(tids), 'persons': len(ranked),
             'players': [k for k in ranked if roles[k] == 'player'], 'player_presence_frac': {},
             'agreed_frac_body': None, 'agreed_frac_by_joint': {}, 'identity': a.identity or ('exact' if a.exact_gt else 'tracks'),
             'labelled_tracks': len(label), 'all_confident_frac_body': None}
    body_cols = [COCO_TO_33.index(j) for j in BODY]
    pl = np.array([keep[p] and roles[person[track[p]]] == 'player' for p in range(n)])
    if pl.any():
        stats['agreed_frac_body'] = round(float(agreed[pl][:, body_cols].mean()), 4)
        stats['all_confident_frac_body'] = round(float(allok.all(0)[pl][:, body_cols].mean()), 4)
        for c, j in zip(body_cols, BODY):
            stats['agreed_frac_by_joint'][j] = round(float(agreed[pl][:, c].mean()), 4)
    with open(os.path.join(a.scene, 'gt.jsonl'), 'w') as g:
        for f in range(1, n_frames + 1):
            people = []
            for p in by_frame[f]:
                pid = person[track[p]]
                k = kp33[p]
                ok = np.zeros(33, int)
                ok[COCO_TO_33] = agreed[p]
                inside = (k[:, 0] >= cb[0]) & (k[:, 0] <= cb[2]) & (k[:, 1] >= cb[1]) & (k[:, 1] <= cb[3])
                z = 1.0 / rscale[p]
                kp = [[round(float(x), 5), round(float(y), 5), round(z, 4), 0 if ins else 3] for (x, y), ins in zip(k, inside)]
                kp3d = [[0.0, 0.0, 1.0] if j in (11, 12) else [0.0, 0.0, 0.0] for j in range(33)]
                b = box[p, :4] / [W, H, W, H]
                people.append({'id': pid, 'role': roles[pid], 'index': order[pid], 'kp': kp, 'kp3d': kp3d,
                               'bbox': [round(float(v), 5) for v in np.clip(b, 0, 1)], 'visible_frac': None,
                               'in_frame': True, 'phase': 'dance', 'pgt_ok': ok.tolist(), 'pgt_scale': round(float(rscale[p]), 5)})
            g.write(json.dumps({'frame': f, 't_ms': round((f - 1) * 1000 / 30, 3), 'people': people}) + '\n')
    for k in stats['players']:
        stats['player_presence_frac'][k] = round(sum(1 for p in np.where(keep)[0] if person[track[p]] == k) / n_frames, 4)
    meta['camera'] = {'width': W, 'height': H, 'K': [[H, 0, W / 2], [0, H, H / 2], [0, 0, 1]],
                      'note': 'pseudo-GT: focal set to 1 picture height so the fake kp3d torso gives the robust 2D torso scale'}
    meta['pgt'] = stats
    json.dump(meta, open(os.path.join(a.scene, 'meta.json'), 'w'), indent=1)
    print(os.path.basename(a.scene), json.dumps({k: stats[k] for k in ('persons', 'players', 'player_presence_frac', 'agreed_frac_body', 'labelled_tracks')}))


if __name__ == '__main__':
    main()
