"""Official upstream weights; downloads stay outside the checkout."""
import hashlib
import os
from pathlib import Path
import shutil
import urllib.request
import zipfile

DATA = Path(os.environ.get('TRACKBENCH_DATA', '/Volumes/development/aerodance-trackbench'))
MODELS = DATA / 'models'

def fetch(url, name):
    target = MODELS / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        tmp = target.with_suffix(target.suffix + '.part')
        print(f'Downloading {url}', flush=True)
        urllib.request.urlretrieve(url, tmp)
        tmp.replace(target)
    return target

def weight(estimator):
    if estimator.startswith('mp-'):
        size = estimator[3:]
        return fetch(f'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_{size}/float16/1/pose_landmarker_{size}.task', f'pose_landmarker_{size}.task')
    if estimator == 'rtmw-x':
        target = MODELS / 'rtmw-x.onnx'
        if not target.exists():
            shutil.copyfile(Path.home() / 'wmyb-blender/models/rtmw-x-b8.onnx', target)
        return target
    from rtmlib import Body
    if estimator.startswith('rtmo-'):
        if estimator == 'rtmo-t':
            url = 'https://download.openmmlab.com/mmpose/v1/projects/rtmo/onnx_sdk/rtmo-t_8xb32-600e_body7-416x416-f48f75cb_20231219.zip'
        else:
            url = Body.RTMO_MODE['lightweight' if estimator.endswith('-s') else 'balanced']['pose']
    elif estimator == 'yolox-tiny':
        url = Body.MODE['lightweight']['det']
    else:
        url = Body.MODE['lightweight' if estimator.endswith('-s') else 'balanced']['pose']
    target = MODELS / f'{estimator}.onnx'
    if not target.exists():
        archive = fetch(url, url.split('/')[-1])
        with zipfile.ZipFile(archive) as z:
            candidates = [n for n in z.namelist() if n.endswith('.onnx')]
            if len(candidates) != 1:
                raise ValueError(f'Ambiguous ONNX archive: {candidates}')
            with z.open(candidates[0]) as src, target.open('wb') as dst:
                shutil.copyfileobj(src, dst)
    return target

def identity(path):
    path = Path(path)
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()}
