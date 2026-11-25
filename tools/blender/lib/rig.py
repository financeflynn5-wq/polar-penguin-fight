"""Armature helpers. Every bone stands straight up with its local Z pointing back, which is exactly glTF's frame.
So after export every joint has an identity rest rotation and the game can pose joints with plain model-space
angles: x = the penguin's right, y = up, z = back."""
import numpy as np
import bpy
from mathutils import Vector


def make_armature(name, bones):
    """bones: list of (name, head(x, y, z), parent or None)."""
    arm = bpy.data.armatures.new(name)
    ob = bpy.data.objects.new(name, arm)
    bpy.context.scene.collection.objects.link(ob)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for bn, head, parent in bones:
        b = arm.edit_bones.new(bn)
        b.head = head
        b.tail = (head[0], head[1], head[2] + 0.08)
        b.align_roll(Vector((0.0, -1.0, 0.0)))
        if parent:
            b.parent = arm.edit_bones[parent]
            b.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    return ob


def set_weights(ob, weights, max_influences=4):
    """weights: dict bone → array (n_verts) of raw weights. Normalised, top-N kept."""
    names = list(weights.keys())
    W = np.stack([np.asarray(weights[n], dtype=np.float64) for n in names], axis=1)
    W = np.clip(W, 0, None)
    if W.shape[1] > max_influences:
        idx = np.argsort(-W, axis=1)[:, max_influences:]
        np.put_along_axis(W, idx, 0.0, axis=1)
    s = W.sum(axis=1, keepdims=True)
    assert (s > 1e-9).all(), f'{ob.name}: {int((s <= 1e-9).sum())} vertices have no bone'
    W /= s
    ob.vertex_groups.clear()
    for j, n in enumerate(names):
        vg = ob.vertex_groups.new(name=n)
        nz = np.nonzero(W[:, j] > 1e-4)[0]
        for i in nz:
            vg.add([int(i)], float(W[i, j]), 'REPLACE')


def bind(ob, arm):
    ob.parent = arm
    md = ob.modifiers.new('Armature', 'ARMATURE')
    md.object = arm
