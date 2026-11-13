"""The hero's TV, rendered for the landing page: blender -b -P apps/site/art/tv.py -- <out.png> [width]

A glossy aero TV in the game's look: a deep navy piano-gloss bezel wrapped in an aqua crystal rim,
a pearl webcam on top, standing on the menu's glass puck (apps/web/src/menu/MenuDancers.tsx). The
screen is a holdout, so it comes out fully transparent and the page plays the video behind it. The
film is transparent, glass included, so the rim and the puck show the sky through them.

The camera looks straight at the screen and is shifted (not tilted) down to see the puck from a
little above, which keeps the screen an exact rectangle. The script prints where the screen lands
in the picture, as fractions of its size, for hero.css.
"""
import bpy, bmesh, math, sys
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else '/tmp/tv.png'
WIDTH = int(argv[1]) if len(argv) > 1 else 2400

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# The screen is 16 x 9 units, its centre at the origin, facing -y (towards the camera).
SW, SH = 16.0, 9.0
SIDE, TOP, CHIN = 0.42, 0.42, 0.62  # bezel
DEPTH = 0.7
RADIUS = 0.55
RIM = 0.22  # how far the crystal rim stands out round the bezel


def mat(name, color, rough=0.1, metal=0.0, coat=1.0, alpha=1.0, transmission=0.0, ior=1.45, emission=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    p.inputs['Coat Weight'].default_value = coat
    p.inputs['Coat Roughness'].default_value = 0.03
    p.inputs['Alpha'].default_value = alpha
    p.inputs['Transmission Weight'].default_value = transmission
    p.inputs['IOR'].default_value = ior
    if emission:
        p.inputs['Emission Color'].default_value = (*emission, 1)
        p.inputs['Emission Strength'].default_value = strength
    return m


def link(obj, material):
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    for f in obj.data.polygons:
        f.use_smooth = True
    return obj


def rounded_slab(name, w, h, depth, r, bevel, material, y=0.0, z=0.0, segments=16):
    """A box w x h (x by z), depth deep along y, its front-view corners rounded by r and every
    edge softened by bevel."""
    bm = bmesh.new()
    pts = []
    for cx, cz, a0 in [(w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)]:
        for i in range(segments + 1):
            a = math.radians(a0 + 90 * i / segments)
            pts.append((cx + r * math.cos(a), cz + r * math.sin(a)))
    verts = [bm.verts.new((x, -depth / 2, zz)) for x, zz in pts]
    face = bm.faces.new(verts)
    ext = bmesh.ops.extrude_face_region(bm, geom=[face])
    bmesh.ops.translate(bm, vec=(0, depth, 0), verts=[v for v in ext['geom'] if isinstance(v, bmesh.types.BMVert)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    obj.location = (0, y, z)
    link(obj, material)
    b = obj.modifiers.new('soft', 'BEVEL')
    b.width = bevel
    b.segments = 8
    b.limit_method = 'ANGLE'
    b.angle_limit = math.radians(40)
    b.harden_normals = False
    return obj


navy = mat('PianoNavy', (0.006, 0.04, 0.11), rough=0.05, metal=0.2)
crystal = mat('Crystal', (0.45, 0.92, 1.0), rough=0.02, transmission=1.0, ior=1.5, coat=1.0)
pearl = mat('Pearl', (0.86, 0.96, 1.0), rough=0.12, metal=0.25)
lens = mat('Lens', (0.0, 0.01, 0.03), rough=0.02)
iris = mat('Iris', (0.1, 0.55, 0.95), rough=0.05, emission=(0.35, 0.8, 1.0), strength=2.5)
mint = mat('Mint', (0.44, 0.95, 0.84), rough=0.1, emission=(0.44, 0.95, 0.84), strength=6.0)
puck_glass = mat('Puck', (0.77, 0.96, 1.0), rough=0.04, metal=0.0, transmission=0.9, ior=1.4)
ring_mat = mat('Ring', (0.48, 1.0, 0.86), rough=0.2, emission=(0.48, 1.0, 0.86), strength=3.0)
holdout = bpy.data.materials.new('Screen')
holdout.use_nodes = True
nt = holdout.node_tree
nt.nodes.clear()
out = nt.nodes.new('ShaderNodeOutputMaterial')
nt.links.new(nt.nodes.new('ShaderNodeHoldout').outputs[0], out.inputs['Surface'])

BW, BH = SW + 2 * SIDE, SH + TOP + CHIN
bz = (CHIN - TOP) / -2  # the bezel's centre, below the screen's for the deeper chin

# Bezel, and the crystal rim round it, set a little back so its edge shows all round.
rounded_slab('Bezel', BW, BH, DEPTH, RADIUS, 0.3, navy, z=bz)
rounded_slab('Rim', BW + 2 * RIM, BH + 2 * RIM, DEPTH * 0.6, RADIUS + RIM, 0.2, crystal, y=0.1, z=bz)

# The screen, a hair proud of the bezel's face, with the video's own small corner radius.
scr = rounded_slab('Screen', SW, SH, 0.01, 0.12, 0.0, holdout, y=-DEPTH / 2 - 0.006, segments=6)
scr.modifiers.clear()

# A mint power light in the chin.
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.07, location=(0, -DEPTH / 2 - 0.02, -SH / 2 - CHIN * 0.5), segments=24, ring_count=12)
led = bpy.context.object
led.scale = (1.6, 0.4, 1)
led.data.materials.append(mint)

# Webcam: a pearl pill on the top edge, with a dark glass lens and an aqua iris.
top = SH / 2 + TOP
bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(0, -0.05, top + 0.18), segments=48, ring_count=24)
cam = bpy.context.object
cam.scale = (0.95, 0.42, 0.34)
cam.data.materials.append(pearl)
bpy.ops.object.shade_smooth()
bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(0, -0.43, top + 0.2), segments=32, ring_count=16)
glass = bpy.context.object
glass.scale = (0.2, 0.08, 0.2)
glass.data.materials.append(lens)
bpy.ops.object.shade_smooth()
bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(0, -0.49, top + 0.2), segments=24, ring_count=12)
pupil = bpy.context.object
pupil.scale = (0.075, 0.03, 0.075)
pupil.data.materials.append(iris)
bpy.ops.object.shade_smooth()
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.04, location=(0.55, -0.38, top + 0.2), segments=16, ring_count=8)
bpy.context.object.data.materials.append(mint)

# Stand: a crystal neck down to the glass puck, with the menu puck's mint ring.
bottom = -SH / 2 - CHIN
NECK_H = 1.15
bpy.ops.mesh.primitive_cylinder_add(radius=0.62, depth=NECK_H, location=(0, 0.1, bottom - NECK_H / 2 + 0.05), vertices=64)
neck = bpy.context.object
neck.scale = (1.5, 0.45, 1)
neck.data.materials.append(crystal)
bpy.ops.object.shade_smooth()
nb = neck.modifiers.new('soft', 'BEVEL')
nb.width = 0.08
nb.segments = 6

PUCK_R, PUCK_H = 2.9, 0.34
pz = bottom - NECK_H + PUCK_H / 2
bpy.ops.mesh.primitive_cylinder_add(radius=PUCK_R, depth=PUCK_H, location=(0, 0.1, pz), vertices=128)
puck = bpy.context.object

puck.scale = (1, 0.55, 1)
puck.data.materials.append(puck_glass)
bpy.ops.object.shade_smooth()
pb = puck.modifiers.new('soft', 'BEVEL')
pb.width = 0.1
pb.segments = 8
bpy.ops.mesh.primitive_torus_add(major_radius=PUCK_R - 0.06, minor_radius=0.05, location=(0, 0.1, pz + PUCK_H / 2), major_segments=160, minor_segments=12)
ring = bpy.context.object

ring.scale = (1, 0.55, 1)
ring.data.materials.append(ring_mat)
bpy.ops.object.shade_smooth()

# World: the hero's sky for the reflections, deep blue above and cloud white below.
world = bpy.data.worlds.new('Sky')
scene.world = world
world.use_nodes = True
wn = world.node_tree
bg = wn.nodes['Background']
grad = wn.nodes.new('ShaderNodeTexGradient')
mapping = wn.nodes.new('ShaderNodeMapping')
coord = wn.nodes.new('ShaderNodeTexCoord')
ramp = wn.nodes.new('ShaderNodeValToRGB')
mapping.inputs['Rotation'].default_value = (0, math.radians(90), 0)
mapping.inputs['Location'].default_value = (0, 0, 0)
wn.links.new(coord.outputs['Generated'], mapping.inputs['Vector'])
wn.links.new(mapping.outputs['Vector'], grad.inputs['Vector'])
wn.links.new(grad.outputs['Fac'], ramp.inputs['Fac'])
wn.links.new(ramp.outputs['Color'], bg.inputs['Color'])
ramp.color_ramp.elements[0].color = (0.02, 0.12, 0.65, 1)
ramp.color_ramp.elements[1].color = (0.92, 0.97, 1.0, 1)
ramp.color_ramp.elements.new(0.5).color = (0.35, 0.6, 0.95, 1)
bg.inputs['Strength'].default_value = 1.0


def light(name, kind, loc, rot, energy, size=1.0, color=(1, 1, 1), shape='RECTANGLE', size_y=None, camera=False):
    d = bpy.data.lights.new(name, kind)
    d.energy = energy
    d.color = color
    if kind == 'AREA':
        d.shape = shape
        d.size = size
        if size_y:
            d.size_y = size_y
    o = bpy.data.objects.new(name, d)
    o.location = loc
    o.rotation_euler = [math.radians(a) for a in rot]
    o.visible_camera = camera
    bpy.context.collection.objects.link(o)
    return o


# A broad softbox high in front, for the long gloss along the top of the bezel and the rim, the
# sun from the top right, and a cool fill from below like the clouds' bounce.
light('Softbox', 'AREA', (-2, -14, 14), (-50, 0, 0), 9000, size=30, size_y=4)
light('Sun', 'AREA', (18, -10, 12), (-50, 0, 50), 5000, size=6, color=(1, 0.96, 0.88))
light('Bounce', 'AREA', (0, -10, -12), (-130, 0, 0), 2500, size=24, size_y=6, color=(0.75, 0.9, 1.0))
light('RimL', 'AREA', (-16, 4, 4), (0, -80, 0), 2000, size=10, color=(0.6, 0.95, 1.0))
light('RimR', 'AREA', (16, 4, 4), (0, 80, 0), 2000, size=10, color=(0.6, 0.95, 1.0))

# The aero gloss: a bright panel behind the camera, unseen by it, that the bezel's flat face
# mirrors as a hard-edged sheen over its upper part.
bpy.ops.mesh.primitive_plane_add(size=1, location=(0, -26, -0.5))
gloss = bpy.context.object
gloss.scale = (40, 8, 1)
gloss.rotation_euler = (math.radians(90), 0, 0)
gloss.data.materials.append(mat('Gloss', (1, 1, 1), emission=(0.85, 0.95, 1.0), strength=0.9))
gloss.visible_camera = False
gloss.visible_diffuse = False
gloss.visible_shadow = False

# Camera straight at the screen from above its centre, its lens shifted down.
cam_d = bpy.data.cameras.new('Cam')
cam_d.lens = 85
cam_d.sensor_fit = 'HORIZONTAL'
cam_o = bpy.data.objects.new('Cam', cam_d)
bpy.context.collection.objects.link(cam_o)
DIST = 52
CAM_Z = 7.0
cam_o.location = (0, -DIST, CAM_Z)
cam_o.rotation_euler = (math.radians(90), 0, 0)
scene.camera = cam_o

# Frame: 0.6 units round the rim and the cam, down to below the puck.
left, right = -BW / 2 - RIM - 0.25, BW / 2 + RIM + 0.25
top_y = top + 0.6
bottom_y = pz - PUCK_H / 2 - 0.35


def to_film(x, z):
    # Where a point in the screen's plane (y=0, roughly) lands on a sensor 1 unit away.
    return x / DIST, (z - CAM_Z) / DIST


fl, ft = to_film(left, top_y)
fr, fb = to_film(right, bottom_y)
fw, fh = fr - fl, ft - fb
sensor = 36.0
cam_d.sensor_width = sensor
cam_d.lens = sensor / fw
res_x = WIDTH
res_y = round(WIDTH * fh / fw)
scene.render.resolution_x = res_x
scene.render.resolution_y = res_y
scene.render.resolution_percentage = 100
cam_d.shift_x = 0
cam_d.shift_y = ((ft + fb) / 2) / fw

scene.render.engine = 'CYCLES'
scene.cycles.samples = int(argv[2]) if len(argv) > 2 else 512
scene.cycles.use_denoising = True
scene.cycles.device = 'GPU'
prefs = bpy.context.preferences.addons['cycles'].preferences
try:
    prefs.compute_device_type = 'METAL'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
except Exception:
    scene.cycles.device = 'CPU'
scene.render.film_transparent = True
scene.cycles.film_transparent_glass = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.image_settings.color_depth = '16'
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Medium High Contrast'
scene.render.filepath = OUT

bpy.context.view_layer.update()
corners = []
for x, z in [(-SW / 2, SH / 2), (SW / 2, -SH / 2)]:
    v = world_to_camera_view(scene, cam_o, Vector((x, -DEPTH / 2 - 0.006, z)))
    corners.append((v.x, 1 - v.y))
(l, t), (r, b) = corners
print(f'SIZE {res_x}x{res_y}')
print(f'SCREEN left {l * 100:.3f}% top {t * 100:.3f}% width {(r - l) * 100:.3f}% height {(b - t) * 100:.3f}%')
bpy.ops.render.render(write_still=True)
