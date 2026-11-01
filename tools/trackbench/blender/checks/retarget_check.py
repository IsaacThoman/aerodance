"""Check the AIST++ -> MPFB retarget against AIST++'s own data.

blender -b -P tools/trackbench/blender/checks/retarget_check.py -- [--clips N] [--every K] [--json out.json]

Poses the real Blender rig (pose bones set from RigModel.solve, evaluated by Blender) and compares
3D limb directions with (a) the SMPL skeleton driven by the same poses (isolates retarget error)
and (b) AIST++ keypoints3d (triangulated COCO joints; includes SMPL-fit and joint-definition
differences). Also checks mirroring (mirrored retarget vs mirrored keypoints) and that the NumPy
forward kinematics matches Blender's.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
import bpy  # noqa
import numpy as np  # noqa
import random  # noqa
import smpl  # noqa
import motion  # noqa
import humans  # noqa

LIMBS = {  # name: (pose33 a, b) using MPFB joint bones; SMPL joints; COCO
    'l_upperarm': ('upperarm01.L', 'lowerarm01.L', 16, 18, 5, 7),
    'l_forearm': ('lowerarm01.L', 'wrist.L', 18, 20, 7, 9),
    'r_upperarm': ('upperarm01.R', 'lowerarm01.R', 17, 19, 6, 8),
    'r_forearm': ('lowerarm01.R', 'wrist.R', 19, 21, 8, 10),
    'l_thigh': ('upperleg01.L', 'lowerleg01.L', 1, 4, 11, 13),
    'l_shin': ('lowerleg01.L', 'foot.L', 4, 7, 13, 15),
    'r_thigh': ('upperleg01.R', 'lowerleg01.R', 2, 5, 12, 14),
    'r_shin': ('lowerleg01.R', 'foot.R', 5, 8, 14, 16),
    'shoulders': ('upperarm01.R', 'upperarm01.L', 17, 16, 6, 5),
    'hips': ('upperleg01.R', 'upperleg01.L', 2, 1, 12, 11),
}


def ang(u, v):
    c = (u * v).sum(-1) / np.linalg.norm(u, axis=-1) / np.linalg.norm(v, axis=-1)
    return np.degrees(np.arccos(np.clip(c, -1, 1)))


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--every', type=int, default=12)
    ap.add_argument('--json')
    ap.add_argument('--body', default='{"gender": 1.0, "age": 0.5}')
    a = ap.parse_args(argv)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    p = humans.build_person({'id': 'p1', 'body': json.loads(a.body), 'outfit': {'clothes': []}}, 0, random.Random(0))
    rig = p.rig
    rm = motion.rig_model_from_blender(rig)
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    names = sorted(os.listdir(os.path.join(smpl.AIST_DIR, 'motions')))
    by_genre = {}
    for n in names:
        by_genre.setdefault(n[:3], []).append(n[:-4])
    clips = [v[len(v) // 2] for k, v in sorted(by_genre.items())]
    res = {'smpl': {}, 'kp': {}, 'kp_mirror': {}}
    fk_err = []
    for clip in clips:
        for mirror in (False, True):
            c = smpl.load_clip(clip, mirror=mirror)
            idx = np.arange(0, c['n'], a.every)
            q = c['q'][idx]
            pel = c['pelvis'][idx]
            hip = (pel + smpl.qrot(q[:, 0], np.broadcast_to(motion.HIP_MID_SMPL, pel.shape))) * rm.scale
            sol = rm.solve(q, hip)
            J = smpl.joints_stage(q, pel)
            kp = c['kp'][idx] if c['kp'] is not None else None
            heads = {}
            for i in range(len(idx)):
                for n_, qs in sol['basis'].items():
                    rig.pose.bones[n_].rotation_quaternion = qs[i]
                rig.pose.bones['root'].location = sol['root_loc'][i]
                bpy.context.view_layer.update()
                for b in {x for lim in LIMBS.values() for x in lim[:2]}:
                    if True:
                        heads.setdefault(b, []).append(np.array(rig.matrix_world @ rig.pose.bones[b].head))
                for b in ('upperarm01.L', 'wrist.R', 'foot.L', 'head'):
                    fk_err.append(np.linalg.norm(np.array(rig.pose.bones[b].head) - sol['heads'][b][i]))
            heads = {k: np.array(v) for k, v in heads.items()}
            for lname, (ba, bb, sa, sb, ca, cb) in LIMBS.items():
                u = heads[bb] - heads[ba]
                if not mirror:
                    res['smpl'].setdefault(lname, []).extend(ang(u, J[:, sb] - J[:, sa]).tolist())
                if kp is not None:
                    key = 'kp_mirror' if mirror else 'kp'
                    res[key].setdefault(lname, []).extend(ang(u, kp[:, cb] - kp[:, ca]).tolist())
        print('done', clip, flush=True)
    summary = {}
    for ref, d in res.items():
        summary[ref] = {l: {'median': round(float(np.median(v)), 2), 'p90': round(float(np.percentile(v, 90)), 2),
                            'max': round(float(np.max(v)), 1), 'n': len(v)} for l, v in d.items()}
    summary['fk_numpy_vs_blender_max_m'] = float(np.max(fk_err))
    summary['clips'] = clips
    print('RESULT', json.dumps(summary, indent=1))
    if a.json:
        json.dump(summary, open(a.json, 'w'), indent=1)


main()
