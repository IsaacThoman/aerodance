#!/usr/bin/env python3
"""Contract-v1 inference. See README.md for runtime and confidence semantics."""
import argparse
import importlib.metadata
import json
import platform
import os
import sys
import importlib.util
import subprocess
import time
from pathlib import Path
import cv2
import numpy as np
from models import DATA, MODELS, fetch, identity, weight

COCO_TO_MP = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
IDS = ['mp-lite', 'mp-full', 'mp-heavy', 'rtmo-t', 'rtmo-s', 'rtmo-m', 'rtmpose-s', 'rtmpose-m', 'rtmw-x', 'movenet-multipose', 'movenet-lightning', 'movenet-thunder', 'apple-vision', 'apple-vision-3d', 'yolo11n-pose', 'yolo11s-pose', 'yolo26n-pose', 'yolo26s-pose']

def mapped(points, scores, width, height, simcc=False):
    # A fixed, explicit transform, not per-frame min/max (which changes the 0.5 gate).
    conf = np.clip(np.asarray(scores) / (10.0 if simcc else 1.0), 0, 1)
    mapping = dict(enumerate(COCO_TO_MP))
    if len(points) == 26:  # Halpe: head/neck/pelvis 17..19; big toes 20/21; heels 24/25
        mapping.update({20: 31, 21: 32, 24: 29, 25: 30})
    elif len(points) == 133:  # COCO WholeBody feet: L big/small/heel, R big/small/heel
        mapping.update({17: 31, 19: 29, 20: 32, 22: 30})
        # 68-point face starts at 23, hands at 91/112 (wrist + 20 finger joints).
        # Face 36/39 are subject-right outer/inner; 42/45 subject-left inner/outer.
        mapping.update({65: 1, 68: 3, 62: 4, 59: 6, 77: 9, 71: 10,
                        111: 17, 132: 18, 99: 19, 120: 20, 95: 21, 116: 22})
    kp = [None] * 33
    for src, dst in mapping.items():
        x, y = points[src][:2]
        if np.isfinite([x, y, conf[src]]).all():
            kp[dst] = [float(x / width), float(y / height), 0, float(conf[src])]
    return {'kp': kp, 'score': float(np.mean(conf[:17]))}

class MediaPipe:
    def __init__(self, args):
        import mediapipe as mp
        self.mp = mp
        path = weight(args.estimator)
        self.model = mp.tasks.vision.PoseLandmarker.create_from_options(mp.tasks.vision.PoseLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(path)),
            running_mode=mp.tasks.vision.RunningMode.VIDEO, num_poses=args.players,
            min_pose_detection_confidence=.5, min_pose_presence_confidence=.5, min_tracking_confidence=.5))
        self.info = {'runtime': f'mediapipe {mp.__version__} Python Tasks CPU', 'weights': [identity(path)], 'confidence': 'min(visibility,presence)', 'num_poses': args.players}
    def __call__(self, img, timestamp):
        result = self.model.detect_for_video(self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=cv2.cvtColor(img, cv2.COLOR_BGR2RGB)), round(timestamp))
        people = []
        for pose in result.pose_landmarks:
            kp = [[p.x, p.y, p.z, min(p.visibility, p.presence)] for p in pose]
            people.append({'kp': kp, 'score': float(np.mean([p[3] for p in kp]))})
        return people

class RTM:
    def __init__(self, args):
        from rtmlib import RTMO, RTMPose, YOLOX
        import onnxruntime as ort
        self.raw_scale = 10.0 if args.estimator == 'rtmw-x' else 1.0
        self.one_stage = args.estimator.startswith('rtmo-')
        self.interval, self.boxes, self.frame = args.det_interval, [], 0
        path = weight(args.estimator)
        paths = [path]
        size = (416, 416) if args.estimator == 'rtmo-t' else (640, 640)
        if self.one_stage:
            self.pose = RTMO(str(path), model_input_size=size, backend='onnxruntime', device='cpu', score_thr=.3)
        else:
            size = (288, 384) if args.estimator == 'rtmw-x' else (192, 256)
            self.pose = RTMPose(str(path), model_input_size=size, backend='onnxruntime', device='cpu')
            batch = self.pose.session.get_inputs()[0].shape[0]
            if isinstance(batch, int) and batch > 1:
                # Supplied RTMW export is fixed batch 8. Execute honestly, discard padding.
                session = self.pose.session
                def fixed_batch(img):
                    tensor = np.repeat(img.transpose(2,0,1)[None].astype(np.float32), batch, axis=0)
                    return [v[:1] for v in session.run(None, {session.get_inputs()[0].name: tensor})]
                self.pose.inference = fixed_batch
            detpath = weight('yolox-tiny')
            paths.append(detpath)
            self.det = YOLOX(str(detpath), model_input_size=(416, 416), backend='onnxruntime', device='cpu', score_thr=.3)
        self.info = {'runtime': f'onnxruntime {ort.__version__} CPUExecutionProvider / rtmlib {importlib.metadata.version("rtmlib")}', 'weights': [identity(p) for p in paths], 'confidence': f'clip(raw/{self.raw_scale},0,1), uncalibrated', 'det_interval': self.interval, 'detector': None if self.one_stage else 'YOLOX-tiny HumanArt 416', 'input_size': size}
    def __call__(self, img, timestamp):
        h, w = img.shape[:2]
        if self.one_stage:
            points, scores = self.pose(img)
        else:
            if self.frame % self.interval == 0 or not len(self.boxes):
                self.boxes = self.det(img)
            self.frame += 1
            if not len(self.boxes):
                return []  # RTMLib otherwise silently runs a whole-frame crop.
            points, scores = self.pose(img, bboxes=self.boxes)
            self.boxes = []
            for p, s in zip(points, scores):
                good = p[s > .2 * self.raw_scale]
                if len(good) >= 4:
                    lo, hi = good.min(axis=0), good.max(axis=0)
                    pad = np.maximum((hi-lo) * .15, 10)
                    self.boxes.append([max(0, lo[0]-pad[0]), max(0, lo[1]-pad[1]), min(w, hi[0]+pad[0]), min(h, hi[1]+pad[1])])
        return [mapped(p, s, w, h, self.raw_scale == 10.0) for p, s in zip(points, scores) if np.max(s) > 0]

class MoveNet:
    def __init__(self, args):
        import tarfile
        import tensorflow as tf
        self.tf = tf
        self.multi = args.estimator == 'movenet-multipose'
        variant = 'multipose/lightning/1' if self.multi else f'singlepose/{args.estimator.split("-")[-1]}/4'
        archive = fetch(f'https://tfhub.dev/google/movenet/{variant}?tf-hub-format=compressed', args.estimator+'.tar.gz')
        dest = MODELS / args.estimator
        if not (dest/'saved_model.pb').exists():
            with tarfile.open(archive) as t:
                t.extractall(dest, filter='data')
        self.model = tf.saved_model.load(str(dest)).signatures['serving_default']
        self.size = 256 if self.multi or args.estimator.endswith('thunder') else 192
        self.info = {'runtime': f'TensorFlow {tf.__version__} CPU', 'weights': [identity(archive)], 'confidence': 'model keypoint score; person score for MultiPose', 'input_size': self.size}
    def __call__(self, img, timestamp):
        tf, size = self.tf, self.size
        h, w = img.shape[:2]
        # TF's centered resize_with_pad, undo actual integer padding after inference.
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        ratio = min(size/w, size/h)
        nh, nw = int(h*ratio), int(w*ratio)
        top, left = (size-nh)//2, (size-nw)//2
        x = tf.image.resize_with_pad(tf.convert_to_tensor(rgb), size, size)
        out = self.model(tf.cast(x[None], tf.int32))['output_0'].numpy()
        rows = out[0] if self.multi else [out[0, 0].reshape(-1)]
        people = []
        for row in rows:
            if self.multi and row[55] < .2:
                continue
            p = np.asarray(row[:51]).reshape(17, 3)
            xy = np.stack([(p[:,1]*size-left)*w/nw, (p[:,0]*size-top)*h/nh], axis=1)
            person = mapped(xy, p[:,2], w, h)
            if self.multi: person['score'] = float(row[55])
            people.append(person)
        return people

class Yolo:
    def __init__(self, args):
        from ultralytics import YOLO, __version__
        path = fetch(f'https://github.com/ultralytics/assets/releases/download/v8.4.0/{args.estimator}.pt', args.estimator+'.pt')
        self.model = YOLO(str(path))
        self.info = {'runtime': f'ultralytics {__version__} PyTorch CPU', 'weights': [identity(path)], 'license': 'AGPL-3.0 reference only; NOT for proprietary shipment', 'confidence': 'model sigmoid confidence'}
    def __call__(self, img, timestamp):
        out = self.model.predict(img, imgsz=640, device='cpu', verbose=False, conf=.25)[0]
        h, w = img.shape[:2]
        people = []
        for p, score in zip(out.keypoints.data.cpu().numpy(), out.boxes.conf.cpu().numpy()):
            person = mapped(p[:,:2], p[:,2], w, h)
            person['score'] = float(score)
            people.append(person)
        return people

def resolve(args):
    source = Path(args.scene).expanduser()
    if not source.is_dir(): source = DATA / 'scenes' / args.scene / 'frames'
    if (source/'frames').is_dir(): source = source/'frames'
    specpath = source.parent/'spec.json'
    spec = json.loads(specpath.read_text()) if specpath.exists() else {}
    args.players = args.players or spec.get('players', 1)
    args.fps = args.fps or spec.get('fps', 30)
    if args.fps <= 0 or args.fps > 1000: raise ValueError('fps must be in (0,1000] for VIDEO timestamps')
    if source.is_relative_to(DATA/'scenes') and not (source.parent/'READY').exists():
        raise ValueError(f'Render is incomplete: {source.parent}/READY missing')
    sceneid = source.parent.name if source.name == 'frames' else source.name
    frames = sorted(p for p in source.iterdir() if p.suffix.lower() in ('.jpg','.jpeg','.png') and p.stem not in ('sheet','contact'))
    frames = frames[args.start-1:][:args.limit or None]
    if not frames: raise ValueError(f'No frames in {source}')
    return frames, DATA/'runs'/(args.run_id or args.estimator)/sceneid

def main():
    ap = argparse.ArgumentParser(__doc__)
    ap.add_argument('estimator', choices=IDS); ap.add_argument('scene')
    ap.add_argument('--players', type=int); ap.add_argument('--fps', type=float)
    ap.add_argument('--limit', type=int, default=0); ap.add_argument('--start', type=int, default=1)
    ap.add_argument('--det-interval', type=int, default=5)
    ap.add_argument('--run-id'); args = ap.parse_args()
    if args.det_interval < 1 or args.start < 1: ap.error('interval/start must be positive')
    if args.estimator.startswith('yolo') and importlib.util.find_spec('ultralytics') is None:
        python = Path.home()/'wmyb-blender/.venv/bin/python'
        if not python.exists(): raise RuntimeError('YOLO references need an environment with ultralytics; see README')
        os.execv(str(python), [str(python), str(Path(__file__).resolve()), *sys.argv[1:]])
    frames, out = resolve(args); out.mkdir(parents=True, exist_ok=True)
    if args.estimator.startswith('apple-vision'):
        binary = DATA/'bin/apple-vision'
        binary.parent.mkdir(exist_ok=True)
        src = Path(__file__).with_name('vision.swift')
        if not binary.exists() or binary.stat().st_mtime < src.stat().st_mtime:
            subprocess.run(['swiftc', '-O', str(src), '-o', str(binary)], check=True)
        manifest = out/'frames.txt'; manifest.write_text('\n'.join(map(str,frames)))
        subprocess.run([str(binary), str(manifest), str(out), str(args.fps), str(args.start), '3d' if args.estimator.endswith('3d') else '2d'], check=True)
        return
    factory = MediaPipe if args.estimator.startswith('mp-') else RTM if args.estimator.startswith('rtm') else MoveNet if args.estimator.startswith('movenet') else Yolo
    start = time.perf_counter(); model = factory(args); init_ms = (time.perf_counter()-start)*1000
    rows, durations = [], []
    tmp = out/'detections.jsonl.partial'
    with tmp.open('w') as f:
        for index, path in enumerate(frames, args.start):
            # Numeric scene filenames preserve GT identity; arbitrary footage/proto uses ordinal.
            frame = int(path.stem) if path.stem.isdigit() else index
            img = cv2.imread(str(path))
            if img is None: raise ValueError(f'Cannot decode {path}')
            t_ms = (frame-1)*1000/args.fps
            start = time.perf_counter(); people = model(img, t_ms); ms = (time.perf_counter()-start)*1000
            row = {'frame':frame, 't_ms':t_ms, 'inference_ms':ms, 'people':people}
            f.write(json.dumps(row, allow_nan=False)+'\n'); durations.append(ms)
    tmp.replace(out/'detections.jsonl')
    info = {**model.info, 'estimator':args.estimator, 'machine':platform.platform(), 'settings':vars(args), 'init_ms':init_ms, 'frames':len(frames), 'source':str(frames[0].parent), 'timing':'decode excluded; preprocessing, inference, decoding/mapping included; first frame retained', 'mean_ms':float(np.mean(durations)), 'p50_ms':float(np.median(durations)), 'p95_ms':float(np.percentile(durations,95))}
    (out/'run.json').write_text(json.dumps(info, indent=2)+'\n')
    print(json.dumps({'out':str(out), 'mean_ms':info['mean_ms'], 'frames':len(frames)}))

if __name__ == '__main__': main()
