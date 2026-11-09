"""Compare decoded browser detections with Python on the same 640x480 fixture."""
import sys,json,argparse
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import cv2,numpy as np
from scipy.optimize import linear_sum_assignment
from run import MediaPipe,RTM,MoveNet
from models import DATA
p=DATA/'browser-results/latest.json';report=json.loads(p.read_text());cache={}
for r in report['results']:
    if 'error' in r:continue
    mid,n=r['model'],r['requested_people'];key=(mid,n)
    if key not in cache:
        factory=MediaPipe if mid.startswith('mp-') else MoveNet if mid.startswith('movenet') else RTM
        model=factory(argparse.Namespace(estimator=mid,players=n,det_interval=5))
        img=cv2.imread(str(DATA/f'browser-fixtures/{n}.png'))
        for frame in range(13):pred=model(img,(frame+1)*34)
        cache[key]=pred
    pred=cache[key];web=r['detections'];cost=np.full((len(web),len(pred)),1e6);joints={}
    for i,a in enumerate(web):
        for j,b in enumerate(pred):
            errs=[float(np.linalg.norm((np.array(x[:2])-y[:2])*[640,480])) for x,y in zip(a['kp'],b['kp']) if x is not None and y is not None and min(x[3],y[3])>=.5]
            if errs:cost[i,j]=np.mean(errs);joints[i,j]=errs
    ii,jj=linear_sum_assignment(cost);errors=[v for i,j in zip(ii,jj) if cost[i,j]<160 for v in joints.get((i,j),[])]
    r['python_decoded_parity']={'python_people':len(pred),'browser_people':len(web),'joints':len(errors),'mean_px':float(np.mean(errors)) if errors else None,'max_px':float(max(errors)) if errors else None,'note':'Hungarian mean-joint distance, confidence >=0.5, same frame, MP after 13 repeated VIDEO frames; empty vs empty does not validate coordinates'}
    print(mid,n,r['backend'],r['python_decoded_parity'],flush=True)
p.write_text(json.dumps(report,indent=2)+'\n')
