"""The penguin: sculpted from smooth implicit shapes, dressed, textured, rigged and exported as penguin.glb.

    python tools/blender/penguin.py            # build + bake + export to src/assets/models/penguin.glb
    python tools/blender/penguin.py --preview  # also write preview renders next to the textures

Blender space: the penguin faces +Y, up is +Z, its right flipper is at +X.
"""
import math
import os
import sys
import numpy as np
import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import geom as G  # noqa: E402
from lib import bake as B  # noqa: E402
from lib import rig as R  # noqa: E402
from lib import render as RD  # noqa: E402
from lib import looks as L  # noqa: E402
from lib.geom import sstep  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))

# ───────────────────────── proportions ─────────────────────────
HEAD_C = (0.0, 0.012, 0.878)
HEAD_R = (0.298, 0.286, 0.270)
EYE_X, EYE_Y, EYE_Z = 0.112, 0.196, 0.915
EYE_RX, EYE_R = 0.074, 0.094  # an ellipsoid of revolution about its own x axis, so the lid can sweep round it
EYE_YAW = 0.30  # each eye is turned outward by this much
BEAK_ROOT = (0.0, 0.262, 0.822)
SHOULDER = (0.292, -0.005, 0.585)
ARM_DIR = np.array([math.sin(0.62), 0.0, -math.cos(0.62)])  # rest pose: flippers held out and down
ELBOW_D, WRIST_D, HAND_D = 0.135, 0.265, 0.36
FOOT = (0.138, 0.085, 0.0)
FOOT_YAW = 0.30
JK_ZB, JK_ZT = 0.135, 0.672  # jacket hem and collar heights
BAFFLE = 0.1075
SCARF_Z = 0.69


def gap_half_angle(z):
    """Half-angle of the jacket's open front (radians from dead ahead): a wide V at the hem, nearly closed at the collar."""
    return 0.98 + (0.36 - 0.98) * sstep(JK_ZB, JK_ZT, z) ** 0.85


def body_sdf():
    torso = G.ellipsoid((0, -0.005, 0.385), (0.372, 0.345, 0.415))
    belly = G.ellipsoid((0, 0.065, 0.30), (0.305, 0.30, 0.30))
    rump = G.ellipsoid((0, -0.06, 0.25), (0.31, 0.29, 0.26))
    head = G.ellipsoid(HEAD_C, HEAD_R)
    cheeks = [G.sphere((s * 0.150, 0.125, 0.800), 0.135) for s in (-1, 1)]
    f = G.union(0.10, torso, belly, rump)
    f = G.clip(f, G.plane((0, 0, -1), -0.022), 0.085)  # a soft flat bottom to sit on the snow
    f = G.add(f, head, 0.085)
    for c in cheeks:
        f = G.add(f, c, 0.075)
    return f


BODY = body_sdf()


def axis_rays(zs, thetas):
    """Horizontal rays from the body axis. theta is measured from dead ahead (+Y), positive toward +X."""
    Z, T = np.meshgrid(zs, thetas, indexing='ij')
    O = np.stack([np.zeros_like(Z), np.zeros_like(Z), Z], axis=-1)
    D = np.stack([np.sin(T), np.cos(T), np.zeros_like(T)], axis=-1)
    return O, D


def body_radius(z, theta):
    O, D = axis_rays(np.atleast_1d(z), np.atleast_1d(theta))
    return np.linalg.norm((G._solve(BODY, O, D, 1.0) - O)[..., :2], axis=-1)


# ───────────────────────── parts ─────────────────────────

def make_body():
    """The skin, in three welded patches so the part the jacket always hides is neither meshed nor textured:
    the bottom, a front wedge (the belly showing through the open jacket) and the head."""
    nu = 48
    g = G.blob(BODY, (0, 0, 0.26), (0, 0, 0.88), nu=nu, nv=46, ref=(0, -1, 0), cap_r=0.33)
    P = g.P
    zmin = P[..., 2].min(axis=1); zmax = P[..., 2].max(axis=1)
    i0 = min(i for i in range(len(P)) if zmin[i] > JK_ZB + 0.085)
    i1 = max(i for i in range(len(P)) if zmax[i] < JK_ZT - 0.11)
    half = int(math.ceil((gap_half_angle(JK_ZB) + 0.45) / (2 * math.pi) * nu)) + 1
    c0, c1 = nu // 2 - half, nu // 2 + half  # column nu/2 is dead ahead
    grids = [
        G.Grid(P[:i0 + 1], closed_u=True, pole0=True, weld=True),
        G.Grid(P[i0:i1 + 1, c0:c1 + 1], closed_u=False, weld=True),
        G.Grid(P[i1:], closed_u=True, pole1=True, weld=True),
    ]
    return G.build_mesh('Body', grids)


def eye_frame(s):
    """Columns: the eye's local x (lid axis), y (out of the face), z (up)."""
    a = s * EYE_YAW
    c, sn = math.cos(a), math.sin(a)
    return np.array([[c, sn, 0], [-sn, c, 0], [0, 0, 1]]).T  # x = (c, -sn, 0), y = (sn, c, 0)


def make_eye(s):
    c = np.array([s * EYE_X, EYE_Y, EYE_Z]); Rm = eye_frame(s)
    f = G.ellipsoid(c, (EYE_RX, EYE_R, EYE_R), Rm)
    g = G.blob(f, c - Rm[:, 1] * 0.02, c + Rm[:, 1] * 0.02, nu=26, nv=16, ref=(0, 0, 1), cap_r=0.09, tmax=0.4)
    # keep only the half that faces out of the head
    rows = g.P.shape[0]
    g.P = g.P[rows // 2 - 2:]
    g.pole0 = False
    return G.build_mesh('Eye' + ('R' if s > 0 else 'L'), g)


def make_lid(s):
    """A half shell that sweeps round the eye's x axis. Built closed (covering the eye); the rig holds it open."""
    c = np.array([s * EYE_X, EYE_Y, EYE_Z]); Rm = eye_frame(s)
    k = 1.07
    nu, nv = 16, 12
    rows = []
    for i in range(nv + 1):
        lat = -math.pi / 2 + math.pi * i / nv  # along the lid axis (x), pole to pole
        ring = []
        for j in range(nu + 1):
            a = -math.pi / 2 + math.pi * j / nu  # the half turn the lid covers: from below, across the front, to above
            loc = np.array([math.sin(lat) * EYE_RX * k, math.cos(lat) * math.cos(a) * EYE_R * k, math.cos(lat) * math.sin(a) * EYE_R * k])
            ring.append(c + Rm @ loc)
        rows.append(ring)
    g = G.Grid(np.array(rows), closed_u=False, pole0=True, pole1=True, flip=True)
    return G.build_mesh('Lid' + ('R' if s > 0 else 'L'), g)


def beak_sdf(lower):
    root = np.array(BEAK_ROOT)
    if not lower:
        tip = root + np.array([0, 0.128, -0.036])
        base = G.capsule(root + (0, -0.04, 0.006), tip, 0.108, 0.020)
        flat = 1.85
    else:
        tip = root + np.array([0, 0.082, -0.046])
        base = G.capsule(root + (0, -0.04, -0.030), tip, 0.090, 0.018)
        flat = 2.2
    zc = root[2] + (0.006 if not lower else -0.030)

    def f(p):
        q = p.copy()
        q[..., 2] = zc + (p[..., 2] - zc) * flat
        d = base(q) / flat
        # the mouth line: a gentle smile that curls up toward the corners
        cutz = root[2] - 0.020 - (p[..., 1] - root[1]) * 0.26 + (np.abs(p[..., 0]) ** 2) * 2.6
        if not lower:
            return G.smax(d, cutz - p[..., 2], 0.014)
        return G.smax(d, p[..., 2] - (cutz - 0.003), 0.010)
    return f


def make_beak(lower):
    root = np.array(BEAK_ROOT)
    a = root + (0, -0.01, -0.004 if not lower else -0.040)
    b = root + (0, 0.05, -0.014 if not lower else -0.047)
    g = G.blob(beak_sdf(lower), a, b, nu=22, nv=14, ref=(0, 0, 1), cap_r=0.06, tmax=0.5)
    return G.build_mesh('BeakLower' if lower else 'BeakUpper', g)


def foot_sdf(s):
    heel = np.array([s * FOOT[0], FOOT[1], 0.0])
    toes = []
    for k, ang in enumerate((-0.52, 0.0, 0.52)):
        a = ang + s * FOOT_YAW
        d = np.array([math.sin(a), math.cos(a), 0.0])
        ln = 0.265 if k == 1 else 0.235
        toes.append(G.capsule(heel + d * 0.03 + (0, 0, 0.03), heel + d * ln + (0, 0, 0.022), 0.05, 0.034))
    dmid = np.array([math.sin(s * FOOT_YAW), math.cos(s * FOOT_YAW), 0.0])
    pad = G.ellipsoid(heel + dmid * 0.105 + (0, 0, 0.026), (0.105, 0.105, 0.05))
    u = G.union(0.05, *toes)
    u = G.add(u, pad, 0.055)

    def f(p):
        q = p.copy(); q[..., 2] = 0.026 + (p[..., 2] - 0.026) * 1.75
        d = u(q) / 1.75
        return G.smax(d, 0.004 - p[..., 2], 0.012)  # flat sole
    return f, heel, dmid


def make_foot(s):
    f, heel, d = foot_sdf(s)
    g = G.blob(f, heel + d * 0.03 + (0, 0, 0.026), heel + d * 0.13 + (0, 0, 0.026), nu=30, nv=16, ref=(0, 0, 1), cap_r=0.07, tmax=0.6)
    foot = G.build_mesh('Foot', g)
    # a stubby ankle, so the foot stays attached when it steps
    ank = G.capsule(heel + d * 0.035 + (0, 0, 0.03), heel + d * 0.02 + (0, -0.02, 0.15), 0.052, 0.058)
    g2 = G.blob(ank, heel + d * 0.035 + (0, 0, 0.04), heel + d * 0.022 + (0, -0.018, 0.13), nu=10, nv=6, ref=(0, 1, 0), cap_r=0.05, tmax=0.4)
    leg = G.build_mesh('Leg', g2)
    return G.join([foot, leg], 'Foot' + ('R' if s > 0 else 'L'))


def make_tail():
    a = np.array([0, -0.25, 0.135]); b = np.array([0, -0.455, 0.052])
    base = G.capsule(a, b, 0.105, 0.016)

    def f(p):
        q = p.copy(); q[..., 2] = 0.09 + (p[..., 2] - 0.09) * 1.5
        return base(q) / 1.5
    g = G.blob(f, a + (0, -0.02, -0.01), a + (0, -0.10, -0.045), nu=14, nv=10, ref=(0, 0, 1), cap_r=0.07, tmax=0.6)
    return G.build_mesh('Tail', g)


def jacket_thickness(p):
    z = p[..., 2]
    th = np.abs(np.arctan2(p[..., 0], p[..., 1]))
    edge = sstep(0.0, 0.30, th - gap_half_angle(z))
    t = np.clip((z - JK_ZB) / BAFFLE, 0, None)
    fr = t - np.floor(t)
    puff = 1.0 - np.abs(2 * fr - 1) ** 2.4
    ends = sstep(JK_ZB - 0.005, JK_ZB + 0.05, z) * (1 - sstep(JK_ZT - 0.05, JK_ZT + 0.005, z))
    # a faint vertical quilting line down each side panel
    return 0.017 + (0.010 + 0.018 * puff) * (0.30 + 0.70 * edge) * (0.55 + 0.45 * ends)


def make_jacket():
    f = G.offset(BODY, jacket_thickness)
    nz, nt = 41, 50
    zs = np.linspace(JK_ZB, JK_ZT, nz)
    rows = []
    for z in zs:
        gap = gap_half_angle(z)
        th = np.linspace(gap, 2 * math.pi - gap, nt)
        O, D = axis_rays([z], th)
        rows.append(G._solve(f, O, D, 1.0)[0])
    g = G.Grid(np.array(rows), closed_u=False, flip=True)
    return G.build_mesh('Jacket', g), np.array(rows)


def tube_along(points, radius, name, nu=10, n=None, ref=(0, 0, 1), section=None, cap=True):
    P = G.resample(points, n or max(8, len(points)))
    sec = section or (lambda t, th: (radius * np.cos(th), radius * np.sin(th)))
    return G.build_mesh(name, G.sweep(P, sec, nu=nu, ref=ref, cap=cap, cap_rows=3))


def make_jacket_trim(JP):
    """Fleece hem and the piping down both front edges. JP: the jacket's grid of points (rows = heights)."""
    parts = []
    # hem: follows the bottom row, a little outside and below it
    hem = JP[0].copy()
    out = hem.copy(); out[:, 2] = 0
    out /= np.linalg.norm(out, axis=1, keepdims=True)
    hem = hem + out * 0.004 + np.array([0, 0, -0.012])
    parts.append(tube_along(hem, 0.036, 'Hem', nu=8, n=46))
    for col, nm in ((0, 'PipingR'), (-1, 'PipingL')):
        edge = JP[:, col].copy()
        o = edge.copy(); o[:, 2] = 0
        o /= np.linalg.norm(o, axis=1, keepdims=True)
        edge = edge - o * 0.006
        edge = edge[1:-1]
        parts.append(tube_along(edge, 0.0185, nm, nu=6, n=26, ref=(0, 1, 0)))
    return parts


def arm_point(s, d, fwd=0.0):
    p = np.array(SHOULDER) + ARM_DIR * d
    p[1] += fwd
    p[0] *= s
    return p


def make_sleeve(s):
    n = 22
    ds = np.linspace(-0.035, WRIST_D + 0.012, n)
    path = np.array([arm_point(s, d) for d in ds])

    def section(t, th):
        d = -0.035 + t * (WRIST_D + 0.047)
        # three puffs along the sleeve
        u = np.clip((d - 0.005) / 0.092, 0, 2.999)
        fr = u - np.floor(u)
        puff = 1.0 - abs(2 * fr - 1) ** 2.4
        taper = 1.0 - 0.24 * t
        ra = (0.080 + 0.011 * puff) * taper  # across (x, the thin way)
        rb = (0.098 + 0.011 * puff) * taper  # front to back
        return ra * np.cos(th), rb * np.sin(th)
    g = G.sweep(path, section, nu=16, ref=(0, 1, 0), cap=True, cap_rows=3)
    return G.build_mesh('Sleeve' + ('R' if s > 0 else 'L'), g)


def make_cuff(s):
    """Fleece cuff at the end of the sleeve."""
    c = arm_point(s, WRIST_D + 0.012)
    e1, e2, e3 = G.frame_from_axis(ARM_DIR * np.array([s, 1, 1]), (0, 1, 0))
    th = np.linspace(0, 2 * math.pi, 20, endpoint=False)
    ring = np.array([c + (e2 * math.cos(a) * 0.070 + e1 * math.sin(a) * 0.086) for a in th])
    return G.build_mesh('Cuff' + ('R' if s > 0 else 'L'), G.sweep(ring, lambda t, th_: (0.034 * np.cos(th_), 0.040 * np.sin(th_)), nu=8, closed=True, ref=e3))


def make_mitten(s):
    c = arm_point(s, HAND_D + 0.012)
    ax = ARM_DIR * np.array([s, 1, 1])
    e1, e2, e3 = G.frame_from_axis(ax, (0, 1, 0))  # e1 = forward, e2 = across, e3 = down the arm
    Rm = np.stack([e2, e1, e3], axis=1)
    palm = G.ellipsoid(c, (0.086, 0.108, 0.118), Rm)
    f = G.clip(palm, G.plane(-e3, -(c @ e3) + 0.098), 0.03)
    g = G.blob(f, c - e3 * 0.03, c + e3 * 0.03, nu=22, nv=14, ref=e1, cap_r=0.1, tmax=0.5)
    palm_ob = G.build_mesh('Palm', g)
    # thumb: sticks out forward and a little inward (toward the body)
    t0 = c + e1 * 0.07 - e3 * 0.040 - e2 * 0.012 * s
    t1 = c + e1 * 0.158 - e3 * 0.030 - e2 * 0.02 * s
    thumb = G.capsule(t0, t1, 0.052, 0.045)
    g2 = G.blob(thumb, t0, t1, nu=12, nv=10, ref=e3, cap_r=0.05, tmax=0.4)
    th_ob = G.build_mesh('Thumb', g2)
    return G.join([palm_ob, th_ob], 'Mitten' + ('R' if s > 0 else 'L'))


def make_mitten_cuff(s):
    c = arm_point(s, WRIST_D + 0.052)
    e1, e2, e3 = G.frame_from_axis(ARM_DIR * np.array([s, 1, 1]), (0, 1, 0))
    th = np.linspace(0, 2 * math.pi, 28, endpoint=False)
    ring = np.array([c + (e2 * math.cos(a) * 0.066 + e1 * math.sin(a) * 0.082) for a in th])
    return G.build_mesh('MittenCuff' + ('R' if s > 0 else 'L'), G.sweep(ring, lambda t, th_: (0.027 * np.cos(th_), 0.040 * np.sin(th_)), nu=10, closed=True, ref=e3))


def scarf_path(n=92):
    """Two loose wraps round the neck, starting and ending at the knot behind the right shoulder."""
    a0 = math.atan2(SCARF_KNOT[0], SCARF_KNOT[1])
    pts = []
    for i in range(n):
        t = i / (n - 1)
        a = a0 + 0.10 + t * (4 * math.pi - 0.20)
        z = SCARF_Z - 0.036 + 0.066 * t + 0.010 * math.sin(a * 3 + 1.0) - 0.012 * math.cos(a)
        r = float(body_radius(z, a)[0, 0]) + 0.036 - 0.008 * t + 0.004 * math.sin(a * 5)
        pts.append((math.sin(a) * r, math.cos(a) * r, z))
    return np.array(pts)


def make_scarf():
    path = scarf_path()
    sec = G.superellipse(0.036, 0.058, 2.8)
    g = G.sweep(path, lambda t, th: sec(th), nu=10, closed=False, ref=(0, 0, 1), cap=True, cap_rows=2)
    return G.build_mesh('ScarfRing', g)


SCARF_KNOT = np.array([0.155, -0.262, 0.690])
TAIL_N = 16


def scarf_tail_path(which):
    k = SCARF_KNOT
    if which == 0:
        return np.array([k + (-0.02, 0.03, 0.0), k + (0.016, -0.05, -0.03), k + (0.034, -0.088, -0.13), k + (0.040, -0.098, -0.25), k + (0.030, -0.118, -0.385)])
    return np.array([k + (-0.03, 0.03, 0.0), k + (-0.06, -0.055, -0.02), k + (-0.105, -0.095, -0.11), k + (-0.135, -0.108, -0.21), k + (-0.150, -0.125, -0.295)])


def make_scarf_tails():
    parts = []
    for which in (0, 1):
        P = G.resample(scarf_tail_path(which), TAIL_N)

        def section(t, th):
            w = 0.050 + 0.016 * sstep(0.0, 0.45, t)
            sec = G.superellipse(w, 0.017, 3.4)
            return sec(th)
        g = G.sweep(P, section, nu=10, ref=(0, -1, 0.0), cap=True, cap_rows=2)
        parts.append(G.build_mesh(f'ScarfTail{which}', g))
    # the knot: a fat lump where the tails leave the wraps
    k = SCARF_KNOT
    knot = G.ellipsoid(k + (0, -0.012, -0.002), (0.074, 0.056, 0.082))
    parts.append(G.build_mesh('ScarfKnot', G.blob(knot, k + (0, -0.012, -0.002), nu=14, nv=10, ref=(0, -1, 0), cap_r=0.06, tmax=0.3)))
    return parts


def make_fringe():
    """Tassels on the ends of the scarf tails."""
    parts = []
    for which in (0, 1):
        P = G.resample(scarf_tail_path(which), TAIL_N)
        T, Nn, Bn = G.path_frames(P, (0, -1, 0))
        end = P[-1]; t = T[-1]; n = Nn[-1]
        for i in range(6):
            o = (i - 2.5) * 0.0235
            a = end + n * o - t * 0.006
            b = a + t * (0.058 + 0.008 * ((i * 7) % 3)) + n * (o * 0.22)
            f = G.capsule(a, b, 0.0125, 0.0085)
            parts.append((which, G.build_mesh(f'Fringe{which}_{i}', G.blob(f, a + t * 0.005, b - t * 0.005, nu=5, nv=4, ref=n, cap_r=0.012, tmax=0.1))))
    return parts


# ───────────────────────── rig ─────────────────────────

def bones():
    S = np.array(SHOULDER)
    b = [
        ('root', (0, 0, 0), None),
        ('body', (0, 0, 0), 'root'),
        ('chest', (0, 0, 0.42), 'body'),
        ('head', (0, 0, 0.70), 'chest'),
        ('hat', (0, 0, 1.06), 'head'),
        ('jaw', (0, 0.225, 0.795), 'head'),
        ('tail', (0, -0.25, 0.135), 'body'),
        ('footL', (-FOOT[0], FOOT[1], 0.0), 'root'),
        ('footR', (FOOT[0], FOOT[1], 0.0), 'root'),
    ]
    for s, sd in ((-1, 'L'), (1, 'R')):
        b.append((f'lid{sd}', (s * EYE_X, EYE_Y, EYE_Z), 'head'))
        b.append((f'arm{sd}', tuple(arm_point(s, 0.0)), 'chest'))
        b.append((f'forearm{sd}', tuple(arm_point(s, ELBOW_D)), f'arm{sd}'))
        b.append((f'hand{sd}', tuple(arm_point(s, WRIST_D + 0.03)), f'forearm{sd}'))
    for which in (0, 1):
        P = G.resample(scarf_tail_path(which), TAIL_N)
        prev = 'chest'
        for k, idx in enumerate((1, 6, 11)):
            nm = f'scarf{"AB"[which]}{k + 1}'
            b.append((nm, tuple(P[idx]), prev)); prev = nm
    return b


def w_trunk(P):
    """Body / chest / head weights from height, shared by the skin and everything worn on the trunk."""
    z = P[:, 2]
    head = sstep(0.615, 0.765, z)
    chest = sstep(0.20, 0.52, z) * (1 - head)
    body = (1 - sstep(0.20, 0.52, z)) * (1 - head)
    return {'body': body, 'chest': chest, 'head': head}


def w_all(P, bone):
    return {bone: np.ones(len(P))}


def w_sleeve(P, s):
    sd = 'R' if s > 0 else 'L'
    d = (P - arm_point(s, 0.0)) @ (ARM_DIR * np.array([s, 1, 1]))
    fore = sstep(ELBOW_D - 0.05, ELBOW_D + 0.05, d)
    return {f'arm{sd}': 1 - fore, f'forearm{sd}': fore}


def w_scarf_tail(P, which):
    path = G.resample(scarf_tail_path(which), TAIL_N)
    d2 = ((P[:, None, :] - path[None, :, :]) ** 2).sum(axis=2)
    t = np.argmin(d2, axis=1) / (TAIL_N - 1.0)
    L = 'AB'[which]
    w1 = 1 - sstep(0.22, 0.48, t)
    w3 = sstep(0.55, 0.80, t)
    w2 = 1 - w1 - w3
    base = 1 - sstep(0.0, 0.10, t)  # the root of the tail stays with the ring
    out = {f'scarf{L}1': w1 * (1 - base), f'scarf{L}2': w2, f'scarf{L}3': w3}
    out.update({'chest': base * 0.62, 'head': base * 0.38})
    return out


# ───────────────────────── build ─────────────────────────

def build_parts():
    """Returns a list of (object, look name, weights function)."""
    parts = []
    body = make_body()
    parts.append((body, 'skin', w_trunk))
    for s in (-1, 1):
        sd = 'R' if s > 0 else 'L'
        parts.append((make_eye(s), 'eye', lambda P: w_all(P, 'head')))
        parts.append((make_lid(s), 'skin', lambda P, sd=sd: w_all(P, 'lid' + sd)))
        parts.append((make_foot(s), 'foot', lambda P, sd=sd: w_all(P, 'foot' + sd)))
        parts.append((make_sleeve(s), 'sleeve', lambda P, s=s: w_sleeve(P, s)))
        parts.append((make_cuff(s), 'fleece', lambda P, sd=sd: w_all(P, 'forearm' + sd)))
        parts.append((make_mitten(s), 'mitten', lambda P, sd=sd: w_all(P, 'hand' + sd)))
    parts.append((make_beak(False), 'beak', lambda P: w_all(P, 'head')))
    parts.append((make_beak(True), 'beak', lambda P: w_all(P, 'jaw')))
    parts.append((make_tail(), 'skin', lambda P: w_all(P, 'tail')))
    jacket, JP = make_jacket()
    parts.append((jacket, 'jacket', w_trunk))
    for t in make_jacket_trim(JP):
        parts.append((t, 'fleece' if t.name == 'Hem' else 'piping', w_trunk))
    ring_w = lambda P: {'chest': np.full(len(P), 0.62), 'head': np.full(len(P), 0.38)}  # noqa: E731
    parts.append((make_scarf(), 'scarf', ring_w))
    for t in make_scarf_tails():
        if t.name == 'ScarfKnot':
            parts.append((t, 'scarf', ring_w))
        else:
            which = int(t.name[-1])
            parts.append((t, 'scarf', lambda P, which=which: w_scarf_tail(P, which)))
    for which, t in make_fringe():
        parts.append((t, 'scarf', lambda P, which=which: w_all(P, f'scarf{"AB"[which]}3')))
    return parts


# which glTF material each look ends up in (the game tints the team ones)
MATERIAL_OF = {'skin': 'Penguin', 'eye': 'Eye', 'foot': 'Penguin', 'beak': 'Penguin', 'fleece': 'Penguin', 'piping': 'Penguin',
               'jacket': 'TeamJacket', 'sleeve': 'TeamJacket', 'scarf': 'TeamScarf', 'mitten': 'Mitten', 'mittencuff': 'Penguin'}
# texture space per part: the face gets the most, things you never see up close (the underside, the scarf's inside) the least
LOD_RATIO = 0.27  # the far-away copy keeps this share of the triangles
DENSITY = {'Body': [0.5, 1.1, 1.3], 'EyeL': 2.1, 'EyeR': 2.1, 'BeakUpper': 1.6, 'BeakLower': 1.3, 'LidL': 0.8, 'LidR': 0.8, 'ScarfRing': 0.85,
           'Hem': 0.7, 'Tail': 0.7, 'FootL': 0.85, 'FootR': 0.85, 'PipingL': 0.8, 'PipingR': 0.8}


def main():
    args = sys.argv[1:]
    preview = '--preview' in args
    shapes_only = '--shapes' in args
    size = 2048
    for a in args:
        if a.startswith('--size='):
            size = int(a.split('=')[1])
    out_dir = os.path.join(HERE, 'out')
    for a in args:
        if a.startswith('--out='):
            out_dir = a.split('=', 1)[1]
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    parts = build_parts()
    objs = [p[0] for p in parts]
    print('[penguin] triangles:', G.tri_count(objs), 'parts:', len(objs))
    looks = L.penguin_looks(preview_tint=(0.03, 0.26, 1.0) if shapes_only else None)
    for ob, lk, _ in parts:
        ob.data.materials.clear()
        ob.data.materials.append(looks[lk])
    if shapes_only:
        # procedural preview: open the lids and tint the team parts
        for ob, lk, _ in parts:
            if ob.name.startswith('Lid'):
                s_ = 1 if ob.name.endswith('R') else -1
                c = np.array([s_ * EYE_X, EYE_Y, EYE_Z]); Rm = eye_frame(s_)
                a = math.radians(-138)
                rot = np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])
                P = G.positions(ob)
                G.set_positions(ob, c + ((P - c) @ Rm) @ rot.T @ Rm.T)
        RD.studio()
        views = {'front': (25, 8, 4.3, 0.58), 'back': (155, 12, 4.3, 0.58), 'side': (90, 5, 4.3, 0.58), 'face': (12, 4, 2.0, 0.86),
                 'backclose': (160, 14, 2.6, 0.62), 'low': (-35, 2, 3.0, 0.45)}
        want = [a.split('=')[1].split(',') for a in args if a.startswith('--views=')]
        want = want[0] if want else ['front', 'back', 'side', 'face']
        shots = []
        for i, k in enumerate(want):
            az, el, dist, tgt = views[k]
            shots.append(RD.shot(os.path.join(out_dir, f'_s{i}.png'), target=(0, 0, tgt), dist=dist, az=az, el=el, res=(840, 840), samples=28))
        RD.sheet(shots, os.path.join(out_dir, 'shapes.png'), cols=2)
        return
    # ── weights, atlas, one mesh ──
    for ob, lk, wf in parts:
        R.set_weights(ob, wf(G.positions(ob)))
    B.pack_atlas(objs, size, pad_px=8, density=DENSITY)
    mesh = G.join(objs, 'Penguin')
    paths = B.bake([mesh], size, out_dir, 'penguin', ao_samples=64, ao_dist=0.30, ao_in_color=0.30)
    B.swap_materials(mesh, {looks[k].name: v for k, v in MATERIAL_OF.items()}, L.penguin_export_materials(paths))
    me = mesh.data
    me.uv_layers.remove(me.uv_layers['param'])
    me.attributes.remove(me.attributes['island'])
    # a lighter copy for penguins far from the camera: same skeleton, same textures, about a quarter of the triangles
    lod = mesh.copy(); lod.data = mesh.data.copy(); lod.name = 'PenguinLOD'; lod.data.name = 'PenguinLOD'
    bpy.context.scene.collection.objects.link(lod)
    dec = lod.modifiers.new('Decimate', 'DECIMATE')
    dec.decimate_type = 'COLLAPSE'; dec.ratio = LOD_RATIO
    arm = R.make_armature('PenguinRig', bones())
    R.bind(mesh, arm)
    R.bind(lod, arm)
    from lib import export as EX
    glb = os.path.join(REPO, 'src', 'assets', 'models', 'penguin.glb')
    EX.export_glb(glb, [arm, mesh, lod])
    if preview:
        RD.studio()
        # hold the lids open for the picture
        for sd in ('L', 'R'):
            pb = arm.pose.bones['lid' + sd]
            pb.rotation_mode = 'XYZ'; pb.rotation_euler = (math.radians(-140), 0, 0)
        shots = []
        for i, (az, el, dist, tgt) in enumerate([(25, 8, 4.3, 0.58), (155, 12, 4.3, 0.58), (90, 5, 4.3, 0.58), (10, 4, 2.0, 0.86)]):
            shots.append(RD.shot(os.path.join(out_dir, f'_p{i}.png'), target=(0, 0, tgt), dist=dist, az=az, el=el, res=(800, 800), samples=40))
        RD.sheet(shots, os.path.join(out_dir, 'penguin_preview.png'), cols=4)


if __name__ == '__main__':
    main()
