"""Timelines (offstage, walk, hold, dance) -> keyframed MPFB `default` rigs.

Every segment produces SMPL-style poses: ``q`` (24, 4) with q[0] the root's global orientation in
stage coordinates and q[j>0] SMPL local joint rotations (in the stage frame), plus ``hip`` (3,),
the midpoint of the two hip joints in stage coordinates (metres, this person's size). Segments
blend into each other (slerp per joint) and every pose goes through one retarget onto the rig:
each mapped bone takes its SMPL joint's world rotation applied to the bone's T-pose ("canonical")
orientation, so limb directions follow the mocap independently of bone-length differences.

The retarget math is plain NumPy (``RigModel``), so it can be checked against AIST++'s own
keypoints without Blender (see checks/retarget_check.py).
"""
import math
import numpy as np

import smpl
from smpl import qmul, qconj, qrot, qslerp, q2m, m2q, yaw_q, axis_angle, heading_of, to_stage

# MPFB bone -> (SMPL joint whose world rotation drives it, SMPL child joint giving the T-pose
# direction, or None to treat the MPFB rest orientation as SMPL's rest orientation).
BONE_MAP = {
    'root': (0, None), 'pelvis.L': (0, None), 'pelvis.R': (0, None),
    'spine05': (0, None), 'spine04': (0, None), 'spine03': (3, None), 'spine02': (6, None),
    'spine01': (9, None), 'neck01': (12, None), 'neck02': (12, None), 'neck03': (12, None),
    'head': (15, None),
    'clavicle.L': (13, None), 'shoulder01.L': (13, None),
    'clavicle.R': (14, None), 'shoulder01.R': (14, None),
    'upperarm01.L': (16, 18), 'upperarm02.L': (16, 18), 'lowerarm01.L': (18, 20), 'lowerarm02.L': (18, 20),
    'wrist.L': (20, 22),
    'upperarm01.R': (17, 19), 'upperarm02.R': (17, 19), 'lowerarm01.R': (19, 21), 'lowerarm02.R': (19, 21),
    'wrist.R': (21, 23),
    'upperleg01.L': (1, 4), 'upperleg02.L': (1, 4), 'lowerleg01.L': (4, 7), 'lowerleg02.L': (4, 7),
    'foot.L': (7, 10),
    'upperleg01.R': (2, 5), 'upperleg02.R': (2, 5), 'lowerleg01.R': (5, 8), 'lowerleg02.R': (5, 8),
    'foot.R': (8, 11),
}

# Pose-33 joint centres taken from bone heads (contract: "Joint definitions").
JOINT_BONES = {11: 'upperarm01.L', 12: 'upperarm01.R', 13: 'lowerarm01.L', 14: 'lowerarm01.R',
               15: 'wrist.L', 16: 'wrist.R', 23: 'upperleg01.L', 24: 'upperleg01.R',
               25: 'lowerleg01.L', 26: 'lowerleg01.R', 27: 'foot.L', 28: 'foot.R',
               # Hand points are knuckles, as MediaPipe places them (checked against Lite: median
               # 0.07-0.09 torso lengths from these vs 0.15-0.19 from the fingertips).
               17: 'finger5-1.L', 18: 'finger5-1.R', 19: 'finger2-1.L', 20: 'finger2-1.R',
               21: 'finger1-2.L', 22: 'finger1-2.R'}

HIP_MID_SMPL = to_stage((smpl.J_REST[1] + smpl.J_REST[2]) / 2 - smpl.J_REST[0])


def _swing(a, b):
    """Rotation matrix taking unit vector a onto unit vector b by the shortest arc."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if c < -0.999999:
        axis = np.cross(a, [1.0, 0, 0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, [0, 1.0, 0])
        return q2m(axis_angle(axis, math.pi))
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx / (1 + c)


class RigModel:
    """Rest data of one MPFB rig plus the retarget, in NumPy."""

    def __init__(self, bones):
        """bones: list of (name, parent_name or None, head_rest (3,), rest_rot (3, 3)) in armature
        space, parents before children. The armature object must sit at the origin unrotated."""
        self.names = [b[0] for b in bones]
        self.idx = {n: i for i, n in enumerate(self.names)}
        self.parent = [self.idx[b[1]] if b[1] else -1 for b in bones]
        self.head = np.array([b[2] for b in bones], float)
        self.B = np.array([b[3] for b in bones], float)
        self.mapped = [n for n in self.names if n in BONE_MAP]
        # Canonical (SMPL T-pose equivalent) world orientation of each mapped bone.
        self.A = {}
        for n in self.mapped:
            j, child = BONE_MAP[n]
            B = self.B[self.idx[n]]
            if child is None:
                self.A[n] = B
            else:
                d = to_stage(smpl.J_REST[child] - smpl.J_REST[j])
                self.A[n] = _swing(B[:, 1], d) @ B
        hl, hr = self.head[self.idx['upperleg01.L']], self.head[self.idx['upperleg01.R']]
        self.hip_rest = (hl + hr) / 2
        self.root_head = self.head[self.idx['root']]
        legs = []
        for s in 'LR':
            h, k, a = (self.head[self.idx[f'{b}.{s}']] for b in ('upperleg01', 'lowerleg01', 'foot'))
            legs.append(np.linalg.norm(k - h) + np.linalg.norm(a - k))
        self.leg_length = float(np.mean(legs))
        self.scale = self.leg_length / smpl.smpl_leg_length()

    def solve(self, q, hip):
        """Poses (N, 24, 4) + hip midpoints (N, 3) -> dict of world rotations W (name -> (N,3,3)),
        bone heads (name -> (N, 3)), basis quaternions (name -> (N, 4)), root location (N, 3)."""
        G = q2m(smpl.fk_stage(q))  # (N, 24, 3, 3)
        W = {n: G[:, BONE_MAP[n][0]] @ self.A[n] for n in self.mapped}
        ri = self.idx['root']
        Wr = W['root']
        root_head = hip - np.einsum('nij,j->ni', Wr @ self.B[ri].T, self.hip_rest - self.root_head)
        heads = {'root': root_head}
        basis = {}
        for n in self.mapped:
            i = self.idx[n]
            p = self.parent[i]
            if p < 0:
                R = self.B[i].T @ W[n]
            else:
                pn = self.names[p]
                R = self.B[i].T @ self.B[p] @ np.swapaxes(W[pn], 1, 2) @ W[n]
                heads[n] = heads[pn] + np.einsum('nij,j->ni', W[pn] @ self.B[p].T, self.head[i] - self.head[p])
            basis[n] = np.array([m2q(r) for r in R])
        loc = np.einsum('ij,nj->ni', self.B[ri].T, root_head - self.root_head)
        return {'W': W, 'heads': heads, 'basis': basis, 'root_loc': loc}

    def point(self, sol, bone, rest_point):
        """World positions (N, 3) of a point rigidly attached to a mapped bone."""
        i = self.idx[bone]
        return sol['heads'][bone] + np.einsum('nij,j->ni', sol['W'][bone] @ self.B[i].T,
                                              np.asarray(rest_point) - self.head[i])

    def min_contact_z(self, sol, contacts):
        """Lowest z over contact points [(bone, rest_point, radius)] per frame."""
        zs = [self.point(sol, b, p)[:, 2] - r for b, p, r in contacts]
        return np.min(np.stack(zs, 1), 1)


# ---------------------------------------------------------------- static poses

def _arm_pose(q, down_deg, elbow_deg=0.0, fwd_deg=0.0):
    """Set shoulders/elbows of pose q (24, 4): arms lowered by down_deg from the T-pose (negative
    raises them), swung forward by fwd_deg, elbows bent forward by elbow_deg."""
    d, e, f = math.radians(down_deg), math.radians(elbow_deg), math.radians(fwd_deg)
    q[16] = qmul(axis_angle([1, 0, 0], -f), axis_angle([0, 1, 0], d))
    q[17] = qmul(axis_angle([1, 0, 0], -f), axis_angle([0, 1, 0], -d))
    q[18] = axis_angle([0, 0, 1], -e)
    q[19] = axis_angle([0, 0, 1], e)
    return q


def identity_pose():
    q = np.zeros((24, 4))
    q[:, 0] = 1
    return q


HOLDS = {
    'neutral': dict(down_deg=76, elbow_deg=10, fwd_deg=4),
    'a-pose': dict(down_deg=45, elbow_deg=5),
    't-pose': dict(down_deg=0, elbow_deg=0),
    'arms-up': dict(down_deg=-68, elbow_deg=8),
    'seated': dict(down_deg=76, elbow_deg=75, fwd_deg=8),
}


def hold_pose(name, facing, t, seed=0.0):
    """Static pose with a little life (breathing sway) so it isn't a frozen image."""
    if name not in HOLDS:
        raise ValueError(f'unknown hold pose {name!r} (use {", ".join(HOLDS)})')
    t = np.atleast_1d(t)
    out = np.empty((len(t), 24, 4))
    for k, tt in enumerate(t):
        q = identity_pose()
        h = dict(HOLDS[name])
        sway = math.sin(2 * math.pi * 0.23 * tt + seed)
        # Arm drift: ±0.8° at the shoulder (~±1 cm at the wrist). It was ±2°, which with the body
        # sway moved a wrist 0.12 torso lengths peak to peak, near the game's 0.15 stillness
        # tolerance before any detector noise, so nobody's "still" hold could calibrate.
        h['down_deg'] += 0.8 * math.sin(2 * math.pi * 0.31 * tt + 1.7 + seed)
        _arm_pose(q, **h)
        if name == 'seated':
            for hip, knee in ((1, 4), (2, 5)):
                q[hip] = axis_angle([1, 0, 0], -math.pi / 2)
                q[knee] = axis_angle([1, 0, 0], math.pi / 2)
        q[0] = qmul(yaw_q(facing + math.radians(1.5) * sway), axis_angle([0, 1, 0], math.radians(1.0) * sway))
        q[3] = axis_angle([0, 1, 0], -math.radians(1.0) * sway)
        q[15] = axis_angle([1, 0, 0], math.radians(2.0) * math.sin(2 * math.pi * 0.17 * tt + seed))
        out[k] = q
    return out


# ---------------------------------------------------------------- segments

def _facing_rad(deg):
    return math.radians(deg or 0.0)


def _heading_to(d):
    return math.atan2(d[0], -d[1])


class Segment:
    kind = 'hold'
    visible = True

    def __init__(self, t0, t1):
        self.t0, self.t1 = t0, t1

    def end_spot(self, spot):
        return spot


class Offstage(Segment):
    kind = 'offstage'
    visible = False


class Hold(Segment):
    kind = 'hold'

    def __init__(self, t0, t1, spot, facing, pose, seed, sway_m=0.01):
        super().__init__(t0, t1)
        self.spot, self.facing, self.pose, self.seed = np.asarray(spot, float), facing, pose, seed
        self.sway_m = float(sway_m)

    def eval(self, t, rig):
        q = hold_pose(self.pose, self.facing, t, self.seed)
        hip = np.zeros((len(t), 3))
        hip[:, :2] = self.spot
        sway = np.sin(2 * np.pi * 0.23 * np.asarray(t) + self.seed)
        hip[:, 0] += 0.01 * sway
        # Extra fidget is upper-body lean, not a rigid translation that slides both feet.
        if self.sway_m != 0.01:
            shoulders = (rig.head[rig.idx['upperarm01.L']] + rig.head[rig.idx['upperarm01.R']]) / 2
            torso = max(0.1, float(shoulders[2] - rig.hip_rest[2]))
            for k, amount in enumerate(sway):
                q[k, 3] = qmul(axis_angle([0, 1, 0], (self.sway_m - 0.01) / torso * amount), q[k, 3])
        return q, hip, np.ones(len(t), bool)  # grounded every frame


class Walk(Segment):
    kind = 'walk'

    def __init__(self, t0, t1, a, b, seed):
        super().__init__(t0, t1)
        self.a, self.b = np.asarray(a, float), np.asarray(b, float)
        self.seed = seed
        d = self.b - self.a
        self.dist = float(np.linalg.norm(d))
        self.heading = _heading_to(d) if self.dist > 1e-6 else None
        D = max(t1 - t0, 1e-3)
        ta = min(0.45, D / 3)
        tau = np.linspace(0, D, 2001)
        v = np.clip(np.minimum(np.minimum(tau / ta, (D - tau) / ta), 1.0), 0, 1)
        v = v * v * (3 - 2 * v)
        s = np.concatenate([[0], np.cumsum((v[1:] + v[:-1]) / 2 * np.diff(tau))])
        self.vmax = self.dist / s[-1] if s[-1] > 0 else 0.0
        self._tau, self._s, self._v = tau, s * (self.vmax), v * self.vmax

    def end_spot(self, spot):
        return self.b

    def eval(self, t, rig, prev_heading=None):
        t = np.asarray(t, float)
        u = np.clip(t - self.t0, 0, self._tau[-1])
        s = np.interp(u, self._tau, self._s)
        v = np.interp(u, self._tau, self._v)
        heading = self.heading if self.heading is not None else (prev_heading or 0.0)
        dirv = (self.b - self.a) / self.dist if self.dist > 1e-6 else np.zeros(2)
        hip = np.zeros((len(t), 3))
        hip[:, :2] = self.a + s[:, None] * dirv
        leg = rig.leg_length
        vmean = max(self.vmax, 0.3)
        stride = float(np.clip(1.45 * (leg / 0.85) * math.sqrt(vmean / 1.3), 0.5, 1.6))
        phi = 2 * np.pi * s / stride + self.seed
        amp = np.clip(v / max(self.vmax, 1e-6), 0, 1) if self.vmax > 0 else np.zeros_like(v)
        th_hip = math.asin(min(0.6, stride / 4 / leg))
        q = np.empty((len(t), 24, 4))
        for k in range(len(t)):
            a = amp[k]
            qq = identity_pose()
            psi = {'L': phi[k], 'R': phi[k] + np.pi}
            for side, hip_j, knee_j, ankle_j in (('L', 1, 4, 7), ('R', 2, 5, 8)):
                p = psi[side]
                hip_a = -th_hip * math.sin(p) * a
                knee_a = math.radians(6 + 52 * max(0.0, math.cos(p - 0.35)) ** 1.6 * a)
                ank_a = -math.radians(10 * max(0.0, math.cos(p)) * a) + math.radians(6 * math.sin(p) * a)
                qq[hip_j] = axis_angle([1, 0, 0], hip_a)
                qq[knee_j] = axis_angle([1, 0, 0], knee_a)
                qq[ankle_j] = axis_angle([1, 0, 0], ank_a)
            sw = math.radians(16) * a
            _arm_pose(qq, 78, elbow_deg=14 + 10 * a, fwd_deg=0)
            qq[16] = qmul(axis_angle([1, 0, 0], sw * math.sin(psi['L'])), qq[16])
            qq[17] = qmul(axis_angle([1, 0, 0], sw * math.sin(psi['R'])), qq[17])
            pel = math.radians(5) * a * math.sin(psi['L'])
            qq[0] = qmul(yaw_q(heading - pel), axis_angle([0, 1, 0], math.radians(2.5) * a * math.cos(2 * psi['L'])))
            qq[3] = axis_angle([0, 0, 1], pel * 0.6)
            qq[9] = axis_angle([0, 0, 1], pel * 0.6)
            qq[3] = qmul(axis_angle([1, 0, 0], -math.radians(3) * a), qq[3])  # slight forward lean
            q[k] = qq
        return q, hip, np.ones(len(t), bool)


class Dance(Segment):
    kind = 'dance'

    def __init__(self, t0, t1, spot, facing, seg, travel, scale):
        super().__init__(t0, t1)
        self.clip = smpl.load_clip(seg['clip'], mirror=bool(seg.get('mirror', False)))
        self.speed = float(seg.get('speed', 1.0))
        self.clip_start = float(seg.get('clip_start_s', 0.0))
        self.spot = np.asarray(spot, float)
        self.travel = float(travel)
        self.scale = scale
        n = self.clip['n']
        fps = self.clip['fps']
        f0 = int(np.clip(self.clip_start * fps, 0, n - 1))
        f1 = int(np.clip((self.clip_start + (t1 - t0) * self.speed) * fps, f0 + 1, n))
        if (self.clip_start + (t1 - t0) * self.speed) * fps > n:
            print(f'[motion] warning: {seg["clip"]} is {n / fps:.1f} s long; holding its last frame')
        q, pel = self.clip['q'][f0:f1], self.clip['pelvis'][f0:f1]
        hipw = pel + qrot(q[:, 0], np.broadcast_to(HIP_MID_SMPL, pel.shape))
        hd = heading_of(q[:, 0])
        mean_heading = math.atan2(np.mean(np.sin(hd)), np.mean(np.cos(hd)))
        self.yaw = facing - mean_heading
        self.qyaw = yaw_q(self.yaw)
        self.center = hipw.mean(0)

    def _sample(self, t):
        fps = self.clip['fps']
        n = self.clip['n']
        fi = np.clip((self.clip_start + (np.asarray(t) - self.t0) * self.speed) * fps, 0, n - 1)
        i0 = np.floor(fi).astype(int)
        i1 = np.minimum(i0 + 1, n - 1)
        w = fi - i0
        q = qslerp(self.clip['q'][i0], self.clip['q'][i1], np.broadcast_to(w[:, None], (len(w), 24)))
        pel = self.clip['pelvis'][i0] * (1 - w)[:, None] + self.clip['pelvis'][i1] * w[:, None]
        return q, pel

    def floor_offset(self, rig, contacts):
        """Height offset for this clip. With AIST++ keypoints: on the frames where the
        triangulated ankles are at their lowest (within 1 cm of the clip's 5th percentile:
        a foot flat on the floor), the rig's lower ankle sits at its standing height above the
        soles. Without keypoints: the lowest contact is on the floor on the 3rd-percentile frame."""
        q = self.clip['q'][::3]
        pel = self.clip['pelvis'][::3]
        hipw = pel + qrot(q[:, 0], np.broadcast_to(HIP_MID_SMPL, pel.shape))
        hip = np.zeros_like(hipw)
        hip[:, 2] = hipw[:, 2] * self.scale
        sol = rig.solve(q, hip)
        kp = self.clip['kp']
        if kp is None:
            return -float(np.percentile(rig.min_contact_z(sol, contacts), 3))
        ka = kp[::3][:, [15, 16], 2].min(1)
        flat = ka < np.percentile(ka, 5) + 0.01
        ours = np.minimum(sol['heads']['foot.L'][:, 2], sol['heads']['foot.R'][:, 2])
        sole = min(p[2] for b, p, r in contacts if r == 0)
        stand = rig.head[rig.idx['foot.L']][2] - sole
        return float(stand - np.median(ours[flat]))

    def eval(self, t, rig):
        q, pel = self._sample(t)
        hipw = pel + qrot(q[:, 0], np.broadcast_to(HIP_MID_SMPL, pel.shape))
        q = q.copy()
        q[:, 0] = qmul(np.broadcast_to(self.qyaw, (len(t), 4)), q[:, 0])
        off = qrot(np.broadcast_to(self.qyaw, (len(t), 4)), hipw - self.center)
        hip = np.empty((len(t), 3))
        hip[:, :2] = self.spot + off[:, :2] * self.scale * self.travel
        hip[:, 2] = hipw[:, 2] * self.scale  # grounded later by a per-segment offset
        return q, hip, np.zeros(len(t), bool)


def build_segments(pspec, rig, seed):
    spot = np.asarray([pspec['place']['x'], pspec['place']['y']], float)
    facing = _facing_rad(pspec['place'].get('facing_deg', 0))
    segs = []
    t = 0.0
    tl = pspec['timeline']
    for k, s in enumerate(tl):
        dur = s.get('duration_s')
        if dur is None:
            dur = 1e9 if k == len(tl) - 1 else 0.0
        t1 = t + float(dur)
        typ = s['type']
        seg_facing = _facing_rad(s['facing_deg']) if 'facing_deg' in s else facing
        if typ == 'offstage':
            seg = Offstage(t, t1)
        elif typ == 'hold':
            seg = Hold(t, t1, spot, seg_facing, s.get('pose', 'neutral'), seed + k, s.get('sway_m', 0.01))
        elif typ == 'walk':
            a = np.asarray(s['from'], float) if 'from' in s else spot
            b = np.asarray(s['to'], float) if 'to' in s else np.asarray([pspec['place']['x'], pspec['place']['y']], float)
            seg = Walk(t, t1, a, b, seed + k)
        elif typ == 'dance':
            seg = Dance(t, t1, spot, seg_facing, s, pspec.get('travel', 0.3), rig.scale)
        else:
            raise ValueError(f'unknown timeline segment type {typ!r}')
        spot = seg.end_spot(spot)
        segs.append(seg)
        t = t1
    return segs


def _smoothstep(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def evaluate_person(pspec, rig, contacts, fps, n_frames, seed=0):
    """Per-frame poses for one person.

    Returns dict: q (F, 24, 4), hip (F, 3), solve (RigModel.solve output), phase (F,) segment
    type names, visible (F,) bool.
    """
    segs = build_segments(pspec, rig, seed)
    times = np.arange(n_frames) / fps
    F = n_frames
    q = np.tile(identity_pose(), (F, 1, 1))
    hip = np.zeros((F, 3))
    grounded = np.ones(F, bool)
    phase = np.array(['offstage'] * F, dtype=object)
    visible = np.zeros(F, bool)
    seg_of = np.full(F, -1)
    for k, s in enumerate(segs):
        sel = (times >= s.t0 - 1e-9) & (times < s.t1 - 1e-9)
        seg_of[sel] = k
    seg_of[seg_of < 0] = len(segs) - 1  # after the last segment: hold it

    def seg_eval(k, t, prev_heading=None):
        s = segs[k]
        if isinstance(s, Walk):
            return s.eval(t, rig, prev_heading)
        return s.eval(t, rig)

    # Raw evaluation per segment, with dance grounding offsets.
    headings = {}
    for k, s in enumerate(segs):
        sel = seg_of == k
        phase[sel] = s.kind
        if not s.visible:
            continue
        visible[sel] = True
        if not sel.any():
            continue
        qk, hk, gk = seg_eval(k, times[sel], headings.get(k - 1))
        if isinstance(s, Dance):
            # One height offset per clip (keeps jumps and relevés), from the clip's flat-foot
            # frames (see Dance.floor_offset). AIST++'s SMPL ankle heights track its triangulated
            # keypoints to ~1 cm (std), so the whole clip gives a stable floor where a short,
            # jumpy segment alone would not.
            s.z_offset = s.floor_offset(rig, contacts)
            hk = hk.copy()
            hk[:, 2] += s.z_offset
        q[sel], hip[sel], grounded[sel] = qk, hk, gk
        headings[k] = float(heading_of(qk[-1, 0]))

    def seg_eval_full(k, t):
        q_, h_, g_ = seg_eval(k, t, headings.get(k - 1))
        if isinstance(segs[k], Dance):
            h_ = h_.copy()
            h_[:, 2] += getattr(segs[k], 'z_offset', 0.0)
        return q_, h_, g_

    # Blends at boundaries between visible segments.
    for k in range(1, len(segs)):
        A, B = segs[k - 1], segs[k]
        if not (A.visible and B.visible):
            continue
        T = B.t0
        qa_end, _, _ = seg_eval_full(k - 1, np.array([max(A.t0, T - 1e-3)]))
        qb_start, _, _ = seg_eval_full(k, np.array([T]))
        dyaw = abs(math.remainder(float(heading_of(qa_end[0, 0]) - heading_of(qb_start[0, 0])), 2 * math.pi))
        h = (0.3 + 0.5 * dyaw / math.pi) / 2
        h = min(h, (A.t1 - A.t0) / 2, (B.t1 - B.t0) / 2 if B.t1 < 1e8 else h)
        sel = (times >= T - h) & (times < T + h)
        if not sel.any():
            continue
        tt = times[sel]
        qa, ha, ga = seg_eval_full(k - 1, tt)
        qb, hb, gb = seg_eval_full(k, tt)
        w = _smoothstep((tt - (T - h)) / (2 * h))
        q[sel] = qslerp(qa, qb, np.broadcast_to(w[:, None], (len(w), 24)))
        hip[sel] = ha * (1 - w)[:, None] + hb * w[:, None]
        grounded[sel] = ga | gb

    # Feet on the floor: grounded frames put their lowest contact exactly on it; others (dance)
    # only never go through it.
    sol = rig.solve(q, hip)
    mz = rig.min_contact_z(sol, contacts)
    dz = np.where(grounded, -mz, np.maximum(0, -mz))
    hip[:, 2] += dz
    sol = rig.solve(q, hip)
    return {'q': q, 'hip': hip, 'solve': sol, 'phase': phase, 'visible': visible, 'segments': segs}


# ---------------------------------------------------------------- Blender side

def rig_model_from_blender(rig):
    bones = []
    order = []

    def visit(b):
        order.append(b)
        for c in b.children:
            visit(c)
    for b in rig.data.bones:
        if b.parent is None:
            visit(b)
    for b in order:
        m = b.matrix_local
        bones.append((b.name, b.parent.name if b.parent else None, np.array(b.head_local),
                      np.array([[m[i][j] for j in range(3)] for i in range(3)])))
    return RigModel(bones)


def _fcurves(action, datablock, path, n):
    return [action.fcurve_ensure_for_datablock(datablock, path, index=i) for i in range(n)]


def _set_keys(fc, frames, values, interpolation='LINEAR'):
    kp = fc.keyframe_points
    kp.add(len(frames))
    co = np.empty(2 * len(frames), np.float32)
    co[0::2] = frames
    co[1::2] = values
    kp.foreach_set('co', co)
    kp.foreach_set('interpolation', np.full(len(frames), _INTERP[interpolation], np.int32))
    fc.update()


_INTERP = {'CONSTANT': 0, 'LINEAR': 1}


def apply_to_rig(rig, person_objects, result):
    import bpy
    sol = result['solve']
    F = len(result['hip'])
    frames = np.arange(1, F + 1, dtype=np.float32)
    rig.animation_data_create()
    act = bpy.data.actions.new(rig.name + '.tb')
    rig.animation_data.action = act
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    for name, qs in sol['basis'].items():
        qs = qs.copy()
        for i in range(1, F):  # keep consecutive quaternions in one hemisphere
            if np.dot(qs[i], qs[i - 1]) < 0:
                qs[i] = -qs[i]
        for i, fc in enumerate(_fcurves(act, rig, f'pose.bones["{name}"].rotation_quaternion', 4)):
            _set_keys(fc, frames, qs[:, i])
    for i, fc in enumerate(_fcurves(act, rig, 'pose.bones["root"].location', 3)):
        _set_keys(fc, frames, sol['root_loc'][:, i])
    vis = result['visible']
    hidden = (~vis).astype(np.float32)
    for ob in person_objects:
        ob.animation_data_create()
        a = bpy.data.actions.new(ob.name + '.vis')
        ob.animation_data.action = a
        for path in ('hide_render', 'hide_viewport'):
            fc = a.fcurve_ensure_for_datablock(ob, path, index=0)
            # Only key changes (constant interpolation).
            keep = np.concatenate([[True], hidden[1:] != hidden[:-1]])
            _set_keys(fc, frames[keep], hidden[keep], 'CONSTANT')
