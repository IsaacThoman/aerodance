"""Per-frame ground truth: pose-33 keypoints (2D, depth, 3D), visibility codes, instance masks,
bboxes and visible fractions. See GENERATOR.md for the definitions and how they were checked.

Visibility (contract codes): 3 if the point projects outside the frame (or behind the camera).
Otherwise a ray from the camera to the point is tested against the person's own body and
clothes (hair, eyes, brows and lashes are not occluders), the other people, and the environment:
  - the first surface hit decides;
  - another person or an environment object hit more than `eps` before the point -> 2;
  - for joint centres (which sit inside the body) the person's own surface counts as the joint's
    own skin if the hit face belongs mostly to one of the joint's bones and lies within `reach`
    of the joint -> 0; any other own surface -> 1;
  - for surface points (face, fingers, heel, toe) any own surface more than `eps` before -> 1.
"""
import os
import numpy as np
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import humans
from motion import JOINT_BONES

FINGERS = {f'finger{i}-{j}.{s}' for i in range(1, 6) for j in range(1, 4) for s in 'LR'} | \
          {f'metacarpal{i}.{s}' for i in range(1, 5) for s in 'LR'}
TOES = {f'toe{i}-{j}.{s}' for i in range(1, 6) for j in range(1, 4) for s in 'LR'}


def _side(names, s):
    return {n for n in names if n.endswith('.' + s)}


# joint index -> (own bones, reach in metres)
JOINT_OWN = {}
for s, k in (('L', 0), ('R', 1)):
    JOINT_OWN[11 + k] = ({f'clavicle.{s}', f'shoulder01.{s}', f'upperarm01.{s}', f'upperarm02.{s}',
                          'spine01', 'spine02', f'breast.{s}', 'neck01'}, 0.16)
    JOINT_OWN[13 + k] = ({f'upperarm02.{s}', f'lowerarm01.{s}', f'lowerarm02.{s}', f'upperarm01.{s}'}, 0.09)
    JOINT_OWN[15 + k] = ({f'lowerarm02.{s}', f'lowerarm01.{s}', f'wrist.{s}'} | _side(FINGERS, s), 0.07)
    JOINT_OWN[17 + k] = JOINT_OWN[19 + k] = JOINT_OWN[21 + k] = (
        {f'wrist.{s}', f'lowerarm02.{s}'} | _side(FINGERS, s), 0.05)
    JOINT_OWN[23 + k] = ({'root', f'pelvis.{s}', f'upperleg01.{s}', f'upperleg02.{s}', 'spine05', 'spine04'}, 0.20)
    JOINT_OWN[25 + k] = ({f'upperleg02.{s}', f'lowerleg01.{s}', f'lowerleg02.{s}'}, 0.11)
    JOINT_OWN[27 + k] = ({f'lowerleg02.{s}', f'foot.{s}', f'lowerleg01.{s}'} | _side(TOES, s), 0.09)

# surface point index -> eps (how far in front of the point an own surface must be to hide it)
SURFACE_EPS = {i: 0.015 for i in range(0, 11)}
SURFACE_EPS.update({7: 0.03, 8: 0.03})
SURFACE_EPS.update({29: 0.04, 30: 0.04, 31: 0.05, 32: 0.05})
OTHER_EPS = 0.02

OCCLUDER_KINDS = ('body', 'clothes')


class Camera:
    """Projection with the scene camera, exactly as rendered (sensor fit, shift, resolution)."""

    def __init__(self, scene):
        self.scene = scene
        self.update()

    def update(self):
        sc = self.scene
        cam = sc.camera
        self.W = sc.render.resolution_x * sc.render.resolution_percentage // 100
        self.H = sc.render.resolution_y * sc.render.resolution_percentage // 100
        fr = [Vector(v) for v in cam.data.view_frame(scene=sc)]
        xs = [v.x for v in fr]
        ys = [v.y for v in fr]
        self.z0 = fr[0].z
        self.left, self.right = min(xs), max(xs)
        self.bottom, self.top = min(ys), max(ys)
        mw = cam.matrix_world
        self.M = np.array(mw)
        self.Minv = np.linalg.inv(self.M)
        self.origin = np.array(mw.translation)

    def to_cam(self, P):
        P = np.asarray(P, float)
        return P @ self.Minv[:3, :3].T + self.Minv[:3, 3]

    def project(self, P):
        """World points (N, 3) -> (N, 3) normalized x, y (top-left origin) and depth (m)."""
        c = self.to_cam(P)
        z = c[:, 2]
        with np.errstate(divide='ignore', invalid='ignore'):
            s = self.z0 / z
            x = (c[:, 0] * s - self.left) / (self.right - self.left)
            y = (self.top - c[:, 1] * s) / (self.top - self.bottom)
        return np.stack([x, y, -z], 1)

    def pixel_dirs(self, xs, ys):
        """World ray directions through normalized image points."""
        cx = self.left + np.asarray(xs) * (self.right - self.left)
        cy = self.top - np.asarray(ys) * (self.top - self.bottom)
        d = np.stack([cx, cy, np.full_like(cx, self.z0)], -1)
        d = d @ self.M[:3, :3].T
        return d / np.linalg.norm(d, axis=-1, keepdims=True)


class PersonGT:
    def __init__(self, person, motion_result):
        self.p = person
        self.m = motion_result
        rig = person.rig
        bone_names = {b.name for b in rig.data.bones}
        self.kp_vidx = {k: v for k, v in humans.KP_VERTS.items()}
        all_v = sorted({v for vs in self.kp_vidx.values() for v in vs})
        self.vrest = {v: person.rest[v] for v in all_v}
        self.vw = dict(zip(all_v, humans.vertex_weights(person.body, all_v, bone_names)))
        self.occluders = [o for o in person.objects if person.kind.get(o.name) in OCCLUDER_KINDS]
        self.poly_bone = {}

    def setup_labels(self, deps):
        """Dominant bone of every evaluated polygon of the occluder meshes (topology is fixed)."""
        for o in self.occluders:
            ev = o.evaluated_get(deps)
            me = ev.to_mesh()
            bones = {b.name for b in self.p.rig.data.bones if b.use_deform}
            names = {g.index: g.name for g in o.vertex_groups if g.name in bones}
            nv = len(me.vertices)
            dom = np.full(nv, -1, np.int64)
            bone_ids = {}
            for v in me.vertices:
                best, bw = None, 0.0
                for g in v.groups:
                    if g.group in names and g.weight > bw:
                        best, bw = names.get(g.group), g.weight
                if best is not None:
                    dom[v.index] = bone_ids.setdefault(best, len(bone_ids))
            id2name = {i: n for n, i in bone_ids.items()}
            lab = []
            for poly in me.polygons:
                vs = [dom[i] for i in poly.vertices if dom[i] >= 0]
                lab.append(id2name[max(set(vs), key=vs.count)] if vs else None)
            self.poly_bone[o.name] = lab
            ev.to_mesh_clear()

    def keypoints3d(self):
        """(33, 3) world positions at the current frame."""
        rig = self.p.rig
        mw = np.array(rig.matrix_world)
        pose = rig.pose.bones
        out = np.full((33, 3), np.nan)
        for j, b in JOINT_BONES.items():
            out[j] = mw[:3, :3] @ np.array(pose[b].head) + mw[:3, 3]
        mats = {}
        for k, vs in self.kp_vidx.items():
            acc = np.zeros(3)
            for v in vs:
                pv = np.zeros(3)
                for b, w in self.vw[v]:
                    if b not in mats:
                        pb = pose[b]
                        mats[b] = np.array(pb.matrix) @ np.linalg.inv(np.array(pb.bone.matrix_local))
                    M = mats[b]
                    pv += w * (M[:3, :3] @ self.vrest[v] + M[:3, 3])
                acc += pv
            acc /= len(vs)
            out[k] = mw[:3, :3] @ acc + mw[:3, 3]
        return out


def _ray_first(bvhs, origin, d, maxdist):
    """Nearest hit over [(tag, obj_name, bvh)]: (distance, tag, obj_name, face) or None."""
    best = None
    o = Vector(origin)
    dv = Vector(d)
    for tag, name, t in bvhs:
        loc, nrm, idx, dist = t.ray_cast(o, dv, maxdist)
        if loc is not None and (best is None or dist < best[0]):
            best = (dist, tag, name, idx)
    return best


class FrameGT:
    """Builds GT for each frame of one scene in this Blender process."""

    def __init__(self, scene, people, results, spec):
        self.scene = scene
        self.spec = spec
        self.people = [PersonGT(p, r) for p, r in zip(people, results)]
        self.cam = Camera(scene)
        deps = bpy.context.evaluated_depsgraph_get()
        for pg in self.people:
            pg.setup_labels(deps)
        self.env_static = None
        self._env_objs = [o for o in scene.objects if o.type == 'MESH' and o.get('tb_kind') in ('environment', 'distractor')
                          and not o.hide_render]
        self._env_animated = any(o.animation_data and o.animation_data.action for o in self._env_objs)

    def _env_bvh(self, deps):
        if self.env_static is not None and not self._env_animated:
            return self.env_static
        verts, tris, off = [], [], 0
        for o in self._env_objs:
            ev = o.evaluated_get(deps)
            try:
                me = ev.to_mesh()
            except RuntimeError:
                continue
            n = len(me.vertices)
            if n == 0:
                ev.to_mesh_clear()
                continue
            co = np.empty(n * 3, np.float32)
            me.vertices.foreach_get('co', co)
            co = co.reshape(-1, 3) @ np.array(ev.matrix_world)[:3, :3].T + np.array(ev.matrix_world)[:3, 3]
            me.calc_loop_triangles()
            t = np.empty(len(me.loop_triangles) * 3, np.int64)
            me.loop_triangles.foreach_get('vertices', t)
            verts.append(co)
            tris.append(t.reshape(-1, 3) + off)
            off += n
            ev.to_mesh_clear()
        if not verts:
            self.env_static = None
            return None
        V = np.concatenate(verts)
        T = np.concatenate(tris)
        self.env_static = BVHTree.FromPolygons(V.tolist(), T.tolist(), all_triangles=True)
        return self.env_static

    def frame(self, f, mask):
        """GT dict for frame f (scene already at frame f); mask: (H, W) uint8 or None."""
        sc = self.scene
        fps = sc.render.fps / sc.render.fps_base
        deps = bpy.context.evaluated_depsgraph_get()
        cam = self.cam
        cam.update()
        H, W = cam.H, cam.W
        env = self._env_bvh(deps)
        active = [pg for pg in self.people if pg.m['visible'][f - 1]]
        bvhs = {}
        for pg in active:
            bvhs[pg.p.index] = [('self', o.name, BVHTree.FromObject(o, deps)) for o in pg.occluders]
        out = {'frame': f, 't_ms': round((f - 1) * 1000.0 / fps, 3), 'people': []}
        for pg in active:
            k = pg.p.index
            P = pg.keypoints3d()
            proj = cam.project(P)
            own = bvhs[k]
            others = [('other', n, t) for kk, lst in bvhs.items() if kk != k for _, n, t in lst]
            if env is not None:
                others.append(('other', 'env', env))
            vis = []
            for j in range(33):
                x, y, z = proj[j]
                if not (z > 0 and 0 <= x <= 1 and 0 <= y <= 1):
                    vis.append(3)
                    continue
                d = P[j] - cam.origin
                dist = float(np.linalg.norm(d))
                d = d / dist
                ho = _ray_first(others, cam.origin, d, dist)
                hs = _ray_first(own, cam.origin, d, dist + 0.5)
                if ho is not None and ho[0] < dist - OTHER_EPS and (hs is None or ho[0] < hs[0]):
                    vis.append(2)
                    continue
                if hs is None:
                    vis.append(0)
                    continue
                if j in JOINT_OWN:
                    bones, reach = JOINT_OWN[j]
                    bone = pg.poly_bone[hs[2]][hs[3]] if hs[3] < len(pg.poly_bone[hs[2]]) else None
                    vis.append(0 if (bone in bones and dist - hs[0] <= reach) else 1)
                else:
                    vis.append(1 if hs[0] < dist - SURFACE_EPS.get(j, 0.02) else 0)
            # Silhouette (body + clothes, unoccluded) sampled by rays on a pixel grid, compared
            # with the mask for the visible fraction.
            vf, in_frame, bbox = self._coverage(pg, own, mask, k + 1, deps)
            out['people'].append({
                'id': pg.p.spec['id'], 'role': pg.p.spec.get('role', 'player'), 'index': k,
                'kp': [[_r(proj[j, 0]), _r(proj[j, 1]), _r(proj[j, 2], 4), vis[j]] for j in range(33)],
                'kp3d': [[_r(v, 4) for v in P[j]] for j in range(33)],
                'bbox': bbox, 'visible_frac': vf, 'in_frame': in_frame,
                'phase': str(pg.m['phase'][f - 1])})
        return out

    def _coverage(self, pg, own, mask, label, deps):
        cam = self.cam
        H, W = cam.H, cam.W
        pts = []
        for o in pg.occluders:
            ev = o.evaluated_get(deps)
            me = ev.to_mesh()
            n = len(me.vertices)
            if n:
                co = np.empty(n * 3, np.float32)
                me.vertices.foreach_get('co', co)
                co = co.reshape(-1, 3)[::3].astype(float)
                mw = np.array(ev.matrix_world)
                pts.append(co @ mw[:3, :3].T + mw[:3, 3])
            ev.to_mesh_clear()
        pr = cam.project(np.concatenate(pts))
        pr = pr[pr[:, 2] > 0]
        if len(pr) == 0:
            return 0.0, False, None
        x0, x1 = np.clip([pr[:, 0].min(), pr[:, 0].max()], 0, 1)
        y0, y1 = np.clip([pr[:, 1].min(), pr[:, 1].max()], 0, 1)
        if x1 <= x0 or y1 <= y0:
            return 0.0, False, None
        # Grid of pixel centres over the clipped projected box, ~90 rows.
        step = max(2, int((y1 - y0) * H / 90))
        cols = np.arange(int(x0 * W), int(np.ceil(x1 * W)), step) + 0.5
        rows = np.arange(int(y0 * H), int(np.ceil(y1 * H)), step) + 0.5
        sil = vis = 0
        if len(cols) and len(rows):
            gx, gy = np.meshgrid(cols / W, rows / H)
            dirs = cam.pixel_dirs(gx.ravel(), gy.ravel())
            o = Vector(cam.origin)
            ix = (gx.ravel() * W).astype(int)
            iy = (gy.ravel() * H).astype(int)
            for d, px, py in zip(dirs, ix, iy):
                dv = Vector(d)
                hit = False
                for _, _, t in own:
                    if t.ray_cast(o, dv, 1000.0)[0] is not None:
                        hit = True
                        break
                if hit:
                    sil += 1
                    if mask is not None and mask[py, px] == label:
                        vis += 1
        in_frame = sil > 0
        bbox = None
        if mask is not None:
            ys, xs = np.nonzero(mask == label)
            if len(xs):
                bbox = [_r(xs.min() / W), _r(ys.min() / H), _r((xs.max() + 1) / W), _r((ys.max() + 1) / H)]
                in_frame = True
        vf = _r(vis / sil, 4) if (sil and mask is not None) else (None if mask is None else 0.0)
        return vf, bool(in_frame), bbox


def _r(v, n=5):
    v = float(v)
    return None if not np.isfinite(v) else round(v, n)


# ---------------------------------------------------------------- instance masks via AOVs

def setup_masks(scene, people, tmp_dir):
    """One-hot colour AOVs (3 people per AOV) on every person material, written by a compositor
    File Output node as a half-float EXR next to each render."""
    vl = scene.view_layers[0]
    n_aov = max(1, (len(people) + 2) // 3)
    names = [f'tbmask{i}' for i in range(n_aov)]
    for nm in names:
        if nm not in [a.name for a in vl.aovs]:
            a = vl.aovs.add()
            a.name = nm
            a.type = 'COLOR'
    for p in people:
        k = p.index
        aov, ch = names[k // 3], k % 3
        col = [0.0, 0.0, 0.0, 1.0]
        col[ch] = 1.0
        for o in p.objects:
            for m in o.data.materials:
                if m is None or not m.use_nodes:
                    continue
                nt = m.node_tree
                for i, nm in enumerate(names):
                    node = nt.nodes.new('ShaderNodeOutputAOV')
                    node.aov_name = nm
                    node.inputs['Color'].default_value = tuple(col) if nm == aov else (0, 0, 0, 1)
    ng = scene.compositing_node_group
    if ng is None:
        ng = bpy.data.node_groups.new('tb_comp', 'CompositorNodeTree')
        scene.compositing_node_group = ng
        rl = ng.nodes.new('CompositorNodeRLayers')
        gout = ng.nodes.new('NodeGroupOutput')
        ng.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
        ng.links.new(rl.outputs['Image'], gout.inputs[0])
    else:
        rl = next(n for n in ng.nodes if n.bl_idname == 'CompositorNodeRLayers')
    # One File Output node per AOV: Blender 5.2's multilayer output writes only its first input.
    fos = []
    for nm in names:
        fo = ng.nodes.new('CompositorNodeOutputFile')
        fo.name = 'tb_' + nm
        fo.directory = tmp_dir.rstrip('/') + '/'
        fo.file_name = nm
        fo.format.media_type = 'MULTI_LAYER_IMAGE'
        fo.format.file_format = 'OPEN_EXR_MULTILAYER'
        fo.format.color_depth = '16'
        fo.format.exr_codec = 'ZIP'
        fo.file_output_items.new('RGBA', nm)
        ng.links.new(rl.outputs[nm], fo.inputs[nm])
        fos.append(fo)
    scene.render.use_compositing = True
    return fos, names


def set_mask_frame(fos, f):
    for fo in fos:
        fo.file_name = f'{fo.name[3:]}_{f:06d}'


def read_mask(tmp_dir, f, names, n_people):
    """Decode (and delete) the AOV EXRs of frame f into an (H, W) uint8 instance mask."""
    import OpenImageIO as oiio
    planes = {}
    for nm in names:
        path = os.path.join(tmp_dir, f'{nm}_{f:06d}.exr')
        inp = oiio.ImageInput.open(path)
        spec = inp.spec()
        a = inp.read_image(format='float').reshape(spec.height, spec.width, -1)
        inp.close()
        ch = list(spec.channelnames)
        for c in 'RGB':
            planes[f'{nm}.{c}'] = a[..., ch.index(f'{nm}.{c}')]
        os.remove(path)
    H, W = next(iter(planes.values())).shape
    if n_people == 0:
        return np.zeros((H, W), np.uint8)
    st = np.stack([planes[f'{names[k // 3]}.{"RGB"[k % 3]}'] for k in range(n_people)], -1)
    best = st.argmax(-1)
    val = st.max(-1)
    return np.where(val >= 0.5, best + 1, 0).astype(np.uint8)


def write_png8(path, arr):
    import OpenImageIO as oiio
    out = oiio.ImageOutput.create(path)
    spec = oiio.ImageSpec(arr.shape[1], arr.shape[0], 1, oiio.UINT8)
    out.open(path, spec)
    out.write_image(np.ascontiguousarray(arr.astype(np.uint8)[..., None]))
    out.close()


def read_png8(path):
    import OpenImageIO as oiio
    inp = oiio.ImageInput.open(path)
    a = inp.read_image(format=oiio.UINT8)
    inp.close()
    return a.reshape(a.shape[0], a.shape[1], -1)[..., 0]
