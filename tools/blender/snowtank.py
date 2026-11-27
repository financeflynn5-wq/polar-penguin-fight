"""Builds the snow tank in Blender and writes public/models/snowtank.glb.

Run (Blender's Python, e.g. a venv with the `bpy` module):
    python tools/blender/snowtank.py                       # build and export
    python tools/blender/snowtank.py --stats --check       # ...with a triangle count per mesh and a clearance test
    python tools/blender/snowtank.py --render --riders --views=hero,rear,side,top --team=blue --team=orange
    python tools/blender/snowtank.py --render --arm=-1.95  # a render-only pose: the catapult's arm against its stop

It is built exactly like the snowmobile and the snowplow (see vehicles.py, whose helpers it borrows): GAME
coordinates (x forward, y up, z to the vehicle's right, metres, origin on the snow under the centre), and every moving
part is an empty AT ITS PIVOT, unrotated, with one child mesh per material:

    body                     everything fixed: hull, running gear frames, cockpit tub, deck fittings
    trackL, trackR           the belts, material `tread` (u across, v along, 1 unit = 1 m; see vehicles.belt)
    wheelL0…6, wheelR0…6     drive sprocket (0, at the back), five road wheels, idler (6): spin about z, `radius`
                             (L is -z; the belts' outer faces are at z = ±1.185, the hull's skirts at ±1.2)
    turret                   (1.05, 1.15, 0)   the gun's little turret: rotation.y
      gun                    (1.05, 1.50, 0)   cradle, hopper and spade grips on the trunnions: rotation.z, + = muzzle up
        barrels              (1.30, 1.50, 0)   the six barrels: spin about x
          muzzle             (1.90, 1.50, 0)   empty at the barrel tips
        gripL, gripR         (0.75, 1.50, ∓0.22)  empties on the spade grips
    catapult                 (-0.95, 1.15, 0)  turntable, frame, winch and the gunner's step: rotation.y
      arm                    (-0.70, 1.70, 0)  throwing arm and cup: rotation.z, 0 = cocked, STOP (-1.95) = on the stop
        bucket               (-2.15, 1.45, 0)  empty at the centre of the cup
        ammo                 (-2.15, 1.45, 0)  the packed snowball in the cup (the game hides it after a throw)
      seat1                  (-0.85, 1.15, 0.85)  empty: the gunner's feet, on the step
    seat0                    (0.2, 0.7, 0)     empty: the driver's feet, on the cockpit floor
    exhaust                  empty at the tail pipe's mouth

src/render/VehicleModel.ts loads it like the other two.
"""
import sys, os, math
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree
import kit
from kit import G, tube, transform, bm_box, bm_ico, shade, displace
from vehicles import (Vehicle, export, TEXTURED, lerp, clamp, smooth, spaced, gtube, loft, rbox, lathe, remap, plate, grid,
                      bolt, spring, wheel, sprocket, sweep, rsect, lamp, belt,
                      PAINT, PAINT_DARK, CHARCOAL, BLACK, IVORY, STEEL, YELLOW, RED, LEATHER, PI, TEAMS, VIEWS)

RENDERS = os.path.join(os.path.dirname(__file__), 'renders')

# ── the numbers the game is written to (src/sim/Vehicles.ts, src/render/VehicleModel.ts) ──
TURRET = (1.05, 1.15, 0.0)     # the turret turns about y here
GUN = (1.05, 1.5, 0.0)         # the gun pitches about z here (its trunnions)
HUB = (1.3, 1.5, 0.0)          # the barrels spin about x here
MUZZLE = (1.9, 1.5, 0.0)
GRIP_X, GRIP_Z = 0.75, 0.22
CATAPULT = (-0.95, 1.15, 0.0)  # the turntable turns about y here; its top is the y given
HINGE = (-0.7, 1.7, 0.0)       # the arm swings about z here
CUP = (-2.15, 1.45, 0.0)       # centre of the cup with the arm cocked (rotation 0)
STOP = -1.95                   # the arm's rotation.z when it lies against the padded crossbar
SEAT0 = (0.2, 0.7, 0.0)
SEAT1 = (-0.85, 1.15, 0.85)
BALL = 0.28                    # the catapult's snowball

# hull
HX0, HX1, HW = -1.97, 1.98, 1.2
DECK, REAR_DECK = 1.08, 1.0    # the deck in front of the catapult, and the lower one it stands on
CK0, CK1, CKW = -0.3, 0.61, 0.5   # the cockpit opening
WOOD_A, WOOD_B, WOOD_C = (1.0, 0.95, 0.88), (0.86, 0.8, 0.74), (0.7, 0.62, 0.55)
IRON = (0.62, 0.64, 0.68)
CANVAS = (0.96, 0.88, 0.7)


# ───────────────────────── helpers ─────────────────────────
def grain(bm, a, b, k=0, tile=1.2):
    """Wood UVs for a piece whose grain runs from GAME point a to b. The texture is four planks wide, so each face is
    centred on a plank (k picks which) and no board joint ever crosses the piece."""
    a_, b_ = G(*a), G(*b)
    d = (b_ - a_).normalized()
    e1 = d.orthogonal().normalized(); e2 = d.cross(e1)
    uv = bm.loops.layers.uv.get('UVMap') or bm.loops.layers.uv.new('UVMap')
    bm.normal_update()
    for f in bm.faces:
        side = 0 if abs(f.normal.dot(e2)) > abs(f.normal.dot(e1)) else 1
        e = e1 if side == 0 else e2
        for l in f.loops:
            p = l.vert.co - a_
            l[uv].uv = (0.125 + 0.25 * ((k + side) % 4) + p.dot(e) / tile, p.dot(d) / tile + k * 0.37)
    return bm


def beam(A, a, b, w, h, k=0, tint=WOOD_A, bev=0.012, mat='wood'):
    """A squared timber from GAME point a to b: w across (along z, or along x for a beam that runs across the
    vehicle), h deep. It must lie in a plane z = const or run along z."""
    a_, b_ = Vector(a), Vector(b)
    d = b_ - a_
    bm = bm_box(d.length / 2, h / 2, w / 2, bev=bev, segs=1)
    rot = (0, PI / 2, 0) if abs(d.z) > max(abs(d.x), abs(d.y)) else (0, 0, math.atan2(d.y, d.x))
    transform(bm, tuple((a_ + b_) / 2), rot=rot)
    shade(bm, 40)
    if mat == 'wood':
        A.add(grain(bm, a, b, k), 'wood', tint, uv='keep')
    else:
        A.add(bm, mat, tint)


def facing(bm, toward):
    """Turn an open piece so its faces look toward the GAME direction given."""
    bm.normal_update()
    t = G(*toward)
    if sum(f.normal.dot(t) * f.calc_area() for f in bm.faces) < 0: bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    return bm


def ring_bolts(A, c, r, n, y, mat='chrome', tint=(1, 1, 1), size=0.015, a0=0.0):
    """Bolt heads standing up in a circle of radius r round GAME point c, at height y."""
    for k in range(n):
        a = a0 + 2 * PI * k / n
        A.add(bolt((c[0] + math.cos(a) * r, y, c[2] + math.sin(a) * r), 'y', r=size, h=size * 0.7), mat, tint)


def side_bolts(A, c, r, n, y, mat='chrome', tint=(1, 1, 1), size=0.014, a0=0.0):
    """Bolt heads round the wall of an upright drum."""
    for k in range(n):
        a = a0 + 2 * PI * k / n
        A.add(transform(bolt((r, y - c[1], 0), 'x', r=size, h=size * 0.7), c, rot=(0, a, 0)), mat, tint)


def torus(c, R, r, axis='z', segs=16, around=6):
    """A ring of round bar about GAME point c (axis 'x', 'y' or 'z')."""
    pts = []
    for i in range(segs + 1):
        a = 2 * PI * i / segs
        u, v = math.cos(a) * R, math.sin(a) * R
        pts.append(G(*{'z': (c[0] + u, c[1] + v, c[2]), 'x': (c[0], c[1] + u, c[2] + v), 'y': (c[0] + u, c[1], c[2] + v)}[axis]))
    bm = tube(pts, r, around=around, cap=False)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    return bm


def slat(hx, hy, hz):
    """A plain little box (GAME half sizes) for slats and treads too small to want rounded edges."""
    return bm_box(hx, hy, hz, bev=0)


def snowball(r, seed=0, sub=2, rough=0.05):
    bm = bm_ico(1.0, sub)
    displace(bm, rough, 1.9, seed)
    bmesh.ops.scale(bm, vec=(r, r, r), verts=bm.verts[:])
    for f in bm.faces: f.smooth = True
    return bm


# ───────────────────────── the hull's shape ─────────────────────────
def pw(knots, x):
    """Piecewise-linear through (x, value) knots."""
    if x <= knots[0][0]: return knots[0][1]
    for (x0, y0), (x1, y1) in zip(knots[:-1], knots[1:]):
        if x <= x1: return lerp(y0, y1, (x - x0) / (x1 - x0))
    return knots[-1][1]


GLACIS_X, TAIL_X, STEP_X0, STEP_X1 = 1.44, -1.6, -0.40, -0.345
NOSE_TOP, TAIL_TOP = 0.8, 0.84
TOP_KNOTS = [(HX0, TAIL_TOP), (TAIL_X, REAR_DECK), (STEP_X0, REAR_DECK), (STEP_X1, DECK), (GLACIS_X, DECK), (HX1, NOSE_TOP)]
SKIRT, ARCH = 0.56, 0.85       # the skirt's lower edge amidships, and where it arches over the sprocket and the idler
SHOULDER = 0.9                 # above this the hull's sides lean in
TH, T1, T_BAND = 0.54, 0.63, 0.26
GLACIS_ANGLE = math.atan2(NOSE_TOP - DECK, HX1 - GLACIS_X)


def deck_top(x): return pw(TOP_KNOTS, x)


def skirt_bot(x):
    a = abs(x)
    if a <= 1.5: return SKIRT + (ARCH - SKIRT) * smooth(0.98, 1.46, a)
    return lerp(ARCH, 0.7 if x > 0 else 0.74, smooth(1.6, 1.98, a))


def shoulder(x): return min(SHOULDER, deck_top(x) - 0.045)


def hull_y(x, t):
    """Height of the hull's skin at x, t = 0 (the skirt's lower edge) to 1 (the deck)."""
    top, bot, ys = deck_top(x), skirt_bot(x), shoulder(x)
    return lerp(bot, ys, t / T1) if t < T1 else lerp(ys, top, (t - T1) / (1 - T1))


def hull_side(x, y, z):
    """The z of a point on the hull's side that would be at z on a straight-sided hull: it leans in above the shoulder."""
    inset = 0.62 * max(0.0, y - shoulder(x)) * smooth(0.7, 1.0, abs(z))
    return z - math.copysign(inset, z)


def hull_shell():
    """One pressed shell: a slab cut to the hull's plan with the cockpit punched through it, then every point carried
    to its place (the glacis and tail slope down, the skirts arch over the sprockets, the shoulders lean in)."""
    outline = kit.rounded_rect(HX0, -HW, HX1, HW, 0.34, 7)
    hole = kit.rounded_rect(CK0, -CKW, CK1, CKW, 0.2, 5)
    bm = kit.slab(outline, [hole], thickness=TH, bev=0.07, segs=3, max_len=0.5, wobble=0)
    def cut(co, no, where=None):
        faces = [f for f in bm.faces if not where or where(f.calc_center_median())]
        geom = set(faces)
        for f in faces: geom.update(f.edges); geom.update(f.verts)
        bmesh.ops.bisect_plane(bm, geom=list(geom), dist=1e-5, plane_co=Vector(co), plane_no=Vector(no))
    def in_hole(c): return CK0 - 0.1 < c.x < CK1 + 0.1 and abs(c.z) < CKW + 0.1
    # creases right across: the glacis, the tail, the step down to the lower deck
    for x in (GLACIS_X - 0.02, GLACIS_X + 0.02, TAIL_X - 0.02, TAIL_X + 0.02, STEP_X0 - 0.012, STEP_X0, STEP_X1, STEP_X1 + 0.012):
        cut((x, 0, 0), (1, 0, 0))
    # the flanks only: where the skirt's lower edge curves, and where the sides fold at the shoulder and change shade
    for x in [k * v for k in (-1, 1) for v in (0.98, 1.08, 1.18, 1.28, 1.38, 1.47, 1.6, 1.72, 1.85)]:
        cut((x, 0, 0), (1, 0, 0), lambda c: abs(c.z) > 0.8)
    for t in (T1 - 0.03, T1 + 0.03, T_BAND):
        cut((0, (t - 0.5) * TH, 0), (0, 1, 0), lambda c: not in_hole(c))
    # the underside is never seen: a few big faces close it instead (see build_snowtank)
    bm.normal_update()
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.normal.y < -0.95 and f.calc_center_median().y < -TH / 2 + 0.01], context='FACES')
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    # two-tone: the skirts are a deeper shade of the team colour
    col = bm.loops.layers.float_color.new('Col')
    for f in bm.faces:
        c = f.calc_center_median()
        tint = PAINT_DARK if (c.y / TH + 0.5 < T_BAND and not in_hole(c)) else PAINT
        for l in f.loops: l[col] = (*tint, 1.0)
    def carry(c):
        y = hull_y(c.x, c.y / TH + 0.5)
        return G(c.x, y, hull_side(c.x, y, c.z))
    remap(bm, carry)
    shade(bm, 42)
    return bm


def hull_loop(yfn, grow=0.006, step=0.1, x0=None, x1=None, side=None):
    """Points on the hull's skin at height yfn(x), pushed out by `grow`: all round, or (side = ±1, x0..x1) along one
    flank."""
    if side:
        return [G(x, yfn(x), hull_side(x, yfn(x), side * HW) + side * grow) for x in spaced(x0, x1, max(2, int((x1 - x0) / step)))]
    pts = kit.rounded_rect(HX0 - grow, -HW - grow, HX1 + grow, HW + grow, 0.34 + grow, 7)
    out = []
    for i, p in enumerate(pts):
        q = pts[(i + 1) % len(pts)]
        n = max(1, int(math.hypot(q[0] - p[0], q[1] - p[1]) / step))
        for j in range(n):
            x, z = lerp(p[0], q[0], j / n), lerp(p[1], q[1], j / n)
            y = yfn(x)
            out.append(G(x, y, hull_side(x, y, z)))
    return out


# ───────────────────────── the snow tank ─────────────────────────
def build_snowtank():
    """A chunky little tank on two rubber tracks: 4.2 m long over the tracks, 2.4 m wide over the skirts, deck at
    1.08 m (the turret's ring and the catapult's turntable stand up to 1.15), the top of the catapult's frame at 2.4 m,
    the cup hanging 0.4 m out behind. A snowball gatling on a turret at the front for the driver, who stands in an
    open tub behind it; a catapult on a turntable on the lower rear deck, with a step on its right for the gunner.

    What turns where (python snowtank.py --check): the arm swings from 0 to STOP without touching anything and meets
    the pad just past STOP. The turntable can turn right round over the hull, whatever the arm is doing; what it
    cannot miss is the driver, whom the gunner on the step walks into for rotation.y of about +0.7 to +2.2, and the
    cocked cup for about 2.5 to 3.8 (so it is free from -2.5 to +0.65). The gun clears everything at any yaw while it
    is level or raised (to +0.6); pointed down it only clears the deck's fittings within about 0.8 of straight ahead."""
    V = Vehicle('snowtank')
    B = V.part('body')

    # ── running gear ──
    TW, TT, ZT = 0.49, 0.06, 0.94
    spr, idl = (-1.76, 0.48, 0.28), (1.76, 0.48, 0.28)
    bog = [(x, 0.27, 0.21) for x in (-1.14, -0.57, 0.0, 0.57, 1.14)]
    for side, s in (('L', -1), ('R', 1)):
        z = s * ZT
        T = V.part('track' + side)
        bm, length, vs = belt([spr, bog[0], bog[-1], idl], TW, TT, z, edge=0.016, cols=5)
        T.add(bm, 'tread', uv='keep')
        if s < 0: print(f'snowtank tracks: {length:.3f} m of belt each, v scale {vs:.4f}')
        W = V.part(f'wheel{side}0', pivot=(spr[0], spr[1], z), ao='self', radius=spr[2])
        sprocket(W, (spr[0], spr[1], z), spr[2] * 0.97, 0.36, teeth=11, segs=18, faces=(s,))
        for i, b in enumerate(bog):
            W = V.part(f'wheel{side}{i + 1}', pivot=(b[0], b[1], z), ao='self', radius=b[2])
            wheel(W, (b[0], b[1], z), b[2], 0.3, marks=5, segs=16, faces=(s,))
        W = V.part(f'wheel{side}6', pivot=(idl[0], idl[1], z), ao='self', radius=idl[2])
        wheel(W, (idl[0], idl[1], z), idl[2], 0.32, marks=6, segs=18, rim=0.7, faces=(s,))
        # the track frame inside the belt and the stub axles
        zi = s * (ZT - 0.2)
        frame = [(-1.72, 0.4), (-1.3, 0.25), (1.3, 0.25), (1.72, 0.4), (1.72, 0.56), (1.3, 0.62), (-1.3, 0.62), (-1.72, 0.56)]
        B.add(plate(frame, zi - 0.04, zi + 0.04, bev=0.016, segs=1), 'trim', CHARCOAL)
        for c in [spr, idl] + bog:
            B.add(gtube([(c[0], c[1], zi), (c[0], c[1], z)], 0.045, around=8, cap=False), 'trim', STEEL)
        # mud flap behind the track
        fl = grid(lambda u, v: G(-1.99 - 0.05 * v, lerp(0.76, 0.3, v), z + lerp(-0.23, 0.23, u)), 4, 3, thickness=0.022, inside=G(0, 0.5, 0))
        B.add(fl, 'rubber', (1, 1, 1))

    # ── hull ──
    B.add(hull_shell(), 'paint', None)
    xs = spaced(HX0 + 0.1, HX1 - 0.1, 26)
    B.add(facing(loft([[G(x, skirt_bot(x) + 0.05, z) for z in (-HW + 0.03, -0.3, 0.3, HW - 0.03)] for x in xs], closed=False), (0, -1, 0)), 'trim', BLACK)
    # the tub between the tracks, its chin and its tail plate
    B.add(rbox(-1.8, 1.8, 0.3, 0.72, 0.655, r=0.1, edge=0.05, n=3, steps=2), 'trim', CHARCOAL)
    B.add(rbox(1.62, 1.86, 0.34, 0.78, 0.66, r=0.08, edge=0.06, lean=0.1, n=3), 'paint', PAINT)
    B.add(rbox(-1.86, -1.7, 0.36, 0.83, 0.64, r=0.06, edge=0.05, lean=-0.08, n=3), 'paint', PAINT_DARK)
    for z in (-0.34, 0.34):       # tow hooks
        B.add(gtube([(1.88, 0.6, z - 0.06), (1.99, 0.6, z - 0.06), (1.99, 0.6, z + 0.06), (1.88, 0.6, z + 0.06)], 0.022, around=6, corner=0.03), 'trim', YELLOW)
    for i in range(6):
        B.add(bolt((1.948, 0.71, -0.45 + i * 0.18), 'x', r=0.018, h=0.012), 'chrome')
    B.add(gtube([(1.84, 0.43, -0.56), (1.95, 0.43, -0.5), (1.95, 0.43, 0.5), (1.84, 0.43, 0.56)], 0.042, around=10, corner=0.06), 'chrome')   # nudge bar
    B.add(gtube([(-1.86, 0.52, 0), (-1.96, 0.52, 0)], 0.035, around=8), 'metal')            # tow pin
    B.add(lathe([(0.055, -0.02), (0.068, 0), (0.055, 0.02), (0.03, 0.02), (0.03, -0.02)], 12, 'y', (-1.97, 0.52, 0)), 'metal')
    for z in (-0.36, 0.36):
        B.add(transform(bm_box(0.012, 0.045, 0.09, bev=0.01, segs=1), (-1.905, 0.66, z)), 'trim', YELLOW)

    # an ivory coach line under the shoulder, and rivets along the skirts
    for s in (-1, 1):
        rows = [hull_loop(lambda x, y=y: y, 0.006, x0=-1.44, x1=1.44, side=s) for y in (0.846, 0.878)]
        B.add(facing(loft(rows, closed=False), (0, 0, s)), 'trim', IVORY)
        for i in range(13):
            x = -1.32 + i * 0.22
            B.add(bolt((x, skirt_bot(x) + 0.075, s * (HW + 0.001)), 'z' if s > 0 else '-z', r=0.017, h=0.01), 'chrome')
        for i in range(3):          # three ivory flashes
            x0 = 0.5 + i * 0.105
            bm = bmesh.new()
            bm.faces.new([bm.verts.new(G(x, y, s * (HW + 0.006))) for x, y in ((x0, 0.728), (x0 + 0.06, 0.728), (x0 + 0.11, 0.822), (x0 + 0.05, 0.822))])
            B.add(facing(bm, (0, 0, s)), 'trim', IVORY)
        # on the deck: a non-slip plate beside the cockpit, bolts along the edge
        B.add(rbox(-0.27, 0.27, DECK - 0.004, DECK + 0.008, 0.15, r=0.03, edge=0.004, z0=s * 0.83, n=2, steps=1), 'trim', CHARCOAL)
        for i in range(6):
            B.add(transform(slat(0.012, 0.004, 0.13), (-0.2 + i * 0.08, DECK + 0.01, s * 0.83)), 'trim', STEEL)
        for x in spaced(-0.2, 1.3, 6):
            B.add(bolt((x, DECK, s * 1.035), 'y', r=0.015, h=0.01), 'chrome')
        for x in spaced(-1.5, -0.55, 4):
            B.add(bolt((x, REAR_DECK, s * 1.095), 'y', r=0.015, h=0.01), 'chrome')

    # ── cockpit: a tub the driver stands in, a padded rim round the front of it ──
    B.add(rbox(CK0 - 0.04, CK1 + 0.04, 0.64, SEAT0[1], CKW + 0.04, r=0.2, edge=0.006, n=4, steps=1), 'trim', CHARCOAL)
    for i in range(6):
        B.add(transform(slat(0.02, 0.006, 0.3), (CK0 + 0.14 + i * 0.125, SEAT0[1] + 0.004, 0)), 'rubber', (1, 1, 1))
    rim = kit.rounded_rect(CK0, -CKW, CK1, CKW, 0.2, 5)[:12]
    rim = [(-0.02, -CKW)] + rim + [(-0.02, CKW)]
    B.add(gtube([(x, DECK + 0.003, z) for x, z in rim], 0.03, around=8), 'seat', LEATHER)
    for x, z in rim[1:-1:2]:
        B.add(transform(bm_ico(0.01, 1), (x + (0.035 if x > 0.5 else 0), DECK + 0.008, z * 1.075)), 'chrome')
    V.empty('seat0', SEAT0)

    # ── deck fittings ──
    # the turret's ring
    RH = TURRET[1] - DECK
    B.add(lathe([(0.3, 0.0), (0.4, 0.0), (0.4, RH - 0.024), (0.378, RH), (0.3, RH)], 30, 'y', (TURRET[0], DECK, 0)), 'trim', STEEL)
    ring_bolts(B, TURRET, 0.36, 16, TURRET[1], size=0.013)
    # the catapult's barbette on the lower deck
    B.add(lathe([(0.4, 0.0), (0.6, 0.0), (0.6, 0.022), (0.56, 0.03), (0.56, 0.072), (0.4, 0.072)], 36, 'y', (CATAPULT[0], REAR_DECK, 0)), 'trim', CHARCOAL)
    ring_bolts(B, CATAPULT, 0.58, 18, REAR_DECK + 0.026, size=0.014)
    # headlamps: two frog eyes at the top of the glacis, each behind a wire guard
    for s in (-1, 1):
        c = (1.52, DECK + 0.128, s * 0.8)
        lamp(B, c, 0.105, bowl='paint', bowl_tint=PAINT, depth=0.26, segs=20, rot=(0, 0, -0.06))
        B.add(gtube([(1.4, DECK - 0.02, s * 0.8), (1.42, DECK + 0.06, s * 0.8)], 0.035, around=8, cap=False), 'paint', PAINT)
        for dz in (-0.05, 0.05):
            B.add(gtube([(1.5, DECK, c[2] + dz), (1.65, DECK + 0.03, c[2] + dz), (1.66, c[1] + 0.1, c[2] + dz), (1.5, c[1] + 0.128, c[2] + dz)], 0.008, around=5, corner=0.05, n=3), 'trim', BLACK)
    # a snowflake badge on the glacis
    gm = ((GLACIS_X + HX1) / 2 - 0.02, (DECK + NOSE_TOP) / 2 + 0.008)
    for k in range(3):
        B.add(transform(transform(slat(0.2, 0.006, 0.026), rot=(0, k * PI / 3, 0)), (gm[0], gm[1], 0), rot=(0, 0, GLACIS_ANGLE)), 'trim', IVORY)
    for j in range(6):
        for w in (-1, 1):
            tip = transform(slat(0.04, 0.006, 0.017), (0.04, 0, 0))
            transform(tip, (0.11, 0, 0), rot=(0, w * 0.85, 0))
            transform(tip, rot=(0, j * PI / 3, 0))
            B.add(transform(tip, (gm[0], gm[1], 0), rot=(0, 0, GLACIS_ANGLE)), 'trim', IVORY)
    B.add(transform(bolt((0, 0.006, 0), 'y', r=0.035, h=0.012), (gm[0], gm[1], 0), rot=(0, 0, GLACIS_ANGLE)), 'chrome')
    # rivets along the glacis' top edge
    for i in range(9):
        B.add(bolt((GLACIS_X - 0.05, DECK, -0.6 + i * 0.15), 'y', r=0.015, h=0.01), 'chrome')
    # a crate of snowballs lashed to the deck on the left
    cx, cz, chx, chz, cy = 0.56, -0.82, 0.23, 0.17, DECK
    B.add(grain(transform(bm_box(chx - 0.012, 0.012, chz - 0.012, bev=0.004, segs=1), (cx, cy + 0.012, cz)), (cx - 1, cy, cz), (cx + 1, cy, cz), 1), 'wood', WOOD_C, uv='keep')
    for sz in (-1, 1):
        for i in range(2):
            y = cy + 0.055 + i * 0.1
            beam(B, (cx - chx, y, cz + sz * chz), (cx + chx, y, cz + sz * chz), 0.02, 0.08, k=i + sz, tint=WOOD_A if i else WOOD_B, bev=0)
    for sx in (-1, 1):
        for i in range(2):
            y = cy + 0.055 + i * 0.1
            beam(B, (cx + sx * chx, y, cz - chz + 0.012), (cx + sx * chx, y, cz + chz - 0.012), 0.02, 0.08, k=i + 2, tint=WOOD_B if i else WOOD_A, bev=0)
        for sz in (-1, 1):
            beam(B, (cx + sx * (chx + 0.004), cy, cz + sz * (chz + 0.004)), (cx + sx * (chx + 0.004), cy + 0.205, cz + sz * (chz + 0.004)), 0.034, 0.034, k=3, tint=WOOD_C, bev=0)
    for i, (dx, dz, dy, r) in enumerate(((-0.11, -0.06, 0.13, 0.09), (0.06, -0.05, 0.14, 0.095), (-0.02, 0.07, 0.13, 0.085), (0.14, 0.07, 0.12, 0.08), (-0.15, 0.07, 0.11, 0.075), (0.0, 0.0, 0.24, 0.085))):
        B.add(transform(snowball(r, seed=i + 3), (cx + dx, cy + dy, cz + dz)), 'snow')
    # a shovel clipped to the deck on the right, a coil of rope lying on the glacis
    hz = 0.86
    B.add(gtube([(0.38, DECK + 0.04, hz), (1.0, DECK + 0.04, hz)], 0.02, around=6), 'wood', WOOD_B)
    B.add(gtube([(0.38, DECK + 0.04, hz - 0.05), (0.38, DECK + 0.04, hz + 0.05)], 0.022, around=6), 'wood', WOOD_B)
    sh = grid(lambda u, v: G(lerp(1.0, 1.3, u), DECK + 0.065 - 0.03 * (1 - (2 * v - 1) ** 2) * (0.4 + 0.6 * u), hz + (v - 0.5) * lerp(0.19, 0.25, u)), 3, 4, thickness=0.01, inside=G(1.15, 0, hz))
    B.add(sh, 'metal')
    for x in (0.52, 0.9):
        B.add(transform(bm_box(0.022, 0.03, 0.035, bev=0.01, segs=1), (x, DECK + 0.03, hz)), 'trim', BLACK)
    def on_glacis(bm, x, z, lift=0.0):
        return transform(bm, (x, pw(TOP_KNOTS, x) + lift, z), rot=(0, 0, GLACIS_ANGLE))
    spare = kit.Asset('spare')          # a spare road wheel strapped down on the left of it
    wheel(spare, (0, 0, 0), 0.21, 0.13, marks=5, segs=16, faces=(1,))
    for mat, bms in spare.parts.items():
        for bm in bms:
            B.add(on_glacis(transform(bm, rot=(-PI / 2, 0, 0)), 1.7, -0.52, 0.06), mat, None, uv='keep')
    for i in range(3):
        B.add(on_glacis(torus((0, 0.022 + i * 0.036, 0), 0.118 - 0.006 * i, 0.02, 'y', segs=14, around=5), 1.68, 0.6), 'rope')
    B.add(on_glacis(gtube([(0.1, 0.1, 0.03), (0.16, 0.06, 0.06), (0.2, 0.02, 0.0), (0.22, 0.02, -0.12)], 0.02, around=5, corner=0.04), 1.68, 0.6), 'rope')
    # aerial with a team pennant
    ax, az = 0.95, -0.96
    B.add(lathe([(0.04, 0), (0.04, 0.02), (0.022, 0.035), (0.022, 0.1), (0.012, 0.12)], 10, 'y', (ax, DECK, az)), 'trim', BLACK)
    B.add(gtube([(ax, DECK + 0.1, az), (ax - 0.02, 1.9, az), (ax - 0.09, 2.4, az)], 0.007, around=5, corner=0.2), 'trim', BLACK)
    B.add(transform(bm_ico(0.018, 1), (ax - 0.09, 2.4, az)), 'trim', YELLOW)
    pen = grid(lambda u, v: G(ax - 0.062 - 0.3 * u, 2.24 + (v - 0.5) * 0.16 * (1 - u) + 0.015 * math.sin(u * 7), az + 0.03 * math.sin(u * 5.5)), 6, 2, thickness=0.006, inside=G(ax - 0.2, 2.24, az + 1))
    B.add(pen, 'paint', PAINT)
    # the lower deck: an engine hatch with louvres on the left, a filler cap, tail lamps and the exhaust
    B.add(rbox(-1.5, -0.62, REAR_DECK - 0.005, REAR_DECK + 0.016, 0.2, r=0.04, edge=0.01, z0=-0.86, n=3, steps=1), 'paint', PAINT_DARK)
    for i in range(6):
        B.add(transform(slat(0.018, 0.008, 0.15), (-1.38 + i * 0.13, REAR_DECK + 0.022, -0.86)), 'trim', BLACK)
    B.add(gtube([(-0.72, REAR_DECK + 0.016, -0.98), (-0.72, REAR_DECK + 0.05, -0.98), (-0.72, REAR_DECK + 0.05, -0.74), (-0.72, REAR_DECK + 0.016, -0.74)], 0.01, around=5, corner=0.02), 'chrome')
    B.add(lathe([(0.055, 0), (0.055, 0.02), (0.045, 0.034), (0, 0.036)], 12, 'y', (-1.52, REAR_DECK - 0.012, 0.62)), 'chrome')
    slope = math.atan2(REAR_DECK - TAIL_TOP, TAIL_X - HX0)
    tm = ((TAIL_X + HX0) / 2 + 0.02, (REAR_DECK + TAIL_TOP) / 2 + 0.006)
    B.add(transform(bm_box(0.13, 0.008, 0.46, bev=0.006, segs=1), (tm[0], tm[1], 0), rot=(0, 0, slope)), 'trim', BLACK)
    for i in range(5):
        B.add(transform(transform(slat(0.012, 0.007, 0.44), (-0.1 + i * 0.05, 0.012, 0)), (tm[0], tm[1], 0), rot=(0, 0, slope)), 'trim', STEEL)
    for s in (-1, 1):
        lamp(B, (-1.955, 0.86, s * 0.82), 0.06, lens='lamp_red', rot=(0, PI, 0.25), segs=14, dome=0.35)
    ez = -0.8
    B.add(gtube([(-1.62, 0.93, ez), (-1.9, 0.93, ez), (-2.02, 1.02, ez)], 0.047, around=10, corner=0.08), 'chrome')
    B.add(lathe([(0.05, 0), (0.058, 0.01), (0.058, 0.05), (0.04, 0.05), (0.04, 0.0)], 10, 'y'), 'trim', BLACK)
    B.parts['trim'][-1] = transform(B.parts['trim'][-1], (-1.99, 1.0, ez), rot=(0, 0, 0.93))
    V.empty('exhaust', (-2.06, 1.06, ez))
    # snow caked on it: caps on the lamps, heaps on the nose and the tail, a wedge in the angle of the deck step
    def lump(at, size, seed, rot=(0, 0, 0), sub=3):
        B.add(transform(kit.snow_lump(size, seed=seed, sub=sub), at, rot=rot), 'snow')
    for s in (-1, 1):
        lump((1.4, DECK + 0.225, s * 0.82), (0.1, 0.04, 0.085), 4 + s, sub=2)
    lump((1.84, deck_top(1.84) - 0.03, -0.86), (0.12, 0.085, 0.17), 5, rot=(0, 0, GLACIS_ANGLE))
    lump((1.62, deck_top(1.62) + 0.115, -0.6), (0.1, 0.035, 0.1), 7, rot=(0, 0, GLACIS_ANGLE), sub=2)
    lump((-1.76, deck_top(-1.76) - 0.03, 0.72), (0.2, 0.09, 0.28), 9, rot=(0, 0, slope))
    lump((-1.52, REAR_DECK - 0.02, -1.0), (0.16, 0.07, 0.12), 12, sub=2)
    B.add(kit.pipe([G(STEP_X0 - 0.035, REAR_DECK + 0.012, z) for z in spaced(-1.08, -0.6, 7)], 0.075, around=7, wobble=0.28, seed=3, squash=0.8), 'snow')
    B.add(kit.pipe([G(STEP_X0 - 0.03, REAR_DECK + 0.01, z) for z in spaced(0.62, 0.9, 4)], 0.06, around=7, wobble=0.3, seed=8, squash=0.8), 'snow')
    # icicles under the nose, the tail and the skirts
    TEXTURED.add('ice')
    def icicles(pts):
        for i, (x, y, z, L) in enumerate(pts):
            B.add(transform(kit.icicle(L, r=0.016 + L * 0.1, around=4, bend=0.01 * ((i % 3) - 1)), (x, y, z)), 'ice')
    icicles([(1.972, 0.728, z, L) for z, L in ((-0.52, 0.1), (-0.4, 0.17), (-0.13, 0.08), (0.1, 0.14), (0.22, 0.07), (0.5, 0.12))])
    icicles([(-1.962, 0.762, z, L) for z, L in ((-0.45, 0.12), (-0.2, 0.07), (0.28, 0.15), (0.42, 0.09))])
    for s in (-1, 1):
        icicles([(x, SKIRT + 0.012, s * 1.178, L) for x, L in ((-0.82, 0.09), (-0.66, 0.15), (-0.2, 0.07), (0.12, 0.13), (0.3, 0.08), (0.78, 0.11))][::s])

    # ── turret ──
    Tu = V.part('turret', pivot=TURRET)
    ty = TURRET[1]
    Tu.add(lathe([(0.33, 0.0), (0.34, 0.012), (0.34, 0.066), (0.318, 0.092), (0.2, 0.106), (0, 0.11)], 30, 'y', TURRET), 'paint', PAINT)
    Tu.add(lathe([(0.341, 0.02), (0.347, 0.024), (0.347, 0.052), (0.341, 0.056)], 30, 'y', TURRET), 'trim', IVORY)
    for s in (-1, 1):       # the cheeks that carry the trunnions
        o = [(0.9, ty + 0.07), (1.24, ty + 0.07), (1.19, GUN[1] - 0.07)]
        o += [(GUN[0] + 0.1 * math.cos(a), GUN[1] + 0.1 * math.sin(a)) for a in [lerp(-0.4, PI + 0.4, i / 10) for i in range(11)]]
        o += [(0.93, GUN[1] - 0.07)]
        Tu.add(plate(o, s * 0.175 - 0.025, s * 0.175 + 0.025, bev=0.014, segs=1), 'paint', PAINT_DARK)
        pr = [(0.0, 0.0), (0.06, 0.0), (0.06, 0.014), (0.036, 0.026), (0.0, 0.028)]
        if s < 0: pr = [(q, -h) for q, h in pr][::-1]
        Tu.add(lathe(pr, 12, 'z', (GUN[0], GUN[1], s * 0.2)), 'chrome')
        for x in (0.96, 1.17):
            Tu.add(bolt((x, ty + 0.17, s * 0.2), 'z' if s > 0 else '-z', r=0.015, h=0.009), 'chrome')

    # ── gun: cradle, hopper, spade grips ──
    Gn = V.part('gun', pivot=GUN, parent='turret')
    gy = GUN[1]
    Gn.add(rbox(0.84, 1.26, gy - 0.085, gy + 0.085, 0.11, r=0.035, edge=0.03, n=3), 'trim', CHARCOAL)
    Gn.add(gtube([(GUN[0], gy, -0.2), (GUN[0], gy, 0.2)], 0.036, around=10, cap=False), 'metal')
    Gn.add(rbox(0.92, 1.22, gy + 0.08, gy + 0.102, 0.085, r=0.02, edge=0.008, n=2, steps=1), 'trim', STEEL)
    for s in (-1, 1):
        for x in (0.89, 1.21):
            Gn.add(bolt((x, gy + 0.045, s * 0.111), 'z' if s > 0 else '-z', r=0.013, h=0.008), 'chrome')
    # the hopper: an open drum of snowballs feeding down a funnel
    hx, hy = 1.08, gy + 0.098
    Gn.add(lathe([(0.06, 0.0), (0.066, 0.03), (0.16, 0.105), (0.18, 0.12), (0.18, 0.22), (0.196, 0.23), (0.196, 0.26), (0.176, 0.267), (0.164, 0.26), (0.164, 0.16)], 24, 'y', (hx, hy, 0)), 'trim', YELLOW)
    Gn.add(lathe([(0.181, 0.14), (0.186, 0.145), (0.186, 0.185), (0.181, 0.19)], 24, 'y', (hx, hy, 0)), 'trim', BLACK)
    Gn.add(facing(lathe([(0.166, 0.222), (0.12, 0.25), (0.0, 0.262)], 14, 'y', (hx, hy, 0)), (0, 1, 0)), 'snow')
    for i, (a, rr, dy, r) in enumerate(((0.3, 0.09, 0.262, 0.066), (2.3, 0.095, 0.258, 0.062), (4.4, 0.092, 0.26, 0.065), (1.2, 0.012, 0.335, 0.064))):
        Gn.add(transform(snowball(r, seed=i, sub=2, rough=0.04), (hx + math.cos(a) * rr, hy + dy, math.sin(a) * rr)), 'snow')
    # spade grips
    for s, name in ((-1, 'gripL'), (1, 'gripR')):
        z = s * GRIP_Z
        Gn.add(gtube([(0.85, gy + 0.05, s * 0.075), (GRIP_X, gy + 0.07, z), (GRIP_X, gy - 0.07, z), (0.85, gy - 0.05, s * 0.075)], 0.013, around=6, corner=0.03, n=3), 'chrome')
        Gn.add(gtube([(GRIP_X, gy - 0.045, z), (GRIP_X, gy + 0.045, z)], 0.028, around=8, cap_steps=1), 'rubber', (1, 1, 1))
        V.empty(name, (GRIP_X, gy, z), parent='gun')
    Gn.add(transform(bm_box(0.012, 0.035, 0.05, bev=0.008, segs=1), (0.832, gy, 0)), 'trim', RED)    # the trigger paddle
    # the bearing the barrels turn in
    Gn.add(lathe([(0.1, 0.0), (0.146, 0.008), (0.146, 0.044), (0.13, 0.058), (0.07, 0.058)], 20, 'x', (1.25, gy, 0)), 'trim', CHARCOAL)

    # ── barrels ──
    Br = V.part('barrels', pivot=HUB, parent='gun', ao='self')
    L = MUZZLE[0] - HUB[0]
    Br.add(lathe([(0.0, -0.02), (0.045, -0.02), (0.045, L - 0.07), (0.0, L - 0.055)], 10, 'x', HUB), 'metal')
    for k in range(6):
        a = 2 * PI * k / 6
        c = (HUB[0], HUB[1] + 0.098 * math.cos(a), 0.098 * math.sin(a))
        Br.add(lathe([(0.0, -0.01), (0.033, -0.01), (0.033, L - 0.005), (0.028, L), (0.021, L), (0.021, L - 0.06), (0.0, L - 0.06)], 8, 'x', c), 'metal')
    for x, w in ((0.05, 0.04), (0.3, 0.03), (L - 0.075, 0.04)):
        Br.add(lathe([(0.0, x - w / 2), (0.138, x - w / 2), (0.15, x - w / 2 + 0.01), (0.15, x + w / 2 - 0.01), (0.138, x + w / 2), (0.0, x + w / 2)], 18, 'x', HUB), 'chrome')
    Br.add(transform(bm_box(0.012, 0.008, 0.022, bev=0.004, segs=1), (HUB[0] + 0.3, HUB[1] + 0.152, 0)), 'trim', YELLOW)   # shows them turning
    V.empty('muzzle', MUZZLE, parent='barrels')

    # ── catapult: turntable, frame, winch, the gunner's step ──
    C = V.part('catapult', pivot=CATAPULT)
    cx, cy = CATAPULT[0], CATAPULT[1]
    # the arm's line: it runs just under the cup's rim, so it slopes down a little more than the line to the cup
    pc = Vector((CUP[0] - HINGE[0], CUP[1] - HINGE[1]))
    OFF = 0.04
    A0 = math.atan2(pc.y, pc.x) + math.asin(OFF / pc.length)
    S_CUP = math.sqrt(pc.length ** 2 - OFF ** 2)
    def arm_frame(rot=0.0):
        d = Vector((math.cos(A0 + rot), math.sin(A0 + rot)))
        return d, Vector((d.y, -d.x))                    # along the arm, and the side its cup opens to
    d0, n0 = arm_frame()
    S_END = S_CUP - 0.31
    def arm_h(s): return lerp(0.115, 0.075, clamp(s / S_END))
    def arm_w(s): return lerp(0.1, 0.07, clamp(s / S_END))
    # the padded crossbar that stops it
    d1, n1 = arm_frame(STOP)
    S_BAR, PAD_R, GAP = 0.6, 0.07, 0.004
    bar = Vector((HINGE[0], HINGE[1])) + d1 * S_BAR + n1 * (arm_h(S_BAR) / 2 + PAD_R + GAP)
    print(f'snowtank catapult: arm at {math.degrees(A0):.1f} deg cocked, {math.degrees(A0 + STOP):.1f} deg on the stop; crossbar at ({bar.x:.3f}, {bar.y:.3f})')

    # turntable: planks in an iron hoop
    R = 0.565
    edges = spaced(-R, R, 7)
    for i, (za, zb) in enumerate(zip(edges[:-1], edges[1:])):
        za, zb = za + 0.006, zb - 0.006
        def chord(z): return math.sqrt(max(1e-4, R * R - z * z))
        zs = spaced(za, zb, 4)
        o = [(cx + chord(z), z) for z in zs] + [(cx - chord(z), z) for z in zs[::-1]]
        bm = plate(o, cy - 0.07, cy, 'xz', bev=0.008, segs=1, max_len=0.3)
        C.add(grain(bm, (cx - 1, cy, (za + zb) / 2), (cx + 1, cy, (za + zb) / 2), i), 'wood', WOOD_B if i % 2 else WOOD_A, uv='keep')
    C.add(lathe([(R - 0.004, -0.062), (R + 0.012, -0.062), (R + 0.016, -0.056), (R + 0.016, -0.014), (R + 0.012, -0.008), (R - 0.004, -0.008)], 36, 'y', CATAPULT), 'metal')
    side_bolts(C, CATAPULT, R + 0.016, 12, cy - 0.035, mat='metal', size=0.016, a0=0.2)
    # frame: two sills, two cross beams, the uprights with their raking struts, a tie on each side that carries the axle
    ZF = 0.27
    X_UP, X_ST = cx + 0.36, cx - 0.4
    SILL_Y = cy + 0.05
    top = (bar.x, bar.y)
    for s in (-1, 1):
        z = s * ZF
        beam(C, (cx - 0.46, SILL_Y, z), (cx + 0.43, SILL_Y, z), 0.09, 0.1, k=0, tint=WOOD_A)
        up0, up1 = Vector((X_UP, cy + 0.09)), Vector((top[0], top[1] + 0.09))
        beam(C, (up0.x, up0.y, z), (up1.x, up1.y, z), 0.085, 0.1, k=1, tint=WOOD_B)
        st1 = up0.lerp(up1, 0.74)
        st0 = Vector((X_ST, cy + 0.09))
        beam(C, (st0.x, st0.y, z), (st1.x, st1.y, z), 0.08, 0.09, k=2, tint=WOOD_A)
        # the tie at the axle's height
        ku = (HINGE[1] - up0.y) / (up1.y - up0.y); ks = (HINGE[1] - st0.y) / (st1.y - st0.y)
        xa, xb = lerp(st0.x, st1.x, ks), lerp(up0.x, up1.x, ku)
        beam(C, (xa, HINGE[1], z), (xb, HINGE[1], z), 0.095, 0.13, k=3, tint=WOOD_B)
        # iron: bearing plates and the bolts through the joints
        pr = [(0.0, 0.0), (0.066, 0.0), (0.07, 0.006), (0.07, 0.014), (0.05, 0.02), (0.0, 0.02)]
        for f in (1, -1):
            C.add(lathe(pr if f > 0 else [(r_, -h_) for r_, h_ in pr][::-1], 12, 'z', (HINGE[0], HINGE[1], z + f * 0.0475)), 'metal')
        for p in (st0 + Vector((0.07, 0.07)), st1 - Vector((0.03, 0.035)), up0 + Vector((0.01, 0.1)), up1 - Vector((0.0, 0.1)), Vector((xa + 0.04, HINGE[1])), Vector((xb - 0.04, HINGE[1]))):
            C.add(bolt((p.x, p.y, z + s * 0.046), 'z' if s > 0 else '-z', r=0.017, h=0.012), 'metal')
        # rope lashing where the crossbar sits in the uprights
        for dy in (-0.075, 0.075):
            C.add(torus((top[0], top[1] + dy, z), 0.068, 0.014, 'y', segs=10, around=5), 'rope')
    for x in (cx - 0.4, cx + 0.37):
        beam(C, (x, SILL_Y, -ZF + 0.045), (x, SILL_Y, ZF - 0.045), 0.09, 0.09, k=1, tint=WOOD_C)
    # the crossbar and its pad
    C.add(gtube([(top[0], top[1], -ZF - 0.11), (top[0], top[1], ZF + 0.11)], 0.045, around=10, cap_steps=1), 'wood', WOOD_C)
    pad = lathe([(0.046, -0.2), (PAD_R - 0.004, -0.185), (PAD_R, -0.11), (PAD_R - 0.003, -0.07), (PAD_R, -0.03), (PAD_R, 0.03), (PAD_R - 0.003, 0.07), (PAD_R, 0.11), (PAD_R - 0.004, 0.185), (0.046, 0.2)], 14, 'z', (top[0], top[1], 0))
    C.add(pad, 'canvas', CANVAS)
    for zz in (-0.07, 0.07, -0.165, 0.165):
        C.add(torus((top[0], top[1], zz), PAD_R + 0.002, 0.011, 'z', segs=12, around=5), 'rope')
    C.add(kit.pipe([G(top[0] + 0.012, top[1] + PAD_R - 0.005, z) for z in spaced(-0.3, 0.12, 6)], 0.045, around=6, wobble=0.3, seed=2, squash=0.7), 'snow')
    # the axle, the twisted rope skeins either side of the arm, a ratchet wheel outside each tie
    C.add(gtube([(HINGE[0], HINGE[1], -ZF - 0.135), (HINGE[0], HINGE[1], ZF + 0.135)], 0.034, around=10, cap=False), 'metal')
    for s in (-1, 1):
        C.add(spring((HINGE[0], HINGE[1], s * 0.072), (HINGE[0], HINGE[1], s * (ZF - 0.062)), 0.07, turns=4, wire=0.021, around=5, per=9), 'rope')
        zr = s * (ZF + 0.1)
        pr = [(0.0, -0.02), (0.085, -0.02), (0.092, -0.012), (0.092, 0.012), (0.085, 0.02), (0.045, 0.02), (0.04, 0.034), (0.0, 0.036)]
        C.add(lathe(pr if s > 0 else [(q, -h) for q, h in pr][::-1], 12, 'z', (HINGE[0], HINGE[1], zr)), 'trim', STEEL)
        for k in range(9):
            tooth = transform(slat(0.02, 0.016, 0.014), (0.1, 0, 0), rot=(0, 0, -0.5))
            C.add(transform(tooth, (HINGE[0], HINGE[1], zr), rot=(0, 0, 2 * PI * k / 9)), 'trim', CHARCOAL)
    # the pawl lever, on the side away from the gunner
    C.add(gtube([(HINGE[0], HINGE[1], -ZF - 0.14), (HINGE[0] - 0.2, HINGE[1] + 0.22, -ZF - 0.14)], 0.015, around=6), 'metal')
    C.add(transform(bm_ico(0.04, 2), (HINGE[0] - 0.21, HINGE[1] + 0.235, -ZF - 0.14)), 'trim', RED)
    # the winch that draws the arm down: a drum of rope between two cheeks, a crank on the gunner's side
    wx, wy = cx - 0.4, SILL_Y + 0.17
    for s in (-1, 1):
        C.add(plate([(wx - 0.07, SILL_Y + 0.04), (wx + 0.07, SILL_Y + 0.04), (wx + 0.045, wy + 0.06), (wx - 0.045, wy + 0.06)], s * 0.19 - 0.012, s * 0.19 + 0.012, bev=0.008, segs=1), 'metal')
    C.add(lathe([(0.0, -0.172), (0.085, -0.172), (0.085, -0.145), (0.048, -0.14), (0.048, 0.14), (0.085, 0.145), (0.085, 0.172), (0.0, 0.172)], 12, 'z', (wx, wy, 0)), 'wood', WOOD_C)
    C.add(lathe([(0.05, -0.13)] + [(0.066 + 0.008 * (i % 2), -0.126 + i * 0.018) for i in range(15)] + [(0.05, 0.13)], 10, 'z', (wx, wy, 0)), 'rope')
    C.add(gtube([(wx, wy, 0.2), (wx, wy, ZF + 0.105), (wx - 0.09, wy + 0.1, ZF + 0.105), (wx - 0.09, wy + 0.1, ZF + 0.14)], 0.014, around=6, corner=0.02), 'metal')
    C.add(gtube([(wx - 0.09, wy + 0.1, ZF + 0.13), (wx - 0.09, wy + 0.1, ZF + 0.25)], 0.024, around=8, cap_steps=1), 'wood', WOOD_C)
    # the gunner's step: a chequer plate hung off the turntable's right side, with a rail in front to hold on to
    # (a penguin is 1.2 m across the flippers: a rail down the outside would run through it)
    sx0, sx1, sz1 = SEAT1[0] - 0.36, SEAT1[0] + 0.43, 1.19
    RS = R + 0.02               # its inner edge follows the turntable's hoop
    a0, a1 = math.acos((sx0 - cx) / RS), math.acos((sx1 - cx) / RS)
    o = [(cx + RS * math.cos(a), RS * math.sin(a)) for a in spaced(a0, a1, 8)]
    o += [(sx1 - 0.14 + 0.14 * math.cos(a), sz1 - 0.14 + 0.14 * math.sin(a)) for a in [i / 5 * PI / 2 for i in range(6)]]
    o += [(sx0 + 0.14 + 0.14 * math.cos(a), sz1 - 0.14 + 0.14 * math.sin(a)) for a in [PI / 2 + i / 5 * PI / 2 for i in range(6)]]
    C.add(plate(o, cy - 0.03, cy, 'xz', bev=0.008, segs=1, max_len=0.25), 'trim', CHARCOAL)
    for i in range(5):
        C.add(transform(slat(0.3, 0.004, 0.012), (SEAT1[0] + 0.02, cy, 0.62 + i * 0.115)), 'trim', STEEL)
    for a in spaced(a0 - 0.12, a1 + 0.12, 4):
        C.add(bolt((cx + (RS + 0.035) * math.cos(a), cy, (RS + 0.035) * math.sin(a)), 'y', r=0.018, h=0.01), 'chrome')
    xr = sx1 - 0.032
    C.add(gtube([(xr, cy - 0.01, 0.66), (xr, cy + 0.5, 0.66), (xr, cy + 0.5, sz1 - 0.04), (xr, cy - 0.01, sz1 - 0.04)], 0.02, around=8, corner=0.1, n=4, cap=False), 'chrome')
    C.add(gtube([(xr, cy + 0.27, 0.66), (xr, cy + 0.27, sz1 - 0.04)], 0.014, around=6, cap=False), 'chrome')
    for z in (0.66, sz1 - 0.04):
        C.add(lathe([(0.034, 0.0), (0.034, 0.012), (0.024, 0.02)], 8, 'y', (xr, cy, z)), 'trim', STEEL)
    V.empty('seat1', SEAT1, parent='catapult')

    # ── the arm ──
    Ar = V.part('arm', pivot=HINGE, parent='catapult')
    hp = Vector((HINGE[0], HINGE[1]))
    def on_arm(s, off=0.0, rot=0.0):
        d, n = arm_frame(rot)
        p = hp + d * s + n * off
        return (p.x, p.y)
    ss = [-0.15, -0.05, 0.12, 0.45, 0.8, 1.05, S_END]
    path = [on_arm(s) for s in ss]
    def sec(t):
        s = ss[int(round(t * (len(ss) - 1)))]
        return rsect(-arm_w(s) / 2, arm_w(s) / 2, -arm_h(s) / 2, arm_h(s) / 2, 0.014, 2)
    a_end, b_end = on_arm(ss[0]), on_arm(ss[-1])
    C_arm = sweep(path, sec, angle=50)
    Ar.add(grain(C_arm, (a_end[0], a_end[1], 0), (b_end[0], b_end[1], 0), 2), 'wood', WOOD_A, uv='keep')
    tilt = A0 - PI                 # the arm's own frame, as a rotation about z
    def on_arm_box(bm, s, off=0.0):
        p = on_arm(s, off)
        return transform(bm, (p[0], p[1], 0), rot=(0, 0, tilt))
    # iron: a collar at the hinge, straps along it, a shoe where it meets the pad
    Ar.add(lathe([(0.0, -0.062), (0.07, -0.062), (0.082, -0.05), (0.082, 0.05), (0.07, 0.062), (0.0, 0.062)], 14, 'z', HINGE), 'metal')
    for s in (0.36, 0.95):
        Ar.add(on_arm_box(bm_box(0.022, arm_h(s) / 2 + 0.007, arm_w(s) / 2 + 0.007, bev=0.005, segs=1), s), 'metal')
        for e in (-1, 1):
            p = on_arm(s)
            Ar.add(bolt((p[0], p[1], e * (arm_w(s) / 2 + 0.006)), 'z' if e > 0 else '-z', r=0.011, h=0.008), 'metal')
    Ar.add(on_arm_box(bm_box(0.1, 0.008, arm_w(S_BAR) / 2 + 0.004, bev=0.004, segs=1), S_BAR, arm_h(S_BAR) / 2 - 0.006), 'seat', LEATHER)
    # the cup: a turned wooden bowl in an iron hoop, strapped to the arm's end
    RO, RI = BALL + 0.036, BALL + 0.012
    bowl = [(0.0, -RO)] + [(RO * math.sin(a), -RO * math.cos(a)) for a in [i / 7 * PI / 2 for i in range(1, 8)]]
    bowl += [(RO + 0.004, 0.02), (RI + 0.004, 0.024)] + [(RI * math.sin(a), -RI * math.cos(a)) for a in [i / 6 * PI / 2 for i in range(6, 0, -1)]] + [(0.0, -RI)]
    Ar.add(transform(lathe(bowl, 20, 'y'), CUP, rot=(0, 0, tilt)), 'wood', WOOD_B)
    Ar.add(transform(lathe([(RO, -0.045), (RO + 0.014, -0.04), (RO + 0.016, 0.0), (RO + 0.012, 0.024), (RO, 0.026)], 20, 'y'), CUP, rot=(0, 0, tilt)), 'metal')
    cup = Vector((CUP[0], CUP[1]))
    strap = [cup + (-d0 * math.cos(a) - n0 * math.sin(a)) * (RO + 0.004) for a in [lerp(0.1, PI - 0.1, i / 10) for i in range(11)]]
    Ar.add(tube([G(p.x, p.y, 0) for p in strap], 0.008, around=6, squash=4.2, cap_steps=1), 'metal')
    for a in (0.42, PI - 0.42):
        p = cup + (-d0 * math.cos(a) - n0 * math.sin(a)) * (RO + 0.014)
        Ar.add(transform(bm_ico(0.014, 1), (p.x, p.y, 0)), 'metal')
    Ar.add(on_arm_box(bm_box(0.05, arm_h(S_END) / 2 + 0.008, arm_w(S_END) / 2 + 0.008, bev=0.006, segs=1), S_END - 0.04), 'metal')
    V.empty('bucket', CUP, parent='arm')
    Am = V.part('ammo', pivot=CUP, parent='arm')
    Am.add(transform(snowball(BALL, seed=7, sub=3, rough=0.03), (CUP[0] + n0.x * 0.012, CUP[1] + n0.y * 0.012, 0)), 'snow')

    return V, dict(target=(-0.15, 1.1, 0), dist=10.6, yaw=38, pitch=13)


# ───────────────────────── review ─────────────────────────
def game_rot(node, x=0.0, y=0.0, z=0.0):
    """Turn a node as the game would (rotation.x/y/z in GAME terms)."""
    node.rotation_mode = 'XYZ'
    node.rotation_euler = (x, -z, y)


def world_bvh(objs):
    verts, polys = [], []
    for ob in objs:
        base = len(verts)
        verts.extend([ob.matrix_world @ v.co for v in ob.data.vertices])
        polys.extend([[base + i for i in p.vertices] for p in ob.data.polygons])
    return BVHTree.FromPolygons(verts, polys), verts, polys


def meshes_of(V, names):
    return [ob for ob in V.meshes if ob.parent and ob.parent.name in names]


def check(V):
    """Swing the arm from cocked to the stop, turn the catapult and the turret right round, and report what touches."""
    N = V.nodes
    hinge, gun = G(*HINGE), G(*GUN)
    def tree(names): return world_bvh(meshes_of(V, names))
    def hits(a, b, skip=None):
        ta, va, pa = a
        out = []
        for i, j in ta.overlap(b[0]):
            c = sum((va[k] for k in pa[i]), Vector()) / len(pa[i])
            if not (skip and skip(c)): out.append(c)
        return out
    def near_hinge(c): return math.hypot(c.x - hinge.x, c.z - hinge.z) < 0.2     # the collar on its axle, between the skeins
    def near_gun(c): return (c - gun).length < 0.23                               # the cradle between its cheeks
    def where(h): return ('at ' + str(tuple(round(v, 2) for v in (h[0].x, h[0].z, -h[0].y)))) if h else ''
    def spans(bad):
        """[(angle, faces, where)] every 5 degrees -> 'a..b (most faces, where)' for each run of angles"""
        out, run = [], []
        for b in bad + [None]:
            if run and (b is None or b[0] != run[-1][0] + 5):
                worst = max(run, key=lambda r: r[1])
                out.append(f'{run[0][0]}..{run[-1][0]} deg ({worst[1]} faces, {worst[2]})'); run = []
            if b: run.append(b)
        return '; '.join(out) or 'no angle'
    hull = tree(('body', 'trackL', 'trackR'))
    print('arm swing (rotation.z: faces touching the catapult / the hull / the gun):')
    cat, guns = tree(('catapult',)), tree(('turret', 'gun', 'barrels'))
    for k in range(40):
        rz = STOP * k / 39
        game_rot(N['arm'], z=rz); bpy.context.view_layer.update()
        arm = tree(('arm', 'ammo'))
        a, b, g = hits(arm, cat, near_hinge), hits(arm, hull), hits(arm, guns)
        if a or b or g or k in (0, 39): print(f'   {rz:6.3f}: {len(a)} / {len(b)} / {len(g)}', where(a or b or g))
    for rz in (STOP - 0.01, STOP - 0.03, STOP - 0.06):
        game_rot(N['arm'], z=rz); bpy.context.view_layer.update()
        print(f'   {rz:6.3f} (past the stop): {len(hits(tree(("arm",)), cat, near_hinge))}')
    for rz, label in ((0.0, 'cocked'), (STOP, 'thrown')):
        game_rot(N['arm'], z=rz)
        bad = []
        for k in range(72):
            game_rot(N['catapult'], y=2 * PI * k / 72); bpy.context.view_layer.update()
            c = tree(('catapult', 'arm', 'ammo'))
            h = hits(c, hull) + hits(c, guns)
            if h: bad.append((k * 5, len(h), where(h)))
        print(f'catapult turned right round, arm {label}: touches the hull or the gun at', spans(bad))
    game_rot(N['arm']); game_rot(N['catapult']); bpy.context.view_layer.update()
    rest = tree(('body', 'turret', 'catapult', 'arm', 'ammo'))
    for pitch in (-0.25, -0.15, 0.0, 0.3, 0.6):
        bad = []
        for k in range(72):
            game_rot(N['turret'], y=2 * PI * k / 72); game_rot(N['gun'], z=pitch); bpy.context.view_layer.update()
            rest = tree(('body', 'turret', 'catapult', 'arm', 'ammo'))
            h = hits(tree(('gun', 'barrels')), rest, near_gun)
            if h: bad.append((k * 5, len(h), where(h)))
        print(f'turret turned right round, gun pitched {pitch:+.2f}: touches at', spans(bad))
    game_rot(N['turret']); game_rot(N['gun']); bpy.context.view_layer.update()


def add_riders(V):
    """Review only: stand a penguin on each seat (feet on the empty, facing the way its node faces)."""
    for name in ('seat0', 'seat1'):
        node = V.nodes[name]
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(kit.ROOT, 'src', 'assets', 'models', 'penguin.glb'))
        for o in [o for o in bpy.data.objects if o not in before]:
            if o.name.startswith('PenguinLOD') or o.name.startswith('Icosphere'): bpy.data.objects.remove(o); continue
            if o.type == 'ARMATURE':
                o.location = node.matrix_world.translation
                o.rotation_mode = 'XYZ'
                o.rotation_euler = (0, 0, -PI / 2 + node.matrix_world.to_euler('XYZ').z)   # the penguin faces Blender +y


MY_VIEWS = dict(VIEWS)
MY_VIEWS.update({
    'frontal': dict(yaw=8, pitch=9),
    'gun': dict(yaw=52, pitch=16, target=(0.95, 1.4, 0), dist=5.2),
    'cat': dict(yaw=128, pitch=16, target=(-1.0, 1.6, 0), dist=6.2),
    'catrear': dict(yaw=205, pitch=20, target=(-1.0, 1.6, 0), dist=6.2),
    'cockpit': dict(yaw=20, pitch=38, target=(0.4, 1.2, 0), dist=5.2),
    'under': dict(yaw=60, pitch=2, target=(0, 0.6, 0), dist=8),
})


def arg(name, default=None, cast=float):
    for a in sys.argv:
        if a.startswith(f'--{name}='): return cast(a.split('=')[1])
    return default


def main():
    do_render = '--render' in sys.argv
    views = arg('views', 'front,rear', str).split(',')
    kit.reset(); kit._mats.clear()
    V, view = build_snowtank()
    V.build()
    if '--noexport' not in sys.argv: export(V)
    for e in V.nodes.values():
        p = e.matrix_world.translation
        print(f'   {e.name:10s} {"<" + e.parent.name + ">" if e.parent else "":11s} ({p.x:.3f}, {p.z:.3f}, {-p.y:.3f})' + (f'  radius {e["radius"]}' if 'radius' in e else ''))
    if '--check' in sys.argv: check(V)
    if not do_render: return
    os.makedirs(RENDERS, exist_ok=True)
    # render-only poses, in GAME terms
    arm, cat_yaw, tur_yaw, pitch, spin = arg('arm', 0.0), arg('catapult', 0.0), arg('turret', 0.0), arg('pitch', 0.0), arg('spin', 0.0)
    N = V.nodes
    game_rot(N['arm'], z=arm); game_rot(N['catapult'], y=cat_yaw); game_rot(N['turret'], y=tur_yaw); game_rot(N['gun'], z=pitch); game_rot(N['barrels'], x=spin)
    if '--noammo' in sys.argv:
        for ob in meshes_of(V, ('ammo',)): ob.hide_render = True
    bpy.context.view_layer.update()
    tag = arg('tag', '', str) or (('-thrown' if arm else '') + ('-riders' if '--riders' in sys.argv else ''))
    if '--riders' in sys.argv: add_riders(V)
    teams = [a.split('=')[1] for a in sys.argv if a.startswith('--team=')] or ['blue']
    for team in teams:
        for n in kit.material('paint').node_tree.nodes:
            if n.type == 'MIX' and n.blend_type == 'MULTIPLY': n.inputs[6].default_value = (*TEAMS[team], 1)
        for v in views:
            o = {**view, **MY_VIEWS.get(v, {})}
            if v == 'hero': o['dist'] *= 1.24                      # the longer lens stands further back
            if arm and 'target' not in MY_VIEWS.get(v, {}): o['target'] = (o['target'][0], o['target'][1] + 0.45, o['target'][2]); o['dist'] *= 1.18
            if arg('dist'): o['dist'] = arg('dist')
            if arg('sun') is not None: o['sun_yaw'] = arg('sun')
            if arg('samples'): o['samples'] = int(arg('samples'))
            size = arg('size', None, str)
            if size: o['size'] = tuple(int(q) for q in size.split('x'))
            kit.render(os.path.join(RENDERS, f'snowtank-{team}-{v}{tag}.png'), **o)


if __name__ == '__main__':
    main()
