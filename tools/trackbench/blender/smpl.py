"""SMPL motion (AIST++) and quaternion helpers. NumPy only, so it runs in Blender and the venv.

Conventions: quaternions are (w, x, y, z) arrays. SMPL's frame is y up, the body facing +z, its
left at +x. The stage (Blender) frame is z up, a person at rest facing -y (the camera), their
left at +x. ``C`` maps SMPL vectors to stage vectors; a rotation R becomes C R C^T.
"""
import os
import pickle
import numpy as np

DATA_ROOT = os.environ.get('TRACKBENCH_DATA', '/Volumes/development/aerodance-trackbench')
AIST_DIR = os.path.join(DATA_ROOT, 'downloads', 'aist')
AIST_FPS = 60.0

PARENTS = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 20, 21]
NAMES = ['pelvis', 'l_hip', 'r_hip', 'spine1', 'l_knee', 'r_knee', 'spine2', 'l_ankle', 'r_ankle',
         'spine3', 'l_foot', 'r_foot', 'neck', 'l_collar', 'r_collar', 'head', 'l_shoulder',
         'r_shoulder', 'l_elbow', 'r_elbow', 'l_wrist', 'r_wrist', 'l_hand', 'r_hand']
# Left/right partner of each joint (for mirroring).
MIRROR = [0, 2, 1, 3, 5, 4, 6, 8, 7, 9, 11, 10, 12, 14, 13, 15, 17, 16, 19, 18, 21, 20, 23, 22]

# SMPL neutral template joint positions (J_regressor @ v_template, metres, SMPL frame). The
# limbs' canonical (T-pose) directions come from these; AIST++ fits only a global scale, no
# betas, so its dancers have exactly this skeleton.
J_REST = np.array([
    [-0.0018, -0.2233, 0.0282], [0.0695, -0.3142, 0.0239], [-0.0677, -0.3147, 0.0215],
    [-0.0025, -0.1089, 0.0019], [0.1040, -0.6754, 0.0435], [-0.1066, -0.6798, 0.0370],
    [0.0054, 0.0198, 0.0262], [0.0880, -1.0705, -0.0221], [-0.0857, -1.0691, -0.0242],
    [0.0013, 0.0752, 0.0287], [0.1192, -1.1295, 0.0997], [-0.1188, -1.1335, 0.1030],
    [-0.0013, 0.2884, -0.0151], [0.0771, 0.1928, 0.0026], [-0.0762, 0.1901, -0.0051],
    [0.0058, 0.3768, 0.0367], [0.1782, 0.2224, -0.0119], [-0.1753, 0.2252, -0.0168],
    [0.4317, 0.2133, -0.0447], [-0.4304, 0.2125, -0.0401], [0.6876, 0.2260, -0.0533],
    [-0.6889, 0.2236, -0.0530], [0.7738, 0.2195, -0.0687], [-0.7742, 0.2193, -0.0684]])

C = np.array([[1.0, 0, 0], [0, 0, -1.0], [0, 1.0, 0]])  # SMPL -> stage

# COCO-17 (AIST++ keypoints3d) indices.
COCO = {'nose': 0, 'l_eye': 1, 'r_eye': 2, 'l_ear': 3, 'r_ear': 4, 'l_shoulder': 5, 'r_shoulder': 6,
        'l_elbow': 7, 'r_elbow': 8, 'l_wrist': 9, 'r_wrist': 10, 'l_hip': 11, 'r_hip': 12,
        'l_knee': 13, 'r_knee': 14, 'l_ankle': 15, 'r_ankle': 16}


def smpl_leg_length():
    j = J_REST
    return (np.linalg.norm(j[4] - j[1]) + np.linalg.norm(j[7] - j[4]) +
            np.linalg.norm(j[5] - j[2]) + np.linalg.norm(j[8] - j[5])) / 2


def to_stage(v):
    return np.asarray(v) @ C.T


# ---------------------------------------------------------------- quaternions (w, x, y, z)

def qnorm(q):
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def qmul(a, b):
    aw, ax, ay, az = np.moveaxis(a, -1, 0)
    bw, bx, by, bz = np.moveaxis(b, -1, 0)
    return np.stack([aw * bw - ax * bx - ay * by - az * bz,
                     aw * bx + ax * bw + ay * bz - az * by,
                     aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw], -1)


def qconj(q):
    return q * np.array([1.0, -1, -1, -1])


def qrot(q, v):
    """Rotate vectors v (..., 3) by quaternions q (..., 4)."""
    qv = np.concatenate([np.zeros(v.shape[:-1] + (1,)), v], -1)
    return qmul(qmul(q, qv), qconj(q))[..., 1:]


def aa2q(aa):
    aa = np.asarray(aa, float)
    ang = np.linalg.norm(aa, axis=-1, keepdims=True)
    half = ang / 2
    with np.errstate(invalid='ignore', divide='ignore'):
        axis = np.where(ang > 1e-10, aa / np.maximum(ang, 1e-12), 0)
    return np.concatenate([np.cos(half), axis * np.sin(half)], -1)


def axis_angle(axis, ang):
    axis = np.asarray(axis, float)
    axis = axis / np.linalg.norm(axis)
    return np.concatenate([[np.cos(ang / 2)], axis * np.sin(ang / 2)])


def q2m(q):
    w, x, y, z = np.moveaxis(qnorm(q), -1, 0)
    return np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], -1),
        np.stack([2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], -1),
        np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], -1)], -2)


def m2q(m):
    """Rotation matrix (3, 3) -> quaternion (robust branch selection)."""
    m = np.asarray(m, float)
    t = m[0, 0] + m[1, 1] + m[2, 2]
    if t > 0:
        s = np.sqrt(t + 1.0) * 2
        q = [0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [(m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s]
    elif m[1, 1] > m[2, 2]:
        s = np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s]
    else:
        s = np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s]
    return qnorm(np.array(q))


def qslerp(a, b, t):
    """Slerp between quaternion arrays a and b (..., 4) with weight t (scalar or (...,))."""
    t = np.asarray(t, float)[..., None] if np.ndim(t) else t
    d = np.sum(a * b, -1, keepdims=True)
    b = np.where(d < 0, -b, b)
    d = np.abs(d)
    lin = d > 0.9995
    th = np.arccos(np.clip(d, -1, 1))
    s = np.sin(th)
    with np.errstate(invalid='ignore', divide='ignore'):
        wa = np.where(lin, 1 - t, np.sin((1 - t) * th) / np.where(s == 0, 1, s))
        wb = np.where(lin, t, np.sin(t * th) / np.where(s == 0, 1, s))
    return qnorm(wa * a + wb * b)


def yaw_q(rad):
    return axis_angle([0, 0, 1], rad)


def heading_of(q_root):
    """Yaw (radians, stage frame) of a root orientation: forward is -y rotated about +z."""
    f = qrot(q_root, np.array([0.0, -1, 0]))
    return np.arctan2(f[..., 0], -f[..., 1])


# ---------------------------------------------------------------- AIST++ clips

_clip_cache = {}


def load_clip(name, mirror=False):
    """An AIST++ motion as stage-frame quaternions.

    Returns dict: q (N, 24, 4) with q[:, 0] the global root orientation in the stage frame and
    q[:, j>0] SMPL local rotations conjugated into the stage frame; pelvis (N, 3) the pelvis
    joint in stage coordinates (SMPL units, AIST world origin); kp (N, 17, 3) keypoints3d in the
    same frame and units (or None); fps.
    """
    key = (name, mirror)
    if key in _clip_cache:
        return _clip_cache[key]
    path = os.path.join(AIST_DIR, 'motions', name + '.pkl')
    with open(path, 'rb') as f:
        m = pickle.load(f)
    scale = float(np.asarray(m['smpl_scaling']).reshape(-1)[0])
    poses = np.asarray(m['smpl_poses'], float).reshape(-1, 24, 3)
    trans = np.asarray(m['smpl_trans'], float) / scale
    kp = None
    kpath = os.path.join(AIST_DIR, 'keypoints3d', name + '.pkl')
    if os.path.exists(kpath):
        with open(kpath, 'rb') as f:
            k = pickle.load(f)
        kp = np.asarray(k.get('keypoints3d_optim', k.get('keypoints3d')), float) / scale
        if kp.shape[0] != poses.shape[0]:
            kp = None
    if mirror:
        # Reflect across the SMPL x = 0 plane: swap sides, negate the y/z axis-angle parts.
        poses = poses[:, MIRROR] * np.array([1.0, -1, -1])
        trans = trans * np.array([-1.0, 1, 1])
        if kp is not None:
            swap = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15]
            kp = kp[:, swap] * np.array([-1.0, 1, 1])
    q = aa2q(poses)
    qc = m2q(C)
    q = qmul(qmul(qc[None, None], q), qconj(qc)[None, None])  # C R C^T
    # Pelvis world = J0 + trans (SMPL rotates the root about J0). Mirroring J0 is exact enough
    # (the template is symmetric to a few mm).
    j0 = J_REST[0] * (np.array([-1.0, 1, 1]) if mirror else 1)
    pelvis = to_stage(trans + j0)
    out = {'q': q, 'pelvis': pelvis, 'kp': None if kp is None else to_stage(kp), 'fps': AIST_FPS,
           'n': q.shape[0], 'name': name}
    _clip_cache[key] = out
    return out


def fk_stage(q):
    """Global stage-frame rotations (N, 24, 4) from load_clip's q."""
    g = np.empty_like(q)
    for j in range(24):
        g[:, j] = q[:, j] if PARENTS[j] < 0 else qmul(g[:, PARENTS[j]], q[:, j])
    return g


def joints_stage(q, pelvis):
    """SMPL joint positions (N, 24, 3) in stage coordinates (SMPL units)."""
    g = fk_stage(q)
    jr = to_stage(J_REST)
    p = np.empty(q.shape[:2] + (3,))
    p[:, 0] = pelvis
    for j in range(1, 24):
        par = PARENTS[j]
        p[:, j] = p[:, par] + qrot(g[:, par], np.broadcast_to(jr[j] - jr[par], (q.shape[0], 3)))
    return p
