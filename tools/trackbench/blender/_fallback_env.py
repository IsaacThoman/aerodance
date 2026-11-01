"""Minimal stand-ins for environment.py / camera.py (used only if those can't be imported)."""
import math
import bpy
from mathutils import Vector


def build_environment(spec, rng):
    sc = bpy.context.scene
    mat = bpy.data.materials.new('tb_grey')
    mat.use_nodes = True
    mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.45, 0.45, 0.47, 1)
    for name, loc, size in (('floor', (0, 0, -0.05), (8, 12, 0.1)), ('back', (0, 3, 1.3), (8, 0.1, 2.6))):
        me = bpy.data.meshes.new(name)
        ob = bpy.data.objects.new(name, me)
        sc.collection.objects.link(ob)
        import bmesh
        b = bmesh.new()
        bmesh.ops.create_cube(b, size=1.0)
        bmesh.ops.scale(b, vec=size, verts=b.verts)
        b.to_mesh(me)
        b.free()
        ob.location = loc
        ob.data.materials.append(mat)
        ob['tb_kind'] = 'environment'
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3
    sun.rotation_euler = (0.8, 0.2, 0.3)
    sun['tb_kind'] = 'environment'
    sc.collection.objects.link(sun)
    w = bpy.data.worlds.new('w')
    sc.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[0].default_value = (0.6, 0.6, 0.65, 1)
    return {'preset': 'fallback_grey_room'}


def render_settings(spec, scene):
    scene.render.engine = 'BLENDER_EEVEE'
    scene.eevee.taa_render_samples = 16
    scene.view_settings.view_transform = 'AgX'


def setup_camera(spec, scene):
    c = spec['camera']
    w, h = spec['resolution']
    if c.get('orientation') == 'portrait':
        w, h = h, w
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.resolution_percentage = 100
    scene.render.fps = int(round(spec['fps']))
    cam = bpy.data.objects.new('TB_camera', bpy.data.cameras.new('TB_camera'))
    scene.collection.objects.link(cam)
    cam['tb_kind'] = 'environment'
    cam.data.sensor_fit = 'HORIZONTAL'
    cam.data.angle = math.radians(c['hfov_deg'])
    target = Vector(c['look_at'])
    yaw = math.radians(c['yaw_deg'])
    cam.location = (target.x + c['distance_m'] * math.sin(yaw), target.y - c['distance_m'] * math.cos(yaw), c['height_m'])
    cam.rotation_mode = 'QUATERNION'
    cam.rotation_quaternion = (target - cam.location).to_track_quat('-Z', 'Y')
    scene.camera = cam
    return cam
