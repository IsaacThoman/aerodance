#!/usr/bin/env python3
"""Run every candidate on complete sample scenes, then check mappings against GT."""
import argparse,subprocess,sys
from models import DATA
from run import IDS
from pathlib import Path
ap=argparse.ArgumentParser(__doc__);ap.add_argument('--limit',type=int,default=30);ap.add_argument('--models',nargs='+',default=IDS);args=ap.parse_args()
root=Path(__file__).parent
scenes=[p.parent for p in sorted((DATA/'scenes').glob('_sample-*/READY'))]
if not scenes:raise SystemExit('No READY sample scenes yet. Re-run after rendering completes.')
failed=[]
for scene in scenes:
    passed=[]
    for model in args.models:
        cmd=[sys.executable,str(root/'run.py'),model,scene.name,'--limit',str(args.limit)]
        if subprocess.run(cmd).returncode:failed.append([scene.name,model])
        else:passed.append(model)
    if passed:subprocess.run([sys.executable,str(root/'sanity.py'),scene.name,*passed],check=True)
if failed:raise SystemExit(f'Failed runners: {failed}')
