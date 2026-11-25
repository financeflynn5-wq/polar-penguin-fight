"""Geometry toolkit: shapes are described as smooth implicit functions (numpy) and turned into clean quad grids.

Conventions: Blender space, metres. The penguin faces +Y, up is +Z, its right is +X (glTF export turns that into
the game's -Z forward / +Y up).
"""
import math
import numpy as np
import bpy

# ───────────────────────── implicit functions ─────────────────────────
# Each returns f(p) for p of shape (..., 3): negative inside, positive outside, roughly a distance in metres.


def _a(v):
    return np.asarray(v, dtype=np.float64)


def sphere(c, r):
    c = _a(c)
    return lambda p: np.linalg.norm(p - c, axis=-1) - r


def ellipsoid(c, r, rot=None):
    """rot: optional 3x3 matrix whose columns are the ellipsoid's local axes in world space."""
    c = _a(c); r = _a(r)
    R = None if rot is None else _a(rot)

    def f(p):
        q = p - c
        if R is not None:
            q = q @ R
        k0 = np.linalg.norm(q / r, axis=-1)
        k1 = np.linalg.norm(q / (r * r), axis=-1)
        return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)
    return f


def capsule(a, b, ra, rb=None):
    """A rounded cone from a (radius ra) to b (radius rb)."""
    a = _a(a); b = _a(b)
    rb = ra if rb is None else rb
    ab = b - a
    L2 = float(ab @ ab)

    def f(p):
        t = np.clip(((p - a) @ ab) / L2, 0.0, 1.0)
        q = p - (a + t[..., None] * ab)
        return np.linalg.norm(q, axis=-1) - (ra + (rb - ra) * t)
    return f


def box(c, half, round_=0.0):
    c = _a(c); half = _a(half)

    def f(p):
        q = np.abs(p - c) - (half - round_)
        return np.linalg.norm(np.maximum(q, 0.0), axis=-1) + np.minimum(np.max(q, axis=-1), 0.0) - round_
    return f


def plane(n, d):
    """Inside is the half-space n.p < d."""
    n = _a(n); n = n / np.linalg.norm(n)
    return lambda p: p @ n - d


def smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1 - h) + a * h - k * h * (1 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def union(k, *fs):
    def f(p):
        d = fs[0](p)
        for g in fs[1:]:
            d = smin(d, g(p), k)
        return d
    return f


def add(base, other, k):
    return lambda p: smin(base(p), other(p), k)


def cut(base, other, k):
    return lambda p: smax(base(p), -other(p), k)


def clip(base, other, k):
    return lambda p: smax(base(p), other(p), k)


def offset(base, d):
    """d: number or function of p."""
    if callable(d):
        return lambda p: base(p) - d(p)
    return lambda p: base(p) - d


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ───────────────────────── frames ─────────────────────────

def frame_from_axis(axis, ref=(0, 1, 0)):
    """Orthonormal (e1, e2, e3) with e3 along axis; e1 is ref made perpendicular to it (θ = 0 direction)."""
    e3 = _a(axis); e3 = e3 / np.linalg.norm(e3)
    r = _a(ref)
    if abs(r @ e3) > 0.98:
        r = _a((1, 0, 0)) if abs(e3[0]) < 0.9 else _a((0, 0, 1))
    e1 = r - (r @ e3) * e3; e1 /= np.linalg.norm(e1)
    e2 = np.cross(e3, e1)
    return e1, e2, e3


def path_frames(P, ref=(0, 0, 1), closed=False):
    """Rotation-minimising frames along a polyline P (N,3). Returns tangents T, normals N, binormals B."""
    P = _a(P); n = len(P)
    T = np.zeros_like(P)
    for i in range(n):
        if closed:
            d = P[(i + 1) % n] - P[(i - 1) % n]
        else:
            d = P[min(i + 1, n - 1)] - P[max(i - 1, 0)]
        T[i] = d / np.linalg.norm(d)
    N = np.zeros_like(P); B = np.zeros_like(P)
    r = _a(ref)
    if abs(r @ T[0]) > 0.98:
        r = _a((1, 0, 0))
    N[0] = r - (r @ T[0]) * T[0]; N[0] /= np.linalg.norm(N[0])
    B[0] = np.cross(T[0], N[0])
    for i in range(1, n):
        v = N[i - 1] - (N[i - 1] @ T[i]) * T[i]
        N[i] = v / np.linalg.norm(v)
        B[i] = np.cross(T[i], N[i])
    if closed:
        # spread the leftover twist evenly so the loop closes
        v = N[-1] - (N[-1] @ T[0]) * T[0]; v /= np.linalg.norm(v)
        ang = math.atan2(np.cross(v, N[0]) @ T[0], v @ N[0])
        for i in range(n):
            a = ang * i / n
            Ni = N[i] * math.cos(a) + B[i] * math.sin(a)
            N[i] = Ni; B[i] = np.cross(T[i], Ni)
    return T, N, B


def resample(P, n, closed=False):
    """Resample a polyline to n evenly spaced points through a Catmull-Rom spline."""
    P = _a(P)
    m = len(P)
    dense = []
    segs = m if closed else m - 1
    for i in range(segs):
        p0 = P[(i - 1) % m] if closed else P[max(i - 1, 0)]
        p1 = P[i]; p2 = P[(i + 1) % m]
        p3 = P[(i + 2) % m] if closed else P[min(i + 2, m - 1)]
        for t in np.linspace(0, 1, 24, endpoint=False):
            t2 = t * t; t3 = t2 * t
            dense.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    dense.append(P[0] if closed else P[-1])
    D = np.array(dense)
    seg = np.linalg.norm(np.diff(D, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    want = np.linspace(0, s[-1], n, endpoint=not closed)
    out = np.stack([np.interp(want, s, D[:, k]) for k in range(3)], axis=1)
    return out


# ───────────────────────── grid → mesh ─────────────────────────

class Grid:
    """A (rows, cols, 3) grid of points with flags, ready to become a mesh."""

    def __init__(self, P, closed_u=True, pole0=False, pole1=False, flip=False, weld=False):
        self.P = _a(P)
        self.closed_u = closed_u
        self.pole0 = pole0
        self.pole1 = pole1
        self.flip = flip
        self.weld = weld


def build_mesh(name, grids, collection=None):
    """Make one object out of one or more Grids. Each grid becomes a UV island with two layers:
    'param' (u, v in metres along the surface, for pattern scale) and 'atlas' (same rectangle, packed later).
    Vertex colour-free; island rectangles are recorded in ob['islands'] for the packer."""
    verts = []; faces = []; loop_uv = []; islands = []
    for g in (grids if isinstance(grids, (list, tuple)) else [grids]):
        P = g.P; R, C, _ = P.shape
        base = len(verts)
        idx = np.zeros((R, C), dtype=np.int64)
        for i in range(R):
            if (i == 0 and g.pole0) or (i == R - 1 and g.pole1):
                verts.append(tuple(P[i].mean(axis=0)))
                idx[i, :] = len(verts) - 1
            else:
                for j in range(C):
                    verts.append(tuple(P[i, j])); idx[i, j] = len(verts) - 1
        # param scale: width = longest ring, height = mean column length
        ring = np.linalg.norm(np.diff(np.concatenate([P, P[:, :1]], axis=1) if g.closed_u else P, axis=1), axis=2).sum(axis=1)
        width = float(ring.max())
        col = np.linalg.norm(np.diff(P, axis=0), axis=2)
        vlen = np.concatenate([[0], np.cumsum(col.mean(axis=1))])
        height = float(vlen[-1])
        nu = C if g.closed_u else C - 1
        isl = len(islands)
        islands.append((width, height))
        for i in range(R - 1):
            for j in range(nu):
                j2 = (j + 1) % C
                a, b, c, d = idx[i, j], idx[i, j2], idx[i + 1, j2], idx[i + 1, j]
                u0, u1 = j / nu, (j + 1) / nu
                v0, v1 = vlen[i] / height, vlen[i + 1] / height
                quad = [(a, (u0, v0)), (b, (u1, v0)), (c, (u1, v1)), (d, (u0, v1))]
                # collapse pole edges into triangles
                seen = []; poly = []
                for vi, uv in quad:
                    if vi in seen:
                        continue
                    seen.append(vi); poly.append((vi, uv))
                if len(poly) < 3:
                    continue
                if g.flip:
                    poly = poly[::-1]
                faces.append([vi for vi, _ in poly])
                loop_uv.append([(uv, isl) for _, uv in poly])
        _ = base
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    uvp = me.uv_layers.new(name='atlas')
    uvm = me.uv_layers.new(name='param')
    li = 0
    isl_attr = []
    for f in loop_uv:
        for (uv, isl) in f:
            w, h = islands[isl]
            uvp.data[li].uv = (uv[0] * w, uv[1] * h)
            uvm.data[li].uv = (uv[0] * w, uv[1] * h)
            isl_attr.append(isl)
            li += 1
    a = me.attributes.new('island', 'INT', 'CORNER')
    a.data.foreach_set('value', isl_attr)
    if any(g.weld for g in (grids if isinstance(grids, (list, tuple)) else [grids])):
        import bmesh
        bm = bmesh.new(); bm.from_mesh(me)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
        bm.to_mesh(me); bm.free()
    me.shade_smooth()
    me.update()
    # outward-facing: the divergence theorem says sum(area * n.(c - centroid)) is positive when normals point out
    npoly = len(me.polygons)
    nn = np.zeros(npoly * 3); me.polygons.foreach_get('normal', nn); nn = nn.reshape(-1, 3)
    cc = np.zeros(npoly * 3); me.polygons.foreach_get('center', cc); cc = cc.reshape(-1, 3)
    ar = np.zeros(npoly); me.polygons.foreach_get('area', ar)
    cen = (cc * ar[:, None]).sum(axis=0) / ar.sum()
    if float((ar * ((cc - cen) * nn).sum(axis=1)).sum()) < 0:
        me.flip_normals()
        me.update()
    ob = bpy.data.objects.new(name, me)
    (collection or bpy.context.scene.collection).objects.link(ob)
    ob['islands'] = [list(x) for x in islands]
    return ob


# ───────────────────────── blobs (implicit → grid) ─────────────────────────

def _solve(f, O, D, tmax, iters=44):
    """For rays O + t*D find the outermost zero crossing of f in (0, tmax) by coarse scan + bisection."""
    n = 96
    ts = np.linspace(0, tmax, n)
    lo = np.zeros(O.shape[:-1]); hi = np.full(O.shape[:-1], tmax)
    prev = f(O)
    found = np.zeros(O.shape[:-1], dtype=bool)
    # scan from the outside in, so we get the outer skin
    vals_out = f(O + D * tmax)
    cur = vals_out; tcur = np.full(O.shape[:-1], tmax)
    for k in range(n - 2, -1, -1):
        v = f(O + D * ts[k])
        hit = (~found) & (v < 0) & (cur >= 0)
        lo = np.where(hit, ts[k], lo); hi = np.where(hit, tcur, hi)
        found |= hit
        upd = ~found
        cur = np.where(upd, v, cur); tcur = np.where(upd, ts[k], tcur)
    _ = prev
    for _i in range(iters):
        mid = 0.5 * (lo + hi)
        v = f(O + D * mid[..., None])
        inside = v < 0
        lo = np.where(inside, mid, lo); hi = np.where(inside, hi, mid)
    t = 0.5 * (lo + hi)
    t = np.where(found, t, 0.0)
    return O + D * t[..., None]


def blob(f, a, b=None, nu=32, nv=24, ref=(0, 1, 0), cap_r=0.2, tmax=2.0, v_bias=None):
    """Mesh the skin of implicit f, seen from a capsule skeleton a→b (b=None: a point). Rows run from the far side
    of a (pole) to the far side of b (pole); columns go round the axis. cap_r is only used to share rows out
    between the caps and the shaft."""
    a = _a(a)
    b = a + _a((0, 0, 1e-6)) if b is None else _a(b)
    e1, e2, e3 = frame_from_axis(b - a, ref)
    L = float(np.linalg.norm(b - a))
    arc_cap = math.pi * cap_r / 2
    total = 2 * arc_cap + L
    s = np.linspace(0, total, nv + 1)
    if v_bias is not None:
        s = total * v_bias(np.linspace(0, 1, nv + 1))
    th = np.linspace(0, 2 * math.pi, nu, endpoint=False)
    O = np.zeros((nv + 1, nu, 3)); D = np.zeros((nv + 1, nu, 3))
    for i, si in enumerate(s):
        if si <= arc_cap:
            o = a; phi = -math.pi / 2 + (si / arc_cap) * (math.pi / 2)
        elif si >= arc_cap + L:
            o = b; phi = ((si - arc_cap - L) / arc_cap) * (math.pi / 2)
        else:
            o = a + e3 * (si - arc_cap); phi = 0.0
        O[i, :] = o
        D[i, :] = (np.cos(th)[:, None] * e1 + np.sin(th)[:, None] * e2) * math.cos(phi) + e3 * math.sin(phi)
    P = _solve(f, O, D, tmax)
    return Grid(P, closed_u=True, pole0=True, pole1=True)


# ───────────────────────── sweeps ─────────────────────────

def sweep(path, section, nu=16, closed=False, ref=(0, 0, 1), cap=True, cap_rows=4, twist=None):
    """Sweep a cross-section along a path. section(t, theta) → (x, y) offsets in the path frame (N, B), where
    t ∈ [0,1] is the position along the path and theta is an array. cap: round the open ends off to a pole."""
    P = _a(path); n = len(P)
    T, N, B = path_frames(P, ref, closed)
    th = np.linspace(0, 2 * math.pi, nu, endpoint=False)
    rows = []
    seglen = np.linalg.norm(np.diff(P, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seglen)])
    tt = s / s[-1] if not closed else np.arange(n) / n

    def ring(i, scale=1.0, shift=0.0):
        x, y = section(tt[i], th)
        if twist is not None:
            a = twist(tt[i]); c, sn = math.cos(a), math.sin(a)
            x, y = x * c - y * sn, x * sn + y * c
        return P[i] + T[i] * shift + (N[i] * (x * scale)[:, None] + B[i] * (y * scale)[:, None])

    if cap and not closed:
        x, y = section(tt[0], th); r0 = float(np.mean(np.hypot(x, y)))
        for k in range(cap_rows):
            a = (k / cap_rows) * math.pi / 2
            rows.append(ring(0, math.sin(a), -r0 * math.cos(a) * 0.9))
    for i in range(n):
        rows.append(ring(i))
    if cap and not closed:
        x, y = section(tt[-1], th); r1 = float(np.mean(np.hypot(x, y)))
        for k in range(cap_rows - 1, -1, -1):
            a = (k / cap_rows) * math.pi / 2
            rows.append(ring(n - 1, math.sin(a), r1 * math.cos(a) * 0.9))
    Pg = np.array(rows)
    if closed:
        Pg = np.concatenate([Pg, Pg[:1]], axis=0)  # repeat the first ring; build_mesh welds the seam
        return Grid(Pg, closed_u=True, weld=True)
    return Grid(Pg, closed_u=True, pole0=cap, pole1=cap)


def superellipse(a, b, n=2.0):
    """Section function pieces: returns (x, y) for theta with half-widths a, b and exponent n (2 = ellipse)."""
    def f(theta):
        c = np.cos(theta); s = np.sin(theta)
        return a * np.sign(c) * np.abs(c) ** (2.0 / n), b * np.sign(s) * np.abs(s) ** (2.0 / n)
    return f


def lathe(profile, nu=32, closed_ends=(False, False), axis=(0, 0, 1), origin=(0, 0, 0), ref=(0, 1, 0)):
    """Revolve a profile [(r, h), ...] about an axis. closed_ends: treat first / last row as poles (r = 0)."""
    e1, e2, e3 = frame_from_axis(axis, ref)
    th = np.linspace(0, 2 * math.pi, nu, endpoint=False)
    o = _a(origin)
    rows = [o + e3 * h + (np.cos(th)[:, None] * e1 + np.sin(th)[:, None] * e2) * r for r, h in profile]
    return Grid(np.array(rows), closed_u=True, pole0=closed_ends[0], pole1=closed_ends[1])


def smooth_profile(pts, n):
    """Catmull-Rom through 2D control points, resampled evenly to n points."""
    P3 = np.array([(p[0], p[1], 0.0) for p in pts])
    return [(float(x), float(y)) for x, y, _ in resample(P3, n)]


# ───────────────────────── mesh utilities ─────────────────────────

def positions(ob):
    v = np.zeros(len(ob.data.vertices) * 3)
    ob.data.vertices.foreach_get('co', v)
    return v.reshape(-1, 3)


def set_positions(ob, P):
    ob.data.vertices.foreach_set('co', np.asarray(P, dtype=np.float64).reshape(-1))
    ob.data.update()


def vertex_normals(ob):
    n = np.zeros(len(ob.data.vertices) * 3)
    ob.data.vertices.foreach_get('normal', n)
    return n.reshape(-1, 3)


def displace(ob, fn):
    """Move every vertex along its normal by fn(P) metres."""
    P = positions(ob); N = vertex_normals(ob)
    set_positions(ob, P + N * np.asarray(fn(P))[:, None])


def transform(ob, M):
    """Bake a 4x4 matrix into the vertices."""
    from mathutils import Matrix
    ob.data.transform(Matrix(M))
    ob.data.update()


def join(objs, name):
    """Join objects into one without bpy.ops (which is crash-prone headless). Keeps the 'atlas' / 'param' UVs, island
    ids (offset per object), materials, vertex groups and smooth / sharp shading."""
    verts = []; faces = []; mat_idx = []; smooth = []
    uvs = {'atlas': [], 'param': []}
    isl_vals = []; islands = []; mats = []; groups = {}
    has_uv = all(('atlas' in o.data.uv_layers and 'param' in o.data.uv_layers) for o in objs)
    has_isl = all('island' in o.data.attributes for o in objs)
    for o in objs:
        me = o.data
        base = len(verts)
        P = positions(o)
        M = np.array(o.matrix_world)
        P = P @ M[:3, :3].T + M[:3, 3]
        verts += [tuple(v) for v in P]
        slot_map = []
        for sl in o.material_slots:
            if sl.material not in mats:
                mats.append(sl.material)
            slot_map.append(mats.index(sl.material))
        for poly in me.polygons:
            faces.append([base + v for v in poly.vertices])
            mat_idx.append(slot_map[poly.material_index] if slot_map else 0)
            smooth.append(poly.use_smooth)
        n = len(me.loops)
        if has_uv:
            for k in uvs:
                a = np.zeros(n * 2); me.uv_layers[k].data.foreach_get('uv', a)
                uvs[k].append(a)
        if has_isl:
            a = np.zeros(n, dtype=np.int32); me.attributes['island'].data.foreach_get('value', a)
            isl_vals.append(a + len(islands))
            islands += [list(x) for x in o.get('islands', [])]
        for vg in o.vertex_groups:
            d = groups.setdefault(vg.name, {})
            for v in me.vertices:
                for ge in v.groups:
                    if ge.group == vg.index and ge.weight > 0:
                        d[base + v.index] = ge.weight
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    me.polygons.foreach_set('use_smooth', smooth)
    for m in mats:
        me.materials.append(m)
    if mats:
        me.polygons.foreach_set('material_index', mat_idx)
    if has_uv:
        for k in ('atlas', 'param'):
            layer = me.uv_layers.new(name=k)
            layer.data.foreach_set('uv', np.concatenate(uvs[k]))
        me.uv_layers.active = me.uv_layers['atlas']
        me.uv_layers['atlas'].active_render = True
    if has_isl:
        a = me.attributes.new('island', 'INT', 'CORNER')
        a.data.foreach_set('value', np.concatenate(isl_vals).astype(np.int32))
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    for gname, d in groups.items():
        vg = ob.vertex_groups.new(name=gname)
        for vi, w in d.items():
            vg.add([vi], w, 'REPLACE')
    ob['islands'] = islands
    for o in objs:
        old = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if old.users == 0:
            bpy.data.meshes.remove(old)
    return ob


def tri_count(objs):
    n = 0
    for o in objs:
        for p in o.data.polygons:
            n += len(p.vertices) - 2
    return n


# ───────────────────────── more builders (hats) ─────────────────────────

def dome(f, center, rim, nu=40, nv=14, ref=(0, 1, 0), tmax=1.0, up=(0, 0, 1)):
    """The skin of implicit f seen from `center`, from a rim up to the pole. rim: elevation (radians) of the rim,
    a number or a function of theta (theta = 0 along ref, counter-clockwise seen from above)."""
    e1, e2, e3 = frame_from_axis(up, ref)
    th = np.linspace(0, 2 * math.pi, nu, endpoint=False)
    r0 = np.array([rim(t) if callable(rim) else rim for t in th])
    O = np.zeros((nv + 1, nu, 3)); D = np.zeros((nv + 1, nu, 3))
    for i in range(nv + 1):
        k = i / nv
        el = r0 + (math.pi / 2 - r0) * k
        D[i] = (np.cos(th)[:, None] * e1 + np.sin(th)[:, None] * e2) * np.cos(el)[:, None] + e3 * np.sin(el)[:, None]
        O[i] = _a(center)
    P = _solve(f, O, D, tmax)
    return Grid(P, closed_u=True, pole1=True)


def round_profile(pts, radius=0.004, segs=3):
    """Round the corners of a lathe profile [(r, h), ...]. radius: one number or one per interior point."""
    pts = [np.array(p, dtype=float) for p in pts]
    out = [tuple(pts[0])]
    for i in range(1, len(pts) - 1):
        p0, p1, p2 = pts[i - 1], pts[i], pts[i + 1]
        r = radius[i - 1] if isinstance(radius, (list, tuple)) else radius
        d0 = p0 - p1; d2 = p2 - p1
        l0 = np.linalg.norm(d0); l2 = np.linalg.norm(d2)
        r = min(r, l0 * 0.45, l2 * 0.45)
        if r <= 1e-6:
            out.append(tuple(p1)); continue
        a = p1 + d0 / l0 * r; b = p1 + d2 / l2 * r
        for k in range(segs + 1):
            t = k / segs
            q = (1 - t) ** 2 * a + 2 * (1 - t) * t * p1 + t * t * b
            out.append(tuple(q))
    out.append(tuple(pts[-1]))
    return out


def slab(outline, thickness, origin=(0, 0, 0), x=(1, 0, 0), y=(0, 1, 0), bevel=0.25, bulge=0.0, n_inset=2):
    """A flat piece with rounded edges from a closed 2D outline (list of (u, v), star-shaped about its centroid).
    It lies in the plane spanned by x and y through origin; thickness goes along x × y. bulge puffs the faces."""
    o = _a(origin); ex = _a(x); ey = _a(y)
    ex = ex / np.linalg.norm(ex); ey = ey - (ey @ ex) * ex; ey /= np.linalg.norm(ey)
    ez = np.cross(ex, ey)
    Q = np.array(outline, dtype=float)
    c = Q.mean(axis=0)
    t = thickness / 2
    b = min(bevel * thickness, t * 0.95)
    rows = []

    def ring(scale, z):
        q = c + (Q - c) * scale
        return o + q[:, :1] * ex + q[:, 1:2] * ey + ez * z
    rmin = float(np.min(np.linalg.norm(Q - c, axis=1)))
    edge = 1.0 - b / max(rmin, 1e-6)
    rows.append(ring(0.0, t + bulge))
    for k in range(n_inset):
        s = (k + 1) / (n_inset + 1)
        rows.append(ring(s * edge, t + bulge * (1 - s * s)))
    rows.append(ring(edge, t))
    rows.append(ring(1.0 - 0.3 * (1 - edge), t - b * 0.3))
    rows.append(ring(1.0, t - b))
    rows.append(ring(1.0, -t + b))
    rows.append(ring(1.0 - 0.3 * (1 - edge), -t + b * 0.3))
    rows.append(ring(edge, -t))
    for k in range(n_inset - 1, -1, -1):
        s = (k + 1) / (n_inset + 1)
        rows.append(ring(s * edge, -t - bulge * (1 - s * s)))
    rows.append(ring(0.0, -t - bulge))
    return Grid(np.array(rows), closed_u=True, pole0=True, pole1=True)


def set_origin(ob, pivot):
    """Move the object's origin to pivot without moving the mesh in the world."""
    pivot = _a(pivot)
    set_positions(ob, positions(ob) - pivot)
    ob.location = tuple(pivot)


def flat_shade(ob):
    ob.data.polygons.foreach_set('use_smooth', [False] * len(ob.data.polygons))
    ob.data.update()
