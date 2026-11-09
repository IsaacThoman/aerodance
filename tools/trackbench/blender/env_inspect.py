"""Venv-side gallery processing, MediaPipe checks and contact sheets (no Blender)."""
import json
import os
from pathlib import Path
import sys
import time
import numpy as np
from PIL import Image, ImageDraw
import mediapipe as mp

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
from post.degrade import process
ROOT=Path(os.environ.get('TRACKBENCH_DATA','/Volumes/development/aerodance-trackbench'))
OUT=ROOT/'gallery/environment'

def main():
    report=json.loads((OUT/'render-report.json').read_text())
    options=mp.tasks.vision.PoseLandmarkerOptions(base_options=mp.tasks.BaseOptions(model_asset_path=str(ROOT/'models/pose_landmarker_lite.task')),num_poses=4,min_pose_detection_confidence=.5,min_pose_presence_confidence=.5)
    with mp.tasks.vision.PoseLandmarker.create_from_options(options) as model:
        for row in report:
            folder=Path(row['path']).parent.parent;process(folder)
            path=folder/'frames/000020.jpg';im=mp.Image.create_from_file(str(path));t=time.perf_counter();result=model.detect(im)
            row['detections']=len(result.pose_landmarks);row['inference_ms']=(time.perf_counter()-t)*1000
            row['frame_path']=str(path)
        post_report=[]
        for path in sorted(OUT.glob('post--*/frames/000020.jpg')):
            result=model.detect(mp.Image.create_from_file(str(path)))
            post_report.append(dict(name=path.parent.parent.name,detections=len(result.pose_landmarks),path=str(path)))
        (OUT/'post-detection-report.json').write_text(json.dumps(post_report,indent=2))
    (OUT/'detection-report.json').write_text(json.dumps(report,indent=2))
    for start in range(0,len(report),12):
        group=report[start:start+12];sheet=Image.new('RGB',(4*320,3*268),(30,30,30));draw=ImageDraw.Draw(sheet)
        for i,row in enumerate(group):
            x=(i%4)*320;y=(i//4)*268
            with Image.open(row['frame_path']) as source:
                im=source.copy();im.thumbnail((320,240));sheet.paste(im,(x+(320-im.width)//2,y))
            draw.text((x+5,y+240),row['name'],fill='white')
            draw.text((x+5,y+253),f"poses {row['detections']} | {row['seconds'][1]:.3f}s",fill='white')
        sheet.save(OUT/f'contact-{start//12+1}.jpg',quality=93)
    print(json.dumps([{k:r[k] for k in ('name','seconds','detections')} for r in report],indent=2))

if __name__=='__main__':main()
