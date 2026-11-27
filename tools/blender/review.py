"""Review renders of an exported character: loads the real .glb, dresses it in both teams' colours, poses its
skeleton the way the game does and puts hats on it. Nothing is rebuilt; this only looks at what the game will load.

    python tools/blender/review.py polarbear            # every sheet → tools/blender/out/review_polarbear_*.png
    python tools/blender/review.py yeti rest up hats    # just these sheets
    options: --res=700  --samples=32  --lod (show the far-away copy instead)

Sheets: rest (both teams: front, back, side, face), up (arms overhead), lean (the charge / forward lean),
bend (elbows, jaw, a lifted foot), hats (beanie, top hat, crown), walk (a stride).
Poses are given in the game's terms (x right, y up, -z ahead; see src/render/PenguinModel.ts) and converted.
"""
import json
import math
import os
import sys
import numpy as np
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import render as RD  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
MODELS = os.path.join(REPO, 'src', 'assets', 'models')
TEAMS = {'blue': dict(TeamJacket='#2f7df0', TeamScarf='#a9e4ff', Mitten='#4f9df8'),
         'orange': dict(TeamJacket='#ff6a1f', TeamScarf='#ffd43d', Mitten='#ff8a3a')}
G2B = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=float)  # game (x, y, z) → Blender (x, -z, y)


def lin(hexstr):
    h = hexstr.lstrip('#')
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return out


def rx(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def ry(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rz(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def euler(x, y, z):
    """three.js Euler 'XYZ'."""
    return rx(x) @ ry(y) @ rz(z)


def axis_angle(axis, a):
    return np.array(Matrix.Rotation(a, 3, Vector(axis).normalized()))


def between(a, b):
    """The shortest turn taking direction a to direction b (three's setFromUnitVectors)."""
    return np.array(Vector(a).normalized().rotation_difference(Vector(b).normalized()).to_matrix())


class Model:
    def __init__(self, name, lod=False):
        self.name = name
        with open(os.path.join(MODELS, name + '.json')) as fh:
            self.facts = json.load(fh)
        bpy.ops.import_scene.gltf(filepath=os.path.join(MODELS, name + '.glb'))
        self.arm = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
        self.meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.find_armature() == self.arm]
        for o in self.meshes:
            o.hide_render = o.name.endswith('LOD') != lod
        self.ar = self.facts['armRest']
        self.hats = []
        self.reset()

    # ── materials ──
    def team(self, which):
        for mname, hexc in TEAMS[which].items():
            mat = bpy.data.materials.get(mname)
            col = (*lin(hexc), 1.0)
            done = False
            for n in mat.node_tree.nodes:
                if n.type == 'MIX' and n.data_type == 'RGBA':
                    for inp in (n.inputs[6], n.inputs[7]):
                        if not inp.is_linked:
                            inp.default_value = col; done = True
                if n.type == 'MIX_RGB':
                    for inp in (n.inputs[1], n.inputs[2]):
                        if not inp.is_linked:
                            inp.default_value = col; done = True
            assert done, f'{mname}: no tint to set'

    # ── pose ──
    def reset(self):
        for pb in self.arm.pose.bones:
            pb.rotation_mode = 'QUATERNION'
            pb.rotation_quaternion = (1, 0, 0, 0); pb.location = (0, 0, 0); pb.scale = (1, 1, 1)
        self.lids(self.facts['lidOpen'])

    def rot(self, bone, m_game):
        pb = self.arm.pose.bones[bone]
        Bm = np.array(pb.bone.matrix_local.to_3x3())
        m = Bm.T @ (G2B @ m_game @ G2B.T) @ Bm
        pb.rotation_quaternion = Matrix(m.tolist()).to_quaternion()

    def move(self, bone, x, y, z):
        pb = self.arm.pose.bones[bone]
        Bm = np.array(pb.bone.matrix_local.to_3x3())
        pb.location = tuple(Bm.T @ (G2B @ np.array([x, y, z], dtype=float)))

    def lids(self, a):
        yw = self.facts['eyeYaw']
        self.rot('lidL', axis_angle((math.cos(yw), 0, -math.sin(yw)), -a))
        self.rot('lidR', axis_angle((math.cos(yw), 0, math.sin(yw)), -a))

    def arm_to(self, side, out, up, fwd):
        s = 1 if side == 'R' else -1
        bind = (s * math.sin(self.ar), -math.cos(self.ar), 0)
        self.rot('arm' + side, between(bind, (s * out, up, -fwd)))

    def elbow(self, side, forward, inward=0.0):
        s = 1 if side == 'R' else -1
        m = axis_angle((math.cos(self.ar), s * math.sin(self.ar), 0), forward)
        if inward:
            m = m @ axis_angle((0, 0, 1), -s * inward)
        self.rot('forearm' + side, m)

    # ── hats ──
    def hat(self, name):
        for o in self.hats:
            bpy.data.objects.remove(o, do_unlink=True)
        self.hats = []
        if not name:
            return
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(MODELS, 'hats', name + '.glb'))
        new = [o for o in bpy.context.scene.objects if o not in before]
        self.hats = new
        bpy.context.view_layer.update()
        pb = self.arm.pose.bones['hat']
        rest = pb.bone.matrix_local
        delta = (self.arm.matrix_world @ pb.matrix) @ rest.inverted()  # how the pose moved the bone
        k = self.facts.get('hatScale', 1.0)
        M = delta @ Matrix.Translation(rest.to_translation()) @ Matrix.Scale(k, 4)
        for o in new:
            if o.parent is None:
                o.matrix_world = M @ o.matrix_world
        bpy.context.view_layer.update()


def poses(m, bear):
    """name → function that poses the model."""
    def rest():
        pass

    def up():
        m.rot('body', euler(0.1, 0, 0))
        for sd in 'LR':
            m.arm_to(sd, 0.10, 1.0, -0.14)

    def lean():
        if bear:
            m.rot('body', euler(-1.0, 0, 0)); m.rot('head', euler(0.8, 0, 0))
            m.move('body', 0, 0.20, 0.30)
            m.arm_to('L', 0.25, -0.75, 0.75); m.arm_to('R', 0.25, -0.30, 1.0)
            m.elbow('L', 0.3); m.elbow('R', 0.2)
            m.move('footL', 0, 0.02, 0.22); m.rot('footL', euler(-0.5, 0, 0))
        else:
            m.rot('body', euler(-0.45, 0, 0)); m.rot('head', euler(0.3, 0, 0))
            for sd in 'LR':
                m.arm_to(sd, 0.2, -0.25, 1.0); m.elbow(sd, 0.25, 0.15)

    def lean_raw():
        m.rot('body', euler(-1.0, 0, 0)); m.rot('head', euler(0.8, 0, 0))
        m.arm_to('L', 0.25, -0.75, 0.75); m.arm_to('R', 0.25, -0.30, 1.0)

    def bend():
        for sd in 'LR':
            m.arm_to(sd, 0.42, -1.0, 0.3); m.elbow(sd, 0.7, 0.2)
        m.rot('jaw', euler(-0.42, 0, 0))
        m.move('footL', 0, 0.08, -0.085); m.rot('footL', euler(0.45, 0, 0))

    def walk():
        s, c = 0.9, 0.44
        m.rot('body', euler(0, 0, -s * 0.18)); m.move('body', 0, abs(c) * 0.045, 0)
        m.rot('chest', euler(0, s * 0.1, 0)); m.rot('head', euler(0, 0, s * 0.12))
        m.move('footL', 0, s * 0.075, c * 0.085); m.rot('footL', euler(s * 0.45, 0, 0))
        m.move('footR', 0, 0, -c * 0.085)
        m.arm_to('L', 0.72, -1, 0.04 - c * 0.38); m.arm_to('R', 0.72, -1, 0.04 + c * 0.38)

    def throw():
        m.rot('body', euler(0.16, 0, 0)); m.rot('chest', euler(0, -0.6, 0)); m.rot('head', euler(0, 0.45, 0))
        m.arm_to('R', 0.5, 0.95, -0.8); m.elbow('R', 0.7)
        m.arm_to('L', 0.25, -0.15, 1.0)
        m.rot('jaw', euler(-0.3, 0, 0))
    return dict(rest=rest, up=up, lean=lean, leanraw=lean_raw, bend=bend, walk=walk, throw=throw)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    opts = {a.split('=')[0]: (a.split('=')[1] if '=' in a else '1') for a in sys.argv[1:] if a.startswith('--')}
    name = args[0]
    want = args[1:] or ['rest', 'up', 'lean', 'bend', 'hats', 'walk']
    res = int(opts.get('--res', 700)); samples = int(opts.get('--samples', 32))
    out_dir = opts.get('--out', os.path.join(HERE, 'out'))
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    m = Model(name, lod='--lod' in opts)
    RD.studio()
    H = m.facts['height']
    k = H / 1.15
    mid = H * 0.5
    V = {'front': (25, 8, 4.3 * k, mid), 'back': (155, 12, 4.3 * k, mid), 'side': (90, 5, 4.3 * k, mid), 'face': (12, 4, 2.2 * k, H * 0.78),
         'q': (-40, 10, 4.3 * k, mid), 'top': (165, 35, 4.8 * k, mid), 'sideL': (-90, 5, 4.3 * k, mid), 'head': (25, 6, 2.4 * k, H * 0.86),
         'headside': (95, 6, 2.4 * k, H * 0.86), 'headback': (160, 14, 2.4 * k, H * 0.86), 'front0': (0, 5, 4.3 * k, mid)}
    P = poses(m, name == 'polarbear')
    tag = '_lod' if '--lod' in opts else ''

    def sheet(label, shots, cols):
        paths = []
        for i, (pose, team, hat, view) in enumerate(shots):
            m.reset(); m.hat(None)
            P[pose]()
            m.team(team)
            bpy.context.view_layer.update()
            m.hat(hat)
            az, el, dist, tgt = V[view]
            paths.append(RD.shot(os.path.join(out_dir, f'_r_{name}_{label}{i}.png'), target=(0, 0, tgt), dist=dist, az=az, el=el,
                                 res=(res, res), samples=samples))
        outp = os.path.join(out_dir, f'review_{name}_{label}{tag}.png')
        RD.sheet(paths, outp, cols=cols)
        print('[review]', outp)

    for w in want:
        if w == 'rest':
            sheet('rest_blue', [('rest', 'blue', None, v) for v in ('front', 'back', 'side', 'face')], 2)
            sheet('rest_orange', [('rest', 'orange', None, v) for v in ('front', 'back', 'side', 'face')], 2)
        elif w == 'restblue':
            sheet('rest_blue', [('rest', 'blue', None, v) for v in ('front', 'back', 'side', 'face')], 2)
        elif w == 'up':
            sheet('up', [('up', 'blue', None, v) for v in ('front', 'back', 'side', 'front0')], 2)
        elif w == 'lean':
            sheet('lean', [('lean', 'orange', None, v) for v in ('front', 'side', 'back', 'q')], 2)
        elif w == 'leanraw':
            sheet('leanraw', [('leanraw', 'orange', None, v) for v in ('front', 'side')], 2)
        elif w == 'bend':
            sheet('bend', [('bend', 'blue', None, v) for v in ('front', 'side', 'face', 'q')], 2)
        elif w == 'walk':
            sheet('walk', [('walk', 'orange', None, 'front'), ('walk', 'orange', None, 'back'), ('throw', 'blue', None, 'front'),
                           ('throw', 'blue', None, 'back')], 2)
        elif w == 'hats':
            sheet('hats', [('rest', 'blue', h, v) for h in ('beanie', 'tophat', 'crown') for v in ('head', 'headside', 'headback')], 3)
        elif w == 'hats2':
            sheet('hats2', [('rest', 'orange', h, 'head') for h in ('propeller', 'viking', 'fish', 'party', 'chef', 'cone')], 3)
        elif w == 'top':
            sheet('top', [('rest', 'blue', None, 'top'), ('rest', 'orange', None, 'top')], 2)


if __name__ == '__main__':
    main()
