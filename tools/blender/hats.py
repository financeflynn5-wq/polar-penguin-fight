"""Every hat in the game, built to fit the penguin's head and exported as src/assets/models/hats/<name>.glb.

    python tools/blender/hats.py                 # all hats
    python tools/blender/hats.py beanie crown    # just these
    options: --size=1024 (texture size)  --ao=48 (occlusion samples)

Each hat is modelled in the penguin's space (it faces +Y, up is +Z, feet at the origin) and then moved so its origin
is the head's hat joint. Parts named spin* turn (the propeller); parts named jiggle* wobble (pom-poms, the fish tail).
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
from lib.geom import sstep  # noqa: E402
from lib.nodes import (rgb, Vec, V, sin, cos, absv, frac, floor, vmin, vmax, clamp01, atan2, smooth, lerp, noise, voronoi,  # noqa: E402
                       bump_band, sqrt)
from lib.looks import knit, fuzz, TAU  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
HEAD_C = np.array([0.0, 0.012, 0.878])
HEAD_R = np.array([0.298, 0.286, 0.270])
HEAD = G.ellipsoid(HEAD_C, HEAD_R)
SOCKET = np.array([0.0, 0.0, 1.06])


def head_radius(z):
    """Mean radius of the head at height z."""
    k = max(0.0, 1.0 - ((z - HEAD_C[2]) / HEAD_R[2]) ** 2)
    return 0.292 * math.sqrt(k)


def rot_matrix(rx=0.0, ry=0.0, rz=0.0, pivot=SOCKET):
    """4x4: rotate about a pivot (x, then y, then z)."""
    cx, sx, cy, sy, cz, sz = math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    Rm = Rz @ Ry @ Rx
    M = np.eye(4); M[:3, :3] = Rm; M[:3, 3] = pivot - Rm @ pivot
    return M


def lumpy(ob, amp, freq, seed=0.0):
    """Push vertices in and out along their normals with smooth noise (for fluff)."""
    def fn(P):
        return amp * (np.sin(P[:, 0] * freq + seed) * np.sin(P[:, 1] * freq * 1.13 + seed * 1.7) * np.sin(P[:, 2] * freq * 0.91 + seed * 2.3)
                      + 0.5 * np.sin(P[:, 0] * freq * 2.3 + 1 + seed) * np.sin(P[:, 1] * freq * 2.1 + 2) * np.sin(P[:, 2] * freq * 1.9 + 3))
    G.displace(ob, fn)


def ball(name, c, r, nu=14, nv=10, squash=(1, 1, 1)):
    c = np.array(c, dtype=float)
    f = G.ellipsoid(c, (r * squash[0], r * squash[1], r * squash[2]))
    return G.build_mesh(name, G.blob(f, c, nu=nu, nv=nv, cap_r=r, tmax=r * 4))


def ring_along(name, pts, sec_a, sec_b, nu=8, ref=(0, 0, 1), n=2.0):
    sec = G.superellipse(sec_a, sec_b, n)
    return G.build_mesh(name, G.sweep(np.array(pts), lambda t, th: sec(th), nu=nu, closed=True, ref=ref))


class Hat:
    def __init__(self, name, tilt=(0, 0, 0), sheen=0.0, sheen_rough=0.5, coat=0.0, scale=1.0):
        self.name = name; self.parts = []; self.tilt = tilt; self.scale = scale
        self.sheen = sheen; self.sheen_rough = sheen_rough; self.coat = coat
        self.density = {}

    def add(self, ob, look, node=None, pivot=None, density=1.0):
        """look: function(g) → dict for bake.look. node: None (the hat itself) or 'spin' / 'jiggle…' with a pivot."""
        self.parts.append(dict(ob=ob, look=look, node=node, pivot=pivot))
        self.density[ob.name] = density
        return ob


# ───────────────────────── shared looks ─────────────────────────

def flat(color, rough=0.6, metal=0.0, grain=0.0004, grain_scale=160.0):
    def f(g):
        p = g.P()
        n = noise(p, grain_scale, 2.0)
        return dict(color=rgb(color) * (0.92 + 0.16 * noise(p, 12.0, 2.0)), rough=rough + (n - 0.5) * 0.1, metal=V(metal), height=(n - 0.5) * grain)
    return f


def fluff(color='#fbf7ee', shade='#cfc6b4'):
    def f(g):
        p = g.P()
        d, _c, _p = voronoi(p, 70.0, 'SMOOTH_F1', 1.0, 0.6)
        n = noise(p, 170.0, 2.0, 0.6)
        return dict(color=lerp(rgb(shade), rgb(color), smooth(0.55, 0.12, d)), rough=V(0.96), height=(0.55 - d) * 0.008 + (n - 0.5) * 0.003)
    return f


def gold(g, engrave=None):
    p = g.P()
    n = noise(p, 60.0, 3.0, 0.6)
    scratch = noise(p * Vec((1.0, 1.0, 14.0)), 55.0, 1.0)
    col = lerp(rgb('#f2a81d'), rgb('#ffd65a'), smooth(0.3, 0.7, n))
    h = (scratch - 0.5) * 0.0003
    rough = 0.20 + (scratch - 0.5) * 0.10 + (n - 0.5) * 0.08
    if engrave is not None:
        col = lerp(col, rgb('#a8650a'), engrave * 0.7)
        h = h - engrave * 0.0016
        rough = rough + engrave * 0.2
    return dict(color=col, rough=rough, metal=V(1.0), height=h)


# ───────────────────────── beanie ─────────────────────────

def hat_beanie():
    hat = Hat('beanie', tilt=(-0.05, 0, 0))  # no fuzzy sheen: in full sun it turns the red pink
    c = HEAD_C + (0, 0, 0.0)
    shell = G.offset(HEAD, 0.026)
    slouch = G.ellipsoid((0, -0.045, 1.125), (0.225, 0.225, 0.165))
    f = G.add(shell, slouch, 0.12)
    rim = lambda th: 0.10 + 0.30 * (1 - math.cos(th)) / 2  # noqa: E731  sits just above the eyes, lower at the back
    g = G.dome(f, c, rim, nu=44, nv=14, ref=(0, -1, 0))  # the seam is at the back
    dome = G.build_mesh('BeanieDome', g)
    W = dome['islands'][0][0]
    wale = W / round(W / 0.0165)  # whole stitches and whole zig-zags round the hat, so the pattern has no seam
    zz = W / round(W / 0.066)

    def dome_look(gr):
        uv = gr.uv('param'); p = gr.P()
        h, shade = knit(uv.x, uv.y, wale, 0.0112, 0.0030)
        # a Nordic band: zig-zag between two rows of dots
        tri = absv(frac(uv.x / zz) - 0.5) * 2.0
        zig = bump_band(0.118, 0.011, uv.y - tri * 0.040)
        dots = bump_band(0.5, 0.26, frac(uv.x / (zz / 2.0))) * (bump_band(0.095, 0.008, uv.y) + bump_band(0.186, 0.008, uv.y))
        white = clamp01(smooth(0.3, 0.6, zig) + smooth(0.4, 0.7, dots))
        red = lerp(rgb('#74081a'), rgb('#c20e28'), shade)
        cream = lerp(rgb('#d8d2c4'), rgb('#fffaf0'), shade)
        return dict(color=lerp(red, cream, white), rough=V(0.93), height=h + fuzz(p, 0.0007))
    hat.add(dome, dome_look, density=1.0)

    # folded cuff
    ring = g.P[0].copy()
    out = ring - c; out[:, 2] = 0; out /= np.linalg.norm(out, axis=1, keepdims=True)
    path = ring + out * 0.010 + np.array([0, 0, 0.034])
    cuff = ring_along('BeanieCuff', path, 0.050, 0.025, nu=10, ref=(0, 0, 1), n=2.6)
    Wc = cuff['islands'][0][1]
    ribw = Wc / round(Wc / 0.0195)

    def cuff_look(gr):
        uv = gr.uv('param'); p = gr.P()
        rib = 0.5 + 0.5 * cos(uv.y / ribw * TAU)
        h, shade = knit(uv.y, uv.x, ribw / 2.0, 0.009, 0.0011)
        col = lerp(rgb('#cfc8ba'), rgb('#fffaf0'), smooth(0.05, 0.75, rib) * (0.78 + 0.22 * shade))
        return dict(color=col, rough=V(0.93), height=rib * 0.0050 + h + fuzz(p, 0.0007))
    hat.add(cuff, cuff_look)

    top = np.array([0, -0.07, 1.325])
    pom = ball('BeaniePom', top, 0.092, nu=18, nv=12)
    lumpy(pom, 0.010, 55.0, 1.0)
    hat.add(pom, fluff(), node='jiggle_pom', pivot=top + (0, 0.01, -0.075))
    return hat


# ───────────────────────── top hat ─────────────────────────

def hat_tophat():
    hat = Hat('tophat', tilt=(0.05, 0.14, 0), sheen=0.3, sheen_rough=0.4)
    z0 = 1.078
    prof = [(0.120, -0.006), (0.300, -0.006), (0.300, 0.010), (0.181, 0.010), (0.166, 0.150), (0.192, 0.305), (0.150, 0.312), (0.0, 0.300)]
    prof = G.round_profile(prof, [0.008, 0.008, 0.012, 0.0, 0.012, 0.03], segs=3)
    prof = [(r, h + z0) for r, h in prof]
    body = G.build_mesh('TopHat', G.lathe(prof, nu=40, closed_ends=(False, True)))
    P = G.positions(body)
    r = np.hypot(P[:, 0], P[:, 1])
    brim = sstep(0.20, 0.30, r) * (P[:, 2] < z0 + 0.02)
    P[:, 2] += brim * (0.050 * (P[:, 0] / 0.30) ** 2 - 0.012 * (P[:, 1] / 0.30) ** 2)  # the brim curls up at the sides
    G.set_positions(body, P)

    def felt(g):
        p = g.P()
        n = noise(p, 300.0, 2.0)
        nap = noise(p * Vec((1.0, 1.0, 0.2)), 40.0, 2.0)
        col = lerp(rgb('#0c0c12'), rgb('#22222c'), smooth(0.3, 0.75, nap))
        return dict(color=col, rough=0.60 + (nap - 0.5) * 0.25, height=(n - 0.5) * 0.0004)
    hat.add(body, felt)

    band_prof = [(0.1835, z0 + 0.012), (0.1845, z0 + 0.016), (0.1790, z0 + 0.064), (0.1765, z0 + 0.068)]
    band = G.build_mesh('TopHatBand', G.lathe(G.smooth_profile(band_prof, 6), nu=40))

    def ribbon(g):
        p = g.P()
        ribs = 0.5 + 0.5 * sin(p.z * TAU / 0.0042)
        col = lerp(rgb('#8f0f22'), rgb('#d2203c'), smooth(0.2, 0.8, ribs))
        return dict(color=col, rough=0.34 + ribs * 0.12, height=ribs * 0.0005)
    hat.add(band, ribbon)

    # holly sprig tucked into the band (penguin's left side)
    a0 = math.radians(128)
    base = np.array([math.sin(a0) * 0.186, math.cos(a0) * 0.186, z0 + 0.055])
    outward = np.array([math.sin(a0), math.cos(a0), 0.0])
    side = np.array([math.cos(a0), -math.sin(a0), 0.0])

    def leaf_outline(length, width):
        pts = []
        n = 5
        for k in range(n * 2 + 1):  # up one side with spikes, back down the other
            t = k / (n * 2)
            w = width * math.sin(math.pi * t) ** 0.7 * (1.0 if k % 2 else 0.62)
            pts.append((t * length, w))
        for k in range(n * 2 - 1, 0, -1):
            t = k / (n * 2)
            w = width * math.sin(math.pi * t) ** 0.7 * (1.0 if k % 2 else 0.62)
            pts.append((t * length, -w))
        return pts

    def leaf_look(g):
        p = g.P()
        n = noise(p, 40.0, 2.0)
        return dict(color=lerp(rgb('#0f5a26'), rgb('#2f9a3e'), n), rough=0.32 + n * 0.1, height=(n - 0.5) * 0.0006)
    for k, (ang, lift) in enumerate(((0.55, 0.5), (-0.5, 0.35), (0.05, 0.95))):
        d = side * math.sin(ang) + np.array([0, 0, 1]) * math.cos(ang) * lift + outward * 0.25
        d /= np.linalg.norm(d)
        w = np.cross(d, outward); w /= np.linalg.norm(w)
        leaf = G.build_mesh(f'Holly{k}', G.slab(leaf_outline(0.105, 0.030), 0.007, origin=base + outward * 0.006, x=d, y=w, bevel=0.3, bulge=0.004))
        hat.add(leaf, leaf_look)
    for k, off in enumerate(((0.0, 0.0), (0.022, 0.012), (-0.02, 0.014))):
        berry = ball(f'Berry{k}', base + outward * 0.020 + side * off[0] + np.array([0, 0, off[1] - 0.012]), 0.0165, nu=10, nv=8)
        hat.add(berry, lambda g: dict(color=lerp(rgb('#b00d1e'), rgb('#ff3a4a'), noise(g.P(), 30.0)), rough=V(0.16), height=V(0.0)))

    # gold buckle on the band at the front
    fz = z0 + 0.040
    fr = 0.1835
    bw, bh = 0.030, 0.021
    loop = []
    for k in range(20):
        a = k / 20 * TAU
        cx = max(-1, min(1, math.cos(a) * 1.5)) * bw
        cz = max(-1, min(1, math.sin(a) * 1.5)) * bh
        ang = cx / fr
        loop.append((math.sin(ang) * (fr + 0.004), math.cos(ang) * (fr + 0.004), fz + cz))
    buckle = ring_along('Buckle', loop, 0.0055, 0.0055, nu=6, ref=(0, 1, 0), n=2.6)
    hat.add(buckle, lambda g: gold(g))
    return hat


# ───────────────────────── propeller cap ─────────────────────────

def hat_propeller():
    hat = Hat('propeller', tilt=(-0.05, 0, 0))
    c = HEAD_C + (0, 0, 0.05)
    f = G.offset(HEAD, 0.020)
    g = G.dome(f, c, 0.40, nu=48, nv=12, ref=(0, 1, 0))
    cap = G.build_mesh('PropCap', g)
    colors = ['#e0142c', '#ff7f0a', '#ffcc0a', '#16a046', '#1466e0', '#7a2fd6']

    def cap_look(gr):
        p = gr.P()
        ang = atan2(p.x, p.y - HEAD_C[1]) / TAU + 0.5  # 0..1 round the cap
        k = ang * 6.0
        idx = floor(k)
        fr = frac(k)
        col = rgb(colors[0])
        for i in range(1, 6):
            col = lerp(col, rgb(colors[i]), smooth(i - 0.5, i - 0.49, idx))
        ds = vmin(fr, 1.0 - fr) * 0.16  # distance to the nearest seam, roughly in metres at the rim
        seam = 1.0 - smooth(0.0, 0.005, ds)
        stitch = (1.0 - smooth(0.004, 0.0075, absv(ds - 0.010))) * smooth(0.3, 0.5, absv(frac(p.z / 0.012) - 0.5) * 2.0)
        weave = noise(p, 380.0, 1.0)
        col = col * (0.92 + 0.12 * weave) * (1.0 - seam * 0.35)
        col = lerp(col, rgb('#fff6da'), stitch * 0.75)
        return dict(color=col, rough=0.72 + seam * 0.1, height=-seam * 0.0022 + stitch * 0.0009 + (weave - 0.5) * 0.0005)
    hat.add(cap, cap_look)

    rimring = g.P[0].copy()
    out = rimring - c; out[:, 2] = 0; out /= np.linalg.norm(out, axis=1, keepdims=True)
    piping = ring_along('PropPiping', rimring + out * 0.004, 0.009, 0.012, nu=6)
    hat.add(piping, flat('#f4efe2', 0.8))

    # little visor at the front
    zr = float(rimring[:, 2].mean())
    rr = float(np.hypot(rimring[:, 0], rimring[:, 1] - HEAD_C[1]).mean())
    outline = []
    for k in range(17):
        a = (k / 16 - 0.5) * 1.5
        outline.append((math.sin(a) * (rr + 0.105 * math.cos(a * 1.9) ** 0.8), math.cos(a) * (rr + 0.105 * math.cos(a * 1.9) ** 0.8)))
    for k in range(16, -1, -1):
        a = (k / 16 - 0.5) * 1.5
        outline.append((math.sin(a) * (rr - 0.03), math.cos(a) * (rr - 0.03)))
    visor = G.build_mesh('PropVisor', G.slab(outline, 0.012, origin=(0, HEAD_C[1], zr - 0.004), x=(1, 0, 0), y=(0, 1, 0), bevel=0.4, n_inset=1))
    P = G.positions(visor)
    P[:, 2] += np.clip(P[:, 1] - rr * 0.9, 0, None) * 0.42 - (P[:, 0] / 0.2) ** 2 * 0.02  # flipped up, so it never hides the eyes
    G.set_positions(visor, P)
    hat.add(visor, flat('#ffd62e', 0.6, grain=0.0006, grain_scale=300.0))

    top = float(g.P[-1][0][2])
    button = ball('PropButton', (0, HEAD_C[1], top + 0.004), 0.026, squash=(1, 1, 0.55))
    hat.add(button, flat('#e8283c', 0.5))
    shaft = G.build_mesh('PropShaft', G.lathe(G.round_profile([(0.0, top), (0.009, top), (0.009, top + 0.075), (0.0, top + 0.079)], 0.003), nu=10, closed_ends=(True, True)))
    hat.add(shaft, lambda gr: dict(color=rgb('#c9ced6'), rough=V(0.3), metal=V(1.0), height=V(0.0)))

    hub_c = np.array([0, HEAD_C[1], top + 0.079])
    hub = ball('spinHub', hub_c, 0.021, squash=(1, 1, 0.8))
    hat.add(hub, flat('#e8283c', 0.35), node='spin', pivot=hub_c)
    for s in (-1, 1):
        outline = []
        for k in range(24):
            a = k / 24 * TAU
            # a teardrop: narrow at the hub, round at the tip
            u = 0.105 + 0.105 * math.cos(a)
            w = 0.042 * math.sin(a) * (0.45 + 0.55 * (u / 0.21))
            outline.append((u, w))
        blade = G.build_mesh(f'spinBlade{s}', G.slab(outline, 0.008, origin=hub_c, x=(s, 0, 0), y=(0, s, 0), bevel=0.45, bulge=0.003, n_inset=1))
        P = G.positions(blade) - hub_c
        a = 0.38  # pitch each blade about its own length
        y = P[:, 1] * math.cos(a) - P[:, 2] * math.sin(a) * s
        z = P[:, 1] * math.sin(a) * s + P[:, 2] * math.cos(a)
        P[:, 1], P[:, 2] = y, z
        G.set_positions(blade, P + hub_c)

        def blade_look(gr, s=s):
            p = gr.P()
            tip = smooth(0.135, 0.150, absv(p.x))
            col = lerp(rgb('#ffd62e'), rgb('#e8283c'), tip)
            return dict(color=col, rough=V(0.32), height=(noise(p, 200.0) - 0.5) * 0.0003)
        hat.add(blade, blade_look, node='spin', pivot=hub_c)
    return hat


# ───────────────────────── viking helmet ─────────────────────────

def hat_viking():
    hat = Hat('viking', tilt=(-0.04, 0, 0))
    c = HEAD_C + (0, 0, 0.02)
    f = G.offset(HEAD, 0.024)
    rim = lambda th: 0.34 - 0.20 * (1 - math.cos(th)) / 2  # noqa: E731
    g = G.dome(f, c, rim, nu=44, nv=12, ref=(0, 1, 0))
    dome = G.build_mesh('VikingDome', g)

    def steel(gr):
        p = gr.P()
        d, _c, _p = voronoi(p, 58.0, 'SMOOTH_F1', 1.0, 0.35)
        n = noise(p, 26.0, 3.0, 0.6)
        col = lerp(rgb('#8e949a'), rgb('#d2d6da'), smooth(0.25, 0.75, n))
        col = lerp(col, rgb('#4a4038'), smooth(0.62, 0.9, noise(p, 9.0, 2.0)) * 0.35)  # a little tarnish
        return dict(color=col, rough=0.40 + d * 0.22 + (n - 0.5) * 0.12, metal=V(1.0), height=d * 0.0022 + (noise(p, 240.0) - 0.5) * 0.0003)
    hat.add(dome, steel)

    def brass(gr):
        p = gr.P()
        n = noise(p, 45.0, 3.0, 0.6)
        col = lerp(rgb('#a87416'), rgb('#e6b040'), smooth(0.25, 0.75, n))
        return dict(color=col, rough=0.28 + (n - 0.5) * 0.2, metal=V(1.0), height=(noise(p, 200.0) - 0.5) * 0.0004)

    ring = g.P[0].copy()
    out = ring - c; out[:, 2] = 0; out /= np.linalg.norm(out, axis=1, keepdims=True)
    rimband = ring_along('VikingRim', ring + out * 0.004 + np.array([0, 0, 0.016]), 0.011, 0.026, nu=8, n=3.0)
    hat.add(rimband, brass)
    # a band over the top, front to back
    col = g.P[:, 0]  # the front meridian (theta = 0)
    back = g.P[:, len(g.P[0]) // 2][::-1]
    crest = np.concatenate([col[:-1], g.P[-1][:1], back[1:]], axis=0)
    crest = crest + (crest - c) / np.linalg.norm(crest - c, axis=1, keepdims=True) * 0.003
    crest = G.resample(crest, 26)
    sec = G.superellipse(0.008, 0.024, 3.0)
    band = G.build_mesh('VikingCrest', G.sweep(crest, lambda t, th: sec(th), nu=8, ref=(0, 0, 1), cap=True, cap_rows=2))
    hat.add(band, brass)
    # rivets round the rim and along the crest
    k = 0
    n_r = len(ring)
    for i in range(0, n_r, n_r // 11):
        pos = ring[i] + out[i] * 0.016 + np.array([0, 0, 0.016])
        hat.add(ball(f'Rivet{k}', pos, 0.0105, nu=8, nv=6), brass, density=0.6); k += 1
    for i in (4, 9, 13, 17, 22):
        pos = crest[i] + (crest[i] - c) / np.linalg.norm(crest[i] - c) * 0.008
        hat.add(ball(f'Rivet{k}', pos, 0.0105, nu=8, nv=6), brass, density=0.6); k += 1
    # nose guard
    fr = ring[0]
    ng = np.array([fr + (0, 0.004, 0.0), fr + (0, 0.014, -0.045), fr + (0, 0.022, -0.095)])
    nsec = lambda t, th: G.superellipse(0.007, 0.024 - 0.008 * t, 3.0)(th)  # noqa: E731
    nose = G.build_mesh('VikingNose', G.sweep(G.resample(ng, 8), nsec, nu=8, ref=(0, 1, 0), cap=True, cap_rows=2))
    hat.add(nose, brass)

    # horns
    for s in (-1, 1):
        pts = np.array([[0.235, 0.0, 1.035], [0.335, 0.0, 1.045], [0.430, -0.004, 1.095], [0.478, -0.010, 1.190], [0.452, -0.018, 1.300], [0.405, -0.024, 1.365]])
        pts[:, 0] *= s
        path = G.resample(pts, 20)
        hsec = lambda t, th: ((0.074 * (1 - t) ** 0.85 + 0.007) * np.cos(th), (0.074 * (1 - t) ** 0.85 + 0.007) * np.sin(th))  # noqa: E731
        horn = G.build_mesh(f'Horn{s}', G.sweep(path, hsec, nu=14, ref=(0, 1, 0), cap=True, cap_rows=3))

        def horn_look(gr):
            uv = gr.uv('param'); p = gr.P()
            t = smooth(0.0, 0.36, uv.y)
            ridge = 0.5 + 0.5 * sin(uv.y * TAU / 0.024 + noise(p, 30.0) * 3.0)
            col = lerp(rgb('#fff6df'), rgb('#e2cfa4'), t)
            col = lerp(col, rgb('#5a3d22'), smooth(0.62, 1.0, t))
            col = col * (0.9 + 0.1 * ridge)
            streak = noise(p * Vec((6.0, 6.0, 6.0)), 30.0, 2.0)
            return dict(color=col * (0.93 + 0.14 * streak), rough=0.38 + ridge * 0.12, height=ridge * 0.0014 * (1.0 - t * 0.6))
        hat.add(horn, horn_look)
        collar_c = path[2]
        T, Nn, Bn = G.path_frames(path, (0, 1, 0))
        th = np.linspace(0, TAU, 18, endpoint=False)
        ringp = np.array([collar_c + (Nn[2] * math.cos(a) + Bn[2] * math.sin(a)) * 0.074 for a in th])
        collar = ring_along(f'HornCollar{s}', ringp, 0.011, 0.022, nu=8, ref=tuple(T[2]), n=2.6)
        hat.add(collar, brass)
    return hat


# ───────────────────────── crown ─────────────────────────

def hat_crown():
    hat = Hat('crown', tilt=(0.04, 0.16, 0), scale=1.22)
    z0 = 1.086
    cy = HEAD_C[1]
    nu = 60
    th = np.linspace(0, TAU, nu, endpoint=False)
    points = 5

    def height(a):
        pk = (0.5 + 0.5 * np.cos(points * a)) ** 2.2
        return 0.062 + 0.088 * pk

    Hh = height(th)
    rows = []
    r_in = 0.150

    def ring(r, h):
        return np.stack([np.sin(th) * r, cy + np.cos(th) * r, z0 + h], axis=1)
    r_out = lambda h: 0.166 + 0.030 * (h / 0.15) ** 1.3  # noqa: E731  flares out toward the points
    rows.append(ring(r_in, np.zeros(nu) + 0.004))
    rows.append(ring(0.160, np.zeros(nu) - 0.002))
    rows.append(ring(0.166, np.zeros(nu) + 0.004))
    for k in (0.12, 0.3, 0.5, 0.7, 0.86, 0.96):
        rows.append(ring(r_out(Hh * k), Hh * k))
    rows.append(ring(r_out(Hh) - 0.004, Hh + 0.003))
    rows.append(ring(r_out(Hh) - 0.011, Hh + 0.001))
    for k in (0.86, 0.5, 0.15):
        rows.append(ring(r_out(Hh * k) - 0.015, Hh * k))
    band = G.build_mesh('CrownBand', G.Grid(np.array(rows), closed_u=True))

    def band_look(gr):
        p = gr.P()
        ang = atan2(p.x, p.y - cy)
        h = p.z - z0
        # engraved diamonds round the base band
        u = ang * 0.166 / 0.028
        dia = absv(frac(u) - 0.5) + absv((h - 0.032) / 0.028 * 0.5)
        eng = (1.0 - smooth(0.02, 0.05, absv(dia - 0.32))) * smooth(0.058, 0.05, h) * smooth(0.006, 0.014, h)
        return gold(gr, eng)
    hat.add(band, band_look, density=1.1)

    # beaded rails
    for nm, h, r in (('RailLow', 0.004, 0.170), ('RailHigh', 0.058, 0.176)):
        rail = ring_along('Crown' + nm, ring(r, np.zeros(nu) + h), 0.0075, 0.0075, nu=6)
        hat.add(rail, lambda gr: gold(gr, 0.5 + 0.5 * sin(atan2(gr.P().x, gr.P().y - cy) * 60.0)))

    gems = ['#e3173a', '#1c6dea', '#17b060', '#e3173a', '#8a2be2']
    for i in range(points):
        a = i * TAU / points
        d = np.array([math.sin(a), math.cos(a), 0.0])
        tip = np.array([0, cy, z0]) + d * (r_out(0.15) - 0.007) + np.array([0, 0, 0.150 + 0.014])
        hat.add(ball(f'Pearl{i}', tip, 0.0185, nu=10, nv=8), lambda gr: dict(color=lerp(rgb('#e9e2f0'), rgb('#ffffff'), noise(gr.P(), 40.0)), rough=V(0.14), height=V(0.0)), density=0.8)
        gc = np.array([0, cy, z0]) + d * (r_out(0.032) + 0.004) + np.array([0, 0, 0.032])
        side = np.array([math.cos(a), -math.sin(a), 0.0])
        Rm = np.stack([side, d, np.array([0, 0, 1.0])], axis=1)
        gf = G.ellipsoid(gc, (0.019, 0.012, 0.024), Rm)
        gem = G.build_mesh(f'Gem{i}', G.blob(gf, gc, nu=8, nv=4, ref=tuple(d), cap_r=0.02, tmax=0.1))
        G.flat_shade(gem)
        hat.add(gem, lambda gr, cc=gems[i]: dict(color=rgb(cc), rough=V(0.04), height=V(0.0)), density=0.8)
        # small gem between the points
        a2 = a + TAU / points / 2
        d2 = np.array([math.sin(a2), math.cos(a2), 0.0])
        gc2 = np.array([0, cy, z0]) + d2 * (r_out(0.032) + 0.003) + np.array([0, 0, 0.032])
        g2 = G.build_mesh(f'GemS{i}', G.blob(G.sphere(gc2, 0.0115), gc2, nu=6, nv=3, ref=tuple(d2), cap_r=0.012, tmax=0.1))
        G.flat_shade(g2)
        hat.add(g2, lambda gr: dict(color=rgb('#fff3c8'), rough=V(0.03), height=V(0.0)), density=0.7)

    # velvet cap inside
    capf = G.ellipsoid((0, cy, z0 + 0.03), (0.158, 0.158, 0.105))
    capg = G.dome(capf, (0, cy, z0 + 0.02), 0.12, nu=30, nv=8, ref=(0, 1, 0))
    cap = G.build_mesh('CrownVelvet', capg)

    def velvet(gr):
        p = gr.P()
        n = noise(p, 300.0, 2.0)
        fold = 0.5 + 0.5 * cos(atan2(p.x, p.y - cy) * 5.0)
        col = lerp(rgb('#5e0a1c'), rgb('#b3142f'), smooth(0.2, 0.9, fold * 0.7 + noise(p, 20.0) * 0.4))
        return dict(color=col, rough=V(0.85), height=(n - 0.5) * 0.0006 + fold * 0.004)
    hat.add(cap, velvet, density=0.8)
    hat.add(ball('CrownButton', (0, cy, z0 + 0.136), 0.02, nu=10, nv=8), lambda gr: gold(gr), density=0.8)
    return hat


# ───────────────────────── fish ─────────────────────────

def hat_fish():
    """A fat fish flopped across the top of the head: nose over the right temple, tail hanging off the left."""
    hat = Hat('fish', tilt=(0, 0, 0), coat=0.6, scale=1.08)
    yaw = 0.30
    d = np.array([math.cos(yaw), math.sin(yaw), 0.0])  # where the fish's nose points (to the right and a little forward)
    up = np.array([0, 0, 1.0])
    RH, RV = 0.372, 0.352  # the fish's spine runs this far from the middle of the head
    HALF_H, HALF_T = 0.108, 0.062

    def on_head(phi):
        sink = 0.055 * sstep(-0.35, -1.0, phi)  # the tail end droops onto the head
        return HEAD_C + d * math.sin(phi) * (RH - sink) + up * math.cos(phi) * (RV - sink)

    phis = np.linspace(0.92, -0.98, 32)
    path = np.array([on_head(ph) for ph in phis])

    def prof(t):  # body size along the fish: blunt head, fat shoulders, narrow tail root
        return (math.sin(math.pi * min(1.0, t * 1.08) ** 0.62) ** 0.75) * (1 - 0.70 * sstep(0.55, 1.0, t)) + 0.12

    def section(t, th):
        sec = G.superellipse(HALF_H * prof(t), HALF_T * prof(t) ** 0.8, 2.15)  # tall and narrow, like a real fish
        return sec(th)
    ref0 = path[0] - HEAD_C
    ref0 = tuple(ref0 / np.linalg.norm(ref0))
    body = G.build_mesh('FishBody', G.sweep(path, section, nu=20, ref=ref0, cap=True, cap_rows=4))
    T, Nn, Bn = G.path_frames(path, ref0)

    def scales(gr):
        uv = gr.uv('param'); p = gr.P()
        q = p - Vec(tuple(HEAD_C))
        along = q.dot(Vec(tuple(d)))
        rad = sqrt(along * along / (RH * RH) + q.z * q.z / (RV * RV)) - 1.0  # −: belly, +: back
        s = 0.033
        row = floor(uv.y / s)
        uu = uv.x / s + frac(row * 0.5)  # every other row shifts half a scale
        fx = frac(uu) - 0.5; fy = frac(uv.y / s)
        dd = sqrt(fx * fx + (fy - 1.0) * (fy - 1.0) * 0.9)
        rimh = smooth(0.36, 0.52, dd)
        cell = Vec((1.0, 0.0, 0.0)) * floor(uu) + Vec((0.0, 1.0, 0.0)) * row
        rnd = noise(cell, 0.731, 0.0)
        back = smooth(-0.16, 0.12, rad)
        col = lerp(rgb('#f4fbff'), rgb('#1f9be0'), back)
        col = lerp(col, rgb('#0f4f9c'), smooth(0.10, 0.24, rad))
        col = lerp(col, rgb('#7ff0e0'), smooth(0.52, 0.75, rnd) * 0.45)
        col = lerp(col, rgb('#b79cff'), smooth(0.46, 0.25, rnd) * 0.30)
        # the face has no scales; a dark line marks the gill cover
        face = smooth(0.150, 0.118, uv.y)
        gill = bump_band(0.134, 0.007, uv.y + absv(rad) * 0.10)
        facecol = lerp(rgb('#f6fbff'), rgb('#2a9be0'), smooth(-0.10, 0.16, rad))
        col = lerp(col * (1.0 - rimh * 0.34) + rgb('#ffffff') * (smooth(0.30, 0.36, dd) * (1.0 - rimh) * 0.10), facecol, face)
        col = col * (1.0 - gill * 0.5)
        hgt = (1.0 - fy) * 0.0022 * (1.0 - face) - rimh * 0.0012 * (1.0 - face) - gill * 0.0015
        return dict(color=col, rough=0.22 + rimh * 0.22 + (rnd - 0.5) * 0.12, metal=V(0.18), height=hgt)
    hat.add(body, scales, density=1.15)

    def fin_look(o, ray, cross):
        """Fin rays fan out from the root o along `ray`; `cross` is the other direction in the fin's plane."""
        o = tuple(np.array(o, dtype=float)); ray = tuple(np.array(ray) / np.linalg.norm(ray)); cross = tuple(np.array(cross) / np.linalg.norm(cross))

        def f(gr):
            p = gr.P()
            q = p - Vec(o)
            a = q.dot(Vec(ray)); b = q.dot(Vec(cross))
            fan = atan2(b, a + 0.10)  # the rays meet a little way behind the root
            rays = 0.5 + 0.5 * cos(fan * 62.0)
            tip = smooth(0.0, 0.15, a)
            col = lerp(rgb('#ff5a0a'), rgb('#ffc12e'), tip * 0.85)
            col = col * (0.86 + 0.14 * rays)
            return dict(color=col, rough=V(0.32), height=rays * 0.0011)
        return f

    # a big round eye on each flank, and pouty lips
    i_eye = 4
    for s in (1, -1):
        ec = path[i_eye] + Bn[i_eye] * 0.040 * s + Nn[i_eye] * 0.022 + T[i_eye] * 0.004
        Rm = np.stack([T[i_eye], Nn[i_eye], Bn[i_eye]], axis=1)
        ef = G.ellipsoid(ec, (0.043, 0.043, 0.024), Rm)
        eye = G.build_mesh('FishEye' + ('A' if s > 0 else 'B'), G.blob(ef, ec, nu=14, nv=8, ref=tuple(T[i_eye]), cap_r=0.03, tmax=0.2))
        ecv = ec + Bn[i_eye] * 0.024 * s
        hiv = tuple(ecv - T[i_eye] * 0.010 + Nn[i_eye] * 0.011)

        def eye_look(gr, ecv=tuple(ecv), hiv=hiv):
            p = gr.P()
            dd = (p - Vec(ecv)).length()
            col = lerp(rgb('#0a0a10'), rgb('#ffffff'), smooth(0.023, 0.027, dd))
            col = lerp(col, rgb('#ffd23a'), bump_band(0.0285, 0.003, dd) * 0.9)
            hi = smooth(0.0095, 0.0070, (p - Vec(hiv)).length())
            return dict(color=lerp(col, rgb('#ffffff'), hi), rough=V(0.06), height=V(0.0))
        hat.add(eye, eye_look, density=1.6)
    mc = path[0] - T[0] * 0.040
    th = np.linspace(0, TAU, 14, endpoint=False)
    lips = ring_along('FishLips', np.array([mc + (Nn[0] * math.cos(a) * 0.036 + Bn[0] * math.sin(a) * 0.024) for a in th]), 0.012, 0.012, nu=6, ref=tuple(T[0]))
    hat.add(lips, flat('#ff7f8e', 0.35))

    # fins: the fish stands on its belly, so the back fin is on top and the tail fin stands upright
    def fin(name, origin, x, y, outline, ray, node=None, pivot=None, thick=0.009):
        o3 = np.array([(u, v, 0.0) for u, v in outline])
        smooth_outline = G.resample(o3, 4 * len(outline), closed=True)[:, :2]  # rounded, like a real fin
        ob = G.build_mesh(name, G.slab([tuple(q) for q in smooth_outline], thick, origin=origin, x=x, y=y, bevel=0.35, bulge=0.002, n_inset=1))
        hat.add(ob, fin_look(origin, ray, np.cross(np.cross(x, y), ray)), node=node, pivot=pivot)
        return ob
    i = 13
    fin('FishDorsal', path[i] + Nn[i] * 0.088, T[i], Nn[i],
        [(-0.15, 0.0), (-0.12, 0.060), (-0.05, 0.098), (0.03, 0.090), (0.10, 0.055), (0.17, 0.018), (0.17, -0.03), (0.0, -0.04), (-0.13, -0.03)],
        ray=Nn[i] + T[i] * 0.5)
    for s in (1, -1):  # side fins, swept back and splayed out
        i = 10
        o = path[i] + Bn[i] * 0.052 * s - Nn[i] * 0.030
        x = T[i] * 0.85 + Bn[i] * 0.45 * s - Nn[i] * 0.25
        fin('FishPec' + ('A' if s > 0 else 'B'), o, x, Nn[i] + Bn[i] * 0.2 * s,
            [(-0.02, -0.02), (0.0, 0.035), (0.085, 0.050), (0.115, 0.0), (0.08, -0.040), (0.0, -0.040)], ray=x)
    # tail fin: forked, flops about
    e = path[-1]
    tail_outline = [(-0.04, 0.0), (0.0, 0.04), (0.08, 0.115), (0.185, 0.160), (0.14, 0.06), (0.115, 0.0), (0.14, -0.06), (0.185, -0.160), (0.08, -0.115), (0.0, -0.04)]
    fin('jiggleTail', e + T[-1] * 0.012, T[-1], Nn[-1], tail_outline, ray=T[-1], node='jiggle_tail', pivot=e, thick=0.010)
    return hat


# ───────────────────────── party hat ─────────────────────────

def hat_party():
    hat = Hat('party', tilt=(0.10, -0.20, 0), coat=0.4)
    z0 = 1.090
    cy = HEAD_C[1]
    prof = [(0.150, 0.0), (0.158, 0.006), (0.150, 0.014), (0.118, 0.10), (0.075, 0.22), (0.032, 0.34), (0.012, 0.392), (0.0, 0.398)]
    prof = [(r, h + z0) for r, h in G.smooth_profile(prof, 26)]
    prof[-1] = (0.0, prof[-1][1])
    cone = G.build_mesh('PartyCone', G.lathe(prof, nu=36, closed_ends=(False, True), origin=(0, cy, 0)))

    def paper(gr):
        uv = gr.uv('param'); p = gr.P()
        h = p.z - z0
        ang = atan2(p.x, p.y - cy) / TAU
        k = frac(ang * 3.0 + h * 5.2)
        stripe = smooth(0.46, 0.50, absv(k - 0.5) * 2.0 - 0.0)
        base = lerp(rgb('#7a2de0'), rgb('#b060ff'), smooth(0.0, 0.4, h))
        gold_c = rgb('#ffc21a')
        # stars of confetti in the purple
        cell = Vec((ang * 16.0, h * 26.0, 0.0))
        d, cc, _p = voronoi(cell, 1.0, 'F1', 1.0)
        dot = smooth(0.17, 0.13, d) * (1.0 - stripe)
        col = lerp(base, gold_c, stripe)
        col = lerp(col, lerp(rgb('#35e0ff'), rgb('#ff5fa8'), smooth(0.4, 0.6, cc.x)), dot)
        crink = noise(p, 85.0, 2.0)
        _ = uv
        return dict(color=col, rough=lerp(0.34, 0.22, stripe) + (crink - 0.5) * 0.1, metal=stripe * 0.45, height=(crink - 0.5) * 0.0010 + stripe * 0.0004)
    hat.add(cone, paper)

    # tinsel frill round the base
    th = np.linspace(0, TAU, 56, endpoint=False)
    ringp = np.array([(math.sin(a) * (0.158 + 0.010 * math.sin(a * 14)), cy + math.cos(a) * (0.158 + 0.010 * math.sin(a * 14)), z0 + 0.004 + 0.008 * math.cos(a * 14)) for a in th])
    frill = ring_along('PartyFrill', ringp, 0.020, 0.020, nu=8)
    lumpy(frill, 0.006, 90.0, 2.0)

    def tinsel(gr):
        p = gr.P()
        d, cc, _p = voronoi(p, 120.0, 'F1', 1.0)
        col = lerp(rgb('#ffd24a'), rgb('#fff3b0'), cc.x)
        return dict(color=col, rough=0.25 + d * 0.5, metal=V(0.85), height=(0.5 - d) * 0.004)
    hat.add(frill, tinsel, density=0.9)

    top = np.array([0, cy, z0 + 0.418])
    pom = ball('PartyPom', top, 0.052, nu=14, nv=10)
    lumpy(pom, 0.007, 80.0, 3.0)
    hat.add(pom, fluff('#fff2a8', '#f0b830'), node='jiggle_pom', pivot=top - (0, 0, 0.045))
    return hat


# ───────────────────────── chef hat ─────────────────────────

def hat_chef():
    hat = Hat('chef', tilt=(-0.05, 0.07, 0), sheen=0.25, sheen_rough=0.8)
    cy = HEAD_C[1]
    nu = 60
    th = np.linspace(0, TAU, nu, endpoint=False)
    z0 = 1.005
    # (radius, height above z0, how strongly the pleats show)
    prof = G.smooth_profile([(0.266, 0.0), (0.268, 0.05), (0.262, 0.100), (0.292, 0.135), (0.338, 0.205), (0.330, 0.285), (0.262, 0.345), (0.14, 0.375), (0.0, 0.372)], 22)
    rows = []
    for (r, h) in prof:
        puff = sstep(0.105, 0.19, h)
        lobes = 1 + 0.085 * puff * np.cos(th * 9 + 0.6) + 0.03 * puff * np.cos(th * 4 + 2.0)
        band_pleat = 0.0
        rr = r * lobes + band_pleat
        slump = puff * (h - 0.105)
        rows.append(np.stack([np.sin(th) * rr + slump * 0.16, cy + np.cos(th) * rr - slump * 0.10, z0 + h + puff * 0.012 * np.cos(th * 9 + 0.6) * np.ones(nu)], axis=1))
    toque = G.build_mesh('ChefHat', G.Grid(np.array(rows), closed_u=True, pole1=True))

    def cotton(gr):
        p = gr.P()
        weave = noise(p, 420.0, 1.0)
        fold = noise(p * Vec((1.0, 1.0, 0.35)), 22.0, 3.0, 0.6)
        h = p.z - z0
        band = smooth(0.112, 0.100, h)
        stitch = bump_band(0.094, 0.004, h) * smooth(0.3, 0.5, absv(frac(atan2(p.x, p.y - cy) * 0.266 / 0.012) - 0.5) * 2.0)
        col = lerp(rgb('#dcdfe6'), rgb('#ffffff'), smooth(0.25, 0.7, fold))
        col = lerp(col, rgb('#f4f6fa'), band * 0.6)
        pleat = 0.5 + 0.5 * cos(atan2(p.x, p.y - cy) * 34.0)
        col = col * (1.0 - band * (1.0 - pleat) * 0.16)
        return dict(color=col * (1.0 - stitch * 0.25), rough=V(0.9), height=(weave - 0.5) * 0.0005 + (fold - 0.5) * 0.004 * (1.0 - band) - stitch * 0.001 + band * pleat * 0.0035)
    hat.add(toque, cotton)
    return hat


# ───────────────────────── traffic cone ─────────────────────────

def hat_cone():
    hat = Hat('cone', tilt=(0.08, 0.13, 0))
    cy = HEAD_C[1]
    z0 = 1.098
    H = 0.44
    prof = [(0.135, 0.0), (0.176, 0.0), (0.180, 0.012), (0.172, 0.026), (0.047, H - 0.01), (0.044, H), (0.034, H), (0.030, H - 0.02), (0.0, H - 0.03)]
    prof = G.round_profile(prof, [0.004, 0.006, 0.01, 0.004, 0.004, 0.004, 0.006], segs=2)
    prof = [(r, h + z0) for r, h in prof]
    cone = G.build_mesh('ConeBody', G.lathe(prof, nu=36, closed_ends=(False, True), origin=(0, cy, 0)))

    def plastic(gr):
        p = gr.P()
        h = p.z - z0
        r = (Vec((p.x, p.y - cy, 0.0))).length()
        band = vmax(bump_band(0.285, 0.050, h), bump_band(0.155, 0.032, h))
        band = smooth(0.25, 0.45, band)
        dirt = noise(p, 14.0, 4.0, 0.65)
        scuff = noise(p * Vec((1.0, 1.0, 9.0)), 50.0, 2.0)
        orange = lerp(rgb('#e8470a'), rgb('#ff6a14'), smooth(0.3, 0.7, dirt))
        white = lerp(rgb('#c9cdd2'), rgb('#f6f8fa'), smooth(0.3, 0.6, dirt))
        col = lerp(orange, white, band)
        col = lerp(col, rgb('#3a2c22'), smooth(0.62, 0.85, dirt) * smooth(0.16, 0.0, h) * 0.55)  # grime near the foot
        col = lerp(col, rgb('#ffd9c2'), smooth(0.78, 0.9, scuff) * 0.3)
        hole = smooth(0.036, 0.030, r) * smooth(H - 0.03, H - 0.005, h)
        col = lerp(col, rgb('#1a0d06'), hole)
        return dict(color=col, rough=lerp(0.52, 0.34, band) + (dirt - 0.5) * 0.15, height=(noise(p, 260.0) - 0.5) * 0.0005 + band * 0.0005 - smooth(0.8, 0.9, scuff) * 0.0004)
    hat.add(cone, plastic)

    # square foot with rounded corners
    outline = []
    half, rc = 0.215, 0.045
    for cxs, cys, a0 in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
        for k in range(6):
            a = math.radians(a0 + k * 18)
            outline.append((cxs * (half - rc) + math.cos(a) * rc, cys * (half - rc) + math.sin(a) * rc))
    foot = G.build_mesh('ConeFoot', G.slab(outline, 0.030, origin=(0, cy, z0 + 0.004), x=(1, 0, 0), y=(0, 1, 0), bevel=0.3, n_inset=2))
    hat.add(foot, plastic)
    return hat


HATS = {'beanie': hat_beanie, 'tophat': hat_tophat, 'propeller': hat_propeller, 'viking': hat_viking, 'crown': hat_crown,
        'fish': hat_fish, 'party': hat_party, 'chef': hat_chef, 'cone': hat_cone}


def build(name, size, ao, out_dir):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    hat = HATS[name]()
    objs = [p['ob'] for p in hat.parts]
    print(f'[{name}] triangles: {G.tri_count(objs)} parts: {len(objs)}')
    cache = {}
    for i, p in enumerate(hat.parts):
        key = p['look']
        if key not in cache:
            cache[key] = B.look(f'look_{name}_{len(cache)}', p['look'])
        p['ob'].data.materials.clear()
        p['ob'].data.materials.append(cache[key])
    B.pack_atlas(objs, size, pad_px=12, density=hat.density)
    groups = {}
    for p in hat.parts:
        groups.setdefault(p['node'], []).append(p)
    nodes = {}
    for node, ps in groups.items():
        nodes[node] = G.join([p['ob'] for p in ps], 'Hat' if node is None else node)
    paths = B.bake(list(nodes.values()), size, out_dir, 'hat_' + name, ao_samples=ao, ao_dist=0.18, ao_in_color=0.35, margin=5)
    mat = B.export_material('Hat_' + name, paths, sheen=hat.sheen, sheen_rough=hat.sheen_rough, coat=hat.coat)
    M = rot_matrix(*hat.tilt)
    Sc = np.eye(4); Sc[:3, :3] *= hat.scale; Sc[:3, 3] = SOCKET * (1 - hat.scale)
    M = M @ Sc
    Mshift = np.eye(4); Mshift[:3, 3] = -SOCKET
    main = nodes[None]
    for node, ob in nodes.items():
        me = ob.data
        me.materials.clear(); me.materials.append(mat)
        me.polygons.foreach_set('material_index', [0] * len(me.polygons))
        me.uv_layers.remove(me.uv_layers['param'])
        me.attributes.remove(me.attributes['island'])
        G.transform(ob, Mshift @ M)
        if node is not None:
            pivot = groups[node][0]['pivot']
            pv = (Mshift @ M @ np.array([*pivot, 1.0]))[:3]
            G.set_origin(ob, pv)
            ob.parent = main
    glb = os.path.join(REPO, 'src', 'assets', 'models', 'hats', name + '.glb')
    EX.export_glb(glb, list(nodes.values()))


def main():
    args = sys.argv[1:]
    size, ao = 1024, 48
    names = []
    out_dir = os.path.join(HERE, 'out')
    for a in args:
        if a.startswith('--size='):
            size = int(a.split('=')[1])
        elif a.startswith('--ao='):
            ao = int(a.split('=')[1])
        elif a.startswith('--out='):
            out_dir = a.split('=', 1)[1]
        else:
            names.append(a)
    for n in (names or list(HATS)):
        build(n, size, ao, out_dir)


if __name__ == '__main__':
    main()
