"""The polar bear: the bruiser. Sculpted, dressed in the penguin's wardrobe, textured, rigged and exported as
polarbear.glb (+ polarbear.json, the rig facts the game needs).

    python tools/blender/polarbear.py             # build + bake + export to src/assets/models/polarbear.glb
    python tools/blender/polarbear.py --size=1024 # quicker draft
    python tools/blender/polarbear.py --shapes    # quick un-baked renders of the sculpt and looks (--grey: clay)

Blender space: the bear faces +Y, up is +Z, its right arm is at +X. Same skeleton as the penguin (see bones()).
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
HAT_SCALE = 1.15  # the top of the skull is the penguin's head dome, this much bigger, so every hat fits
HEAD_C = np.array([0.0, 0.02, 1.14])
HEAD_R = np.array([0.298, 0.286, 0.270]) * HAT_SCALE
HEIGHT = float(HEAD_C[2] + HEAD_R[2])
HAT_BONE = HEAD_C + np.array([0.0, -0.012, 0.182]) * HAT_SCALE
MUZ_C = np.array([0.0, 0.365, 1.052]); MUZ_R = np.array([0.150, 0.172, 0.112])
JAW_C = np.array([0.0, 0.345, 0.980]); JAW_R = np.array([0.100, 0.140, 0.050])
JAW_PIVOT = (0.0, 0.225, 0.995)
NOSE_C = np.array([0.0, 0.522, 1.100])
EAR_C = np.array([0.258, -0.03, 1.385])
ARM_REST = 0.62
SHOULDER = np.array([0.385, -0.015, 0.695])
ARM_DIR = np.array([math.sin(ARM_REST), 0.0, -math.cos(ARM_REST)])
ELBOW_D, WRIST_D, HAND_D = 0.175, 0.305, 0.415
MITTEN_K = 1.25
HIP = np.array([0.205, -0.01, 0.40]); ANKLE = np.array([0.215, 0.025, 0.10])
FOOT = np.array([0.215, 0.03, 0.0]); FOOT_YAW = 0.22
JK_ZB, JK_ZT = 0.355, 0.775
BAFFLE = (JK_ZT - JK_ZB) / 5
SCARF_Z, SCARF_K = 0.805, 1.12
TAIL_C = np.array([0.0, -0.475, 0.300])


def gap_half_angle(z):
    """Half-angle of the jacket's open front: zipped shut over the belly, falling open below the scarf."""
    return 0.030 + 0.26 * sstep(0.60, JK_ZT, z) ** 1.3


def torso_sdf():
    main = G.ellipsoid((0, -0.01, 0.55), (0.455, 0.410, 0.330))
    belly = G.ellipsoid((0, 0.07, 0.50), (0.410, 0.390, 0.300))
    rump = G.ellipsoid((0, -0.07, 0.44), (0.420, 0.385, 0.260))
    back = G.ellipsoid((0, -0.05, 0.66), (0.410, 0.345, 0.200))  # a bear's big round shoulders
    neck = G.capsule((0, 0.0, 0.74), (0, 0.01, 0.92), 0.235, 0.22)
    return G.add(G.union(0.10, main, belly, rump, back), neck, 0.07)


def head_sdf():
    skull = G.ellipsoid(HEAD_C, HEAD_R)
    f = skull
    for s in (-1, 1):
        f = G.add(f, G.sphere((s * 0.175, 0.125, 1.020), 0.185), 0.09)  # chubby cheeks: the face is widest low down
    f = G.add(f, G.ellipsoid(MUZ_C, MUZ_R), 0.060)
    f = G.add(f, G.capsule((0, 0.25, 1.175), (0, 0.45, 1.115), 0.085, 0.062), 0.06)  # the bridge of the nose
    return f


TORSO = torso_sdf()
HEAD = head_sdf()
TRUNK = G.union(0.03, TORSO, HEAD)
TRUNK_R = C.radius_fn(TRUNK)


def _eye():
    x, z, rx, r = 0.150, 1.200, 0.077, 0.098
    surf = C.hit(HEAD, (x, 0.0, z), (0, 1, 0))
    return C.Eye(x, float(surf[1]) - r + 0.020, z, rx, r, 0.30)


EYE = _eye()


def arm_point(s, d, fwd=0.0):
    p = SHOULDER + ARM_DIR * d
    p[1] += fwd
    p[0] *= s
    return p


def arm_axis(s):
    return ARM_DIR * np.array([s, 1, 1])


# ───────────────────────── parts ─────────────────────────

def make_head():
    g = G.blob(HEAD, HEAD_C + (0, -0.02, 0.0), (0, 0.215, 1.085), nu=52, nv=40, ref=(0, 0, -1), cap_r=0.30, tmax=1.0)
    return G.build_mesh('Head', g)


EAR_DISH = 0.096


def make_ear(s):
    c = EAR_C * np.array([s, 1, 1])
    yaw = s * 0.30
    Rm = np.array([[math.cos(yaw), math.sin(yaw), 0], [-math.sin(yaw), math.cos(yaw), 0], [0, 0, 1]]).T
    fwd = Rm[:, 1]
    ear = G.ellipsoid(c, (0.112, 0.060, 0.112), Rm)
    dish = G.sphere(c + fwd * EAR_DISH, 0.072)
    f = G.cut(ear, dish, 0.024)
    g = G.blob(f, c, nu=20, nv=14, ref=tuple(fwd), cap_r=0.08, tmax=0.4)
    return G.build_mesh('Ear' + ('R' if s > 0 else 'L'), g)


def make_nose():
    top = G.ellipsoid(NOSE_C, (0.072, 0.046, 0.048))
    low = G.sphere(NOSE_C + (0, 0.004, -0.032), 0.034)
    f = G.add(top, low, 0.03)
    return G.build_mesh('Nose', G.blob(f, NOSE_C + (0, -0.01, -0.005), nu=20, nv=12, ref=(0, 0, 1), cap_r=0.05, tmax=0.3))


def make_jaw():
    f = G.ellipsoid(JAW_C, JAW_R)
    g = G.blob(f, JAW_C + (0, -0.03, 0), JAW_C + (0, 0.03, 0), nu=22, nv=14, ref=(0, 0, 1), cap_r=0.08, tmax=0.5)
    return G.build_mesh('Jaw', g)


def make_arm(s):
    ds = np.linspace(-0.02, WRIST_D + 0.03, 11)
    path = np.array([arm_point(s, d) for d in ds])

    def section(t, th):
        d = -0.02 + t * (WRIST_D + 0.05)
        r = 0.124 + 0.012 * math.exp(-((d - 0.20) / 0.09) ** 2) - 0.020 * sstep(0.24, 0.33, d)
        return r * 0.96 * np.cos(th), r * 1.04 * np.sin(th)
    g = G.sweep(path, section, nu=14, ref=(0, 1, 0), cap=True, cap_rows=3)
    return G.build_mesh('Arm' + ('R' if s > 0 else 'L'), g)


SLEEVE_END = 0.105


def make_sleeve(s):
    """A short puffy cap sleeve: one baffle, riding on the arm so the shoulder can turn any way."""
    ds = np.linspace(-0.05, SLEEVE_END, 6)
    path = np.array([arm_point(s, d) for d in ds])

    def section(t, th):
        fr = np.clip(t, 0, 1)
        puff = 1.0 - abs(2 * fr - 1) ** 2.4
        r = 0.142 + 0.020 * puff
        return r * 0.97 * np.cos(th), r * 1.05 * np.sin(th)
    g = G.sweep(path, section, nu=14, ref=(0, 1, 0), cap=True, cap_rows=2)
    return G.build_mesh('Sleeve' + ('R' if s > 0 else 'L'), g)


def make_leg(s):
    a = HIP * np.array([s, 1, 1]); b = ANKLE * np.array([s, 1, 1])
    path = np.array([a + (b - a) * t for t in np.linspace(0, 1, 7)])
    g = G.sweep(path, lambda t, th: ((0.172 - 0.020 * t) * np.cos(th), (0.178 - 0.022 * t) * np.sin(th)), nu=14, ref=(0, 1, 0), cap=True, cap_rows=3)
    return G.build_mesh('Leg' + ('R' if s > 0 else 'L'), g)


def foot_frame(s):
    a = s * FOOT_YAW
    fwd = np.array([math.sin(a), math.cos(a), 0.0])
    side = np.array([math.cos(a), -math.sin(a), 0.0])
    return FOOT * np.array([s, 1, 1]), fwd, side


def make_foot(s):
    heel, fwd, side = foot_frame(s)
    Rm = np.stack([side, fwd, np.array([0, 0, 1.0])], axis=1)
    c = heel + fwd * 0.085 + np.array([0, 0, 0.072])
    f = G.ellipsoid(c, (0.142, 0.200, 0.100), Rm)
    for k in (-1, 0, 1):
        tc = heel + fwd * (0.235 - 0.022 * abs(k)) + side * (k * 0.088) + np.array([0, 0, 0.058])
        f = G.add(f, G.sphere(tc, 0.062), 0.035)
    f = G.clip(f, G.plane((0, 0, -1), -0.004), 0.016)  # a flat sole
    g = G.blob(f, c - fwd * 0.05, c + fwd * 0.07, nu=24, nv=14, ref=(0, 0, 1), cap_r=0.10, tmax=0.6)
    return G.build_mesh('Foot' + ('R' if s > 0 else 'L'), g)


def make_tail():
    f = G.ellipsoid(TAIL_C, (0.108, 0.100, 0.100))
    ob = G.build_mesh('Tail', G.blob(f, TAIL_C, nu=16, nv=10, ref=(0, 0, 1), cap_r=0.08, tmax=0.4))
    C.lumpy(ob, 0.008, 50.0, 2.0)
    return ob


def make_tufts():
    """Sculpted fur where the outline needs it. → [(object, weights)]"""
    out = []
    hd = lambda P: {'head': np.ones(len(P))}  # noqa: E731
    o = HEAD_C + np.array([0, 0.06, -0.10])
    k = 0
    for s in (-1, 1):
        # cheek ruffs: soft locks sweeping out and down from each cheek
        for dr, fl, ln, wd in (((1.0, 0.20, -0.12), (0.80, -0.05, -0.60), 0.125, 0.070),
                               ((1.0, 0.08, -0.42), (0.60, -0.05, -0.80), 0.135, 0.074),
                               ((1.0, 0.36, -0.58), (0.40, 0.05, -1.0), 0.110, 0.064),
                               ((1.0, -0.22, -0.30), (0.65, -0.35, -0.70), 0.115, 0.066)):
            d = np.array(dr) * (s, 1, 1); f = np.array(fl) * (s, 1, 1)
            out.append((C.tuft(f'Cheek{k}', HEAD, o, d, f, ln, wd, thick=wd * 0.62, lift=0.26, embed=0.04, bend=0.10), hd)); k += 1
        # a tuft in each ear
        yaw = s * 0.30
        fwd = np.array([math.sin(yaw), math.cos(yaw), 0.0])
        ec = EAR_C * (s, 1, 1)
        for j, (dx, ln) in enumerate(((-0.030, 0.085), (0.022, 0.070))):
            root = ec + fwd * 0.012 + np.array([s * dx, 0, -0.085])
            tip = ec + fwd * 0.050 + np.array([s * dx * 1.3, 0, -0.085 + ln])
            out.append((C.lock(f'EarTuft{k}', root, tip, 0.030, 0.020, fwd, bend=0.12, nu=6, n=5), hd)); k += 1
    # haunches: fluff over the tops of the legs, below the jacket's hem
    o = np.array([0, 0, 0.40])
    for s in (-1, 1):
        for dr, ln, wd in (((1.0, -0.15, -0.34), 0.120, 0.066), ((0.85, -0.55, -0.37), 0.115, 0.064), ((1.0, 0.30, -0.37), 0.110, 0.062),
                           ((0.55, -0.9, -0.39), 0.110, 0.062)):
            d = np.array(dr) * (s, 1, 1)
            fl = np.array([d[0] * 0.45, d[1] * 0.45, -1.0])
            out.append((C.tuft(f'Haunch{k}', TORSO, o, d, fl, ln, wd, thick=wd * 0.6, lift=0.30, embed=0.04, bend=0.10), w_trunk)); k += 1
    # the ruff of the chest, showing where the zip falls open
    o = np.array([0, 0, 0.70])
    for dx, dz, ln, wd in ((0.0, 0.0, 0.130, 0.062), (-0.075, 0.03, 0.110, 0.056), (0.075, 0.03, 0.110, 0.056)):
        out.append((C.tuft(f'Chest{k}', TORSO, o + (0, 0, dz), (dx * 3.0, 1.0, 0.0), (dx * 0.6, 0.0, -1.0), ln, wd, thick=wd * 0.6, lift=0.22,
                           embed=0.03, bend=0.10), w_trunk)); k += 1
    # elbows
    for s in (-1, 1):
        sd = 'R' if s > 0 else 'L'
        ax = arm_axis(s)
        for j, (dd, ln, wd) in enumerate(((ELBOW_D - 0.02, 0.100, 0.052), (ELBOW_D + 0.045, 0.085, 0.046))):
            root = arm_point(s, dd) + np.array([s * 0.05, -0.085, 0.045])
            tip = root + ax * ln * 0.75 + np.array([s * 0.035, -0.07, 0.0]) * (ln / 0.1)
            ob = C.lock(f'Elbow{sd}{j}', root, tip, wd, wd * 0.6, (s * 0.5, -0.85, 0.2), bend=0.12)
            out.append((ob, lambda P, s=s: w_arm(P, s))); k += 1
    # a tuft on the tail
    for j, (dx, ln) in enumerate(((0.0, 0.11), (-0.05, 0.085), (0.05, 0.085))):
        root = TAIL_C + np.array([dx, 0.0, 0.02])
        tip = TAIL_C + np.array([dx * 1.5, -0.095 - ln * 0.5, -0.03 - ln * 0.4])
        out.append((C.lock(f'TailTuft{j}', root, tip, 0.050, 0.040, (0, -0.6, 0.8), bend=0.15), lambda P: {'tail': np.ones(len(P))}))
    return out


def make_jacket_trim(JP):
    """Fleece hem and the zip's piping down both front edges. JP: the jacket's grid of points (rows = heights)."""
    parts = []
    hem = JP[0].copy()
    hem = hem + C.outward(hem) * 0.006 + np.array([0, 0, -0.014])
    parts.append((C.tube('Hem', hem, lambda t, th: (0.042 * np.cos(th), 0.042 * np.sin(th)), nu=7, n=40), 'fleece'))
    for col, nm in ((0, 'PipingR'), (-1, 'PipingL')):
        edge = JP[:, col].copy()
        edge = (edge - C.outward(edge) * 0.004)[1:-1]
        parts.append((C.tube(nm, edge, lambda t, th: (0.020 * np.cos(th), 0.020 * np.sin(th)), nu=6, n=22, ref=(0, 1, 0)), 'piping'))
    return parts


# ───────────────────────── rig ─────────────────────────

def w_trunk(P):
    z = P[:, 2]
    head = sstep(0.80, 0.93, z)
    chest = sstep(0.30, 0.66, z) * (1 - head)
    body = (1 - sstep(0.30, 0.66, z)) * (1 - head)
    return {'body': body, 'chest': chest, 'head': head}


def w_all(P, bone):
    return {bone: np.ones(len(P))}


def w_arm(P, s):
    sd = 'R' if s > 0 else 'L'
    d = (P - arm_point(s, 0.0)) @ arm_axis(s)
    fore = sstep(ELBOW_D - 0.06, ELBOW_D + 0.06, d)
    hand = sstep(WRIST_D - 0.02, WRIST_D + 0.06, d)
    return {f'arm{sd}': 1 - fore, f'forearm{sd}': fore * (1 - hand), f'hand{sd}': fore * hand}


def w_leg(P, s):
    sd = 'R' if s > 0 else 'L'
    k = sstep(0.11, 0.31, P[:, 2])
    return {f'foot{sd}': 1 - k, 'body': k}


class Bear(C.Build):
    name = 'polarbear'
    mesh_name = 'PolarBear'
    height = HEIGHT
    face_z = 1.13
    face_zoom = 1.12
    eyes = EYE
    material_of = {'fur_head': 'Bear', 'fur_body': 'Bear', 'fur_arm': 'Bear', 'fur_leg': 'Bear', 'foot': 'Bear', 'ear': 'Bear', 'nose': 'Bear',
                   'jaw': 'Bear', 'lid': 'Bear', 'tuft': 'Bear', 'tail': 'Bear', 'eye': 'Eye', 'fleece': 'Bear', 'piping': 'Bear',
                   'mittencuff': 'Bear', 'jacket': 'TeamJacket', 'sleeve': 'TeamJacket', 'scarf': 'TeamScarf', 'scarftail0': 'TeamScarf',
                   'scarftail1': 'TeamScarf', 'mitten': 'Mitten'}
    density = {'Head': 1.35, 'EyeL': 2.2, 'EyeR': 2.2, 'Nose': 1.5, 'Jaw': 1.0, 'LidL': 0.8, 'LidR': 0.8, 'Torso': [0.7, 0.8, 0.5],
               'ScarfRing': 0.85, 'Hem': 0.7, 'PipingL': 0.8, 'PipingR': 0.8, 'LegL': 0.8, 'LegR': 0.8}

    def __init__(self):
        self.scarf = None
        self.jacket_f = None

    def parts(self):
        parts = []
        hd = lambda P: w_all(P, 'head')  # noqa: E731
        parts.append((make_head(), 'fur_head', hd))
        parts.append((C.torso_patches('Torso', TORSO, (0, 0, 0.42), (0, 0, 0.76), JK_ZB + 0.10, JK_ZT - 0.13,
                                      wedge=gap_half_angle(JK_ZT) + 0.30, nu=44, nv=34, cap_r=0.36), 'fur_body', w_trunk))
        parts.append((make_nose(), 'nose', hd))
        parts.append((make_jaw(), 'jaw', lambda P: w_all(P, 'jaw')))
        parts.append((make_tail(), 'tail', lambda P: w_all(P, 'tail')))
        for s in (-1, 1):
            sd = 'R' if s > 0 else 'L'
            parts.append((C.make_eye(EYE, s), 'eye', hd))
            parts.append((C.make_lid(EYE, s), 'lid', lambda P, sd=sd: w_all(P, 'lid' + sd)))
            parts.append((make_ear(s), 'ear', hd))
            parts.append((make_arm(s), 'fur_arm', lambda P, s=s: w_arm(P, s)))
            parts.append((make_sleeve(s), 'sleeve', lambda P, sd=sd: w_all(P, 'arm' + sd)))
            parts.append((C.arm_ring('SleeveCuff' + sd, arm_point(s, SLEEVE_END + 0.004), arm_axis(s), 0.128, 0.140, 0.036, 0.042), 'fleece',
                          lambda P, sd=sd: w_all(P, 'arm' + sd)))
            parts.append((C.arm_ring('MittenCuff' + sd, arm_point(s, WRIST_D + 0.022), arm_axis(s), 0.094, 0.106, 0.034, 0.050, n=28, nu=10),
                          'mittencuff', lambda P, sd=sd: w_all(P, 'hand' + sd)))
            parts.append((C.make_mitten('Mitten' + sd, arm_point(s, HAND_D + 0.012 * MITTEN_K), arm_axis(s), MITTEN_K, s), 'mitten',
                          lambda P, sd=sd: w_all(P, 'hand' + sd)))
            parts.append((make_leg(s), 'fur_leg', lambda P, s=s: w_leg(P, s)))
            parts.append((make_foot(s), 'foot', lambda P, sd=sd: w_all(P, 'foot' + sd)))
        for ob, wf in make_tufts():
            parts.append((ob, 'tuft', wf))
        jacket, JP, jf = C.make_puffer('Jacket', TORSO, JK_ZB, JK_ZT, BAFFLE, gap=gap_half_angle, nz=31, nt=50, base=0.020, puff=0.017)
        self.jacket_f = jf
        parts.append((jacket, 'jacket', w_trunk))
        for ob, lk in make_jacket_trim(JP):
            parts.append((ob, lk, w_trunk))
        sc = self.make_scarf()
        parts += sc.parts()
        return parts

    def make_scarf(self):
        if self.scarf is None:
            a0 = math.radians(150)
            ring_r = C.radius_fn(G.union(0.03, HEAD, self.jacket_f))
            rk = float(ring_r(SCARF_Z, a0)[0, 0]) + 0.045
            knot = np.array([math.sin(a0) * rk, math.cos(a0) * rk, SCARF_Z])
            dressed = C.radius_fn(self.jacket_f)

            def hang(specs):
                pts = []
                for da, dz, off in specs:
                    a = a0 + da; z = SCARF_Z + dz
                    r = float(dressed(z, a)[0, 0]) + off
                    pts.append(np.array([math.sin(a) * r, math.cos(a) * r, z]) - knot)
                return pts
            tails = [hang([(-0.06, 0.0, 0.02), (0.06, -0.04, 0.045), (0.11, -0.16, 0.040), (0.13, -0.31, 0.040), (0.11, -0.47, 0.050)]),
                     hang([(-0.08, 0.0, 0.02), (-0.20, -0.03, 0.045), (-0.32, -0.13, 0.040), (-0.39, -0.26, 0.040), (-0.43, -0.37, 0.048)])]
            self.scarf = C.Scarf(ring_r, SCARF_Z, knot, tails, k=SCARF_K)
        return self.scarf

    def bones(self):
        b = [
            ('root', (0, 0, 0), None),
            ('body', (0, 0, 0), 'root'),
            ('chest', (0, 0, 0.50), 'body'),
            ('head', (0, 0, 0.86), 'chest'),
            ('hat', tuple(HAT_BONE), 'head'),
            ('jaw', JAW_PIVOT, 'head'),
            ('tail', (0, -0.40, 0.30), 'body'),
            ('footL', tuple(FOOT * (-1, 1, 1)), 'root'),
            ('footR', tuple(FOOT), 'root'),
        ]
        for s, sd in ((-1, 'L'), (1, 'R')):
            b.append((f'lid{sd}', tuple(EYE.centre(s)), 'head'))
            b.append((f'arm{sd}', tuple(arm_point(s, 0.0)), 'chest'))
            b.append((f'forearm{sd}', tuple(arm_point(s, ELBOW_D)), f'arm{sd}'))
            b.append((f'hand{sd}', tuple(arm_point(s, WRIST_D + 0.03)), f'forearm{sd}'))
        return b + self.make_scarf().bones()

    # ── looks ──
    def looks(self, tint):
        sc = self.make_scarf()
        d = dict(fur_head=look_head, fur_body=look_body, fur_arm=look_arm, fur_leg=look_body, foot=look_foot, ear=look_ear, nose=look_nose,
                 jaw=look_jaw, lid=look_lid, tuft=look_tuft, tail=look_body,
                 eye=C.eye_look(EYE, iris_in='#1c0f06', iris_out='#80481a', iris_r=0.84, pupil_r=0.52, sclera=('#f6f8fc', '#a9b1c2')),
                 fleece=L.fleece, piping=L.piping, mittencuff=L.mittencuff,
                 jacket=C.tinted(C.quilt_look(JK_ZB, BAFFLE, 0.44), tint),
                 sleeve=C.tinted(C.sleeve_quilt_look(SHOULDER, ARM_REST, SLEEVE_END + 0.02, -0.02), tint),
                 scarf=C.tinted(C.scarf_look, tint), mitten=C.tinted(L.mitten, tint, 0.9))
        for w in (0, 1):
            d[f'scarftail{w}'] = C.tinted(C.scarf_tail_look(length=sc.tail_length(w)), tint)
        return d

    def export_materials(self, paths):
        return {
            'Bear': B.export_material('Bear', paths, sheen=0.35, sheen_rough=0.55, sheen_tint=(0.60, 0.55, 0.46)),
            'Eye': B.export_material('Eye', paths, coat=1.0, coat_rough=0.03),
            'TeamJacket': B.export_material('TeamJacket', paths, tint=(0.03, 0.26, 1.0)),
            'TeamScarf': B.export_material('TeamScarf', paths, tint=(0.03, 0.26, 1.0), sheen=0.3, sheen_rough=0.7),
            'Mitten': B.export_material('Mitten', paths, tint=(0.12, 0.38, 1.0), sheen=0.3, sheen_rough=0.7),
        }

    def facts(self):
        jr = C.radius_fn(self.jacket_f)
        zc = 0.60
        chest = np.array([0.0, float(jr(zc, 0.0)[0, 0]), zc])
        cheek = C.hit(HEAD, HEAD_C + (0, 0.05, -0.06), (-0.62, 0.74, -0.16))
        zb = 0.46; a = -0.50
        rb = float(jr(zb, a)[0, 0])
        belly = np.array([math.sin(a) * rb, math.cos(a) * rb, zb])
        by = JK_ZB + 0.055
        return dict(armRest=ARM_REST, eyeYaw=EYE.yaw, lidOpen=C.LID_OPEN, height=round(HEIGHT, 3), hatScale=HAT_SCALE,
                    chestFront=chest, cheek=cheek, belly=belly,
                    belt=dict(y=round(by, 3), rx=round(float(jr(by, math.pi / 2)[0, 0]), 3), rz=round(float(jr(by, math.pi)[0, 0]), 3)),
                    handTip=round(HAND_D + 0.012 * MITTEN_K, 3))


# ───────────────────────── looks ─────────────────────────
LIGHT = '#fcf7ec'   # sunlit fur: a clean creamy white
SHADE = '#e7dcc6'   # down in the coat
WARM = '#f4e8d0'    # where the coat yellows a little


def coat(p, fr, light=None):
    """Soft cream fur: barely-there clumps and strands, with broad, gentle warm patches."""
    n = noise(p, 4.5, 2.0, 0.5)
    lt = lerp(rgb(LIGHT), rgb(WARM), smooth(0.42, 0.78, n) * 0.6)
    if light is not None:
        lt = light(lt)
    return lerp(rgb(SHADE), lt, fr['shade'])


def look_head(g):
    p = g.P()
    pm = Vec((absv(p.x), p.y, p.z))
    fr = C.soft_fur(C.flow_down(p, 0.22))
    muz = smooth(1.30, 0.90, ell(p, tuple(MUZ_C), tuple(MUZ_R)))
    col = coat(p, fr, lambda t: lerp(t, rgb('#fffdf8'), muz * 0.85))
    h = fr['height'] * (1.0 - muz * 0.6)
    # the mouth: its roof is under the jaw (you see it when the jaw drops), with a soft lip line where the two meet
    jd = ell(p, tuple(JAW_C), tuple(JAW_R))
    col = lerp(col, rgb('#5a3c36'), bump_band(1.015, 0.05, jd) * 0.9)
    col = lerp(col, rgb('#3d0f1a'), smooth(1.0, 0.95, jd))
    # the split of the lip, from nose to mouth
    lip = (1.0 - smooth(0.003, 0.0075, absv(p.x))) * smooth(0.46, 0.50, p.y) * smooth(1.070, 1.058, p.z) * smooth(0.99, 1.02, jd)
    col = lerp(col, rgb('#5a3c36'), lip * 0.85)
    # blush
    blush = 1.0 - smooth(0.0, 1.0, ell(pm, (0.235, 0.245, 1.075), (0.072, 0.12, 0.048)))
    col = lerp(col, rgb('#ffa0a8'), blush * 0.50)
    return dict(color=col, rough=0.62 + (fr['strand'] - 0.5) * 0.10, height=h + L.fuzz(p, 0.0004))


def look_body(g):
    p = g.P()
    fr = C.soft_fur(C.flow_down(p))
    return dict(color=coat(p, fr), rough=0.64 + (fr['strand'] - 0.5) * 0.10, height=fr['height'] + L.fuzz(p, 0.0004))


def look_arm(g):
    p = g.P()
    fr = C.soft_fur(C.flow_along(p, ARM_DIR))
    return dict(color=coat(p, fr), rough=0.64 + (fr['strand'] - 0.5) * 0.10, height=fr['height'] + L.fuzz(p, 0.0004))


def sq(x):
    return x * x


def look_foot(g):
    p = g.P()
    pm = Vec((absv(p.x), p.y, p.z))
    heel, fwd, side = foot_frame(1)
    q = pm - Vec(tuple(heel))
    u = q.dot(Vec(tuple(side))); v = q.dot(Vec(tuple(fwd)))
    fr = C.soft_fur(C.flow_along(p, (fwd[0], fwd[1], -0.5), 0.25))
    col = coat(p, fr)
    h = fr['height']
    # the sole: dark leathery pads on pale fur
    sole = smooth(0.016, 0.006, p.z)
    pad = smooth(1.05, 0.9, (sq(u / 0.085) + sq((v - 0.045) / 0.075)) ** 0.5)
    for k in (-1, 0, 1):
        tu = k * 0.088; tv = 0.215 - 0.022 * abs(k)
        pad = vmax(pad, smooth(1.05, 0.85, (sq((u - tu) / 0.034) + sq((v - tv) / 0.040)) ** 0.5))
    lum = noise(p, 60.0, 2.0)
    col = lerp(col, lerp(rgb('#3a302c'), rgb('#57463f'), lum), sole * pad)
    h = h * (1.0 - sole * pad) + sole * pad * (0.0025 + (lum - 0.5) * 0.0012)
    # claws: short dark tips at the front of each toe
    claw = V(0.0)
    for k in (-1, 0, 1):
        tu = k * 0.088; tv = 0.298 - 0.024 * abs(k)
        claw = vmax(claw, smooth(1.0, 0.72, (sq((u - tu) / 0.015) + sq((v - tv) / 0.026) + sq((p.z - 0.044) / 0.022)) ** 0.5))
    col = lerp(col, rgb('#3a322e'), claw)
    rough = lerp(0.64, 0.42, vmax(claw, sole * pad))
    return dict(color=col, rough=rough, height=h * (1.0 - claw) + claw * 0.002)


def look_ear(g):
    p = g.P()
    pm = Vec((absv(p.x), p.y, p.z))
    fr = C.soft_fur(C.flow_down(p, 0.3))
    col = coat(p, fr)
    yaw = 0.30
    fwd = np.array([math.sin(yaw), math.cos(yaw), 0.0])
    d = (pm - Vec(tuple(EAR_C + fwd * EAR_DISH))).length()
    inner = smooth(0.094, 0.074, d)
    col = lerp(col, lerp(rgb('#b98f88'), rgb('#e6bfb4'), smooth(0.055, 0.085, d)), inner)
    return dict(color=col, rough=0.66, height=fr['height'] * (1.0 - inner) + L.fuzz(p, 0.0005))


def look_nose(g):
    p = g.P()
    n = noise(p, 220.0, 2.0)
    col = lerp(rgb('#0d0b0b'), rgb('#2b2625'), smooth(1.085, 1.14, p.z) * 0.8 + (n - 0.5) * 0.3)
    pm = Vec((absv(p.x), p.y, p.z))
    nostril = 1.0 - smooth(0.0, 1.0, ell(pm, (0.027, float(NOSE_C[1]) + 0.038, float(NOSE_C[2]) - 0.012), (0.013, 0.02, 0.010)))
    col = lerp(col, rgb('#050404'), nostril)
    return dict(color=col, rough=0.24 + n * 0.10, height=(n - 0.5) * 0.0006 - nostril * 0.002)


def look_jaw(g):
    p = g.P()
    fr = C.soft_fur(C.flow_along(p, (0, 1, -0.3), 0.3, mirror=False))
    col = coat(p, fr, lambda t: lerp(t, rgb('#fffdf8'), 0.85))
    md = ell(p, tuple(MUZ_C), tuple(MUZ_R))
    inside = smooth(1.02, 0.96, md)  # the part tucked up into the muzzle
    tongue = smooth(1.0, 0.8, ell(p, (0.0, 0.355, 1.03), (0.058, 0.095, 0.03)))
    mouth = lerp(rgb('#3d0f1a'), rgb('#e8717f'), tongue)
    col = lerp(col, mouth, inside)
    return dict(color=col, rough=lerp(0.62, 0.35, inside), height=fr['height'] * (1.0 - inside))


def look_lid(g):
    p = g.P()
    st = noise(p * Vec((1.0, 1.0, 0.25)), 170.0, 2.0)
    col = lerp(rgb('#d8c9ae'), rgb('#f1e6d2'), 0.5 + 0.5 * st)
    return dict(color=col, rough=0.62, height=(st - 0.5) * 0.0008)


def look_tuft(g):
    p = g.P(); uv = g.uv('param')
    st = noise(Vec((uv.x / 0.0045, uv.y / 0.10, p.x * 3.0)), 1.0, 2.0, 0.5)
    cl = noise(Vec((uv.x / 0.02, uv.y / 0.12, p.z * 3.0)), 1.0, 2.0, 0.5)
    fr = dict(shade=smooth(0.28, 0.72, cl * 0.5 + st * 0.5) * smooth(-0.02, 0.07, uv.y), strand=st)
    return dict(color=coat(p, fr), rough=0.64, height=(st - 0.5) * 0.0014 + (cl - 0.5) * 0.002 + L.fuzz(p, 0.0004))


if __name__ == '__main__':
    C.run(Bear(), HERE)
