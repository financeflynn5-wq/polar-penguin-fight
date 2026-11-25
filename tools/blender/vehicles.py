"""Builds the vehicles in Blender and writes them to public/models as .glb.

Run (Blender's Python, e.g. a venv with the `bpy` module):
    python tools/blender/vehicles.py                      # build and export both
    python tools/blender/vehicles.py snowplow             # only this one
    python tools/blender/vehicles.py --render snowmobile  # also write review renders to tools/blender/renders/
    python tools/blender/vehicles.py --render --riders    # ...with penguins on the seats (never exported)

Unlike the map props, a vehicle has moving parts, so its GLB keeps a node hierarchy. Every moving part is an empty
placed AT ITS PIVOT, unrotated and unscaled, with one child mesh per material (named `mesh_<part>_<material>`):

    body                     everything that does not move
    steer, skiL, skiR        snowmobile: handlebars (turn about y), each ski with its spindle (turn about y)
    blade                    snowplow: blade and push arms, hinged on the chassis (rotation.z > 0 lifts it)
    track / trackL, trackR   the rubber belts, material `tread`: u across the belt, v along it (1 unit = 1 m);
                             adding to the texture's offset.y in the game runs the belt as when driving forward
    wheel…                   anything that spins about its local z (the axle); custom property `radius` in metres
    beacon                   the roof beacon's lens
    seat0, seat1, gripL, gripR, exhaust   bare empties: where a rider's feet go (on the seat), where mittens hold
                             the bars (children of `steer`), where smoke puffs

Everything is written in GAME coordinates (x forward, y up, z to the vehicle's right, metres, origin on the snow
under the centre); see kit.py. src/render/VehicleModel.ts loads the result. Sizes are what the game collides with
(src/sim/Vehicles.ts): change one, change the other.
"""
import sys, os, math, json, struct, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
from mathutils.geometry import tessellate_polygon
import kit
from kit import G, Asset, tube, arc, transform, bm_box, bm_cyl, bm_ico, bevel, shade, refine, displace

RENDERS = os.path.join(os.path.dirname(__file__), 'renders')
PI = math.pi

# vertex tints (linear). `paint` is multiplied by the team colour in the game, so it stays a light neutral grey.
PAINT = (0.9, 0.9, 0.9)
PAINT_DARK = (0.42, 0.42, 0.42)       # a deeper shade of the team colour, for two-tone panels
CHARCOAL = (0.045, 0.05, 0.06)
BLACK = (0.016, 0.017, 0.02)
IVORY = (0.84, 0.82, 0.76)
STEEL = (0.42, 0.44, 0.47)
YELLOW = (0.95, 0.55, 0.03)
RED = (0.7, 0.05, 0.04)
LEATHER = (0.2, 0.095, 0.045)
WOOD = (0.36, 0.2, 0.09)
PIPING = (0.72, 0.7, 0.64)
TEXTURED = {'tread', 'snow', 'wood', 'canvas'}   # every other material is untextured: its UVs are dropped from the GLB


# ───────────────────────── small maths ─────────────────────────
def lerp(a, b, t): return a + (b - a) * t
def clamp(x, a=0.0, b=1.0): return max(a, min(b, x))
def smooth(a, b, x):
    t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t)


def curve(*knots):
    """A smooth function through (x, value) knots (cubic Hermite with Catmull-Rom tangents, flat past the ends)."""
    xs = [k[0] for k in knots]; ys = [k[1] for k in knots]
    n = len(xs)
    ms = []
    for i in range(n):
        if i == 0: ms.append((ys[1] - ys[0]) / (xs[1] - xs[0]))
        elif i == n - 1: ms.append((ys[-1] - ys[-2]) / (xs[-1] - xs[-2]))
        else: ms.append((ys[i + 1] - ys[i - 1]) / (xs[i + 1] - xs[i - 1]))
    def f(x):
        if x <= xs[0]: return ys[0]
        if x >= xs[-1]: return ys[-1]
        i = max(k for k in range(n - 1) if xs[k] <= x)
        h = xs[i + 1] - xs[i]; t = (x - xs[i]) / h
        t2, t3 = t * t, t * t * t
        return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * ms[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * ms[i + 1]
    return f


def spaced(a, b, n, ease=0.0):
    """n+1 values from a to b; ease > 0 crowds them toward both ends (where a rounded nose needs them)."""
    out = []
    for i in range(n + 1):
        t = i / n
        if ease: t = lerp(t, 0.5 - 0.5 * math.cos(PI * t), ease)
        out.append(lerp(a, b, t))
    return out


def rounded(pts, r, n=4):
    """Round the corners of a polyline of game points with radius-ish r."""
    pts = [Vector(p) for p in pts]
    if r <= 0 or len(pts) < 3: return pts
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        p, a, b = pts[i], pts[i - 1], pts[i + 1]
        da, db = (a - p), (b - p)
        k = min(r, da.length * 0.45, db.length * 0.45)
        pa, pb = p + da.normalized() * k, p + db.normalized() * k
        for j in range(n + 1):
            t = j / n
            out.append(pa * (1 - t) ** 2 + p * 2 * t * (1 - t) + pb * t * t)
    out.append(pts[-1])
    return out


# ───────────────────────── builders ─────────────────────────
def gtube(pts, r, around=10, corner=0.0, cap=True, n=4, cap_steps=2):
    """A round bar through GAME points, its corners rounded."""
    return tube([G(*p) for p in rounded(pts, corner, n)], r, around=around, cap=cap, cap_steps=cap_steps)


def loft(rings, cap0=True, cap1=True, closed=True, angle=40):
    """Skin a row of rings (equal-length lists of Blender points)."""
    bm = bmesh.new()
    vs = [[bm.verts.new(p) for p in r] for r in rings]
    n = len(rings[0])
    for i in range(len(rings) - 1):
        for k in range(n if closed else n - 1):
            k2 = (k + 1) % n
            try: bm.faces.new((vs[i][k], vs[i][k2], vs[i + 1][k2], vs[i + 1][k]))
            except ValueError: pass
    if cap0 and closed: bm.faces.new(vs[0][::-1])
    if cap1 and closed: bm.faces.new(vs[-1])
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    shade(bm, angle)
    return bm


def sect(x, y0, y1, w, e=2.6, n=32, wt=1.0, z0=0.0, eb=None):
    """A ring in the plane x = const (GAME): a superellipse from y0 up to y1, half-width w. wt scales the width at
    the top against the bottom (a body that leans in). eb = a different exponent for the lower half."""
    pts = []
    for k in range(n):
        a = 2 * PI * (k + 0.5) / n
        c, s = math.cos(a), math.sin(a)
        ee = eb if (eb and s < 0) else e
        zz = math.copysign(abs(c) ** (2 / ee), c); yy = math.copysign(abs(s) ** (2 / ee), s)
        t = (yy + 1) / 2
        pts.append(G(x, lerp(y0, y1, t), z0 + zz * w * lerp(1.0, wt, t)))
    return pts


def plan(y, x0, x1, hw, r, n=6, z0=0.0, e=None):
    """A ring in the plane y = const (GAME): a rectangle x0..x1 by ±hw with corners of radius r."""
    r = min(r, (x1 - x0) / 2 - 1e-4, hw - 1e-4)
    pts = []
    for cx, cz, a0 in ((x1 - r, hw - r, 0), (x0 + r, hw - r, PI / 2), (x0 + r, -hw + r, PI), (x1 - r, -hw + r, 1.5 * PI)):
        for i in range(n + 1):
            a = a0 + i / n * PI / 2
            pts.append(G(cx + math.cos(a) * r, y, z0 + cz + math.sin(a) * r))
    return pts


def rbox(x0, x1, y0, y1, hw, r=0.1, edge=0.03, z0=0.0, n=6, taper=0.0, lean=0.0, steps=3):
    """A box whose plan is a rounded rectangle and whose top and bottom edges are rounded over by `edge`.
    taper pulls the top in on every side, lean slides the top along x."""
    rings = []
    def ring(y, inset):
        t = (y - y0) / (y1 - y0)
        k = inset + taper * t
        return plan(y, x0 + k + lean * t, x1 - k + lean * t, hw - k, max(0.004, r - k), n, z0)
    for i in range(steps + 1):
        a = i / steps * PI / 2
        rings.append(ring(y0 + edge * (1 - math.cos(a)) if i else y0, edge * (1 - math.sin(a))))
    for i in range(steps + 1):
        a = (1 - i / steps) * PI / 2
        rings.append(ring(y1 - edge * (1 - math.cos(a)) if i < steps else y1, edge * (1 - math.sin(a))))
    return loft(rings, angle=50)


def lathe(profile, segs=24, axis='y', at=(0, 0, 0), angle=40):
    """Turn a profile [(radius, height), …] about an axis through `at` (GAME): 'y' upright, 'z' an axle across the
    vehicle (heights run toward +z), 'x' pointing forward (heights run toward +x). Radius 0 closes an end."""
    bm = bmesh.new()
    rings = []
    for r, h in profile:
        if r <= 1e-6: rings.append([bm.verts.new((0, 0, h))])
        else: rings.append([bm.verts.new((math.cos(2 * PI * k / segs) * r, math.sin(2 * PI * k / segs) * r, h)) for k in range(segs)])
    for a, b in zip(rings[:-1], rings[1:]):
        for k in range(segs):
            k2 = (k + 1) % segs
            if len(a) == 1 and len(b) == 1: continue
            if len(a) == 1: bm.faces.new((a[0], b[k], b[k2]))
            elif len(b) == 1: bm.faces.new((a[k], a[k2], b[0]))
            else: bm.faces.new((a[k], a[k2], b[k2], b[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    shade(bm, angle)
    rot = {'y': (0, 0, 0), 'z': (PI / 2, 0, 0), 'x': (0, 0, -PI / 2)}[axis]
    return transform(bm, at, rot=rot)


def remap(bm, fn):
    """Move every vertex through fn(Vector) -> Vector, then put the normals right (fn may mirror)."""
    for v in bm.verts: v.co = fn(v.co)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return bm


def plate(outline, a, b, plane='xy', holes=(), bev=0.012, segs=2, max_len=0.3, angle=40):
    """A flat plate cut from sheet: `outline` in the named GAME plane ('xy' a side view, 'xz' a plan view, 'zy' seen
    from the front), reaching from a to b along the third axis."""
    bm = kit.slab(outline, holes, thickness=abs(b - a), bev=min(bev, abs(b - a) * 0.45), segs=segs, max_len=max_len, wobble=0)
    m = (a + b) / 2
    if plane == 'xy': remap(bm, lambda c: G(c.x, c.z, m + c.y))
    elif plane == 'xz': remap(bm, lambda c: G(c.x, m + c.y, c.z))
    else: remap(bm, lambda c: G(m + c.y, c.z, c.x))
    shade(bm, angle)
    return bm


def sheet(outline, holes, fn, cuts_u=(), cuts_v=(), thickness=0.0, max_len=0.22, inside=None, angle=45):
    """A curved panel with openings. The panel is drawn flat in (u, v), `holes` are cut out of it, it is sliced along
    the given u and v lines (so it can bend there) and then every point is carried to fn(u, v) (Blender space).
    thickness > 0 gives it a back face and rims round the openings, growing toward `inside` (a Blender point)."""
    loops = [list(outline)] + [list(h) for h in holes]
    flat = [[Vector((u, v, 0)) for u, v in lp] for lp in loops]
    tris = tessellate_polygon(flat)
    pts = [p for lp in loops for p in lp]
    bm = bmesh.new()
    vs = [bm.verts.new((u, v, 0)) for u, v in pts]
    for a, b, c in tris:
        try: bm.faces.new((vs[a], vs[b], vs[c]))
        except ValueError: pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    for co, no, cuts in (((1, 0, 0), (1, 0, 0), cuts_u), ((0, 1, 0), (0, 1, 0), cuts_v)):
        for c in cuts:
            geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
            bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=Vector(co) * c, plane_no=Vector(no))
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    for _ in range(3):
        long = [e for e in bm.edges if e.calc_length() > max_len]
        if not long: break
        bmesh.ops.subdivide_edges(bm, edges=long, cuts=1)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    for v in bm.verts: v.co = fn(v.co.x, v.co.y)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    if inside is not None:
        bm.normal_update()
        ins = Vector(inside)
        toward = sum(1 if f.normal.dot(ins - f.calc_center_median()) > 0 else -1 for f in bm.faces)
        if toward > 0: bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    if thickness:
        bm.normal_update()
        bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=thickness)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    shade(bm, angle)
    return bm


def grid(fn, nu, nv, thickness=0.0, inside=None, angle=45, close_u=False):
    """A curved panel with no openings: fn(s, t) for s, t in 0..1 (Blender points), nu by nv quads."""
    bm = bmesh.new()
    vs = [[bm.verts.new(fn(i / nu, j / nv)) for j in range(nv + 1)] for i in range(nu + (0 if close_u else 1))]
    m = len(vs)
    for i in range(nu):
        for j in range(nv):
            i2 = (i + 1) % m
            bm.faces.new((vs[i][j], vs[i2][j], vs[i2][j + 1], vs[i][j + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    if inside is not None:
        bm.normal_update()
        ins = Vector(inside)
        toward = sum(1 if f.normal.dot(ins - f.calc_center_median()) > 0 else -1 for f in bm.faces)
        if toward > 0: bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    if thickness:
        bm.normal_update()
        bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=thickness)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    shade(bm, angle)
    return bm


def bolt(at, axis='y', r=0.016, h=0.012, sides=6):
    """A bolt head at a GAME point, standing along +/-axis ('x', '-x', 'y', 'z', '-z' …)."""
    bm = bm_cyl(r, h, sides, bev=0)
    rot = {'y': (0, 0, 0), '-y': (PI, 0, 0), 'z': (PI / 2, 0, 0), '-z': (-PI / 2, 0, 0), 'x': (0, 0, -PI / 2), '-x': (0, 0, PI / 2)}[axis]
    return transform(bm, at, rot=rot)


def spring(a, b, r, turns=6, wire=0.011, around=5, per=10):
    """A coil spring between two GAME points."""
    a, b = Vector(a), Vector(b)
    ax = (b - a)
    u = ax.normalized().orthogonal().normalized(); w = ax.normalized().cross(u)
    n = int(turns * per)
    pts = [a + ax * (i / n) + (u * math.cos(2 * PI * turns * i / n) + w * math.sin(2 * PI * turns * i / n)) * r for i in range(n + 1)]
    return tube([G(*p) for p in pts], wire, around=around, cap_steps=1)


def ram(A, a, b, barrel=0.05, rod=0.026, split=0.58, mat_barrel='trim', tint=CHARCOAL):
    """A hydraulic ram from GAME point a (the barrel end) to b (the rod end): barrel, gland, bright rod, eyes."""
    a, b = Vector(a), Vector(b)
    m = a.lerp(b, split)
    A.add(tube([G(*a), G(*m)], barrel, around=12, cap_steps=2), mat_barrel, tint)
    A.add(tube([G(*m.lerp(a, 0.06)), G(*m.lerp(b, 0.02))], barrel * 1.16, around=12, cap_steps=1), 'trim', STEEL)
    A.add(tube([G(*m), G(*b)], rod, around=10, cap_steps=1), 'chrome')
    for p in (a, b):
        A.add(transform(bm_cyl(barrel * 1.1, barrel * 1.5, 12, bev=0.006), tuple(p), rot=(PI / 2, 0, 0)), 'trim', STEEL)


def wheel(A, c, r, w, mat='trim', tyre=BLACK, hub=STEEL, cap=YELLOW, marks=5, segs=24, rim=0.66, faces=(-1, 1)):
    """A rubber-tyred road wheel on an axle along z, centred on GAME point c. `faces`: which sides (-1 = toward -z,
    1 = toward +z) get a dished rim with dark slots in it, which show the wheel turning; the others are closed flat."""
    ri = r * rim
    b = min(w * 0.3, r * 0.16)
    round_ = max(segs, int(segs * 1.45))     # the tyre's outline is what shows, so it gets the segments
    A.add(lathe([(ri, -w / 2 + b), (r - b, -w / 2), (r - b * 0.25, -w / 2 + b * 0.25), (r, -w / 2 + b), (r, w / 2 - b), (r - b * 0.25, w / 2 - b * 0.25), (r - b, w / 2), (ri, w / 2 - b)], round_, 'z', c, angle=50), mat, tyre)
    d = w / 2 - b
    for s in (-1, 1):
        if s in faces:
            prof = [(ri, d), (ri * 0.93, d + 0.006), (ri * 0.85, d - 0.012), (ri * 0.36, d - 0.004), (ri * 0.27, d + 0.012)]
            ch = min(0.026, ri * 0.22)
            capp = [(ri * 0.27, d + 0.012), (ri * 0.22, d + 0.012 + ch * 0.7), (ri * 0.12, d + 0.012 + ch * 0.96), (0, d + 0.012 + ch)]
        else:
            prof, capp = [(ri, d), (0, d)], None
        for pr, tint, sg in ((prof, hub, segs), (capp, cap, 12)):
            if not pr: continue
            if s < 0: pr = [(q, -h) for q, h in pr][::-1]
            A.add(lathe(pr, sg, 'z', c), mat, tint)
        if s in faces:
            for k in range(marks):
                a = 2 * PI * (k + 0.5) / marks
                bm = bmesh.new()
                vs = [bm.verts.new(G(c[0] + math.cos(a) * ri * 0.6 + math.cos(q) * ri * 0.15, c[1] + math.sin(a) * ri * 0.6 + math.sin(q) * ri * 0.15, c[2] + s * (d - 0.006)))
                      for q in [2 * PI * i / 8 for i in range(8)]]
                bm.faces.new(vs if s < 0 else vs[::-1])
                A.add(bm, mat, BLACK)


def sprocket(A, c, r, w, teeth=10, mat='trim', body=STEEL, cap=YELLOW, segs=20, faces=(-1, 1)):
    """A drive sprocket on an axle along z: two toothed discs on a drum."""
    drum = [(0, -w / 2), (r * 0.34, -w / 2), (r * 0.6, -w / 2 + 0.02), (r * 0.6, w / 2 - 0.02), (r * 0.34, w / 2), (0, w / 2)]
    A.add(lathe(drum, segs, 'z', c), mat, body)
    for s in (-1, 1):
        zc = c[2] + s * w * 0.36
        A.add(lathe([(r * 0.55, -0.016), (r * 0.84, -0.016), (r * 0.84, 0.016), (r * 0.55, 0.016)], segs, 'z', (c[0], c[1], zc)), mat, CHARCOAL)
        for k in range(teeth):
            a = 2 * PI * k / teeth
            t = bm_box(r * 0.11, r * 0.085, 0.016, bev=0.0)
            for v in t.verts:
                if v.co.x > 0: v.co.z *= 0.55      # the teeth narrow toward their tips
            transform(t, (r * 0.92, 0, 0)); transform(t, (c[0], c[1], zc), rot=(0, 0, a))
            A.add(t, mat, CHARCOAL)
        if s in faces:
            ch = min(0.04, r * 0.16)
            pr = [(r * 0.3, w / 2), (r * 0.24, w / 2 + ch * 0.7), (r * 0.12, w / 2 + ch * 0.96), (0, w / 2 + ch)]
            if s < 0: pr = [(q, -h) for q, h in pr][::-1]
            A.add(lathe(pr, 12, 'z', c), mat, cap)


def sweep(path, section, cap=True, angle=40, flip=False, closed=True):
    """Carry a section along a path drawn in the GAME x-y plane (a side view). `section` is a closed loop [(z, h), …]
    or a function of t (0..1 along the path) returning one: z across the vehicle, h out along the path's normal, which
    is the left-hand side of the direction of travel (up, for a path that runs forward); flip = the other side."""
    n = len(path)
    rings = []
    for i, (x, y) in enumerate(path):
        a, b = path[max(0, i - 1)], path[min(n - 1, i + 1)]
        tx, ty = b[0] - a[0], b[1] - a[1]
        L = math.hypot(tx, ty) or 1.0
        nx, ny = -ty / L, tx / L
        if flip: nx, ny = -nx, -ny
        sec = section(i / (n - 1)) if callable(section) else section
        rings.append([G(x + nx * h, y + ny * h, z) for z, h in sec])
    return loft(rings, cap0=cap, cap1=cap, closed=closed, angle=angle)


def rsect(z0, z1, h0, h1, r, n=3):
    """A rounded rectangle as a section for sweep(): [(z, h), …]."""
    return [(z, h) for z, h in kit.rounded_rect(z0, h0, z1, h1, min(r, (z1 - z0) / 2 - 1e-4, (h1 - h0) / 2 - 1e-4), n)]


def lamp(A, c, r, lens='glow', ring='chrome', rot=(0, 0, 0), bowl=None, bowl_tint=(1, 1, 1), depth=None, segs=22, dome=0.5):
    """A round lamp looking along +x at GAME point c (rot = kit.transform's rot: (x, y, z), so (0, PI, 0) looks
    backward and (0, 0, 0.2) looks up a little): a bright bezel, a domed lens and, with bowl = a material, a
    teardrop shell behind it."""
    depth = depth if depth is not None else r * 2.2
    t = r * 0.16
    A.add(transform(lathe([(r * 0.86, -t * 0.4), (r, -t), (r + t, -t * 0.2), (r + t * 0.9, t * 0.6), (r + t * 0.2, t * 1.2), (r * 0.88, t * 0.9)], segs, 'x'), c, rot=rot), ring)
    A.add(transform(lathe([(r * 0.9, t * 0.3), (r * 0.8, t * 0.3 + r * dome * 0.55), (r * 0.5, t * 0.3 + r * dome * 0.9), (0, t * 0.3 + r * dome)], segs, 'x'), c, rot=rot), lens)
    if bowl:
        pr = [(0, -depth), (r * 0.3, -depth * 0.93), (r * 0.62, -depth * 0.72), (r * 0.88, -depth * 0.42), (r * 1.02, -depth * 0.16), (r * 1.04, -t)]
        A.add(transform(lathe(pr, segs, 'x'), c, rot=rot), bowl, bowl_tint)


# ───────────────────────── tracks ─────────────────────────
def belt_path(circles, step=0.05, straight=0.2):
    """The line a belt takes round pulleys [(x, y, r), …] listed counter-clockwise in the GAME x-y plane (looking from
    +z with x to the right). Returns [(x, y, nx, ny, s)] with the outward normal and the distance along, plus the
    total length. The loop is closed; its first point is not repeated."""
    n = len(circles)
    ang = []
    for i in range(n):
        x1, y1, r1 = circles[i]; x2, y2, r2 = circles[(i + 1) % n]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy)
        ang.append(math.atan2(dy, dx) - math.acos((r1 - r2) / L))
    out, s = [], 0.0
    def push(x, y, nx, ny):
        nonlocal s
        if out: s += math.hypot(x - out[-1][0], y - out[-1][1])
        out.append((x, y, nx, ny, s))
    for i in range(n):
        x, y, r = circles[i]
        a0, a1 = ang[i - 1], ang[i]
        while a1 < a0 - 1e-9: a1 += 2 * PI
        while a1 - a0 > 2 * PI: a1 -= 2 * PI
        k = max(1, int(math.ceil((a1 - a0) * r / step)))
        for j in range(k + 1):
            a = lerp(a0, a1, j / k)
            push(x + math.cos(a) * r, y + math.sin(a) * r, math.cos(a), math.sin(a))
        x2, y2, r2 = circles[(i + 1) % n]
        px, py = x + math.cos(a1) * r, y + math.sin(a1) * r
        qx, qy = x2 + math.cos(a1) * r2, y2 + math.sin(a1) * r2
        m = max(1, int(math.ceil(math.hypot(qx - px, qy - py) / straight)))
        for j in range(1, m):
            push(lerp(px, qx, j / m), lerp(py, qy, j / m), math.cos(a1), math.sin(a1))
    total = s + math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1])
    return out, total


LUGS = 6  # lugs per metre in the tread texture (tools/blender/textures.py)


def belt(circles, width, thick, zc, edge=0.012, cols=4):
    """A rubber track round the pulleys (see belt_path), `width` across z about zc, `thick` deep.
    UVs: u 0..1 across the belt, v along it in metres, stretched by under a lug's pitch so the pattern meets itself
    where the loop closes. v falls along the path here, which (the glTF exporter turns v over) makes it RISE toward
    the front along the bottom run in the game: adding to the texture's offset.y there carries the pattern backward
    under the vehicle, as when it drives forward. Returns (bmesh, length, v_scale)."""
    mid = [(x, y, r + thick / 2) for x, y, r in circles]
    path, total = belt_path(mid)
    vscale = max(1, round(total * LUGS)) / LUGS / total
    h = thick / 2
    # the section, going round: outer face left to right, right edge, inner face right to left, left edge
    sec = []   # (z offset, out offset, u)
    for i in range(cols + 1):
        z = lerp(-width / 2 + edge, width / 2 - edge, i / cols); sec.append((z, h, (z + width / 2) / width))
    sec += [(width / 2, h - edge, 1.0), (width / 2, -h + edge, 1.0)]
    for i in range(cols + 1):
        z = lerp(width / 2 - edge, -width / 2 + edge, i / cols); sec.append((z, -h, (z + width / 2) / width))
    sec += [(-width / 2, -h + edge, 0.0), (-width / 2, h - edge, 0.0)]
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    rings = [[bm.verts.new(G(x + nx * o, y + ny * o, zc + z)) for z, o, u in sec] for x, y, nx, ny, s in path]
    m, k = len(rings), len(sec)
    for i in range(m):
        i2 = (i + 1) % m
        v0 = -path[i][4] * vscale
        v1 = -(path[i2][4] if i2 else total) * vscale
        for j in range(k):
            j2 = (j + 1) % k
            f = bm.faces.new((rings[i][j], rings[i][j2], rings[i2][j2], rings[i2][j]))
            for l, (uu, vv) in zip(f.loops, ((sec[j][2], v0), (sec[j2][2], v0), (sec[j2][2], v1), (sec[j][2], v1))):
                l[uv].uv = (uu, vv)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    shade(bm, 35)
    return bm, total, vscale


# ───────────────────────── a vehicle: parts on pivots ─────────────────────────
class Vehicle:
    def __init__(self, name):
        self.name = name
        self.parts = {}     # name -> dict(A=Asset, pivot, extras, ao, parent)
        self.empties = {}   # name -> (position, parent)

    def part(self, name, pivot=(0, 0, 0), ao='scene', parent=None, **extras):
        """A node with meshes. ao='self': only the part shades itself (for things that spin)."""
        A = Asset(name)
        self.parts[name] = dict(A=A, pivot=pivot, extras=extras, ao=ao, parent=parent)
        return A

    def empty(self, name, at, parent=None):
        self.empties[name] = (at, parent)

    def build(self):
        """Make the objects (still in world space), bake the shading, then hang every mesh on its pivot."""
        col = bpy.context.scene.collection
        meshes = {}
        for name, p in self.parts.items():
            objs = p['A'].build()
            for ob in objs:
                mat = ob.data.materials[0].name
                ob.name = ob.data.name = f'mesh_{name}_{mat}'
            meshes[name] = objs
        scene = [ob for n, objs in meshes.items() for ob in objs]
        still = [ob for n, objs in meshes.items() if self.parts[n]['ao'] == 'scene' for ob in objs]
        bake_ao(still, scene)
        for n, objs in meshes.items():
            if self.parts[n]['ao'] == 'self':
                bake_ao(objs, objs, ground=None, dist=0.5, gain=0.82)
        nodes = {}
        for name, p in self.parts.items():
            e = bpy.data.objects.new(name, None)
            e.empty_display_size = 0.1
            e.location = G(*p['pivot'])
            for k, v in p['extras'].items(): e[k] = v
            col.objects.link(e)
            nodes[name] = e
            off = Matrix.Translation(-G(*p['pivot']))
            for ob in meshes[name]:
                ob.data.transform(off)
                ob.parent = e
        for name, (at, parent) in self.empties.items():
            e = bpy.data.objects.new(name, None)
            e.empty_display_size = 0.08
            e.location = G(*at)
            col.objects.link(e)
            nodes[name] = e
        for name, p in list(self.parts.items()) + [(n, dict(parent=par, pivot=at)) for n, (at, par) in self.empties.items()]:
            if p['parent']:
                par = self.parts[p['parent']]
                nodes[name].parent = nodes[p['parent']]
                nodes[name].location = G(*p['pivot']) - G(*par['pivot'])
        bpy.context.view_layer.update()
        self.nodes = nodes
        self.meshes = scene
        return scene


def bake_ao(targets, occluders, rays=44, dist=1.1, floor=0.36, ground=0.0, power=1.0, gain=1.0):
    """kit.bake_ao, with the things that are shaded and the things that shade them given separately."""
    verts, polys = [], []
    for ob in occluders:
        me = ob.data
        base = len(verts)
        verts.extend([v.co.copy() for v in me.vertices])
        polys.extend([[base + i for i in p.vertices] for p in me.polygons])
    if ground is not None:
        base = len(verts)
        B = 60
        verts.extend([Vector((-B, -B, ground)), Vector((B, -B, ground)), Vector((B, B, ground)), Vector((-B, B, ground))])
        polys.append([base, base + 1, base + 2, base + 3])
    tree = BVHTree.FromPolygons(verts, polys, all_triangles=False, epsilon=0.0)
    dirs = kit._hemisphere(rays)
    for ob in targets:
        me = ob.data
        col = me.color_attributes['Col']
        normals = me.corner_normals
        matname = me.materials[0].name.split('.')[0]
        fl = {'snow': 0.84, 'glow': 1.0, 'beacon': 1.0, 'lamp_red': 1.0, 'glass': 0.8, 'chrome': 0.5, 'paint': 0.42}.get(matname, floor)
        cache = {}
        for li, loop in enumerate(me.loops):
            n = normals[li].vector
            key = (loop.vertex_index, round(n.x, 2), round(n.y, 2), round(n.z, 2))
            ao = cache.get(key)
            if ao is None:
                p = me.vertices[loop.vertex_index].co
                n = Vector(n)
                t = n.orthogonal().normalized(); b = n.cross(t)
                o = p + n * 0.01
                occ = 0.0
                for dx, dy, dz in dirs:
                    d = t * dx + b * dy + n * dz
                    hit = tree.ray_cast(o, d, dist)
                    if hit[0] is not None: occ += 1.0 - (hit[3] / dist) ** 2 * 0.85
                ao = 1.0 - occ / rays
                ao = (fl + (1 - fl) * (max(0.0, ao) ** power)) * gain
                cache[key] = ao
            c = col.data[li].color
            col.data[li].color = (c[0] * ao, c[1] * ao, c[2] * ao, 1.0)
        me.update()


def export(V):
    """Write public/models/<name>.glb (to a temporary name first: the game may be loading the old one)."""
    os.makedirs(kit.MODELS, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for ob in list(V.nodes.values()) + V.meshes: ob.select_set(True)
    bpy.context.view_layer.objects.active = V.meshes[0]
    path = os.path.join(kit.MODELS, f'{V.name}.glb')
    tmp = path + '.tmp.glb'
    bpy.ops.export_scene.gltf(
        filepath=tmp, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False,
        export_materials='EXPORT', export_image_format='NONE', export_vertex_color='NAME', export_vertex_color_name='Col', export_all_vertex_colors=False,
        export_active_vertex_color_when_no_material=True, export_extras=True,
        export_cameras=False, export_lights=False, export_animations=False, export_skins=False, export_morph=False,
    )
    slim_glb(tmp)
    os.replace(tmp, path)
    tris = sum(len(p.vertices) - 2 for ob in V.meshes for p in ob.data.polygons)
    if '--stats' in sys.argv:
        for ob in sorted(V.meshes, key=lambda o: -len(o.data.polygons)):
            print(f'   {ob.name:28s} {sum(len(p.vertices) - 2 for p in ob.data.polygons):6d} tris {len(ob.data.vertices):6d} verts')
    print(f'exported {V.name}.glb: {len(V.nodes)} nodes, {len(V.meshes)} meshes, {tris} triangles, {os.path.getsize(path) / 1024:.0f} KB')


def slim_glb(path):
    """Shrink a GLB the exporter wrote: normals become signed bytes and vertex colours unsigned bytes (the
    KHR_mesh_quantization extension, which three.js reads as it is), and meshes whose material has no texture lose
    their UVs. About half the size, the same picture."""
    import numpy as np
    data = open(path, 'rb').read()
    jlen = struct.unpack_from('<I', data, 12)[0]
    j = json.loads(data[20:20 + jlen])
    bin_ = data[20 + jlen + 8:]
    acc, views = j['accessors'], j['bufferViews']
    CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
    NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}
    def read(i):
        a = acc[i]; v = views[a['bufferView']]
        n = NC[a['type']]; dt = np.dtype(CT[a['componentType']])
        off = v.get('byteOffset', 0) + a.get('byteOffset', 0)
        return np.frombuffer(bin_, dtype=dt, count=a['count'] * n, offset=off).reshape(a['count'], n)
    out = bytearray()
    new_views, new_acc = [], []
    def write(arr, ctype, typ, target=None, normalized=False, stride=None, minmax=False):
        while len(out) % 4: out.append(0)
        raw = arr.tobytes()
        view = dict(buffer=0, byteOffset=len(out), byteLength=len(raw))
        if target: view['target'] = target
        if stride: view['byteStride'] = stride
        out.extend(raw)
        new_views.append(view)
        a = dict(bufferView=len(new_views) - 1, componentType=ctype, count=len(arr), type=typ)
        if normalized: a['normalized'] = True
        if minmax: a['min'] = [float(x) for x in arr.min(0)]; a['max'] = [float(x) for x in arr.max(0)]
        new_acc.append(a)
        return len(new_acc) - 1
    for m in j['meshes']:
        for pr in m['primitives']:
            at = pr['attributes']
            mat = j['materials'][pr['material']]['name'] if 'material' in pr else ''
            new = {}
            new['POSITION'] = write(read(at['POSITION']).astype(np.float32), 5126, 'VEC3', 34962, minmax=True)
            nrm = read(at['NORMAL']).astype(np.float32)
            q = np.zeros((len(nrm), 4), np.int8); q[:, :3] = np.clip(np.round(nrm * 127), -127, 127)
            new['NORMAL'] = write(q, 5120, 'VEC3', 34962, normalized=True, stride=4)
            if 'COLOR_0' in at:
                c = read(at['COLOR_0']).astype(np.float32)
                if acc[at['COLOR_0']]['componentType'] == 5123: c = c / 65535.0
                elif acc[at['COLOR_0']]['componentType'] == 5121: c = c / 255.0
                q = np.full((len(c), 4), 255, np.uint8); q[:, :3] = np.clip(np.round(c[:, :3] * 255), 0, 255)
                new['COLOR_0'] = write(q, 5121, 'VEC4', 34962, normalized=True)
            if 'TEXCOORD_0' in at and mat in TEXTURED:
                new['TEXCOORD_0'] = write(read(at['TEXCOORD_0']).astype(np.float32), 5126, 'VEC2', 34962)
            pr['attributes'] = new
            idx = read(pr['indices'])
            big = idx.max() > 65535
            pr['indices'] = write(idx.astype(np.uint32 if big else np.uint16).reshape(-1), 5125 if big else 5123, 'SCALAR', 34963)
    while len(out) % 4: out.append(0)
    j['accessors'], j['bufferViews'] = new_acc, new_views
    j['buffers'] = [dict(byteLength=len(out))]
    j['extensionsUsed'] = sorted(set(j.get('extensionsUsed', [])) | {'KHR_mesh_quantization'})
    j['extensionsRequired'] = sorted(set(j.get('extensionsRequired', [])) | {'KHR_mesh_quantization'})
    for m in j.get('materials', []):   # the game builds its own materials from the names
        for k in list(m.keys()):
            if k != 'name': del m[k]
    js = json.dumps(j, separators=(',', ':')).encode()
    while len(js) % 4: js += b' '
    total = 12 + 8 + len(js) + 8 + len(out)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(out), 0x004E4942)); f.write(bytes(out))


# ───────────────────────── snowmobile ─────────────────────────
def build_snowmobile():
    """A two-up trail sled: 2.7 m long, 1.25 m across the skis, windshield 1.15 m high, seat at 0.62 m."""
    V = Vehicle('snowmobile')
    B = V.part('body')

    # ── the track and what it runs on ──
    TW, TT = 0.40, 0.04
    drive, rear, front = (0.10, 0.275, 0.10), (-1.07, 0.15, 0.11), (-0.22, 0.104, 0.064)
    T = V.part('track')
    bm, length, vs = belt([rear, front, drive], TW, TT, 0.0, edge=0.012)
    T.add(bm, 'tread', uv='keep')
    print(f'snowmobile track: {length:.3f} m of belt, v scale {vs:.4f}')
    def axle_pair(name, c, r, zs, w=0.05, spr=False):
        W = V.part(name, pivot=(c[0], c[1], 0), ao='self', radius=round(r, 4))
        for s in (-1, 1):
            if spr: sprocket(W, (c[0], c[1], s * zs), r, w, teeth=9, segs=16, faces=(s,))
            else: wheel(W, (c[0], c[1], s * zs), r, w, segs=16 if r > 0.1 else 12, marks=4, faces=(s,))
        W.add(gtube([(c[0], c[1], -zs), (c[0], c[1], zs)], 0.016, around=6, cap=False), 'trim', STEEL)
    axle_pair('wheelRear', rear, rear[2], 0.12, w=0.06)
    axle_pair('wheelFront', front, front[2], 0.15, w=0.04)
    axle_pair('wheelMid0', (-0.52, 0.104), 0.064, 0.15, w=0.04)
    axle_pair('wheelMid1', (-0.80, 0.104), 0.064, 0.15, w=0.04)
    axle_pair('wheelDrive', drive, drive[2] * 0.96, 0.10, w=0.05, spr=True)
    # slide rails, swing arms and the rear shock
    for s in (-1, 1):
        rail = [(-1.07, 0.15), (-0.9, 0.088), (-0.2, 0.088), (-0.08, 0.16), (-0.14, 0.2), (-0.26, 0.15), (-0.86, 0.15), (-1.02, 0.2)]
        B.add(plate(rail, s * 0.085 - 0.012, s * 0.085 + 0.012, bev=0.006, segs=1), 'trim', STEEL)
        B.add(gtube([(-0.16, 0.16, s * 0.085), (0.05, 0.36, s * 0.15)], 0.02, around=6), 'trim', CHARCOAL)
        B.add(gtube([(-0.86, 0.15, s * 0.085), (-0.55, 0.38, s * 0.15)], 0.02, around=6), 'trim', CHARCOAL)
    B.add(gtube([(-0.62, 0.14, 0), (-0.3, 0.37, 0)], 0.017, around=6), 'chrome')
    B.add(spring((-0.6, 0.155, 0), (-0.34, 0.34, 0), 0.042, turns=6), 'trim', YELLOW)

    # ── tunnel: one pressed shell over the track, rolling down into a rounded tail ──
    HW, D, tk = 0.275, 0.225, 0.022
    tail = [(-1.02 - 0.27 * math.sin(a), 0.185 + 0.27 * math.cos(a)) for a in [lerp(0.5 * PI, 0, i / 7) for i in range(8)]]
    tpath = tail + [(x, 0.455) for x in spaced(-0.86, 0.36, 7)]
    usec = [(-HW, -D), (-HW, -0.05), (-HW + 0.015, -0.015), (-HW + 0.05, 0), (HW - 0.05, 0), (HW - 0.015, -0.015), (HW, -0.05), (HW, -D),
            (HW - tk, -D), (HW - tk, -0.05), (HW - 0.05, -tk), (-HW + 0.05, -tk), (-HW + tk, -0.05), (-HW + tk, -D)]
    B.add(sweep(tpath, usec, angle=50), 'paint', PAINT)
    for s in (-1, 1):
        # a dark rub strip along the tunnel's lower edge with rivets, a bright bead above it
        z = s * (HW + 0.004)
        B.add(plate([(-1.0, 0.232), (0.34, 0.232), (0.34, 0.3), (-1.06, 0.3)], z - 0.006, z + 0.006, bev=0.004, segs=1), 'paint', PAINT_DARK)
        B.add(gtube([(-1.08, 0.312, z), (0.34, 0.312, z)], 0.009, around=6), 'chrome')
        for i in range(9):
            B.add(bolt((-0.96 + i * 0.155, 0.266, z + s * 0.006), 'z' if s > 0 else '-z', r=0.012, h=0.008), 'chrome')
        B.add(lathe([(0.035, 0), (0.035, 0.01), (0.02, 0.016), (0, 0.017)], 12, 'z'), 'lamp_red')
        B.parts['lamp_red'][-1] = transform(B.parts['lamp_red'][-1], (-1.0, 0.39, z), rot=(0 if s > 0 else PI, 0, 0))
    # running boards with rubber treads, a bright rail round them, a toe stop at the front
    for s in (-1, 1):
        zc = s * 0.4
        o = [(-1.0, -0.13), (0.42, -0.13), (0.52, -0.06), (0.52, 0.11), (-0.9, 0.11), (-1.0, 0.06)]
        o = [(x, zc + s * z) for x, z in o]
        if s < 0: o = o[::-1]
        B.add(plate(o, 0.2, 0.238, 'xz', bev=0.012), 'trim', CHARCOAL)
        for i in range(8):
            B.add(transform(bm_box(0.022, 0.008, 0.09, bev=0.006, segs=1), (-0.82 + i * 0.155, 0.242, zc - s * 0.005)), 'rubber', (1, 1, 1))
        B.add(gtube([(-1.0, 0.224, s * 0.51), (0.38, 0.224, s * 0.52), (0.55, 0.3, s * 0.48), (0.6, 0.43, s * 0.4)], 0.018, around=8, corner=0.07), 'chrome')
        B.add(gtube([(0.42, 0.22, s * 0.3), (0.56, 0.33, s * 0.3), (0.6, 0.44, s * 0.3)], 0.032, around=8, corner=0.05), 'trim', CHARCOAL)

    # ── belly pan: a dark keel under the nose ──
    px = spaced(0.2, 1.22, 14, 0.5)
    pb = curve((0.2, 0.2), (0.5, 0.15), (0.85, 0.16), (1.05, 0.22), (1.22, 0.36))
    pw = curve((0.2, 0.3), (0.45, 0.36), (0.85, 0.35), (1.08, 0.25), (1.22, 0.05))
    B.add(loft([sect(x, pb(x), 0.42, pw(x), e=2.8, n=24) for x in px]), 'trim', CHARCOAL)

    # ── cowl: one swept shell from the seat's nose to the headlights ──
    cx = spaced(0.02, 1.28, 28, 0.55)
    ctop = curve((0.02, 0.6), (0.14, 0.67), (0.3, 0.78), (0.46, 0.87), (0.62, 0.885), (0.8, 0.83), (0.98, 0.73), (1.12, 0.62), (1.22, 0.53), (1.28, 0.46))
    cbot = curve((0.02, 0.44), (0.3, 0.36), (0.6, 0.33), (1.0, 0.33), (1.18, 0.35), (1.28, 0.4))
    cw = curve((0.02, 0.17), (0.14, 0.23), (0.3, 0.31), (0.48, 0.4), (0.7, 0.425), (0.92, 0.4), (1.1, 0.32), (1.21, 0.21), (1.28, 0.06))
    cwt = curve((0.02, 0.8), (0.4, 0.6), (0.8, 0.58), (1.1, 0.68), (1.28, 0.9))
    NS = 40
    def ring(x, grow=0.0):
        return sect(x, cbot(x) - grow, ctop(x) + grow, cw(x) + grow, e=2.7, n=NS, wt=cwt(x), eb=3.4)
    B.add(loft([ring(x) for x in cx]), 'paint', PAINT)
    # racing stripes laid over the top of it: a wide ivory band with a thin one either side
    def stripe(k0, k1, x0, x1, tint):
        rows = [ring(x, 0.004)[k0:k1 + 1] for x in cx if x0 <= x <= x1]
        B.add(loft(rows, closed=False), 'trim', tint)
    for k0, k1 in ((33, 38), (21, 26)):      # the flanks are a deeper shade below the waist
        B.add(loft([ring(x, 0.003)[k0:k1 + 1] for x in cx if 0.24 <= x <= 1.2], closed=False), 'paint', PAINT_DARK)
    stripe(8, 11, 0.36, 1.27, IVORY)
    stripe(6, 7, 0.36, 1.25, IVORY); stripe(12, 13, 0.36, 1.25, IVORY)
    # air intakes: dark louvres let into the cowl's flanks
    for s in (-1, 1):
        for i in range(3):
            x = 0.6 + i * 0.1
            l = bm_box(0.03, 0.075, 0.014, bev=0.01, segs=1)
            transform(l, (0, 0, 0), rot=(0, 0, -0.4))
            B.add(transform(l, (x, 0.52, s * (cw(x) * 0.972))), 'trim', BLACK)

    # ── headlights: two frog-eye lamps in bright bezels ──
    for s in (-1, 1):
        lamp(B, (1.05, 0.65, s * 0.17), 0.09, rot=(0, -s * 0.12, 0.12), bowl='paint', bowl_tint=PAINT, depth=0.36)
    # ── bumper ──
    B.add(gtube([(0.7, 0.3, -0.39), (1.02, 0.3, -0.39), (1.28, 0.32, -0.22), (1.33, 0.33, 0), (1.28, 0.32, 0.22), (1.02, 0.3, 0.39), (0.7, 0.3, 0.39)], 0.028, around=10, corner=0.11, n=5), 'chrome')
    for s in (-1, 1):
        B.add(gtube([(0.95, 0.3, s * 0.39), (0.9, 0.32, s * 0.29)], 0.02, around=6), 'trim', CHARCOAL)
        B.add(gtube([(1.25, 0.325, s * 0.16), (1.12, 0.33, s * 0.12)], 0.02, around=6), 'trim', CHARCOAL)

    # ── windshield ──
    def ws(u, v):   # u -1..1 across, v 0..1 up
        w = lerp(0.37, 0.29, v)
        return G(lerp(0.78, 0.5, v ** 0.8) - 0.22 * u * u, lerp(0.72, 1.15, v) - 0.06 * u * u * (1 - v), u * w)
    r = 0.5
    top = [(1 - r + r * math.cos(a), 1 - r + r * math.sin(a)) for a in [i / 7 * PI / 2 for i in range(8)]] + [(-1 + r + r * math.cos(a), 1 - r + r * math.sin(a)) for a in [PI / 2 + i / 7 * PI / 2 for i in range(8)]]
    ol = [(-1, 0), (1, 0)] + top
    B.add(sheet(ol, [], ws, cuts_u=[i / 6 for i in range(-5, 6)], cuts_v=[i / 5 for i in range(1, 5)], thickness=0.014, max_len=0.2, inside=G(0.2, 0.9, 0)), 'glass')
    B.add(tube([ws(u, 0.2 + 0.1 * u * u) + Vector((0.006, 0, 0)) for u in [i / 12 for i in range(-12, 13)]], 0.022, around=8, cap_steps=2), 'trim', BLACK)
    edge = [(1, 0.32)] + top + [(-1, 0.32)]
    B.add(tube([ws(u, v) for u, v in edge], 0.009, around=6, cap_steps=1), 'chrome')
    # gauge pod behind the screen
    pod = lathe([(0.078, -0.06), (0.086, 0.0), (0.076, 0.016), (0.066, 0.008)], 16, 'y')
    B.add(transform(pod, (0.6, 0.875, 0), rot=(0, 0, 0.55)), 'trim', CHARCOAL)
    B.add(transform(lathe([(0.066, 0.0), (0.0, 0.004)], 16, 'y'), (0.596, 0.882, 0), rot=(0, 0, 0.55)), 'glow')

    # ── front suspension ──
    SX, SZ = 0.84, 0.525
    for s in (-1, 1):
        for xa in (0.66, 1.0):
            B.add(gtube([(xa, 0.3, s * 0.2), (SX + (xa - 0.83) * 0.25, 0.25, s * (SZ - 0.04))], 0.022, around=6), 'trim', CHARCOAL)
            B.add(gtube([(xa, 0.42, s * 0.24), (SX + (xa - 0.83) * 0.2, 0.37, s * (SZ - 0.04))], 0.018, around=6), 'trim', CHARCOAL)
        a, b = (SX - 0.02, 0.27, s * (SZ - 0.08)), (SX - 0.06, 0.62, s * 0.3)
        B.add(gtube([a, b], 0.018, around=6), 'chrome')
        B.add(spring(Vector(a).lerp(Vector(b), 0.08), Vector(a).lerp(Vector(b), 0.8), 0.048, turns=6, wire=0.012), 'trim', YELLOW)

    # ── skis: crowned planks with a spine, a saddle, a sprung leg and a loop at the tip ──
    for name, s in (('skiL', -1), ('skiR', 1)):
        K = V.part(name, pivot=(SX, 0.12, s * SZ))
        z = s * SZ
        path = [(SX - 0.53, 0.05), (SX - 0.49, 0.025), (SX - 0.43, 0.0)] + [(x, 0.0) for x in spaced(SX - 0.3, SX + 0.22, 4)]
        path += [(SX + 0.22 + 0.3 * math.sin(a), 0.3 - 0.3 * math.cos(a)) for a in [i / 8 * 1.08 for i in range(1, 9)]]
        def sec(t, z=z):
            w = 0.098 * lerp(1.0, 0.72, smooth(0.72, 1.0, t)) * lerp(0.8, 1.0, smooth(0.0, 0.12, t))
            crown = lerp(0.03, 0.012, smooth(0.6, 1.0, t))
            top = [(z + w * q, 0.018 + crown * (1 - q * q) + 0.012 * max(0.0, 1 - abs(q) * 3.2)) for q in (1, 0.8, 0.45, 0.2, 0, -0.2, -0.45, -0.8, -1)]
            return [(z - w, 0.006), (z - w * 0.9, 0.0), (z + w * 0.9, 0.0), (z + w, 0.006)] + top
        K.add(sweep(path, sec, angle=50), 'trim', CHARCOAL)
        K.add(plate([(SX - 0.36, -0.016), (SX + 0.16, -0.016), (SX + 0.2, 0.004), (SX - 0.4, 0.004)], z - 0.012, z + 0.012, bev=0.004, segs=1), 'trim', STEEL)   # wear bar
        for dz in (-0.05, 0.05):
            K.add(plate([(SX - 0.17, 0.03), (SX + 0.17, 0.03), (SX + 0.05, 0.16), (SX - 0.05, 0.16)], z + dz - 0.01, z + dz + 0.01, bev=0.006, segs=1), 'trim', STEEL)
        K.add(gtube([(SX, 0.115, z - 0.07), (SX, 0.115, z + 0.07)], 0.02, around=8), 'trim', YELLOW)
        K.add(lathe([(0.03, 0.09), (0.03, 0.2), (0.04, 0.205)], 12, 'y', (SX, 0, z)), 'trim', STEEL)
        K.add(lathe([(0.04, 0.2), (0.052, 0.215), (0.04, 0.235), (0.052, 0.255), (0.04, 0.275), (0.052, 0.295), (0.04, 0.315), (0.05, 0.335), (0.036, 0.36), (0, 0.365)], 12, 'y', (SX, 0, z)), 'trim', BLACK)
        tipx, tipy = path[-1][0], path[-1][1] + 0.03
        K.add(gtube([(tipx - 0.03, tipy - 0.02, z), (tipx - 0.11, tipy + 0.09, z), (SX + 0.17, 0.21, z), (SX + 0.1, 0.05, z)], 0.02, around=8, corner=0.09, n=5), 'trim', YELLOW)

    # ── handlebars ──
    S = V.part('steer', pivot=(0.5, 0.82, 0))
    S.add(gtube([(0.52, 0.78, 0), (0.44, 0.985, 0)], 0.032, around=10), 'trim', CHARCOAL)
    S.add(gtube([(0.33, 1.0, -0.42), (0.36, 1.0, -0.26), (0.44, 0.99, -0.1), (0.44, 0.99, 0.1), (0.36, 1.0, 0.26), (0.33, 1.0, 0.42)], 0.019, around=10, corner=0.08), 'chrome')
    pad = rbox(0.4, 0.48, 0.955, 1.03, 0.1, r=0.03, edge=0.025)
    S.add(pad, 'trim', BLACK)
    for s in (-1, 1):
        S.add(gtube([(0.345, 1.0, s * 0.3), (0.326, 1.0, s * 0.435)], 0.029, around=10), 'trim', BLACK)
        S.add(gtube([(0.35, 1.006, s * 0.28), (0.395, 1.0, s * 0.3), (0.39, 0.995, s * 0.41)], 0.008, around=5, corner=0.02), 'trim', STEEL)
        # a round mirror on a stalk
        S.add(gtube([(0.365, 1.0, s * 0.25), (0.39, 1.09, s * 0.3), (0.39, 1.12, s * 0.34)], 0.008, around=5, corner=0.03), 'trim', BLACK)
        lamp(S, (0.39, 1.125, s * 0.35), 0.048, lens='chrome', ring='trim', rot=(0, PI + s * 0.15, 0), dome=0.12, segs=14)
        V.empty('gripL' if s < 0 else 'gripR', (0.335, 1.0, s * 0.37), parent='steer')

    # ── the seat: a long tuck-and-roll saddle, a step up for the passenger, a backrest ──
    sx = spaced(-1.2, 0.16, 50, 0.25)
    stop = curve((-1.2, 0.60), (-1.14, 0.68), (-1.0, 0.685), (-0.6, 0.68), (-0.48, 0.64), (-0.3, 0.62), (0.0, 0.62), (0.1, 0.61), (0.16, 0.56))
    sw = curve((-1.2, 0.2), (-1.12, 0.28), (-0.6, 0.295), (-0.2, 0.28), (0.05, 0.22), (0.16, 0.14))
    def roll(x):   # the pleats
        return 0.02 * abs(math.sin((x + 1.2) * PI / 0.118)) ** 0.6
    B.add(loft([sect(x, 0.445, stop(x) - 0.02 + roll(x), sw(x) - 0.014 + roll(x) * 0.7, e=3.0, n=28, wt=0.9, eb=6) for x in sx]), 'seat', LEATHER)
    for s in (-1, 1):
        B.add(gtube([(x, 0.5, s * (sw(x) + 0.004)) for x in spaced(-1.14, 0.08, 16)], 0.013, around=6), 'seat', PIPING)
    B.add(rbox(-1.315, -1.185, 0.69, 1.02, 0.26, r=0.06, edge=0.06, lean=-0.04, steps=4), 'seat', LEATHER)
    hoop = [(-1.25 - 0.04 * (y - 0.69) / 0.33, y, z) for z, y in kit.rounded_rect(-0.262, 0.7, 0.262, 1.01, 0.07, 4)]
    B.add(gtube(hoop + hoop[:1], 0.012, around=6, cap=False), 'seat', PIPING)
    for z in (-0.09, 0.09):     # two tucks down the pad
        B.add(gtube([(-1.183 - 0.04 * k, 0.74 + 0.23 * k, z) for k in (0, 0.5, 1)], 0.01, around=5), 'seat', (0.1, 0.045, 0.02))
    V.empty('seat0', (-0.12, 0.62, 0))
    V.empty('seat1', (-0.86, 0.68, 0))

    # ── grab rail, backrest posts and tail ──
    rail = [(-0.9, 0.44, 0.285), (-1.0, 0.6, 0.325), (-1.23, 0.72, 0.31), (-1.325, 0.76, 0.18), (-1.325, 0.76, -0.18), (-1.23, 0.72, -0.31), (-1.0, 0.6, -0.325), (-0.9, 0.44, -0.285)]
    B.add(gtube(rail, 0.022, around=10, corner=0.1, n=5), 'chrome')
    for s in (-1, 1):   # the clamps that hold the backrest to the rail
        B.add(rbox(-1.36, -1.29, 0.725, 0.795, 0.035, r=0.012, edge=0.012, z0=s * 0.12, n=2, steps=1), 'trim', CHARCOAL)
    B.add(transform(bm_box(0.03, 0.05, 0.15, bev=0.02, segs=2), (-1.3, 0.56, 0)), 'trim', CHARCOAL)
    B.add(transform(bm_box(0.014, 0.034, 0.13, bev=0.012, segs=2), (-1.33, 0.56, 0)), 'lamp_red')
    B.add(gtube([(-1.3, 0.56, 0), (-1.2, 0.47, 0)], 0.018, around=6), 'trim', CHARCOAL)
    # snow flap
    flap = grid(lambda u, v: G(-1.3 - 0.05 * v - 0.02 * math.sin(v * PI), lerp(0.26, 0.05, v), lerp(-0.24, 0.24, u)), 6, 5, thickness=0.016, inside=G(0, 0.2, 0))
    B.add(flap, 'rubber', (1, 1, 1))
    # exhaust on the right
    B.add(gtube([(0.52, 0.29, 0.31), (0.2, 0.3, 0.32)], 0.037, around=10), 'chrome')
    B.add(gtube([(0.2, 0.3, 0.32), (0.1, 0.3, 0.34)], 0.02, around=8), 'trim', BLACK)
    return V, dict(target=(0, 0.5, 0), dist=4.9, yaw=38, pitch=14)


# ───────────────────────── snowplow ─────────────────────────
def cab_shape(y0, ys, yt, xr0, xr1, xf0, xf1, hw0, hw1, rc):
    """The cab's skin as a function of (u, y): u runs round the plan in metres (measured at the sill), starting in
    the middle of the front-left corner and going front, right side, rear, left side. Below the sill `ys` the walls
    stand straight; above it the windshield rakes back from xf0 to xf1 and the sides lean in from hw0 to hw1.
    Returns (fn(u, y, off) -> Blender point, {face name: (u start, u end)}, U)."""
    arc_l = PI / 2 * rc
    Lf, Ls = 2 * (hw0 - rc), (xf0 - xr0) - 2 * rc
    segs = [('cFL2', arc_l / 2), ('front', Lf), ('cFR', arc_l), ('right', Ls), ('cRR', arc_l), ('rear', Lf), ('cRL', arc_l), ('left', Ls), ('cFL1', arc_l / 2)]
    spans, u = {}, 0.0
    for name, L in segs:
        spans[name] = (u, u + L); u += L
    U = u
    def fn(u, y, off=0.0):
        k = clamp((y - ys) / (yt - ys))
        xf, hw = lerp(xf0, xf1, k) - off, lerp(hw0, hw1, k) - off
        xr = lerp(xr0, xr1, clamp((y - y0) / (yt - y0))) + off
        r = rc - off
        u = clamp(u, 0.0, U)
        for name, (a, b) in spans.items():
            if u <= b + 1e-9: break
        t = clamp((u - a) / (b - a))
        if name == 'front': return G(xf, y, lerp(-(hw - r), hw - r, t))
        if name == 'rear': return G(xr, y, lerp(hw - r, -(hw - r), t))
        if name == 'right': return G(lerp(xf - r, xr + r, t), y, hw)
        if name == 'left': return G(lerp(xr + r, xf - r, t), y, -hw)
        cx, cz, a0, a1 = {'cFL2': (xf - r, -(hw - r), -PI / 4, 0), 'cFR': (xf - r, hw - r, 0, PI / 2), 'cRR': (xr + r, hw - r, PI / 2, PI),
                          'cRL': (xr + r, -(hw - r), PI, 1.5 * PI), 'cFL1': (xf - r, -(hw - r), 1.5 * PI, 1.75 * PI)}[name]
        a = lerp(a0, a1, t)
        return G(cx + math.cos(a) * r, y, cz + math.sin(a) * r)
    return fn, spans, U


def build_snowplow():
    """A tracked snow-cat with a big blade: 4.0 m long over the tracks, 2.3 m wide, blade 3.0 m by 1.25 m with its
    front edge at x = 2.75, cab roof 2.55 m, beacon 2.8 m."""
    V = Vehicle('snowplow')
    B = V.part('body')

    # ── running gear ──
    TW, TT, ZT = 0.56, 0.06, 0.87
    spr, idl = (-1.55, 0.50, 0.30), (1.50, 0.50, 0.30)
    bog = [(-0.98, 0.29, 0.23), (-0.34, 0.29, 0.23), (0.30, 0.29, 0.23), (0.94, 0.29, 0.23)]
    for side, s in (('L', -1), ('R', 1)):
        z = s * ZT
        T = V.part('track' + side)
        bm, length, vs = belt([spr, bog[0], bog[-1], idl], TW, TT, z, edge=0.016, cols=5)
        T.add(bm, 'tread', uv='keep')
        if s < 0: print(f'snowplow tracks: {length:.3f} m of belt each, v scale {vs:.4f}')
        W = V.part(f'wheel{side}0', pivot=(spr[0], spr[1], z), ao='self', radius=spr[2])
        sprocket(W, (spr[0], spr[1], z), spr[2] * 0.97, 0.36, teeth=11, segs=18, faces=(s,))
        for i, b in enumerate(bog):
            W = V.part(f'wheel{side}{i + 1}', pivot=(b[0], b[1], z), ao='self', radius=b[2])
            wheel(W, (b[0], b[1], z), b[2], 0.3, marks=5, segs=16, faces=(s,))
        W = V.part(f'wheel{side}5', pivot=(idl[0], idl[1], z), ao='self', radius=idl[2])
        wheel(W, (idl[0], idl[1], z), idl[2], 0.32, marks=6, segs=18, rim=0.7, faces=(s,))
        # the track frame: a beam inside the belt that the wheels hang from, and the arms that carry it
        zi = s * (ZT - 0.2)
        beam = [(-1.5, 0.42), (-1.2, 0.3), (1.15, 0.3), (1.46, 0.42), (1.46, 0.6), (1.15, 0.66), (-1.2, 0.66), (-1.5, 0.6)]
        B.add(plate(beam, zi - 0.04, zi + 0.04, bev=0.016, segs=1), 'trim', CHARCOAL)
        for c in [spr, idl] + bog:
            B.add(gtube([(c[0], c[1], zi), (c[0], c[1], z)], 0.045, around=8, cap=False), 'trim', STEEL)
        # fender: a pressed mudguard with a rolled lip that follows the belt over both ends
        f = [(spr[0] + 0.44 * math.cos(a), spr[1] + 0.44 * math.sin(a)) for a in [lerp(PI + 0.42, PI / 2, i / 10) for i in range(11)]]
        f += [(x, 0.94) for x in spaced(-1.25, 1.2, 8)[1:-1]]
        f += [(idl[0] + 0.44 * math.cos(a), idl[1] + 0.44 * math.sin(a)) for a in [lerp(PI / 2, -0.3, i / 10) for i in range(11)]]
        zi_, zo_ = 0.54, 1.17
        sec = [(zi_, 0.0), (zo_ - 0.045, 0.0), (zo_ - 0.045, -0.06), (zo_ - 0.01, -0.06), (zo_, -0.045), (zo_, 0.025), (zo_ - 0.02, 0.05), (zi_, 0.05)]
        B.add(sweep(f, [(s * zz, h) for zz, h in (sec if s > 0 else sec[::-1])], angle=50), 'paint', PAINT)
        for i, (x, y) in enumerate(f[2:-2:3]):
            B.add(bolt((x, y - 0.02, s * (zo_ + 0.002)), 'z' if s > 0 else '-z', r=0.014, h=0.008), 'chrome')
        # non-slip step on the fender by the door, a mud flap behind
        B.add(transform(bm_box(0.34, 0.012, 0.15, bev=0.008, segs=1), (0.7, 0.996, s * 1.0)), 'trim', CHARCOAL)
        for i in range(6):
            B.add(transform(bm_box(0.014, 0.008, 0.13, bev=0.004, segs=1), (0.43 + i * 0.108, 1.01, s * 1.0)), 'trim', STEEL)
        fl = grid(lambda u, v: G(-1.955 - 0.04 * v, lerp(0.34, 0.1, v), s * 0.87 + lerp(-0.3, 0.3, u)), 4, 3, thickness=0.022, inside=G(0, 0.3, 0))
        B.add(fl, 'rubber', (1, 1, 1))

    # ── chassis tub between the tracks ──
    B.add(rbox(-1.88, 1.78, 0.3, 0.96, 0.6, r=0.1, edge=0.05, n=3, steps=2), 'trim', CHARCOAL)
    B.add(rbox(-2.0, -1.82, 0.5, 0.82, 0.52, r=0.05, edge=0.035), 'trim', CHARCOAL)      # rear bumper
    for z in (-0.3, 0.3):
        B.add(transform(bm_box(0.012, 0.05, 0.1, bev=0.01, segs=1), (-2.005, 0.66, z)), 'trim', YELLOW)
    B.add(gtube([(-1.98, 0.6, 0), (-2.03, 0.6, 0)], 0.035, around=8), 'metal')            # tow pin
    B.add(lathe([(0.055, -0.02), (0.068, 0), (0.055, 0.02), (0.03, 0.02), (0.03, -0.02)], 12, 'y', (-2.04, 0.6, 0)), 'metal')
    B.add(rbox(1.72, 1.84, 0.34, 0.78, 0.56, r=0.04, edge=0.03), 'trim', CHARCOAL)       # nose plate
    B.add(gtube([(1.6, 0.9, -0.5), (1.72, 0.9, -0.44), (1.72, 0.9, 0.44), (1.6, 0.9, 0.5)], 0.035, around=8, corner=0.05), 'chrome')   # nudge bar
    for z in (-0.25, 0.25):
        B.add(gtube([(1.84, 0.6, z - 0.06), (1.92, 0.6, z - 0.06), (1.92, 0.6, z + 0.06), (1.84, 0.6, z + 0.06)], 0.02, around=6, corner=0.03), 'trim', YELLOW)   # tow eyes

    # ── cab ──
    Y0, YS, YT = 0.96, 1.26, 2.42
    cab, sp, U = cab_shape(Y0, YS, YT, xr0=-0.34, xr1=-0.27, xf0=1.58, xf1=1.2, hw0=0.84, hw1=0.76, rc=0.26)
    def win(face, a, b, y0, y1, r=0.1):
        u0, u1 = sp[face]
        return kit.rounded_rect(u0 + a if a >= 0 else u1 + a, y0, u0 + b if b > 0 else u1 + b, y1, r, 4)
    Ls = sp['right'][1] - sp['right'][0]
    DOOR = 0.86   # the door's width along the side
    holes = [win('front', 0.0, -0.0001, 1.36, 2.3, 0.13),
             win('right', 0.05, DOOR - 0.06, 1.36, 2.3), win('right', DOOR + 0.06, -0.05, 1.36, 2.3),
             win('rear', 0.1, -0.1, 1.5, 2.26),
             win('left', 0.05, Ls - DOOR - 0.06, 1.36, 2.3), win('left', Ls - DOOR + 0.06, -0.05, 1.36, 2.3)]
    cuts = []
    for name, (a, b) in sp.items():
        n = 5 if name.startswith('c') else 1
        cuts += [lerp(a, b, i / n) for i in range(1, n + 1)]
    cuts = [c for c in cuts if 1e-4 < c < U - 1e-4]
    inside = G(0.6, 1.6, 0)
    shell = sheet([(0, Y0), (U, Y0), (U, YT), (0, YT)], holes, lambda u, y: cab(u, y), cuts_u=cuts, cuts_v=[YS], thickness=0.055, max_len=0.3, inside=inside)
    bmesh.ops.remove_doubles(shell, verts=shell.verts[:], dist=1e-4)
    shade(shell, 45)
    B.add(shell, 'paint', PAINT)
    for h in holes:
        c = (sum(p[0] for p in h) / len(h), sum(p[1] for p in h) / len(h))
        big = [(p[0] + math.copysign(0.02, p[0] - c[0]), p[1] + math.copysign(0.02, p[1] - c[1])) for p in h]
        lo, hi = min(p[0] for p in big), max(p[0] for p in big)
        B.add(sheet(big, [], lambda u, y: cab(u, y, 0.03), cuts_u=[q for q in cuts if lo < q < hi], max_len=0.4, inside=inside), 'glass')
        # the rubber gasket the pane sits in
        B.add(tube([cab(u, y, -0.004) for u, y in h + h[:1]], 0.02, around=6, cap=False), 'rubber', (1, 1, 1))
    # an ivory waistband round the cab, door shuts, hinges and handles
    band = sheet([(0, 1.0), (U, 1.0), (U, 1.2), (0, 1.2)], [], lambda u, y: cab(u, y, -0.006), cuts_u=cuts, max_len=0.8, inside=inside)
    bmesh.ops.remove_doubles(band, verts=band.verts[:], dist=1e-4)
    B.add(band, 'trim', IVORY)
    for face, u0 in (('right', sp['right'][0]), ('left', sp['left'][1] - DOOR)):
        o = kit.rounded_rect(u0 - 0.03, 1.0, u0 + DOOR + 0.02, 2.37, 0.12, 4)
        B.add(tube([cab(u, y, -0.003) for u, y in o + o[:1]], 0.009, around=4, cap=False), 'rubber', (1, 1, 1))
        hinge_u = u0 + DOOR + 0.02 if face == 'right' else u0 - 0.03
        handle_u = u0 + 0.1 if face == 'right' else u0 + DOOR - 0.1
        for y in (1.12, 2.2):
            p = cab(hinge_u, y, -0.012)
            B.add(transform(bm_cyl(0.022, 0.1, 8, bev=0.006), (p.x, p.z, -p.y)), 'chrome')
        p = cab(handle_u, 1.27, -0.02)
        B.add(transform(bm_box(0.07, 0.022, 0.016, bev=0.012, segs=2), (p.x, p.z, -p.y)), 'chrome')
    # wipers, parked
    fu = sp['front'][0]
    for u0, u1 in ((fu + 0.32, fu + 0.62), (fu + 0.92, fu + 1.22)):
        B.add(tube([cab(u0, 1.33, -0.02), cab(u0 + 0.02, 1.42, -0.04), cab(u1, 1.86, -0.04)], 0.009, around=5, cap_steps=1), 'rubber', (1, 1, 1))
        B.add(tube([cab(u1 - 0.2, 1.62, -0.036), cab(u1 + 0.16, 2.1, -0.036)], 0.012, around=5, cap_steps=1), 'rubber', (1, 1, 1))
    # roof: an ivory lid with a visor over the windshield
    B.add(rbox(-0.36, 1.52, 2.4, 2.57, 0.82, r=0.28, edge=0.08, steps=4), 'trim', IVORY)
    B.add(rbox(-0.24, 1.3, 2.55, 2.61, 0.64, r=0.22, edge=0.035), 'trim', IVORY)
    # floor, dashboard, steering wheel and seat
    B.add(rbox(-0.26, 1.5, 0.95, 1.0, 0.76, r=0.2, edge=0.01, n=3, steps=1), 'trim', CHARCOAL)
    B.add(rbox(1.08, 1.5, 0.98, 1.34, 0.7, r=0.14, edge=0.07, n=3), 'trim', CHARCOAL)
    B.add(gtube([(1.2, 1.28, 0), (1.0, 1.5, 0)], 0.03, around=8), 'trim', BLACK)
    wheel_ring = [(1.0 - 0.115 * math.cos(a), 1.5 - 0.125 * math.cos(a), 0.18 * math.sin(a)) for a in [i / 16 * 2 * PI for i in range(17)]]
    B.add(tube([G(*p) for p in wheel_ring], 0.022, around=6, cap=False), 'trim', BLACK)
    for a in (0.0, 2.1, 4.2):
        B.add(gtube([(1.0, 1.5, 0), (1.0 - 0.115 * math.cos(a), 1.5 - 0.125 * math.cos(a), 0.18 * math.sin(a))], 0.014, around=5, cap=False), 'trim', STEEL)
    B.add(rbox(0.14, 0.8, 1.0, 1.12, 0.38, r=0.1, edge=0.045), 'seat', LEATHER)
    B.add(rbox(-0.04, 0.12, 1.06, 1.66, 0.36, r=0.08, edge=0.05, lean=-0.07), 'seat', LEATHER)
    V.empty('seat0', (0.5, 1.12, 0))
    # headlights and grille: the face
    for s in (-1, 1):
        lamp(B, (1.59, 1.12, s * 0.52), 0.13, bowl='trim', bowl_tint=IVORY, depth=0.2, segs=20)
    B.add(transform(bm_box(0.022, 0.1, 0.27, bev=0.02, segs=2), (1.585, 1.11, 0)), 'trim', BLACK)
    for i in range(4):
        B.add(transform(bm_box(0.014, 0.012, 0.25, bev=0.006, segs=1), (1.607, 1.04 + i * 0.047, 0)), 'chrome')
    # round work lamps on the visor
    for z in (-0.57, -0.2, 0.2, 0.57):
        lamp(B, (1.42, 2.66, z), 0.07, bowl='trim', bowl_tint=CHARCOAL, depth=0.16, segs=12, rot=(0, 0, -0.08))
        B.add(gtube([(1.36, 2.6, z), (1.36, 2.64, z)], 0.02, around=6, cap=False), 'trim', CHARCOAL)
    # beacon: an amber lens on a bright base, in a wire guard
    BX = -0.05
    B.add(lathe([(0.11, 0), (0.11, 0.03), (0.09, 0.05), (0.09, 0.075), (0.1, 0.085), (0.1, 0.1)], 16, 'y', (BX, 2.6, 0)), 'chrome')
    K = V.part('beacon', pivot=(BX, 2.7, 0))
    K.add(lathe([(0.085, 0.0), (0.085, 0.06), (0.07, 0.095), (0.035, 0.108), (0.0, 0.11)], 16, 'y', (BX, 2.7, 0)), 'beacon')
    # aerial
    B.add(gtube([(-0.2, 2.6, -0.6), (-0.21, 3.0, -0.6), (-0.26, 3.25, -0.6)], 0.008, around=5, corner=0.1), 'trim', BLACK)
    B.add(transform(bm_ico(0.02, 1), (-0.26, 3.25, -0.6)), 'trim', YELLOW)
    # mirrors and grab rails
    for s in (-1, 1):
        B.add(gtube([(1.3, 1.5, s * 0.82), (1.44, 1.56, s * 1.02), (1.44, 1.98, s * 1.02), (1.24, 2.04, s * 0.78)], 0.016, around=6, corner=0.06), 'trim', BLACK)
        B.add(rbox(1.41, 1.47, 1.62, 1.92, 0.09, r=0.025, edge=0.02, z0=s * 1.08), 'trim', CHARCOAL)
        B.add(transform(bm_box(0.004, 0.125, 0.07, bev=0.002, segs=1), (1.408, 1.77, s * 1.08)), 'chrome')
        B.add(gtube([(-0.2, 1.4, s * 0.82), (-0.2, 1.4, s * 0.91), (-0.2, 2.1, s * 0.87), (-0.2, 2.1, s * 0.78)], 0.019, around=8, corner=0.04), 'chrome')

    # ── engine deck ──
    def hood_ring(y, x0, inset):
        return plan(y, x0 + inset, -0.3, 0.75 - inset, max(0.02, 0.17 - inset), 5)
    hood = [(0.96, -1.93, 0.012), (0.975, -1.93, 0.0), (1.28, -1.93, 0.0), (1.42, -1.88, 0.004), (1.5, -1.82, 0.022), (1.56, -1.72, 0.07), (1.58, -1.6, 0.16)]
    B.add(loft([hood_ring(*h) for h in hood], angle=50), 'paint', PAINT)
    B.add(rbox(-1.5, -0.62, 1.56, 1.615, 0.5, r=0.1, edge=0.025), 'paint', PAINT_DARK)       # access hatch
    B.add(loft([plan(y, -1.936, -0.3, 0.756, 0.176, 5) for y in (1.0, 1.2)], cap0=False, cap1=False), 'trim', IVORY)   # the waistband carries on round the hood
    for z in (-0.3, 0.3):
        B.add(gtube([(-1.42, 1.61, z), (-1.42, 1.66, z), (-1.26, 1.66, z), (-1.26, 1.61, z)], 0.012, around=6, corner=0.02), 'chrome')
    for s in (-1, 1):
        # a dark grille panel with bright slats, tail lamps
        B.add(rbox(-1.72, -1.02, 1.08, 1.4, 0.012, r=0.004, edge=0.004, z0=s * 0.752), 'trim', BLACK)
        for i in range(5):
            B.add(transform(bm_box(0.33, 0.012, 0.01, bev=0.004, segs=1), (-1.37, 1.12 + i * 0.06, s * 0.768)), 'trim', STEEL)
        lamp(B, (-1.935, 1.24, s * 0.52), 0.07, lens='lamp_red', rot=(0, PI, 0), segs=16, dome=0.35)
    # air cleaner
    B.add(lathe([(0.1, 0), (0.1, 0.12), (0.13, 0.13), (0.13, 0.19), (0.09, 0.22), (0, 0.225)], 16, 'y', (-0.52, 1.58, -0.42)), 'chrome')
    # exhaust stack with its heat guard and rain cap
    ex = (-0.56, 0.5)
    B.add(gtube([(ex[0], 1.5, ex[1]), (ex[0], 2.42, ex[1]), (ex[0] - 0.07, 2.5, ex[1])], 0.052, around=12, corner=0.07), 'chrome')
    B.add(lathe([(0.06, -0.02), (0.08, 0), (0.08, 0.5), (0.06, 0.52)], 12, 'y', (ex[0], 1.66, ex[1])), 'trim', BLACK)
    for i in range(4):
        B.add(lathe([(0.082, 0), (0.088, 0.012), (0.082, 0.024)], 12, 'y', (ex[0], 1.72 + i * 0.12, ex[1])), 'trim', STEEL)
    V.empty('exhaust', (ex[0] - 0.1, 2.54, ex[1]))
    # a shovel clipped to the hood, a fuel can on the fender
    hz = -0.775
    B.add(gtube([(-1.05, 1.5, hz), (-0.42, 1.5, hz)], 0.02, around=6), 'trim', WOOD)
    B.add(gtube([(-0.42, 1.46, hz), (-0.42, 1.54, hz)], 0.022, around=6), 'trim', WOOD)
    sh = grid(lambda u, v: G(lerp(-1.4, -1.05, u), 1.5 + (v - 0.5) * lerp(0.26, 0.2, u), hz - 0.035 * (1 - (2 * v - 1) ** 2) - 0.0), 3, 4, thickness=0.01, inside=G(-1.2, 1.5, 0))
    B.add(sh, 'metal')
    for x in (-0.95, -0.55):
        B.add(transform(bm_box(0.022, 0.035, 0.03, bev=0.01, segs=1), (x, 1.5, hz + 0.005)), 'trim', BLACK)
    B.add(rbox(-1.62, -1.3, 1.0, 1.36, 0.1, r=0.04, edge=0.03, z0=0.99), 'trim', RED)
    B.add(lathe([(0.03, 0), (0.03, 0.04), (0, 0.045)], 8, 'y', (-1.36, 1.36, 0.99)), 'trim', BLACK)
    B.add(gtube([(-1.56, 1.36, 0.99), (-1.56, 1.42, 0.99), (-1.44, 1.42, 0.99), (-1.44, 1.36, 0.99)], 0.012, around=5, corner=0.02), 'trim', RED)
    B.add(rbox(-1.5, -1.44, 0.99, 1.37, 0.108, r=0.02, edge=0.006, z0=0.99), 'trim', BLACK)

    # ── blade ──
    PV = (1.72, 0.46, 0)
    BL = V.part('blade', pivot=PV)
    C, R = (3.04, 0.62), 0.75
    SWEEP = 0.07    # how far the blade's ends lead its middle
    A0, A1 = math.radians(233), math.radians(121)
    def face(sv, t, off=0.0, a0=A0, a1=A1):
        a = lerp(a0, a1, t); z = lerp(-1.5, 1.5, sv)
        return G(C[0] + (R + off) * math.cos(a) + SWEEP * (z / 1.5) ** 2, C[1] + (R + off) * math.sin(a), z)
    def gp(v): return (v.x, v.z, -v.y)     # a Blender point back in GAME terms
    BL.add(grid(face, 20, 12, thickness=0.05, inside=G(1.5, 0.6, 0)), 'paint', PAINT)
    BL.add(tube([face(u, 1.0, 0.02) for u in spaced(0.0, 1.0, 14)], 0.036, around=8, cap_steps=2), 'paint', PAINT_DARK)   # rolled top lip
    # cutting edge, bolted on
    E0, E1 = math.radians(236.5), math.radians(223)
    BL.add(grid(lambda u, v: face(u, v, -0.016, E0, E1), 20, 2, thickness=0.022, inside=G(1.5, 0.6, 0)), 'metal')
    for i in range(13):
        BL.add(bolt(gp(face((i + 0.5) / 13, 0.55, -0.02, E0, E1)), 'x', r=0.022, h=0.016), 'metal')
    # hazard stripes under the top lip
    N = 18
    for k in range(-1, N):
        bm = bmesh.new()
        rows = []
        for j in range(4):
            t = lerp(0.8, 0.955, j / 3)
            rows.append([bm.verts.new(face(clamp((k + e) / N + (j / 3) / N), t, -0.006)) for e in (0, 1)])
        for a, b in zip(rows[:-1], rows[1:]):
            if (a[0].co - a[1].co).length < 1e-6 and (b[0].co - b[1].co).length < 1e-6: continue
            try: bm.faces.new((a[0], a[1], b[1], b[0]))
            except ValueError: pass
        if not bm.faces: bm.free(); continue
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        bm.normal_update()
        if sum(f.normal.x for f in bm.faces) < 0: bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
        for f in bm.faces: f.smooth = True
        BL.add(bm, 'trim', YELLOW if k % 2 else BLACK)
    # end plates, with a marker wand on each corner
    for s in (-1, 1):
        o = [(C[0] + (R - 0.13) * math.cos(a) + SWEEP, C[1] + (R - 0.13) * math.sin(a)) for a in [lerp(A0 + 0.05, A1, i / 12) for i in range(13)]]
        o += [(C[0] + (R + 0.07) * math.cos(a) + SWEEP, C[1] + (R + 0.07) * math.sin(a)) for a in [lerp(A1, A0 + 0.03, i / 12) for i in range(13)]]
        BL.add(plate(o, s * 1.5 - 0.028, s * 1.5 + 0.028, bev=0.014), 'paint', PAINT_DARK)
        top = gp(face(0.5 + s * 0.485, 1.0, 0.05))
        BL.add(gtube([top, (top[0] - 0.02, top[1] + 0.42, top[2])], 0.012, around=6), 'trim', BLACK)
        BL.add(gtube([(top[0] - 0.014, top[1] + 0.3, top[2]), (top[0] - 0.02, top[1] + 0.44, top[2])], 0.02, around=6), 'trim', RED)
        BL.add(gtube([(top[0] - 0.012, top[1] + 0.24, top[2]), (top[0] - 0.014, top[1] + 0.3, top[2])], 0.0195, around=6, cap=False), 'trim', IVORY)
    # the back: two cross tubes and gussets
    for t in (0.2, 0.8):
        BL.add(tube([face(u, t, 0.11) for u in spaced(0.01, 0.99, 12)], 0.06, around=8, cap_steps=2), 'trim', CHARCOAL)
    for zz in (-1.25, -0.82, -0.42, 0.42, 0.82, 1.25):
        sw = SWEEP * (zz / 1.5) ** 2
        ts = spaced(0.06, 0.94, 10)
        o = [(C[0] + (R + 0.045) * math.cos(lerp(A0, A1, t)) + sw, C[1] + (R + 0.045) * math.sin(lerp(A0, A1, t))) for t in ts]
        o += [(C[0] + (R + 0.045 + 0.2 * math.sin(PI * t) ** 0.7) * math.cos(lerp(A0, A1, t)) + sw, C[1] + (R + 0.045 + 0.2 * math.sin(PI * t) ** 0.7) * math.sin(lerp(A0, A1, t))) for t in ts[::-1][1:-1]]
        BL.add(plate(o, zz - 0.02, zz + 0.02, bev=0.01, segs=1), 'paint', PAINT_DARK)
    # push arms, hinge pins and the tilt rams
    for s in (-1, 1):
        zz = s * 0.42
        o = [(1.64, 0.4), (1.72, 0.36), (2.28, 0.3), (2.3, 0.54), (1.72, 0.56), (1.64, 0.52)]
        BL.add(plate(o, zz - 0.05, zz + 0.05, bev=0.02), 'trim', CHARCOAL)
        BL.add(gtube([(PV[0], PV[1], zz - 0.1), (PV[0], PV[1], zz + 0.1)], 0.042, around=10), 'chrome')
        ram(BL, (1.9, 0.6, zz), (2.36, 1.03, zz), barrel=0.052, rod=0.028)
        BL.add(plate([(2.24, 0.95), (2.4, 0.93), (2.42, 1.12), (2.3, 1.12)], zz - 0.075, zz + 0.075, bev=0.012, segs=1), 'trim', CHARCOAL)
        BL.add(plate([(1.8, 0.52), (2.0, 0.52), (1.96, 0.66), (1.84, 0.66)], zz - 0.07, zz + 0.07, bev=0.012, segs=1), 'trim', CHARCOAL)
        # the lugs on the chassis that carry the hinge
        for dz in (-0.078, 0.078):
            B.add(plate([(1.58, 0.34), (1.76, 0.36), (1.8, 0.46), (1.76, 0.56), (1.58, 0.6)], zz + dz - 0.018, zz + dz + 0.018, bev=0.01, segs=1), 'trim', STEEL)
    BL.add(gtube([(2.05, 0.42, -0.42), (2.05, 0.42, 0.42)], 0.045, around=8, cap=False), 'trim', CHARCOAL)
    # snow rolled up in the curve of the blade, a little lying along its top
    heap = kit.pipe([face(u, 0.09, -0.17) for u in spaced(0.07, 0.93, 28)], 0.135, around=12, wobble=0.22, seed=3, squash=1.3)
    displace(heap, 0.03, 2.4, 4)
    BL.add(heap, 'snow')
    heap = kit.pipe([face(u, 0.25, -0.1) for u in spaced(0.2, 0.64, 14)], 0.1, around=10, wobble=0.3, seed=7, squash=1.25)
    displace(heap, 0.03, 3.0, 9)
    BL.add(heap, 'snow')
    BL.add(kit.pipe([face(u, 1.0, 0.0) + Vector((0, 0, 0.035)) for u in spaced(0.1, 0.55, 8)], 0.05, around=6, wobble=0.35, seed=5, squash=0.7), 'snow')
    # snow on the roof, the engine deck and where the fenders meet the cab
    B.add(transform(kit.drift((0.72, 0.1, 0.56), seed=2, around=14), (0.42, 2.6, 0.04)), 'snow')
    B.add(transform(kit.drift((0.42, 0.09, 0.4), seed=6, around=12), (-1.05, 1.6, 0.12)), 'snow')
    B.add(transform(kit.drift((0.3, 0.08, 0.14), seed=9, around=10), (-0.75, 0.985, -1.0)), 'snow')
    B.add(transform(kit.drift((0.26, 0.07, 0.13), seed=11, around=10), (1.42, 0.985, 0.98)), 'snow')
    return V, dict(target=(0.3, 1.15, 0), dist=10.5, yaw=38, pitch=13)


BUILDERS = {'snowmobile': build_snowmobile, 'snowplow': build_snowplow}

TEAMS = {'blue': (0.028, 0.209, 0.807), 'orange': (1.0, 0.254, 0.027)}   # 0x2f7ee8 and 0xff8a2e, linear
VIEWS = {
    'front': dict(yaw=35, pitch=14),
    'hero': dict(yaw=42, pitch=11, sun_yaw=250, lens=62),
    'side': dict(yaw=90, pitch=6),
    'rear': dict(yaw=215, pitch=16),
    'top': dict(yaw=60, pitch=62),
    'low': dict(yaw=-28, pitch=5),
}


def add_riders(V):
    """Review only: stand a penguin on every seat, feet on the seat empty, as the game does."""
    out = []
    for name in ('seat0', 'seat1'):
        if name not in V.empties: continue
        at = V.empties[name][0]
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(kit.ROOT, 'src', 'assets', 'models', 'penguin.glb'))
        new = [o for o in bpy.data.objects if o not in before]
        for o in new:
            if o.name.startswith('PenguinLOD') or o.name.startswith('Icosphere'): bpy.data.objects.remove(o); continue
            if o.type == 'ARMATURE':
                o.location = G(at[0], at[1], at[2])
                o.rotation_mode = 'XYZ'
                o.rotation_euler = (0, 0, -PI / 2)    # the penguin faces Blender +y; turn it to face +x
            out.append(o)
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    do_render = '--render' in sys.argv
    views = [a.split('=')[1].split(',') for a in sys.argv if a.startswith('--views=')]
    views = views[0] if views else ['front', 'rear']
    for name in (args or list(BUILDERS)):
        kit.reset(); kit._mats.clear()
        V, view = BUILDERS[name]()
        V.build()
        export(V)
        for e in V.nodes.values():
            if e.name.startswith('wheel'): print('  ', e.name, 'radius', e['radius'], 'at', tuple(round(v, 3) for v in (e.matrix_world.translation.x, e.matrix_world.translation.z, -e.matrix_world.translation.y)))
        if do_render:
            os.makedirs(RENDERS, exist_ok=True)
            if '--riders' in sys.argv: add_riders(V)
            teams = [a.split('=')[1] for a in sys.argv if a.startswith('--team=')] or ['blue']
            for team in teams:
                node = kit.material('paint').node_tree.nodes
                for n in node:
                    if n.type == 'MIX' and n.blend_type == 'MULTIPLY': n.inputs[6].default_value = (*TEAMS[team], 1)
                for v in views:
                    o = {**view, **VIEWS.get(v, {})}
                    for a in sys.argv:
                        if a.startswith('--dist='): o['dist'] = float(a.split('=')[1])
                        if a.startswith('--sun='): o['sun_yaw'] = float(a.split('=')[1])
                        if a.startswith('--size='): o['size'] = tuple(int(q) for q in a.split('=')[1].split('x'))
                        if a.startswith('--samples='): o['samples'] = int(a.split('=')[1])
                    kit.render(os.path.join(RENDERS, f'{name}-{team}-{v}.png'), **o)

if __name__ == '__main__':
    main()
