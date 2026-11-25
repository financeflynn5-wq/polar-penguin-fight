"""The gingerbread house, its two ruins, and the log cabin. Sizes match src/world/Landmarks.ts."""
import math, random
import bmesh
from mathutils import Vector, Matrix
import kit
from kit import (G, Asset, tube, arc, transform, snow_lump, gumdrop, bm_box, bm_cyl, bm_ico, bevel, shade, refine, displace,
                 slab, rounded_rect, arch_outline, ribbon, pipe, blob, drip, icicle, chunk, drift)

# the gingerbread house (makeGingerbreadHouse) and the cabin (makeCabin)
GB = dict(hx=3.6, hz=2.8, t=0.3, wallH=2.7, ridgeH=4.5, doorW=1.7, doorH=2.0, winW=2.2, sill=0.9, winTop=2.1)
CABIN = dict(hx=3.3, hz=2.6, t=0.34, wallH=2.5, ridgeH=4.3, doorW=1.6, doorH=2.0, winW=1.9, sill=0.95, winTop=2.0)
FOOT = -0.55  # how far the walls go down into the snow

DROPS = [(0.78, 0.05, 0.06), (0.07, 0.50, 0.13), (0.95, 0.60, 0.05), (0.06, 0.24, 0.80), (0.93, 0.22, 0.48), (0.95, 0.33, 0.04), (0.42, 0.12, 0.62)]
CHOC = (0.40, 0.29, 0.25)  # gingerbread tinted down to dark chocolate
ROOF_TINT = (0.9, 0.82, 0.77)
HALF = math.pi / 2


class Wall:
    """Maps a wall's own (u along it, v up, w outward) onto the house, so decoration is written once per kind of wall."""

    def __init__(self, side, h):
        self.side = side; self.h = h
        self.len = h['hx'] if side in 'SN' else h['hz']  # half length

    def p(self, u, v, w=0.0):
        h = self.h
        if self.side == 'S': return (u, v, h['hz'] + w)
        if self.side == 'N': return (-u, v, -h['hz'] - w)
        if self.side == 'E': return (h['hx'] + w, v, -u)
        return (-h['hx'] - w, v, u)

    def g(self, u, v, w=0.0):
        return G(*self.p(u, v, w))

    def rot_y(self):
        """Game rotation about y that turns local +u (east) to this wall's +u, with local +z facing outward."""
        return {'S': 0.0, 'N': math.pi, 'E': -HALF, 'W': HALF}[self.side]


class Roof:
    """A pitched roof with its ridge along x. Points on it are (s = +1 south side / -1 north, x, k = 0 at the ridge
    .. 1 over the wall's eave line, lift = out along the slope's normal)."""

    def __init__(self, h, over=0.35, thick=0.17):
        self.h = h
        self.span = h['hz'] + over
        self.rise = h['ridgeH'] - h['wallH']
        self.ang = math.atan2(self.rise, self.span)
        self.ln = math.hypot(self.span, self.rise) + 0.14
        self.thick = thick
        self.top = 0.02 + thick / 2 / math.cos(self.ang)

    def p(self, s, x, k, lift=0.0):
        y = self.h['ridgeH'] - self.rise * k + self.top
        return (x, y + math.cos(self.ang) * lift, s * self.span * k + s * math.sin(self.ang) * lift)

    def g(self, s, x, k, lift=0.0):
        return G(*self.p(s, x, k, lift))

    def sheet(self, s, outline, mat_thick=None, **kw):
        """A slab lying on side s. outline in (x, v) with v from -ln/2 at the eave to +ln/2 at the ridge."""
        bm = slab(outline, [], mat_thick or self.thick, **kw)
        cy = self.h['wallH'] + self.rise / 2 + 0.02
        return transform(bm, (0, cy, s * self.span / 2), rot=(s * (self.ang - HALF), 0, 0))

    def snow(self, A, s, xa, xb, ka, kb, depth, seed):
        """Snow that has settled on part of side s: a soft sheet with a ragged edge that thins out to nothing."""
        from mathutils import noise
        nx, nk = max(6, int((xb - xa) / 0.28)), max(4, int((kb - ka) * self.ln / 0.28))
        bm = bmesh.new()
        rows = []
        for i in range(nx + 1):
            row = []
            for j in range(nk + 1):
                u, v = i / nx, j / nk
                x, k = xa + (xb - xa) * u, ka + (kb - ka) * v
                q = Vector((x * 0.8 + seed * 3.1, k * self.ln * 0.8, seed * 1.7))
                d = min(min(u, 1 - u) * (xb - xa), min(v, 1 - v) * (kb - ka) * self.ln) - 0.2 + 0.55 * noise.noise(q)
                t = max(0.0, min(1.0, d / 0.5)); t = t * t * (3 - 2 * t)
                hgt = depth * t * (0.8 + 0.5 * noise.noise(q * 2.3 + Vector((5, 0, 0))))
                row.append(bm.verts.new(self.g(s, x, k, hgt - 0.015)))
            rows.append(row)
        for i in range(nx):
            for j in range(nk):
                bm.faces.new((rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        if sum(f.normal.z for f in bm.faces) < 0: bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
        for f in bm.faces: f.smooth = True
        A.add(bm, 'snow')

    def put(self, A, bm, s, x, k, mat, tint=(1, 1, 1), lift=0.0, spin=0.0, **kw):
        """Stand a piece (made upright at the origin) on the slope."""
        transform(bm, (0, 0, 0), rot=(0, spin, 0))
        transform(bm, self.p(s, x, k, lift), rot=(s * self.ang, 0, 0))
        A.add(bm, mat, tint, **kw)


def put(A, bm, wall, u, v, w, mat, tint=(1, 1, 1), spin=0.0, tilt=0.0, turn=0.0, **kw):
    """Place a piece made facing +z (south) onto a wall at (u, v), w out from its face. tilt = HALF lays an
    upright piece (a gumdrop) flat against the wall; spin turns it in the wall's plane first."""
    transform(bm, (0, 0, 0), rot=(tilt, turn, spin))
    transform(bm, wall.p(u, v, w), rot=(0, wall.rot_y(), 0))
    A.add(bm, mat, tint, **kw)


def scallops(wall, u0, u1, v, n, sag, w, steps=5):
    """A garland of n hanging loops of piping between u0 and u1 at height v, as one path (Blender space)."""
    pts = []
    for i in range(n * steps + 1):
        t = i / steps
        pts.append(wall.g(u0 + (u1 - u0) * t / n, v - sag * abs(math.sin(math.pi * t)), w))
    return pts


def swirl(wall, cu, cv, r, turns, w, flip=1, steps=24):
    pts = []
    for k in range(steps + 1):
        t = k / steps
        a = t * turns * 2 * math.pi
        rr = r * (1 - 0.9 * t)
        pts.append(wall.g(cu + flip * math.cos(a) * rr, cv + math.sin(a) * rr, w))
    return pts


def heart(wall, cu, cv, size, w, steps=22):
    pts = []
    for k in range(steps + 1):
        t = math.pi + k / steps * 2 * math.pi
        x = 16 * math.sin(t) ** 3
        y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        pts.append(wall.g(cu + x * size / 32, cv + (y + 2.5) * size / 32, w))
    return pts


def disc_candy(r=0.5, thick=0.12, segs=24):
    """A peppermint: a fat disc facing +z, with the swirl mapped on both faces."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r, radius2=r, depth=thick)
    bevel(bm, thick * 0.42, 2, angle=50)
    uv = bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        for l in f.loops:
            l[uv].uv = (0.5 + l.vert.co.x / (2 * r) * 0.98, 0.5 + l.vert.co.y / (2 * r) * 0.98)
    bmesh.ops.transform(bm, matrix=Matrix.Rotation(HALF, 4, 'X'), verts=bm.verts[:])  # its axis becomes game z
    shade(bm, 40)
    return bm


def small_cane(height=1.9, r=0.085, hook=0.2):
    """A little candy cane to stand by a door (rising from the origin, hooking toward +x)."""
    path = [G(0, y, 0) for y in (-0.3, 0.3, 0.9, height - hook)]
    path += arc((hook, height - hook, 0), hook, math.pi, -0.3, 9, 'xy')
    return tube(path, r, around=10, tile_v=0.55, cap=True, cap_steps=2)


def jag(rng, a, b, n, amp):
    """n points from a to b (2D), knocked sideways: a broken edge."""
    out = []
    dx, dy = b[0] - a[0], b[1] - a[1]
    ln = math.hypot(dx, dy) or 1
    nx, ny = -dy / ln, dx / ln
    for i in range(1, n):
        t = (i + rng.uniform(-0.3, 0.3)) / n
        o = rng.uniform(-amp, amp)
        out.append((a[0] + dx * t + nx * o, a[1] + dy * t + ny * o))
    return out


# ───────────────────────── gingerbread: the shell ─────────────────────────
def gb_end_wall(A, h, side):
    """An end wall: the arched doorway and the gable cut from one sheet."""
    hz, t = h['hz'], h['t']
    w = Wall(side, h)
    slope = (h['ridgeH'] - h['wallH']) / (hz + 0.35)
    rake = lambda u: h['ridgeH'] - slope * abs(u) - 0.2
    door = arch_outline(-h['doorW'] / 2, h['doorW'] / 2, FOOT, 1.42, h['doorH'])
    # the doorway runs out of the bottom of the sheet, so it is part of the outline rather than a hole
    outline = [(-hz, FOOT), (-h['doorW'] / 2, FOOT)] + door[::-1][:-2] + [(h['doorW'] / 2, FOOT), (hz, FOOT), (hz, rake(hz)), (0, rake(0)), (-hz, rake(hz))]
    bm = slab(outline, [], t, bev=0.05, segs=2, max_len=0.6, seed=ord(side))
    transform(bm, w.p(0, 0, -t / 2), rot=(0, w.rot_y(), 0))
    A.add(bm, 'gingerbread')


def gb_long_wall(A, h, side):
    w = Wall(side, h)
    L = h['hx'] - h['t'] + 0.02
    outline = [(-L, FOOT), (L, FOOT), (L, h['wallH'] + 0.25), (-L, h['wallH'] + 0.25)]  # up into the roof sheet, so no daylight shows under it
    win = rounded_rect(-h['winW'] / 2, h['sill'], h['winW'] / 2, h['winTop'], 0.2)
    bm = slab(outline, [win[::-1]], h['t'], bev=0.05, segs=2, max_len=0.6, seed=ord(side))
    transform(bm, w.p(0, 0, -h['t'] / 2), rot=(0, w.rot_y(), 0))
    A.add(bm, 'gingerbread')


def gb_roof(A, h, rng, x0, x1, broken=False):
    """The two roof sheets between x0 and x1 with their icing: scalloped rows, a fat roll along the ridge with
    gumdrops on it, a dripping band at the eaves. broken = the east edge is snapped off."""
    R = Roof(h)
    half = R.ln / 2
    for s in (-1, 1):
        east = [(x1, -half)] + ([(x1 - 0.1 - rng.random() * 0.75, v) for v in [-half + R.ln * i / 7 for i in range(1, 7)]] if broken else []) + [(x1, half)]
        if broken: east[0] = (x1 - 0.5, -half); east[-1] = (x1 - 0.2, half)
        bm = R.sheet(s, [(x0, half), (x0, -half)] + east, bev=0.045, segs=2, max_len=0.6, seed=30 + s)
        A.add(bm, 'gingerbread', ROOF_TINT)
        xa, xb = x0 + 0.14, (x1 - 0.95 if broken else x1 - 0.14)
        # rows of scallops, each row half a loop out of step with the last
        pitch, steps = 0.66, 8
        for row, k0 in enumerate((0.17, 0.38, 0.59, 0.80)):
            n = int((xb - xa) / (pitch / steps))
            path = []
            for i in range(n + 1):
                x = xa + i * pitch / steps
                ph = (x - x0) / pitch + (0.5 if row % 2 else 0.0)
                path.append(R.g(s, x, k0 + 0.105 * abs(math.sin(math.pi * ph)), 0.02))
            A.add(tube(path, 0.052, around=5, cap=True, cap_steps=2), 'icing')
        # the eave: a fat wobbly band and the drips that ran off it
        path = [R.g(s, xa - 0.05 + (xb - xa + 0.1) * i / 26, 1.0, 0.035) for i in range(27)]
        A.add(pipe(path, 0.115, around=7, wobble=0.16, seed=s + 2), 'icing')
        x = xa + 0.1
        while x < xb - 0.05:
            ln = rng.choice((0.14, 0.2, 0.26, 0.34, 0.46, 0.6)) * rng.uniform(0.8, 1.15)
            A.add(transform(drip(ln, 0.055 + 0.03 * rng.random()), R.p(s, x, 1.02, 0.0)), 'icing')
            x += rng.uniform(0.3, 0.62)
        # piping down the outer edges (the rakes)
        for xe in ([x0 + 0.05] if broken else [x0 + 0.05, x1 - 0.05]):
            path = [R.g(s, xe, 1.0 - i / 10, 0.035) for i in range(11)]
            A.add(pipe(path, 0.085, around=6, wobble=0.12, seed=int(xe * 7) + s), 'icing')
    # the ridge: a thick roll of icing with gumdrops pressed into it
    xa, xb = x0 + 0.05, (x1 - 0.5 if broken else x1 - 0.05)
    n = int((xb - xa) / 0.33)
    yr = h['ridgeH'] + R.top + 0.03
    A.add(pipe([G(xa + (xb - xa) * i / n, yr, 0) for i in range(n + 1)], 0.17, around=9, wobble=0.13, seed=5, cap_steps=3), 'icing')
    count = max(2, round((xb - xa) / 0.86))
    for i in range(count):
        x = xa + 0.35 + (xb - xa - 0.7) * i / max(1, count - 1)
        A.add(transform(gumdrop(0.19, 0.24, around=12), (x, yr + 0.1, 0)), 'gumdrop', DROPS[i % len(DROPS)])
    return R


# ───────────────────────── gingerbread: decoration ─────────────────────────
def gb_long_deco(A, h, w, rng, u0=None, u1=None, window=True):
    """Everything piped and stuck onto a long wall between u0 and u1."""
    L = h['hx']
    u0 = -L if u0 is None else u0
    u1 = L if u1 is None else u1
    ww, sill, top = h['winW'] / 2, h['sill'], h['winTop']
    if window:
        frame = rounded_rect(-ww - 0.05, sill - 0.05, ww + 0.05, top + 0.05, 0.24, n=4)
        A.add(tube([w.g(u, v, 0.03) for u, v in frame + frame[:2]], 0.07, around=6, cap=False), 'icing')
        # the sill: a biscuit ledge with icing lying on it and a gumdrop at each end
        put(A, bm_box(ww + 0.2, 0.05, 0.1, bev=0.03), w, 0, sill - 0.13, 0.1, 'gingerbread', ROOF_TINT)
        A.add(pipe([w.g(-ww - 0.16 + (2 * ww + 0.32) * i / 8, sill - 0.06, 0.13) for i in range(9)], 0.06, wobble=0.2, seed=3), 'icing')
        for k, s in enumerate((-1, 1)):
            A.add(transform(gumdrop(0.1, 0.13), w.p(s * (ww + 0.07), sill - 0.03, 0.13), rot=(0, 0, 0)), 'gumdrop', DROPS[(k * 3 + ord(w.side)) % 7])
        # chocolate shutters, each with a piped cross and a pearl
        for s in (-1, 1):
            us = s * (ww + 0.42)
            put(A, bm_box(0.27, 0.68, 0.04, bev=0.025), w, us, (sill + top) / 2, 0.04, 'gingerbread', CHOC)
            for d in (-1, 1):
                A.add(tube([w.g(us - 0.19, (sill + top) / 2 - d * 0.56, 0.085), w.g(us, (sill + top) / 2, 0.095), w.g(us + 0.19, (sill + top) / 2 + d * 0.56, 0.085)], 0.03, around=5, cap_steps=1), 'icing')
            put(A, blob(0.07, sub=1), w, us, (sill + top) / 2, 0.1, 'icing')
        # a garland over the window with a pearl on every peg
        A.add(tube(scallops(w, -1.5, 1.5, top + 0.42, 4, 0.17, 0.03), 0.045, around=5, cap_steps=2), 'icing')
        for i in range(5):
            put(A, gumdrop(0.085, 0.1, around=8), w, -1.5 + 0.75 * i, top + 0.42, 0.0, 'gumdrop', DROPS[(i * 2 + 1) % 7], tilt=HALF)
        # a swirl either side
        for s in (-1, 1):
            if u0 <= s * 2.72 <= u1:
                A.add(tube(swirl(w, s * 2.72, 1.5, 0.4, 2.1, 0.03, flip=s), 0.042, around=5, cap_steps=2), 'icing')
    # a row of gumdrops along the foot of the wall
    n = int((u1 - u0 - 0.5) / 0.6)
    for i in range(n + 1):
        u = u0 + 0.3 + (u1 - u0 - 0.6) * i / max(1, n)
        put(A, gumdrop(0.13, 0.15), w, u, 0.3, 0.0, 'gumdrop', DROPS[(i + ord(w.side)) % 7], tilt=HALF)
    A.add(pipe([w.g(u0 + 0.2 + (u1 - u0 - 0.4) * i / 14, 0.5, 0.02) for i in range(15)], 0.04, around=5, wobble=0.15, seed=9), 'icing')


def gb_end_deco(A, h, w, rng, gable=True):
    """The doorway's piping and sweets, the peppermint in the gable, canes either side of the door."""
    dw, dh, hz = h['doorW'] / 2, h['doorH'], h['hz']
    spring = 1.42
    arc_pts = arch_outline(-dw - 0.09, dw + 0.09, -0.1, spring, dh + 0.09, n=12)
    path = [arc_pts[1]] + arc_pts[2:] + [arc_pts[0]]
    A.add(tube([w.g(u, v, 0.03) for u, v in path], 0.08, around=7, cap_steps=2), 'icing')
    # gumdrops round the arch
    for i in range(7):
        a = math.radians(12 + 26 * i)
        u, v = math.cos(a) * (dw + 0.36), spring + math.sin(a) * (dh - spring + 0.34)
        put(A, gumdrop(0.12, 0.15), w, u, v, 0.0, 'gumdrop', DROPS[(i + ord(w.side)) % 7], tilt=HALF)
    # little candy canes standing either side of the door, hooks toward it
    for s in (-1, 1):
        put(A, small_cane(1.7, 0.075, 0.19), w, s * (dw + 0.5), 0.0, 0.17, 'candy', turn=0.0 if s < 0 else math.pi, uv='keep')
        put(A, drift((0.34, 0.2, 0.3), seed=s + 4, around=10), w, s * (dw + 0.5), 0.0, 0.2, 'snow')
    # a heart piped on each side panel, a gumdrop in the middle of it
    for s in (-1, 1):
        A.add(tube(heart(w, s * 2.02, 1.2, 0.62, 0.03), 0.042, around=5, cap_steps=2), 'icing')
        put(A, gumdrop(0.1, 0.12, around=8), w, s * 2.02, 1.5, 0.0, 'gumdrop', DROPS[0 if s < 0 else 4], tilt=HALF)
        for k in range(3):
            put(A, gumdrop(0.13, 0.15), w, s * (1.55 + 0.47 * k), 0.3, 0.0, 'gumdrop', DROPS[(k + 2 + ord(w.side)) % 7], tilt=HALF)
    if gable:
        slope = (h['ridgeH'] - h['wallH']) / (hz + 0.35)
        put(A, disc_candy(0.47, 0.13), w, 0, 3.12, 0.05, 'mint', uv='keep')
        for i in range(12):
            a = i / 12 * 2 * math.pi
            put(A, blob(0.062, sub=1), w, math.cos(a) * 0.6, 3.12 + math.sin(a) * 0.6, 0.03, 'icing')
        # a garland under each rake
        for s in (-1, 1):
            pts = []
            for i in range(4 * 5 + 1):
                t = i / 5
                u = s * (0.75 + 1.95 * t / 4)
                pts.append(w.g(u, h['ridgeH'] - slope * abs(u) - 0.55 - 0.13 * abs(math.sin(math.pi * t)), 0.03))
            A.add(tube(pts, 0.042, around=5, cap_steps=2), 'icing')


def corner_piping(A, h, cx, cz, top, seed=0):
    """A fat bead of icing up a corner where two walls meet."""
    sx, sz = (1 if cx > 0 else -1), (1 if cz > 0 else -1)
    n = max(3, int(top / 0.3))
    path = [G(cx + sx * 0.02, -0.15 + (top + 0.15) * i / n, cz + sz * 0.02) for i in range(n + 1)]
    A.add(pipe(path, 0.1, around=7, wobble=0.16, seed=seed), 'icing')


def build_gingerbread():
    h = GB
    rng = random.Random(7)
    A = Asset('gingerbread')
    hx, hz = h['hx'], h['hz']
    for side in 'EW': gb_end_wall(A, h, side)
    for side in 'SN': gb_long_wall(A, h, side)
    R = gb_roof(A, h, rng, -hx - 0.45, hx + 0.45)
    for side in 'SN': gb_long_deco(A, h, Wall(side, h), rng)
    for side in 'EW': gb_end_deco(A, h, Wall(side, h), rng)
    for i, (cx, cz) in enumerate(((hx, hz), (hx, -hz), (-hx, hz), (-hx, -hz))):
        corner_piping(A, h, cx, cz, h['wallH'] - 0.02, i)
    # a stubby chimney with an icing cap and snow on it
    cx, cz = 1.95, -1.05
    A.add(transform(bm_box(0.36, 0.62, 0.36, bev=0.05, segs=2), (cx, 4.38, cz)), 'gingerbread')
    cap = bm_box(0.44, 0.075, 0.44, bev=0.07, segs=2); refine(cap, 0.3); displace(cap, 0.02, 3, 4); shade(cap, 50)
    A.add(transform(cap, (cx, 5.02, cz)), 'icing')
    for k in range(7):
        a = k / 7 * 2 * math.pi + 0.3
        ex, ez = max(-0.43, min(0.43, math.cos(a) * 0.62)), max(-0.43, min(0.43, math.sin(a) * 0.62))
        A.add(transform(drip(0.12 + 0.3 * rng.random(), 0.05), (cx + ex, 5.0, cz + ez)), 'icing')
    A.add(transform(snow_lump((0.4, 0.2, 0.4), seed=12, sub=2), (cx, 5.07, cz)), 'snow')
    # snow that has settled on the roof and drifted against the walls
    R.snow(A, 1, -3.9, 0.9, 0.05, 0.62, 0.17, 21)
    R.snow(A, 1, 1.2, 3.95, 0.3, 0.97, 0.15, 22)
    R.snow(A, -1, -3.95, -0.6, 0.25, 0.97, 0.17, 23)
    R.snow(A, -1, -0.2, 3.9, 0.05, 0.6, 0.16, 24)
    for i, (x, z, sx, sz) in enumerate(((3.1, 3.05, 1.0, 0.55), (-3.0, 3.1, 1.2, 0.6), (-3.2, -3.1, 1.0, 0.55), (2.9, -3.05, 1.3, 0.6), (0.2, 3.1, 0.9, 0.42), (-0.4, -3.1, 0.9, 0.42))):
        A.add(transform(drift((sx * 1.15, 0.36, sz * 1.15), seed=40 + i), (x, 0.0, z)), 'snow')
    # a sugar lantern hanging from the ridge inside
    A.add(tube([G(0, 4.42, 0), G(0, 3.62, 0)], 0.016, around=5, cap=False), 'rope')
    A.add(transform(blob(0.17, sub=2, squash=(1, 1.15, 1)), (0, 3.45, 0)), 'glow')
    A.add(transform(gumdrop(0.2, 0.12, around=10), (0, 3.56, 0)), 'icing')
    return A, dict(target=(0, 2.1, 0), dist=15, yaw=58, pitch=13, lens=45,
                   more=[dict(tag='b', yaw=-25, pitch=8, dist=12.5), dict(tag='c', target=(3.6, 1.7, 0), yaw=20, pitch=6, dist=6.5, lens=40)])


# ───────────────────────── gingerbread: the ruins ─────────────────────────
def broken_wall(A, h, w, segs, rng, clean=(False, False), tint=(1, 1, 1), snow=True):
    """A run of wall along `w` that has been bitten down. segs = [(u0, u1, top, jagged)] touching each other, left to
    right. clean = whether the left / right end is a proper edge (a corner, a door jamb) or a break.
    Tops stay at or just under the heights given, because those are what you bump into (PROP_SHAPES)."""
    ua, ub = segs[0][0], segs[-1][1]
    def top_at(u):
        for u0, u1, top, jagged in segs:
            if u <= u1 + 1e-6: return top, jagged
        return segs[-1][2], segs[-1][3]
    n = max(2, int((ub - ua) / 0.24))
    prof = []
    for i in range(n + 1):
        u = ua + (ub - ua) * i / n
        top, jagged = top_at(u)
        v = top - (rng.uniform(0.0, 0.26) if jagged else 0.0)
        if jagged and rng.random() < 0.22: v -= rng.uniform(0.1, 0.3)
        prof.append((u, max(0.25, v)))
    left = [] if clean[0] else jag(rng, (ua, prof[0][1]), (ua, FOOT), max(2, int(prof[0][1] / 0.3) + 1), 0.09)
    right = [] if clean[1] else jag(rng, (ub, FOOT), (ub, prof[-1][1]), max(2, int(prof[-1][1] / 0.3) + 1), 0.09)
    outline = [(ua, FOOT), (ub, FOOT)] + right + prof[::-1] + left
    bm = slab(outline, [], h['t'], bev=0.045, segs=2, max_len=0.6, seed=int(ua * 10) + ord(w.side))
    transform(bm, w.p(0, 0, -h['t'] / 2), rot=(0, w.rot_y(), 0))
    A.add(bm, 'gingerbread', tint)
    if snow:
        # snow lying along the broken top
        run = [p for p in prof if top_at(p[0])[1]]
        if len(run) >= 3:
            A.add(pipe([w.g(u, v + 0.03, -h['t'] / 2) for u, v in run], 0.15, around=7, wobble=0.25, seed=int(ua * 3), cap_steps=2), 'snow')
    return prof


def foot_sweets(A, h, w, u0, u1, rng, band=True):
    """What is left of the row of gumdrops and the band of icing along the foot of a wall."""
    n = int((u1 - u0 - 0.4) / 0.6)
    for i in range(n + 1):
        if rng.random() < 0.3: continue
        u = u0 + 0.25 + (u1 - u0 - 0.5) * i / max(1, n)
        put(A, gumdrop(0.13, 0.15), w, u, 0.3, 0.0, 'gumdrop', DROPS[(i + ord(w.side)) % 7], tilt=HALF)
    if band and u1 - u0 > 1.2:
        A.add(pipe([w.g(u0 + 0.15 + (u1 - u0 - 0.3) * i / 8, 0.5, 0.02) for i in range(9)], 0.04, around=5, wobble=0.15, seed=9), 'icing')


def rubble(A, rng, cx, cz, rx, rz, top, n=4, seed=0):
    """A heap of broken biscuit inside a footprint, no higher than `top`."""
    for i in range(n):
        s = (rng.uniform(0.28, 0.5) * min(1, rx), rng.uniform(0.07, 0.1), rng.uniform(0.22, 0.4) * min(1, rz))
        x, z = cx + rng.uniform(-0.55, 0.55) * rx, cz + rng.uniform(-0.55, 0.55) * rz
        y = rng.uniform(0.08, max(0.1, top - 0.22))
        bm = chunk(s, seed * 10 + i, bev=0.03)
        transform(bm, (x, y, z), rot=(rng.uniform(-0.35, 0.35), rng.uniform(0, 3.1), rng.uniform(-0.3, 0.3)))
        A.add(bm, 'gingerbread', ROOF_TINT if i % 2 else (1, 1, 1))
    A.add(transform(drift((rx * 1.05, max(0.12, top * 0.55), rz * 1.05), seed=seed + 3, around=12), (cx, 0.0, cz)), 'snow')


def roof_piece(A, rng, cx, cz, hx_, hz_, y, tilt, yaw, seed):
    """A piece of the roof lying on the ground, icing side up, its scallops still on it."""
    th = 0.17
    out = [(-hx_, -hz_)] + jag(rng, (-hx_, -hz_), (hx_, -hz_), 5, 0.12) + [(hx_, -hz_)] + jag(rng, (hx_, -hz_), (hx_, hz_), 4, 0.14) + \
          [(hx_, hz_)] + jag(rng, (hx_, hz_), (-hx_, hz_), 5, 0.12) + [(-hx_, hz_)] + jag(rng, (-hx_, hz_), (-hx_, -hz_), 4, 0.14)
    bm = slab(out, [], th, bev=0.04, segs=2, max_len=0.6, seed=seed)
    parts = [(bm, 'gingerbread', ROOF_TINT)]
    for row in range(2):
        v0 = -hz_ * 0.45 + row * hz_ * 0.8
        path = [Vector((-hx_ * 0.85 + i * 0.66 / 8, -th / 2 - 0.02, v0 + 0.11 * abs(math.sin(math.pi * (i / 8 + row * 0.5))))) for i in range(int(hx_ * 1.7 / (0.66 / 8)) + 1)]
        parts.append((tube(path, 0.052, around=5, cap_steps=2), 'icing', (1, 1, 1)))
    for b, mat, tint in parts:
        transform(b, (0, 0, 0), rot=(-HALF + tilt, 0, 0))
        transform(b, (cx, y, cz), rot=(0, yaw, 0))
        A.add(b, mat, tint)


def build_ruin_a():
    """A gingerbread house with the roof gone and the walls bitten down to different heights."""
    h = GB
    rng = random.Random(11)
    A = Asset('ruinA')
    hx, hz, dw = h['hx'], h['hz'], h['doorW'] / 2
    L = hx - h['t']
    W, E, N, S = (Wall(c, h) for c in 'WENS')
    broken_wall(A, h, W, [(-hz, -dw, 2.7, True)], rng, clean=(True, True))
    broken_wall(A, h, W, [(dw, hz, 1.5, True)], rng, clean=(True, True))
    broken_wall(A, h, E, [(-hz, -dw, 2.7, True)], rng, clean=(True, True))
    broken_wall(A, h, E, [(dw, hz, 0.6, True)], rng, clean=(True, True))
    broken_wall(A, h, N, [(-L, -1.4, 0.5, True), (-1.4, 0.6, 1.3, True), (0.6, L, 2.4, True)], rng, clean=(True, True))
    broken_wall(A, h, S, [(-L, -1.6, 1.0, True)], rng, clean=(True, False))
    broken_wall(A, h, S, [(1.0, L, 2.0, True)], rng, clean=(False, True))
    # what is left of the decoration
    foot_sweets(A, h, N, -1.3, 3.5, rng); foot_sweets(A, h, S, -3.5, -1.7, rng); foot_sweets(A, h, S, 1.1, 3.5, rng)
    for w, lo, hi in ((W, -hz, -dw), (W, dw, hz), (E, -hz, -dw), (E, dw, hz)):
        foot_sweets(A, h, w, lo + 0.1, hi - 0.25, rng, band=not (w is E and lo > 0))
    A.add(tube(swirl(N, 2.3, 1.45, 0.4, 2.1, 0.03), 0.042, around=5, cap_steps=2), 'icing')
    A.add(tube(heart(W, -1.95, 1.2, 0.62, 0.03), 0.042, around=5, cap_steps=2), 'icing')
    A.add(tube(heart(E, -1.95, 1.2, 0.62, 0.03), 0.042, around=5, cap_steps=2), 'icing')
    A.add(tube(swirl(S, 2.4, 1.0, 0.3, 2.1, 0.03, flip=-1), 0.042, around=5, cap_steps=2), 'icing')
    # corners: piping as high as the lower of the two walls that meet there
    corner_piping(A, h, -hx, -hz, 2.1, 1); corner_piping(A, h, -hx, hz, 0.7, 2)
    corner_piping(A, h, hx, -hz, 0.3, 3); corner_piping(A, h, hx, hz, 1.7, 4)
    # one door still has a cane beside it
    put(A, small_cane(1.7, 0.075, 0.19), W, -(dw + 0.5), 0.0, 0.17, 'candy', uv='keep')
    put(A, drift((0.34, 0.2, 0.3), seed=4, around=10), W, -(dw + 0.5), 0.0, 0.2, 'snow')
    # the roof came down inside
    roof_piece(A, rng, 0.75, 0.3, 1.35, 0.95, 0.27, 0.1, 0.12, 5)
    rubble(A, rng, 0.2, 0.35, 1.2, 0.9, 0.42, n=3, seed=6)
    A.add(transform(gumdrop(0.19, 0.24, around=12), (1.9, 0.02, -0.9), rot=(0.5, 0, 0.3)), 'gumdrop', DROPS[1])
    A.add(transform(gumdrop(0.19, 0.24, around=12), (-1.2, 0.02, 1.1), rot=(-0.4, 0, 0.2)), 'gumdrop', DROPS[4])
    # chunks lying outside
    rubble(A, rng, 4.7, -1.5, 0.55, 0.45, 0.55, n=3, seed=7)
    rubble(A, rng, -1.0, 3.9, 0.75, 0.4, 0.46, n=3, seed=8)
    # snow drifted into the corners and against the walls
    for i, (x, z, sx, sz, sy) in enumerate(((-2.6, -1.9, 1.1, 0.9, 0.42), (2.6, 1.9, 1.0, 0.8, 0.4), (-3.4, 3.2, 1.2, 0.6, 0.34), (3.3, -3.2, 1.2, 0.6, 0.3), (-4.0, -1.6, 0.6, 1.0, 0.3), (2.4, 3.2, 1.2, 0.55, 0.32))):
        A.add(transform(drift((sx, sy, sz), seed=60 + i), (x, 0.0, z)), 'snow')
    return A, dict(target=(0, 1.2, 0), dist=15, yaw=52, pitch=22, lens=45, more=[dict(tag='b', yaw=215, pitch=14, dist=13)])


def build_ruin_b():
    """Half a gingerbread house: the west half still has its roof, the east half has fallen in."""
    h = GB
    rng = random.Random(23)
    A = Asset('ruinB')
    hx, hz, dw = h['hx'], h['hz'], h['doorW'] / 2
    L = hx - h['t']
    W, E, N, S = (Wall(c, h) for c in 'WENS')
    gb_end_wall(A, h, 'W')
    gb_end_deco(A, h, W, rng)
    broken_wall(A, h, N, [(-L, -2.0, 0.8, True), (-2.0, -0.2, 1.6, True), (-0.2, L, 2.95, False)], rng, clean=(True, True))
    broken_wall(A, h, S, [(-L, 0.2, 2.95, False), (0.2, 2.0, 1.1, True)], rng, clean=(True, False))
    broken_wall(A, h, E, [(1.2, hz, 0.5, True)], rng, clean=(False, True))
    R = gb_roof(A, h, rng, -hx - 0.45, 0.45, broken=True)
    R.snow(A, 1, -3.95, 0.2, 0.05, 0.7, 0.17, 31)
    R.snow(A, -1, -3.9, -0.3, 0.3, 0.97, 0.16, 32)
    foot_sweets(A, h, N, -1.9, 3.5, rng); foot_sweets(A, h, S, -3.5, 2.0, rng)
    A.add(tube(swirl(S, -2.72, 1.5, 0.4, 2.1, 0.03, flip=-1), 0.042, around=5, cap_steps=2), 'icing')
    A.add(tube(swirl(N, 2.72, 1.5, 0.4, 2.1, 0.03), 0.042, around=5, cap_steps=2), 'icing')
    A.add(tube(scallops(S, -2.2, -0.2, 2.2, 3, 0.17, 0.03), 0.045, around=5, cap_steps=2), 'icing')
    A.add(tube(scallops(N, 0.2, 2.2, 2.2, 3, 0.17, 0.03), 0.045, around=5, cap_steps=2), 'icing')
    corner_piping(A, h, -hx, -hz, h['wallH'] - 0.02, 1); corner_piping(A, h, -hx, hz, h['wallH'] - 0.02, 2)
    corner_piping(A, h, hx, -hz, 0.3, 3)
    # the fallen half: a heap where the roof came down, pieces of it still showing their icing
    roof_piece(A, rng, 2.05, 0.35, 0.85, 0.7, 0.36, 0.16, 0.5, 9)
    rubble(A, rng, 1.9, 0.3, 0.9, 0.8, 0.5, n=4, seed=12)
    A.add(transform(gumdrop(0.19, 0.24, around=12), (2.9, 0.05, -1.2), rot=(0.4, 0, -0.3)), 'gumdrop', DROPS[2])
    A.add(transform(gumdrop(0.19, 0.24, around=12), (1.2, 0.1, 1.6), rot=(-0.3, 0, 0.5)), 'gumdrop', DROPS[0])
    for i, (x, z, sx, sz, sy) in enumerate(((2.9, -1.9, 0.9, 0.8, 0.34), (-3.3, 3.2, 1.2, 0.6, 0.34), (-2.8, -3.2, 1.3, 0.6, 0.32), (2.3, 2.9, 1.0, 0.6, 0.3), (0.6, -3.2, 1.1, 0.5, 0.3))):
        A.add(transform(drift((sx, sy, sz), seed=80 + i), (x, 0.0, z)), 'snow')
    return A, dict(target=(0, 1.8, 0), dist=15, yaw=40, pitch=18, lens=45, more=[dict(tag='b', yaw=200, pitch=12, dist=13)])


# ───────────────────────── the log cabin ─────────────────────────
def log(A, p0, p1, r, seed=0, tint=(1, 1, 1), ends=(True, True)):
    """A peeled log between two GAME points: bark-brown round the side, sawn rings on the ends."""
    a, b = G(*p0), G(*p1)
    L = (b - a).length
    n = max(2, int(L / 0.55))
    rad = lambda t: r * (1 + 0.045 * math.sin(t * L * 2.3 + seed * 1.9) + 0.025 * math.sin(t * L * 6.1 + seed))
    bm = tube([a.lerp(b, i / n) for i in range(n + 1)], rad, around=10, tile_v=1.4, cap=False, v0=seed * 0.37)
    A.add(bm, 'log', tint, uv='keep')
    d = (b - a).normalized()
    e1 = d.orthogonal().normalized(); e2 = d.cross(e1)
    for flag, at, out in ((ends[0], a, -d), (ends[1], b, d)):
        if not flag: continue
        em = bmesh.new()
        uv = em.loops.layers.uv.new('UVMap')
        vs = [em.verts.new(at + (e1 * math.cos(k / 10 * 2 * math.pi) + e2 * math.sin(k / 10 * 2 * math.pi)) * r * 1.02) for k in range(10)]
        f = em.faces.new(vs)
        f.normal_update()
        if f.normal.dot(out) < 0: f.normal_flip()
        for l in f.loops:
            q = l.vert.co - at
            l[uv].uv = (0.5 + q.dot(e1) / r * 0.46, 0.5 + q.dot(e2) / r * 0.46)
        A.add(em, 'logend', tint, uv='keep')


def build_cabin():
    """A little log cabin under a thick blanket of snow: a door in each end, a window in each side."""
    h = CABIN
    rng = random.Random(3)
    A = Asset('cabin')
    hx, hz, t = h['hx'], h['hz'], h['t']
    r, pitch, stick = 0.168, 0.31, 0.3
    zc, xc = hz - t / 2, hx - t / 2
    dw, ww = h['doorW'] / 2, h['winW'] / 2
    R = Roof(h, over=0.4, thick=0.12)
    tone = lambda: (lambda v: (v, v * 0.97, v * 0.94))(rng.uniform(0.8, 1.05))
    seed = 0
    # long walls: nine courses, cut for the window
    for s in (-1, 1):
        for i in range(10):
            y = -0.12 + pitch * i
            seed += 1
            if h['sill'] - 0.08 < y < h['winTop'] - 0.05:
                log(A, (-hx - stick, y, s * zc), (-ww - 0.07, y, s * zc), r, seed, tone(), ends=(True, False))
                log(A, (ww + 0.07, y, s * zc), (hx + stick, y, s * zc), r, seed + 50, tone(), ends=(False, True))
            else:
                log(A, (-hx - stick, y, s * zc), (hx + stick, y, s * zc), r, seed, tone())
    # end walls: half a course out of step, cut for the door, then the gable
    for s in (-1, 1):
        for i in range(14):
            y = 0.035 + pitch * i
            seed += 1
            if y - r < h['doorH']:
                log(A, (s * xc, y, -hz - stick), (s * xc, y, -dw - 0.07), r, seed, tone(), ends=(True, False))
                log(A, (s * xc, y, dw + 0.07), (s * xc, y, hz + stick), r, seed + 50, tone(), ends=(False, True))
            else:
                half = hz + stick if y < h['wallH'] - 0.1 else (h['ridgeH'] - y - 0.32) * R.span / R.rise
                if half < 0.3: break
                log(A, (s * xc, y, -half), (s * xc, y, half), r, seed, tone())
    # sawn frames round the openings
    FR = (0.82, 0.74, 0.66)
    for s in (-1, 1):
        w = Wall('E' if s > 0 else 'W', h)
        for k in (-1, 1):
            put(A, bm_box(0.055, 1.18, 0.215, bev=0.015), w, k * (dw + 0.02), 0.86, -t / 2, 'wood', FR)
        put(A, bm_box(dw + 0.16, 0.06, 0.23, bev=0.015), w, 0, h['doorH'] + 0.05, -t / 2, 'wood', FR)
        w = Wall('S' if s > 0 else 'N', h)
        for k in (-1, 1):
            put(A, bm_box(0.05, 0.5, 0.215, bev=0.015), w, k * (ww + 0.02), (h['sill'] + h['winTop']) / 2 - 0.06, -t / 2, 'wood', FR)
        put(A, bm_box(ww + 0.12, 0.05, 0.225, bev=0.015), w, 0, h['winTop'] - 0.14, -t / 2, 'wood', FR)
        put(A, bm_box(ww + 0.16, 0.045, 0.27, bev=0.015), w, 0, h['sill'] - 0.04, -t / 2 + 0.03, 'wood', FR)
        A.add(pipe([w.g(-ww - 0.1 + (2 * ww + 0.2) * i / 8, h['sill'] + 0.03, 0.03) for i in range(9)], 0.075, wobble=0.25, seed=3 + s), 'snow')
        # red shutters
        for k in (-1, 1):
            put(A, bm_box(0.25, 0.56, 0.03, bev=0.012), w, k * (ww + 0.34), (h['sill'] + h['winTop']) / 2, 0.03, 'wood', (0.62, 0.1, 0.07))
            for dy in (-0.36, 0.36):
                put(A, bm_box(0.25, 0.045, 0.012, bev=0.006), w, k * (ww + 0.34), (h['sill'] + h['winTop']) / 2 + dy, 0.07, 'wood', (0.4, 0.06, 0.05))
    # the roof: planks, then the snow lying on them
    half = R.ln / 2
    X = hx + 0.55
    for s in (-1, 1):
        A.add(R.sheet(s, [(-X, -half), (X, -half), (X, half), (-X, half)], bev=0.02, segs=1, max_len=0.7, wobble=0.0), 'wood', (0.52, 0.47, 0.44))
        for xe in (-X + 0.03, X - 0.03):
            R.put(A, bm_box(0.04, 0.1, half, bev=0.015), s, xe, 0.5, 'wood', (0.7, 0.62, 0.55), lift=-0.07)
        blanket = bm_box(X + 0.07, 0.125, half + 0.08, bev=0.115, segs=3)
        refine(blanket, 0.42); displace(blanket, 0.05, 0.9, 7 + s); shade(blanket, 70)
        R.put(A, blanket, s, 0, 0.5, 'snow', lift=0.115)
        x = -X + 0.2
        while x < X - 0.1:
            ln = rng.uniform(0.14, 0.62)
            A.add(transform(icicle(ln, 0.035 + ln * 0.035), R.p(s, x, 1.035, 0.06)), 'ice')
            x += rng.uniform(0.28, 0.75)
    A.add(pipe([G(-X - 0.05 + (2 * X + 0.1) * i / 22, h['ridgeH'] + R.top + 0.2, 0) for i in range(23)], 0.2, around=9, wobble=0.14, seed=2, cap_steps=3), 'snow')
    # a river-stone chimney through the north slope
    cx, cz = -1.75, -1.25
    st = bm_box(0.42, 0.75, 0.36, bev=0.06, segs=2); refine(st, 0.3); displace(st, 0.035, 2.2, 3); shade(st, 50)
    A.add(transform(st, (cx, 4.33, cz)), 'stone')
    capst = bm_box(0.5, 0.07, 0.44, bev=0.04, segs=2); refine(capst, 0.3); displace(capst, 0.02, 2.5, 5); shade(capst, 50)
    A.add(transform(capst, (cx, 5.12, cz)), 'stone', (0.85, 0.85, 0.88))
    A.add(transform(drift((0.5, 0.26, 0.45), seed=5, around=12), (cx, 5.19, cz)), 'snow')
    # a wreath on each gable, a lantern by each door
    for s in (-1, 1):
        w = Wall('E' if s > 0 else 'W', h)
        ring = [w.g(math.cos(a) * 0.36, 3.02 + math.sin(a) * 0.36, 0.1) for a in [i / 18 * 2 * math.pi for i in range(19)]]
        wr = tube(ring, 0.105, around=7, cap=False); displace(wr, 0.035, 9, 2 + s)
        A.add(wr, 'ribbon', (0.04, 0.2, 0.07))
        for i in range(6):
            a = i / 6 * 2 * math.pi + 0.4
            put(A, blob(0.045, sub=1), w, math.cos(a) * 0.36, 3.02 + math.sin(a) * 0.36, 0.2, 'ribbon', (0.75, 0.04, 0.05))
        put(A, blob(0.11, sub=2, squash=(1.5, 0.8, 0.6)), w, 0, 2.66, 0.2, 'ribbon', (0.75, 0.04, 0.05))
        A.add(tube([w.g(1.2, 2.02, 0.0), w.g(1.2, 2.08, 0.3), w.g(1.2, 1.98, 0.36)], 0.018, around=5, cap_steps=1), 'metal')
        put(A, bm_box(0.075, 0.1, 0.075, bev=0.02), w, 1.2, 1.84, 0.36, 'glow')
        put(A, bm_box(0.1, 0.02, 0.1, bev=0.01), w, 1.2, 1.955, 0.36, 'metal')
        put(A, bm_box(0.09, 0.015, 0.09, bev=0.008), w, 1.2, 1.73, 0.36, 'metal')
    # snow against the walls, a lantern hanging inside
    for i, (x, z, sx, sz) in enumerate(((3.0, 3.0, 1.2, 0.6), (-2.9, 3.0, 1.3, 0.62), (-3.1, -3.0, 1.1, 0.6), (2.8, -3.0, 1.3, 0.62), (3.75, -1.9, 0.5, 0.9), (-3.75, 1.9, 0.5, 0.9))):
        A.add(transform(drift((sx, 0.4, sz), seed=90 + i), (x, 0.0, z)), 'snow')
    A.add(tube([G(0, 4.2, 0), G(0, 3.5, 0)], 0.016, around=5, cap=False), 'rope')
    A.add(transform(bm_box(0.11, 0.14, 0.11, bev=0.03), (0, 3.36, 0)), 'glow')
    A.add(transform(bm_box(0.14, 0.02, 0.14, bev=0.01), (0, 3.52, 0)), 'metal')
    return A, dict(target=(0, 2.0, 0), dist=15, yaw=58, pitch=13, lens=45, more=[dict(tag='b', yaw=-25, pitch=8, dist=12.5)])
