"""Photographic CC0 assets in metre-scale rooms; no implicit network downloads."""
import math
import random
import bpy
from mathutils import Vector
try:
    from .assets_fetch import CACHE, ROOT
except ImportError:
    from assets_fetch import CACHE, ROOT

ROOMS = ('living_room', 'bedroom', 'plain_wall', 'small_room', 'dance_studio', 'basement', 'open_plan', 'backyard')
LIGHTS = ('bright_even', 'daylight_side', 'backlit_window', 'dim_evening', 'ceiling_only', 'tv_glow', 'party', 'flicker', 'mixed_temp', 'overexposed')
# Per-preset exposure (EV) with the Standard view transform; see render_settings.
AUTO_EXPOSURE_EV = {'bright_even': -1.0, 'daylight_side': -1.0, 'mixed_temp': -1.0, 'flicker': 0.0, 'overexposed': 0.0}
FEATURES = ('mirror_behind', 'tv_with_people', 'poster_people', 'coat_rack', 'mannequin', 'window_behind', 'doorway', 'patterned_wallpaper')


def tag(obj, kind='environment'):
    obj['tb_kind'] = kind
    return obj


def material(name, color, rough=.6, metal=0, emission=0):
    m = bpy.data.materials.new('TB_' + name)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    p.inputs['Emission Color'].default_value = (*color, 1)
    p.inputs['Emission Strength'].default_value = emission
    return m


def require(path):
    if not path.exists():
        raise FileNotFoundError(f'Missing environment asset {path}. Run python3 tools/trackbench/blender/assets_fetch.py')
    return str(path)


def pbr(ident):
    m = material(ident, (.7, .7, .7))
    n, links = m.node_tree.nodes, m.node_tree.links
    coord = n.new('ShaderNodeTexCoord')
    p = n.get('Principled BSDF')
    for channel, socket in [('diff', 'Base Color'), ('rough', 'Roughness'), ('nor_gl', 'Normal')]:
        files = list((CACHE / ident).glob(channel + '.*'))
        if not files:
            require(CACHE / ident / (channel + '.jpg'))
        tex = n.new('ShaderNodeTexImage')
        tex.image = bpy.data.images.load(str(files[0]), check_existing=True)
        tex.projection = 'BOX'; tex.projection_blend = .15
        links.new(coord.outputs['Object'], tex.inputs['Vector'])
        if channel != 'diff':
            tex.image.colorspace_settings.name = 'Non-Color'
        output = tex.outputs['Color']
        if channel == 'nor_gl':
            normal = n.new('ShaderNodeNormalMap'); normal.inputs['Strength'].default_value = .35
            links.new(output, normal.inputs['Color']); output = normal.outputs['Normal']
        if channel == 'diff' and ident == 'white_plaster_02':
            mix = n.new('ShaderNodeMixRGB'); mix.blend_type='MIX'; mix.inputs[0].default_value=.8
            mix.inputs[2].default_value=(.72,.69,.63,1)
            links.new(output,mix.inputs[1]); output=mix.outputs[0]
        links.new(output, p.inputs[socket])
    return m


def box(name, loc, size, mat, kind='environment', bevel=.015):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = tag(bpy.context.object, kind); o.name = 'TB_' + name
    o.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat)
    if bevel:
        mod = o.modifiers.new('soft manufactured edges', 'BEVEL'); mod.width = bevel; mod.segments = 2
        o.modifiers.new('weighted normals', 'WEIGHTED_NORMAL')
    return o


def model(ident, x, y, width, yaw=0):
    path = require(CACHE / ident / 'model.blend')
    before = set(bpy.data.objects)
    with bpy.data.libraries.load(path, link=False) as (src, dst):
        dst.objects = src.objects
    objects = [o for o in dst.objects if o is not None]
    for o in objects:
        bpy.context.scene.collection.objects.link(o); tag(o)
        for mod in o.modifiers:
            if mod.type == 'SUBSURF':
                mod.render_levels = min(mod.render_levels, 1)
    meshes = [o for o in objects if o.type == 'MESH']
    if not meshes:
        raise RuntimeError(f'{ident} has no meshes')
    bpy.context.view_layer.update()
    points = [o.matrix_world @ Vector(v) for o in meshes for v in o.bound_box]
    lo = Vector(tuple(min(v[i] for v in points) for i in range(3)))
    hi = Vector(tuple(max(v[i] for v in points) for i in range(3)))
    center = Vector(((lo.x + hi.x)/2, (lo.y + hi.y)/2, lo.z))
    scale = width / (hi.x - lo.x)
    root = tag(bpy.data.objects.new('TB_' + ident, None))
    bpy.context.scene.collection.objects.link(root)
    for o in objects:
        if o.parent not in objects:
            matrix = o.matrix_world.copy(); o.parent = root; o.matrix_world = matrix
            o.location -= center
    root.scale = (scale,) * 3
    root.rotation_euler.z = math.radians(yaw)
    root.location = (x, y, .015)
    # Packed/relative texture paths are resolved against the source blend automatically.
    return root


def light(name, loc, target, power, color, size=3):
    data = bpy.data.lights.new('TB_' + name, 'AREA'); data.energy = power; data.specular_factor = 0; data.color = color; data.shape = 'DISK'; data.size = size
    o = tag(bpy.data.objects.new(data.name, data)); bpy.context.scene.collection.objects.link(o)
    o.location = loc; o.rotation_euler = (Vector(target) - o.location).to_track_quat('-Z', 'Y').to_euler()
    return o


def kelvin(k):
    if not 1000 <= k <= 15000:
        raise ValueError('lighting.color_temp_k must be in [1000,15000]')
    t = k / 100
    r = 255 if t <= 66 else 329.6987 * (t - 60) ** -.1332
    g = 99.4708 * math.log(t) - 161.1196 if t <= 66 else 288.1222 * (t - 60) ** -.0755
    b = 255 if t >= 66 else (0 if t <= 19 else 138.5177 * math.log(t - 10) - 305.0448)
    return tuple(max(0, min(1, v / 255)) for v in (r, g, b))


def people_surface(name, x, back, z, width, height, emissive):
    path = ROOT / 'downloads/trackbench-props' / ('poster.png' if name == 'poster_people' else 'people.png')
    if not path.exists():
        raise FileNotFoundError(f'{name} needs {path}; generate it with Blender --background --python tools/trackbench/blender/env_gallery.py -- --props')
    black = material('frame', (.025, .025, .028), .25)
    box(name + '_frame', (x, back, z), (width+.08, .075, height+.08), black, 'distractor')
    m = material(name, (1, 1, 1), .5, emission=emissive)
    n = m.node_tree.nodes.new('ShaderNodeTexImage'); n.image = bpy.data.images.load(str(path), check_existing=True)
    p = m.node_tree.nodes.get('Principled BSDF')
    m.node_tree.links.new(n.outputs['Color'], p.inputs['Base Color'])
    m.node_tree.links.new(n.outputs['Color'], p.inputs['Emission Color'])
    bpy.ops.mesh.primitive_plane_add(size=1, location=(x, back-.045, z), rotation=(math.pi/2, 0, 0))
    o = tag(bpy.context.object, 'distractor'); o.name='TB_' + name
    o.scale=(width, height, 1); o.data.materials.append(m)


def mannequin(x, y):
    from bl_ext.blender_org.mpfb.services.humanservice import HumanService
    before = set(bpy.data.objects)
    info = HumanService._create_default_human_info_dict()
    body = HumanService.deserialize_from_dict(info, HumanService.get_default_deserialization_settings())
    ivory = material('mannequin', (.55,.48,.39), .3)
    for o in set(bpy.data.objects) - before:
        tag(o, 'distractor')
        if not o.parent: o.location += Vector((x,y,0))
        if o.type == 'MESH':
            o.data.materials.clear(); o.data.materials.append(ivory)
    return body


def build_environment(spec: dict, rng: random.Random) -> dict:
    room, lighting = spec.get('room', {}), spec.get('lighting', {})
    if set(room) - {'preset','clutter','features'}: raise ValueError(f'Unsupported room options: {set(room)-{"preset","clutter","features"}}')
    if set(lighting) - {'preset','exposure_ev','color_temp_k','flicker_hz'}: raise ValueError('Unsupported lighting options')
    preset, lp = room.get('preset', 'living_room'), lighting.get('preset', 'bright_even')
    if preset not in ROOMS: raise ValueError(f'Unknown room preset: {preset}')
    if lp not in LIGHTS: raise ValueError(f'Unknown lighting preset: {lp}')
    clutter = room.get('clutter', .5)
    if not 0 <= clutter <= 1: raise ValueError('room.clutter must be in [0,1]')
    features = set(room.get('features', []))
    if features - set(FEATURES): raise ValueError(f'Unknown room features: {features-set(FEATURES)}')
    if preset == 'dance_studio': features.add('mirror_behind')
    if lp == 'backlit_window': features.add('window_behind')
    if lp == 'tv_glow': features.add('tv_with_people')
    back = 1.65 if preset == 'small_room' else (6 if preset == 'open_plan' else 2.5)
    half = 2.05 if preset == 'small_room' else 3.3
    wall = pbr('concrete_floor' if preset == 'basement' else ('patterned_plaster_wall' if 'patterned_wallpaper' in features else 'white_plaster_02'))
    floor = pbr('concrete_floor' if preset in ('basement', 'backyard') else 'wood_floor')
    trim = material('trim', (.78,.76,.7)); wood = material('walnut', (.12,.066,.03)); dark=material('black',(.015,.019,.024))
    box('floor', (0,0,-.07), (2*half,16,.14), floor)
    if preset != 'backyard':
        # A real doorway gap, with corridor beyond, rather than a painted door.
        if 'doorway' in features:
            box('rear_left',(-1.3,back,1.3),(4,.12,2.6),wall)
            box('rear_right',(2.75,back,1.3),(1.1,.12,2.6),wall)
            box('lintel',(1.45,back,2.4),(1.5,.12,.4),wall)
            box('hall_rear',(1.5,back+2,1.3),(3,.12,2.6),wall)
        elif 'window_behind' in features:
            box('rear_low',(0,back,.3),(2*half,.12,.6),wall)
            box('rear_high',(0,back,2.55),(2*half,.12,.1),wall)
            for x in (-2.35,2.35): box('rear_side',(x,back,1.55),(1.9,.12,1.9),wall)
        else:
            box('rear',(0,back,1.3),(2*half,.12,2.6),wall)
        for x in (-half,half):
            box('side',(x,(back-4.5)/2,1.3),(.12,back+4.5,2.6),wall)
            box('skirting',(x,(back-4.5)/2,.055),(.15,back+4.5,.11),trim)
        box('ceiling',(0,(back-4.5)/2,2.67),(2*half,back+4.5,.12),trim)
        if 'doorway' not in features: box('skirting_rear',(0,back-.08,.055),(2*half,.04,.11),trim)
    used=[]
    def asset(ident,x,y,width,yaw=0):
        used.append(ident); return model(ident,x,y,width,yaw)
    if preset in ('living_room','small_room','open_plan'):
        asset('sofa_03',-.8,back-.65,2.15)
        asset('modern_coffee_table_01',-half+.65,.65,.85)
        asset('modern_wooden_cabinet',1.25 if preset!='small_room' else 1.35,back-.45,.95)
        if clutter > .15 and preset!='small_room': asset('wooden_bookshelf_worn',half-.4,back-.4,.65)
        if clutter > .3: asset('potted_plant_02',-half+.4,back-.35,.5)
        rug=material('woven rug',(.16,.23,.25),.95)
        n=rug.node_tree.nodes.new('ShaderNodeTexNoise'); n.inputs['Scale'].default_value=180
        bump=rug.node_tree.nodes.new('ShaderNodeBump'); bump.inputs['Strength'].default_value=.3; bump.inputs['Distance'].default_value=.01
        rug.node_tree.links.new(n.outputs['Fac'],bump.inputs['Height']); rug.node_tree.links.new(bump.outputs['Normal'],rug.node_tree.nodes['Principled BSDF'].inputs['Normal'])
        box('rug',(0,.1,.008),(2.6,1.9,.012),rug)
        # Television faces into the play area from the rear wall.
        if 'window_behind' not in features and 'tv_with_people' not in features: box('television',(1.45,back-.14,1.55),(1.1,.08,.65),dark)
        if 'window_behind' not in features: box('art_frame',(-1.2,back-.12,1.9),(.7,.05,.48),wood)
        art=material('abstract art',(.25,.36,.31))
        nodes=art.node_tree.nodes;noise=nodes.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=3
        ramp=nodes.new('ShaderNodeValToRGB');ramp.color_ramp.elements[0].color=(.06,.15,.12,1);ramp.color_ramp.elements[1].color=(.65,.38,.15,1)
        art.node_tree.links.new(noise.outputs['Fac'],ramp.inputs['Fac']);art.node_tree.links.new(ramp.outputs['Color'],nodes['Principled BSDF'].inputs['Base Color'])
        if 'window_behind' not in features: box('art_print',(-1.2,back-.155,1.9),(.64,.012,.42),art)
        # Side-window reveal, glass and mullions, beside the camera-facing play area.
        glass=material('side daylight glass',(.65,.8,1),emission=.8)
        box('side_window_reveal',(-half+.08,-.5,1.65),(.06,1.5,1.3),wood)
        box('side_window_glass',(-half+.12,-.5,1.65),(.015,1.4,1.2),glass)
        for yy in (-1.2,-.5,.2):box('side_window_bar',(-half+.15,yy,1.65),(.04,.035,1.25),trim)
        # Floor lamp with shade, real light supplied by lighting preset.
        box('lamp_stem',(-half+.45,.9,.8),(.025,.025,1.6),dark)
        bpy.ops.mesh.primitive_cone_add(vertices=48, radius1=.24,radius2=.15,depth=.32,location=(-half+.45,.9,1.65))
        tag(bpy.context.object).data.materials.append(material('linen shade',(.7,.58,.38),emission=.15))
    if preset == 'bedroom':
        asset('vintage_day_bed',-2.25,1.1,2.05,90)
        duvet=material('cotton duvet',(.48,.56,.6),.95)
        box('folded_duvet',(-2.25,.8,.53),(.8,1.1,.12),duvet,bevel=.06)
        box('bedside',(-1.5,1.95,.32),(.45,.4,.64),wood)
        box('pillow',(-2.25,1.75,.57),(.65,.4,.16),trim,bevel=.07)
        asset('modern_wooden_cabinet',2.5,2,1.1)
        lamp=asset('desk_lamp_arm_01',-1.5,1.95,.3); lamp.location.z=.65
    if preset == 'open_plan':
        asset('dining_table',1.4,3.6,1.7)
        for x in (-2,-1,0,1,2):
            box('kitchen_cabinet',(x,5.65,.46),(.98,.65,.92),trim)
            box('counter',(x,5.65,.96),(1,.7,.05),dark)
            box('cabinet_handle',(x,5.3,.75),(.3,.025,.02),dark)
    if preset == 'basement':
        asset('wooden_bookshelf_worn',2.5,2,.95)
        for z in (2.25,2.4): box('exposed_pipe',(0,2.3,z),(6,.07,.07),dark)
    if preset == 'backyard':
        asset('potted_plant_02',-2,2,.8); asset('potted_plant_02',2,2,1)
    # Seeded small objects make clutter continuous without filling the play area.
    if preset in ('living_room','small_room','open_plan'):
        for i in range(round(clutter*12)):
            x=-half+.65+rng.uniform(-.12,.12)
            box('clutter_book',(x,.65,.47+i*.025),(.20+rng.random()*.1,.16,.025),material('book',(rng.random()*.4,rng.random()*.4,rng.random()*.4)))
    if 'mirror_behind' in features:
        box('mirror_frame',(0,back-.12,1.25),(3.5,.08,2.35),dark,'distractor')
        mirror=material('mirror',(.97,.97,.97),.015,1)
        box('mirror',(0,back-.17,1.25),(3.4,.012,2.25),mirror,'distractor',0)
        probe=bpy.data.lightprobes.new('TB_mirror_probe','PLANE')
        o=tag(bpy.data.objects.new('TB_mirror_probe',probe),'distractor'); bpy.context.scene.collection.objects.link(o)
        o.location=(0,back-.2,1.25); o.rotation_euler=(math.pi/2,0,0); o.scale=(1.7,1.15,1)
    if 'window_behind' in features:
        sky=material('bright window',(.7,.83,1),emission=4 if lp=='backlit_window' else 1.5)
        box('window',(0,back+.02,1.55),(2.8,.02,1.9),sky)
        for x in (-1.4,0,1.4): box('window_mullion',(x,back-.08,1.55),(.055,.1,1.95),trim)
        for z in (.6,1.55,2.5): box('window_frame',(0,back-.08,z),(2.85,.1,.045),trim)
    if 'tv_with_people' in features: people_surface('tv_people',1.2,back-.25,1.5,1.25,.85,1.5)
    if 'poster_people' in features: people_surface('poster_people',-1.35,back-.2,1.65,.8,1.15,0)
    if 'mannequin' in features: mannequin(1.7,back-.6)
    if 'coat_rack' in features:
        box('coat_rack',(1.7,back-.5,.9),(.04,.04,1.8),wood,'distractor')
        box('coat_feet',(1.7,back-.5,.025),(.55,.45,.05),wood,'distractor')
        for i in range(2):
            x=1.55+i*.3
            coat=material('coat',(.09+i*.04,.075,.06))
            box('hanging_coat',(x,back-.55,1.15),(.36,.15,.85),coat,'distractor',.08)
            for dx in (-.23,.23):
                o=box('sleeve',(x+dx,back-.55,1.25),(.14,.16,.55),coat,'distractor',.06); o.rotation_euler.y=dx*1.2
    hdri='residential_garden' if preset=='backyard' else 'kiara_interior'
    world=bpy.data.worlds.new('TB_world'); bpy.context.scene.world=world; world.use_nodes=True
    nodes=world.node_tree.nodes; env=nodes.new('ShaderNodeTexEnvironment'); env.image=bpy.data.images.load(require(CACHE/hdri/'world.hdr'),check_existing=True)
    world.node_tree.links.new(env.outputs['Color'],nodes['Background'].inputs['Color'])
    nodes['Background'].inputs['Strength'].default_value=.35 if preset=='backyard' else (.035 if lp in ('dim_evening','tv_glow','party') else .18)
    color=kelvin(lighting.get('color_temp_k',4500)); lights=[]
    def add(loc,power,size=3,col=color,target=(0,0,1)):
        if 'color_temp_k' in lighting and lp in ('mixed_temp','party','tv_glow'):
            balance=kelvin(lighting['color_temp_k']);neutral=kelvin(4500)
            col=tuple(min(1,c*b/n) for c,b,n in zip(col,balance,neutral))
        o=light(lp,loc,target,power,col,size); lights.append(o); return o
    if lp in ('bright_even','overexposed','flicker'):
        add((0,-2.5,2.4),550); add((2,.3,2.3),220)
    elif lp=='daylight_side': add((-half+.35,-.3,2),800,3,kelvin(lighting.get('color_temp_k',6500))); add((2,-2,2),60)
    elif lp=='backlit_window': add((0,back-.3,2),1600,2.5); add((0,-3,2),25)
    elif lp=='dim_evening': add((-2,.8,1.6),85,.45,kelvin(lighting.get('color_temp_k',2700)))
    elif lp=='ceiling_only': add((0,0,2.55),420,.3)
    elif lp=='tv_glow': add((1.2,back-.5,1.5),130,1.1,(.35,.55,1))
    elif lp=='mixed_temp': add((-2,0,2.1),550,2,kelvin(8000)); add((2,0,1.5),200,.6,kelvin(2400))
    elif lp=='party':
        for i,col in enumerate(((1,.025,.1),(.02,.1,1),(.05,1,.2))): add((-2+i*2,1,2.4),160,1,col)
    hz=lighting.get('flicker_hz', 0) or (11 if lp=='flicker' else 0)
    if not math.isfinite(hz) or hz < 0: raise ValueError('lighting.flicker_hz must be finite and nonnegative')
    if hz or lp=='party':
        fps=spec.get('fps',30)
        for i,o in enumerate(lights):
            energy=o.data.energy
            for f in range(1,max(1,math.ceil(spec.get('duration_s',12)*fps))+1):
                t=(f-1)/fps
                o.data.energy=energy*(.55+.45*math.cos(math.tau*hz*t)) if hz else energy
                o.data.keyframe_insert('energy',frame=f)
                if lp=='party':
                    o.location.x=2*math.sin(t*1.3+i*2); o.rotation_euler=(Vector((0,0,1))-o.location).to_track_quat('-Z','Y').to_euler()
                    o.keyframe_insert('location',frame=f); o.keyframe_insert('rotation_euler',frame=f)
    return dict(preset=preset, lighting=lp, features=sorted(features), room_size_m=[2*half,back+4.5,2.6], assets=sorted(set(used+[hdri])), asset_manifest=str(CACHE/'manifest.json'))


def render_settings(spec: dict, scene) -> None:
    lp=spec.get('lighting',{}).get('preset','bright_even')
    if lp not in LIGHTS: raise ValueError(f'Unknown lighting preset: {lp}')
    scene.render.engine='BLENDER_EEVEE'
    scene.eevee.taa_render_samples=24
    scene.eevee.use_raytracing = 'mirror_behind' in spec.get('room',{}).get('features',[]) or spec.get('room',{}).get('preset')=='dance_studio'
    # A webcam's picture: plain sRGB (AgX desaturated clothes and lightened dark skin) at the
    # exposure its auto exposure would pick. The bright presets' key light is ~2.6 m from the
    # dancer (~5 m from the wall), so they're metered down to put a #c03030 shirt at about its
    # own sRGB value; the dark presets stay at 0 (a webcam's gain is maxed out there).
    scene.view_settings.view_transform='Standard'
    scene.view_settings.look='None'
    exposure=spec.get('lighting',{}).get('exposure_ev',0)+AUTO_EXPOSURE_EV.get(lp,0)
    if not math.isfinite(exposure) or not -32<=exposure<=32:raise ValueError('Combined lighting exposure must be finite and in [-32,32] EV')
    scene.view_settings.exposure=exposure
    scene.render.use_motion_blur=True
    scene.render.motion_blur_shutter=.85 if lp in ('dim_evening','tv_glow') else .35
    # Optional per-scene shutter (fraction of a frame): a webcam indoors exposes for 1/60-1/30 s.
    shutter=spec.get('render',{}).get('motion_blur_shutter')
    if shutter is not None:
        if not 0<shutter<=1: raise ValueError('render.motion_blur_shutter must be in (0,1]')
        scene.render.motion_blur_shutter=float(shutter)
    scene.render.image_settings.file_format='PNG'
