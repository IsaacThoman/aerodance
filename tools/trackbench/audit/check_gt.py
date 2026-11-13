import os
# Independent GT checks: re-projects kp3d with meta's camera (and the documented lens/rolling
# shutter), compares bboxes with masks, counts vis codes against mask labels and draws overlays.
# python3 check_gt.py [scene ...]   (default: the audit's original scene list -> audit/gt-checks.json;
# named scenes -> audit/gt-checks-<first>[-etc].json; overlays audit/<scene>-gt.png)
# Table-tennis scenes (hand-21 and paddle GT) also get: hand points re-projected, hand vis codes
# against mask labels (vis 0 should land on the person, the paddle is mask 0), paddle centre
# within reach of its hand's middle knuckle, unit normals, and the hand points drawn.
import json, math, sys
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw
D=Path(os.environ.get('TRACKBENCH_DATA','/Volumes/development/aerodance-trackbench')); O=D/'audit'
def proj(P,inv,K,W,H,s,f):
 c=np.asarray(P)@inv[:3,:3].T+inv[:3,3]; xy=np.stack([K[0,0]*c[:,0]/-c[:,2]+K[0,2],K[1,2]-K[1,1]*c[:,1]/-c[:,2]],1)/[W,H]
 k=max(0,(s['camera']['hfov_deg']-90)/30)*.12; q=(xy-.5)*[2,2*H/W]; xy=q*((1+k)/(1+k*(q*q).sum(1)))[:,None]/[2,2*H/W]+.5
 for op in s.get('post',[]):
  if op['type']=='rolling_shutter': xy[:,0]+=op.get('strength_px',4)/W*(xy[:,1]-.5)*math.sin(2*math.pi*op.get('frequency_hz',2)*(f-1)/s['fps'])
 return xy
HAND_EDGES=[(0,1),(1,2),(2,3),(3,4),(0,5),(5,6),(6,7),(7,8),(5,9),(9,10),(10,11),(11,12),(9,13),(13,14),(14,15),(15,16),(13,17),(0,17),(17,18),(18,19),(19,20)]
scenes=sys.argv[1:] or ['cam-portrait','cam-fov-120','sens-rolling-shutter','sens-fps-15','mp2-cross-distinct','mot-spins','mot-floor']
results={}
for sid in scenes:
 d=D/'scenes'/sid
 if not (d/'meta.json').exists(): continue
 m=json.loads((d/'meta.json').read_text()); s=json.loads((d/'spec.json').read_text()); rows=[json.loads(l) for l in (d/'gt.jsonl').read_text().splitlines()]; W,H=m['resolution']; K=np.array(m['camera']['K']); err=[]; herr=[]; nhand=0; pad_d=[]; pad_n=[]; hcounts=np.zeros((4,3),int); tm=[]; counts=np.zeros((4,3),int); bboxerr=[]; overlays=[]
 files={int(p.stem) for p in (d/'frames').glob('*.jpg')}
 for g in rows:
  f=g['frame']; tm.append(abs(g['t_ms']-(f-1)*1000/m['fps'])); M=np.array(m['camera_to_world'][str(f)]).reshape(4,4); inv=np.linalg.inv(M)
  for p in g['people']:
   P=np.array(p['kp3d']); c=P@inv[:3,:3].T+inv[:3,3]; xy=np.stack([K[0,0]*c[:,0]/-c[:,2]+K[0,2],K[1,2]-K[1,1]*c[:,1]/-c[:,2]],1)/[W,H]
   # Independently implement the documented forward geometry, not distort_points.
   k=max(0,(s['camera']['hfov_deg']-90)/30)*.12; q=(xy-.5)*[2,2*H/W]; xy=q*((1+k)/(1+k*(q*q).sum(1)))[:,None]/[2,2*H/W]+.5
   for op in s.get('post',[]):
    if op['type']=='rolling_shutter': xy[:,0]+=op.get('strength_px',4)/W*(xy[:,1]-.5)*math.sin(2*math.pi*op.get('frequency_hz',2)*(f-1)/s['fps'])
   kp=np.array(p['kp']); err.extend(np.linalg.norm((xy-kp[:,:2])*[W,H],axis=1))
   for side,hd in (p.get('hands') or {}).items():
    hxy=proj(hd['kp3d'],inv,K,W,H,s,f); herr.extend(np.linalg.norm((hxy-np.array(hd['kp'])[:,:2])*[W,H],axis=1)); nhand+=1
   if p.get('paddle'):
    pd=p['paddle']; hand=np.array(p['hands'][pd['hand']]['kp3d']); pad_d.append(float(np.linalg.norm(np.array(pd['center'])-hand[9]))); pad_n.append(abs(np.linalg.norm(pd['normal'])-1))
  if f not in files or f not in ([61,181,301,451] if sid.startswith('pp') else [185,305,455,605] if sid=='sens-rolling-shutter' else [404,405,406,407] if sid=='mp2-cross-distinct' else [181,301,451,601]): continue
  im=Image.open(d/'frames'/f'{f:06}.jpg').convert('RGB'); dr=ImageDraw.Draw(im); mask=np.array(Image.open(d/'masks'/f'{f:06}.png')) if (d/'masks'/f'{f:06}.png').exists() else None
  for p in g['people']:
   kp=p['kp']; lab=p['index']+1
   if mask is not None:
    yy,xx=np.where(mask==lab)
    if len(xx) and p['bbox']: bboxerr.extend(np.abs((np.array([xx.min()/W,yy.min()/H,(xx.max()+1)/W,(yy.max()+1)/H])-p['bbox'])*[W,H,W,H]))
   for a,b in [(11,13),(13,15),(12,14),(14,16),(11,12),(11,23),(12,24),(23,24),(23,25),(25,27),(24,26),(26,28)]:
    if kp[a][3]!=3 and kp[b][3]!=3: dr.line((kp[a][0]*W,kp[a][1]*H,kp[b][0]*W,kp[b][1]*H),fill='yellow',width=1)
   for j,(x,y,z,v) in enumerate(kp):
    if not 0<=x<1 or not 0<=y<1: continue
    X,Y=x*W,y*H
    if mask is not None:
     label=mask[int(Y),int(X)]; counts[int(v),0 if label==lab else 1 if label else 2]+=1
    color=['lime','orange','red','magenta'][int(v)]; dr.ellipse((X-2,Y-2,X+2,Y+2),fill=color); dr.text((X+3,Y-4),str(j),fill=color)
   for side,hd in (p.get('hands') or {}).items():
    hk=hd['kp']
    for a,b in HAND_EDGES:
     if hk[a][3]!=3 and hk[b][3]!=3: dr.line((hk[a][0]*W,hk[a][1]*H,hk[b][0]*W,hk[b][1]*H),fill='cyan',width=1)
    for (x,y,z,v) in hk:
     if not 0<=x<1 or not 0<=y<1: continue
     X,Y=x*W,y*H
     if mask is not None:
      label=mask[int(Y),int(X)]; hcounts[int(v),0 if label==lab else 1 if label else 2]+=1
     dr.ellipse((X-1,Y-1,X+1,Y+1),fill=['lime','orange','red','magenta'][int(v)])
  dr.rectangle((0,0,W,19),fill='black'); dr.text((4,3),f'{sid} frame {f} t={g["t_ms"]}ms',fill='white'); overlays.append(im)
 if overlays:
  sheet=Image.new('RGB',(W*2,H*2));
  for i,im in enumerate(overlays): sheet.paste(im,((i%2)*W,(i//2)*H))
  sheet.save(O/f'{sid}-gt.png')
 results[sid]={'frames_gt':len(rows),'frames_jpg':len(files),'meta_fps':m['fps'],'projection_max_px':max(err),'projection_mean_px':float(np.mean(err)),'time_max_ms':max(tm),'bbox_max_px':max(bboxerr,default=0),'vis_rows_own_other_bg':counts.tolist(),'jpg_without_gt':len(files-{g['frame'] for g in rows}),'first_jpg_frames':sorted(files)[:5]}
 if nhand: results[sid].update({'hand_projection_max_px':max(herr),'hand_projection_mean_px':float(np.mean(herr)),'hand_vis_rows_own_other_bg':hcounts.tolist(),
                                'paddle_to_middle_knuckle_m':[round(min(pad_d),3),round(max(pad_d),3)] if pad_d else None,'paddle_normal_unit_err_max':max(pad_n) if pad_n else None})
# The audit's own run (no arguments) keeps its file; a run on named scenes writes beside it.
(O/('gt-checks.json' if not sys.argv[1:] else f'gt-checks-{sys.argv[1]}{"-etc" if len(sys.argv)>2 else ""}.json')).write_text(json.dumps(results,indent=2)); print(json.dumps(results,indent=2))
