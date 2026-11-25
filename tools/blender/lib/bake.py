"""Procedural looks → baked PBR textures (base colour, normal, occlusion/roughness/metal) on a packed atlas."""
import math
import os
import numpy as np
import bpy
from PIL import Image
from . import nodes as N
from .nodes import Graph, sock_of

LOOKS = {}  # material name → dict(sockets)


def look(name, fn):
    """Create a bake material. fn(g) returns dict(color=Vec, rough=V, metal=V, height=V[metres])."""
    mat = bpy.data.materials.new(name)
    with Graph(mat) as g:
        out = fn(g)
        socks = {
            'color': sock_of(out.get('color', N.Vec((0.8, 0.8, 0.8)))),
            'rough': sock_of(out.get('rough', 0.6)),
            'metal': sock_of(out.get('metal', 0.0)),
            'height': sock_of(out.get('height', 0.0)),
        }
        nd = g.nodes
        emit = nd.new('ShaderNodeEmission')
        bsdf = nd.new('ShaderNodeBsdfPrincipled')
        bump = nd.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = 1.0
        bump.inputs['Distance'].default_value = 1.0
        g.links.new(socks['height'], bump.inputs['Height'])
        g.links.new(bump.outputs[0], bsdf.inputs['Normal'])
        g.links.new(socks['color'], bsdf.inputs['Base Color'])
        g.links.new(socks['rough'], bsdf.inputs['Roughness'])
        g.links.new(socks['metal'], bsdf.inputs['Metallic'])
        outn = nd.new('ShaderNodeOutputMaterial')
        g.links.new(bsdf.outputs[0], outn.inputs['Surface'])
        img = nd.new('ShaderNodeTexImage')
        LOOKS[mat.name] = dict(socks=socks, emit=emit, bsdf=bsdf, out=outn, img=img, extra=out)
    return mat


def _wire(mat, what):
    L = LOOKS[mat.name]; nt = mat.node_tree
    for l in list(L['out'].inputs['Surface'].links):
        nt.links.remove(l)
    if what in ('color', 'rough', 'metal'):
        for l in list(L['emit'].inputs['Color'].links):
            nt.links.remove(l)
        nt.links.new(L['socks'][what], L['emit'].inputs['Color'])
        nt.links.new(L['emit'].outputs[0], L['out'].inputs['Surface'])
    else:
        nt.links.new(L['bsdf'].outputs[0], L['out'].inputs['Surface'])


def pack_atlas(objs, size, pad_px=8, density=None):
    """Shelf-pack every island rectangle of every object into the unit square and write the 'atlas' UV layer."""
    density = density or {}
    rects = []
    for o in objs:
        dm = density.get(o.name, 1.0)
        for k, (w, h) in enumerate(o['islands']):
            m = dm[k] if isinstance(dm, (list, tuple)) else dm  # one number per object, or one per island
            rot = h > w * 1.15
            rects.append(dict(o=o, k=k, w=(h if rot else w) * m, h=(w if rot else h) * m, rot=rot, m=m))
    pad = pad_px / size

    def attempt(s, asp, commit=False):
        """Shelf-pack with the whole atlas stretched: metres map to s*asp across and s/asp up."""
        sx, sy = s * asp, s / asp
        items = sorted(((r, r['W'] * sx, r['H'] * sy) for r in rects), key=lambda it: -it[2])
        x = pad; y = pad; shelf = 0.0
        for r, w, h in items:
            if w + 2 * pad > 1.0:
                return False
            if x + w + pad > 1.0:
                x = pad; y += shelf + pad; shelf = 0.0
            if y + h + pad > 1.0:
                return False
            if commit:
                r.update(x=x, y=y, sx=sx, sy=sy)
            shelf = max(shelf, h); x += w + pad
        return True

    for r in rects:  # W, H: the island's size in the atlas, in metres (after its own quarter turn, if any)
        r['W'] = r['w']; r['H'] = r['h']
    best = (0.0, 1.0)
    for asp in (0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.4, 1.65, 2.0, 2.5):
        lo, hi = 0.0, 50.0
        for _ in range(36):
            mid = 0.5 * (lo + hi)
            if attempt(mid, asp):
                lo = mid
            else:
                hi = mid
        if lo > best[0]:
            best = (lo, asp)
    s, asp = best
    attempt(s, asp, commit=True)
    by = {}
    for r in rects:
        by[(r['o'].name, r['k'])] = r
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
    used = sum(r['W'] * r['H'] for r in rects) * s * s
    print(f'[atlas] {len(rects)} islands, {s * size:.0f} px per metre, stretch {asp}, {used * 100:.0f}% used')
    return s * size


def auto_island(ob, angle=66.0):
    """Unwrap an arbitrary mesh with Smart UV Project and register it as one island sized by its surface area."""
    me = ob.data
    for name in ('atlas', 'param'):
        if name not in me.uv_layers:
            me.uv_layers.new(name=name)
    me.uv_layers.active = me.uv_layers['atlas']
    for o in bpy.context.scene.objects:
        o.select_set(False)
    ob.select_set(True); bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=0.02)
    bpy.ops.object.mode_set(mode='OBJECT')
    n = len(me.loops)
    uv = np.zeros(n * 2); me.uv_layers['atlas'].data.foreach_get('uv', uv); uv = uv.reshape(-1, 2)
    area3 = sum(p.area for p in me.polygons)
    area2 = 0.0
    for p in me.polygons:
        idx = list(p.loop_indices)
        for i in range(1, len(idx) - 1):
            a, b, c = uv[idx[0]], uv[idx[i]], uv[idx[i + 1]]
            area2 += abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * 0.5
    side = math.sqrt(area3 / max(area2, 1e-9))
    me.uv_layers['param'].data.foreach_set('uv', (uv * side).reshape(-1))
    me.uv_layers['atlas'].data.foreach_set('uv', (uv * side).reshape(-1))
    if 'island' in me.attributes:
        me.attributes.remove(me.attributes['island'])
    a = me.attributes.new('island', 'INT', 'CORNER')
    a.data.foreach_set('value', np.zeros(n, dtype=np.int32))
    ob['islands'] = [[side, side]]


def _pixels(img):
    w, h = img.size
    a = np.zeros(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)[::-1]


def _to_srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def bake(objs, size, out_dir, name, ao_samples=48, ao_dist=0.35, ao_in_color=0.35, margin=10, ss=1, occluders=()):
    """Bake colour / normal / ORM for objs (each with look() materials) into out_dir/name_*.png. Returns paths."""
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.render.bake.margin = margin * ss
    sc.render.bake.margin_type = 'EXTEND'
    sc.render.bake.use_clear = False
    sc.render.bake.use_selected_to_active = False
    if sc.world is None:
        sc.world = bpy.data.worlds.new('w')
    sc.world.light_settings.distance = ao_dist
    S = size * ss
    mats = set()
    for o in objs:
        for sl in o.material_slots:
            if sl.material and sl.material.name in LOOKS:
                mats.add(sl.material)
    for o in sc.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    res = {}
    for what in ('color', 'rough', 'metal', 'normal', 'ao'):
        img = bpy.data.images.new(f'bake_{what}', S, S, float_buffer=True, alpha=False)
        img.colorspace_settings.name = 'Non-Color'
        fill = {'normal': (0.5, 0.5, 1.0, 1.0), 'ao': (1, 1, 1, 1)}.get(what, (0.5, 0.5, 0.5, 1.0))
        img.generated_color = fill
        img.pixels.foreach_set(np.tile(np.array(fill, dtype=np.float32), S * S))
        for m in mats:
            _wire(m, what)
            L = LOOKS[m.name]
            L['img'].image = img
            m.node_tree.nodes.active = L['img']
        if what == 'ao':
            sc.cycles.samples = ao_samples
            bpy.ops.object.bake(type='AO')
        elif what == 'normal':
            sc.cycles.samples = 6
            bpy.ops.object.bake(type='NORMAL', normal_space='TANGENT')
        else:
            sc.cycles.samples = 6
            bpy.ops.object.bake(type='EMIT')
        px = _pixels(img)[..., :3]
        if ss > 1:
            px = px.reshape(size, ss, size, ss, 3).mean(axis=(1, 3))
        res[what] = px
        bpy.data.images.remove(img)
    os.makedirs(out_dir, exist_ok=True)
    ao = res['ao'][..., 0]
    col = res['color'] * (1.0 - ao_in_color * (1.0 - ao))[..., None]
    paths = {}

    def save(arr, suffix):
        p = os.path.join(out_dir, f'{name}_{suffix}.png')
        Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8)).save(p)
        paths[suffix] = p
    for o in occluders:
        o.hide_render = True
    save(_to_srgb(col), 'color')
    nrm = res['normal']
    save(nrm, 'normal')
    orm = np.stack([ao, np.clip(res['rough'][..., 0], 0.03, 1), res['metal'][..., 0]], axis=-1)
    save(orm, 'orm')
    return paths


def swap_materials(ob, look_to_name, export_mats):
    """Replace the bake materials on a joined mesh with export materials, merging slots that share one."""
    me = ob.data
    old = [sl.material.name for sl in ob.material_slots]
    names = []
    for n in old:
        t = look_to_name[n]
        if t not in names:
            names.append(t)
    remap = np.array([names.index(look_to_name[n]) for n in old], dtype=np.int32)
    idx = np.zeros(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get('material_index', idx)
    me.materials.clear()
    for n in names:
        me.materials.append(export_mats[n])
    me.polygons.foreach_set('material_index', remap[idx])
    me.update()


_GLTF_OUT = None


def _gltf_output_group():
    ng = bpy.data.node_groups.get('glTF Material Output')
    if ng is None:
        ng = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
        ng.interface.new_socket(name='Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    return ng


_IMG = {}


def _image(path, data):
    key = os.path.abspath(path)
    im = bpy.data.images.load(key, check_existing=True)
    im.colorspace_settings.name = 'Non-Color' if data else 'sRGB'
    return im


def export_material(name, paths, tint=(1, 1, 1), sheen=0.0, sheen_rough=0.5, sheen_tint=(1, 1, 1), coat=0.0, coat_rough=0.05,
                    emissive=None, emissive_strength=1.0, alpha=False, double_sided=False, rough_mul=1.0):
    """A glTF-ready Principled material that reads the baked textures."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree; nd = nt.nodes
    nd.clear()
    bsdf = nd.new('ShaderNodeBsdfPrincipled')
    out = nd.new('ShaderNodeOutputMaterial')
    nt.links.new(bsdf.outputs[0], out.inputs['Surface'])
    ctex = nd.new('ShaderNodeTexImage'); ctex.image = _image(paths['color'], False)
    if tuple(tint) != (1, 1, 1):
        mix = nd.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
        mix.inputs[0].default_value = 1.0
        nt.links.new(ctex.outputs['Color'], mix.inputs[6])
        mix.inputs[7].default_value = (*tint, 1.0)
        nt.links.new(mix.outputs[2], bsdf.inputs['Base Color'])
    else:
        nt.links.new(ctex.outputs['Color'], bsdf.inputs['Base Color'])
    if alpha:
        nt.links.new(ctex.outputs['Alpha'], bsdf.inputs['Alpha'])
        mat.blend_method = 'BLEND'
    ntex = nd.new('ShaderNodeTexImage'); ntex.image = _image(paths['normal'], True)
    nm = nd.new('ShaderNodeNormalMap')
    nt.links.new(ntex.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs[0], bsdf.inputs['Normal'])
    otex = nd.new('ShaderNodeTexImage'); otex.image = _image(paths['orm'], True)
    sep = nd.new('ShaderNodeSeparateColor')
    nt.links.new(otex.outputs['Color'], sep.inputs[0])
    nt.links.new(sep.outputs[1], bsdf.inputs['Roughness'])
    nt.links.new(sep.outputs[2], bsdf.inputs['Metallic'])
    grp = nd.new('ShaderNodeGroup'); grp.node_tree = _gltf_output_group()
    nt.links.new(sep.outputs[0], grp.inputs['Occlusion'])
    bsdf.inputs['Sheen Weight'].default_value = sheen
    bsdf.inputs['Sheen Roughness'].default_value = sheen_rough
    bsdf.inputs['Sheen Tint'].default_value = (*sheen_tint, 1.0)
    bsdf.inputs['Coat Weight'].default_value = coat
    bsdf.inputs['Coat Roughness'].default_value = coat_rough
    if emissive is not None:
        bsdf.inputs['Emission Color'].default_value = (*emissive, 1.0)
        bsdf.inputs['Emission Strength'].default_value = emissive_strength
    mat.use_backface_culling = not double_sided
    return mat
