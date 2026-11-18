"""Table-tennis motion for a player facing the camera (the minigame's first-person ping-pong).

A `pingpong` timeline segment is a ready stance with strokes and serves in it. It is procedural:
no licence-clean full-body racket-stroke motion capture exists (CMU has none, AMASS's licence is
non-commercial, the published table-tennis mocap sets aren't downloadable), so strokes are built
the way an animator keys them, then solved onto the rig:

- **Channels** keyed at a stroke's ready start, backswing end, contact, follow-through end and
  ready again: torso yaw / forward lean / side lean (shared over pelvis and the three spine
  joints, the head counter-turning to keep the eyes on the screen), knee bend (hip drop), weight
  shift (hip over one foot), foot steps (wide reaches lift and replant a foot), and for each arm a
  wrist target in the chest's frame relative to its shoulder, an elbow hint, the palm's facing and
  the wrist's flex and deviation. Keys are joined by cubic Hermite splines with Catmull-Rom
  tangents (zero at the ready keys), so the hand keeps moving through the backswing's reversal
  and is fastest at contact; slow sine noise keeps the ready stance alive.
- **Solving**: the torso pose goes through the rig model (`motion.RigModel`) for the shoulder and
  hip joint positions; two-bone IK with the MPFB bone lengths places elbows and knees (feet
  planted flat, knees over the toes), the forearm is twisted so the palm faces the keyed way
  (pronation), and the wrist bends the rest. Everything is written for a right-hander at the
  origin facing the camera and mirrored for a left-hander, then turned to `facing_deg` and moved
  to the player's spot.
- **Speed**: each stroke's forward swing is retimed (a few iterations) until the paddle wrist's
  peak speed in the stage frame is the stroke's `speed_mps`.
- **Fingers**: the paddle hand is closed round a handle (a shakehand grip: middle, ring and
  little fingers wrapped, index along the blade's back, thumb on its face), looser when empty
  handed; the free hand is relaxed, and opens palm up when it's raised to serve.

Segment spec (all optional but `duration_s`):

    {"type": "pingpong", "duration_s": 18, "hand": "right",
     "events": [{"t_s": 0.4, "kind": "serve", "speed_mps": 3.5}, {"t_s": 3.0, "kind": "forehand", "speed_mps": 5}],
     "auto": {"start_s": 0.4, "speed_mps": [2.5, 6], "gap_s": [0.15, 1.1], "mix": {"forehand": 3, "backhand": 2},
              "rally": [3, 7], "pause_s": [0.8, 2.0]},
     "stance_m": 0.55, "liveliness": 1.0}

`events` (times are when the stroke leaves the ready stance, relative to the segment) or `auto`
(a seeded rally: a serve, `rally` strokes from `mix` at irregular gaps, a pause, a serve again).
Kinds: forehand, backhand, push, block, loop, wide_forehand, wide_backhand, low, serve.
"""
import math
import random

import numpy as np

import smpl
from smpl import qmul, q2m, axis_angle, yaw_q

WRIST_MAX_DEG = 60.0  # the most the wrist bends to turn the palm
REF_ARM = 0.55  # arm length (shoulder to wrist joint, m) the templates are written for
KINDS = ('forehand', 'backhand', 'push', 'block', 'loop', 'wide_forehand', 'wide_backhand', 'low', 'serve')

# ---------------------------------------------------------------- templates (right-hander)
# Player coordinates: r = the player's right, f = forward (towards the camera), u = up.
# P / Q: paddle (right) / free (left) wrist relative to its own shoulder, in the chest's frame,
# metres for a REF_ARM arm. E / F: elbow hints (directions). N / fN: palm normals (chest frame;
# a shakehand blade's forehand rubber faces where the palm faces). Angles in degrees.

READY = dict(
    yaw=0.0, pitch=17.0, roll=0.0, crouch=0.12, shift=(0.0, 0.02),
    P=(-0.03, 0.34, -0.17), E=(0.5, -0.3, -1.0), N=(-0.75, 0.6, -0.1), flex=0.0, dev=20.0,
    Q=(-0.02, 0.28, -0.22), F=(-0.5, -0.3, -1.0), fN=(0.55, 0.1, -0.8), fflex=12.0, fdev=0.0,
    footR=(0.0, 0.0, 0.0), footL=(0.0, 0.0, 0.0), fopen=0.0,
)

# Each template: keys as (name, overrides). Times come from the stroke's timing: 'back' ends the
# backswing, 'contact' is the fastest point, 'follow' ends the follow-through; 'mid*' keys sit at
# fractions of their phase (see _key_times).
TEMPLATES = {
    'forehand': dict(T=(0.36, 0.17, 0.20, 0.45), keys=[
        ('back', dict(yaw=-35, pitch=19, roll=3, crouch=0.15, shift=(0.07, 0.0), P=(0.22, 0.08, -0.33),
                      E=(0.7, -0.5, -0.6), N=(0.35, 0.55, -0.6), flex=-15, dev=15, Q=(0.18, 0.30, -0.22))),
        ('contact', dict(yaw=-5, pitch=18, crouch=0.13, shift=(0.02, 0.02), P=(0.15, 0.40, -0.20),
                         E=(0.5, -0.1, -1.0), N=(0.05, 0.85, -0.5), flex=-5, dev=10, Q=(0.02, 0.26, -0.28))),
        ('follow', dict(yaw=30, pitch=15, roll=-3, crouch=0.11, shift=(-0.06, 0.03), P=(-0.28, 0.30, 0.05),
                        E=(0.3, 0.6, -0.6), N=(-0.6, 0.35, -0.7), flex=10, dev=5, Q=(-0.10, 0.12, -0.30))),
    ]),
    'backhand': dict(T=(0.32, 0.16, 0.18, 0.40), keys=[
        ('back', dict(yaw=18, pitch=20, crouch=0.14, shift=(-0.03, 0.0), P=(-0.30, 0.20, -0.28),
                      E=(1.0, 0.5, -0.3), N=(0.3, -0.7, 0.5), flex=35, dev=10, Q=(0.12, 0.20, -0.33))),
        ('contact', dict(yaw=2, pitch=18, crouch=0.13, P=(-0.12, 0.42, -0.17), E=(1.0, 0.5, -0.3),
                         N=(0.1, -0.85, 0.45), flex=10, dev=10)),
        ('follow', dict(yaw=-12, pitch=16, crouch=0.12, shift=(0.03, 0.02), P=(0.12, 0.45, -0.02),
                        E=(1.0, 0.2, -0.4), N=(-0.2, -0.6, 0.7), flex=-20, dev=5, Q=(0.05, 0.24, -0.30))),
    ]),
    'push': dict(T=(0.30, 0.20, 0.18, 0.35), keys=[
        ('back', dict(pitch=19, P=(-0.12, 0.25, -0.18), E=(1.0, 0.3, -0.6), N=(0.0, -0.7, -0.7), flex=15)),
        ('contact', dict(pitch=20, crouch=0.14, P=(-0.08, 0.40, -0.28), E=(1.0, 0.3, -0.6), N=(0.0, -0.7, -0.7), flex=5)),
        ('follow', dict(pitch=20, crouch=0.14, P=(-0.05, 0.48, -0.33), E=(0.9, 0.3, -0.7), N=(0.0, -0.6, -0.8), flex=0)),
    ]),
    'block': dict(T=(0.22, 0.14, 0.12, 0.35), keys=[
        ('back', dict(P=(-0.10, 0.34, -0.20), E=(1.0, 0.4, -0.5), N=(0.1, -0.9, 0.4), flex=10)),
        ('contact', dict(crouch=0.13, P=(-0.08, 0.43, -0.18), E=(1.0, 0.4, -0.5), N=(0.1, -0.9, 0.4), flex=8)),
        ('follow', dict(crouch=0.13, P=(-0.07, 0.46, -0.17), E=(1.0, 0.4, -0.5), N=(0.1, -0.9, 0.4), flex=5)),
    ]),
    'loop': dict(T=(0.45, 0.20, 0.25, 0.50), keys=[
        ('back', dict(yaw=-50, pitch=25, roll=6, crouch=0.21, shift=(0.10, -0.02), P=(0.25, 0.02, -0.43),
                      E=(0.6, -0.6, -0.8), N=(0.3, 0.45, -0.85), flex=-15, dev=0, Q=(0.20, 0.32, -0.15))),
        ('contact', dict(yaw=-10, pitch=20, roll=2, crouch=0.16, shift=(0.03, 0.02), P=(0.15, 0.38, -0.25),
                         E=(0.5, -0.2, -1.0), N=(0.0, 0.7, -0.7), flex=-5, dev=5, Q=(0.03, 0.25, -0.25))),
        ('follow', dict(yaw=40, pitch=11, roll=-4, crouch=0.08, shift=(-0.08, 0.03), P=(-0.22, 0.20, 0.22),
                        E=(0.4, 0.5, -0.3), N=(-0.7, 0.3, -0.6), flex=10, dev=0, Q=(-0.12, 0.08, -0.28))),
    ]),
    'wide_forehand': dict(T=(0.42, 0.18, 0.20, 0.55), keys=[
        ('back', dict(yaw=-40, pitch=21, roll=5, crouch=0.17, shift=(0.12, 0.0), P=(0.25, 0.05, -0.33),
                      E=(0.7, -0.5, -0.6), N=(0.35, 0.55, -0.6), flex=-15, dev=10, footR=(0.14, 0.01, 0.07),
                      Q=(0.20, 0.30, -0.20))),
        ('contact', dict(yaw=-8, pitch=21, roll=6, crouch=0.19, shift=(0.20, 0.03), P=(0.33, 0.33, -0.27),
                         E=(0.6, -0.1, -1.0), N=(0.1, 0.85, -0.5), flex=-5, dev=5, footR=(0.28, 0.04, 0.0),
                         Q=(0.06, 0.25, -0.25))),
        ('follow', dict(yaw=25, pitch=18, roll=2, crouch=0.17, shift=(0.14, 0.03), P=(-0.20, 0.32, 0.0),
                        E=(0.3, 0.6, -0.6), N=(-0.6, 0.35, -0.7), flex=10, footR=(0.28, 0.04, 0.0),
                        Q=(-0.08, 0.14, -0.30))),
        ('mid_recover', dict(yaw=8, crouch=0.14, shift=(0.07, 0.02), footR=(0.14, 0.02, 0.06))),
    ]),
    'wide_backhand': dict(T=(0.40, 0.17, 0.18, 0.55), keys=[
        ('back', dict(yaw=30, pitch=21, roll=-5, crouch=0.17, shift=(-0.12, 0.0), P=(-0.34, 0.18, -0.28),
                      E=(1.0, 0.5, -0.3), N=(0.3, -0.7, 0.5), flex=35, dev=10, footL=(-0.14, 0.01, 0.07),
                      Q=(0.05, 0.15, -0.35))),
        ('contact', dict(yaw=22, pitch=21, roll=-6, crouch=0.19, shift=(-0.20, 0.03), P=(-0.36, 0.33, -0.20),
                         E=(1.0, 0.5, -0.3), N=(0.1, -0.85, 0.45), flex=10, dev=10, footL=(-0.28, 0.04, 0.0))),
        ('follow', dict(yaw=5, pitch=19, roll=-3, crouch=0.17, shift=(-0.14, 0.03), P=(-0.05, 0.46, -0.05),
                        E=(1.0, 0.2, -0.4), N=(-0.2, -0.6, 0.7), flex=-20, footL=(-0.28, 0.04, 0.0))),
        ('mid_recover', dict(yaw=3, crouch=0.14, shift=(-0.07, 0.02), footL=(-0.14, 0.02, 0.06))),
    ]),
    'low': dict(T=(0.38, 0.18, 0.20, 0.50), keys=[
        ('back', dict(yaw=-20, pitch=29, crouch=0.24, shift=(0.04, 0.02), P=(0.18, 0.15, -0.46),
                      E=(0.6, -0.3, -0.8), N=(0.2, 0.75, -0.3), flex=-10, Q=(0.15, 0.30, -0.25))),
        ('contact', dict(yaw=-5, pitch=31, crouch=0.26, shift=(0.02, 0.04), P=(0.08, 0.42, -0.36),
                         E=(0.5, -0.1, -1.0), N=(0.0, 0.95, -0.2), flex=0)),
        ('follow', dict(yaw=12, pitch=23, crouch=0.20, P=(-0.10, 0.40, -0.10), E=(0.3, 0.4, -0.8),
                        N=(-0.4, 0.6, -0.4), flex=10, Q=(0.0, 0.18, -0.30))),
    ]),
    # The serve as the game has it: the free hand raised above its shoulder (palm up, as if holding
    # the ball), held, then a short swing as it drops.
    'serve': dict(T=(0.30, 0.17, 0.20, 0.45), raise_s=0.55, hold_s=(0.7, 1.3), keys=[
        ('raised', dict(yaw=-12, pitch=15, crouch=0.11, P=(0.10, 0.22, -0.30), E=(0.6, -0.4, -0.8),
                        N=(0.2, 0.6, 0.2), Q=(-0.10, 0.30, 0.13), F=(-0.8, 0.0, -0.6), fN=(0.0, 0.1, 1.0),
                        fflex=-5, fopen=1.0)),
        ('held', dict(yaw=-15, pitch=15, crouch=0.11, P=(0.14, 0.18, -0.28), E=(0.6, -0.4, -0.8),
                      N=(0.2, 0.6, 0.2), Q=(-0.10, 0.30, 0.18), F=(-0.8, 0.0, -0.6), fN=(0.0, 0.1, 1.0),
                      fflex=-5, fopen=1.0)),
        ('back', dict(yaw=-25, pitch=16, crouch=0.12, P=(0.20, 0.10, -0.25), E=(0.6, -0.4, -0.8),
                      N=(0.0, 0.4, 0.9), flex=-10, Q=(-0.06, 0.32, 0.0), F=(-0.6, 0.0, -0.9), fN=(0.2, 0.2, 0.9),
                      fopen=0.6)),
        ('contact', dict(yaw=-5, pitch=17, crouch=0.12, P=(0.04, 0.38, -0.28), E=(0.6, -0.2, -0.9),
                         N=(-0.2, 0.5, 0.85), flex=0, Q=(0.07, 0.26, -0.20), fopen=0.2)),
        ('follow', dict(yaw=15, pitch=16, crouch=0.12, P=(-0.18, 0.40, -0.22), E=(0.5, 0.3, -0.8),
                        N=(-0.5, 0.3, 0.8), flex=5)),
    ]),
}

VEC = ('shift', 'P', 'E', 'N', 'Q', 'F', 'fN', 'footR', 'footL')
UNIT = ('E', 'N', 'F', 'fN')
CHANNELS = tuple(READY)

# Finger flexion (degrees about each bone's local x; positive closes the hand), per finger
# [bone 1, 2, 3]; thumb = finger1.
GRIPS = {
    'paddle': {1: (20, 25, 15), 2: (40, 30, 15), 3: (72, 88, 45), 4: (76, 90, 45), 5: (80, 90, 42)},
    'fist': {1: (18, 22, 15), 2: (45, 55, 30), 3: (60, 75, 40), 4: (64, 78, 40), 5: (68, 80, 40)},
    'relaxed': {1: (8, 10, 8), 2: (14, 20, 12), 3: (18, 24, 14), 4: (22, 28, 16), 5: (26, 30, 18)},
    'open': {1: (-5, 5, 5), 2: (6, 8, 6), 3: (8, 10, 6), 4: (10, 12, 8), 5: (12, 14, 8)},
}


def finger_quats(grip, side):
    """{bone name: quaternion (w, x, y, z)} of a grip for one hand ('L' or 'R')."""
    out = {}
    for i, angs in GRIPS[grip].items():
        for j, a in enumerate(angs):
            out[f'finger{i}-{j + 1}.{side}'] = axis_angle([1, 0, 0], math.radians(a))
    return out


# ---------------------------------------------------------------- small maths

def _unit(v):
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, 1e-9)


def _stage(v):
    """Player coordinates (r, f, u) -> stage (x, y, z) for a player at facing 0."""
    v = np.asarray(v, float)
    return np.stack([-v[..., 0], -v[..., 1], v[..., 2]], -1)


def _frame(a1, b1, a2, b2):
    """Rotations (N, 3, 3) taking a1 exactly onto a2 and b1 (made square to a1) towards b2."""
    a1, a2 = _unit(np.broadcast_to(a1, np.shape(a2)).astype(float)), _unit(a2)
    b1 = np.broadcast_to(b1, np.shape(a2)).astype(float)
    b1 = _unit(b1 - np.sum(b1 * a1, -1, keepdims=True) * a1)
    b2 = _unit(b2 - np.sum(b2 * a2, -1, keepdims=True) * a2)
    M1 = np.stack([a1, b1, np.cross(a1, b1)], -1)
    M2 = np.stack([a2, b2, np.cross(a2, b2)], -1)
    return M2 @ np.swapaxes(M1, -1, -2)


def _m2q(m):
    return np.array([smpl.m2q(x) for x in m.reshape(-1, 3, 3)]).reshape(m.shape[:-2] + (4,))


def _rot(axis, ang):
    """Rotation matrices (N, 3, 3) about unit axes (N, 3) by angles (N,) (Rodrigues)."""
    axis = _unit(axis)
    c, s = np.cos(ang)[:, None, None], np.sin(ang)[:, None, None]
    x, y, z = axis[:, 0], axis[:, 1], axis[:, 2]
    K = np.zeros(axis.shape[:1] + (3, 3))
    K[:, 0, 1], K[:, 0, 2], K[:, 1, 0], K[:, 1, 2], K[:, 2, 0], K[:, 2, 1] = -z, y, z, -x, -y, x
    return np.eye(3) + s * K + (1 - c) * (K @ K)


def _ik(S, T, hint, L1, L2, reach=0.975):
    """Two-bone IK: shoulder/hip S, target T, bend hint direction -> (middle joint, end), (N, 3)."""
    d = T - S
    D0 = np.linalg.norm(d, axis=-1, keepdims=True)
    ax = d / np.maximum(D0, 1e-9)
    D = np.clip(D0, abs(L1 - L2) + 1e-3, reach * (L1 + L2))
    x = (L1 * L1 - L2 * L2 + D * D) / (2 * D)
    r = np.sqrt(np.maximum(L1 * L1 - x * x, 0))
    perp = hint - np.sum(hint * ax, -1, keepdims=True) * ax
    perp = _unit(perp)
    mid = S + ax * x + perp * r
    return mid, S + ax * D


def _hermite(times, keys, still, t):
    """Cubic Hermite through keys (K, ...) at times (K,), Catmull-Rom tangents, zero where still."""
    keys = np.asarray(keys, float)
    K = len(times)
    tan = np.zeros_like(keys)
    for i in range(K):
        if still[i] or K < 2:
            continue
        a, b = max(i - 1, 0), min(i + 1, K - 1)
        if b > a:
            tan[i] = (keys[b] - keys[a]) / (times[b] - times[a])
    t = np.asarray(t, float)
    i = np.clip(np.searchsorted(times, t, side='right') - 1, 0, K - 2) if K > 1 else np.zeros(len(t), int)
    if K == 1:
        return np.broadcast_to(keys[0], (len(t),) + keys.shape[1:]).copy()
    t0, t1 = times[i], times[i + 1]
    h = np.maximum(t1 - t0, 1e-9)
    s = np.clip((t - t0) / h, 0, 1)
    shp = (len(t),) + (1,) * (keys.ndim - 1)
    s = s.reshape(shp)
    hh = h.reshape(shp)
    h00, h10, h01, h11 = 2 * s ** 3 - 3 * s ** 2 + 1, s ** 3 - 2 * s ** 2 + s, -2 * s ** 3 + 3 * s ** 2, s ** 3 - s ** 2
    return h00 * keys[i] + h10 * hh * tan[i] + h01 * keys[i + 1] + h11 * hh * tan[i + 1]


# ---------------------------------------------------------------- the rig's canonical frames

class ArmCanon:
    """Canonical (T-pose, G = identity) directions of one side's limbs and hand, stage frame."""

    def __init__(self, rig, s):
        J = smpl.to_stage(smpl.J_REST)
        sh, el, wr, hd = (16, 18, 20, 22) if s == 'L' else (17, 19, 21, 23)
        hp, kn, an, ft = (1, 4, 7, 10) if s == 'L' else (2, 5, 8, 11)
        self.upper = _unit(J[el] - J[sh])
        self.fore = _unit(J[wr] - J[el])
        self.thigh = _unit(J[kn] - J[hp])
        self.shin = _unit(J[an] - J[kn])
        H = rig.head
        ix = rig.idx

        def L(*bones):
            return sum(float(np.linalg.norm(H[ix[b]] - H[ix[a]])) for a, b in zip(bones[:-1], bones[1:]))
        self.L_upper = L(f'upperarm01.{s}', f'upperarm02.{s}', f'lowerarm01.{s}')
        self.L_fore = L(f'lowerarm01.{s}', f'lowerarm02.{s}', f'wrist.{s}')
        self.L_thigh = L(f'upperleg01.{s}', f'upperleg02.{s}', f'lowerleg01.{s}')
        self.L_shin = L(f'lowerleg01.{s}', f'lowerleg02.{s}', f'foot.{s}')
        # The hand: rest-armature vectors through the wrist bone's canonical orientation.
        w = ix[f'wrist.{s}']
        C = rig.A[f'wrist.{s}'] @ rig.B[w].T
        h0 = H[w]
        mid, idx, pinky, thumb = (H[ix[f'finger{k}.{s}']] for k in ('3-1', '2-1', '5-1', '1-3'))
        along = _unit(C @ (mid - h0))
        across = _unit(C @ (idx - pinky))
        n = _unit(np.cross(along, across))
        # The palm is the side the thumb tip curls towards.
        if np.dot(C @ (thumb - (idx + pinky) / 2), n) < 0:
            n = -n
        self.along, self.palm = along, n
        self.side = s


# ---------------------------------------------------------------- the segment

def _stroke_list(seg, rng, dur):
    """Explicit `events`, or a seeded rally from `auto`. Auto events carry `_after` (the idle time
    after the previous stroke's recovery); explicit ones carry `t_s`."""
    if seg.get('events'):
        ev = [dict(e) for e in seg['events']]
    else:
        a = dict(seg.get('auto', {}))
        mix = a.get('mix', {'forehand': 3, 'backhand': 2, 'push': 1, 'block': 1, 'loop': 1,
                             'wide_forehand': 1, 'wide_backhand': 1, 'low': 1})
        lo, hi = a.get('speed_mps', [2.5, 6.0])
        glo, ghi = a.get('gap_s', [0.15, 1.1])
        rlo, rhi = a.get('rally', [3, 7])
        plo, phi = a.get('pause_s', [0.8, 2.0])
        kinds, w = zip(*mix.items())
        ev, after = [], float(a.get('start_s', 0.4))
        while len(ev) < int(dur / 0.7) + 4:
            if a.get('serve', True):
                ev.append({'kind': 'serve', 'speed_mps': rng.uniform(2.5, 4.5), '_after': after})
                after = rng.uniform(glo, ghi)
            for _ in range(rng.randint(rlo, rhi)):
                k = rng.choices(kinds, w)[0]
                sp = rng.uniform(lo, hi)
                # Hard strokes come from loops and drives; pushes and blocks stay gentle.
                if k in ('push', 'block'):
                    sp = min(sp, rng.uniform(1.6, 2.8))
                elif k == 'loop':
                    sp = max(sp, rng.uniform(0.75, 1.0) * hi)
                ev.append({'kind': k, 'speed_mps': sp, '_after': after})
                after = rng.uniform(glo, ghi)
            after = rng.uniform(plo, phi)
    for e in ev:
        if e.get('kind') not in KINDS:
            raise ValueError(f'pingpong: unknown stroke kind {e.get("kind")!r} (use {", ".join(KINDS)})')
    return ev


class PingPong:
    """A `pingpong` timeline segment (see the module docstring)."""
    kind = 'pingpong'
    visible = True

    def __init__(self, t0, t1, spot, facing, seg, rig, sole_z, seed, hand='right', paddle=False):
        self.t0, self.t1 = t0, t1
        self.spot, self.facing = np.asarray(spot, float), facing
        self.rig = rig
        self.hand = seg.get('hand', hand)
        if self.hand not in ('right', 'left'):
            raise ValueError('pingpong: hand must be "right" or "left"')
        # Holding a paddle closes the hand round its handle; empty-handed players make a looser fist.
        self.grip = seg.get('grip') or ('paddle' if paddle else 'fist')
        if self.grip not in GRIPS:
            raise ValueError(f'pingpong: unknown grip {self.grip!r}')
        self.rng = random.Random(int(seed * 1000) + 17)
        self.live = float(seg.get('liveliness', 1.0))
        self.stance = float(seg.get('stance_m', 0.46))
        self.canon = {s: ArmCanon(rig, s) for s in 'LR'}
        self.sole_z = sole_z
        self.arm_scale = (self.canon['R'].L_upper + self.canon['R'].L_fore) / REF_ARM
        dur = (t1 - t0) if t1 < 1e8 else 60.0
        self.dur = dur
        self.noise = [(self.rng.uniform(0.35, 1.7), self.rng.uniform(0, 6.283)) for _ in range(40)]
        self._build(_stroke_list(seg, self.rng, dur), dur)

    def end_spot(self, spot):
        return spot

    # ---- keys

    def _ready(self):
        return {k: (np.array(v, float) if k in VEC else float(v)) for k, v in READY.items()}

    def _template_keys(self, ev, t_start, k):
        """[(time, values, still)], end time, contact time for one stroke; times scaled by k."""
        tpl = TEMPLATES[ev['kind']]
        Tb, Tf, Tft, Tr = tpl['T']
        jit = ev.get('_jitter', (1.0, 1.0))
        Tb, Tr = Tb * jit[0] * min(1.0, 0.6 + 0.4 * k), Tr * jit[1]
        Tf, Tft = Tf * k, Tft * (0.5 + 0.5 * k)
        out = [(t_start, self._ready(), True)]
        t = t_start
        if ev['kind'] == 'serve':
            t_raised = t + tpl['raise_s']
            t_held = t_raised + ev.get('hold_s', ev['_hold'])
            times = {'raised': t_raised, 'held': t_held, 'back': t_held + Tb, 'contact': t_held + Tb + Tf}
        else:
            times = {'back': t + Tb, 'contact': t + Tb + Tf}
        times['follow'] = times['contact'] + Tft
        times['mid_recover'] = times['follow'] + 0.5 * Tr
        end = times['follow'] + Tr
        for name, ov in tpl['keys']:
            v = self._ready()
            for c, x in ov.items():
                v[c] = np.array(x, float) if c in VEC else float(x)
            v = self._perturb(v, ev)
            out.append((times[name], v, name in ('raised', 'held')))
        out.append((end, self._ready(), True))
        out.sort(key=lambda x: x[0])
        return out, end, times['contact']

    def _perturb(self, v, ev):
        """Each stroke a little different: its own key offsets (seeded per stroke)."""
        rng = random.Random(ev['_seed'])
        v = dict(v)
        for c in ('P', 'Q'):
            v[c] = v[c] + np.array([rng.gauss(0, 0.025), rng.gauss(0, 0.02), rng.gauss(0, 0.025)])
        v['yaw'] += rng.gauss(0, 4)
        v['crouch'] += rng.gauss(0, 0.01)
        if 'reach' in ev:  # explicit contact offsets (r, u) for a wider/higher/lower ball
            v['P'] = v['P'] + np.array([ev['reach'][0], 0, ev['reach'][1]])
        return v

    def _build(self, events, dur):
        keys = [(0.0, self._ready(), True)]
        self.strokes = []
        t_free = 0.0
        for n, ev in enumerate(events):
            ev['_seed'] = self.rng.randrange(1 << 30)
            ev['_jitter'] = (self.rng.uniform(0.85, 1.2), self.rng.uniform(0.85, 1.25))
            ev['_hold'] = self.rng.uniform(*TEMPLATES['serve']['hold_s'])
            if '_after' in ev:
                t_start = t_free + ev['_after']
            else:
                t_start = max(float(ev.get('t_s', t_free)), t_free)
            if t_start > dur - 0.8:
                break
            k = self._fit_speed(ev, t_start, keys[-1])
            sk, end, contact = self._template_keys(ev, t_start, k)
            # Drop the duplicate ready key if the previous stroke ended exactly here.
            if abs(keys[-1][0] - sk[0][0]) < 1e-6:
                sk = sk[1:]
            keys += sk
            win = (t_start, end)
            self.strokes.append({'kind': ev['kind'], 'start_s': t_start, 'contact_s': contact,
                                 'end_s': end, 'swing_end_s': sk[-2][0] if len(sk) > 1 else end,
                                 'target_speed_mps': float(ev.get('speed_mps', 0) or 0), 'k': k, 'window': win})
            t_free = end
        if keys[-1][0] < dur:
            keys.append((dur + 1.0, self._ready(), True))
        self.key_t = np.array([k[0] for k in keys])
        self.key_still = np.array([k[2] for k in keys])
        self.key_v = {c: np.array([k[1][c] for k in keys]) for c in CHANNELS}
        # Measured peak speeds (after the whole timeline is assembled).
        for s in self.strokes:
            a, b = s['window']
            tt = np.arange(a, b, 1 / 240)
            s['peak_speed_mps'] = round(float(self._peak(tt)), 2)
            s.pop('window')
            s.pop('k')
            for key in ('start_s', 'contact_s', 'end_s', 'swing_end_s'):
                s[key] = round(s[key], 4)

    def _fit_speed(self, ev, t_start, prev):
        target = ev.get('speed_mps')
        if not target:
            return 1.0
        k = 1.0
        for _ in range(5):
            sk, end, contact = self._template_keys(ev, t_start, k)
            kt = np.array([x[0] for x in sk])
            kv = {c: np.array([x[1][c] for x in sk]) for c in CHANNELS}
            ks = np.array([x[2] for x in sk])
            tt = np.arange(t_start, end, 1 / 240)
            peak = self._peak(tt, (kt, kv, ks))
            if peak <= 1e-6:
                return k
            k = float(np.clip(k * (peak / target) ** 1.1, 0.2, 4.0))
        return k

    # ---- evaluation

    def channels(self, t, keys=None):
        kt, kv, ks = keys if keys is not None else (self.key_t, self.key_v, self.key_still)
        out = {}
        for c in CHANNELS:
            out[c] = _hermite(kt, kv[c], ks, t)
        # Life: slow, small, smooth wobble on the ready stance and through the strokes.
        L = self.live
        nz = iter(self.noise)

        def wob(amp):
            f, ph = next(nz)
            f2, ph2 = next(nz)
            return amp * (0.65 * np.sin(2 * np.pi * f * t + ph) + 0.35 * np.sin(2 * np.pi * f2 * 1.7 * t + ph2))
        out['crouch'] = out['crouch'] + L * wob(0.01)
        out['yaw'] = out['yaw'] + L * wob(2.0)
        out['pitch'] = out['pitch'] + L * wob(1.5)
        out['shift'] = out['shift'] + L * np.stack([wob(0.012), wob(0.008)], -1)
        out['P'] = out['P'] + L * np.stack([wob(0.015), wob(0.015), wob(0.015)], -1)
        out['Q'] = out['Q'] + L * np.stack([wob(0.02), wob(0.015), wob(0.02)], -1)
        for c in UNIT:
            out[c] = _unit(out[c])
        return out

    def _torso(self, ch):
        """Pelvis..head local rotations (N, 24, 4) and hip midpoints (N, 3), player at the origin."""
        N = len(ch['yaw'])
        q = np.zeros((N, 24, 4))
        q[:, :, 0] = 1
        Y, Pt, R = (np.radians(ch[c]) for c in ('yaw', 'pitch', 'roll'))
        X, Yax, Z = np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), np.array([0, 0, 1.0])

        def aa(axis, ang):
            return np.stack([np.cos(ang / 2), *(axis[i] * np.sin(ang / 2) for i in range(3))], -1)
        # Forward lean is +x rotation (the chest goes to -y, towards the camera); a lean to the
        # player's right is -y rotation.
        q[:, 0] = qmul(aa(Z, 0.45 * Y), aa(X, 0.55 * Pt))
        for j in (3, 6, 9):
            q[:, j] = qmul(aa(Z, 0.55 * Y / 3), qmul(aa(X, 0.15 * Pt), aa(Yax, -R / 3)))
        q[:, 12] = qmul(aa(Z, -0.35 * Y), aa(X, -0.45 * Pt))
        q[:, 15] = qmul(aa(Z, -0.35 * Y), aa(X, -0.35 * Pt))
        return q

    def _legs_hip(self, ch, q):
        rig, N = self.rig, len(ch['yaw'])
        cL, cR = self.canon['L'], self.canon['R']
        ankle_h = rig.head[rig.idx['foot.L']][2] - self.sole_z
        hip_h = rig.hip_rest[2] - self.sole_z
        w = self.stance / 2
        footR = np.array([w, -0.05, 0.0]) + ch['footR']
        footL = np.array([-w, 0.0, 0.0]) + ch['footL']
        aR, aL = _stage(footR), _stage(footL)
        aR[:, 2] = ankle_h + np.maximum(ch['footR'][:, 2], 0)
        aL[:, 2] = ankle_h + np.maximum(ch['footL'][:, 2], 0)
        # Hips over the feet's middle plus the weight shift.
        planted = (_stage(np.array([w, -0.05, 0])) + _stage(np.array([-w, 0, 0]))) / 2
        hip = np.zeros((N, 3))
        hip[:, :2] = planted[:2] + _stage(np.concatenate([ch['shift'], np.zeros((N, 1))], -1))[:, :2]
        hip[:, 2] = hip_h - ch['crouch']
        sol = rig.solve(q, hip)
        # Keep each leg able to reach its foot (a straight leg's hip can't be higher).
        for s, a, c in (('L', aL, cL), ('R', aR, cR)):
            hj = sol['heads'][f'upperleg01.{s}']
            dxy = np.linalg.norm((a - hj)[:, :2], axis=-1)
            zmax = a[:, 2] + np.sqrt(np.maximum((0.985 * (c.L_thigh + c.L_shin)) ** 2 - dxy ** 2, 0.01))
            over = np.maximum(hj[:, 2] - zmax, 0)
            hip[:, 2] -= over
        sol = rig.solve(q, hip)
        G = q2m(smpl.fk_stage(q))
        for s, a, c, (hp, kn, an) in (('L', aL, cL, (1, 4, 7)), ('R', aR, cR, (2, 5, 8))):
            hj = sol['heads'][f'upperleg01.{s}']
            out = 1.0 if s == 'L' else -1.0
            hint = _stage(np.array([0.25 * (-out), 1.0, 0.0]))  # knee forward and a little out
            hint = np.broadcast_to(hint, hj.shape)
            knee, ank = _ik(hj, a, hint, c.L_thigh, c.L_shin, reach=0.995)
            th, sh = _unit(knee - hj), _unit(ank - knee)
            hinge = np.cross(th, sh)
            straight = np.linalg.norm(hinge, axis=-1) < 1e-4
            hinge = np.where(straight[:, None], np.cross(th, -hint), hinge)
            G1 = _frame(c.thigh, X_AX, th, hinge)
            G4 = _frame(c.shin, X_AX, sh, hinge)
            toe = math.radians(12) * (1 if s == 'L' else -1)
            G7 = np.broadcast_to(q2m(yaw_q(toe)), (N, 3, 3))
            q[:, hp] = _m2q(np.swapaxes(G[:, 0], -1, -2) @ G1)
            q[:, kn] = _m2q(np.swapaxes(G1, -1, -2) @ G4)
            q[:, an] = _m2q(np.swapaxes(G4, -1, -2) @ G7)
        return hip

    def _arm_targets(self, ch, q, hip):
        """World wrist targets (and chest rotation) of both arms."""
        sol = self.rig.solve(q, hip)
        G = q2m(smpl.fk_stage(q))
        # Targets are in the chest's heading frame (its yaw only), so 'up' stays up when the
        # player leans forward.
        fwd = np.einsum('nij,j->ni', G[:, 9], np.array([0, -1.0, 0]))
        hd = np.arctan2(fwd[:, 0], -fwd[:, 1])
        M9 = q2m(np.stack([np.cos(hd / 2), 0 * hd, 0 * hd, np.sin(hd / 2)], -1))
        sc = self.arm_scale
        SR, SL = sol['heads']['upperarm01.R'], sol['heads']['upperarm01.L']
        WR = SR + np.einsum('nij,nj->ni', M9, _stage(ch['P'] * sc))
        WL = SL + np.einsum('nij,nj->ni', M9, _stage(ch['Q'] * sc))
        return G, M9, (SR, WR), (SL, WL)

    def _peak(self, tt, keys=None):
        ch = self.channels(tt, keys)
        q = self._torso(ch)
        hip = self._legs_hip(ch, q)
        _, _, (SR, WR), _ = self._arm_targets(ch, q, hip)
        cR = self.canon['R']
        _, WR = _ik(SR, WR, np.broadcast_to([0, 0, -1.0], SR.shape), cR.L_upper, cR.L_fore)
        v = np.linalg.norm(np.diff(WR, axis=0), axis=-1) * 240
        return float(v.max()) if len(v) else 0.0

    def _arms(self, ch, q, hip):
        G, M9, R, L = self._arm_targets(ch, q, hip)
        for s, (S, W), (E, Nn, fl, dv), (sh, el, wr) in (
                ('R', R, ('E', 'N', 'flex', 'dev'), (17, 19, 21)),
                ('L', L, ('F', 'fN', 'fflex', 'fdev'), (16, 18, 20))):
            c = self.canon[s]
            hint = np.einsum('nij,nj->ni', M9, _stage(ch[E]))
            palm_t = np.einsum('nij,nj->ni', M9, _stage(ch[Nn]))
            elbow, wrist = _ik(S, W, hint, c.L_upper, c.L_fore)
            u, f = _unit(elbow - S), _unit(wrist - elbow)
            a = np.cross(f, u) if s == 'L' else np.cross(u, f)
            straight = np.linalg.norm(a, axis=-1) < 1e-4
            # Straight arm: the forearm bends away from where the elbow points.
            a = np.where(straight[:, None], np.cross(u, hint) if s == 'L' else np.cross(hint, u), a)
            a = _unit(a)
            G16 = _frame(c.upper, Z_AX, u, a)
            # Pronation: the forearm turned so the palm faces the keyed way (within a forearm's
            # range: 85 deg supination to 95 deg pronation from the handshake position).
            n0 = -a
            sgn = 1.0 if s == 'L' else -1.0
            pt = palm_t - np.sum(palm_t * f, -1, keepdims=True) * f
            ang = np.arctan2(np.sum(np.cross(n0, pt) * f, -1), np.sum(n0 * pt, -1)) * sgn
            ang = np.clip(ang, math.radians(-85), math.radians(95))
            nf = np.einsum('nij,nj->ni', _rot(f, sgn * ang), n0)
            G18 = _frame(c.fore, c.palm, f, nf)
            # Wrist: whatever turn of the forearm couldn't do, the wrist does: the hand turned
            # from the forearm's frame towards the palm facing the key asks for (the fingers
            # continuing the forearm as far as they can), at most WRIST_MAX_DEG of bend. Then the
            # keyed flex (towards the palm) and deviation (towards the thumb) on top.
            nt = _unit(palm_t)
            along_d = _unit(f - np.sum(f * nt, -1, keepdims=True) * nt)
            Rw = _frame(f, nf, along_d, nt)
            cosw = np.clip((np.trace(Rw, axis1=1, axis2=2) - 1) / 2, -1, 1)
            phi = np.arccos(cosw)
            axis = np.stack([Rw[:, 2, 1] - Rw[:, 1, 2], Rw[:, 0, 2] - Rw[:, 2, 0], Rw[:, 1, 0] - Rw[:, 0, 1]], -1)
            Rw = _rot(np.where(np.linalg.norm(axis, axis=-1, keepdims=True) > 1e-9, axis, f),
                      np.minimum(phi, math.radians(WRIST_MAX_DEG)))
            along = np.einsum('nij,nj->ni', Rw, f)
            n = np.einsum('nij,nj->ni', Rw, nf)
            thumb = np.cross(along, n) if s == 'R' else np.cross(n, along)
            Rf = _rot(np.cross(along, n), np.radians(ch[fl]) * 0.5)
            along = np.einsum('nij,nj->ni', Rf, along)
            n = np.einsum('nij,nj->ni', Rf, n)
            thumb = np.einsum('nij,nj->ni', Rf, thumb)
            Rd = _rot(np.cross(along, thumb), np.radians(ch[dv]))
            along = np.einsum('nij,nj->ni', Rd, along)
            G20 = _frame(c.along, c.palm, along, n)
            q[:, sh] = _m2q(np.swapaxes(G[:, 9], -1, -2) @ G16)  # collar = identity: parent is spine3
            q[:, el] = _m2q(np.swapaxes(G16, -1, -2) @ G18)
            q[:, wr] = _m2q(np.swapaxes(G18, -1, -2) @ G20)
        return q

    def eval(self, t, rig=None):
        tl = np.asarray(t, float) - self.t0
        ch = self.channels(tl)
        q = self._torso(ch)
        hip = self._legs_hip(ch, q)
        q = self._arms(ch, q, hip)
        if self.hand == 'left':
            q = q[:, smpl.MIRROR] * np.array([1.0, 1, -1, -1])
            hip = hip * np.array([-1.0, 1, 1])
        qy = yaw_q(self.facing)
        q[:, 0] = qmul(np.broadcast_to(qy, q[:, 0].shape), q[:, 0])
        cy, sy = math.cos(self.facing), math.sin(self.facing)
        hx, hy = hip[:, 0].copy(), hip[:, 1].copy()
        hip[:, 0] = cy * hx - sy * hy + self.spot[0]
        hip[:, 1] = sy * hx + cy * hy + self.spot[1]
        return q, hip, np.ones(len(tl), bool)

    def fingers(self, t):
        """{bone: (N, 4)} finger rotations: the paddle hand's grip, the free hand relaxed/open."""
        tl = np.asarray(t, float) - self.t0
        ps, fs = ('R', 'L') if self.hand == 'right' else ('L', 'R')
        out = {b: np.broadcast_to(v, (len(tl), 4)).copy() for b, v in finger_quats(self.grip, ps).items()}
        op = np.clip(_hermite(self.key_t, self.key_v['fopen'], self.key_still, tl), 0, 1)
        rel, opn = finger_quats('relaxed', fs), finger_quats('open', fs)
        for b in rel:
            out[b] = smpl.qslerp(np.broadcast_to(rel[b], (len(tl), 4)), np.broadcast_to(opn[b], (len(tl), 4)), op)
        return out

    def labels(self, t):
        tl = np.asarray(t, float) - self.t0
        lab = np.array(['ready'] * len(tl), dtype=object)
        for s in self.strokes:
            sel = (tl >= s['start_s']) & (tl < s['swing_end_s'])
            lab[sel] = 'serve' if s['kind'] == 'serve' else 'swing'
        return lab

    def events(self):
        """Strokes in scene time (seconds), for meta.json."""
        out = []
        for s in self.strokes:
            d = dict(s)
            for k in ('start_s', 'contact_s', 'end_s', 'swing_end_s'):
                d[k] = round(d[k] + self.t0, 4)
            out.append(d)
        return out


X_AX = np.array([1.0, 0, 0])
Z_AX = np.array([0, 0, 1.0])
