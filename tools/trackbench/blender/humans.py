"""Spec person -> MPFB human with the `default` rig, recoloured outfit and optional loose garments.

Garments: any MakeHuman clothes folder name, plus procedural loose ones made from the basemesh's
own skirt helper (fitted to the body, skinned to the hips and legs):
  "tb_skirt"       knee-length flared skirt (over whatever else is worn)
  "tb_long_skirt"  ankle-length skirt
  "tb_dress"       knee-length skirt + the top recoloured the same colour (reads as a dress)
Recolour keys (outfit.recolor): top, bottom, shoes, hat, hair, skirt, all. Values are sRGB hex.
"""
import math
import os
import numpy as np
import bpy

from bl_ext.blender_org.mpfb.services.humanservice import HumanService

MPFB_DATA = os.path.expanduser('~/Library/Application Support/Blender/5.2/extensions/.user/blender_org/mpfb/data')
PROCEDURAL = {'tb_skirt': 0.0, 'tb_dress': 0.0, 'tb_long_skirt': 1.0}

# Basemesh vertex indices of the pose-33 surface points (MakeHuman topology, same for every
# body). Found geometrically on the rest basemesh (checks/find_vertices.py) and checked on renders.
KP_VERTS = {
    0: [5054],            # nose tip
    1: [6880], 2: [14607], 3: [6936],    # left eye inner corner, centre (eye helper front), outer
    4: [96], 5: [14679], 6: [158],       # right eye
    7: [12243], 8: [5646],               # ears (centre of the ear)
    9: [7302], 10: [561],                # mouth corners, left / right
    # (17-22 hand points are knuckle joint centres from bones, see motion.JOINT_BONES; the
    # fingertip vertices, unused, are pinky 9171/2503, index 8595/1927, thumb 9348/2680 L/R.)
    29: [12453], 30: [5856],             # heel backs
    31: [11551], 32: [4933],             # toe tips
}


def _srgb_to_linear(c):
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def hex_to_linear(h):
    h = h.lstrip('#')
    return _srgb_to_linear([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def default_skin(body):
    race = body.get('race', {})
    r = max(('african', 'asian', 'caucasian'), key=lambda k: race.get(k, 0)) if race else 'caucasian'
    g = 'male' if body.get('gender', 0.5) >= 0.5 else 'female'
    age = body.get('age', 0.5)
    a = 'young' if age < 0.62 else ('middleage' if age < 0.85 else 'old')
    return f'{a}_{r}_{g}'


def _asset(kind, name):
    if name in (None, '', 'none'):
        return ''
    if name.endswith('.mhclo') or name.endswith('.mhmat'):
        return name
    ext = '.mhmat' if kind == 'skins' else '.mhclo'
    path = os.path.join(MPFB_DATA, kind, name, name + ext)
    if not os.path.exists(path):
        raise ValueError(f'unknown MakeHuman {kind} asset {name!r} ({path})')
    return f'{name}/{name}{ext}'


class Person:
    pass


def build_person(pspec, index, rng, sss=True):
    """Create one person in the current scene. Returns a Person with rig, objects, body, etc."""
    before = set(bpy.data.objects)
    body = pspec.get('body', {})
    info = HumanService._create_default_human_info_dict()
    ph = info['phenotype']
    for k in ('gender', 'age', 'muscle', 'weight', 'height', 'proportions', 'cupsize', 'firmness'):
        if k in body:
            ph[k] = float(body[k])
    if 'race' in body:
        tot = sum(body['race'].values()) or 1
        ph['race'] = {k: float(body['race'].get(k, 0)) / tot for k in ('african', 'asian', 'caucasian')}
    info['rig'] = 'default'
    info['eyes'] = 'high-poly/high-poly.mhclo'
    info['eyebrows'] = _asset('eyebrows', pspec.get('eyebrows', 'eyebrow001'))
    info['eyelashes'] = _asset('eyelashes', pspec.get('eyelashes', 'eyelashes01'))
    info['hair'] = _asset('hair', pspec.get('hair'))
    outfit = pspec.get('outfit', {})
    clothes = list(outfit.get('clothes', []))
    procedural = [c for c in clothes if c in PROCEDURAL]
    info['clothes'] = [_asset('clothes', c) for c in clothes if c not in PROCEDURAL]
    info['skin_mhmat'] = _asset('skins', pspec.get('skin') or default_skin(body))
    info['skin_material_type'] = 'ENHANCED_SSS' if sss else 'ENHANCED'
    bm = HumanService.deserialize_from_dict(info, HumanService.get_default_deserialization_settings())
    new = [o for o in bpy.data.objects if o not in before]
    rig = next(o for o in new if o.type == 'ARMATURE')
    prefix = f'P{index + 1}'
    for o in new:
        if o is rig:
            o.name = f'{prefix}.rig'
        elif o is bm:
            o.name = f'{prefix}.body'
        else:
            o.name = f'{prefix}.' + o.name.split('.', 1)[-1]
    p = Person()
    p.index, p.spec, p.rig, p.body, p.prefix = index, pspec, rig, bm, prefix
    p.objects = [o for o in new if o.type == 'MESH']
    for o in p.objects:
        # Own copies of every material (masks and recolours are per person).
        for slot in o.material_slots:
            if slot.material is not None:
                orig = slot.material
                m = orig.copy()
                m.name = f'{prefix}.{orig.name}'
                slot.material = m
                _own_groups(m.node_tree, prefix)
                if orig.users == 0:
                    # MPFB looks materials up by name: leave none for the next human to reuse.
                    bpy.data.materials.remove(orig)
    _fix_skin_texture(bm, info['skin_mhmat'])
    p.kind = {}
    for o in p.objects:
        n = o.name.split('.', 1)[1]
        if o is bm:
            p.kind[o.name] = 'body'
        elif n.startswith(('high-poly', 'low-poly')):
            p.kind[o.name] = 'eyes'
        elif n.startswith('eyebrow'):
            p.kind[o.name] = 'eyebrows'
        elif n.startswith('eyelash'):
            p.kind[o.name] = 'eyelashes'
        elif pspec.get('hair') and n.startswith(pspec['hair']):
            p.kind[o.name] = 'hair'
        else:
            p.kind[o.name] = 'clothes'
    rest = rest_coords(bm)
    p.rest = rest
    p.skirts = []
    for c in procedural:
        sk = make_skirt(p, PROCEDURAL[c], rng)
        p.objects.append(sk)
        p.kind[sk.name] = 'clothes'
        p.skirts.append(sk)
    for o in p.objects + [rig]:
        o['tb_kind'] = 'person'
        o['tb_person'] = index
    recolor(p, outfit.get('recolor', {}), 'tb_dress' in procedural)
    # No subdivision: at webcam resolution it's invisible, and evaluating it for every human on
    # every frame (and motion-blur step) cost ~0.9 s/frame with four people. GT ray casts use
    # the same level-0 surface that is rendered.
    for o in p.objects:
        for m in o.modifiers:
            if m.type == 'SUBSURF':
                m.levels = 0
                m.render_levels = 0
    return p


def _fix_skin_texture(bm, skin_rel):
    """With several humans in one file MPFB can leave the first skin's texture on later ones;
    set the diffuse texture from this person's .mhmat."""
    path = os.path.join(MPFB_DATA, 'skins', skin_rel)
    tex = None
    with open(path) as f:
        for line in f:
            parts = line.split()
            if len(parts) >= 2 and parts[0] == 'diffuseTexture':
                tex = os.path.join(os.path.dirname(path), os.path.basename(parts[1]))
    if not tex or not os.path.exists(tex):
        return
    img = bpy.data.images.load(tex, check_existing=True)
    for m in bm.data.materials:
        if m is None or not m.use_nodes:
            continue
        stack = [m.node_tree]
        while stack:
            nt = stack.pop()
            for n in nt.nodes:
                if n.bl_idname == 'ShaderNodeGroup' and n.node_tree:
                    stack.append(n.node_tree)
                elif n.bl_idname == 'ShaderNodeTexImage' and n.name.lower().startswith('diffuse'):
                    n.image = img


def _own_groups(nt, prefix):
    """MPFB reuses node groups by name (the skin group is 'Human.body' for everyone), so the
    next human would change this one's skin: give each person private copies."""
    for n in nt.nodes:
        if n.bl_idname == 'ShaderNodeGroup' and n.node_tree is not None and not n.node_tree.name.startswith(prefix + '.'):
            orig = n.node_tree
            g = orig.copy()
            g.name = f'{prefix}.{orig.name}'
            n.node_tree = g
            _own_groups(g, prefix)
            if orig.users == 0:
                bpy.data.node_groups.remove(orig)


def rest_coords(ob):
    """Original-index vertex coordinates with the shape keys mixed in (the rest shape)."""
    me = ob.data
    n = len(me.vertices)
    co = np.empty(n * 3, np.float32)
    if me.shape_keys:
        kb = me.shape_keys.key_blocks
        kb[0].data.foreach_get('co', co)
        base = co.reshape(-1, 3).astype(np.float64)
        out = base.copy()
        tmp = np.empty(n * 3, np.float32)
        for k in kb[1:]:
            if k.mute or k.value == 0:
                continue
            k.data.foreach_get('co', tmp)
            out += k.value * (tmp.reshape(-1, 3) - base)
        return out
    me.vertices.foreach_get('co', co)
    return co.reshape(-1, 3).astype(np.float64)


def vertex_weights(ob, indices, bone_names):
    """LBS weights for the given vertices: list of [(bone_name, weight), ...] normalised."""
    gname = {g.index: g.name for g in ob.vertex_groups}
    out = []
    for i in indices:
        ws = [(gname[g.group], g.weight) for g in ob.data.vertices[i].groups
              if gname[g.group] in bone_names and g.weight > 0]
        tot = sum(w for _, w in ws) or 1
        out.append([(b, w / tot) for b, w in ws])
    return out


# ---------------------------------------------------------------- recolouring

def _islands(me):
    n = len(me.vertices)
    parent = np.arange(n)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    ev = np.empty(len(me.edges) * 2, np.int64)
    me.edges.foreach_get('vertices', ev)
    for a, b in ev.reshape(-1, 2):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    return np.array([find(i) for i in range(n)])


def _region_attribute(p, ob):
    """Per-vertex region 0 = top, 1 = bottom, by mesh island (a suit's shirt and trousers are
    separate islands); falls back to height when the garment is one piece."""
    me = ob.data
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    bones = p.rig.data.bones
    hip_z = bones['upperleg01.L'].head_local.z
    waist_z = (bones['spine04'].head_local.z + bones['spine05'].head_local.z) / 2
    lab = _islands(me)
    region = np.zeros(len(co), np.float32)
    for r in np.unique(lab):
        sel = lab == r
        zc = co[sel, 2].mean()
        zmax = co[sel, 2].max()
        if zmax < waist_z + 0.08 and zc < hip_z:
            region[sel] = 1.0
        elif zc < hip_z and zmax >= waist_z + 0.08:
            # one-piece garment spanning both: split at the waist
            region[sel] = (co[sel, 2] < waist_z).astype(np.float32)
    attr = me.attributes.get('tb_region') or me.attributes.new('tb_region', 'FLOAT', 'POINT')
    attr.data.foreach_set('value', region)
    return region


def _mean_lum(img, me, region_vals):
    """Mean linear luminance of the texture over the garment's UVs, per region (0, 1)."""
    w, h = img.size
    if w == 0 or not me.uv_layers:
        return [0.5, 0.5]
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    rgb = px[..., :3]
    if img.colorspace_settings.name.lower().startswith('srgb'):
        rgb = _srgb_to_linear(rgb)
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722])
    uv = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers.active.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2)
    lv = np.empty(len(me.loops), np.int64)
    me.loops.foreach_get('vertex_index', lv)
    xs = np.clip((uv[:, 0] % 1.0) * w, 0, w - 1).astype(int)
    ys = np.clip((uv[:, 1] % 1.0) * h, 0, h - 1).astype(int)
    vals = lum[ys, xs]
    alpha = px[ys, xs, 3]
    out = []
    for r in (0, 1):
        sel = (region_vals[lv] == r) & (alpha > 0.5)
        out.append(float(np.mean(vals[sel])) if sel.sum() > 10 else float(np.mean(vals)))
    return [max(v, 0.03) for v in out]


def _tint_material(mat, top, bottom, means, strength=0.9):
    """Insert nodes after the diffuse texture: luminance / mean * colour, per region."""
    nt = mat.node_tree
    tex = nt.nodes.get('diffuseTexture')
    if tex is None:
        tex = next((n for n in nt.nodes if n.bl_idname == 'ShaderNodeTexImage' and n.image
                    and 'normal' not in n.name.lower() and 'ao' not in n.name.lower()), None)
    if tex is None:
        return False
    targets = [l for l in nt.links if l.from_node == tex and l.from_socket.name == 'Color']
    N = nt.nodes.new

    def sock(socks, ident):
        return next(x for x in socks if x.identifier == ident)
    attr = N('ShaderNodeAttribute')
    attr.attribute_name = 'tb_region'
    attr.attribute_type = 'GEOMETRY'

    def mixf(a, b, name):
        m = N('ShaderNodeMix')
        m.data_type = 'FLOAT'
        m.label = name
        nt.links.new(attr.outputs['Fac'], sock(m.inputs, 'Factor_Float'))
        sock(m.inputs, 'A_Float').default_value = a
        sock(m.inputs, 'B_Float').default_value = b
        return sock(m.outputs, 'Result_Float')

    def mixc(a, b):
        m = N('ShaderNodeMix')
        m.data_type = 'RGBA'
        nt.links.new(attr.outputs['Fac'], sock(m.inputs, 'Factor_Float'))
        sock(m.inputs, 'A_Color').default_value = (*a, 1)
        sock(m.inputs, 'B_Color').default_value = (*b, 1)
        return sock(m.outputs, 'Result_Color')
    on = mixf(strength if top is not None else 0.0, strength if bottom is not None else 0.0, 'on')
    mean = mixf(means[0], means[1], 'mean')
    col = mixc(top if top is not None else (1, 1, 1), bottom if bottom is not None else (1, 1, 1))
    bw = N('ShaderNodeRGBToBW')
    nt.links.new(tex.outputs['Color'], bw.inputs[0])
    div = N('ShaderNodeMath')
    div.operation = 'DIVIDE'
    nt.links.new(bw.outputs[0], div.inputs[0])
    nt.links.new(mean, div.inputs[1])
    mul = N('ShaderNodeVectorMath')
    mul.operation = 'SCALE'
    nt.links.new(col, mul.inputs[0])
    nt.links.new(div.outputs[0], mul.inputs['Scale'])
    fin = N('ShaderNodeMix')
    fin.data_type = 'RGBA'
    nt.links.new(on, sock(fin.inputs, 'Factor_Float'))
    nt.links.new(tex.outputs['Color'], sock(fin.inputs, 'A_Color'))
    nt.links.new(mul.outputs[0], sock(fin.inputs, 'B_Color'))
    for l in targets:
        to = l.to_socket
        nt.links.remove(l)
        nt.links.new(sock(fin.outputs, 'Result_Color'), to)
    return True


def recolor(p, rec, dress):
    rec = dict(rec or {})
    if dress and 'skirt' in rec and 'top' not in rec:
        rec['top'] = rec['skirt']
    if dress and 'top' in rec and 'skirt' not in rec:
        rec['skirt'] = rec['top']
    if not rec:
        return
    col = {k: hex_to_linear(v) for k, v in rec.items()}
    for o in p.objects:
        kind = p.kind[o.name]
        name = o.name.split('.', 1)[1].lower()
        if o in p.skirts:
            c = col.get('skirt', col.get('bottom', col.get('all')))
            if c is not None:
                o.data.materials[0].node_tree.nodes['tb_color'].outputs[0].default_value = (*c, 1)
            continue
        if kind == 'hair':
            top = bottom = col.get('hair')
        elif kind != 'clothes':
            continue
        elif 'shoe' in name or 'boot' in name:
            top = bottom = col.get('shoes', col.get('all'))
        elif 'fedora' in name or 'hat' in name:
            top = bottom = col.get('hat', col.get('all'))
        else:
            top, bottom = col.get('top', col.get('all')), col.get('bottom', col.get('all'))
        if top is None and bottom is None:
            continue
        region = _region_attribute(p, o) if kind == 'clothes' else np.zeros(len(o.data.vertices))
        if kind == 'hair':
            attr = o.data.attributes.get('tb_region') or o.data.attributes.new('tb_region', 'FLOAT', 'POINT')
            attr.data.foreach_set('value', np.zeros(len(o.data.vertices), np.float32))
        for mat in o.data.materials:
            if mat is None or not mat.use_nodes:
                continue
            tex = mat.node_tree.nodes.get('diffuseTexture')
            means = _mean_lum(tex.image, o.data, region) if tex is not None and tex.image else [0.5, 0.5]
            _tint_material(mat, top, bottom, means)


# ---------------------------------------------------------------- procedural skirt

def make_skirt(p, length, rng):
    """A loose skirt from the basemesh's skirt helper. length 0 = knee, 1 = ankle."""
    bm = p.body
    me = bm.data
    g = bm.vertex_groups['helper-skirt'].index
    idx = np.array([v.index for v in me.vertices if any(x.group == g and x.weight > 0.5 for x in v.groups)])
    inset = np.zeros(len(me.vertices), bool)
    inset[idx] = True
    co = p.rest
    bones = p.rig.data.bones
    knee_z = bones['lowerleg01.L'].head_local.z
    ankle_z = bones['foot.L'].head_local.z
    hem_z = knee_z - 0.04 + length * (ankle_z + 0.08 - (knee_z - 0.04))
    faces = []
    for poly in me.polygons:
        vs = list(poly.vertices)
        if inset[vs].all() and co[vs, 2].min() > hem_z - 1e-4:
            faces.append(vs)
    used = sorted({v for f in faces for v in f})
    remap = {v: i for i, v in enumerate(used)}
    verts = co[used].copy()
    # Loosen: push outward from the body axis, more toward the hem (a flare).
    top_z = verts[:, 2].max()
    hip = (np.array(bones['upperleg01.L'].head_local) + np.array(bones['upperleg01.R'].head_local)) / 2
    t = np.clip((top_z - verts[:, 2]) / max(top_z - hem_z, 1e-3), 0, 1)
    radial = verts[:, :2] - hip[:2]
    rn = np.linalg.norm(radial, axis=1, keepdims=True) + 1e-9
    flare = 0.012 + (0.09 + 0.05 * length) * t ** 1.2
    verts[:, :2] += radial / rn * flare[:, None]
    mesh = bpy.data.meshes.new(f'{p.prefix}.skirt')
    mesh.from_pydata(verts.tolist(), [], [[remap[v] for v in f] for f in faces])
    mesh.update()
    for poly in mesh.polygons:
        poly.use_smooth = True
    ob = bpy.data.objects.new(f'{p.prefix}.skirt', mesh)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = p.rig
    # Weights: the waist follows the pelvis; lower down, a mix of both thighs (so the cloth hangs
    # between the legs rather than wrapping each), biased toward the leg on the same side.
    side = np.clip(verts[:, 0] / 0.12, -1, 1)
    wl = 0.5 + 0.35 * side
    def vg(name):
        return ob.vertex_groups.get(name) or ob.vertex_groups.new(name=name)
    hipw = np.clip(1 - t * 2.2, 0, 1)
    legw = 1 - hipw
    upper = np.clip(1 - t * 1.4, 0, 1) if length < 0.5 else np.clip(1 - t * 0.9, 0, 1)
    groups = {'root': hipw, 'upperleg02.L': legw * wl * upper, 'upperleg02.R': legw * (1 - wl) * upper,
              'lowerleg01.L': legw * wl * (1 - upper), 'lowerleg01.R': legw * (1 - wl) * (1 - upper)}
    for name, ws in groups.items():
        grp = vg(name)
        for i, w in enumerate(ws):
            if w > 1e-3:
                grp.add([i], float(w), 'REPLACE')
    mod = ob.modifiers.new('Armature', 'ARMATURE')
    mod.object = p.rig
    sol = ob.modifiers.new('Solidify', 'SOLIDIFY')
    sol.thickness = 0.004
    sol.offset = 1.0
    # Fabric material: colour * a soft woven noise.
    mat = bpy.data.materials.new(f'{p.prefix}.skirt')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    bsdf.inputs['Roughness'].default_value = 0.85
    rgb = nt.nodes.new('ShaderNodeRGB')
    rgb.name = 'tb_color'
    hue = rng.random()
    import colorsys
    rgb.outputs[0].default_value = (*_srgb_to_linear(colorsys.hsv_to_rgb(hue, 0.55, 0.6)), 1)
    noise = nt.nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 60.0
    ramp = nt.nodes.new('ShaderNodeMapRange')
    ramp.inputs['To Min'].default_value = 0.8
    ramp.inputs['To Max'].default_value = 1.1
    nt.links.new(noise.outputs['Fac'], ramp.inputs['Value'])
    mul = nt.nodes.new('ShaderNodeVectorMath')
    mul.operation = 'SCALE'
    nt.links.new(rgb.outputs[0], mul.inputs[0])
    nt.links.new(ramp.outputs['Result'], mul.inputs['Scale'])
    nt.links.new(mul.outputs[0], bsdf.inputs['Base Color'])
    ob.data.materials.append(mat)
    return ob


def contact_points(p):
    """Points used to put the person on the floor: [(bone, rest_point, radius)]. The feet use
    the lowest point of everything they wear (shoe soles) under the heel and toe."""
    bones = p.rig.data.bones
    deps = bpy.context.evaluated_depsgraph_get()
    p.rig.data.pose_position = 'REST'
    deps.update()
    sole = 0.0
    for o in p.objects:
        if p.kind.get(o.name) in ('body', 'clothes'):
            ev = o.evaluated_get(deps)
            me = ev.to_mesh()
            n = len(me.vertices)
            if n:
                co = np.empty(n * 3, np.float32)
                me.vertices.foreach_get('co', co)
                sole = min(sole, float(co[2::3].min()))
            ev.to_mesh_clear()
    p.rig.data.pose_position = 'POSE'
    co = p.rest
    pts = []
    for s, heel, toe in (('L', KP_VERTS[29][0], KP_VERTS[31][0]), ('R', KP_VERTS[30][0], KP_VERTS[32][0])):
        for v in (heel, toe):
            pt = co[v].copy()
            pt[2] = sole
            pts.append((f'foot.{s}', pt, 0.0))
        pts.append((f'lowerleg01.{s}', np.array(bones[f'lowerleg01.{s}'].head_local), 0.06))
        pts.append((f'wrist.{s}', np.array(bones[f'wrist.{s}'].head_local), 0.03))
        pts.append((f'lowerarm01.{s}', np.array(bones[f'lowerarm01.{s}'].head_local), 0.045))
        pts.append((f'upperarm01.{s}', np.array(bones[f'upperarm01.{s}'].head_local), 0.06))
        pts.append((f'upperleg01.{s}', np.array(bones[f'upperleg01.{s}'].head_local), 0.09))
    pts.append(('head', np.array(bones['head'].head_local) + np.array([0, 0, 0.1]), 0.11))
    p.sole_z = sole
    return pts


# ---------------------------------------------------------------- table-tennis paddle

PADDLE = dict(blade_w=0.150, blade_h=0.158, blade_t=0.007, handle_l=0.100, handle_w=0.028, handle_t=0.023)


def _hand_frame_rest(rig, s):
    """Rest-pose hand frame (armature space): wrist head, along (to the middle knuckle), across
    (pinky to index, square to along), palm normal (the side the thumb curls to)."""
    H = {b.name: np.array(b.head_local) for b in rig.data.bones}
    h0 = H[f'wrist.{s}']
    a = H[f'finger3-1.{s}'] - h0
    a /= np.linalg.norm(a)
    c = H[f'finger2-1.{s}'] - H[f'finger5-1.{s}']
    c -= np.dot(c, a) * a
    c /= np.linalg.norm(c)
    n = np.cross(a, c)
    if np.dot(H[f'finger1-3.{s}'] - (H[f'finger2-1.{s}'] + H[f'finger5-1.{s}']) / 2, n) < 0:
        n = -n
    return h0, a, c, n


def make_paddle(p, hand, opts=None):
    """A shakehand table-tennis paddle in the person's paddle hand: a 15 x 15.8 cm blade with red
    (forehand, palm side) and black rubbers, a 10 cm wooden handle across the palm, parented to
    the wrist bone. The object's origin is the blade centre, local +y points from the handle to
    the blade's tip, local +z is the forehand face's normal. Not part of the person's mask; GT
    treats it as an occluder (vis 2) and reports its centre and normal."""
    import bmesh
    from mathutils import Matrix
    opts = dict(opts or {})
    d = dict(PADDLE)
    s = 'R' if hand == 'right' else 'L'
    rig = p.rig
    h0, a, c, n = _hand_frame_rest(rig, s)
    # Handle along the palm's diagonal (heel of the hand to the thumb-index web), its grip point
    # inside the curled fingers (the handle's butt just past the little finger), the blade beyond the web, its face parallel to the palm.
    h = 0.5 * a + 0.87 * c
    h /= np.linalg.norm(h)
    nz = n - np.dot(n, h) * h
    nz /= np.linalg.norm(nz)
    grip = h0 + a * opts.get('grip_along', 0.068) + n * opts.get('grip_out', 0.021)
    centre = grip + h * (0.058 + d['blade_h'] / 2)
    x = np.cross(h, nz)
    M = np.eye(4)
    M[:3, 0], M[:3, 1], M[:3, 2], M[:3, 3] = x, h, nz, centre
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=48, radius1=0.5, radius2=0.5, depth=1.0)
    bmesh.ops.scale(bm, vec=(d['blade_w'], d['blade_h'], d['blade_t']), verts=bm.verts)
    hb = bmesh.ops.create_cube(bm, size=1.0)
    hv = hb['verts']
    bmesh.ops.scale(bm, vec=(d['handle_w'], d['handle_l'], d['handle_t']), verts=hv)
    bmesh.ops.translate(bm, vec=(0, -(d['blade_h'] / 2 + d['handle_l'] / 2 - 0.004), 0), verts=hv)
    hset = set(hv)
    for f in bm.faces:
        if any(v in hset for v in f.verts):
            f.material_index = 2
        elif f.normal.z > 0.9:
            f.material_index = 0
        elif f.normal.z < -0.9:
            f.material_index = 1
        else:
            f.material_index = 2
        f.smooth = False
    me = bpy.data.meshes.new(f'{p.prefix}.paddle')
    bm.to_mesh(me)
    bm.free()

    def mat(name, hexcol, rough):
        m = bpy.data.materials.new(f'{p.prefix}.paddle_{name}')
        m.use_nodes = True
        b = m.node_tree.nodes.get('Principled BSDF')
        b.inputs['Base Color'].default_value = (*hex_to_linear(hexcol), 1)
        b.inputs['Roughness'].default_value = rough
        return m
    me.materials.append(mat('forehand', opts.get('forehand', '#b3141c'), 0.55))
    me.materials.append(mat('backhand', opts.get('backhand', '#141414'), 0.6))
    me.materials.append(mat('wood', opts.get('wood', '#b98a55'), 0.7))
    ob = bpy.data.objects.new(f'{p.prefix}.paddle', me)
    bpy.context.scene.collection.objects.link(ob)
    ob['tb_kind'] = 'prop'
    ob['tb_person'] = p.index
    ob.parent = rig
    ob.parent_type = 'BONE'
    ob.parent_bone = f'wrist.{s}'
    # Rest pose: place it in armature space (the rig sits at the origin unrotated).
    rig.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    ob.matrix_world = Matrix(M.tolist())
    rig.data.pose_position = 'POSE'
    bpy.context.view_layer.update()
    p.paddle, p.paddle_hand = ob, hand
    return ob
