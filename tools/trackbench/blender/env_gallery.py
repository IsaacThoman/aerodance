"""Blender verification harness, uses prototype mocap human without editing core modules."""
import json
import math
import random
import sys
import time
from pathlib import Path
import bpy

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
from environment import build_environment, render_settings, ROOMS, LIGHTS, FEATURES
from camera import setup_camera
from assets_fetch import ROOT


def human():
    motion=next((ROOT/'downloads/aist/motions').glob('gJB*.pkl'))
    code=(HERE/'proto_retarget.py').read_text().split('sc=bpy.context.scene;')[0]
    code=code.replace("argv = sys.argv[sys.argv.index('--')+1:]",f'argv = {[str(motion),str(ROOT / "gallery"),"90"]!r}')
    exec(compile(code,str(HERE/'proto_retarget.py'),'exec'),{})
    for o in bpy.data.objects:o['tb_kind']='person'


def base():
    return dict(seed=12,duration_s=1.5,fps=30,resolution=[640,480],camera={},room=dict(preset='living_room',clutter=.5,features=[]),lighting=dict(preset='bright_even'),post=[])


def cleanup():
    for o in list(bpy.data.objects):
        if o.get('tb_kind')!='person':bpy.data.objects.remove(o,do_unlink=True)


def main():
    human();sc=bpy.context.scene
    out=ROOT/'gallery/environment';out.mkdir(parents=True,exist_ok=True)
    prop=ROOT/'downloads/trackbench-props/people.png';prop.parent.mkdir(parents=True,exist_ok=True)
    spec=base();spec['room']['preset']='plain_wall';spec['camera']={'distance_m':2.6,'hfov_deg':55}
    rig=next(o for o in bpy.data.objects if o.type=='ARMATURE'); original=rig.rotation_euler.copy();rig.rotation_euler.z+=math.pi
    setup_camera(spec,sc);build_environment(spec,random.Random(12));render_settings(spec,sc)
    sc.frame_set(20);sc.render.filepath=str(prop);bpy.ops.render.render(write_still=True)
    spec['camera'].update(orientation='portrait',hfov_deg=40)
    setup_camera(spec,sc);sc.frame_set(20);sc.render.filepath=str(prop.with_name('poster.png'));bpy.ops.render.render(write_still=True)
    rig.rotation_euler=original
    if '--props' in sys.argv:return
    cases=[]
    for room in ROOMS:
        for lighting in ('bright_even','daylight_side','dim_evening'):
            s=base();s['room']['preset']=room;s['lighting']['preset']=lighting;cases.append((room+'--'+lighting,s))
    for lighting in LIGHTS:
        if lighting not in ('bright_even','daylight_side','dim_evening'):
            s=base();s['lighting']['preset']=lighting;cases.append(('light--'+lighting,s))
    for feature in FEATURES:
        s=base();s['room']['preset']='plain_wall';s['room']['features']=[feature];cases.append(('feature--'+feature,s))
    for name,options in [('low',{'height_m':.35}),('near',{'distance_m':2.2}),('distant',{'distance_m':4}),('narrow',{'hfov_deg':40}),('look_at',{'look_at':[0,0,1.6]}),('portrait',{'orientation':'portrait'}),('ultrawide',{'hfov_deg':120}),('roll',{'roll_deg':12}),('high',{'height_m':1.9,'yaw_deg':25}),('shake',{'shake':{'amp_deg':2,'freq_hz':2}}),('bump',{'events':[{'type':'bump','t_s':.3,'yaw_deg':8,'pitch_deg':-3}]})]:
        s=base();s['camera']=options;cases.append(('camera--'+name,s))
    only=sys.argv[sys.argv.index('--only')+1:] if '--only' in sys.argv else []
    report=json.loads((out/'render-report.json').read_text()) if only else []
    for name,spec in cases:
        if only and name not in only:continue
        report=[r for r in report if r['name']!=name]
        cleanup();setup_camera(spec,sc);info=build_environment(spec,random.Random(spec['seed']));render_settings(spec,sc)
        folder=out/name;folder.mkdir(exist_ok=True);(folder/'render').mkdir(exist_ok=True)
        (folder/'spec.json').write_text(json.dumps(spec,indent=2))
        times=[]
        for f in (20,21):
            sc.frame_set(f);sc.render.filepath=str(folder/'render'/f'{f:06d}.png')
            start=time.perf_counter();bpy.ops.render.render(write_still=True);times.append(time.perf_counter()-start)
        report.append(dict(name=name,seconds=times,info=info,path=str(folder/'render/000020.png')))
        (out/'render-report.json').write_text(json.dumps(report,indent=2))
        print('GALLERY',name,times,flush=True)
    print('GALLERY_DONE',flush=True)

if __name__=='__main__':main()
