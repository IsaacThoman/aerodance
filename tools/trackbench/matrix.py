#!/usr/bin/env python3
"""Runs every estimator over every READY scene, then the tracker and metrics, skipping work
that's already done. Two lanes run side by side: the game's own worker in Chromium (GPU, one
at a time) and the Python/native estimators (CPU, --cpu-jobs at a time).

  python3 tools/trackbench/matrix.py [--scenes PREFIX...] [--estimators ID...] [--cpu-jobs 2] [--force]
"""
import argparse
import concurrent.futures as cf
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get('TRACKBENCH_DATA', '/Volumes/development/aerodance-trackbench'))
PY = str(DATA / '.venv/bin/python')
GAME = {'mp-lite-game': 'lite', 'mp-full-game': 'full', 'mp-heavy-game': 'heavy'}
# Python/native runners: run id -> extra args.
NATIVE = {
    'rtmo-s': [], 'rtmo-t': [], 'rtmpose-s': ['--det-interval', '5'], 'rtmpose-m': ['--det-interval', '5'],
    'movenet-multipose': [], 'apple-vision': [], 'yolo26s-pose': [],
}
# The full pass: the game's models and the shippable candidates. The rest run on a subset.
DEFAULT = ['mp-lite-game', 'mp-full-game', 'mp-heavy-game', 'apple-vision', 'rtmo-s', 'rtmpose-s', 'movenet-multipose']
lock = threading.Lock()


def log(msg):
    with lock:
        print(time.strftime('%H:%M:%S'), msg, flush=True)


def run(cmd, logfile):
    logfile.parent.mkdir(parents=True, exist_ok=True)
    with open(logfile, 'a') as f:
        f.write(f'\n$ {" ".join(cmd)}\n')
        f.flush()
        return subprocess.run(cmd, cwd=REPO, stdout=f, stderr=subprocess.STDOUT).returncode == 0


def done(est, scene, name):
    """The output exists and is newer than the scene's render (READY), so a re-render redoes it."""
    p = DATA / 'runs' / est / scene / name
    ready = DATA / 'scenes' / scene / 'READY'
    return p.exists() and p.stat().st_size > 0 and (not ready.exists() or p.stat().st_mtime >= ready.stat().st_mtime)


def scenes(prefixes):
    out = []
    for d in sorted((DATA / 'scenes').iterdir()):
        if not (d / 'READY').exists() or d.name.startswith('_'):
            continue
        if prefixes and not any(d.name.startswith(p) for p in prefixes):
            continue
        out.append(d.name)
    return out


def finish(est, scene, need_track, force):
    logf = DATA / 'runs' / est / scene / 'matrix.log'
    if need_track and (force or not done(est, scene, 'tracked.jsonl')):
        if not run(['node', 'tools/trackbench/harness/track.ts', est, scene], logf):
            log(f'FAIL track {est} {scene}')
            return
    m, t = DATA / 'runs' / est / scene / 'metrics.json', DATA / 'runs' / est / scene / 'tracked.jsonl'
    if force or not done(est, scene, 'metrics.json') or (t.exists() and m.exists() and t.stat().st_mtime > m.stat().st_mtime):
        if not run(['node', 'tools/trackbench/harness/metrics.ts', est, scene], logf):
            log(f'FAIL metrics {est} {scene}')
            return
    log(f'ok {est} {scene}')


def game_lane(jobs, force):
    for est, scene in jobs:
        if force or not done(est, scene, 'tracked.jsonl'):
            logf = DATA / 'runs' / est / scene / 'matrix.log'
            if not run(['node', 'tools/trackbench/harness/run-game.ts', scene, '--model', GAME[est]], logf):
                log(f'FAIL run-game {est} {scene}')
                continue
        finish(est, scene, False, force)


def native_job(est, scene, force):
    if force or not done(est, scene, 'detections.jsonl'):
        logf = DATA / 'runs' / est / scene / 'matrix.log'
        if not run([PY, 'tools/trackbench/estimators/run.py', est, scene, *NATIVE[est]], logf):
            log(f'FAIL run {est} {scene}')
            return
    finish(est, scene, True, force)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scenes', nargs='*', default=[])
    ap.add_argument('--estimators', nargs='*', default=DEFAULT)
    ap.add_argument('--cpu-jobs', type=int, default=2)
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    ss = scenes(a.scenes)
    log(f'{len(ss)} scenes, estimators {a.estimators}')
    game = [(e, s) for s in ss for e in a.estimators if e in GAME]
    native = [(e, s) for e in a.estimators if e in NATIVE for s in ss]
    t = threading.Thread(target=game_lane, args=(game, a.force))
    t.start()
    with cf.ThreadPoolExecutor(a.cpu_jobs) as ex:
        list(ex.map(lambda j: native_job(*j, a.force), native))
    t.join()
    log('matrix done')


if __name__ == '__main__':
    sys.exit(main())
