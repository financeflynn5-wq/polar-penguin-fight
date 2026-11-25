"""Shared building blocks for the furry classes (polar bear, yeti): eyes and lids, layered fur, tufts, limbs, the
penguin's wardrobe (puffer, scarf, mittens) cut to any body, and the build → bake → rig → export pipeline.

Blender space as everywhere here: the character faces +Y, up is +Z, its right arm is at +X, feet on z = 0.
"""
import json
import math
import os
import sys
import numpy as np
import bpy

from . import geom as G
from . import bake as B
from . import rig as R
from . import render as RD
from . import looks as L
from . import nodes as N
from .geom import sstep
from .nodes import (rgb, Vec, V, cos, absv, frac, floor, vmin, vmax, clamp01, atan2, smooth, lerp, noise, bump_band)

TAU = 2 * math.pi
LID_OPEN = 2.72  # how far the game swings a lid back to hold the eye open


# ───────────────────────── geometry helpers ─────────────────────────

def axis_rays(zs, thetas, cx=0.0, cy=0.0):
    """Horizontal rays from a vertical axis. theta is measured from dead ahead (+Y), positive toward +X."""
    Z, T = np.meshgrid(np.atleast_1d(zs).astype(float), np.atleast_1d(thetas).astype(float), indexing='ij')
    O = np.stack([np.full_like(Z, cx), np.full_like(Z, cy), Z], axis=-1)
    D = np.stack([np.sin(T), np.cos(T), np.zeros_like(T)], axis=-1)
    return O, D


def radius_fn(f, cx=0.0, cy=0.0, tmax=1.6):
    """r(z, theta): how far the skin of f is from the vertical axis through (cx, cy)."""
    def r(z, theta):
        O, D = axis_rays(z, theta, cx, cy)
        return np.linalg.norm((G._solve(f, O, D, tmax) - O)[..., :2], axis=-1)
    return r


def hit(f, origin, direction, tmax=2.0):
    """The outermost point of f along a ray."""
    o = np.asarray(origin, dtype=float)[None, :]
    d = np.asarray(direction, dtype=float); d = (d / np.linalg.norm(d))[None, :]
    return G._solve(f, o, d, tmax)[0]


def gradient(f, p, e=1e-3):
    p = np.asarray(p, dtype=float)
    g = np.array([f((p + d)[None, :])[0] - f((p - d)[None, :])[0] for d in (np.array([e, 0, 0]), np.array([0, e, 0]), np.array([0, 0, e]))])
    n = np.linalg.norm(g)
    return g / n if n > 1e-12 else np.array([0.0, 0.0, 1.0])


def unit(v):
    v = np.asarray(v, dtype=float)
    return v / np.linalg.norm(v)


def stretch(f, c, k):
    """f squashed about point c by factors k = (kx, ky, kz) (> 1 = flatter along that axis)."""
    c = np.asarray(c, dtype=float); k = np.asarray(k, dtype=float)
    m = float(k.max())

    def g(p):
        return f(c + (p - c) * k) / m
    return g


def tube(name, points, section, nu=12, n=None, ref=(0, 0, 1), cap=True, cap_rows=3):
    """Sweep section(t, theta) → (x, y) along a smooth path through points."""
    P = G.resample(points, n or max(8, len(points)))
    return G.build_mesh(name, G.sweep(P, section, nu=nu, ref=ref, cap=cap, cap_rows=cap_rows))


def ring_tube(name, ring_points, ra, rb, nu=8, ref=(0, 0, 1), n=2.0):
    sec = G.superellipse(ra, rb, n)
    return G.build_mesh(name, G.sweep(np.asarray(ring_points), lambda t, th: sec(th), nu=nu, closed=True, ref=ref))


def ball(name, c, r, nu=14, nv=10, ref=(0, 1, 0)):
    c = np.asarray(c, dtype=float)
    r3 = np.broadcast_to(np.asarray(r, dtype=float), (3,))
    return G.build_mesh(name, G.blob(G.ellipsoid(c, r3), c, nu=nu, nv=nv, ref=ref, cap_r=float(r3.max()), tmax=float(r3.max()) * 4))


def lumpy(ob, amp, freq, seed=0.0):
    """Push vertices in and out along their normals with smooth noise, so big soft forms are not perfect ellipsoids."""
    def fn(P):
        return amp * (np.sin(P[:, 0] * freq + seed) * np.sin(P[:, 1] * freq * 1.13 + seed * 1.7) * np.sin(P[:, 2] * freq * 0.91 + seed * 2.3)
                      + 0.5 * np.sin(P[:, 0] * freq * 2.3 + 1 + seed) * np.sin(P[:, 1] * freq * 2.1 + 2) * np.sin(P[:, 2] * freq * 1.9 + 3))
    G.displace(ob, fn)


# ───────────────────────── tufts ─────────────────────────

def lock(name, root, tip, width, thick, normal, bend=0.0, nu=7, n=5, fat=0.35):
    """A lock of fur: a flattened, curved cone from root (buried in the body) to a pointed tip. normal: the way the
    body's surface faces there (the lock lies flat against it and arcs away from it by `bend` × its length)."""
    root = np.asarray(root, dtype=float); tip = np.asarray(tip, dtype=float); nrm = unit(normal)
    ln = float(np.linalg.norm(tip - root))
    mid = (root + tip) / 2 + nrm * (bend * ln)
    ts = np.linspace(0, 1, n + 1)
    P = np.array([(1 - t) ** 2 * root + 2 * (1 - t) * t * mid + t * t * tip for t in ts])
    t0 = unit(P[1] - P[0])
    across = np.cross(nrm, t0)
    if np.linalg.norm(across) < 1e-6:
        across = np.cross(nrm + np.array([0.3, 0.2, 0.1]), t0)
    across = unit(across)
    T, Nn, Bn = G.path_frames(P, across)
    th = np.linspace(0, TAU, nu, endpoint=False)
    sec = G.superellipse(1.0, 1.0, 2.5)
    sx, sy = sec(th)
    rows = []
    for i, t in enumerate(ts):
        prof = (0.70 + 0.30 * math.sin(min(t / fat, 1.0) * math.pi / 2)) * max(0.0, 1 - t ** 2.2) ** 0.8
        rows.append(P[i] + Nn[i] * (sx * width * prof)[:, None] + Bn[i] * (sy * thick * prof)[:, None])
    return G.build_mesh(name, G.Grid(np.array(rows), closed_u=True, pole1=True))


def tuft(name, f, origin, direction, flow, length, width, thick=None, lift=0.25, embed=0.03, bend=0.12, nu=7, n=5):
    """A lock growing out of the skin of f: found by a ray from origin along direction, lying along `flow` (made
    tangent to the skin) and lifted away from it by `lift` × length at the tip."""
    p = hit(f, origin, direction)
    nrm = gradient(f, p)
    fl = np.asarray(flow, dtype=float)
    fl = fl - (fl @ nrm) * nrm
    fl = unit(fl) if np.linalg.norm(fl) > 1e-6 else unit(np.cross(nrm, (1, 0, 0)))
    root = p - nrm * embed - fl * (length * 0.12)
    tip = p + fl * length * 0.88 + nrm * (lift * length)
    return lock(name, root, tip, width, thick if thick is not None else width * 0.55, nrm, bend=bend, nu=nu, n=n)


# ───────────────────────── eyes ─────────────────────────

class Eye:
    """An eye: an ellipsoid of revolution about its own x axis (so a lid can sweep round it), turned outward by yaw."""

    def __init__(self, x, y, z, rx, r, yaw=0.30):
        self.x, self.y, self.z, self.rx, self.r, self.yaw = x, y, z, rx, r, yaw

    def centre(self, s):
        return np.array([s * self.x, self.y, self.z])

    def frame(self, s):
        """Columns: the eye's local x (lid axis), y (out of the face), z (up)."""
        a = s * self.yaw
        c, sn = math.cos(a), math.sin(a)
        return np.array([[c, sn, 0], [-sn, c, 0], [0, 0, 1]]).T


def make_eye(e, s):
    c = e.centre(s); Rm = e.frame(s)
    f = G.ellipsoid(c, (e.rx, e.r, e.r), Rm)
    g = G.blob(f, c - Rm[:, 1] * 0.02, c + Rm[:, 1] * 0.02, nu=26, nv=16, ref=(0, 0, 1), cap_r=0.09, tmax=0.4)
    rows = g.P.shape[0]
    g.P = g.P[rows // 2 - 2:]  # keep only the half that faces out of the head
    g.pole0 = False
    return G.build_mesh('Eye' + ('R' if s > 0 else 'L'), g)


def make_lid(e, s, k=1.07):
    """A half shell that sweeps round the eye's x axis. Built closed (covering the eye); the rig holds it open."""
    c = e.centre(s); Rm = e.frame(s)
    nu, nv = 16, 12
    rows = []
    for i in range(nv + 1):
        lat = -math.pi / 2 + math.pi * i / nv
        ring = []
        for j in range(nu + 1):
            a = -math.pi / 2 + math.pi * j / nu
            loc = np.array([math.sin(lat) * e.rx * k, math.cos(lat) * math.cos(a) * e.r * k, math.cos(lat) * math.sin(a) * e.r * k])
            ring.append(c + Rm @ loc)
        rows.append(ring)
    g = G.Grid(np.array(rows), closed_u=False, pole0=True, pole1=True, flip=True)
    return G.build_mesh('Lid' + ('R' if s > 0 else 'L'), g)


def open_lid_in_place(ob, e, s, angle=LID_OPEN):
    """For un-rigged preview renders: swing a lid's vertices back the way the game does."""
    c = e.centre(s); Rm = e.frame(s)
    a = -angle
    rot = np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])
    P = G.positions(ob)
    G.set_positions(ob, c + ((P - c) @ Rm) @ rot.T @ Rm.T)


def eye_look(e, iris_in='#2a1608', iris_out='#9a5a1c', iris_edge='#120903', iris_r=0.70, pupil_r=0.40,
             sclera=('#f6f8fc', '#b9c4d8'), gaze=(-0.07, 1.0, 0.0)):
    """The penguin's glossy eye for any eye: big pupil, warm iris lit from below, two catch-lights."""
    def f(g):
        p = g.P()
        side = smooth(-0.001, 0.001, p.x) * 2.0 - 1.0
        ax = absv(p.x)
        q = Vec((ax - e.x, p.y - e.y, p.z - e.z))
        c, sn = math.cos(e.yaw), math.sin(e.yaw)
        lx = (q.x * c - q.y * sn) / e.rx
        ly = (q.x * sn + q.y * c) / e.r
        lz = q.z / e.r
        wl = math.sqrt(sum(a * a for a in gaze))
        gw = tuple(a / wl for a in gaze)
        gl = (gw[0] * c - gw[1] * sn, gw[0] * sn + gw[1] * c, gw[2])
        d = Vec((lx - gl[0], ly - gl[1], lz - gl[2])).length()
        scl = lerp(rgb(sclera[0]), rgb(sclera[1]), smooth(0.75, 1.5, d))
        low = clamp01((gl[2] - lz) / iris_r * 0.5 + 0.5)  # 0 at the top of the iris, 1 at the bottom
        iris = lerp(rgb(iris_in), rgb(iris_out), smooth(0.35, 1.0, low) * smooth(pupil_r * 0.8, iris_r, d))
        iris = lerp(iris, rgb(iris_edge), smooth(iris_r * 0.86, iris_r, d))
        col = lerp(iris, scl, smooth(iris_r - 0.02, iris_r + 0.02, d))
        col = lerp(rgb('#05060a'), col, smooth(pupil_r - 0.02, pupil_r + 0.02, d))
        # catch-lights: a big one up and to the character's left, a small one opposite; the same side on both eyes
        h1 = Vec((lx - (gl[0] - side * 0.30), ly - gl[1], lz - (gl[2] + 0.30))).length()
        h2 = Vec((lx - (gl[0] + side * 0.24), ly - gl[1], lz - (gl[2] - 0.26))).length()
        hi = vmax(smooth(0.19, 0.15, h1), smooth(0.085, 0.06, h2) * 0.85)
        col = lerp(col, rgb('#ffffff'), hi)
        return dict(color=col, rough=lerp(0.07, 0.25, hi), height=V(0.0))
    return f


# ───────────────────────── fur (procedural look) ─────────────────────────

def white(v):
    """A random number 0..1 per cell: v is a Vec of whole numbers."""
    n = N._G.nodes.new('ShaderNodeTexWhiteNoise'); n.noise_dimensions = '3D'
    v = v if isinstance(v, Vec) else Vec(v)
    if v.c is not None:
        n.inputs['Vector'].default_value = v.c
    else:
        N._G.links.new(v.sock, n.inputs['Vector'])
    return V(n.outputs['Value'])


def fur(a, b, p, W=0.05, H=0.07, depth=0.006, strand=0.0012, length=1.6, warp=0.35, seed=0.0, wrap=None, fine=0.0045):
    """Layered locks of fur, like soft pointed shingles. a: metres across the flow, b: metres along it (toward the
    tips), p: position (for the wobble that keeps rows from looking ruled). Each row of locks overlaps the one
    below. wrap: how many locks go round a closed surface, so the pattern has no seam.
    Returns dict(height [m], tt [0 at a lock's root → 1 at its tip], strand [0..1], edge [1 in the gaps])."""
    if warp:
        a = a + (noise(p, 9.0, 2.0) - 0.5) * (W * warp * 2.0)
        b = b + (noise(p + Vec((7.3, 1.1, 3.7)), 9.0, 2.0) - 0.5) * (H * warp * 2.0)
    rb = b / H
    r = floor(rb)
    fb = rb - r

    def layer(row, tt):
        shift = white(Vec((row, seed + 3.0, 1.0))) if wrap is None else 0.0
        aa = a / W + shift + row * 0.5
        col = floor(aa)
        ca = aa - col - 0.5
        if wrap is not None:
            col = col - floor(col / float(wrap)) * float(wrap)
        rnd = white(Vec((col, row, seed)))
        rnd2 = white(Vec((col, row, seed + 11.0)))
        te = tt / (0.78 + 0.22 * rnd)  # every lock has its own length
        ca = ca + (rnd2 - 0.5) * 0.55 * te * te  # tips curl sideways
        tip = smooth(0.62, 1.0, te)
        w = 0.5 * (1.0 - tip) ** 0.75
        inside = smooth(-0.035, 0.035, w - absv(ca)) * smooth(1.0, 0.96, te)
        cross = clamp01(1.0 - (absv(ca) / vmax(w, 0.03)) ** 2.0)
        st = noise(Vec((ca * (W / fine) + rnd * 37.0, b / (fine * 22.0), row * 5.7 + seed)), 1.0, 2.0, 0.5)
        return inside, te, cross, st

    in_t, te_t, cr_t, st_t = layer(r - 1.0, (fb + 1.0) / length)
    _in, te_l, cr_l, st_l = layer(r, fb / length)
    tt = lerp(te_l, te_t, in_t)
    cross = lerp(cr_l, cr_t, in_t)
    st = lerp(st_l, st_t, in_t)
    h = tt * (0.6 + 0.4 * cross)
    return dict(height=h * depth + (st - 0.5) * strand, tt=tt, strand=st, cross=cross)


def fur_shade(fr, root, tip, p=None, strand_amt=0.16):
    """Colour for fur(): darker roots where a lock dives under the row above, light tips, fine strands."""
    k = smooth(0.18, 0.95, fr['tt']) * (0.55 + 0.45 * fr['cross'] ** 0.5)
    col = lerp(root if isinstance(root, Vec) else rgb(root), tip if isinstance(tip, Vec) else rgb(tip), k)
    return col * (1.0 - strand_amt * 0.5 + strand_amt * fr['strand'])


def soft_fur(pa, clump=34.0, strand=180.0, depth=0.0035, fine=0.0011):
    """Soft, clean fur with no pattern to it: gentle clumps and fine strands, both drawn out along the flow.
    pa: position with the flow direction squeezed (see flow_down / flow_along).
    Returns dict(height [m], shade [0 in the dips → 1 on top], clump, strand)."""
    c = noise(pa, clump, 2.0, 0.5)
    s = noise(pa, strand, 2.0, 0.55)
    return dict(height=(c - 0.5) * depth + (s - 0.5) * fine, shade=smooth(0.28, 0.72, c * 0.62 + s * 0.38), clump=c, strand=s)


def flow_down(p, k=0.2):
    """Fur that hangs straight down."""
    return p * Vec((1.0, 1.0, k))


def flow_along(p, axis, k=0.2, mirror=True):
    """Fur that runs along axis (given for the right-hand side; mirror folds the left side onto it)."""
    ax = np.asarray(axis, dtype=float); ax = ax / np.linalg.norm(ax)
    pm = Vec((absv(p.x), p.y, p.z)) if mirror else p
    av = Vec(tuple(ax))
    return pm - av * (pm.dot(av) * (1.0 - k))


def round_coords(p, R, c=(0.0, 0.0), k=1.0):
    """Fur flowing straight down a body that is roughly round about a vertical axis: (across, along)."""
    return atan2(p.x - c[0], p.y - c[1]) * (R * k), 0.0 - p.z


def limb_coords(p, origin, axis, R, fwd=(0.0, 1.0, 0.0), mirror=True):
    """Fur flowing down a limb. origin/axis are for the right (+X) limb; mirror folds the left one onto it."""
    ax = np.asarray(axis, dtype=float); ax = ax / np.linalg.norm(ax)
    e1, e2, e3 = G.frame_from_axis(ax, fwd)
    pm = Vec((absv(p.x), p.y, p.z)) if mirror else p
    q = pm - Vec(tuple(origin))
    along = q.dot(Vec(tuple(e3)))
    return atan2(q.dot(Vec(tuple(e1))), q.dot(Vec(tuple(e2)))) * R, along


def dome_coords(p, c, R):
    """Fur flowing away from the crown of a head centred on c: (across, along)."""
    q = p - Vec(tuple(c))
    hor = (q.x * q.x + q.y * q.y) ** 0.5
    return atan2(q.x, q.y) * (R * 0.8), atan2(hor, q.z) * R


# ───────────────────────── wardrobe looks ─────────────────────────

def quilt_look(zb, baffle, arc_r=0.36):
    """The penguin's puffer quilting for a garment whose seams are level rings baffle metres apart, from zb up."""
    def f(g):
        p = g.P()
        fr = frac((p.z - zb) / baffle)
        ds = vmin(fr, 1.0 - fr) * baffle
        return L._quilt(p, ds, atan2(p.x, p.y) * arc_r, p * Vec((1.0, 1.0, 0.13)))
    return f


def sleeve_quilt_look(shoulder, ang, seg, d0=0.005):
    """Quilting for a sleeve that runs out and down from the shoulder at ang from straight down."""
    def f(g):
        p = g.P()
        ax = absv(p.x)
        d = (ax - shoulder[0]) * math.sin(ang) - (p.z - shoulder[2]) * math.cos(ang)
        fr = frac((d - d0) / seg)
        ds = vmin(fr, 1.0 - fr) * seg
        across = (ax - shoulder[0]) * math.cos(ang) + (p.z - shoulder[2]) * math.sin(ang)
        arc = atan2(p.y - shoulder[1], across) * 0.1
        along = Vec((math.sin(ang), 0.0, -math.cos(ang)))
        pw = Vec((ax, p.y, p.z))
        return L._quilt(p, ds, arc, pw - along * (pw.dot(along) * 0.87))
    return f


def scarf_tail_look(stripes=((0.06, 0.02), (0.12, 0.011)), length=0.4):
    """Knit with darker stripes near the free end. stripes: (distance from the end, half-width) in metres."""
    def f(g):
        uv = g.uv('param'); p = g.P()
        h, shade = L.knit(uv.x, uv.y, 0.0135, 0.0098, 0.0026)
        st = V(0.0)
        for d, w in stripes:
            st = st + bump_band(length - d, w, uv.y)
        v = (0.70 + 0.26 * shade) * (1.0 - 0.45 * clamp01(st))
        return dict(color=Vec((v, v, v)), rough=0.92, height=h + L.fuzz(p, 0.0006))
    return f


def scarf_look(g):
    uv = g.uv('param'); p = g.P()
    h, shade = L.knit(uv.x, uv.y, 0.0135, 0.0098, 0.0026)
    v = 0.70 + 0.26 * shade
    return dict(color=Vec((v, v, v)), rough=0.92, height=h + L.fuzz(p, 0.0006))


def tinted(fn, tint, k=1.0):
    """For previews before baking: multiply a grey look by a team colour."""
    if tint is None:
        return fn

    def f(g):
        d = fn(g)
        d['color'] = d['color'] * Vec(tuple(1 - (1 - c) * k for c in tint))
        return d
    return f


# ───────────────────────── wardrobe builders ─────────────────────────

class Scarf:
    """The penguin's scarf: two loose wraps round the neck, a knot behind the right shoulder, two fringed tails."""
    TAIL_N = 16

    def __init__(self, radius, z, knot, tails, k=1.0, wraps=2.0, rise=0.066, gap=0.036):
        """radius(z, theta): the body under the scarf. knot: where the tails leave. tails: two lists of points
        relative to the knot. k: overall thickness scale against the penguin's scarf."""
        self.radius, self.z, self.knot, self.k, self.wraps, self.rise, self.gap = radius, z, np.asarray(knot, dtype=float), k, wraps, rise, gap
        self.tails = [np.asarray(t, dtype=float) + self.knot for t in tails]

    def ring_path(self, n=76):
        k = self.k
        a0 = math.atan2(self.knot[0], self.knot[1])
        pts = []
        for i in range(n):
            t = i / (n - 1)
            a = a0 + 0.10 + t * (self.wraps * TAU - 0.20)
            z = self.z - self.rise * 0.55 * k + self.rise * k * t + 0.010 * k * math.sin(a * 3 + 1.0) - 0.012 * k * math.cos(a)
            r = float(self.radius(z, a)[0, 0]) + self.gap * k - 0.008 * k * t + 0.004 * k * math.sin(a * 5)
            pts.append((math.sin(a) * r, math.cos(a) * r, z))
        return np.array(pts)

    def tail_path(self, which):
        return G.resample(self.tails[which], self.TAIL_N)

    def tail_length(self, which):
        P = self.tail_path(which)
        return float(np.linalg.norm(np.diff(P, axis=0), axis=1).sum())

    def make_ring(self):
        sec = G.superellipse(0.036 * self.k, 0.058 * self.k, 2.8)
        g = G.sweep(self.ring_path(), lambda t, th: sec(th), nu=10, closed=False, ref=(0, 0, 1), cap=True, cap_rows=2)
        return G.build_mesh('ScarfRing', g)

    def make_tails(self):
        k = self.k
        parts = []
        for which in (0, 1):
            def section(t, th):
                return G.superellipse((0.050 + 0.016 * sstep(0.0, 0.45, t)) * k, 0.017 * k, 3.4)(th)
            g = G.sweep(self.tail_path(which), section, nu=10, ref=(0, -1, 0.0), cap=True, cap_rows=2)
            parts.append(G.build_mesh(f'ScarfTail{which}', g))
        c = self.knot + np.array([0, -0.012, -0.002]) * k
        knot = G.ellipsoid(c, np.array([0.074, 0.056, 0.082]) * k)
        parts.append(G.build_mesh('ScarfKnot', G.blob(knot, c, nu=14, nv=10, ref=(0, -1, 0), cap_r=0.06, tmax=0.4)))
        return parts

    def make_fringe(self):
        k = self.k
        parts = []
        for which in (0, 1):
            P = self.tail_path(which)
            T, Nn, _B = G.path_frames(P, (0, -1, 0))
            end = P[-1]; t = T[-1]; n = Nn[-1]
            for i in range(6):
                o = (i - 2.5) * 0.0235 * k
                a = end + n * o - t * 0.006
                b = a + t * (0.058 + 0.008 * ((i * 7) % 3)) * k + n * (o * 0.22)
                f = G.capsule(a, b, 0.0125 * k, 0.0085 * k)
                parts.append((which, G.build_mesh(f'Fringe{which}_{i}', G.blob(f, a + t * 0.005, b - t * 0.005, nu=5, nv=4, ref=n, cap_r=0.012, tmax=0.1))))
        return parts

    def bones(self, parent='chest'):
        out = []
        for which in (0, 1):
            P = self.tail_path(which)
            prev = parent
            for j, idx in enumerate((1, 6, 11)):
                nm = f'scarf{"AB"[which]}{j + 1}'
                out.append((nm, tuple(P[idx]), prev)); prev = nm
        return out

    def w_tail(self, P, which, base=None):
        path = self.tail_path(which)
        d2 = ((P[:, None, :] - path[None, :, :]) ** 2).sum(axis=2)
        t = np.argmin(d2, axis=1) / (self.TAIL_N - 1.0)
        Ln = 'AB'[which]
        w1 = 1 - sstep(0.22, 0.48, t)
        w3 = sstep(0.55, 0.80, t)
        w2 = 1 - w1 - w3
        root = 1 - sstep(0.0, 0.10, t)  # the root of the tail stays with the ring
        out = {f'scarf{Ln}1': w1 * (1 - root), f'scarf{Ln}2': w2, f'scarf{Ln}3': w3}
        for bn, w in (base or {'chest': 0.62, 'head': 0.38}).items():
            out[bn] = root * w
        return out

    def parts(self, ring_w=None):
        """[(object, look, weights)] for the ring, knot, tails and fringe."""
        rw = ring_w or {'chest': 0.62, 'head': 0.38}
        fixed = lambda P: {bn: np.full(len(P), w) for bn, w in rw.items()}  # noqa: E731
        out = [(self.make_ring(), 'scarf', fixed)]
        for t in self.make_tails():
            if t.name == 'ScarfKnot':
                out.append((t, 'scarf', fixed))
            else:
                which = int(t.name[-1])
                out.append((t, f'scarftail{which}', lambda P, which=which: self.w_tail(P, which, rw)))
        for which, t in self.make_fringe():
            out.append((t, 'scarf', lambda P, which=which: {f'scarf{"AB"[which]}3': np.ones(len(P))}))
        return out


def make_mitten(name, c, axis, k=1.0, s=1):
    """A knitted mitten centred on c, pointing along axis (down the arm); the thumb sticks out forward. k: size
    against the penguin's."""
    c = np.asarray(c, dtype=float)
    e1, e2, e3 = G.frame_from_axis(axis, (0, 1, 0))  # e1 = forward, e2 = across, e3 = down the arm
    Rm = np.stack([e2, e1, e3], axis=1)
    palm = G.ellipsoid(c, np.array([0.086, 0.108, 0.118]) * k, Rm)
    f = G.clip(palm, G.plane(-e3, -(c @ e3) + 0.098 * k), 0.03 * k)
    g = G.blob(f, c - e3 * 0.03 * k, c + e3 * 0.03 * k, nu=22, nv=14, ref=e1, cap_r=0.1 * k, tmax=0.5 * k)
    palm_ob = G.build_mesh('Palm', g)
    t0 = c + (e1 * 0.07 - e3 * 0.040 - e2 * 0.012 * s) * k
    t1 = c + (e1 * 0.158 - e3 * 0.030 - e2 * 0.02 * s) * k
    thumb = G.capsule(t0, t1, 0.052 * k, 0.045 * k)
    g2 = G.blob(thumb, t0, t1, nu=12, nv=10, ref=e3, cap_r=0.05 * k, tmax=0.4 * k)
    th_ob = G.build_mesh('Thumb', g2)
    return G.join([palm_ob, th_ob], name)


def arm_ring(name, c, axis, ra, rb, ta, tb, n=24, nu=8):
    """A fat ring round an arm (a fleece or ribbed cuff): centre c, ra across / rb front-to-back, tube ta × tb."""
    e1, e2, e3 = G.frame_from_axis(axis, (0, 1, 0))
    th = np.linspace(0, TAU, n, endpoint=False)
    ring = np.array([np.asarray(c) + (e2 * math.cos(a) * ra + e1 * math.sin(a) * rb) for a in th])
    return G.build_mesh(name, G.sweep(ring, lambda t, th_: (ta * np.cos(th_), tb * np.sin(th_)), nu=nu, closed=True, ref=e3))


def make_puffer(name, body, zb, zt, baffle, gap=None, nz=40, nt=52, base=0.017, puff=0.018, cx=0.0, cy=0.0):
    """A quilted puffer shell round implicit body from hem zb to collar zt. gap(z): half-angle of the open front
    (None: closed all the way round, seam at the front). Returns the object and its grid of points."""
    def thickness(p):
        z = p[..., 2]
        t = np.clip((z - zb) / baffle, 0, None)
        fr = t - np.floor(t)
        pf = 1.0 - np.abs(2 * fr - 1) ** 2.4
        ends = sstep(zb - 0.005, zb + 0.05, z) * (1 - sstep(zt - 0.05, zt + 0.005, z))
        edge = 1.0
        if gap is not None:
            th = np.abs(np.arctan2(p[..., 0] - cx, p[..., 1] - cy))
            edge = sstep(0.0, 0.30, th - gap(z))
        return base + (0.010 + puff * pf) * (0.30 + 0.70 * edge) * (0.55 + 0.45 * ends)
    f = G.offset(body, thickness)
    rows = []
    for z in np.linspace(zb, zt, nz):
        if gap is None:
            th = np.linspace(0, TAU, nt, endpoint=False)
        else:
            gp = float(gap(z))
            th = np.linspace(gp, TAU - gp, nt)
        O, D = axis_rays([z], th, cx, cy)
        rows.append(G._solve(f, O, D, 1.6)[0])
    rows = np.array(rows)
    g = G.Grid(rows, closed_u=gap is None, flip=True)
    return G.build_mesh(name, g), rows, f


def torso_patches(name, f, a, b, hem_z, collar_z, wedge=None, nu=48, nv=40, cap_r=0.33):
    """The skin of a trunk, leaving out the band a garment always hides: everything below hem_z, everything above
    collar_z and, if wedge (a half-angle) is given, a strip down the front between them. The seam is at the back."""
    g = G.blob(f, a, b, nu=nu, nv=nv, ref=(0, -1, 0), cap_r=cap_r)
    P = g.P
    zmin = P[..., 2].min(axis=1); zmax = P[..., 2].max(axis=1)
    i0 = min(i for i in range(len(P)) if zmin[i] > hem_z)
    i1 = max(i for i in range(len(P)) if zmax[i] < collar_z)
    grids = [G.Grid(P[:i0 + 1], closed_u=True, pole0=True, weld=True)]
    if wedge is not None:
        half = int(math.ceil(wedge / TAU * nu)) + 1
        grids.append(G.Grid(P[i0:i1 + 1, nu // 2 - half:nu // 2 + half + 1], closed_u=False, weld=True))
    grids.append(G.Grid(P[i1:], closed_u=True, pole1=True, weld=True))
    return G.build_mesh(name, grids)


def outward(P):
    o = P.copy(); o[:, 2] = 0
    return o / np.maximum(np.linalg.norm(o, axis=1, keepdims=True), 1e-9)


# ───────────────────────── the pipeline ─────────────────────────

class Build:
    """Everything a character script hands over. See polarbear.py for how it is filled in."""
    name = 'creature'       # file name: src/assets/models/<name>.glb
    mesh_name = 'Creature'  # object name; the far-away copy is <mesh_name>LOD
    height = 1.0
    face_z = 0.85           # where the face close-up looks
    face_zoom = 1.0
    eyes = None             # Eye
    lod_ratio = 0.27
    density = {}
    material_of = {}
    ao = dict(ao_samples=64, ao_dist=0.30, ao_in_color=0.30)

    def parts(self):            # → [(object, look key, weights function)]
        raise NotImplementedError

    def looks(self, tint):      # → {look key: function(g)}; tint is None for the bake
        raise NotImplementedError

    def bones(self):
        raise NotImplementedError

    def export_materials(self, paths):
        raise NotImplementedError

    def facts(self):            # the rig facts for the game (in Blender space; converted on the way out)
        return {}


def to_game(p):
    """Blender (x right, y ahead, z up) → the game (x right, y up, -z ahead)."""
    return [round(float(p[0]), 4), round(float(p[2]), 4), round(float(-p[1]), 4)]


def run(build, here, argv=None):
    args = (argv if argv is not None else sys.argv[1:])
    repo = os.path.abspath(os.path.join(here, '..', '..'))
    shapes_only = '--shapes' in args
    grey = '--grey' in args
    size = 2048
    out_dir = os.path.join(here, 'out')
    for a in args:
        if a.startswith('--size='):
            size = int(a.split('=')[1])
        if a.startswith('--out='):
            out_dir = a.split('=', 1)[1]
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    parts = build.parts()
    objs = [p[0] for p in parts]
    tris = G.tri_count(objs)
    print(f'[{build.name}] triangles: {tris} parts: {len(objs)}')
    if '--count' in args:
        by = {}
        for o in objs:
            key = o.name.rstrip('0123456789LR_')
            by[key] = by.get(key, 0) + G.tri_count([o])
        print('   ', ', '.join(f'{k} {v}' for k, v in sorted(by.items(), key=lambda kv: -kv[1])))
    look_fns = build.looks((0.03, 0.26, 1.0) if shapes_only else None)
    mats = {k: B.look(f'look_{k}', f) for k, f in look_fns.items()}
    if shapes_only and grey:
        clay = bpy.data.materials.new('Clay'); clay.use_nodes = True
        clay.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.62, 0.62, 0.64, 1)
        clay.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.7
    for ob, lk, _ in parts:
        ob.data.materials.clear()
        ob.data.materials.append(clay if (shapes_only and grey and lk != 'eye') else mats[lk])
    H = build.height
    if shapes_only:
        for ob, lk, _ in parts:
            if ob.name.startswith('Lid'):
                open_lid_in_place(ob, build.eyes, 1 if ob.name.endswith('R') else -1)
        RD.studio()
        k = H / 1.15
        fz = build.face_z
        views = {'front': (25, 8, 4.3 * k, H * 0.5), 'back': (155, 12, 4.3 * k, H * 0.5), 'side': (90, 5, 4.3 * k, H * 0.5),
                 'face': (12, 4, 2.0 * k * build.face_zoom, fz), 'front0': (0, 4, 4.3 * k, H * 0.5), 'top': (160, 38, 4.6 * k, H * 0.55),
                 'faceside': (70, 4, 2.0 * k * build.face_zoom, fz), 'low': (-35, 2, 3.0 * k, H * 0.4), 'feet': (20, 12, 1.8 * k, H * 0.12),
                 'back0': (180, 8, 4.3 * k, H * 0.5), 'q': (-40, 10, 4.3 * k, H * 0.5)}
        want = [a.split('=')[1].split(',') for a in args if a.startswith('--views=')]
        want = want[0] if want else ['front', 'back', 'side', 'face']
        res = 840
        for a in args:
            if a.startswith('--res='):
                res = int(a.split('=')[1])
        shots = []
        for i, kview in enumerate(want):
            az, el, dist, tgt = views[kview]
            shots.append(RD.shot(os.path.join(out_dir, f'_{build.name}{i}.png'), target=(0, 0, tgt), dist=dist, az=az, el=el, res=(res, res), samples=24))
        sheet = os.path.join(out_dir, f'{build.name}_shapes.png')
        RD.sheet(shots, sheet, cols=min(len(shots), 2 if len(shots) <= 4 else 3))
        print('[shapes]', sheet)
        return
    # ── weights, atlas, one mesh ──
    for ob, lk, wf in parts:
        R.set_weights(ob, wf(G.positions(ob)))
    B.pack_atlas(objs, size, pad_px=8, density=build.density)
    mesh = G.join(objs, build.mesh_name)
    paths = B.bake([mesh], size, out_dir, build.name, **build.ao)
    B.swap_materials(mesh, {mats[k].name: v for k, v in build.material_of.items() if k in mats}, build.export_materials(paths))
    me = mesh.data
    me.uv_layers.remove(me.uv_layers['param'])
    me.attributes.remove(me.attributes['island'])
    # a lighter copy for characters far from the camera: same skeleton, same textures, about a quarter of the triangles
    lod = mesh.copy(); lod.data = mesh.data.copy(); lod.name = build.mesh_name + 'LOD'; lod.data.name = build.mesh_name + 'LOD'
    bpy.context.scene.collection.objects.link(lod)
    dec = lod.modifiers.new('Decimate', 'DECIMATE')
    dec.decimate_type = 'COLLAPSE'; dec.ratio = build.lod_ratio
    arm = R.make_armature(build.mesh_name + 'Rig', build.bones())
    R.bind(mesh, arm)
    R.bind(lod, arm)
    from . import export as EX
    glb = os.path.join(repo, 'src', 'assets', 'models', build.name + '.glb')
    EX.export_glb(glb, [arm, mesh, lod])
    dg = bpy.context.evaluated_depsgraph_get()
    tris_lod = sum(len(p.vertices) - 2 for p in lod.evaluated_get(dg).to_mesh().polygons)
    facts = build.facts()
    out = {}
    for k_, v in facts.items():
        if isinstance(v, np.ndarray):
            out[k_] = to_game(v)
        elif isinstance(v, float):
            out[k_] = round(v, 4)
        else:
            out[k_] = v
    out['tris'] = int(G.tri_count([mesh])); out['trisLOD'] = int(tris_lod)
    jp = os.path.join(repo, 'src', 'assets', 'models', build.name + '.json')
    with open(jp, 'w') as fh:
        json.dump(out, fh, indent=2)
        fh.write('\n')
    print(f'[{build.name}] triangles: {out["tris"]}  far-away copy: {out["trisLOD"]}  → {jp}')
