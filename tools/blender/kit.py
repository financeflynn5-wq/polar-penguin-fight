"""Shared helpers for building the props in Blender (run with Blender's Python, `bpy`).

Conventions
- Everything is written in GAME coordinates: x east, y up, z south, metres, with the prop's origin on the snow at its
  centre. `G()` turns a game point into Blender's (x, -z, y), and the glTF exporter turns it back.
- Geometry is collected per material. An asset ends up as one mesh per material, which the game draws instanced.
- Materials are only NAMES as far as the game is concerned (src/render/PropMaterials.ts builds the real ones from the
  shared tiling textures in public/textures). Here they get the same textures so review renders look like the game.
- UVs are box-projected in metres / `tile`, so the tiling textures line up across separate pieces.
- Vertex colours carry a tint multiplied by ambient occlusion that is ray-cast here (so pieces shade each other and
  the snow they stand on).
"""
import bpy, bmesh, math, os, random
from mathutils import Vector, Matrix, noise
from mathutils.bvhtree import BVHTree

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
TEX = os.path.join(ROOT, 'public', 'textures')
MODELS = os.path.join(ROOT, 'public', 'models')

# name -> how Blender should preview it. `tex` is the texture set, `tile` the size in metres of one repeat.
MATERIALS = {
    'gingerbread': dict(tex='gingerbread', tile=1.6),
    'icing': dict(tex='icing', tile=0.8),
    'candy': dict(tex='candy', tile=1.0, coat=1.0, rough=0.9),
    'mint': dict(tex='mint', tile=1.0, coat=1.0),
    'gumdrop': dict(tex='sugar', tile=0.35, sss=0.25),
    'wood': dict(tex='wood', tile=1.2),
    'log': dict(tex='log', tile=1.4),
    'logend': dict(tex='logend', tile=1.0),
    'snow': dict(tex='snow', tile=1.5, sss=0.4),
    'ice': dict(tex='ice', tile=1.3, coat=1.0, ior=1.31),
    'canvas': dict(tex='canvas', tile=0.5),
    'stone': dict(tex='stone', tile=0.9),
    'metal': dict(color=(0.32, 0.34, 0.38), rough=0.38, metal=1.0),
    'rope': dict(color=(0.55, 0.42, 0.25), rough=0.9),
    'ribbon': dict(color=(1, 1, 1), rough=0.45, sheen=0.5),
    'glow': dict(color=(1.0, 0.72, 0.35), rough=0.4, emit=6.0),
    # vehicles (tools/blender/vehicles.py). `paint` is baked light grey and multiplied by the team colour in the game;
    # `trim` and `seat` are white here and take their colour from the vertex tint.
    'paint': dict(color=(1, 1, 1), rough=0.34, coat=1.0),
    'trim': dict(color=(1, 1, 1), rough=0.5),
    'rubber': dict(color=(0.022, 0.023, 0.026), rough=0.85),
    'tread': dict(tex='tread', tile=1.0),
    'glass': dict(color=(0.55, 0.75, 0.9), rough=0.05, alpha=0.3),
    'chrome': dict(color=(0.85, 0.87, 0.9), rough=0.12, metal=1.0),
    'seat': dict(color=(1, 1, 1), rough=0.55, sheen=0.3),
    'beacon': dict(color=(1.0, 0.45, 0.04), rough=0.3, emit=5.0),
    'lamp_red': dict(color=(1.0, 0.06, 0.04), rough=0.3, emit=3.0),
}


def G(x, y, z):
    """Game (x east, y up, z south) -> Blender (x, y north, z up)."""
    return Vector((x, -z, y))


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for m in list(bpy.data.materials): bpy.data.materials.remove(m)


_mats = {}


def material(name):
    if name in _mats: return _mats[name]
    spec = MATERIALS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    col = nt.nodes.new('ShaderNodeVertexColor')
    col.layer_name = 'Col'
    mul = nt.nodes.new('ShaderNodeMix')
    mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'
    mul.inputs[0].default_value = 1.0
    nt.links.new(col.outputs['Color'], mul.inputs[7])
    if 'tex' in spec:
        def img(kind, cs):
            n = nt.nodes.new('ShaderNodeTexImage')
            n.image = bpy.data.images.load(os.path.join(TEX, f"{spec['tex']}_{kind}.webp"), check_existing=True)
            n.image.colorspace_settings.name = cs
            return n
        c = img('color', 'sRGB')
        nt.links.new(c.outputs['Color'], mul.inputs[6])
        nrm = img('normal', 'Non-Color')
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(nrm.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
        orm = img('orm', 'Non-Color')
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(orm.outputs['Color'], sep.inputs['Color'])
        if spec.get('rough', 1.0) != 1.0:
            rm = nt.nodes.new('ShaderNodeMath'); rm.operation = 'MULTIPLY'; rm.inputs[1].default_value = spec['rough']
            nt.links.new(sep.outputs['Green'], rm.inputs[0]); nt.links.new(rm.outputs[0], bsdf.inputs['Roughness'])
        else:
            nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
        # the texture's own cavity occlusion darkens the colour a little, as aoMap does in the game
        ao = nt.nodes.new('ShaderNodeMix'); ao.data_type = 'RGBA'; ao.blend_type = 'MULTIPLY'; ao.inputs[0].default_value = 0.6
        nt.links.new(mul.outputs[2], ao.inputs[6]); nt.links.new(sep.outputs['Red'], ao.inputs[7])
        nt.links.new(ao.outputs[2], bsdf.inputs['Base Color'])
    else:
        mul.inputs[6].default_value = (*spec['color'], 1)
        nt.links.new(mul.outputs[2], bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = spec.get('rough', 0.5)
    bsdf.inputs['Metallic'].default_value = spec.get('metal', 0.0)
    if spec.get('coat'):
        bsdf.inputs['Coat Weight'].default_value = spec['coat']
        bsdf.inputs['Coat Roughness'].default_value = 0.08
    if spec.get('sss'):
        bsdf.inputs['Subsurface Weight'].default_value = spec['sss']
        bsdf.inputs['Subsurface Radius'].default_value = (0.08, 0.08, 0.1)
        bsdf.inputs['Subsurface Scale'].default_value = 0.25
    if spec.get('sheen'):
        bsdf.inputs['Sheen Weight'].default_value = spec['sheen']
    if spec.get('ior'):
        bsdf.inputs['IOR'].default_value = spec['ior']
    if spec.get('emit'):
        bsdf.inputs['Emission Color'].default_value = (*spec['color'], 1)
        bsdf.inputs['Emission Strength'].default_value = spec['emit']
    if spec.get('alpha') is not None:  # see-through (window glass)
        bsdf.inputs['Alpha'].default_value = spec['alpha']
        try: m.surface_render_method = 'BLENDED'
        except Exception: pass
    _mats[name] = m
    return m


# ───────────────────────── collecting geometry ─────────────────────────
class Asset:
    """Collects finished pieces (bmesh, in Blender coordinates) per material."""

    def __init__(self, name):
        self.name = name
        self.parts = {}  # material name -> list of (bmesh, tint)

    def add(self, bm, mat, tint=(1, 1, 1), uv='box', tile=None):
        """Take ownership of bm. uv: 'box' projects in metres, 'keep' leaves the layer the piece made itself."""
        if uv == 'box':
            box_uv(bm, tile or MATERIALS[mat].get('tile', 1.0))
        layer = bm.loops.layers.float_color.get('Col') or bm.loops.layers.float_color.new('Col')
        if tint is not None:  # None = the piece painted its own 'Col' layer
            t = (*tint, 1.0)
            for f in bm.faces:
                for l in f.loops: l[layer] = t
        self.parts.setdefault(mat, []).append(bm)

    def build(self):
        """One object per material."""
        objs = []
        for mat, bms in self.parts.items():
            big = bmesh.new()
            big.loops.layers.uv.new('UVMap')
            big.loops.layers.float_color.new('Col')
            for bm in bms:
                me = bpy.data.meshes.new('tmp')
                bm.to_mesh(me)
                bm.free()
                big.from_mesh(me)
                bpy.data.meshes.remove(me)
            me = bpy.data.meshes.new(f'{self.name}_{mat}')
            big.to_mesh(me)
            big.free()
            me.materials.append(material(mat))
            me.color_attributes.active_color = me.color_attributes['Col']
            me.color_attributes.render_color_index = me.color_attributes.find('Col')
            ob = bpy.data.objects.new(f'{self.name}_{mat}', me)
            bpy.context.scene.collection.objects.link(ob)
            objs.append(ob)
        self.parts = {}
        self.objects = objs
        return objs


def box_uv(bm, tile):
    """Project each face along its dominant axis, in metres / tile. Game-up faces read x/z, sides read along/up."""
    uv = bm.loops.layers.uv.get('UVMap') or bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        n = f.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for l in f.loops:
            p = l.vert.co
            if az >= ax and az >= ay: u, v = p.x, p.y
            elif ay >= ax: u, v = p.x, p.z
            else: u, v = p.y, p.z
            l[uv].uv = (u / tile, v / tile)


def shade(bm, angle=38):
    """Smooth shading, with edges sharper than `angle` degrees kept hard."""
    lim = math.radians(angle)
    for f in bm.faces: f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) == 2:
            e.smooth = e.calc_face_angle(0) < lim
        else:
            e.smooth = False


def refine(bm, max_len=0.4, passes=3):
    """Triangulate and split long edges so vertex colours (the baked shading) have enough points to sit on."""
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method='BEAUTY', ngon_method='BEAUTY')
    for _ in range(passes):
        long = [e for e in bm.edges if e.calc_length() > max_len]
        if not long: break
        bmesh.ops.subdivide_edges(bm, edges=long, cuts=1)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3], quad_method='BEAUTY', ngon_method='BEAUTY')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])


def bevel(bm, width=0.03, segments=2, angle=30, profile=0.6):
    """Round every edge sharper than `angle` degrees."""
    lim = math.radians(angle)
    edges = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > lim]
    if edges:
        bmesh.ops.bevel(bm, geom=edges, offset=width, offset_type='OFFSET', segments=segments, profile=profile, affect='EDGES', clamp_overlap=True)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])


def transform(bm, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    """loc/rot in GAME terms: loc (x, y up, z south); rot = (about x, about y up, about z), radians, applied y then x then z."""
    sx, sy, sz = scale if not isinstance(scale, (int, float)) else (scale, scale, scale)
    S = Matrix.Diagonal((sx, sz, sy, 1))  # game (x, y, z) scale -> blender (x, y, z) = (x, z, y)
    R = Matrix.Rotation(-rot[1], 4, 'Z') @ Matrix.Rotation(rot[0], 4, 'X') @ Matrix.Rotation(-rot[2], 4, 'Y')
    T = Matrix.Translation(G(*loc))
    bmesh.ops.transform(bm, matrix=T @ R @ S, verts=bm.verts[:])
    return bm


# ───────────────────────── primitives (all in Blender coords, centred on the origin) ─────────────────────────
def bm_box(hx, hy, hz, bev=0.03, segs=2):
    """A box with GAME half sizes (hx east, hy up, hz south), bevelled."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    bmesh.ops.scale(bm, vec=(hx * 2, hz * 2, hy * 2), verts=bm.verts[:])
    if bev > 0: bevel(bm, min(bev, hx * 0.45, hy * 0.45, hz * 0.45), segs)
    return bm


def bm_cyl(r, h, segs=24, bev=0.02, cap_mat_split=False, r2=None):
    """An upright cylinder (axis = game y), centred, radius r (r2 at the top)."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r, radius2=r if r2 is None else r2, depth=h)
    if bev > 0: bevel(bm, bev, 2, angle=50)
    return bm


def bm_ico(r=1.0, sub=3):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    return bm


def displace(bm, amount, scale, seed=0, axis=None):
    """Push vertices along their normals (or a fixed axis) by smooth noise."""
    off = Vector((seed * 13.1, seed * 7.7, seed * 3.3))
    bm.normal_update()
    for v in bm.verts:
        n = noise.noise(v.co * scale + off) + 0.5 * noise.noise(v.co * scale * 2.3 + off)
        v.co += (axis or v.normal) * (n * amount)


def tube(path, radius, around=16, tile_v=1.0, u_repeat=1.0, cap=True, twist=0.0, squash=None, v0=0.0, cap_steps=3):
    """Sweep a circle along `path` (Blender-space points). radius: number or fn(t 0..1). UVs: u round the tube
    (u_repeat times), v along it in metres / tile_v. cap: rounded ends. Returns a bmesh."""
    pts = [Vector(p) for p in path]
    n = len(pts)
    # arc length
    s = [0.0]
    for i in range(1, n): s.append(s[-1] + (pts[i] - pts[i - 1]).length)
    total = s[-1] or 1.0
    rad = radius if callable(radius) else (lambda t: radius)
    # parallel-transport frames
    tangents = []
    for i in range(n):
        a = pts[max(0, i - 1)]; b = pts[min(n - 1, i + 1)]
        tangents.append((b - a).normalized())
    up = Vector((0, 0, 1))
    if abs(tangents[0].dot(up)) > 0.9: up = Vector((1, 0, 0))
    nrm = (up - tangents[0] * up.dot(tangents[0])).normalized()
    frames = []
    for i in range(n):
        t = tangents[i]
        if i > 0:
            axis = tangents[i - 1].cross(t)
            if axis.length > 1e-6:
                ang = tangents[i - 1].angle(t)
                nrm = Matrix.Rotation(ang, 3, axis.normalized()) @ nrm
        nrm = (nrm - t * nrm.dot(t)).normalized()
        frames.append((nrm.copy(), t.cross(nrm).normalized()))
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    rings = []
    for i in range(n):
        t = s[i] / total
        r = rad(t)
        a0 = twist * t
        ring = []
        for k in range(around):
            a = a0 + k / around * 2 * math.pi
            nx, ny = math.cos(a), math.sin(a)
            if squash: ny *= squash
            ring.append(bm.verts.new(pts[i] + (frames[i][0] * nx + frames[i][1] * ny) * r))
        rings.append(ring)
    for i in range(n - 1):
        for k in range(around):
            k2 = (k + 1) % around
            f = bm.faces.new((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]))
            us = (k / around * u_repeat, (k + 1) / around * u_repeat)
            vs = (v0 + s[i] / tile_v, v0 + s[i + 1] / tile_v)
            for l, (uu, vv) in zip(f.loops, ((us[0], vs[0]), (us[1], vs[0]), (us[1], vs[1]), (us[0], vs[1]))):
                l[uv].uv = (uu, vv)
    if cap:
        steps = cap_steps
        for end, sign in ((0, -1), (n - 1, 1)):
            ring = rings[end]
            r = rad(0.0 if end == 0 else 1.0)
            t = tangents[end] * sign
            prev, prev_v = ring, v0 + s[end] / tile_v
            for j in range(1, steps + 1):
                a = j / steps * math.pi / 2
                vv = v0 + (s[end] + sign * r * a) / tile_v
                if j < steps:
                    cur = [bm.verts.new(pts[end] + (ring[k].co - pts[end]) * math.cos(a) + t * r * math.sin(a)) for k in range(around)]
                else:
                    tip = bm.verts.new(pts[end] + t * r)
                for k in range(around):
                    k2 = (k + 1) % around
                    u0, u1 = k / around * u_repeat, (k + 1) / around * u_repeat
                    if j < steps:
                        vs_ = [prev[k], prev[k2], cur[k2], cur[k]]
                        uvs = [(u0, prev_v), (u1, prev_v), (u1, vv), (u0, vv)]
                    else:
                        vs_ = [prev[k], prev[k2], tip]
                        uvs = [(u0, prev_v), (u1, prev_v), ((u0 + u1) / 2, vv)]
                    f = bm.faces.new(vs_)
                    for l, q in zip(f.loops, uvs): l[uv].uv = q
                if j < steps: prev, prev_v = cur, vv
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    for f in bm.faces: f.smooth = True
    return bm


def arc(center, r, a0, a1, n, plane='xy'):
    """Points on a circular arc in GAME coordinates, returned in Blender space. plane 'xy' = vertical plane along x,
    'xz' = flat on the ground, 'zy' = vertical plane along z. Angles in radians, measured from +first axis."""
    out = []
    for i in range(n + 1):
        a = a0 + (a1 - a0) * i / n
        c, s = math.cos(a) * r, math.sin(a) * r
        if plane == 'xy': out.append(G(center[0] + c, center[1] + s, center[2]))
        elif plane == 'xz': out.append(G(center[0] + c, center[1], center[2] + s))
        else: out.append(G(center[0], center[1] + s, center[2] + c))
    return out


def snow_lump(size, seed=0, sub=3, flat=0.35, rough=0.12):
    """A soft mound of snow with GAME half sizes (x, y up, z), sitting on y = 0 (its underside is cut flat)."""
    bm = bm_ico(1.0, sub)
    displace(bm, rough, 1.6, seed)
    for v in bm.verts:
        if v.co.z < -flat: v.co.z = -flat
    bmesh.ops.translate(bm, vec=(0, 0, flat), verts=bm.verts[:])
    bmesh.ops.scale(bm, vec=(size[0], size[2], size[1] / (1 + flat)), verts=bm.verts[:])
    for f in bm.faces: f.smooth = True
    return bm


def drift(size, seed=0, around=18):
    """A low drift of snow with GAME half sizes (x, y up, z): an uneven bell whose rim runs out flat and ends just
    under the surface, so there is no hard edge where it meets the ground."""
    off = Vector((seed * 5.3, seed * 2.9, 0))
    bm = bmesh.new()
    rings = []
    for pr in (1.0, 0.9, 0.78, 0.64, 0.48, 0.32, 0.16):
        ring = []
        for k in range(around):
            a = 2 * math.pi * k / around
            c, sn = math.cos(a), math.sin(a)
            wob = 1 + 0.2 * noise.noise(Vector((c * 1.3, sn * 1.3, 0)) + off) + 0.08 * noise.noise(Vector((c * 3, sn * 3, pr)) + off)
            hh = (1 - pr * pr) ** 2 * (1 + 0.22 * noise.noise(Vector((c * 2 * pr, sn * 2 * pr, 3)) + off)) if pr < 1 else -0.14
            ring.append(bm.verts.new((c * pr * wob * size[0], sn * pr * wob * size[2], hh * size[1])))
        rings.append(ring)
    top = bm.verts.new((0, 0, size[1]))
    for i in range(len(rings) - 1):
        for k in range(around):
            k2 = (k + 1) % around
            bm.faces.new((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]))
    for k in range(around):
        bm.faces.new((rings[-1][k], rings[-1][(k + 1) % around], top))
    for f in bm.faces: f.smooth = True
    return bm


def gumdrop(r=0.17, h=0.2, seed=0, around=10):
    """A sugar-crusted dome, open underneath (it always sits on something)."""
    prof = [(1.0, 0.0), (0.98, 0.3), (0.87, 0.62), (0.63, 0.87), (0.32, 0.98)]  # (radius, height) of each ring
    bm = bmesh.new()
    rings = [[bm.verts.new((math.cos(2 * math.pi * k / around) * pr * r, math.sin(2 * math.pi * k / around) * pr * r, ph * h))
              for k in range(around)] for pr, ph in prof]
    top = bm.verts.new((0, 0, h))
    for i in range(len(rings) - 1):
        for k in range(around):
            k2 = (k + 1) % around
            bm.faces.new((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]))
    for k in range(around):
        bm.faces.new((rings[-1][k], rings[-1][(k + 1) % around], top))
    for f in bm.faces: f.smooth = True
    return bm


# ───────────────────────── baked shading ─────────────────────────
def _hemisphere(n, seed=1):
    rng = random.Random(seed)
    out = []
    for i in range(n):
        u, v = (i + rng.random()) / n, rng.random()
        r = math.sqrt(u); a = 2 * math.pi * v
        out.append((r * math.cos(a), r * math.sin(a), math.sqrt(max(0, 1 - u))))
    return out


# snow is lit from all round by the snow about it, so it only takes a little of the baked shading
AO_FLOOR = {'snow': 0.84, 'glow': 1.0, 'ice': 0.6}


def bake_ao(objs, rays=40, dist=1.6, floor=0.42, ground=0.0, power=1.0):
    """Ray-cast ambient occlusion into the 'Col' attribute (multiplying whatever tint is there).
    Everything occludes everything, plus the snow the prop stands on (a plane at game y = ground; None = no ground)."""
    verts, polys = [], []
    for ob in objs:
        me = ob.data
        base = len(verts)
        verts.extend([ob.matrix_world @ v.co for v in me.vertices])
        polys.extend([[base + i for i in p.vertices] for p in me.polygons])
    if ground is not None:
        base = len(verts)
        B = 60
        verts.extend([Vector((-B, -B, ground)), Vector((B, -B, ground)), Vector((B, B, ground)), Vector((-B, B, ground))])
        polys.append([base, base + 1, base + 2, base + 3])
    tree = BVHTree.FromPolygons(verts, polys, all_triangles=False, epsilon=0.0)
    dirs = _hemisphere(rays)
    for ob in objs:
        me = ob.data
        col = me.color_attributes['Col']
        normals = me.corner_normals
        cache = {}
        for li, loop in enumerate(me.loops):
            n = normals[li].vector
            key = (loop.vertex_index, round(n.x, 2), round(n.y, 2), round(n.z, 2))
            ao = cache.get(key)
            if ao is None:
                p = me.vertices[loop.vertex_index].co
                n = Vector(n)
                t = n.orthogonal().normalized(); b = n.cross(t)
                o = p + n * 0.012
                occ = 0.0
                for dx, dy, dz in dirs:
                    d = t * dx + b * dy + n * dz
                    hit = tree.ray_cast(o, d, dist)
                    if hit[0] is not None: occ += 1.0 - (hit[3] / dist) ** 2 * 0.85
                ao = 1.0 - occ / rays
                fl = AO_FLOOR.get(me.materials[0].name.split('.')[0], floor)
                ao = fl + (1 - fl) * (max(0.0, ao) ** power)
                cache[key] = ao
            c = col.data[li].color
            col.data[li].color = (c[0] * ao, c[1] * ao, c[2] * ao, 1.0)
        me.update()


# ───────────────────────── output ─────────────────────────
def export(name, objs):
    os.makedirs(MODELS, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objs: ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    path = os.path.join(MODELS, f'{name}.glb')
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False,
        export_materials='EXPORT', export_image_format='NONE', export_vertex_color='NAME', export_vertex_color_name='Col', export_all_vertex_colors=False,
        export_active_vertex_color_when_no_material=True,
        export_cameras=False, export_lights=False, export_animations=False, export_skins=False, export_morph=False,
    )
    tris = sum(len(p.vertices) - 2 for ob in objs for p in ob.data.polygons)
    print(f'exported {name}.glb: {len(objs)} meshes, {tris} triangles, {os.path.getsize(path) / 1024:.0f} KB')


def render(path, target=(0, 1.5, 0), dist=9.0, yaw=35, pitch=18, size=(1024, 640), samples=28, sun_yaw=140, sun_el=32, lens=50, engine='CYCLES'):
    """A review render on a snow field under a clear winter sky. target in GAME coords; yaw: where the camera
    stands, degrees round the prop from +x toward +z (south); pitch: degrees above the horizon."""
    sc = bpy.context.scene
    sc.render.engine = engine
    if engine == 'CYCLES':
        sc.cycles.samples = samples
        sc.cycles.use_denoising = True
        sc.cycles.device = 'CPU'
    sc.render.resolution_x, sc.render.resolution_y = size
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Medium High Contrast'
    sc.view_settings.exposure = -0.6
    # sky
    w = sc.world or bpy.data.worlds.new('World')
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    bg = nt.nodes.new('ShaderNodeBackground'); out = nt.nodes.new('ShaderNodeOutputWorld')
    sky = nt.nodes.new('ShaderNodeTexSky')
    try:
        sky.sun_elevation = math.radians(sun_el); sky.sun_rotation = math.radians(sun_yaw)
        sky.sun_intensity = 1.0
    except Exception as e:
        print('sky params:', e)
    nt.links.new(sky.outputs[0], bg.inputs[0]); nt.links.new(bg.outputs[0], out.inputs[0])
    bg.inputs[1].default_value = 0.11
    # ground
    if 'ReviewGround' not in bpy.data.objects:
        bm = bmesh.new()
        bmesh.ops.create_grid(bm, x_segments=120, y_segments=120, size=40)
        displace(bm, 0.05, 0.25, 5, axis=Vector((0, 0, 1)))
        box_uv(bm, 1.5)
        l = bm.loops.layers.float_color.new('Col')
        for f in bm.faces:
            f.smooth = True
            for lp in f.loops: lp[l] = (1, 1, 1, 1)
        me = bpy.data.meshes.new('ReviewGround'); bm.to_mesh(me); bm.free()
        me.materials.append(material('snow'))
        g = bpy.data.objects.new('ReviewGround', me)
        g.location = (0, 0, -0.02)
        sc.collection.objects.link(g)
    # camera
    cam = bpy.data.objects.get('ReviewCam')
    if not cam:
        cam = bpy.data.objects.new('ReviewCam', bpy.data.cameras.new('ReviewCam'))
        sc.collection.objects.link(cam)
    cam.data.lens = lens
    ya, pa = math.radians(yaw), math.radians(pitch)
    tgt = G(*target)
    pos_game = (target[0] + math.cos(ya) * math.cos(pa) * dist, target[1] + math.sin(pa) * dist, target[2] + math.sin(ya) * math.cos(pa) * dist)
    cam.location = G(*pos_game)
    cam.rotation_euler = (tgt - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    sc.render.filepath = path
    sc.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)
    print('rendered', path)


# ───────────────────────── more builders ─────────────────────────
from mathutils.geometry import tessellate_polygon


def slab(outline, holes=(), thickness=0.3, bev=0.05, segs=3, max_len=0.45, wobble=0.012, seed=0):
    """A flat piece cut from a sheet: `outline` and `holes` are lists of (u, v) points. It stands in Blender's
    x/z plane (u along x, v up) and is `thickness` deep along y, centred. Edges are rounded like a baked biscuit."""
    loops = [list(outline)] + [list(h) for h in holes]
    flat = [[Vector((u, v, 0)) for u, v in lp] for lp in loops]
    tris = tessellate_polygon(flat)
    pts = [p for lp in loops for p in lp]
    bm = bmesh.new()
    front = [bm.verts.new((u, -thickness / 2, v)) for u, v in pts]
    back = [bm.verts.new((u, thickness / 2, v)) for u, v in pts]
    for a, b, c in tris:
        try:
            bm.faces.new((front[a], front[b], front[c]))
            bm.faces.new((back[c], back[b], back[a]))
        except ValueError:
            pass
    base = 0
    for lp in loops:
        n = len(lp)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((front[base + i], back[base + i], back[base + j], front[base + j]))
        base += n
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    # merge the coplanar triangles back into big faces so the bevel only sees the real edges
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(1), verts=bm.verts[:], edges=bm.edges[:])
    if bev > 0: bevel(bm, bev, segs, angle=30)
    refine(bm, max_len)
    if wobble: displace(bm, wobble, 1.3, seed)
    shade(bm, 40)
    return bm


def rounded_rect(u0, v0, u1, v1, r, n=5):
    """Corner-rounded rectangle as (u, v) points, counter-clockwise."""
    out = []
    for cx, cy, a0 in ((u1 - r, v0 + r, -math.pi / 2), (u1 - r, v1 - r, 0), (u0 + r, v1 - r, math.pi / 2), (u0 + r, v0 + r, math.pi)):
        for i in range(n + 1):
            a = a0 + i / n * math.pi / 2
            out.append((cx + math.cos(a) * r, cy + math.sin(a) * r))
    return out


def arch_outline(u0, u1, v0, spring, apex, n=10):
    """A doorway: straight sides from v0 up to `spring`, then half an ellipse over to `apex`. Counter-clockwise."""
    cu, ru, rv = (u0 + u1) / 2, (u1 - u0) / 2, apex - spring
    out = [(u0, v0), (u1, v0)]
    for i in range(n + 1):
        a = i / n * math.pi
        out.append((cu + math.cos(a) * ru, spring + math.sin(a) * rv))
    return out


def ribbon(path, width=0.14, thick=0.018, up=None, tile_v=1.0):
    """A flat band swept along `path` (Blender-space points). `up` is the direction the band's width runs at the start."""
    pts = [Vector(p) for p in path]
    n = len(pts)
    bm = bmesh.new()
    tang = [(pts[min(n - 1, i + 1)] - pts[max(0, i - 1)]).normalized() for i in range(n)]
    w = Vector(up) if up is not None else Vector((0, 0, 1))
    rings = []
    for i in range(n):
        t = tang[i]
        w = (w - t * w.dot(t))
        if w.length < 1e-5: w = t.orthogonal()
        w.normalize()
        nrm = t.cross(w).normalized()
        a, b = w * (width / 2), nrm * (thick / 2)
        # a rounded-rectangle section: 8 points
        k = 0.7
        sec = [a + b * k, a * k + b, -a * k + b, -a + b * k, -a - b * k, -a * k - b, a * k - b, a - b * k]
        rings.append([bm.verts.new(pts[i] + s) for s in sec])
    for i in range(n - 1):
        for k in range(8):
            k2 = (k + 1) % 8
            bm.faces.new((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]))
    bm.faces.new(rings[0][::-1]); bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    shade(bm, 50)
    return bm


def pipe(path, r=0.06, around=6, wobble=0.1, seed=0, cap=True, squash=None, cap_steps=2):
    """Piped icing: a tube that swells and thins a little along its length. `path` in Blender space."""
    ph = seed * 1.7
    n = max(2, len(path))
    return tube(path, lambda t: r * (1 + wobble * math.sin(t * n * 1.3 + ph) + wobble * 0.5 * math.sin(t * n * 3.1 + ph * 2)), around=around, cap=cap, squash=squash, cap_steps=cap_steps)


def blob(r, seed=0, sub=2, squash=(1, 1, 1), rough=0.0):
    """A small rounded lump (pearls of icing, pebbles)."""
    bm = bm_ico(1.0, sub)
    if rough: displace(bm, rough, 1.5, seed)
    bmesh.ops.scale(bm, vec=(r * squash[0], r * squash[2], r * squash[1]), verts=bm.verts[:])
    for f in bm.faces: f.smooth = True
    return bm


def drip(length, r=0.07, around=6, seed=0):
    """An icing drip or an icicle hanging down from the origin: fat at the top, a bead at the tip."""
    n = 5
    path = [Vector((0, 0, -length * i / n)) for i in range(n + 1)]
    return tube(path, lambda t: r * (1 - 0.55 * t + 0.35 * max(0, 1 - abs(t - 0.88) * 7)), around=around, cap=True, cap_steps=2)


def icicle(length, r=0.05, around=6, bend=0.0):
    n = 5
    path = [Vector((bend * (i / n) ** 2, 0, -length * i / n)) for i in range(n + 1)]
    return tube(path, lambda t: max(0.004, r * (1 - t) ** 1.3), around=around, cap=False)


def chunk(size, seed=0, bev=0.04):
    """A broken-off piece of slab with GAME half sizes: a box with its corners knocked about."""
    rng = random.Random(seed)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts:
        v.co.x *= size[0] * 2 * (0.75 + rng.random() * 0.5)
        v.co.y *= size[2] * 2 * (0.75 + rng.random() * 0.5)
        v.co.z *= size[1] * 2 * (0.8 + rng.random() * 0.4)
    bevel(bm, bev, 2)
    refine(bm, 0.35)
    displace(bm, 0.02, 2.5, seed)
    shade(bm, 40)
    return bm
