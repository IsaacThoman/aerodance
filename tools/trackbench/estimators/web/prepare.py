"""Prepare exact ORT tensors for cross-runtime parity, plus original frame URLs."""
import sys, json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from models import DATA, weight
import cv2
import numpy as np
from rtmlib import RTMO
out = DATA/'browser-fixtures'; out.mkdir(exist_ok=True)
inputs = sys.argv[1:] or ['/Volumes/development/aerodance-trackbench/proto/rt/f0001.png',str(Path.home()/'aerodance-tracking-eval/frames/v4/02000.jpg')]
for n, src in zip([1,4],inputs):
    path = Path(src)
    if path.is_dir(): path = sorted([p for p in path.iterdir() if p.suffix in ('.png','.jpg')])[0]
    img = cv2.imread(str(path))
    img = cv2.resize(img,(640,480))
    cv2.imwrite(str(out/f'{n}.png'),img)
    for modelid in ['rtmo-t','rtmo-s','rtmo-m']:
        size = 416 if modelid == 'rtmo-t' else 640
        model = RTMO(str(weight(modelid)),model_input_size=(size,size),backend='onnxruntime',device='cpu',score_thr=.3)
        x, ratio = model.preprocess(img)
        x.transpose(2,0,1).astype('float32').tofile(out/f'{modelid}-{n}.bin')
        results = model.inference(x)
        meta = {'ratio':ratio,'input_size':size,'outputs':[]}
        for j, value in enumerate(results):
            name = f'{modelid}-{n}-out{j}.bin'; value.astype('float32').tofile(out/name)
            meta['outputs'].append({'file':name,'shape':value.shape})
        (out/f'{modelid}-{n}.json').write_text(json.dumps(meta))

# MoveNet Python reference, same centered padding and bilinear half-pixel resize.
import tensorflow as tf
model=tf.saved_model.load(str(DATA/'models/movenet-multipose')).signatures['serving_default']
for n in [1,4]:
    img=cv2.cvtColor(cv2.imread(str(out/f'{n}.png')),cv2.COLOR_BGR2RGB)
    tensor=tf.cast(tf.image.resize_with_pad(tf.convert_to_tensor(img),256,256)[None],tf.int32)
    raw=model(tensor)['output_0'].numpy().reshape(-1).tolist()
    (out/f'movenet-{n}.json').write_text(json.dumps(raw))

# Official TF.js graph and shards, pinned MultiPose release 1.
import urllib.request
root=DATA/'models/movenet-multipose-tfjs';root.mkdir(exist_ok=True)
base='https://tfhub.dev/google/tfjs-model/movenet/multipose/lightning/1/'
if not (root/'model.json').exists():
    urllib.request.urlretrieve(base+'model.json?tfjs-format=file',root/'model.json')
manifest=json.loads((root/'model.json').read_text())
for group in manifest['weightsManifest']:
    for name in group['paths']:
        if not (root/name).exists():urllib.request.urlretrieve(base+name+'?tfjs-format=file',root/name)
