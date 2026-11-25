"""The jump ramp: a timber kicker with a sheet of ice for a deck, candy-cane rails that curl over at the lip, a
peppermint on the front and a pennant on each corner. Built by props.py (`python tools/blender/props.py ramp`).

Its shape is RAMP in src/world/Landmarks.ts: 5.6 m long, 3.2 m of deck to ride on, rising 1.3 m along a curve
(rise * (s / len)^2). The origin is the middle of the ramp at the height of the deck's low end, x toward the lip.
What you ride on in the game is that curve exactly, so the top of the ice here has to follow it too.
"""
import math, random
import bmesh
from mathutils import Vector
import kit
from kit import G, Asset, tube, transform, bm_box, bm_cyl, shade, refine, displace
import houses

LEN, WIDTH, RISE = 5.6, 3.2, 1.3
HALF = WIDTH / 2
X0 = -LEN / 2           # the low end
SIDE = HALF + 0.07      # where the side frames stand: just outside the deck you ride on
FOOT = -1.0             # how far down the boarding goes (the snow hides what it doesn't need)
DEEP = -3.4             # ... and the legs, for ramps that stand on the edge of a drop
RED = (0.80, 0.07, 0.09)
ARROW = (1.0, 0.74, 0.12)
GREEN = (0.10, 0.42, 0.20)
DARK = (0.7, 0.59, 0.5)
PALE = (1.0, 0.93, 0.84)


def deck(s):
    """Height of the deck s metres in from the low end."""
    t = max(0.0, min(1.0, s / LEN))
    return RISE * t * t


def slope(s):
    return 2 * RISE * max(0.0, min(LEN, s)) / (LEN * LEN)


def ice_deck():
    """The sheet of ice you ride on: clear blue down the middle, frosted white toward the edges and the lip."""
    bm = bmesh.new()
    col = bm.loops.layers.float_color.new('Col')
    nx, nz, thick = 30, 8, 0.11
    hw = HALF + 0.02
    top, bot = [], []
    for i in range(nx + 1):
        s = -0.7 + (LEN + 0.7) * i / nx
        y = deck(s) - (0.05 * (-s / 0.7) if s < 0 else 0.0)  # the first of it dips under the snow
        rt, rb = [], []
        for k in range(nz + 1):
            z = -hw + 2 * hw * k / nz
            rt.append(bm.verts.new(G(X0 + s, y, z)))
            rb.append(bm.verts.new(G(X0 + s, y - thick, z)))
        top.append(rt); bot.append(rb)
    for i in range(nx):
        for k in range(nz):
            bm.faces.new((top[i][k], top[i][k + 1], top[i + 1][k + 1], top[i + 1][k]))
            bm.faces.new((bot[i][k], bot[i + 1][k], bot[i + 1][k + 1], bot[i][k + 1]))
    for i in range(nx):
        bm.faces.new((top[i][0], top[i + 1][0], bot[i + 1][0], bot[i][0]))
        bm.faces.new((top[i][nz], bot[i][nz], bot[i + 1][nz], top[i + 1][nz]))
    for k in range(nz):
        bm.faces.new((top[nx][k], top[nx][k + 1], bot[nx][k + 1], bot[nx][k]))
        bm.faces.new((top[0][k], bot[0][k], bot[0][k + 1], top[0][k + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    for v in bm.verts:
        gx, gz = v.co.x, -v.co.y
        s = gx - X0
        edge = min(hw - abs(gz), LEN - s, s + 0.2)
        k = max(0.0, min(1.0, edge / 0.55))
        k = k * k * (3 - 2 * k)
        # long streaks worn into it by everyone who went before
        k *= 0.82 + 0.18 * math.sin(gz * 9.0 + math.sin(gx * 1.7) * 1.3)
        c = (1 - 0.3 * k, 1 - 0.14 * k, 1.0, 1.0)
        for l in v.link_loops: l[col] = c
    shade(bm, 40)
    return bm


def edge_path(z, lift, s0=0.0, s1=LEN, n=22):
    return [G(X0 + s0 + (s1 - s0) * i / n, deck(s0 + (s1 - s0) * i / n) + lift, z) for i in range(n + 1)]


def side_frame(A, sgn, rng):
    """One side: a curved stringer under the edge of the deck, upright boards below it, and three log posts."""
    z = sgn * SIDE
    # the stringer: a heavy curved beam that follows the deck
    A.add(kit.ribbon(edge_path(z, -0.1, -0.35), width=0.3, thick=0.17, up=(0, 0, 1)), 'wood', DARK)
    # boards, each a little different, their tops hidden behind the stringer
    w = 0.3
    n = int(round((LEN + 0.3) / w))
    for i in range(n):
        s = -0.3 + (i + 0.5) * (LEN + 0.3) / n
        top = deck(s) - 0.12
        if top - FOOT < 0.25: continue
        tint = tuple(v * rng.uniform(0.86, 1.02) for v in PALE)
        b = bm_box(w / 2 - 0.012, (top - FOOT) / 2, 0.03, bev=0.012)
        A.add(transform(b, (X0 + s, (top + FOOT) / 2 + rng.uniform(-0.02, 0.0), sgn * (SIDE - 0.045)), rot=(0, 0, rng.uniform(-0.012, 0.012))), 'wood', tint)
    # a rail of timber along the boards half way up the tall end, and a diagonal brace
    A.add(transform(bm_box(1.5, 0.055, 0.03, bev=0.012), (X0 + LEN - 1.55, 0.28, sgn * (SIDE + 0.01))), 'wood', DARK)
    brace = bm_box(1.02, 0.05, 0.028, bev=0.012)
    A.add(transform(brace, (X0 + LEN - 1.2, 0.05, sgn * (SIDE + 0.035)), rot=(0, 0, math.radians(-33))), 'wood', DARK)
    # posts: logs with snow on their heads
    for j, (s, up_, r) in enumerate(((LEN - 0.12, 0.42, 0.15), (LEN * 0.62, 0.3, 0.135), (LEN * 0.3, 0.24, 0.125))):
        x, topy = X0 + s, deck(s) + up_
        houses.log(A, (x, DEEP if j < 2 else FOOT, sgn * (SIDE + 0.19)), (x, topy, sgn * (SIDE + 0.19)), r, seed=j * 3 + (1 if sgn > 0 else 7), ends=(False, True))
        A.add(transform(kit.snow_lump((r * 1.25, 0.11, r * 1.25), seed=j + 11, sub=2), (x, topy - 0.015, sgn * (SIDE + 0.19))), 'snow')
        # rope lashed round the post where it meets the stringer
        for k in range(3):
            yy = deck(s) - 0.2 + k * 0.045
            ring = [G(x + math.cos(a) * (r + 0.012), yy + 0.01 * math.sin(a * 2 + k), sgn * (SIDE + 0.19) + math.sin(a) * (r + 0.012)) for a in [i / 12 * 2 * math.pi for i in range(13)]]
            A.add(tube(ring, 0.021, around=5, cap=False), 'rope')


def candy_rail(A, sgn):
    """A candy-cane rail along the edge of the deck that curls up and over at the lip, like a sled runner."""
    z = sgn * (SIDE - 0.01)
    lift, r = 0.17, 0.1
    path = edge_path(z, lift, 0.55, LEN, 20)
    # the crook: carries on from the rail's own slope
    a = math.atan(slope(LEN))
    cr = 0.3
    cx, cy = X0 + LEN - math.sin(a) * cr, deck(LEN) + lift + math.cos(a) * cr
    for i in range(1, 15):
        ang = (a - math.pi / 2) + math.radians(205) * i / 14
        path.append(G(cx + math.cos(ang) * cr, cy + math.sin(ang) * cr, z))
    # the low end dives into the snow
    path = [G(X0 + 0.1, -0.16, z), G(X0 + 0.32, deck(0.32) + lift * 0.45, z)] + path
    A.add(tube(path, r, around=14, tile_v=0.55, cap=True, cap_steps=3), 'candy', uv='keep')
    # snow lying along the top of it here and there, and on the crook
    for k, (s0, s1) in enumerate(((1.0, 2.1), (3.3, 4.1)) if sgn > 0 else ((1.6, 2.5), (3.9, 4.9))):
        A.add(kit.pipe(edge_path(z, lift + r * 0.82, s0, s1, 6), 0.05, around=7, wobble=0.35, seed=3 * k + (2 if sgn > 0 else 8), squash=1.5), 'snow')
    top = [G(cx + math.cos(ang) * (cr + r * 0.8), cy + math.sin(ang) * (cr + r * 0.8), z) for ang in [math.radians(d) for d in (40, 62, 85, 108, 130)]]
    A.add(tube(top, lambda t: 0.03 + 0.07 * math.sin(math.pi * t) ** 0.6, around=8, squash=1.6, cap=True), 'snow')


def chevron(A, s, tint):
    """An arrow painted across the ice, pointing up the ramp."""
    a = math.atan(slope(s))
    for sgn in (-1, 1):
        arm = bm_box(0.5, 0.008, 0.075, bev=0)
        transform(arm, (0, 0, 0), rot=(0, -sgn * math.radians(38), 0))
        transform(arm, (-0.2, 0, sgn * 0.33))
        transform(arm, (X0 + s, deck(s) + 0.012, 0), rot=(0, 0, a))
        A.add(arm, 'ribbon', tint)


def pennant(A, x, z, base, top, tint, lean):
    """A thin pole with a three-cornered flag flying from it."""
    A.add(tube([G(x, base, z), G(x + lean * 0.3, (base + top) / 2, z + lean * 0.04), G(x + lean * 0.55, top, z + lean * 0.1)], 0.028, around=6, cap_steps=1), 'wood', DARK)
    bm = bmesh.new()
    px, pz = x + lean * 0.55, z + lean * 0.1
    n = 6
    rows = []
    for i in range(n + 1):
        t = i / n
        wave = 0.05 * math.sin(t * 5.0) * t
        hgt = 0.27 * (1 - t)
        y = top - 0.32 - 0.04 * t
        rows.append((bm.verts.new(G(px - 0.85 * t, y + hgt, pz + wave)), bm.verts.new(G(px - 0.85 * t, y - hgt, pz + wave))))
    for i in range(n):
        a, b = rows[i], rows[i + 1]
        if i == n - 1: bm.faces.new((a[0], b[0], a[1]))
        else: bm.faces.new((a[0], b[0], b[1], a[1]))
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    # a back face too, so it shows from both sides
    geom = bmesh.ops.duplicate(bm, geom=bm.faces[:])['geom']
    bmesh.ops.reverse_faces(bm, faces=[g for g in geom if isinstance(g, bmesh.types.BMFace)])
    for f in bm.faces: f.smooth = True
    A.add(bm, 'ribbon', tint)
    A.add(transform(kit.blob(0.045, sub=1), (px, top + 0.02, pz)), 'metal')


def build_ramp():
    A = Asset('ramp')
    rng = random.Random(21)
    A.add(ice_deck(), 'ice', None)
    for sgn in (-1, 1):
        side_frame(A, sgn, rng)
        candy_rail(A, sgn)
    # joists under the ice, their sawn ends showing along the sides
    for s in (1.4, 2.2, 3.0, 3.8, 4.6, 5.3):
        a = math.atan(slope(s))
        j = bm_box(0.06, 0.07, SIDE + 0.03, bev=0.012)
        A.add(transform(j, (X0 + s, deck(s) - 0.19, 0), rot=(0, 0, a)), 'wood', DARK)
    # the front, under the lip: boards laid across, a beam along the top, and a cross of braces
    fx = X0 + LEN
    lip = deck(LEN)
    h = 0.3
    rows = int((lip - 0.16 - FOOT) / h)
    for i in range(rows):
        y = FOOT + (i + 0.5) * h
        tint = tuple(v * rng.uniform(0.86, 1.02) for v in PALE)
        A.add(transform(bm_box(0.03, h / 2 - 0.012, SIDE - 0.02, bev=0.012), (fx - 0.05, y, rng.uniform(-0.015, 0.015))), 'wood', tint)
    A.add(transform(bm_box(0.1, 0.1, SIDE + 0.12, bev=0.02), (fx - 0.04, lip - 0.21, 0)), 'wood', DARK)
    for sgn in (-1, 1):
        d = bm_box(0.028, 0.055, 1.05, bev=0.012)
        A.add(transform(d, (fx + 0.005, 0.5, 0), rot=(sgn * math.radians(28), 0, 0)), 'wood', DARK)
    # a peppermint where the braces cross
    A.add(transform(houses.disc_candy(0.36, 0.11), (fx + 0.06, 0.5, 0), rot=(0, math.pi / 2, 0)), 'mint', uv='keep')
    # icicles under the lip
    for i in range(11):
        ln = rng.uniform(0.16, 0.5)
        A.add(transform(kit.icicle(ln, 0.028 + ln * 0.05), (fx + 0.02, lip - 0.1, -1.4 + 2.8 * (i + rng.uniform(0.1, 0.9)) / 11)), 'ice')
    # a storm lantern hung on each front post, so you can find the lip in a blizzard
    for sgn in (-1, 1):
        px, pz, py = fx - 0.12, sgn * (SIDE + 0.19), lip + 0.2
        A.add(tube([G(px, py, pz), G(px + 0.2, py + 0.07, pz), G(px + 0.3, py + 0.02, pz)], 0.018, around=5, cap_steps=1), 'metal')
        A.add(transform(bm_box(0.07, 0.09, 0.07, bev=0.02), (px + 0.3, py - 0.13, pz)), 'glow')
        A.add(transform(bm_box(0.09, 0.016, 0.09, bev=0), (px + 0.3, py - 0.03, pz)), 'metal')
        A.add(transform(bm_box(0.085, 0.014, 0.085, bev=0.006), (px + 0.3, py - 0.225, pz)), 'metal')
    # arrows up the ice
    chevron(A, 1.9, ARROW)
    chevron(A, 2.9, ARROW)
    chevron(A, 3.9, ARROW)
    # a pennant on each corner of the lip, leaning out
    pennant(A, fx - 0.12, -(SIDE + 0.19), lip + 0.4, lip + 2.3, RED, 0.2)
    pennant(A, fx - 0.12, SIDE + 0.19, lip + 0.4, lip + 2.3, GREEN, 0.2)
    # snow: banked along both sides, piled against the front, spilling onto the low end
    for i, (x, z, sx, sz, sy) in enumerate((
            (X0 + 0.6, -(SIDE + 0.5), 1.5, 0.75, 0.3), (X0 + 0.5, SIDE + 0.55, 1.6, 0.8, 0.32),
            (X0 + 2.6, -(SIDE + 0.45), 1.3, 0.6, 0.42), (X0 + 2.9, SIDE + 0.45, 1.2, 0.6, 0.36),
            (fx - 0.7, -(SIDE + 0.5), 0.9, 0.6, 0.34), (fx - 0.8, SIDE + 0.5, 0.9, 0.55, 0.3),
            (fx + 0.5, -0.7, 0.7, 1.0, 0.36), (fx + 0.45, 0.9, 0.6, 0.8, 0.28),
            (X0 - 0.25, -1.0, 0.8, 0.9, 0.1), (X0 - 0.2, 0.9, 0.8, 0.9, 0.1))):
        A.add(transform(kit.drift((sx, sy, sz), seed=60 + i, around=16), (x, 0.0, z)), 'snow')
    return A, dict(target=(0.2, 0.7, 0), dist=11.5, yaw=128, pitch=17, lens=45,
                   more=[dict(tag='b', yaw=20, pitch=12, dist=10.5), dict(tag='c', yaw=180, pitch=28, dist=10)])
