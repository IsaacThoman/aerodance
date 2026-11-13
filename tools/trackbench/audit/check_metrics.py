import os
import json
from pathlib import Path
import numpy as np
from scipy.optimize import linear_sum_assignment
D=Path(os.environ.get('TRACKBENCH_DATA','/Volumes/development/aerodance-trackbench')); B=[11,12,13,14,15,16,23,24,25,26,27,28]; T=[11,12,23,24]; M={i:i+1 if i%2 else i-1 for i in B}; out={}
for sid in ['base-solo','cam-fov-120']:
 d=D/'scenes'/sid; meta=json.loads((d/'meta.json').read_text()); W,H=meta['resolution']; A=W/H; focal=meta['camera']['K'][0][0]/H; gt={g['frame']:g for g in map(json.loads,(d/'gt.jsonl').read_text().splitlines())}; run=D/'runs'/'rtmo-s'/sid; dets=list(map(json.loads,(run/'detections.jsonl').read_text().splitlines())); errors=[]; found=total=0
 for f in dets:
  g=gt[f['frame']]; scales=[]
  for p in g['people']:
   P=np.array(p['kp3d']); scales.append(focal*np.linalg.norm((P[11]+P[12]-P[23]-P[24])/2)/np.mean(np.array(p['kp'])[T,2]))
  cost=np.ones((len(f['people']),len(g['people'])))*1e9
  for i,dp in enumerate(f['people']):
   for k,p in enumerate(g['people']):
    es=[]
    for flip in [False,True]:
     v=[np.linalg.norm((np.array(dp['kp'][M[j] if flip else j][:2])-p['kp'][j][:2])*[A,1])/scales[k] for j in B if p['kp'][j][3]!=3 and dp['kp'][M[j] if flip else j] is not None]; es.append(np.mean(v) if len(v)>=3 else 1e9)
    cost[i,k]=min(es)
  matched=set()
  for i,k in zip(*linear_sum_assignment(cost)):
   if cost[i,k]>1: continue
   matched.add(k); p=g['people'][k]
   if p['role']!='player':continue
   errors.extend(np.linalg.norm((np.array(f['people'][i]['kp'][j][:2])-p['kp'][j][:2])*[A,1])/scales[k] for j in B if p['kp'][j][3]!=3 and f['people'][i]['kp'][j] is not None)
  for k,p in enumerate(g['people']):
   present=p['in_frame'] and sum(p['kp'][j][3]!=3 for j in T)>=3 and (p['visible_frac'] if p['visible_frac'] is not None else 1)>=.25
   if p['role']=='player' and present:total+=1;found+=k in matched
 saved=json.loads((run/'metrics.json').read_text()); out[sid]={'independent':{'recall':found/total,'error_mean':float(np.mean(errors)),'pck20':float(np.mean(np.array(errors)<.2)),'n':len(errors)},'saved':{'recall':saved['detection']['recall']['players'],'body':saved['detection']['keypoints']['body']}}
 if sid=='cam-fov-120':
  ratio=saved['frame']['focal_from_gt']/focal; out[sid]['gt_focal_vs_pinhole_ratio']=ratio;out[sid]['pck20_using_gt_focal']=float(np.mean(np.array(errors)/ratio<.2))
(D/'audit'/'metrics-checks.json').write_text(json.dumps(out,indent=2));print(json.dumps(out,indent=2))
