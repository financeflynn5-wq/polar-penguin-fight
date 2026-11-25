"""Builds the map props in Blender and writes them to public/models as .glb.

Run (Blender's Python, e.g. a venv with the `bpy` module):
    python tools/blender/props.py                 # build and export everything
    python tools/blender/props.py cane sled       # only these
    python tools/blender/props.py --render cane   # also write review renders to tools/blender/renders/

Sizes come from src/world/Landmarks.ts (PROP_SHAPES and the house makers): what you bump into in the game is defined
there, and these models are built to those numbers. Change one, change the other.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
from mathutils import Vector, Matrix
import kit
from kit import G, Asset, tube, arc, transform, snow_lump, gumdrop, bm_box, bm_cyl, bm_ico, bevel, shade, refine, displace

RENDERS = os.path.join(os.path.dirname(__file__), 'renders')
GREEN = (0.10, 0.42, 0.20)
RED = (0.80, 0.07, 0.09)
GOLD = (0.95, 0.68, 0.18)


def ribbon_bow(A, at, size=1.0, tint=GREEN):
    """A tied bow facing +z (south): two puffed loops, a knot, two tails. `at` in game coords."""
    x, y, z = at
    for s in (-1, 1):
        loop = bm_ico(1.0, 3)
        for v in loop.verts:
            t = (v.co.x + 1) / 2  # 0 at the knot .. 1 at the far end of the loop
            fat = 0.18 + 0.82 * math.sin(math.pi * min(1.0, t * 1.08) ** 0.75)
            v.co.z *= fat
            v.co.y *= 0.3 + 0.7 * fat
            if abs(v.co.z) < 0.25 * fat and v.co.y < 0: v.co.y *= 0.55  # the crease down the middle of the loop
        for f in loop.faces: f.smooth = True
        transform(loop, (0, 0, 0), scale=(0.2 * size, 0.13 * size, 0.075 * size))
        transform(loop, (x + s * 0.2 * size, y + 0.045 * size, z + 0.03 * size), rot=(0, -s * 0.3, s * 0.38))
        A.add(loop, 'ribbon', tint)
        tail = [G(x + s * 0.03 * size, y, z + 0.02 * size), G(x + s * 0.1 * size, y - 0.16 * size, z + 0.07 * size),
                G(x + s * 0.17 * size, y - 0.36 * size, z + 0.05 * size), G(x + s * 0.2 * size, y - 0.56 * size, z + 0.09 * size)]
        A.add(kit.ribbon(tail, width=0.13 * size, thick=0.02 * size, up=(1, 0, 0)), 'ribbon', tint)
    knot = bm_ico(1.0, 2)
    for f in knot.faces: f.smooth = True
    A.add(transform(knot, (x, y, z + 0.04 * size), scale=(0.075 * size, 0.085 * size, 0.065 * size)), 'ribbon', tint)


def build_cane():
    """A giant candy cane standing in the snow, tied with a green ribbon, snow settled on the crook."""
    A = Asset('cane')
    R = 0.27
    shaft_top, hook_r = 3.5, 0.55
    path = [G(0, y, 0) for y in (-0.7, 0.0, 0.8, 1.6, 2.4, 3.1)]
    path += arc((hook_r, shaft_top, 0), hook_r, math.pi, -0.42, 22, 'xy')
    A.add(tube(path, R, around=24, tile_v=1.5, cap=True), 'candy', uv='keep')
    # snow lying along the top of the crook
    top = arc((hook_r, shaft_top, 0), hook_r + R * 0.86, math.pi * 0.9, math.pi * 0.16, 14, 'xy')
    A.add(tube(top, lambda t: 0.04 + 0.12 * math.sin(math.pi * t) ** 0.6, around=12, squash=1.75, cap=True), 'snow')
    # the drift it stands in
    A.add(transform(kit.drift((1.0, 0.36, 0.95), seed=3), (0.05, 0.0, 0.02)), 'snow')
    A.add(transform(kit.drift((0.5, 0.22, 0.45), seed=8, around=12), (-0.55, 0.0, 0.42)), 'snow')
    # ribbon: a band round the shaft and a bow on the south side
    band = bm_cyl(R + 0.012, 0.17, 24, bev=0.012)
    A.add(transform(band, (0, 2.62, 0)), 'ribbon', GREEN)
    ribbon_bow(A, (0, 2.62, R + 0.02), 1.25, GREEN)
    return A, dict(target=(0.3, 2.2, 0), dist=9.5, yaw=62, pitch=10)


def build_cane_down():
    """A giant candy cane that fell over and snapped: the shaft lies half sunk in the snow in two pieces, and the
    crook has stabbed into the drift at the far end. Knee-high cover (PROP_SHAPES.caneDown: 4.4 m by 0.72 m)."""
    A = Asset('caneDown')
    rng = random.Random(5)
    R, yc = 0.29, 0.33
    # the long piece, from the foot to the break
    A.add(tube([G(x, yc - 0.02 * (x + 2.3), 0.02 * math.sin(x)) for x in (-2.3, -1.6, -0.9, -0.2, 0.3)], R, around=22, tile_v=1.5, cap=True), 'candy', uv='keep')
    # the short piece, knocked a little out of line, running into the crook that dives into the snow
    path = [G(0.52, yc - 0.01, 0.07), G(0.9, yc + 0.01, 0.04), G(1.25, yc + 0.02, 0.0)]
    path += arc((1.25, yc + 0.02 - 0.52, 0.0), 0.52, math.pi / 2, -0.55, 14, 'xy')
    A.add(tube(path, R, around=22, tile_v=1.5, cap=True, v0=1.9), 'candy', uv='keep')
    # splinters of sugar where it broke
    for i in range(7):
        sh = kit.chunk((rng.uniform(0.05, 0.1), rng.uniform(0.03, 0.06), rng.uniform(0.04, 0.09)), seed=i, bev=0.01)
        A.add(transform(sh, (0.42 + rng.uniform(-0.35, 0.35), 0.03 + rng.random() * 0.05, rng.choice((-1, 1)) * rng.uniform(0.3, 0.55)), rot=(rng.random(), rng.random() * 3, rng.random())), 'candy', tile=0.5)
    # snow lying along the top and drifted against it
    A.add(kit.pipe([G(x, yc + R * 0.86, 0.03) for x in (-2.15, -1.8, -1.4, -1.0, -0.6, -0.25, 0.1)], 0.13, around=8, wobble=0.3, seed=2, squash=1.6), 'snow')
    A.add(kit.pipe([G(x, yc + R * 0.9, 0.04) for x in (0.7, 0.95, 1.2, 1.45)], 0.11, around=8, wobble=0.3, seed=4, squash=1.5), 'snow')
    for i, (x, z, sx, sz, sy) in enumerate(((-1.5, 0.35, 0.9, 0.42, 0.3), (-0.3, -0.36, 1.0, 0.4, 0.28), (1.75, 0.0, 0.5, 0.5, 0.3), (0.9, 0.33, 0.6, 0.34, 0.24), (-2.25, -0.1, 0.42, 0.42, 0.26))):
        A.add(transform(kit.drift((sx, sy, sz), seed=20 + i, around=14), (x, 0.0, z)), 'snow')
    ribbon_bow(A, (-1.2, yc + 0.12, R + 0.02), 1.15, GREEN)
    band = bm_cyl(R + 0.012, 0.17, 22, bev=0.012)
    A.add(transform(band, (-1.2, yc - 0.02, 0), rot=(0, 0, math.pi / 2)), 'ribbon', GREEN)
    return A, dict(target=(0, 0.4, 0), dist=7.5, yaw=65, pitch=22)


def crate(A, c, half, yaw=0.0, tint=(1, 1, 1), seed=0):
    """A slatted wooden crate: centre c (game), half sizes, turned by yaw."""
    hx, hy, hz = half
    def piece(bm, loc):
        transform(bm, loc)
        transform(bm, c, rot=(0, yaw, 0))
        return bm
    A.add(piece(bm_box(hx - 0.02, hy - 0.02, hz - 0.02, bev=0.01), (0, 0, 0)), 'wood', tuple(v * 0.8 for v in tint))
    f = 0.055  # half width of a slat
    dark = tuple(v * 0.95 for v in tint)
    for s in (-1, 1):
        for k in (-1, 1):
            A.add(piece(bm_box(hx, f, 0.018, bev=0), (0, k * (hy - f), s * hz)), 'wood', dark)       # rails on the long faces
            A.add(piece(bm_box(f, hy - 2 * f, 0.018, bev=0), (k * (hx - f), 0, s * hz)), 'wood', dark)
            A.add(piece(bm_box(0.018, f, hz, bev=0), (s * hx, k * (hy - f), 0)), 'wood', dark)        # and on the ends
            A.add(piece(bm_box(0.018, hy - 2 * f, f, bev=0), (s * hx, 0, k * (hz - f))), 'wood', dark)
            A.add(piece(bm_box(f, 0.018, hz, bev=0), (k * (hx - f), s * hy, 0)), 'wood', dark)        # top and bottom
        brace = bm_box(math.hypot(hx - 2 * f, hy - 2 * f), f * 0.9, 0.014, bev=0)
        transform(brace, (0, 0, 0), rot=(0, 0, -s * math.atan2(hy - 2 * f, hx - 2 * f)))
        A.add(piece(brace, (0, 0, s * (hz - 0.004))), 'wood', dark)


def sack(A, c, size, seed=0, tint=(0.7, 0.52, 0.3), yaw=0.0, tied=True):
    """A stuffed burlap sack lying on its side."""
    bm = bm_ico(1.0, 2)
    for v in bm.verts:
        if v.co.z < -0.55: v.co.z = -0.55 - (v.co.z + 0.55) * 0.15   # it sags flat where it lies
        v.co.x *= 1 + 0.12 * math.sin(v.co.z * 3)
    displace(bm, 0.07, 1.8, seed)
    for f in bm.faces: f.smooth = True
    transform(bm, (0, 0, 0), scale=size)
    transform(bm, c, rot=(0, yaw, 0))
    A.add(bm, 'canvas', tint)
    if tied:
        neck = transform(bm_cyl(size[1] * 0.3, size[1] * 0.3, 10, bev=0.01, r2=size[1] * 0.42), (size[0] * 1.02, size[1] * 0.1, 0), rot=(0, 0, -math.pi / 2))
        A.add(transform(neck, c, rot=(0, yaw, 0)), 'canvas', tint)
        tie = tube([G(size[0] * 0.98, size[1] * 0.1 + math.cos(a) * size[1] * 0.3, math.sin(a) * size[1] * 0.3) for a in [i / 10 * 2 * math.pi for i in range(11)]], 0.018, around=5, cap=False)
        A.add(transform(tie, c, rot=(0, yaw, 0)), 'rope')


def build_sled():
    """A cargo sled loaded with crates and sacks, part of the load under a lashed tarp, snow settled on all of it.
    PROP_SHAPES.sled: 3.5 x 1.56 m and 1.05 m high, with a second tier 2.4 x 1.32 m up to 1.5 m."""
    A = Asset('sled')
    rng = random.Random(9)
    DARK = (0.62, 0.52, 0.44)
    zr = 0.62
    # runners: long skis that curl up at the front, shod with iron
    run = [G(-1.72, 0.2, 0), G(-1.55, 0.1, 0), G(-1.2, 0.075, 0), G(-0.4, 0.07, 0), G(0.4, 0.07, 0), G(0.85, 0.07, 0)]
    run += arc((0.85, 0.56, 0), 0.49, -math.pi / 2, math.radians(62), 12, 'xy')
    for s in (-1, 1):
        off = Vector((0, -s * zr, 0))
        A.add(kit.ribbon([p + off for p in run], width=0.085, thick=0.1, up=(0, 1, 0)), 'wood', DARK)
        A.add(kit.ribbon([p + off + Vector((0, 0, -0.056)) for p in run[:-3]], width=0.09, thick=0.02, up=(0, 1, 0)), 'metal')
        for x in (-1.35, -0.5, 0.35):
            A.add(transform(bm_box(0.04, 0.15, 0.035, bev=0.012), (x, 0.26, s * zr)), 'wood', DARK)
        A.add(transform(bm_box(1.32, 0.035, 0.04, bev=0.012), (-0.45, 0.41, s * zr)), 'wood', DARK)
    for x in (-1.35, -0.5, 0.35):
        A.add(transform(bm_box(0.05, 0.035, zr + 0.06, bev=0.012), (x, 0.38, 0)), 'wood', DARK)
    for i in range(5):
        A.add(transform(bm_box(1.34, 0.022, 0.118, bev=0.01), (-0.45, 0.455, -0.5 + 0.25 * i)), 'wood', (0.9, 0.84, 0.76) if i % 2 else (0.8, 0.74, 0.68))
    # the bow bar joining the curled tips, with the tow rope coiled over it
    tip = (0.85 + 0.49 * math.cos(math.radians(62)), 0.56 + 0.49 * math.sin(math.radians(62)))
    A.add(tube([G(tip[0], tip[1], -zr - 0.08), G(tip[0], tip[1], 0), G(tip[0], tip[1], zr + 0.08)], 0.04, around=8, cap_steps=2), 'wood', DARK)
    coil = [G(tip[0] + 0.02 * math.sin(i * 0.5) + 0.0, tip[1] + math.sin(i / 8 * 2 * math.pi) * 0.075, -0.3 + i * 0.012 + 0.0) + Vector((math.cos(i / 8 * 2 * math.pi) * 0.075, 0, 0)) for i in range(41)]
    A.add(tube(coil, 0.02, around=5, cap_steps=1), 'rope')
    A.add(tube([coil[-1], G(tip[0] + 0.1, 0.6, 0.25), G(tip[0] + 0.25, 0.12, 0.32), G(tip[0] + 0.32, 0.03, 0.2)], 0.02, around=5, cap_steps=1), 'rope')
    # the load
    deck = 0.478
    crate(A, (-1.12, deck + 0.3, 0.02), (0.5, 0.3, 0.52), yaw=0.03, tint=(0.95, 0.88, 0.8), seed=1)
    crate(A, (-0.02, deck + 0.26, -0.14), (0.44, 0.26, 0.42), yaw=-0.12, tint=(0.82, 0.74, 0.66), seed=2)
    sack(A, (0.62, deck + 0.2, 0.2), (0.34, 0.21, 0.27), seed=3, yaw=0.5)
    sack(A, (0.55, deck + 0.18, -0.42), (0.3, 0.19, 0.22), seed=4, yaw=-0.3, tint=(0.6, 0.46, 0.28))
    sack(A, (-0.05, deck + 0.2, 0.42), (0.36, 0.2, 0.2), seed=5, yaw=0.1)
    # second tier: a small crate and a bundle under a green tarp, lashed down
    crate(A, (-1.0, deck + 0.6 + 0.2, 0.0), (0.36, 0.2, 0.36), yaw=0.2, tint=(0.88, 0.8, 0.7), seed=6)
    tarp = bm_box(0.52, 0.22, 0.46, bev=0.16, segs=3)
    refine(tarp, 0.26); displace(tarp, 0.05, 2.2, 6); shade(tarp, 70)
    A.add(transform(tarp, (-0.02, deck + 0.52 + 0.2, -0.1), rot=(0, -0.1, 0)), 'canvas', (0.2, 0.36, 0.24))
    skirt = bm_box(0.56, 0.05, 0.5, bev=0.04, segs=2); refine(skirt, 0.2); displace(skirt, 0.03, 3, 8); shade(skirt, 60)
    A.add(transform(skirt, (-0.02, deck + 0.53, -0.1), rot=(0, -0.1, 0)), 'canvas', (0.17, 0.31, 0.21))
    for dx in (-0.28, 0.24):
        pts = [G(-0.02 + dx, deck + 0.02, -0.72)] + [G(-0.02 + dx, deck + 0.72 + 0.26 * math.sin(a) - 0.0, -0.1 + 0.62 * -math.cos(a)) for a in [i / 10 * math.pi for i in range(11)]][1:-1] + [G(-0.02 + dx, deck + 0.02, 0.62)]
        A.add(tube(pts, 0.02, around=5, cap_steps=1), 'rope')
    # a storm lantern on the tail
    A.add(tube([G(-1.66, deck, 0.45), G(-1.66, deck + 0.75, 0.45), G(-1.56, deck + 0.82, 0.45)], 0.018, around=5, cap_steps=1), 'metal')
    A.add(transform(bm_box(0.065, 0.085, 0.065, bev=0.02), (-1.56, deck + 0.68, 0.45)), 'glow')
    A.add(transform(bm_box(0.085, 0.016, 0.085, bev=0), (-1.56, deck + 0.78, 0.45)), 'metal')
    A.add(transform(bm_box(0.08, 0.014, 0.08, bev=0.006), (-1.56, deck + 0.59, 0.45)), 'metal')
    # snow on top of everything and drifted round the runners
    A.add(transform(kit.drift((0.4, 0.13, 0.4), seed=1, around=12), (-1.0, deck + 1.0, 0.0)), 'snow')
    A.add(transform(kit.drift((0.5, 0.12, 0.44), seed=2, around=12), (-0.02, deck + 0.93, -0.1)), 'snow')
    A.add(transform(kit.drift((0.26, 0.09, 0.3), seed=4, around=10), (-1.42, deck + 0.59, 0.25)), 'snow')
    for i, (x, z, sx, sz, sy) in enumerate(((-1.2, 0.85, 0.9, 0.4, 0.3), (0.5, -0.85, 1.0, 0.4, 0.28), (1.55, 0.1, 0.45, 0.7, 0.26), (-1.85, -0.2, 0.4, 0.6, 0.24), (0.2, 0.85, 0.7, 0.34, 0.22))):
        A.add(transform(kit.drift((sx, sy, sz), seed=30 + i, around=14), (x, 0.0, z)), 'snow')
    return A, dict(target=(0, 0.75, 0), dist=7.5, yaw=58, pitch=17, more=[dict(tag='b', yaw=205, pitch=12)])


def ice_block(half, seed, chip=0.07):
    """A sawn block of lake ice with GAME half sizes: square but not perfect, corners chipped."""
    rng = random.Random(seed)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts:
        v.co.x *= half[0] * 2 * (1 - rng.random() * 0.06)
        v.co.y *= half[2] * 2 * (1 - rng.random() * 0.06)
        v.co.z *= half[1] * 2 * (1 - rng.random() * 0.03)
    # knock a couple of corners off
    for v in rng.sample(list(bm.verts), 3):
        bmesh.ops.bevel(bm, geom=[v], offset=chip * rng.uniform(0.8, 2.2), segments=1, affect='VERTICES')
        bm.verts.ensure_lookup_table()
    bevel(bm, 0.035, 2, angle=25)
    refine(bm, 0.42)
    # frost: the faces are clear blue in the middle and go white toward the edges and corners
    col = bm.loops.layers.float_color.new('Col')
    for v in bm.verts:
        d = sorted((half[0] - abs(v.co.x), half[2] - abs(v.co.y), half[1] - abs(v.co.z)))
        k = max(0.0, min(1.0, (d[1] - 0.02) / (0.34 * min(1.0, min(half) * 2.2))))
        k = k * k * (3 - 2 * k)
        c = (1 - 0.5 * k, 1 - 0.3 * k, 1 - 0.1 * k, 1.0)
        for l in v.link_loops: l[col] = c
    displace(bm, 0.012, 1.4, seed)
    shade(bm, 35)
    return bm


def build_ice_blocks():
    """Sawn blocks of lake ice stacked for hauling: two side by side with a third on top, a rope sling still round
    it. PROP_SHAPES.iceBlocks: 2.6 x 1.32 m and 1.22 m high, the top block 1.36 x 1.24 m up to 2.36 m."""
    A = Asset('iceBlocks')
    rng = random.Random(4)
    for i, (x, z, hx, hz, yaw) in enumerate(((-0.665, 0.0, 0.625, 0.65, 0.02), (0.665, -0.01, 0.625, 0.645, -0.03))):
        A.add(transform(ice_block((hx, 0.86, hz), 11 + i), (x, 0.355, z), rot=(0, yaw, 0)), 'ice', None)
    A.add(transform(ice_block((0.66, 0.565, 0.6), 15), (-0.52, 1.79, 0.03), rot=(0, 0.07, 0)), 'ice', None)
    # the rope sling round the top block
    for dx in (-0.3, 0.3):
        x = -0.52 + dx
        loop = [G(x, 1.79 + sy * 0.585, 0.03 + sz * 0.625) for sy, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1), (-1, -1))]
        pts = []
        for a, b in zip(loop[:-1], loop[1:]):
            pts += [a.lerp(b, k / 4) for k in range(4)]
        A.add(tube(pts + [pts[0]], 0.024, around=5, cap=False), 'rope')
    A.add(tube([G(-0.82, 2.38, 0.03), G(-0.52, 2.5, 0.03), G(-0.22, 2.38, 0.03)], 0.024, around=5, cap_steps=1), 'rope')
    # snow on the tops, frost and chips round the foot
    A.add(transform(kit.drift((0.62, 0.15, 0.56), seed=1, around=14), (-0.52, 2.345, 0.03)), 'snow')
    A.add(transform(kit.drift((0.5, 0.13, 0.55), seed=2, around=14), (0.72, 1.2, 0.0)), 'snow')
    for i in range(7):
        ln = rng.uniform(0.12, 0.4)
        A.add(transform(kit.icicle(ln, 0.03 + ln * 0.04), (-0.52 - 0.6 + 1.2 * rng.random(), 1.24, 0.03 + rng.choice((-1, 1)) * 0.61)), 'ice')
    for i, (x, z, sx, sz, sy) in enumerate(((-1.25, 0.45, 0.6, 0.5, 0.3), (1.2, -0.5, 0.65, 0.5, 0.3), (0.2, 0.75, 0.8, 0.36, 0.24), (-0.3, -0.75, 0.8, 0.36, 0.22))):
        A.add(transform(kit.drift((sx, sy, sz), seed=40 + i, around=14), (x, 0.0, z)), 'snow')
    for i in range(5):
        c = ice_block((rng.uniform(0.07, 0.14), rng.uniform(0.05, 0.09), rng.uniform(0.07, 0.12)), 30 + i, chip=0.02)
        A.add(transform(c, (rng.choice((-1, 1)) * rng.uniform(1.35, 1.6) - 0.1, 0.05, rng.uniform(-0.6, 0.6)), rot=(rng.random(), rng.random() * 3, rng.random())), 'ice', None)
    return A, dict(target=(0, 1.1, 0), dist=8.5, yaw=60, pitch=14)


import houses, ramp

BUILDERS = {'cane': build_cane, 'caneDown': build_cane_down, 'sled': build_sled, 'iceBlocks': build_ice_blocks,
            'ramp': ramp.build_ramp,
            'gingerbread': houses.build_gingerbread, 'ruinA': houses.build_ruin_a, 'ruinB': houses.build_ruin_b, 'cabin': houses.build_cabin}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    do_render = '--render' in sys.argv
    names = args or list(BUILDERS)
    for name in names:
        kit.reset(); kit._mats.clear()
        A, view = BUILDERS[name]()
        objs = A.build()
        kit.bake_ao(objs)
        kit.export(name, objs)
        if do_render:
            os.makedirs(RENDERS, exist_ok=True)
            kit.render(os.path.join(RENDERS, f'{name}.png'), **{k: v for k, v in view.items() if k != 'more'})
            for extra in (view.get('more', []) if '--views' in sys.argv else []):
                kit.render(os.path.join(RENDERS, f"{name}-{extra['tag']}.png"), **{k: v for k, v in {**view, **extra}.items() if k not in ('more', 'tag')})


if __name__ == '__main__':
    main()
