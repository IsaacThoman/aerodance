"""Blender-side camera invariants. Run blender --background --python this_file."""
import math
from pathlib import Path
import sys
import bpy
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view
sys.path.insert(0,str(Path(__file__).resolve().parent))
from camera import setup_camera
from environment import render_settings

bpy.ops.wm.read_factory_settings(use_empty=True)
s=bpy.context.scene
for orientation in ('landscape','portrait'):
    spec={'fps':30,'duration_s':1,'resolution':[640,480],'camera':{'orientation':orientation,'hfov_deg':120,'look_at':[0,0,1]}}
    camera=setup_camera(spec,s);bpy.context.view_layer.update()
    assert (s.render.resolution_x,s.render.resolution_y)==((640,480) if orientation=='landscape' else (480,640))
    for x,expected in ((0,.5),(3.2*math.tan(math.radians(60)),1)):
        point=world_to_camera_view(s,camera,Vector((x,0,1)))
        assert abs(point.x-expected)<1e-6,(orientation,point)
    assert camera['tb_kind']=='environment'
spec={'duration_s':1,'camera':{'events':[{'type':'bump','t_s':.5,'yaw_deg':10}]}}
camera=setup_camera(spec,s)
s.frame_set(15);before=camera.rotation_quaternion.copy();s.frame_set(16);after=camera.rotation_quaternion.copy();s.frame_set(25);later=camera.rotation_quaternion.copy()
assert abs(before.rotation_difference(after).angle-math.radians(10))<1e-5
assert after.rotation_difference(later).angle<1e-5
for options in ({'hfov_deg':float('nan')},{'hfov_deg':180},{'orientation':'sideways'},{'distance_m':0},{'events':[{'type':'teleport'}]},{'foo':1}):
    try:setup_camera({'camera':options},s)
    except ValueError:pass
    else:raise AssertionError(options)
render_settings({'room':{'preset':'dance_studio'}},s)
assert s.eevee.use_raytracing
print('CAMERA_TESTS_OK')
