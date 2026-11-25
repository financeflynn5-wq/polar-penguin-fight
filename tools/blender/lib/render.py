"""Preview renders in Cycles: a snowy studio with a low warm sun and cool sky fill, like the game."""
import math
import os
import bpy
from mathutils import Vector
from PIL import Image


def studio(ground=True, sun_strength=3.4, sky_strength=0.9):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.use_denoising = True
    try:
        sc.view_settings.view_transform = 'Khronos PBR Neutral'
    except Exception:
        sc.view_settings.view_transform = 'Standard'
    w = sc.world or bpy.data.worlds.new('World'); sc.world = w
    w.use_nodes = True
    nt = w.node_tree; nt.nodes.clear()
    bg = nt.nodes.new('ShaderNodeBackground'); out = nt.nodes.new('ShaderNodeOutputWorld')
    tc = nt.nodes.new('ShaderNodeTexCoord'); sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    nt.links.new(tc.outputs['Generated'], sep.inputs[0]); nt.links.new(sep.outputs[2], ramp.inputs[0])
    e = ramp.color_ramp.elements
    e[0].position = 0.0; e[0].color = (0.72, 0.8, 0.95, 1)
    e[1].position = 1.0; e[1].color = (0.22, 0.42, 0.85, 1)
    m = e.new(0.52); m.color = (0.78, 0.86, 0.98, 1)
    nt.links.new(ramp.outputs[0], bg.inputs['Color']); bg.inputs['Strength'].default_value = sky_strength
    nt.links.new(bg.outputs[0], out.inputs['Surface'])
    sun = bpy.data.lights.new('Sun', 'SUN'); sun.energy = sun_strength; sun.angle = math.radians(3); sun.color = (1.0, 0.9, 0.8)
    so = bpy.data.objects.new('Sun', sun); sc.collection.objects.link(so)
    so.rotation_euler = (math.radians(58), 0, math.radians(-38))
    rim = bpy.data.lights.new('Rim', 'SUN'); rim.energy = 1.6; rim.color = (0.75, 0.86, 1.0); rim.angle = math.radians(8)
    ro = bpy.data.objects.new('Rim', rim); sc.collection.objects.link(ro)
    ro.rotation_euler = (math.radians(68), 0, math.radians(150))
    made = [so, ro]
    if ground:
        bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
        g = bpy.context.object; g.name = 'StudioGround'
        gm = bpy.data.materials.new('StudioSnow'); gm.use_nodes = True
        b = gm.node_tree.nodes['Principled BSDF']
        b.inputs['Base Color'].default_value = (0.86, 0.9, 0.97, 1); b.inputs['Roughness'].default_value = 0.85
        g.data.materials.append(gm)
        made.append(g)
    return made


def shot(path, target=(0, 0, 0.6), dist=3.0, az=30.0, el=10.0, fov=28.0, res=(900, 900), samples=48):
    sc = bpy.context.scene
    cam = bpy.data.objects.get('PreviewCam')
    if cam is None:
        cam = bpy.data.objects.new('PreviewCam', bpy.data.cameras.new('PreviewCam'))
        sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.angle = math.radians(fov)
    a = math.radians(az); e = math.radians(el)
    t = Vector(target)
    # az 0 = looking at the model's front (the model faces +Y)
    cam.location = t + Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e))) * dist
    d = (t - cam.location).normalized()
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.cycles.samples = samples
    sc.render.filepath = path
    sc.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)
    return path


def sheet(paths, out, cols=None):
    ims = [Image.open(p).convert('RGB') for p in paths]
    cols = cols or len(ims)
    rows = (len(ims) + cols - 1) // cols
    w, h = ims[0].size
    S = Image.new('RGB', (w * cols, h * rows), (20, 24, 32))
    for i, im in enumerate(ims):
        S.paste(im, ((i % cols) * w, (i // cols) * h))
    S.save(out)
    for p in paths:
        if p != out:
            os.remove(p)
    return out
