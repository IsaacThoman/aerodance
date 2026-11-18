#!/usr/bin/env python3
"""Quick mapping check, NOT the full tracking/scoring benchmark."""
import argparse,json
import numpy as np
from scipy.optimize import linear_sum_assignment
from models import DATA

ap=argparse.ArgumentParser(__doc__);ap.add_argument('scene');ap.add_argument('estimators',nargs='*');ap.add_argument('--confidence',type=float,default=.5);args=ap.parse_args()
scene=DATA/'scenes'/args.scene
if not (scene/'READY').exists(): raise SystemExit(f'{scene}/READY absent; refusing to score partial render')
spec=json.loads((scene/'spec.json').read_text());size=np.array(spec.get('resolution',[640,480]))
gt={r['frame']:r for r in map(json.loads,(scene/'gt.jsonl').read_text().splitlines())}
ids=args.estimators or [p.name for p in (DATA/'runs').iterdir() if (p/args.scene/'detections.jsonl').exists()]
summary={}
for id in ids:
    errors=[[] for _ in range(33)];swapped=[[] for _ in range(33)];matched=detected=truth=0;frames=0
    pairs={11:12,12:11,13:14,14:13,15:16,16:15,23:24,24:23,25:26,26:25,27:28,28:27,29:30,30:29,31:32,32:31}
    rows=map(json.loads,(DATA/'runs'/id/args.scene/'detections.jsonl').read_text().splitlines())
    for row in rows:
        if row['frame'] not in gt:continue
        frames+=1
        people=[p for p in gt[row['frame']]['people'] if p.get('in_frame',True)]
        found=row['people'];truth+=len(people);detected+=len(found)
        cost=np.full((len(found),len(people)),1e6)
        for i,d in enumerate(found):
            for j,g in enumerate(people):
                ds=[np.linalg.norm((np.array(d['kp'][k][:2])-g['kp'][k][:2])*size) for k in [11,12,23,24] if d['kp'][k] is not None and d['kp'][k][3]>=args.confidence and g['kp'][k] is not None and g['kp'][k][3]<3]
                if len(ds)>=2:cost[i,j]=np.mean(ds)
        ii,jj=linear_sum_assignment(cost)
        for i,j in zip(ii,jj):
            if cost[i,j]> .2*np.linalg.norm(size):continue
            matched+=1;d,g=found[i],people[j]
            for k in range(33):
                p,q=d['kp'][k],g['kp'][k]
                if p is None or q is None or p[3]<args.confidence or q[3]>=3:continue
                errors[k].append(float(np.linalg.norm((np.array(p[:2])-q[:2])*size)))
                if k in pairs:
                    q2=g['kp'][pairs[k]]
                    if q2 is not None and q2[3]<3:swapped[k].append(float(np.linalg.norm((np.array(p[:2])-q2[:2])*size)))
    result={'frames':frames,'gt_people':truth,'detected_people':detected,'matched_people':matched,'confidence':args.confidence,'per_joint':[{'index':k,'n':len(e),'mean_px':float(np.mean(e)) if e else None,'p95_px':float(np.percentile(e,95)) if e else None,'swapped_mean_px':float(np.mean(swapped[k])) if swapped[k] else None} for k,e in enumerate(errors)],'note':'Hungarian torso-distance match; gate 20% diagonal; visible+self/other occluded GT; no mean offset correction; missing joints never counted as zero error'}
    (DATA/'runs'/id/args.scene/'sanity.json').write_text(json.dumps(result,indent=2)+'\n');summary[id]=result
print(json.dumps(summary,indent=2))
