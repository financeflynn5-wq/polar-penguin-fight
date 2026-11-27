"""The two toy guns and the Candy Cane Blade, exported as src/assets/models/guns/<name>.glb.

    python tools/blender/guns.py                 # all three
    python tools/blender/guns.py cocoa           # just the Hot Chocolate Blaster
    python tools/blender/guns.py water           # just the Freeze Soaker
    python tools/blender/guns.py blade           # just the Candy Cane Blade
    options: --size=1024 (texture size)  --ao=48 (occlusion samples)  --shapes (quick Cycles renders, no bake / export)

Each gun is modelled in Blender space with its barrel along +Y, up +Z and its right side at +X, and then moved so its
origin is the middle of the grip (where the right mitten holds it). In the exported GLB that makes the barrel point
along -Z with +Y up. Two empties ride along: `muzzle` at the tip of the nozzle (the spray starts there) and `foregrip`
at the middle of the pump under the barrel (where the left mitten rests). The blade is laid out the same way (it points
along +Y here, -Z in the GLB) and carries `tip` and `mid` instead.
"""
import math
import os
import sys
import numpy as np
import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import geom as G  # noqa: E402
from lib import bake as B  # noqa: E402
from lib import export as EX  # noqa: E402
from lib.nodes import (rgb, Vec, V, sin, cos, absv, frac, floor, vmin, vmax, clamp01, atan2, smooth, lerp, noise, voronoi,  # noqa: E402
                       bump_band, sqrt)
from lib.looks import TAU, knit as looks_knit  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))


class Gun:
    def __init__(self, name, node, grip, muzzle=None, foregrip=None, coat=0.0, coat_rough=0.06, marks=None, view=((0, 0.14, 0.09), 1.0)):
        self.name = name; self.node = node
        self.grip = np.array(grip, dtype=float)          # becomes the origin
        marks = marks if marks is not None else dict(muzzle=muzzle, foregrip=foregrip)
        self.marks = {k: np.array(v, dtype=float) for k, v in marks.items()}     # the named child nodes, in model space
        self.coat = coat; self.coat_rough = coat_rough
        self.view = view                                 # for --shapes: what the camera looks at, and how far back it stands (1 = the guns)
        self.parts = []; self.density = {}

    def add(self, ob, look, density=1.0):
        """look: function(g) → dict for bake.look."""
        self.parts.append(dict(ob=ob, look=look))
        self.density[ob.name] = density
        return ob


# ───────────────────────── shape helpers ─────────────────────────

def lathe_y(name, prof, z, nu=16, ends=(False, False), x=0.0):
    """Revolve [(radius, y), ...] about a line along the barrel at height z. The texture seam is underneath."""
    return G.build_mesh(name, G.lathe(prof, nu=nu, closed_ends=ends, axis=(0, 1, 0), origin=(x, 0, z), ref=(0, 0, -1)))


def lathe_on(name, prof, origin, axis, nu=16, ends=(False, False), ref=(0, -1, 0)):
    return G.build_mesh(name, G.lathe(prof, nu=nu, closed_ends=ends, axis=axis, origin=origin, ref=ref))


def ring_about(name, centre, axis, radius, sec_axial, sec_radial, n=20, nu=6, power=2.6):
    """A band round a circle: sec_axial is its half-width along the axis, sec_radial its half-thickness."""
    e1, e2, e3 = G.frame_from_axis(axis, (0, 0, 1))
    centre = np.array(centre, dtype=float)
    th = np.linspace(0, TAU, n, endpoint=False)
    pts = np.array([centre + (e1 * math.cos(a) + e2 * math.sin(a)) * radius for a in th])
    sec = G.superellipse(sec_axial, sec_radial, power)
    return G.build_mesh(name, G.sweep(pts, lambda t, a: sec(a), nu=nu, closed=True, ref=tuple(e3)))


def rod(name, pts, r, nu=8, ref=(1, 0, 0), n=12, power=2.0, rb=None, cap_rows=2):
    """A round bar through the points (rounded ends). r: radius, or (half-size along ref, half-size across)."""
    path = G.resample(np.array(pts, dtype=float), n) if len(pts) > 2 else np.array(pts, dtype=float)
    ra, rc = (r if isinstance(r, (tuple, list)) else (r, r))
    k = 1.0 if rb is None else rb

    def sec(t, th):
        s = 1.0 + (k - 1.0) * t
        return G.superellipse(ra * s, rc * s, power)(th)
    return G.build_mesh(name, G.sweep(path, sec, nu=nu, ref=ref, cap=True, cap_rows=cap_rows))


def lumpy(ob, amp, freq, seed=0.0):
    def fn(P):
        return amp * (np.sin(P[:, 0] * freq + seed) * np.sin(P[:, 1] * freq * 1.13 + seed * 1.7) * np.sin(P[:, 2] * freq * 0.91 + seed * 2.3)
                      + 0.5 * np.sin(P[:, 0] * freq * 2.3 + 1 + seed) * np.sin(P[:, 1] * freq * 2.1 + 2) * np.sin(P[:, 2] * freq * 1.9 + 3))
    G.displace(ob, fn)


def grip_mesh(name, top, bottom, half_fore=0.041, half_wide=0.0335):
    """The handle: a fat rounded bar, a little wider at the bottom so it sits in a mitten."""
    path = G.resample(np.array([top, (np.array(top) + np.array(bottom)) / 2 + (0, 0.003, 0), bottom], dtype=float), 7)

    def sec(t, th):
        k = 0.94 + 0.10 * G.sstep(0.55, 1.0, t)
        return G.superellipse(half_fore * k, half_wide * k, 2.7)(th)
    return G.build_mesh(name, G.sweep(path, sec, nu=12, ref=(0, 1, 0), cap=True, cap_rows=3))


# ───────────────────────── look helpers ─────────────────────────

def cell_rand(i, seed=0.0):
    """A steady random number (about 0.2 to 0.8) for whole-number cell i."""
    return noise(Vec((i * 0.731 + seed, seed * 1.37 + 0.5, 0.25)), 1.0, 0.0)


def perimeter(p, cy, half_w, half_l, rho):
    """How far round a rounded-rectangle body a point is, in metres from its middle (mirrored left and right), so
    patterns that run round the body carry on smoothly over the two ends."""
    yy = p.y - cy
    ay = absv(yy)
    e = ay - (half_l - rho)
    ex = absv(p.x) - (half_w - rho)
    turn = atan2(vmax(e, 0.0), vmax(ex, 0.0001)) * rho
    across = vmax(ex * -1.0, 0.0) * smooth(0.0, 0.004, e)
    s = vmin(ay, half_l - rho) + turn + across
    return s * (smooth(-0.0005, 0.0005, yy) * 2.0 - 1.0)


def drips(u, z, z0, lmin, lmax, cell_w, half_w, seed=0.0, soft=0.0012):
    """Runny drips hanging from the line z = z0. u: position along the line in metres. Returns (mask, bulge): mask is
    1 where the syrup is, bulge is a rounded 0..1 thickness for the height map."""
    k = u / cell_w
    i = floor(k)
    c = (frac(k) - 0.5) * cell_w
    r = cell_rand(i, seed)
    r2 = cell_rand(i, seed + 7.3)
    L = lmin + (lmax - lmin) * smooth(0.28, 0.72, r)
    w = half_w * (0.75 + 0.5 * smooth(0.3, 0.7, r2))
    c = c + (r2 - 0.5) * cell_w * 0.25
    zz = z0 - L - z                       # > 0 below the middle of the drip's round end
    d = sqrt(c * c + vmax(zz, 0.0) * vmax(zz, 0.0))
    wavy = z0 + 0.0035 * cos(k * TAU)
    top = smooth(wavy - soft, wavy + soft, z)
    finger = smooth(w + soft, w - soft, d) * smooth(z0 + 0.004, z0, z)
    mask = vmax(top, finger)
    bulge = vmax(smooth(wavy - 0.006, wavy + 0.004, z), smooth(w + 0.001, w * 0.15, d) * smooth(z0 + 0.004, z0, z))
    return mask, bulge


def chocolate(p, swirl=1.0):
    """Glossy melted chocolate."""
    n = noise(p * Vec((1.0, 1.0, 0.45)), 34.0, 3.0, 0.6, 1.2)
    col = lerp(rgb('#2b1208'), rgb('#6a3418'), smooth(0.25, 0.80, n) * swirl + (1.0 - swirl) * 0.4)
    return col, 0.13 + (n - 0.5) * 0.08, (n - 0.5) * 0.0007


def copper(g):
    p = g.P()
    d, _c, _p = voronoi(p, 85.0, 'SMOOTH_F1', 1.0, 0.4)
    n = noise(p, 30.0, 3.0, 0.6)
    col = lerp(rgb('#b4502a'), rgb('#f29a62'), smooth(0.25, 0.75, n))
    return dict(color=col, rough=0.24 + d * 0.16 + (n - 0.5) * 0.10, metal=V(0.72), height=d * 0.0011 + (noise(p, 240.0) - 0.5) * 0.0002)


def plastic(color, shade=None, rough=0.30, grain=0.0003):
    """Smooth toy plastic with a faint mottle."""
    def f(g):
        p = g.P()
        n = noise(p, 14.0, 2.0)
        col = rgb(color) * (0.93 + 0.14 * n) if shade is None else lerp(rgb(shade), rgb(color), smooth(0.25, 0.75, n))
        return dict(color=col, rough=rough + (n - 0.5) * 0.08, height=(noise(p, 220.0, 2.0) - 0.5) * grain)
    return f


def rubber_grip(color, shade, cap, z_top, z_cap, lean):
    """The handle: grooved rubber with a smooth end cap. lean: how much the handle's y moves per metre of z."""
    def f(g):
        p = g.P()
        along = p.z + (p.y * lean)
        groove = bump_band(0.5, 0.26, frac(along / 0.0125))
        side = smooth(0.012, 0.022, absv(p.x))                 # grooves on the two flanks only
        groove = groove * side * smooth(z_cap + 0.012, z_cap + 0.020, p.z) * smooth(z_top, z_top - 0.01, p.z)
        n = noise(p, 60.0, 2.0)
        col = lerp(rgb(shade), rgb(color), smooth(0.2, 0.8, n)) * (1.0 - groove * 0.35)
        capm = smooth(z_cap + 0.006, z_cap + 0.002, p.z)
        seam = bump_band(z_cap + 0.006, 0.0025, p.z)
        col = lerp(col, rgb(cap), capm) * (1.0 - seam * 0.45)
        return dict(color=col, rough=lerp(0.62, 0.30, capm) + (n - 0.5) * 0.1, height=groove * -0.0016 - seam * 0.0012 + (noise(p, 300.0) - 0.5) * 0.0003)
    return f


def frosted(p, col, rough, h, amount):
    """Lay frost over a look: amount 0..1."""
    d, _c, _p = voronoi(p, 260.0, 'F1', 1.0)
    f = clamp01(amount)
    sparkle = smooth(0.30, 0.06, d)
    col = lerp(col, lerp(rgb('#cfeaf8'), rgb('#ffffff'), sparkle), f * 0.92)
    rough = lerp(rough, 0.58 - sparkle * 0.25, f)
    h = h + f * (0.0007 + (0.45 - d) * 0.0011)
    return col, rough, h


# ───────────────────────── Hot Chocolate Blaster ─────────────────────────

def gun_cocoa():
    AX = 0.078                                    # height of the barrel's centre line
    GRIP_TOP, GRIP_BOT = (0, -0.030, 0.045), (0, -0.056, -0.052)
    MUG = np.array([0.0, -0.045, 0.114])          # middle of the mug's foot
    MUG_H = 0.105
    PUMP_Z, PUMP_Y0, PUMP_Y1 = 0.004, 0.172, 0.272
    gun = Gun('cocoa', 'CocoaBlaster', grip=(0, -0.047, -0.030), muzzle=(0, 0.458, AX), foregrip=(0, (PUMP_Y0 + PUMP_Y1) / 2, PUMP_Z),
              coat=0.35)

    # ── body: cream ceramic dipped in chocolate ──
    BODY_C, HALF_W, HALF_L, RHO = -0.015, 0.056, 0.145, 0.036
    f = G.union(0.03,
                G.box((0, BODY_C, AX), (HALF_W, HALF_L, 0.050), RHO),
                G.capsule((0, 0.09, AX), (0, 0.150, AX), 0.050, 0.043),
                G.capsule((0, 0.05, 0.034), (0, 0.135, 0.016), 0.028, 0.024))
    body = G.build_mesh('Body', G.blob(f, (0, -0.105, AX), (0, 0.125, AX), nu=26, nv=20, ref=(0, 0, -1), cap_r=0.05, tmax=0.4))

    def body_look(g):
        p = g.P()
        u = perimeter(p, BODY_C, HALF_W, HALF_L, RHO)
        mask, bulge = drips(u, p.z, 0.086, 0.006, 0.040, 0.030, 0.0068, seed=1.0)
        ccol, crough, ch = chocolate(p)
        # the shell is a golden biscuit, pricked like shortbread, with a zig-zag of white icing piped round the belly
        n = noise(p, 18.0, 3.0, 0.55)
        bake = noise(p, 150.0, 2.0, 0.6)
        biscuit = lerp(rgb('#b9772f'), rgb('#e6b062'), smooth(0.25, 0.75, n))
        biscuit = lerp(biscuit, rgb('#8f5220'), smooth(0.62, 0.80, bake) * 0.30)
        biscuit = lerp(biscuit, rgb('#9a5a22'), smooth(0.040, 0.020, p.z) * 0.35)       # browner underneath
        k = u / 0.034
        tri = absv(frac(k) - 0.5) * 2.0
        icing = smooth(0.25, 0.60, bump_band(0.0375 + tri * 0.0135, 0.0030, p.z))
        cu = (frac(k) - 0.5) * 0.034
        dot = smooth(0.0034, 0.0026, sqrt(cu * cu + (p.z - 0.0560) * (p.z - 0.0560)))
        icing = vmax(icing, dot)
        cv = (frac(k + 0.5) - 0.5) * 0.034
        prick = smooth(0.0019, 0.0012, sqrt(cv * cv + (p.z - 0.0335) * (p.z - 0.0335)))
        col = lerp(biscuit * (1.0 - prick * 0.45), lerp(rgb('#ead9bb'), rgb('#fff8ea'), n), icing)
        col = lerp(col, ccol, mask)
        shadow = (1.0 - mask) * bulge                           # the syrup shades the biscuit just under its edge
        col = col * (1.0 - shadow * 0.30)
        rough = lerp(lerp(0.66 + (bake - 0.5) * 0.15, 0.36, icing), crough, mask)
        h = (bake - 0.5) * 0.0012 - prick * 0.0012 + icing * 0.0013
        return dict(color=col, rough=rough, height=h * (1.0 - mask) + bulge * 0.0026 + ch * mask)
    gun.add(body, body_look, density=1.05)

    # ── grip, trigger and guard ──
    grip = grip_mesh('Grip', GRIP_TOP, GRIP_BOT)
    gun.add(grip, rubber_grip('#5a2c14', '#33170a', '#f6e6c8', 0.03, -0.088, 0.27))
    guard = rod('Guard', [(0, 0.088, 0.036), (0, 0.090, 0.004), (0, 0.070, -0.030), (0, 0.030, -0.045), (0, -0.016, -0.040)], (0.0125, 0.0080), nu=8, ref=(1, 0, 0), n=11, power=2.8, cap_rows=1)
    gun.add(guard, plastic('#5a2c14', '#33170a', 0.4), density=0.8)
    trig = rod('Trigger', [(0, 0.030, 0.036), (0, 0.038, 0.012), (0, 0.047, -0.012)], (0.0095, 0.0080), nu=6, ref=(1, 0, 0), n=5, rb=0.75)
    gun.add(trig, plastic('#d2162e', '#8f0c1e', 0.28), density=0.8)

    # ── a peppermint swirl pressed into each flank ──
    MINT = (0.078, AX - 0.006)
    mint_prof = [(0.0, 0.0170), (0.0120, 0.0168), (0.0215, 0.0150), (0.0265, 0.0110), (0.0285, 0.0050), (0.0270, -0.0040)]

    def mint_look(g):
        p = g.P()
        dy = p.y - MINT[0]; dz = p.z - MINT[1]
        r = sqrt(dy * dy + dz * dz)
        ang = atan2(dz, dy * (smooth(-0.001, 0.001, p.x) * 2.0 - 1.0)) / TAU       # mirrored, so both sides swirl the same way
        k = frac(ang * 6.0 + r * 26.0)
        red = smooth(0.42, 0.50, absv(k - 0.5) * 2.0) * smooth(0.0035, 0.0055, r) * smooth(0.0262, 0.0248, r)
        n = noise(p, 40.0, 2.0)
        col = lerp(lerp(rgb('#e9e2d6'), rgb('#fffdf8'), n), lerp(rgb('#a30a20'), rgb('#dc1632'), n), red)
        return dict(color=col, rough=0.13 + (n - 0.5) * 0.05, height=red * 0.0004)
    for sd in (-1, 1):
        mint = lathe_on(f'Mint{sd}', mint_prof, (sd * (HALF_W - 0.0105), MINT[0], MINT[1]), (sd, 0, 0), nu=16, ends=(True, False), ref=(0, 0, 1))
        gun.add(mint, mint_look, density=1.1)

    # ── the mug: red enamel with a Nordic band, cream rim and foot ──
    prof = [(0.052, -0.014), (0.070, -0.016), (0.0745, -0.008), (0.0715, 0.004), (0.0745, 0.018), (0.0772, 0.045), (0.0772, 0.075), (0.0765, 0.094),
            (0.0790, 0.1010), (0.0785, 0.1060), (0.0745, 0.1085), (0.0705, 0.1050), (0.0690, 0.0940), (0.0660, 0.0905), (0.0, 0.0920)]
    mug = lathe_on('Mug', prof, tuple(MUG), (0, 0, 1), nu=32, ends=(False, True), ref=(0, 1, 0))
    COCOA_Z = MUG[2] + MUG_H - 0.014

    def mug_look(g):
        p = g.P()
        hz = p.z - MUG[2]
        q = Vec((p.x, p.y - MUG[1], 0.0))
        r = q.length()
        ang = atan2(p.x, p.y - MUG[1]) / TAU
        n = noise(p, 22.0, 3.0, 0.55)
        red = lerp(rgb('#8c0a1c'), rgb('#cf1430'), smooth(0.2, 0.8, n))
        cream = lerp(rgb('#ead9bb'), rgb('#fff6e2'), smooth(0.2, 0.8, n))
        # Nordic band: a zig-zag between two rows of dots, like the beanie
        k = ang * 9.0
        tri = absv(frac(k) - 0.5) * 2.0
        zig = bump_band(0.052, 0.0065, hz - tri * 0.022 + 0.011)
        dots = bump_band(0.5, 0.20, frac(k * 2.0)) * (bump_band(0.026, 0.0055, hz) + bump_band(0.080, 0.0055, hz))
        white = clamp01(smooth(0.3, 0.6, zig) + smooth(0.4, 0.7, dots))
        col = lerp(red, cream, white)
        # cream rim and foot
        rim = smooth(MUG_H - 0.010, MUG_H - 0.007, hz)
        foot = smooth(0.008, 0.005, hz)
        col = lerp(col, cream, vmax(rim, foot))
        chip = bump_band(MUG_H - 0.0085, 0.0015, hz) + bump_band(0.0065, 0.0015, hz)
        col = col * (1.0 - chip * 0.25)
        # inside: the cocoa
        inside = smooth(0.0705, 0.0690, r) * smooth(MUG_H - 0.006, MUG_H - 0.009, hz)
        ccol, crough, ch = chocolate(p * Vec((1.0, 1.0, 3.0)))
        froth = smooth(0.060, 0.068, r + (noise(p, 60.0, 2.0) - 0.5) * 0.008)      # a ring of pale bubbles at the edge
        ccol = lerp(lerp(rgb('#4a2210'), rgb('#7a431f'), smooth(0.3, 0.7, noise(p, 45.0, 2.0, 0.5, 2.0))), rgb('#c79a6a'), froth * 0.55)
        col = lerp(col, ccol, inside)
        rough = lerp(0.16 + white * 0.05 + (n - 0.5) * 0.06, 0.10, inside)
        return dict(color=col, rough=rough, height=white * 0.0005 - chip * 0.0006 + inside * ch + (noise(p, 260.0) - 0.5) * 0.0002)
    gun.add(mug, mug_look, density=1.2)

    hpts = [MUG + (0, -0.068, 0.090), MUG + (0, -0.108, 0.092), MUG + (0, -0.128, 0.066), MUG + (0, -0.122, 0.036), MUG + (0, -0.066, 0.022)]
    handle = rod('MugHandle', hpts, (0.0130, 0.0100), nu=8, ref=(1, 0, 0), n=15, power=2.4, cap_rows=1)
    gun.add(handle, plastic('#cf1430', '#8c0a1c', 0.17), density=0.9)

    # ── whipped cream, piped in a coil, with marshmallows and a wafer ──
    nu, nr, H, R0, coils = 22, 15, 0.076, 0.054, 2.4
    th = np.linspace(0, TAU, nu, endpoint=False)
    base = np.array([MUG[0], MUG[1], COCOA_Z - 0.004])
    rows = []
    for i in range(nr + 1):
        t = i / nr
        env = R0 * (1 - t ** 1.9) ** 0.72
        ph = TAU * coils * t - th
        r = env * (1 + 0.12 * np.cos(ph) * (1 - t) ** 0.35)
        z = H * t + 0.0035 * np.sin(ph) * (1 - t)
        cx = 0.012 * t ** 2.2; cyo = 0.008 * t ** 2.2
        rows.append(np.stack([base[0] + cx + np.sin(th) * r, base[1] + cyo + np.cos(th) * r, base[2] + z * np.ones(nu)], axis=1))
    cream_ob = G.build_mesh('WhippedCream', G.Grid(np.array(rows), closed_u=True, pole1=True))

    def cream_look(g):
        p = g.P()
        hz = p.z - base[2]
        ang = atan2(p.x - base[0], p.y - base[1])
        ridge = 0.5 + 0.5 * cos(ang * 9.0 + hz * 95.0)
        ridge = smooth(0.1, 0.9, ridge)
        n = noise(p, 30.0, 2.0)
        col = lerp(rgb('#f0d9b0'), rgb('#fffbf0'), 0.25 + 0.75 * ridge)
        col = col * (0.96 + 0.08 * n)
        # chocolate sauce drizzled across the top
        s = (p.x * 0.80 + p.y * 0.60) / 0.021 + sin((p.x * -0.6 + p.y * 0.8) * 55.0) * 0.20
        line = bump_band(0.5, 0.20, frac(s))
        sauce = smooth(0.35, 0.60, line) * smooth(0.030, 0.042, hz + (noise(p, 40.0) - 0.5) * 0.02)
        ccol, crough, _ch = chocolate(p)
        col = lerp(col, ccol, sauce)
        dust = smooth(0.74, 0.80, noise(p, 520.0, 1.0)) * (1.0 - sauce) * smooth(0.010, 0.03, hz)
        col = lerp(col, rgb('#6a3a1c'), dust * 0.55)
        return dict(color=col, rough=lerp(0.62, crough, sauce), height=ridge * 0.0024 + sauce * 0.0012 + (noise(p, 200.0, 2.0) - 0.5) * 0.0004)
    gun.add(cream_ob, cream_look, density=1.2)

    def marshmallow(color, shade):
        def f(g):
            p = g.P()
            n = noise(p, 55.0, 2.0)
            d, _c, _p = voronoi(p, 300.0, 'F1', 1.0)
            return dict(color=lerp(rgb(shade), rgb(color), smooth(0.2, 0.8, n)), rough=V(0.78), height=(0.4 - d) * 0.0005 + (n - 0.5) * 0.0010)
        return f
    white_m, pink_m = marshmallow('#fffdf6', '#eadfce'), marshmallow('#ffc3cf', '#f296a8')
    mprof = [(0.0, -0.0140), (0.0130, -0.0140), (0.0185, -0.0100), (0.0198, 0.0), (0.0185, 0.0100), (0.0130, 0.0140), (0.0, 0.0140)]
    for k, (a, rad, dz, tilt, look) in enumerate(((2.05, 0.055, 0.016, (0.5, 0.2, 0.84), white_m), (4.25, 0.055, 0.015, (-0.45, -0.3, 0.84), pink_m),
                                                  (0.30, 0.055, 0.015, (0.15, 0.55, 0.82), white_m), (5.35, 0.052, 0.020, (-0.4, 0.5, 0.75), white_m))):
        c = np.array([MUG[0] + math.sin(a) * rad, MUG[1] + math.cos(a) * rad, COCOA_Z + dz])
        m = lathe_on(f'Marshmallow{k}', mprof, tuple(c), tilt, nu=8, ends=(True, True), ref=(1, 0, 0))
        gun.add(m, look, density=0.9)
    w0 = np.array([MUG[0] + 0.034, MUG[1] - 0.030, COCOA_Z - 0.01])
    wd = np.array([0.42, -0.36, 0.83]); wd /= np.linalg.norm(wd)
    WL = 0.088
    wafer = lathe_on('Wafer', [(0.0100, 0.0), (0.0100, WL - 0.002), (0.0088, WL), (0.0060, WL), (0.0, WL - 0.004)],
                     tuple(w0), tuple(wd), nu=8, ends=(False, True), ref=(0, 0, 1))

    def wafer_look(g):
        p = g.P()
        q = p - Vec(tuple(w0))
        along = q.dot(Vec(tuple(wd)))
        side = q - Vec(tuple(wd)) * along
        e1, e2, _e3 = G.frame_from_axis(wd, (0, 0, 1))
        ang = atan2(side.dot(Vec(tuple(e2))), side.dot(Vec(tuple(e1)))) / TAU
        stripe = smooth(0.30, 0.42, absv(frac(ang + along / 0.034) - 0.5) * 2.0)
        col = lerp(rgb('#5a2a12'), rgb('#e9b872'), stripe)
        hole = smooth(0.0068, 0.0058, side.length()) * smooth(WL - 0.004, WL - 0.001, along)
        col = lerp(col, rgb('#2a1206'), hole)
        return dict(color=col * (0.9 + 0.2 * noise(p, 90.0, 2.0)), rough=V(0.55), height=stripe * 0.0006)
    gun.add(wafer, wafer_look, density=0.9)

    # ── candy-cane barrel with copper collars, and the copper bell it sprays from ──
    bprof = [(0.030, 0.150), (0.040, 0.172), (0.0425, 0.180), (0.0425, 0.192), (0.040, 0.199), (0.0335, 0.203), (0.0335, 0.350)]
    barrel = lathe_y('Barrel', bprof, AX, nu=20)

    def barrel_look(g):
        p = g.P()
        ang = atan2(p.x, p.z - AX) / TAU
        k = frac(ang + (p.y - 0.2) / 0.085)
        wide = smooth(0.035, 0.045, absv(k - 0.30) - 0.20) * -1.0 + 1.0
        thin = bump_band(0.76, 0.035, k)
        red = clamp01(wide + smooth(0.3, 0.6, thin))
        n = noise(p, 20.0, 2.0)
        col = lerp(lerp(rgb('#e9e2d6'), rgb('#fffdf8'), n), lerp(rgb('#a30a20'), rgb('#dc1632'), n), red)
        cp = copper(g)
        collar = smooth(0.2015, 0.1995, p.y)
        return dict(color=lerp(col, cp['color'], collar), rough=lerp(0.20 + (n - 0.5) * 0.05, cp['rough'], collar), metal=collar * 0.72,
                    height=cp['height'] * collar + red * 0.0003 * (1.0 - collar))
    gun.add(barrel, barrel_look, density=1.1)

    nprof = [(0.0335, 0.340), (0.0395, 0.344), (0.0415, 0.352), (0.0395, 0.362), (0.0350, 0.370), (0.0365, 0.385), (0.0420, 0.408), (0.0510, 0.432),
             (0.0585, 0.447), (0.0615, 0.4535), (0.0595, 0.459), (0.0540, 0.456), (0.0440, 0.440), (0.0300, 0.420), (0.0170, 0.410), (0.0, 0.408)]
    nozzle = lathe_y('Nozzle', nprof, AX, nu=20, ends=(False, True))

    def nozzle_look(g):
        p = g.P()
        cp = copper(g)
        r = Vec((p.x, 0.0, p.z - AX)).length()
        # inside the bell: a pool of chocolate, and a lick of it over the bottom lip
        inside = smooth(0.0555, 0.0535, r) * smooth(0.4555, 0.4535, p.y + (r - 0.05) * 0.5) * smooth(0.40, 0.404, p.y) * smooth(0.036, 0.034, r - (p.y - 0.428) * 1.2)
        ccol, crough, ch = chocolate(p)
        low = smooth(-0.3, -0.75, (p.z - AX) / vmax(r, 0.001))                    # the bottom of the lip
        lick = low * smooth(0.436, 0.444, p.y + (noise(p, 60.0) - 0.5) * 0.012)
        m = vmax(inside, lick)
        return dict(color=lerp(cp['color'], ccol, m), rough=lerp(cp['rough'], crough, m), metal=cp['metal'] * (1.0 - m), height=cp['height'] * (1.0 - m) + ch * m + lick * 0.0012)
    gun.add(nozzle, nozzle_look, density=1.1)

    def choc_look(g):
        ccol, crough, ch = chocolate(g.P())
        return dict(color=ccol, rough=crough, height=ch)
    for k, (dx, y0, L, r0) in enumerate(((0.004, 0.452, 0.032, 0.0088), (-0.022, 0.450, 0.017, 0.0068), (0.027, 0.449, 0.012, 0.0060))):
        zt = AX - math.sqrt(max(0.0595 ** 2 - dx ** 2, 0)) + 0.004
        a, b = np.array([dx, y0, zt]), np.array([dx, y0 + 0.001, zt - L])
        drip = G.build_mesh(f'Drip{k}', G.blob(G.capsule(a, b, r0 * 0.42, r0), a, b, nu=8, nv=7, ref=(0, 1, 0), cap_r=r0, tmax=0.1,
                                               v_bias=lambda t: 1.0 - (1.0 - t) ** 1.6))   # more rows round the fat end
        gun.add(drip, choc_look, density=0.8)

    # ── pump: a marshmallow on a copper rod under the barrel ──
    prod = lathe_y('PumpRod', [(0.0075, 0.120), (0.0075, 0.318)], PUMP_Z, nu=8)
    gun.add(prod, copper, density=0.6)
    clamp = rod('PumpClamp', [(0, 0.318, PUMP_Z - 0.002), (0, 0.318, AX - 0.02)], 0.0105, nu=6, ref=(1, 0, 0))
    gun.add(clamp, copper, density=0.7)
    y0, y1 = PUMP_Y0, PUMP_Y1
    pprof = G.smooth_profile([(0.0, y0 + 0.002), (0.020, y0), (0.0345, y0 + 0.006), (0.0385, y0 + 0.022), (0.0398, (y0 + y1) / 2), (0.0385, y1 - 0.022), (0.0345, y1 - 0.006), (0.020, y1), (0.0, y1 - 0.002)], 11)
    pprof[0] = (0.0, pprof[0][1]); pprof[-1] = (0.0, pprof[-1][1])
    pump = lathe_y('Pump', pprof, PUMP_Z, nu=14, ends=(True, True))

    def pump_look(g):
        p = g.P()
        n = noise(p, 40.0, 2.0)
        d, _c, _p = voronoi(p, 280.0, 'F1', 1.0)
        col = lerp(rgb('#e8dccb'), rgb('#fffdf6'), smooth(0.2, 0.8, n))
        dent = bump_band((y0 + y1) / 2, 0.004, p.y)
        # toasted golden at both ends, as if held over a fire
        ends = smooth(0.018, 0.044, absv(p.y - (y0 + y1) / 2) + (noise(p, 28.0, 3.0, 0.6) - 0.5) * 0.020)
        col = lerp(col, lerp(rgb('#e6b060'), rgb('#a8682a'), smooth(0.40, 0.80, noise(p, 60.0, 2.0))), ends * 0.80)
        return dict(color=col * (1.0 - dent * 0.10), rough=lerp(0.76, 0.55, ends), height=(0.4 - d) * 0.0005 + (n - 0.5) * 0.0012 - dent * 0.0010)
    gun.add(pump, pump_look, density=0.9)
    return gun


# ───────────────────────── Freeze Soaker ─────────────────────────

def gun_water():
    AX = 0.070
    GRIP_TOP, GRIP_BOT = (0, -0.030, 0.040), (0, -0.056, -0.052)
    PUMP_Z, PUMP_Y0, PUMP_Y1 = 0.000, 0.170, 0.285
    TF, TR, TANK_R = np.array([0.0, 0.105, 0.166]), np.array([0.0, -0.070, 0.200]), 0.066   # the tank's front and rear centres
    gun = Gun('water', 'WaterSoaker', grip=(0, -0.047, -0.030), muzzle=(0, 0.522, AX), foregrip=(0, (PUMP_Y0 + PUMP_Y1) / 2, PUMP_Z),
              coat=0.45)
    TEAL, TEAL_D = '#12b5c6', '#07808f'
    YELLOW, YELLOW_D = '#ffd21a', '#f0a408'

    # ── body: teal toy plastic with a snowflake badge, frosting over toward the nose ──
    BODY_C, HALF_W, HALF_L, RHO = -0.020, 0.050, 0.150, 0.032
    f = G.union(0.035,
                G.box((0, BODY_C, AX), (HALF_W, HALF_L, 0.048), RHO),
                G.capsule((0, 0.08, AX), (0, 0.200, AX), 0.047, 0.037),
                G.capsule((0, 0.04, 0.030), (0, 0.135, 0.014), 0.028, 0.023),
                G.capsule((0, -0.105, 0.105), (0, -0.142, 0.158), 0.036, 0.026))      # the tail sweeps up to cradle the tank
    body = G.build_mesh('Body', G.blob(f, (0, -0.112, AX + 0.030), (0, 0.170, AX), nu=26, nv=24, ref=(0, 0, -1), cap_r=0.055, tmax=0.4,
                                       v_bias=lambda t: 0.5 * t + 0.5 * t * t))        # more rows at the tail, where the shape turns
    FLAKE = (-0.030, 0.066)

    def flake_mask(dy, dz, R, w):
        r = sqrt(dy * dy + dz * dz)
        a = atan2(dz, dy) / (TAU / 6.0)
        loc = (frac(a + 0.5) - 0.5) * (TAU / 6.0)
        along = r * cos(loc); across = r * absv(sin(loc))
        m = smooth(w, w * 0.55, across) * smooth(R, R - 0.002, along)
        for a0, L in ((0.42 * R, 0.30 * R), (0.70 * R, 0.20 * R)):
            dist = absv((along - a0) * 0.866 - across * 0.5)
            tt = (along - a0) * 0.5 + across * 0.866
            m = vmax(m, smooth(w * 0.85, w * 0.45, dist) * smooth(-0.001, 0.0005, tt) * smooth(L, L - 0.002, tt))
        return m

    def body_look(g):
        p = g.P()
        n = noise(p, 14.0, 3.0, 0.55)
        col = lerp(rgb(TEAL_D), rgb(TEAL), smooth(0.2, 0.8, n))
        col = lerp(col, rgb('#35d6e0'), smooth(0.085, 0.125, p.z) * 0.5)
        col = lerp(col, lerp(rgb('#075f8c'), rgb('#0b7fae'), n), smooth(0.038, 0.034, p.z - p.y * 0.06) * 0.85)     # a deeper blue keel
        side = smooth(0.030, 0.040, absv(p.x))
        # moulded panel lines
        line = bump_band(0.036, 0.0020, p.z - (p.y - 0.0) * 0.06) * side + bump_band(0.102, 0.0020, p.z) * side * smooth(0.12, 0.08, p.y)
        line = line + bump_band(0.118, 0.0020, p.y) * smooth(0.040, 0.050, p.z)
        col = col * (1.0 - clamp01(line) * 0.38)
        dy = p.y - FLAKE[0]; dz = p.z - FLAKE[1]
        flake = flake_mask(dy, dz, 0.031, 0.0036) * side
        disc = smooth(0.0395, 0.0380, sqrt(dy * dy + dz * dz)) * side
        ring = bump_band(0.0385, 0.0018, sqrt(dy * dy + dz * dz)) * side
        col = lerp(col, lerp(rgb('#0a5f92'), rgb('#0f7fb8'), n), disc)
        col = lerp(col, rgb('#f2fbff'), flake)
        col = lerp(col, rgb(YELLOW), ring)
        rough = 0.26 + (n - 0.5) * 0.08 + flake * 0.2
        h = clamp01(line) * -0.0012 + disc * -0.0006 + flake * 0.0008 + ring * 0.0008 + (noise(p, 240.0) - 0.5) * 0.0002
        metal = V(0.0)
        for sy, sz in ((-0.128, 0.050), (0.070, 0.106), (0.100, 0.052)):               # cross-head screws holding the shell together
            ey = p.y - sy; ez = p.z - sz
            dd = sqrt(ey * ey + ez * ez)
            head = smooth(0.0050, 0.0042, dd) * side
            slot = head * vmax(bump_band(0.0, 0.0010, ey), bump_band(0.0, 0.0010, ez)) * smooth(0.0040, 0.0034, dd)
            well = bump_band(0.0056, 0.0014, dd) * side
            col = lerp(col, rgb('#dfeaf2'), head) * (1.0 - slot * 0.75) * (1.0 - well * 0.45)
            rough = rough + head * 0.04
            metal = metal + head * 0.8
            h = h + head * 0.0004 - slot * 0.0009 - well * 0.0009
        amount = smooth(0.56, 0.74, (p.y - 0.08) * 3.2 + noise(p, 26.0, 3.0, 0.6) * 0.70 + (p.z - AX) * 1.5)
        col, rough, h = frosted(p, col, rough, h, amount)
        return dict(color=col, rough=rough, metal=metal * (1.0 - clamp01(amount)), height=h)
    gun.add(body, body_look, density=1.1)

    # ── grip, trigger and guard ──
    grip = grip_mesh('Grip', GRIP_TOP, GRIP_BOT)
    gun.add(grip, rubber_grip('#0c5f86', '#083f5e', YELLOW, 0.028, -0.088, 0.27))
    guard = rod('Guard', [(0, 0.086, 0.032), (0, 0.088, 0.002), (0, 0.068, -0.030), (0, 0.030, -0.045), (0, -0.016, -0.040)], (0.0125, 0.0080), nu=8, ref=(1, 0, 0), n=11, power=2.8, cap_rows=1)
    gun.add(guard, plastic(TEAL, TEAL_D, 0.3), density=0.8)
    trig = rod('Trigger', [(0, 0.030, 0.034), (0, 0.038, 0.010), (0, 0.047, -0.014)], (0.0095, 0.0080), nu=6, ref=(1, 0, 0), n=5, rb=0.75)
    gun.add(trig, plastic(YELLOW, YELLOW_D, 0.25), density=0.8)

    # ── the water tank: a clear bottle lying on top, with a yellow screw cap at the back ──
    d = TR - TF
    L = float(np.linalg.norm(d)); d = d / L
    prof = [(0.0, -TANK_R)]
    for k in range(1, 7):
        a = k / 7 * math.pi / 2
        prof.append((TANK_R * math.sin(a), -TANK_R * math.cos(a)))
    prof += [(TANK_R, 0.0), (TANK_R, L * 0.5), (TANK_R, L)]
    for k in range(1, 6):
        a = k / 6 * math.pi / 2
        prof.append((0.027 + (TANK_R - 0.027) * math.cos(a) ** 0.8, L + 0.046 * math.sin(a) ** 1.15))
    prof += [(0.0265, L + 0.056)]
    tank = lathe_on('Tank', prof, tuple(TF), tuple(d), nu=28, ends=(True, False), ref=(0, 0, -1))
    LEVEL = 0.218

    def tank_look(g):
        p = g.P()
        nrm = g.normal()
        q = p - Vec(tuple(TF))
        along = q.dot(Vec(tuple(d)))
        wave = LEVEL + 0.0035 * sin(p.y * 55.0) + 0.002 * sin(p.y * 131.0 + 1.0)
        water = smooth(wave + 0.0012, wave - 0.0012, p.z)
        depth = clamp01((wave - p.z) / 0.10)
        wcol = lerp(rgb('#1f9cea'), rgb('#0846a8'), smooth(0.0, 1.0, depth))
        # light falling through the water: paler streaks
        caust = noise(p * Vec((1.0, 0.6, 1.0)), 38.0, 2.0, 0.5, 2.5)
        wcol = lerp(wcol, rgb('#8fe6ff'), smooth(0.55, 0.80, caust) * 0.35)
        air = lerp(rgb('#4fb6ee'), rgb('#7ccdf6'), smooth(0.0, 0.03, p.z - wave))
        col = lerp(air, wcol, water)
        meniscus = bump_band(0.0, 0.0030, p.z - wave)
        col = lerp(col, rgb('#eafaff'), meniscus * 0.85)
        # bubbles: small rings rising through the water
        dv, cc, _p = voronoi(p, 46.0, 'F1', 1.0)
        ringb = bump_band(0.20, 0.055, dv) * smooth(0.55, 0.60, cc.x)
        col = lerp(col, rgb('#e6f9ff'), ringb * water * 0.75)
        # a painted streak of light along each shoulder, as on blown plastic
        hi = smooth(0.74, 0.86, nrm.z * 0.78 + absv(nrm.x) * 0.62) * smooth(0.985, 0.93, nrm.z * 0.78 + absv(nrm.x) * 0.62 + 0.03)
        hi = hi * smooth(-0.02, 0.02, along) * smooth(L + 0.02, L - 0.02, along)
        col = lerp(col, rgb('#ffffff'), hi * 0.50)
        # the bottle's neck is thicker plastic
        neck = smooth(L + 0.030, L + 0.046, along)
        col = lerp(col, rgb('#8fd8f6'), neck)
        thread = bump_band(0.5, 0.3, frac(along / 0.0065)) * neck
        rough = lerp(0.07, 0.05, water) + ringb * water * 0.1 + neck * 0.1
        h = meniscus * 0.0004 + ringb * water * 0.0004 + thread * 0.0008
        # frost creeping over the nose of the tank
        amount = smooth(0.57, 0.74, (-0.030 - along) * 7.0 + noise(p, 30.0, 3.0, 0.6) * 0.80 + (p.z - TF[2]) * 3.2)
        col, rough, h = frosted(p, col, rough, h, amount)
        return dict(color=col, rough=rough, height=h)
    gun.add(tank, tank_look, density=1.25)

    cprof = [(0.0, L + 0.050), (0.0310, L + 0.050), (0.0340, L + 0.053), (0.0340, L + 0.079), (0.0315, L + 0.085), (0.0240, L + 0.088), (0.0, L + 0.089)]
    cap = lathe_on('TankCap', cprof, tuple(TF), tuple(d), nu=14, ends=(True, True), ref=(0, 0, -1))
    e1, e2, _e3 = G.frame_from_axis(d, (0, 0, -1))

    def cap_look(g):
        p = g.P()
        q = p - Vec(tuple(TF))
        along = q.dot(Vec(tuple(d)))
        side = q - Vec(tuple(d)) * along
        ang = atan2(side.dot(Vec(tuple(e2))), side.dot(Vec(tuple(e1)))) / TAU
        knurl = smooth(0.25, 0.75, absv(frac(ang * 22.0) - 0.5) * 2.0) * smooth(L + 0.055, L + 0.058, along) * smooth(L + 0.082, L + 0.079, along)
        n = noise(p, 30.0, 2.0)
        col = lerp(rgb(YELLOW_D), rgb(YELLOW), smooth(0.2, 0.8, n)) * (1.0 - knurl * 0.22)
        return dict(color=col, rough=0.28 + knurl * 0.1, height=knurl * -0.0014)
    gun.add(cap, cap_look, density=1.0)

    def strap_look(g):
        p = g.P()
        n = noise(p, 30.0, 2.0)
        col = lerp(rgb('#083f5e'), rgb('#0c5f86'), smooth(0.2, 0.8, n))
        return dict(color=col, rough=0.34 + (n - 0.5) * 0.1, height=(noise(p, 200.0) - 0.5) * 0.0003)
    for k, h in enumerate((0.022, L - 0.012)):
        strap = ring_about(f'Strap{k}', TF + d * h, d, TANK_R + 0.0015, 0.011, 0.0042, n=20, nu=6, power=3.0)
        gun.add(strap, strap_look, density=0.7)

    # ── barrel: pale ice-blue, frosting over toward the tip, with an orange nozzle ──
    bprof = [(0.031, 0.190), (0.036, 0.212), (0.0385, 0.219), (0.0385, 0.231), (0.036, 0.237), (0.031, 0.241), (0.031, 0.445)]
    barrel = lathe_y('Barrel', bprof, AX, nu=20)

    def barrel_look(g):
        p = g.P()
        n = noise(p, 20.0, 2.0)
        col = lerp(rgb('#1668d6'), rgb('#2a8cf0'), smooth(0.2, 0.8, n))
        collar = smooth(0.2405, 0.2385, p.y)
        col = lerp(col, lerp(rgb(YELLOW_D), rgb(YELLOW), n), collar)
        rings = bump_band(0.5, 0.18, frac((p.y - 0.25) / 0.036)) * (1.0 - collar) * smooth(0.40, 0.38, p.y)
        col = col * (1.0 - rings * 0.22)
        rough = 0.22 + (n - 0.5) * 0.06
        h = rings * -0.0010
        amount = smooth(0.50, 0.70, (p.y - 0.30) * 3.4 + noise(p, 30.0, 3.0, 0.6) * 0.6 + (p.z - AX) * 2.0) * (1.0 - collar)
        col, rough, h = frosted(p, col, rough, h, amount)
        return dict(color=col, rough=rough, height=h)
    gun.add(barrel, barrel_look, density=1.0)

    nprof = [(0.031, 0.436), (0.038, 0.441), (0.0415, 0.450), (0.0415, 0.462), (0.038, 0.472), (0.032, 0.494), (0.0245, 0.513), (0.0195, 0.521),
             (0.0150, 0.5215), (0.0125, 0.514), (0.0, 0.512)]
    nozzle = lathe_y('Nozzle', nprof, AX, nu=16, ends=(False, True))

    def nozzle_look(g):
        p = g.P()
        r = Vec((p.x, 0.0, p.z - AX)).length()
        n = noise(p, 26.0, 2.0)
        col = lerp(rgb('#f2620c'), rgb('#ff8f1c'), smooth(0.2, 0.8, n))
        hole = smooth(0.0165, 0.0150, r) * smooth(0.505, 0.512, p.y)
        col = lerp(col, rgb('#0a2a4a'), hole)
        rib = bump_band(0.5, 0.2, frac((p.y - 0.447) / 0.009)) * smooth(0.466, 0.463, p.y) * smooth(0.446, 0.449, p.y)
        col = col * (1.0 - rib * 0.2)
        rough = 0.24 + (n - 0.5) * 0.06
        h = rib * -0.0010
        amount = smooth(0.52, 0.72, noise(p, 34.0, 3.0, 0.6) * 0.8 + (p.z - AX) * 4.5 + 0.12) * (1.0 - hole)
        col, rough, h = frosted(p, col, rough, h, amount)
        return dict(color=col, rough=rough, height=h)
    gun.add(nozzle, nozzle_look, density=1.1)

    # ── a crust of snow behind the nozzle with icicles hanging from it ──
    crust = ring_about('Frost', (0, 0.418, AX + 0.004), (0, 1, 0), 0.031, 0.024, 0.015, n=16, nu=8, power=2.0)
    lumpy(crust, 0.0055, 105.0, 1.0)

    def snow_look(g):
        p = g.P()
        dv, _c, _p = voronoi(p, 210.0, 'F1', 1.0)
        n = noise(p, 60.0, 3.0, 0.6)
        col = lerp(rgb('#cbe6f6'), rgb('#ffffff'), smooth(0.25, 0.7, n))
        return dict(color=col, rough=0.62 - smooth(0.25, 0.05, dv) * 0.3, height=(0.45 - dv) * 0.0014 + (n - 0.5) * 0.002)
    gun.add(crust, snow_look, density=1.0)

    def ice_look(g):
        p = g.P()
        n = noise(p * Vec((1.0, 1.0, 0.3)), 90.0, 2.0)
        col = lerp(rgb('#8fd8f6'), rgb('#f2fcff'), smooth(0.2, 0.8, n))
        tip = smooth(AX - 0.105, AX - 0.045, p.z)
        col = lerp(rgb('#bdeeff'), col, tip)
        return dict(color=col, rough=0.07 + n * 0.06, height=(n - 0.5) * 0.0012)
    for k, (dx, y, zt, Li, r0) in enumerate(((0.003, 0.412, AX - 0.036, 0.078, 0.0125), (0.018, 0.430, AX - 0.031, 0.048, 0.0100), (-0.019, 0.424, AX - 0.031, 0.058, 0.0105),
                                             (-0.004, 0.397, AX - 0.036, 0.036, 0.0085), (0.030, 0.408, AX - 0.020, 0.030, 0.0080), (-0.031, 0.404, AX - 0.018, 0.026, 0.0075))):
        ip = []
        for j in range(5):
            t = j / 4
            ip.append((r0 * (1 - t) ** 0.85 * (1 + 0.14 * math.sin(t * 9 + k)) + 0.0008, -t * Li))
        ip = [(ip[0][0] * 0.9, 0.012)] + ip
        icicle = lathe_on(f'Icicle{k}', ip + [(0.0, -Li - 0.003)], (dx, y, zt), (0, 0, 1), nu=6, ends=(False, True), ref=(0, 1, 0))
        gun.add(icicle, ice_look, density=0.8)

    # ── pump: a ribbed yellow handle on a steel rod under the barrel ──
    def steel(g):
        p = g.P()
        n = noise(p * Vec((1.0, 0.1, 1.0)), 80.0, 2.0)
        return dict(color=lerp(rgb('#aab8c6'), rgb('#e6eef6'), n), rough=0.26 + n * 0.1, metal=V(0.85), height=V(0.0))
    prod = lathe_y('PumpRod', [(0.0075, 0.110), (0.0075, 0.372)], PUMP_Z, nu=8)
    gun.add(prod, steel, density=0.6)
    clamp = rod('PumpClamp', [(0, 0.372, PUMP_Z - 0.002), (0, 0.372, AX - 0.018)], 0.0105, nu=6, ref=(1, 0, 0))
    gun.add(clamp, plastic(TEAL, TEAL_D, 0.3), density=0.7)
    y0, y1 = PUMP_Y0, PUMP_Y1
    pts = [(0.0, y0), (0.024, y0), (0.0335, y0 + 0.008)]
    nrib = 4
    for k in range(nrib):
        c = y0 + 0.022 + (y1 - y0 - 0.044) * k / (nrib - 1)
        pts += [(0.0315, c - 0.011), (0.0365, c), (0.0315, c + 0.011)] if 0 < k < nrib - 1 else [(0.0365, c)]
    pts += [(0.0335, y1 - 0.008), (0.024, y1), (0.0, y1)]
    pprof = G.smooth_profile(pts, 15)
    pprof[0] = (0.0, pprof[0][1]); pprof[-1] = (0.0, pprof[-1][1])
    pump = lathe_y('Pump', pprof, PUMP_Z, nu=14, ends=(True, True))

    def pump_look(g):
        p = g.P()
        n = noise(p, 22.0, 2.0)
        col = lerp(rgb(YELLOW_D), rgb(YELLOW), smooth(0.15, 0.75, n))
        ang = atan2(p.x, p.z - PUMP_Z) / TAU
        fine = bump_band(0.5, 0.25, frac(ang * 28.0)) * smooth(y0 + 0.012, y0 + 0.018, p.y) * smooth(y1 - 0.012, y1 - 0.018, p.y)
        return dict(color=col * (1.0 - fine * 0.12), rough=0.30 + (n - 0.5) * 0.08, height=fine * -0.0007)
    gun.add(pump, pump_look, density=1.0)
    return gun


# ───────────────────────── Candy Cane Blade ─────────────────────────

def cane_stripes(k, soft=0.012):
    """Candy-cane stripes across one turn of the spiral (k: 0..1): a broad red band and a thin red line. 1 = red."""
    wide = smooth(0.26 + soft, 0.26 - soft, absv(k - 0.28))
    thin = smooth(0.045 + soft, 0.045 - soft, absv(k - 0.77))
    return clamp01(wide + thin)


def hard_candy(p, red, pink=0.0):
    """Glossy boiled sugar: red (0..1) picks the stripe colour, pink warms the white toward a licked pink."""
    n = noise(p, 20.0, 2.0)
    white = lerp(lerp(rgb('#efe3d6'), rgb('#fffdf8'), smooth(0.2, 0.8, n)), rgb('#ff8fa2'), pink)
    col = lerp(white, lerp(rgb('#cb1029'), rgb('#e51834'), smooth(0.25, 0.75, n)), red)
    return col, 0.11 + (n - 0.5) * 0.05, red * 0.0003


def gold(g):
    p = g.P()
    d, _c, _p = voronoi(p, 95.0, 'SMOOTH_F1', 1.0, 0.4)
    n = noise(p, 30.0, 3.0, 0.6)
    col = lerp(rgb('#d9961e'), rgb('#ffdc6a'), smooth(0.25, 0.75, n))
    return dict(color=col, rough=0.22 + d * 0.14 + (n - 0.5) * 0.08, metal=V(0.62), height=d * 0.0008 + (noise(p, 240.0) - 0.5) * 0.0002)


def gun_blade():
    """A fat candy cane sharpened into a cutlass. The straight of the cane is the blade, the wool-wrapped middle is the
    grip, and the crook turns back under the mitten as a knuckle guard. A peppermint sits where blade meets grip, with
    a sprig of holly on it."""
    GRIP_R, GRIP_H = 0.0335, 0.054                 # the grip's radius and half its length
    HUB_Y, HUB_R, HUB_W = 0.112, 0.057, 0.040       # the peppermint: where it sits, its radius, half its thickness
    Y0, TIP_Y = HUB_Y + 0.012, 0.826                # the blade's root (buried in the peppermint) and its tip
    T_TIP = 0.77                                    # where the blade starts to close into its point (0..1 along it)
    CROOK_Y, CROOK_R, ROD = -0.066, 0.058, 0.025    # where the crook starts to turn, how tightly, and how thick the cane is
    TAIL_Y = 0.074                                  # the crook's free end
    PITCH = 0.135                                   # blade stripes: metres along the blade per stripe

    def hz(t):                                      # half the blade's height: a little belly, like a cutlass
        return 0.048 + 0.005 * G.sstep(0.0, 0.55, t) - 0.004 * G.sstep(0.55, T_TIP, t)

    def hx(t):                                      # half its thickness
        return 0.030 - 0.007 * G.sstep(0.0, T_TIP, t)

    def point(t):                                   # how far the tip has closed (1 = full section, 0 = the point)
        s = max(0.0, (t - T_TIP) / (1.0 - T_TIP))
        return (1.0 - s ** 1.85) ** 0.80

    def blade_c(y):                                 # the centre line lifts toward the tip, and the edge sweeps up to the point
        t = (y - Y0) / (TIP_Y - Y0)
        s = max(0.0, (t - T_TIP) / (1.0 - T_TIP))
        return 0.006 * t * t + hz(t) * 0.46 * s ** 1.6

    VIS_Y = HUB_Y + HUB_R * 0.93                    # where the blade comes out of the peppermint
    mid_y = (VIS_Y + TIP_Y) / 2
    gun = Gun('blade', 'CandyCaneBlade', grip=(0, 0, 0), coat=0.45, coat_rough=0.05,
              marks=dict(tip=(0, TIP_Y, blade_c(TIP_Y)), mid=(0, mid_y, blade_c(mid_y))), view=((0, 0.34, -0.03), 1.0))

    # ── the blade: a round back, flat flanks, and a ground bevel down to the edge. Round each ring the points are
    #    spaced evenly (9 steps from the back to the bevel's ridge, 3 down the bevel) so the stripes wind evenly ──
    BACK_N, BEVEL_N = 9, 3
    NU = 2 * (BACK_N + BEVEL_N)
    BEVEL = BEVEL_N / (BACK_N + BEVEL_N) * 0.5       # the bevel's share of the way round, each side of the edge

    def even(P, n):
        d = np.linalg.norm(np.diff(P, axis=0), axis=1)
        acc = np.concatenate([[0.0], np.cumsum(d)])
        want = np.linspace(0, acc[-1], n + 1)
        return np.stack([np.interp(want, acc, P[:, k]) for k in range(2)], axis=1)

    def ring(t):
        a, b, k = hx(t), hz(t), point(t)
        a, b = a * k ** 0.85, b * k
        zw, zr, xr = -0.10 * b, -0.58 * b, 0.93 * a       # the widest line, and the bevel's ridge
        th = np.linspace(0, math.pi / 2, 60)
        back = np.stack([a * np.sin(th) ** 0.9, zw + (b - zw) * np.cos(th)], axis=1)
        s = np.linspace(0, 1, 12)[1:, None]
        back = np.concatenate([back, np.array([a, zw]) + (np.array([xr, zr]) - np.array([a, zw])) * s])
        s = np.linspace(0, 1, 24)
        bevel = np.stack([xr * (1 - s) ** 0.88, zr + (-b - zr) * s], axis=1)
        half = np.concatenate([even(back, BACK_N), even(bevel, BEVEL_N)[1:]])        # the back … the edge, on +x
        full = np.concatenate([half, half[-2:0:-1] * np.array([-1.0, 1.0])])
        y = Y0 + (TIP_Y - Y0) * t
        return np.stack([full[:, 0], np.full(NU, y), full[:, 1] + blade_c(y)], axis=1)
    ts = list(np.linspace(0, T_TIP, 17)) + [T_TIP + (1 - T_TIP) * (1 - (1 - k / 13) ** 1.7) for k in range(1, 14)]
    blade = G.build_mesh('Blade', G.Grid(np.array([ring(t) for t in ts]), closed_u=True, pole1=True))
    BLADE_W = blade['islands'][0][0]

    def blade_look(g):
        p = g.P()
        uv = g.uv('param')
        f = uv.x / BLADE_W                                               # round the blade: 0 on the back, 0.5 on the edge
        red = cane_stripes(frac(f * 2.0 + (p.y - Y0) / PITCH))
        licked = smooth(TIP_Y - 0.15, TIP_Y - 0.005, p.y)                # the point has been licked: the white runs pink
        col, rough, h = hard_candy(p, red, licked * 0.75)
        # the bevel is ground matt and pale, and a crust of sugar crystals runs along the very edge
        e = absv(f - 0.5)
        ground = smooth(BEVEL + 0.004, BEVEL - 0.004, e)
        d, _c, _p = voronoi(p, 235.0, 'F1', 1.0)
        crust = smooth(0.060, 0.030, e + (noise(p, 95.0, 2.0) - 0.5) * 0.034 + (d - 0.3) * 0.030)
        sparkle = smooth(0.34, 0.08, d)
        col = lerp(col, lerp(col, rgb('#ffdfe6'), 0.45), ground)
        col = lerp(col, lerp(rgb('#f6c9d3'), rgb('#ffffff'), sparkle), crust)
        rough = lerp(lerp(rough, 0.36, ground), 0.66 - sparkle * 0.40, crust)
        h = h * (1.0 - ground) + crust * (0.0007 + (0.42 - d) * 0.0022)
        return dict(color=col, rough=rough, height=h)
    gun.add(blade, blade_look, density=1.0)

    # ── the crook: the same cane carries on out of the back of the grip and turns under the knuckles ──
    path = [(0, -0.030, 0), (0, CROOK_Y * 0.75, 0)]
    for k in range(17):
        a = math.pi * k / 16
        path.append((0, CROOK_Y - CROOK_R * math.sin(a), -CROOK_R + CROOK_R * math.cos(a)))
    path += [(0, CROOK_Y + (TAIL_Y - CROOK_Y) * k / 4, -2 * CROOK_R) for k in range(1, 5)]
    crook = G.build_mesh('Crook', G.sweep(np.array(path, dtype=float), lambda t, th: (ROD * np.cos(th), ROD * np.sin(th)), nu=12, ref=(1, 0, 0), cap=True, cap_rows=3))
    CROOK_W = crook['islands'][0][0]

    def crook_look(g):
        p = g.P()
        uv = g.uv('param')
        red = cane_stripes(frac(uv.x / CROOK_W * 2.0 + uv.y / (CROOK_W * 0.55)))
        col, rough, h = hard_candy(p, red)
        return dict(color=col, rough=rough, height=h)
    gun.add(crook, crook_look, density=1.0)

    # ── the grip: a knitted wool sleeve with a gold ring at each end ──
    gprof = [(GRIP_R - 0.002, -GRIP_H - 0.004), (GRIP_R - 0.0005, -GRIP_H * 0.6), (GRIP_R, 0.0), (GRIP_R - 0.0005, GRIP_H * 0.6), (GRIP_R - 0.002, GRIP_H + 0.004)]
    grip = lathe_y('Grip', gprof, 0.0, nu=14)
    GRIP_W = grip['islands'][0][0]

    def grip_look(g):
        p = g.P()
        uv = g.uv('param')
        h, shade = looks_knit(uv.x, uv.y, GRIP_W / 14.0, 0.0098, 0.0024)
        n = noise(p, 26.0, 2.0)
        col = lerp(rgb('#0b4a22'), rgb('#1f9a48'), smooth(0.1, 0.9, shade) * (0.8 + 0.2 * n))
        band = bump_band(0.031, 0.0065, absv(p.y))
        cream = lerp(rgb('#d9cbb0'), rgb('#fff6e2'), shade)
        col = lerp(col, cream, smooth(0.35, 0.65, band))
        return dict(color=col, rough=V(0.92), height=h + (noise(p, 190.0, 2.0, 0.6) - 0.5) * 0.0006)
    gun.add(grip, grip_look, density=1.0)
    for k, y in enumerate((-GRIP_H - 0.002, GRIP_H + 0.001)):
        ringo = ring_about(f'Ferrule{k}', (0, y, 0), (0, 1, 0), GRIP_R + 0.0005, 0.0075, 0.0060, n=18, nu=6, power=2.2)
        gun.add(ringo, gold, density=0.8)

    # ── the peppermint between grip and blade ──
    hprof = [(0.0, -HUB_W), (HUB_R * 0.36, -HUB_W * 0.985), (HUB_R * 0.66, -HUB_W * 0.90), (HUB_R * 0.87, -HUB_W * 0.68), (HUB_R * 0.975, -HUB_W * 0.36), (HUB_R, 0.0)]
    hprof = hprof + [(r, -h) for r, h in hprof[-2::-1]]
    hub = lathe_on('Peppermint', hprof, (0, HUB_Y, 0), (1, 0, 0), nu=24, ends=(True, True), ref=(0, 0, 1))

    def hub_look(g):
        p = g.P()
        dy = p.y - HUB_Y
        r = sqrt(dy * dy + p.z * p.z)
        ang = atan2(p.z, dy) / TAU
        k = frac(ang * 7.0 + r * 8.0)
        red = smooth(0.40, 0.52, absv(k - 0.5) * 2.0) * smooth(0.0055, 0.0085, r)
        col, rough, h = hard_candy(p, red)
        return dict(color=col, rough=rough, height=h)
    gun.add(hub, hub_look, density=1.1)

    # ── holly: two leaves laid forward over the blade's shoulders, three berries where it meets the peppermint ──
    SPRIG = np.array([0.0, HUB_Y + HUB_R * 0.80, hz(0.0) + 0.001])
    LEAF = 1.22
    half = [(0.046, 0.0), (0.031, 0.0085), (0.025, 0.0190), (0.011, 0.0115), (0.003, 0.0220), (-0.011, 0.0120), (-0.021, 0.0180), (-0.031, 0.0075), (-0.040, 0.0)]
    half = [(u * LEAF, v * LEAF) for u, v in half]
    outline = half + [(u, -v) for u, v in half[-2:0:-1]]
    for sd in (-1, 1):
        ex = np.array([sd * 0.52, 0.85, 0.05]); ex /= np.linalg.norm(ex)
        nrm = np.array([sd * 0.58, -0.10, 0.80])
        ey = np.cross(nrm, ex); ey /= np.linalg.norm(ey)
        ez = np.cross(ex, ey)
        centre = SPRIG + ex * 0.040 * LEAF + ez * 0.002
        gr = G.slab(outline, 0.0056, bevel=0.3, n_inset=1)
        P = gr.P
        u, v = P[..., 0] + 0.040 * LEAF, P[..., 1]
        P[..., 2] += -3.4 * u * u + 0.22 * np.abs(v) + 0.0040 * np.sin(u * 125.0) * (np.abs(v) / 0.024)     # droop, fold along the midrib, wavy rim
        gr.P = centre + P[..., :1] * ex + P[..., 1:2] * ey + P[..., 2:3] * ez
        leaf = G.build_mesh(f'Holly{sd}', gr)

        def leaf_look(g, centre=centre, ex=ex, ey=ey):
            p = g.P()
            q = p - Vec(tuple(centre))
            u = q.dot(Vec(tuple(ex))); v = q.dot(Vec(tuple(ey)))
            n = noise(p, 60.0, 2.0)
            rib = bump_band(0.0, 0.0022, v)
            vein = bump_band(0.5, 0.16, frac((u - absv(v) * 1.1) / 0.0175)) * smooth(0.002, 0.005, absv(v))
            col = lerp(rgb('#0a4f20'), rgb('#1d8f3e'), smooth(0.2, 0.8, n))
            col = lerp(col, rgb('#6cc46a'), clamp01(rib + vein * 0.45) * 0.55)
            return dict(color=col, rough=0.26 + (n - 0.5) * 0.08, height=rib * 0.0006 - vein * 0.0005)
        gun.add(leaf, leaf_look, density=1.0)
    bprof = [(0.0, -1.0), (0.59, -0.81), (0.95, -0.31), (0.95, 0.31), (0.59, 0.81), (0.0, 1.0)]

    def berry_look(g):
        p = g.P()
        n = noise(p, 70.0, 2.0)
        return dict(color=lerp(rgb('#b00a22'), rgb('#f02a40'), smooth(0.2, 0.8, n)), rough=V(0.14), height=V(0.0))
    for k, (dx, dy, dz, r) in enumerate(((0.0105, -0.011, 0.0075, 0.0118), (-0.0105, -0.011, 0.0075, 0.0118), (0.0, 0.006, 0.0065, 0.0125))):
        c = SPRIG + (dx, dy, dz)
        berry = lathe_on(f'Berry{k}', [(a * r, b * r) for a, b in bprof], tuple(c), (0.2 * (k - 1), -0.2, 1), nu=8, ends=(True, True), ref=(1, 0, 0))
        gun.add(berry, berry_look, density=0.8)
    return gun


GUNS = {'cocoa': gun_cocoa, 'water': gun_water, 'blade': gun_blade}


# ───────────────────────── build ─────────────────────────

def report(gun, objs):
    P = np.concatenate([G.positions(o) for o in objs]) - gun.grip
    lo, hi = P.min(axis=0), P.max(axis=0)
    print(f'[{gun.name}] ' + '  '.join(f'{o.name} {G.tri_count([o])}' for o in objs))
    print(f'[{gun.name}] triangles: {G.tri_count(objs)}  parts: {len(objs)}  length {hi[1] - lo[1]:.3f}  height {hi[2] - lo[2]:.3f}  width {hi[0] - lo[0]:.3f} m')
    print(f'[{gun.name}] box (Blender, origin at the grip): x {lo[0]:.3f}..{hi[0]:.3f}  y {lo[1]:.3f}..{hi[1]:.3f}  z {lo[2]:.3f}..{hi[2]:.3f}')
    print(f'[{gun.name}] in the GLB: ' + '  '.join(f'{k} ({m[0]:.3f}, {m[2]:.3f}, {-m[1]:.3f})' for k, m in ((k, v - gun.grip) for k, v in gun.marks.items())))


def pack_even(objs, size, pad_px=10, density=None):
    """Shelf-pack every island into the atlas like bake.pack_atlas, but keep the texels close to square (that one
    will stretch the whole atlas up to 4:1 when it packs tighter, which blurs fine patterns one way)."""
    density = density or {}
    rects = []
    for o in objs:
        m = density.get(o.name, 1.0)
        for k, (w, h) in enumerate(o['islands']):
            rects.append(dict(o=o, k=k, w=w * m, h=h * m, m=m))
    pad = pad_px / size

    def attempt(s, asp, tall, commit=False):
        sx, sy = s * asp, s / asp
        items = []
        for r in rects:
            rot = (r['h'] > r['w']) != tall
            W, H = (r['h'], r['w']) if rot else (r['w'], r['h'])
            items.append((r, rot, W * sx, H * sy))
        items.sort(key=lambda it: -it[3])
        shelves = []                                  # [y, height, next x]
        y = pad
        for r, rot, w, h in items:
            if w + 2 * pad > 1.0:
                return False
            for sh in shelves:
                if sh[2] + w + pad <= 1.0:
                    break
            else:
                if y + h + pad > 1.0:
                    return False
                sh = [y, h, pad]; shelves.append(sh); y += h + pad
            if commit:
                r.update(x=sh[2], y=sh[0], sx=sx, sy=sy, rot=rot)
            sh[2] += w + pad
        return True

    best = (0.0, 1.0, False)
    for tall in (False, True):
        for asp in (0.8, 0.9, 1.0, 1.1, 1.25):
            lo, hi = 0.0, 50.0
            for _ in range(36):
                mid = 0.5 * (lo + hi)
                if attempt(mid, asp, tall):
                    lo = mid
                else:
                    hi = mid
            if lo > best[0]:
                best = (lo, asp, tall)
    s, asp, tall = best
    attempt(s, asp, tall, commit=True)
    by = {(r['o'].name, r['k']): r for r in rects}
    for o in objs:
        me = o.data
        n = len(me.loops)
        isl = np.zeros(n, dtype=np.int32); me.attributes['island'].data.foreach_get('value', isl)
        pu = np.zeros(n * 2); me.uv_layers['param'].data.foreach_get('uv', pu); pu = pu.reshape(-1, 2)
        out = np.zeros((n, 2))
        for k, (w, h) in enumerate(o['islands']):
            r = by[(o.name, k)]; sel = isl == k
            u = pu[sel, 0] * r['m']; v = pu[sel, 1] * r['m']
            if r['rot']:
                out[sel, 0] = r['x'] + v * r['sx']; out[sel, 1] = r['y'] + (w * r['m'] - u) * r['sy']
            else:
                out[sel, 0] = r['x'] + u * r['sx']; out[sel, 1] = r['y'] + v * r['sy']
        me.uv_layers['atlas'].data.foreach_set('uv', out.reshape(-1))
        me.uv_layers.active = me.uv_layers['atlas']
        me.uv_layers['atlas'].active_render = True
    used = sum(r['w'] * r['h'] for r in rects) * s * s
    print(f'[atlas] {len(rects)} islands, {s * size:.0f} px per metre, stretch {asp}, {used * 100:.0f}% used')


def assign_looks(gun):
    cache = {}
    for p in gun.parts:
        key = p['look']
        if key not in cache:
            cache[key] = B.look(f'look_{gun.name}_{len(cache)}', p['look'])
        p['ob'].data.materials.clear()
        p['ob'].data.materials.append(cache[key])


def shapes(name, out_dir):
    """Quick Cycles renders of the model with its procedural looks: for judging shape, not final colour."""
    from lib import render as RD
    bpy.ops.wm.read_factory_settings(use_empty=True)
    gun = GUNS[name]()
    objs = [p['ob'] for p in gun.parts]
    report(gun, objs)
    assign_looks(gun)
    made = RD.studio(ground=True)
    made[-1].location = (0, 0, -0.16)
    os.makedirs(out_dir, exist_ok=True)
    shots = []
    tgt, far = gun.view
    for k, (az, el, dist) in enumerate(((90, 6, 2.0), (38, 18, 2.0), (-145, 24, 2.0), (-90, 4, 2.0), (180, 12, 1.6), (60, 62, 2.0))):
        shots.append(RD.shot(os.path.join(out_dir, f'gun_{name}_{k}.png'), target=tgt, dist=dist * far, az=az, el=el, fov=24, res=(760, 560), samples=24))
    RD.sheet(shots, os.path.join(out_dir, f'gun_{name}_shapes.png'), cols=3)


def build(name, size, ao, out_dir):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    gun = GUNS[name]()
    objs = [p['ob'] for p in gun.parts]
    report(gun, objs)
    assign_looks(gun)
    pack_even(objs, size, pad_px=10, density=gun.density)
    main = G.join(objs, gun.node)
    paths = B.bake([main], size, out_dir, 'gun_' + name, ao_samples=ao, ao_dist=0.09, ao_in_color=0.40, margin=5)
    mat = B.export_material('Gun_' + name, paths, coat=gun.coat, coat_rough=gun.coat_rough)
    me = main.data
    me.materials.clear(); me.materials.append(mat)
    me.polygons.foreach_set('material_index', [0] * len(me.polygons))
    me.uv_layers.remove(me.uv_layers['param'])
    me.attributes.remove(me.attributes['island'])
    shift = np.eye(4); shift[:3, 3] = -gun.grip
    G.transform(main, shift)
    extras = []
    for nm, pos in gun.marks.items():
        e = bpy.data.objects.new(nm, None)
        bpy.context.scene.collection.objects.link(e)
        e.empty_display_size = 0.02
        e.parent = main
        e.location = tuple(pos - gun.grip)
        extras.append(e)
    glb = os.path.join(REPO, 'src', 'assets', 'models', 'guns', name + '.glb')
    EX.export_glb(glb, [main] + extras)


def main():
    args = sys.argv[1:]
    size, ao = 1024, 48
    names = []
    out_dir = os.path.join(HERE, 'out')
    shapes_only = False
    for a in args:
        if a.startswith('--size='):
            size = int(a.split('=')[1])
        elif a.startswith('--ao='):
            ao = int(a.split('=')[1])
        elif a.startswith('--out='):
            out_dir = a.split('=', 1)[1]
        elif a == '--shapes':
            shapes_only = True
        else:
            names.append(a)
    for n in (names or list(GUNS)):
        if shapes_only:
            shapes(n, out_dir)
        else:
            build(n, size, ao, out_dir)


if __name__ == '__main__':
    main()
