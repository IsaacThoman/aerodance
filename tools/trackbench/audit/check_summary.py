import json,hashlib
from pathlib import Path
D=Path('/Volumes/development/aerodance-trackbench');o={}
for e in ['mp-lite-game','mp-heavy-game','mp-lite-game-rt','rtmo-s']:
 ms=[json.loads(p.read_text()) for p in (D/'runs'/e).glob('*/metrics.json')];o[e]={'scenes':len(ms),'calibration_never':sum(m.get('calibration') is not None and m['calibration']['complete_ms'] is None for m in ms),'identity_null':sum(m['tracking']['after_numbering']['identity_accuracy'] is None for m in ms)}
 for m in ms:
  if m['cost']['dropped_results']:o[e].setdefault('dropped',[]).append({'scene':m['scene'],'cost':m['cost'],'lost':m['tracking']['whole_scene']['lost']})
fps=D/'scenes'/'sens-fps-15';base=D/'scenes'/'base-solo';files=list((fps/'frames').glob('*.jpg'));o['fps_jpg_equal_base']=sum(p.read_bytes()==(base/'frames'/p.name).read_bytes() for p in files);o['fps_jpg_count']=len(files)
(D/'audit'/'summary-checks.json').write_text(json.dumps(o,indent=2));print(json.dumps(o,indent=2))
