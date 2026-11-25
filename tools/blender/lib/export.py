"""glTF export with the settings the game expects."""
import os
import bpy


def export_glb(path, objs, webp_quality=90, tangents=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True,
        export_yup=True, export_apply=True, export_texcoords=True, export_normals=True, export_tangents=tangents,
        export_materials='EXPORT', export_image_format='WEBP', export_image_quality=webp_quality,
        export_skins=True, export_animations=False, export_morph=False, export_attributes=False,
        export_extras=False, export_cameras=False, export_lights=False,
    )
    print(f'[export] {path}: {os.path.getsize(path) / 1024:.0f} KB')
