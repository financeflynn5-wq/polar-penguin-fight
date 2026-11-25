"""The yeti: the slow heavy hitter. Sculpted, dressed in the penguin's wardrobe (two sizes too small), textured,
rigged and exported as yeti.glb (+ yeti.json, the rig facts the game needs).

    python tools/blender/yeti.py             # build + bake + export to src/assets/models/yeti.glb
    python tools/blender/yeti.py --size=1024 # quicker draft
    python tools/blender/yeti.py --shapes    # quick un-baked renders of the sculpt and looks (--grey: clay)

Blender space: the yeti faces +Y, up is +Z, its right arm is at +X. Same skeleton as the penguin (see bones()).
"""
import math
import os
import sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import geom as G  # noqa: E402
from lib import bake as B  # noqa: E402
from lib import looks as L  # noqa: E402
from lib import creature as C  # noqa: E402
from lib.geom import sstep  # noqa: E402
from lib.nodes import (rgb, Vec, V, absv, vmax, vmin, clamp01, smooth, lerp, ell, noise, bump_band, atan2)  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

# ───────────────────────── proportions ─────────────────────────
HAT_SCALE = 1.12  # the top of the skull is the penguin's head dome, this much bigger, so every hat fits
HEAD_C = np.array([0.0, 0.07, 1.548])
HEAD_R = np.array([0.298, 0.286, 0.270]) * HAT_SCALE
HEIGHT = float(HEAD_C[2] + HEAD_R[2])
HAT_BONE = HEAD_C + np.array([0.0, -0.012, 0.182]) * HAT_SCALE
FZ = -0.045      # the whole face sits this far below the middle of the skull, so hat brims clear the brow
MZ = FZ - 0.014  # … and the mouth a little lower again, to leave room for big eyes
FACE_Y = 0.335   # the bare face is a flat plate set back into the fur
MUZ_C = np.array([0.0, 0.345, 1.478 + MZ]); MUZ_R = np.array([0.134, 0.102, 0.080])
JAW_C = np.array([0.0, 0.348, 1.410 + MZ]); JAW_R = np.array([0.142, 0.130, 0.078])
LIP_Z, LIP_K = 1.416 + MZ, 2.4  # the lower lip's top edge: z = LIP_Z + LIP_K x², a smile
JAW_PIVOT = (0.0, 0.22, 1.42 + MZ)
NOSE_C = np.array([0.0, 0.440, 1.522 + MZ])
BROW_Z = 1.660 + FZ
BROW_IN, BROW_OUT = np.array([0.018, FACE_Y - 0.004, BROW_Z - 0.014]), np.array([0.200, FACE_Y - 0.016, BROW_Z + 0.022])  # one side of the brow ridge
EAR_C = np.array([0.368, 0.050, 1.565 + FZ]); EAR_YAW = 0.42
ARM_REST = 0.40
SHOULDER = np.array([0.470, -0.012, 1.125])
ARM_DIR = np.array([math.sin(ARM_REST), 0.0, -math.cos(ARM_REST)])
ELBOW_D, WRIST_D, HAND_D = 0.32, 0.58, 0.725
MITTEN_K = 1.70
HIP = np.array([0.215, -0.01, 0.50]); ANKLE = np.array([0.235, 0.02, 0.13])
FOOT = np.array([0.235, 0.02, 0.0]); FOOT_YAW = 0.26
JK_ZB, JK_ZT = 0.735, 1.215
BAFFLE = (JK_ZT - JK_ZB) / 4
SCARF_Z, SCARF_K, SCARF_DIP = 1.275, 1.10, 0.095


def gap_half_angle(z):
    """Half-angle of the vest's open front: it has no hope of closing over that chest."""
    return 0.60 + (0.30 - 0.60) * sstep(JK_ZB, JK_ZT, z) ** 0.9


def torso_sdf():
    chest = G.ellipsoid((0, 0.0, 0.96), (0.485, 0.375, 0.330))
    traps = G.ellipsoid((0, -0.06, 1.09), (0.450, 0.320, 0.200))
    belly = G.ellipsoid((0, 0.04, 0.71), (0.385, 0.355, 0.330))
    hips = G.ellipsoid((0, -0.02, 0.52), (0.365, 0.330, 0.240))
    neck = G.capsule((0, 0.02, 1.16), (0, 0.05, 1.42), 0.215, 0.20)
    return G.add(G.union(0.10, chest, traps, belly, hips), neck, 0.05)


def head_sdf():
    skull = G.ellipsoid(HEAD_C, HEAD_R)
    # the face: the front of the skull sliced flat, a little hollow, so the fur stands proud all round it
    f = G.clip(skull, G.sphere((0, FACE_Y - 1.1, 1.50 + FZ), 1.1), 0.035)
    for s in (-1, 1):
        f = G.add(f, G.sphere((s * 0.215, 0.150, 1.415 + FZ), 0.160), 0.07)  # jowls of fur
    f = G.add(f, G.ellipsoid(MUZ_C, MUZ_R), 0.045)
    for s in (-1, 1):  # a heavy brow, a touch lower in the middle: grumpy, but not cross
        f = G.add(f, G.capsule(BROW_IN * (s, 1, 1), BROW_OUT * (s, 1, 1), 0.046, 0.038), 0.045)
    return f


TORSO = torso_sdf()
HEAD = head_sdf()
TRUNK = G.union(0.03, TORSO, HEAD)


def _eye():
    # big glossy eyes like the penguin's and the bear's. The face is flat, so the ball is big and only its front shows
    x, z, rx, r = 0.126, 1.563 + FZ, 0.090, 0.114
    return C.Eye(x, FACE_Y - 0.012 - r + 0.024, z, rx, r, 0.20)


EYE = _eye()


def arm_point(s, d, fwd=0.0):
    p = SHOULDER + ARM_DIR * d
    p[1] += fwd
    p[0] *= s
    return p


def arm_axis(s):
    return ARM_DIR * np.array([s, 1, 1])


def arm_radius(d):
    """Round at the shoulder, lean at the elbow, a Popeye forearm, a narrow wrist."""
    return (0.155 + 0.045 * math.exp(-(d / 0.12) ** 2) - 0.008 * math.exp(-((d - ELBOW_D) / 0.07) ** 2)
            + 0.036 * math.exp(-((d - 0.46) / 0.10) ** 2) - 0.026 * sstep(0.52, 0.60, d))


# ───────────────────────── parts ─────────────────────────

def make_head():
    g = G.blob(HEAD, HEAD_C + (0, -0.03, 0.0), (0, 0.22, 1.50 + FZ), nu=52, nv=40, ref=(0, 0, -1), cap_r=0.30, tmax=1.0)
    return G.build_mesh('Head', g)


EAR_DISH = 0.082


def make_ear(s):
    c = EAR_C * np.array([s, 1, 1])
    yaw = s * EAR_YAW
    Rm = np.array([[math.cos(yaw), math.sin(yaw), 0], [-math.sin(yaw), math.cos(yaw), 0], [0, 0, 1]]).T
    fwd = Rm[:, 1]
    ear = G.ellipsoid(c, (0.108, 0.042, 0.122), Rm)
    f = G.cut(ear, G.sphere(c + fwd * EAR_DISH, 0.070), 0.022)
    g = G.blob(f, c, nu=18, nv=11, ref=tuple(fwd), cap_r=0.08, tmax=0.4)
    return G.build_mesh('Ear' + ('R' if s > 0 else 'L'), g)


def make_nose():
    f = G.add(G.ellipsoid(NOSE_C, (0.058, 0.034, 0.036)), G.sphere(NOSE_C + (0, -0.02, 0.035), 0.030), 0.04)
    return G.build_mesh('Nose', G.blob(f, NOSE_C + (0, -0.012, 0.004), nu=16, nv=10, ref=(0, 0, 1), cap_r=0.04, tmax=0.3))


def make_jaw():
    ell_ = G.ellipsoid(JAW_C, JAW_R)

    def f(p):
        return G.smax(ell_(p), p[..., 2] - (LIP_Z + LIP_K * p[..., 0] ** 2), 0.012)
    g = G.blob(f, JAW_C + (0, -0.03, -0.02), JAW_C + (0, 0.03, -0.02), nu=24, nv=14, ref=(0, 0, 1), cap_r=0.08, tmax=0.5)
    return G.build_mesh('Jaw', g)


TEETH = (0.070, 0.452, 1.452 + MZ)


def make_tooth(s):
    """A blunt lower tooth: the underbite."""
    a = np.array([s * TEETH[0], TEETH[1] - 0.012, TEETH[2] - 0.025]); b = np.array([s * TEETH[0] * 0.98, TEETH[1], TEETH[2] + 0.040])
    f = G.capsule(a, b, 0.027, 0.017)
    return G.build_mesh('Tooth' + ('R' if s > 0 else 'L'), G.blob(f, a + (0, 0, 0.01), b - (0, 0, 0.012), nu=10, nv=8, ref=(0, 1, 0), cap_r=0.03, tmax=0.2))


def make_arm(s):
    n = 16
    ds = np.linspace(-0.02, WRIST_D + 0.04, n)
    path = np.array([arm_point(s, d) for d in ds])

    def section(t, th):
        r = arm_radius(-0.02 + t * (WRIST_D + 0.06))
        return r * 0.97 * np.cos(th), r * 1.04 * np.sin(th)
    g = G.sweep(path, section, nu=16, ref=(0, 1, 0), cap=True, cap_rows=3)
    ob = G.build_mesh('Arm' + ('R' if s > 0 else 'L'), g)
    C.lumpy(ob, 0.007, 21.0, 3.0 + s)
    return ob


def make_leg(s):
    a = HIP * np.array([s, 1, 1]); b = ANKLE * np.array([s, 1, 1])
    path = np.array([a + (b - a) * t for t in np.linspace(0, 1, 7)])
    g = G.sweep(path, lambda t, th: ((0.190 - 0.012 * t) * np.cos(th), (0.200 - 0.016 * t) * np.sin(th)), nu=14, ref=(0, 1, 0), cap=True, cap_rows=3)
    return G.build_mesh('Leg' + ('R' if s > 0 else 'L'), g)


def foot_frame(s):
    a = s * FOOT_YAW
    fwd = np.array([math.sin(a), math.cos(a), 0.0])
    side = np.array([math.cos(a), -math.sin(a), 0.0])
    return FOOT * np.array([s, 1, 1]), fwd, side


TOES = ((-1, 0.118, 0.262, 0.070), (0, 0.0, 0.300, 0.078), (1, -0.112, 0.268, 0.066))  # (index, side, forward, radius); big toe inside


def make_foot(s):
    heel, fwd, side = foot_frame(s)
    Rm = np.stack([side, fwd, np.array([0, 0, 1.0])], axis=1)
    c = heel + fwd * 0.095 + np.array([0, 0, 0.085])
    f = G.ellipsoid(c, (0.165, 0.235, 0.118), Rm)
    for _k, u, v, r in TOES:
        tc = heel + fwd * v + side * (-u * 1.0) + np.array([0, 0, 0.066])
        f = G.add(f, G.sphere(tc, r), 0.030)
    f = G.clip(f, G.plane((0, 0, -1), -0.004), 0.018)  # a flat sole
    g = G.blob(f, c - fwd * 0.05, c + fwd * 0.09, nu=26, nv=16, ref=(0, 0, 1), cap_r=0.12, tmax=0.7)
    return G.build_mesh('Foot' + ('R' if s > 0 else 'L'), g)


def make_tufts():
    """The shag: long drooping locks wherever the outline or a seam needs them, in loose clumps. → [(object, weights)]"""
    rng = np.random.default_rng(11)
    out = []
    k = [0]

    def nm(base):
        k[0] += 1
        return f'{base}{k[0]}'

    def jit(a=0.26):
        return 1.0 + (rng.random() - 0.5) * 2 * a
    LK = dict(nu=6, n=4, point=1.15, fat=0.03)
    hd = lambda P: {'head': np.ones(len(P))}  # noqa: E731
    # round the face: sideburns and jowls hanging down past the jaw, a wispy fringe over the brow
    o = HEAD_C + np.array([0, 0.02, -0.03 + FZ])
    for s in (-1, 1):
        for dr, fl, ln, wd in (((1.0, 0.64, 0.22), (0.55, 0.20, -0.80), 0.170, 0.052),
                               ((1.0, 0.66, -0.06), (0.60, 0.15, -0.80), 0.200, 0.058),
                               ((1.0, 0.62, -0.36), (0.50, 0.12, -0.90), 0.210, 0.060),
                               ((0.80, 0.84, -0.66), (0.28, 0.16, -1.00), 0.190, 0.056),
                               ((1.0, 0.25, -0.40), (0.60, -0.05, -0.85), 0.220, 0.060),
                               ((1.0, -0.20, -0.36), (0.55, -0.35, -0.85), 0.220, 0.060),
                               ((1.0, -0.62, -0.30), (0.40, -0.55, -0.85), 0.210, 0.060)):
            d = np.array(dr) * (s, 1, 1); f = np.array(fl) * (s, 1, 1)
            out.append((C.tuft(nm('Face'), HEAD, o, d, f, ln * jit(), wd, thick=wd * 0.85, lift=0.22, embed=0.035, bend=0.20, **LK), hd))
    for dx, ln in ((-0.20, 0.090), (-0.105, 0.115), (0.0, 0.100), (0.105, 0.115), (0.20, 0.090)):
        root = np.array([dx, FACE_Y - 0.085, BROW_Z + 0.105])
        tip = np.array([dx * 1.10 + 0.012, FACE_Y + 0.030, BROW_Z + 0.105 - ln * 0.60])
        out.append((C.lock(nm('Fringe'), root, tip, 0.036, 0.026, (0, 0.75, 0.65), bend=0.22, **LK), hd))
    # eyebrows: thick tufts sweeping out along the brow ridge and flicking up past the corner of the eye
    for s in (-1, 1):
        ax = (BROW_OUT - BROW_IN) / np.linalg.norm(BROW_OUT - BROW_IN)
        for t0, ln, dz, wd in ((0.02, 0.105, -0.012, 0.050), (0.36, 0.110, 0.004, 0.054), (0.70, 0.115, 0.034, 0.050)):
            root = BROW_IN + (BROW_OUT - BROW_IN) * t0 + np.array([0, 0.018, 0.012])
            tip = root + ax * ln + np.array([0.0, 0.034, dz])
            out.append((C.lock(nm('Brow'), root * (s, 1, 1), tip * (s, 1, 1), wd, wd * 0.75, (0, 0.8, 0.6), bend=0.16, **LK), hd))
    # the nape: a mane down the back of the head, over the scarf
    for a in (-1.0, -0.5, 0.0, 0.5, 1.0):
        d = np.array([math.sin(a) * 0.9, -1.0, -0.40])
        out.append((C.tuft(nm('Nape'), HEAD, HEAD_C, d, (math.sin(a) * 0.3, -0.25, -1.0), 0.230 * jit(), 0.062, thick=0.052, lift=0.22,
                           embed=0.035, bend=0.20, **LK), hd))
    # shoulders, elbows and forearms: shag that rides on the arm and hangs off the back of it
    for s in (-1, 1):
        sd = 'R' if s > 0 else 'L'
        ax = arm_axis(s)
        wa = lambda P, s=s: w_arm(P, s)  # noqa: E731
        # phi: 0 = forward, 90° = out to the side, 180° = back (given for the right arm, mirrored for the left)
        for d0, phis, ln, wd, lift in ((0.00, (0.4, 1.15, 1.9, 2.65), 0.260, 0.066, 0.10),
                                       (0.12, (0.9, 1.7, 2.5), 0.240, 0.062, 0.16),
                                       (ELBOW_D - 0.09, (1.9, 2.5, 3.1), 0.240, 0.060, 0.30),
                                       (0.40, (0.5, 1.3, 2.1, 2.9), 0.260, 0.064, 0.24)):
            for ph in phis:
                phi = ph * jit(0.06) if s > 0 else math.pi - ph * jit(0.06)
                out.append((C.limb_tuft(nm('Arm' + sd), arm_point(s, 0.0), ax, d0, phi, arm_radius(d0), ln * jit(), wd,
                                        thick=wd * 0.85, lift=lift * jit(0.3), embed=0.04, bend=0.20, splay=(rng.random() - 0.5) * 0.4, **LK), wa))
    # chest ruff in the open front of the vest, belly, and a skirt of shag over the hips and the tops of the legs
    for z0, thetas, ln, wd, dz in ((1.14, (-0.22, 0.0, 0.22), 0.220, 0.062, -0.05), (1.00, (-0.34, -0.11, 0.11, 0.34), 0.230, 0.064, 0.0),
                                   (0.84, (-0.42, -0.14, 0.14, 0.42), 0.240, 0.064, 0.0)):
        for th in thetas:
            d = np.array([math.sin(th), math.cos(th), dz])
            out.append((C.tuft(nm('Chest'), TORSO, (0, 0, z0), d, (math.sin(th) * 0.25 + (rng.random() - 0.5) * 0.2, 0.0, -1.0), ln * jit(), wd,
                               thick=wd * 0.85, lift=0.16, embed=0.035, bend=0.18, **LK), w_trunk))
    for z0, n, off, ln, wd in ((0.66, 12, 0.0, 0.250, 0.064), (0.52, 13, 0.26, 0.260, 0.066)):
        for i in range(n):
            th = off + i * C.TAU / n + (rng.random() - 0.5) * 0.15
            d = np.array([math.sin(th), math.cos(th), -0.10])
            out.append((C.tuft(nm('Skirt'), TORSO, (0, 0, z0), d, (math.sin(th) * 0.22, math.cos(th) * 0.22, -1.0), ln * jit(), wd, thick=wd * 0.85,
                               lift=0.20 * jit(0.3), embed=0.04, bend=0.18, **LK), w_trunk))
    # cuffs of shag over the feet
    for s in (-1, 1):
        sd = 'R' if s > 0 else 'L'
        a = HIP * np.array([s, 1, 1]); b = ANKLE * np.array([s, 1, 1])
        ax = b - a
        for ph in (-0.9, -0.2, 0.5, 1.2, 1.9, 2.6, 3.3):  # all round, but not where the legs face each other
            phi = ph if s > 0 else math.pi - ph
            out.append((C.limb_tuft(nm('Shin' + sd), a, ax, 0.20 * jit(0.08), phi, 0.180, 0.190 * jit(), 0.060, thick=0.050, lift=0.26,
                                    embed=0.04, bend=0.18, **LK), lambda P, s=s: w_leg(P, s)))
    return out


def make_vest_trim(JP):
    """Fleece hem and the piping down both front edges. JP: the vest's grid of points (rows = heights)."""
    parts = []
    hem = JP[0].copy()
    hem = hem + C.outward(hem) * 0.006 + np.array([0, 0, -0.014])
    parts.append((C.tube('Hem', hem, lambda t, th: (0.044 * np.cos(th), 0.044 * np.sin(th)), nu=7, n=40), 'fleece'))
    for col, nm in ((0, 'PipingR'), (-1, 'PipingL')):
        edge = JP[:, col].copy()
        edge = (edge - C.outward(edge) * 0.004)[1:-1]
        parts.append((C.tube(nm, edge, lambda t, th: (0.022 * np.cos(th), 0.022 * np.sin(th)), nu=6, n=22, ref=(0, 1, 0)), 'piping'))
    return parts


# ───────────────────────── rig ─────────────────────────

def w_trunk(P):
    z = P[:, 2]
    head = sstep(1.23, 1.36, z)
    chest = sstep(0.52, 0.96, z) * (1 - head)
    body = (1 - sstep(0.52, 0.96, z)) * (1 - head)
    return {'body': body, 'chest': chest, 'head': head}


def w_all(P, bone):
    return {bone: np.ones(len(P))}


def w_arm(P, s):
    sd = 'R' if s > 0 else 'L'
    d = (P - arm_point(s, 0.0)) @ arm_axis(s)
    fore = sstep(ELBOW_D - 0.08, ELBOW_D + 0.08, d)
    hand = sstep(WRIST_D - 0.02, WRIST_D + 0.07, d)
    return {f'arm{sd}': 1 - fore, f'forearm{sd}': fore * (1 - hand), f'hand{sd}': fore * hand}


def w_leg(P, s):
    sd = 'R' if s > 0 else 'L'
    k = sstep(0.14, 0.40, P[:, 2])
    return {f'foot{sd}': 1 - k, 'body': k}


class Yeti(C.Build):
    name = 'yeti'
    mesh_name = 'Yeti'
    height = HEIGHT
    face_z = 1.48
    face_zoom = 1.0
    eyes = EYE
    material_of = {'fur_head': 'Yeti', 'fur_body': 'Yeti', 'fur_arm': 'Yeti', 'fur_leg': 'Yeti', 'foot': 'Yeti', 'ear': 'Yeti', 'nose': 'Yeti',
                   'jaw': 'Yeti', 'lid': 'Yeti', 'tuft': 'Yeti', 'tooth': 'Yeti', 'eye': 'Eye', 'fleece': 'Yeti', 'piping': 'Yeti',
                   'mittencuff': 'Yeti', 'jacket': 'TeamJacket', 'scarf': 'TeamScarf', 'scarftail0': 'TeamScarf',
                   'scarftail1': 'TeamScarf', 'mitten': 'Mitten'}
    density = {'Head': 1.35, 'EyeL': 2.4, 'EyeR': 2.4, 'Nose': 1.4, 'Jaw': 1.1, 'LidL': 0.9, 'LidR': 0.9, 'ToothL': 1.2, 'ToothR': 1.2,
               'Torso': [0.8, 0.9, 0.5], 'ScarfRing': 0.85, 'Hem': 0.7, 'PipingL': 0.8, 'PipingR': 0.8, 'LegL': 0.8, 'LegR': 0.8}

    def __init__(self):
        self.scarf = None
        self.vest_f = None

    def parts(self):
        parts = []
        hd = lambda P: w_all(P, 'head')  # noqa: E731
        jw = lambda P: w_all(P, 'jaw')  # noqa: E731
        parts.append((make_head(), 'fur_head', hd))
        torso = C.torso_patches('Torso', TORSO, (0, 0, 0.60), (0, 0, 1.08), JK_ZB + 0.11, JK_ZT - 0.13,
                                wedge=gap_half_angle(JK_ZB) + 0.42, nu=44, nv=40, cap_r=0.36)
        C.lumpy(torso, 0.010, 17.0, 1.0)
        parts.append((torso, 'fur_body', w_trunk))
        parts.append((make_nose(), 'nose', hd))
        parts.append((make_jaw(), 'jaw', jw))
        for s in (-1, 1):
            sd = 'R' if s > 0 else 'L'
            parts.append((make_tooth(s), 'tooth', jw))
            parts.append((C.make_eye(EYE, s), 'eye', hd))
            parts.append((C.make_lid(EYE, s), 'lid', lambda P, sd=sd: w_all(P, 'lid' + sd)))
            parts.append((make_ear(s), 'ear', hd))
            parts.append((make_arm(s), 'fur_arm', lambda P, s=s: w_arm(P, s)))
            parts.append((C.arm_ring('MittenCuff' + sd, arm_point(s, WRIST_D + 0.035), arm_axis(s), 0.132, 0.146, 0.046, 0.066, n=24, nu=8),
                          'mittencuff', lambda P, sd=sd: w_all(P, 'hand' + sd)))
            parts.append((C.make_mitten('Mitten' + sd, arm_point(s, HAND_D + 0.012 * MITTEN_K), arm_axis(s), MITTEN_K, s), 'mitten',
                          lambda P, sd=sd: w_all(P, 'hand' + sd)))
            parts.append((make_leg(s), 'fur_leg', lambda P, s=s: w_leg(P, s)))
            parts.append((make_foot(s), 'foot', lambda P, sd=sd: w_all(P, 'foot' + sd)))
        for ob, wf in make_tufts():
            parts.append((ob, 'tuft', wf))
        vest, JP, vf = C.make_puffer('Vest', TORSO, JK_ZB, JK_ZT, BAFFLE, gap=gap_half_angle, nz=31, nt=46, base=0.022, puff=0.020)
        self.vest_f = vf
        parts.append((vest, 'jacket', w_trunk))
        for ob, lk in make_vest_trim(JP):
            parts.append((ob, lk, w_trunk))
        parts += self.make_scarf().parts(ring_w={'chest': 0.7, 'head': 0.3})
        return parts

    def make_scarf(self):
        if self.scarf is None:
            a0 = math.radians(150)
            ring_r = C.radius_fn(self.vest_f)  # under the jowls, not round them
            rk = float(ring_r(SCARF_Z, a0)[0, 0]) + 0.050
            knot = np.array([math.sin(a0) * rk, math.cos(a0) * rk, SCARF_Z])
            dressed = C.radius_fn(self.vest_f)

            def hang(specs):
                pts = []
                for da, dz, off in specs:
                    a = a0 + da; z = SCARF_Z + dz
                    r = float(dressed(z, a)[0, 0]) + off
                    pts.append(np.array([math.sin(a) * r, math.cos(a) * r, z]) - knot)
                return pts
            tails = [hang([(-0.05, 0.0, 0.02), (0.05, -0.05, 0.050), (0.09, -0.20, 0.045), (0.11, -0.40, 0.045), (0.10, -0.60, 0.060)]),
                     hang([(-0.07, 0.0, 0.02), (-0.17, -0.04, 0.050), (-0.27, -0.16, 0.045), (-0.33, -0.33, 0.045), (-0.36, -0.48, 0.058)])]
            self.scarf = C.Scarf(ring_r, SCARF_Z, knot, tails, k=SCARF_K, dip=SCARF_DIP)
        return self.scarf

    def bones(self):
        b = [
            ('root', (0, 0, 0), None),
            ('body', (0, 0, 0), 'root'),
            ('chest', (0, 0, 0.76), 'body'),
            ('head', (0, 0.02, 1.28), 'chest'),
            ('hat', tuple(HAT_BONE), 'head'),
            ('jaw', JAW_PIVOT, 'head'),
            ('tail', (0, -0.33, 0.50), 'body'),
            ('footL', tuple(FOOT * (-1, 1, 1)), 'root'),
            ('footR', tuple(FOOT), 'root'),
        ]
        for s, sd in ((-1, 'L'), (1, 'R')):
            b.append((f'lid{sd}', tuple(EYE.centre(s)), 'head'))
            b.append((f'arm{sd}', tuple(arm_point(s, 0.0)), 'chest'))
            b.append((f'forearm{sd}', tuple(arm_point(s, ELBOW_D)), f'arm{sd}'))
            b.append((f'hand{sd}', tuple(arm_point(s, WRIST_D + 0.04)), f'forearm{sd}'))
        return b + self.make_scarf().bones()

    def looks(self, tint):
        sc = self.make_scarf()
        d = dict(fur_head=look_head, fur_body=look_body, fur_arm=look_arm, fur_leg=look_body, foot=look_foot, ear=look_ear, nose=look_nose,
                 jaw=look_jaw, lid=look_lid, tuft=look_tuft, tooth=look_tooth,
                 eye=C.eye_look(EYE, iris_in='#3a1c06', iris_out='#d08a22', iris_r=0.50, pupil_r=0.30, sclera=('#fbfcff', '#c3cada')),
                 fleece=L.fleece, piping=L.piping, mittencuff=L.mittencuff,
                 jacket=C.tinted(C.quilt_look(JK_ZB, BAFFLE, 0.46), tint),
                 scarf=C.tinted(C.scarf_look, tint), mitten=C.tinted(L.mitten, tint, 0.9))
        for w in (0, 1):
            d[f'scarftail{w}'] = C.tinted(C.scarf_tail_look(length=sc.tail_length(w), stripes=((0.07, 0.024), (0.14, 0.012))), tint)
        return d

    def export_materials(self, paths):
        return {
            'Yeti': B.export_material('Yeti', paths, sheen=0.35, sheen_rough=0.55, sheen_tint=(0.48, 0.56, 0.68)),
            'Eye': B.export_material('Eye', paths, coat=1.0, coat_rough=0.03),
            'TeamJacket': B.export_material('TeamJacket', paths, tint=(0.03, 0.26, 1.0)),
            'TeamScarf': B.export_material('TeamScarf', paths, tint=(0.03, 0.26, 1.0), sheen=0.3, sheen_rough=0.7),
            'Mitten': B.export_material('Mitten', paths, tint=(0.12, 0.38, 1.0), sheen=0.3, sheen_rough=0.7),
        }

    def facts(self):
        jr = C.radius_fn(self.vest_f)
        zc = 0.98; a = 0.55  # the chest itself is bare fur down the middle; this is on the vest's front panel
        r = float(jr(zc, a)[0, 0])
        chest = np.array([math.sin(a) * r, math.cos(a) * r, zc])
        cheek = C.hit(HEAD, HEAD_C + (0, 0.05, -0.06), (-0.60, 0.74, -0.30))
        tr = C.radius_fn(TORSO)
        zb = 0.66; ab = -0.45
        rb = float(tr(zb, ab)[0, 0])
        belly = np.array([math.sin(ab) * rb, math.cos(ab) * rb, zb])
        by = JK_ZB + 0.055
        return dict(armRest=ARM_REST, eyeYaw=EYE.yaw, lidOpen=C.LID_OPEN, height=round(HEIGHT, 3), hatScale=HAT_SCALE,
                    chestFront=chest, cheek=cheek, belly=belly,
                    belt=dict(y=round(by, 3), rx=round(float(jr(by, math.pi / 2)[0, 0]), 3), rz=round(float(jr(by, math.pi)[0, 0]), 3)),
                    handTip=round(HAND_D + 0.012 * MITTEN_K, 3))


# ───────────────────────── looks ─────────────────────────
LIGHT = '#fafcfe'   # sunlit fur: icy white with a breath of blue
SHADE = '#d0dcee'   # down in the shag
DEEP = '#b4c6e0'    # the coat's blue undertone, in broad soft patches
SKIN = '#8fa2ca'    # bare leathery face, ears and feet
SKIN_DARK = '#6a7dab'
SKIN_LIGHT = '#b6c5e2'


def coat(p, fr):
    """Shaggy ice-blue fur: long soft clumps, bluer down in the coat."""
    n = noise(p, 4.0, 2.0, 0.5)
    sh = lerp(rgb(SHADE), rgb(DEEP), smooth(0.40, 0.80, n) * 0.6)
    return lerp(sh, rgb(LIGHT), fr['shade'])


def shag(pa):
    return C.soft_fur(pa, clump=20.0, strand=150.0, depth=0.0075, fine=0.0016)


def leather(p, light=0.0):
    n = noise(p, 55.0, 3.0, 0.6)
    pore = noise(p, 260.0, 2.0)
    col = lerp(rgb(SKIN_DARK), rgb(SKIN), smooth(0.25, 0.75, n) * 0.5 + 0.5)
    return col, (pore - 0.5) * 0.0007 + (n - 0.5) * 0.0010, 0.50 + (n - 0.5) * 0.14


def sq(x):
    return x * x


def look_head(g):
    p = g.P()
    pm = Vec((absv(p.x), p.y, p.z))
    fr = shag(C.flow_down(p, 0.2))
    fur = coat(p, fr)
    skin, sh, srough = leather(p)
    wob = (noise(p, 26.0, 2.0) - 0.5) * 0.10
    # the bare face: a rounded heart from the brow down to the chin, with a ragged furry edge
    fd = ((sq(p.x / (0.232 + 0.050 * smooth(1.42 + FZ, 1.56 + FZ, p.z))) + sq((p.z - 1.500 - FZ) / 0.205)) ** 0.5) + wob
    face = smooth(1.04, 0.92, fd) * smooth(FACE_Y - 0.085, FACE_Y - 0.045, p.y)
    # the brow ridge is furry: a thick white eyebrow over each eye
    bt = clamp01((pm.x - float(BROW_IN[0])) / float(BROW_OUT[0] - BROW_IN[0]))
    bz = float(BROW_IN[2]) + bt * float(BROW_OUT[2] - BROW_IN[2])
    face = face * smooth(bz - 0.016 + wob * 0.15, bz - 0.030 + wob * 0.15, p.z)
    # lighter on the muzzle and the brow, darker in the eye hollows
    mz = smooth(1.25, 0.70, ell(p, tuple(MUZ_C), tuple(MUZ_R)))
    skin = lerp(skin, rgb(SKIN_LIGHT), mz * 0.75)
    hollow = smooth(1.25, 0.95, ell(pm, (EYE.x, FACE_Y, EYE.z), (0.074, 0.09, 0.086)))  # a thin soft liner round each eye
    skin = lerp(skin, rgb(SKIN_DARK), hollow * 0.45)
    blush = 1.0 - smooth(0.0, 1.0, ell(pm, (0.205, FACE_Y + 0.01, 1.452 + FZ), (0.050, 0.08, 0.030)))
    skin = lerp(skin, rgb('#b48fc0'), blush * 0.55)
    # the mouth: its roof is under the jaw, and a lip line where they meet
    jd = ell(p, tuple(JAW_C), tuple(JAW_R))
    lipz = LIP_Z + LIP_K * sq(p.x)
    under = smooth(lipz + 0.012, lipz + 0.002, p.z)
    skin = lerp(skin, rgb('#2c3d57'), smooth(1.06, 1.0, jd) * bump_band(lipz + 0.004, 0.010, p.z) * 0.9)
    skin = lerp(skin, rgb('#2a1230'), smooth(1.0, 0.95, jd) * under)
    # the corners of the mouth turn up
    sm = bump_band(0.0, 0.006, (p.z - 1.447 - MZ) - sq(pm.x - 0.125) * 6.0 - (pm.x - 0.125) * 0.45) * smooth(0.125, 0.140, pm.x) * smooth(0.192, 0.176, pm.x)
    skin = lerp(skin, rgb('#2c3d57'), sm * 0.85)
    col = lerp(fur, skin, face)
    h = lerp(fr['height'], sh, face)
    rough = lerp(0.66 + (fr['strand'] - 0.5) * 0.10, srough, face)
    return dict(color=col, rough=rough, height=h + L.fuzz(p, 0.0004))


def look_body(g):
    p = g.P()
    fr = shag(C.flow_down(p, 0.16))
    return dict(color=coat(p, fr), rough=0.66 + (fr['strand'] - 0.5) * 0.10, height=fr['height'] + L.fuzz(p, 0.0004))


def look_arm(g):
    p = g.P()
    fr = shag(C.flow_along(p, ARM_DIR, 0.16))
    return dict(color=coat(p, fr), rough=0.66 + (fr['strand'] - 0.5) * 0.10, height=fr['height'] + L.fuzz(p, 0.0004))


def look_foot(g):
    p = g.P()
    pm = Vec((absv(p.x), p.y, p.z))
    heel, fwd, side = foot_frame(1)
    q = pm - Vec(tuple(heel))
    u = q.dot(Vec(tuple(side))); v = q.dot(Vec(tuple(fwd)))
    col, h, rough = leather(p)
    col = lerp(col, rgb(SKIN_LIGHT), smooth(0.05, 0.16, p.z) * 0.5)
    col = lerp(col, rgb('#3d5270'), smooth(0.022, 0.006, p.z) * 0.8)  # the sole
    # creases between the toes and big pale toenails
    nail = V(0.0)
    for _k, tu, tv, r in TOES:
        d = (sq((u + tu) / (r * 0.50)) + sq((v - tv - r * 0.74) / (r * 0.42)) + sq((p.z - 0.066 - r * 0.50) / 0.034)) ** 0.5
        nail = vmax(nail, smooth(1.0, 0.82, d))
    col = lerp(col, lerp(rgb('#cfd3de'), rgb('#eef0f4'), noise(p, 40.0)), nail)
    return dict(color=col, rough=lerp(rough, 0.25, nail), height=h * (1.0 - nail) + nail * 0.0025)


def look_ear(g):
    p = g.P()
    pm = Vec((absv(p.x), p.y, p.z))
    col, h, rough = leather(p)
    fwd = np.array([math.sin(EAR_YAW), math.cos(EAR_YAW), 0.0])
    d = (pm - Vec(tuple(EAR_C + fwd * EAR_DISH))).length()
    inner = smooth(0.092, 0.070, d)
    col = lerp(lerp(col, rgb(SKIN_LIGHT), 0.35), rgb('#8a79a8'), inner * 0.8)
    return dict(color=col, rough=rough, height=h)


def look_nose(g):
    p = g.P()
    n = noise(p, 200.0, 2.0)
    col = lerp(rgb('#1f2c40'), rgb('#3c5070'), smooth(1.51 + MZ, 1.56 + MZ, p.z) * 0.8 + (n - 0.5) * 0.3)
    pm = Vec((absv(p.x), p.y, p.z))
    nostril = 1.0 - smooth(0.0, 1.0, ell(pm, (0.024, float(NOSE_C[1]) + 0.026, float(NOSE_C[2]) - 0.008), (0.012, 0.02, 0.010)))
    col = lerp(col, rgb('#0b1018'), nostril)
    return dict(color=col, rough=0.28 + n * 0.10, height=(n - 0.5) * 0.0006 - nostril * 0.002)


def look_jaw(g):
    p = g.P()
    col, h, rough = leather(p)
    col = lerp(col, rgb(SKIN_LIGHT), smooth(1.36 + MZ, 1.44 + MZ, p.z) * 0.6)
    md = ell(p, tuple(MUZ_C), (float(MUZ_R[0]), float(MUZ_R[1]), float(MUZ_R[2])))
    inside = smooth(1.03, 0.96, md) * smooth(1.40 + MZ, 1.425 + MZ, p.z)  # the part tucked up into the muzzle
    tongue = smooth(1.0, 0.8, ell(p, (0.0, 0.35, 1.455 + MZ), (0.075, 0.085, 0.03)))
    mouth = lerp(rgb('#2a1230'), rgb('#e0708a'), tongue)
    col = lerp(col, rgb('#2c3d57'), bump_band(1.04, 0.06, md) * 0.6)
    col = lerp(col, mouth, inside)
    return dict(color=col, rough=lerp(rough, 0.35, inside), height=h * (1.0 - inside))


def look_lid(g):
    p = g.P()
    n = noise(p, 60.0, 2.0)
    return dict(color=lerp(rgb(SKIN), rgb(SKIN_LIGHT), 0.3 + 0.5 * n), rough=0.5, height=(n - 0.5) * 0.0006)


def look_tooth(g):
    p = g.P()
    n = noise(p * Vec((1.0, 1.0, 0.2)), 90.0, 2.0)
    col = lerp(rgb('#e9dcb8'), rgb('#fffaec'), smooth(1.43 + MZ, 1.47 + MZ, p.z) * 0.7 + n * 0.3)
    return dict(color=col, rough=0.22 + n * 0.08, height=(n - 0.5) * 0.0004)


def look_tuft(g):
    p = g.P(); uv = g.uv('param')
    st = noise(Vec((uv.x / 0.0042, uv.y / 0.16, p.x * 3.0)), 1.0, 2.0, 0.55)
    st2 = noise(Vec((uv.x / 0.011, uv.y / 0.22, p.z * 3.0 + 5.0)), 1.0, 2.0, 0.5)
    fr = dict(shade=smooth(0.30, 0.70, st * 0.55 + st2 * 0.45) * smooth(-0.04, 0.12, uv.y), strand=st)
    return dict(color=coat(p, fr), rough=0.66, height=(st - 0.5) * 0.0020 + (st2 - 0.5) * 0.0030 + L.fuzz(p, 0.0004))


if __name__ == '__main__':
    C.run(Yeti(), HERE)
