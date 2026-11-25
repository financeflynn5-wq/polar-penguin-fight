"""A tiny expression language over Blender shader nodes, so procedural looks can be written as maths.

    with Graph(material) as g:
        p = g.P()                      # object-space position (Vec)
        h = sin(p.z * 40) * 0.002      # V (scalar)
        col = lerp(rgb('#ff0000'), rgb('#ffffff'), smooth(0.1, 0.2, p.y))

Scalars are V, vectors/colours are Vec. Constants fold in Python, so only real work becomes nodes.
"""
import math
import bpy

_G = None


def rgb(hexstr):
    """sRGB hex → linear (r, g, b) tuple."""
    h = hexstr.lstrip('#')
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return Vec(tuple(out))


def _isnum(x):
    return isinstance(x, (int, float))


class V:
    def __init__(self, x):
        self.x = x.x if isinstance(x, V) else x

    @property
    def const(self):
        return _isnum(self.x)

    def __add__(self, o): return _math('ADD', self, o)
    def __radd__(self, o): return _math('ADD', o, self)
    def __sub__(self, o): return _math('SUBTRACT', self, o)
    def __rsub__(self, o): return _math('SUBTRACT', o, self)
    def __mul__(self, o):
        if isinstance(o, Vec):
            return o * self
        return _math('MULTIPLY', self, o)
    def __rmul__(self, o): return _math('MULTIPLY', o, self)
    def __truediv__(self, o): return _math('DIVIDE', self, o)
    def __rtruediv__(self, o): return _math('DIVIDE', o, self)
    def __neg__(self): return _math('MULTIPLY', self, -1.0)
    def __pow__(self, o): return _math('POWER', self, o)


_FOLD = {
    'ADD': lambda a, b: a + b, 'SUBTRACT': lambda a, b: a - b, 'MULTIPLY': lambda a, b: a * b,
    'DIVIDE': lambda a, b: a / b if b else 0.0, 'POWER': lambda a, b: a ** b if a >= 0 else 0.0,
    'MINIMUM': min, 'MAXIMUM': max, 'SINE': math.sin, 'COSINE': math.cos, 'ABSOLUTE': abs,
    'SQRT': lambda a: math.sqrt(max(a, 0)), 'FRACT': lambda a: a - math.floor(a), 'FLOOR': math.floor,
    'LESS_THAN': lambda a, b: 1.0 if a < b else 0.0, 'GREATER_THAN': lambda a, b: 1.0 if a > b else 0.0,
    'ARCTAN2': math.atan2, 'SIGN': lambda a: (a > 0) - (a < 0), 'EXPONENT': math.exp,
}


def _math(op, *args, clamp=False):
    args = [a if isinstance(a, V) else V(a) for a in args]
    if all(a.const for a in args) and op in _FOLD:
        r = _FOLD[op](*[a.x for a in args])
        return V(min(1.0, max(0.0, r)) if clamp else float(r))
    n = _G.nodes.new('ShaderNodeMath'); n.operation = op; n.use_clamp = clamp
    for i, a in enumerate(args):
        if a.const:
            n.inputs[i].default_value = a.x
        else:
            _G.links.new(a.x, n.inputs[i])
    return V(n.outputs[0])


def sin(a): return _math('SINE', a)
def cos(a): return _math('COSINE', a)
def absv(a): return _math('ABSOLUTE', a)
def sqrt(a): return _math('SQRT', a)
def frac(a): return _math('FRACT', a)
def floor(a): return _math('FLOOR', a)
def vmin(a, b): return _math('MINIMUM', a, b)
def vmax(a, b): return _math('MAXIMUM', a, b)
def clamp01(a): return _math('ADD', a, 0.0, clamp=True)
def atan2(a, b): return _math('ARCTAN2', a, b)
def lt(a, b): return _math('LESS_THAN', a, b)
def gt(a, b): return _math('GREATER_THAN', a, b)
def smin(a, b, k): return _math('SMOOTH_MIN', a, b, k)
def smax(a, b, k): return _math('SMOOTH_MAX', a, b, k)
def exp(a): return _math('EXPONENT', a)


def smooth(lo, hi, x):
    """smoothstep(lo, hi, x), clamped. lo > hi gives a falling edge."""
    x = x if isinstance(x, V) else V(x)
    if _isnum(lo) and _isnum(hi) and lo > hi:
        return 1.0 - smooth(hi, lo, x)
    n = _G.nodes.new('ShaderNodeMapRange'); n.interpolation_type = 'SMOOTHSTEP'
    for i, a in enumerate((x, lo, hi, 0.0, 1.0)):
        a = a if isinstance(a, V) else V(a)
        if a.const:
            n.inputs[i].default_value = a.x
        else:
            _G.links.new(a.x, n.inputs[i])
    return V(n.outputs[0])


def bump_band(c, w, x):
    """A smooth bump of half-width w centred on c: 1 at c, 0 beyond c±w."""
    return 1.0 - smooth(0.0, w, absv(x - c))


class Vec:
    def __init__(self, x):
        self.sock = None; self.c = None; self._xyz = None
        if isinstance(x, Vec):
            self.sock, self.c, self._xyz = x.sock, x.c, x._xyz
        elif isinstance(x, (tuple, list)):
            if all(_isnum(a) for a in x):
                self.c = tuple(float(a) for a in x)
            else:
                comps = [a if isinstance(a, V) else V(a) for a in x]
                n = _G.nodes.new('ShaderNodeCombineXYZ')
                for i, a in enumerate(comps):
                    if a.const:
                        n.inputs[i].default_value = a.x
                    else:
                        _G.links.new(a.x, n.inputs[i])
                self.sock = n.outputs[0]; self._xyz = comps
        else:
            self.sock = x

    def _sep(self):
        if self._xyz is None:
            if self.c is not None:
                self._xyz = [V(a) for a in self.c]
            else:
                n = _G.nodes.new('ShaderNodeSeparateXYZ')
                _G.links.new(self.sock, n.inputs[0])
                self._xyz = [V(o) for o in n.outputs]
        return self._xyz

    @property
    def x(self): return self._sep()[0]
    @property
    def y(self): return self._sep()[1]
    @property
    def z(self): return self._sep()[2]

    def _vm(self, op, o=None, scale=None):
        n = _G.nodes.new('ShaderNodeVectorMath'); n.operation = op
        for i, a in enumerate([self] + ([o] if o is not None else [])):
            a = a if isinstance(a, Vec) else Vec(a)
            if a.c is not None:
                n.inputs[i].default_value = a.c
            else:
                _G.links.new(a.sock, n.inputs[i])
        if scale is not None:
            s = scale if isinstance(scale, V) else V(scale)
            if s.const:
                n.inputs['Scale'].default_value = s.x
            else:
                _G.links.new(s.x, n.inputs['Scale'])
        return n

    def __add__(self, o):
        o = o if isinstance(o, Vec) else Vec(o)
        if self.c is not None and o.c is not None:
            return Vec(tuple(a + b for a, b in zip(self.c, o.c)))
        return Vec(self._vm('ADD', o).outputs[0])
    __radd__ = __add__

    def __sub__(self, o):
        o = o if isinstance(o, Vec) else Vec(o)
        if self.c is not None and o.c is not None:
            return Vec(tuple(a - b for a, b in zip(self.c, o.c)))
        return Vec(self._vm('SUBTRACT', o).outputs[0])

    def __mul__(self, o):
        if isinstance(o, (tuple, list)):
            o = Vec(o)
        if isinstance(o, Vec):
            if self.c is not None and o.c is not None:
                return Vec(tuple(a * b for a, b in zip(self.c, o.c)))
            return Vec(self._vm('MULTIPLY', o).outputs[0])
        o = o if isinstance(o, V) else V(o)
        if self.c is not None and o.const:
            return Vec(tuple(a * o.x for a in self.c))
        return Vec(self._vm('SCALE', scale=o).outputs[0])
    __rmul__ = __mul__

    def length(self):
        if self.c is not None:
            return V(math.sqrt(sum(a * a for a in self.c)))
        return V(self._vm('LENGTH').outputs['Value'])

    def dot(self, o):
        return V(self._vm('DOT_PRODUCT', o).outputs['Value'])


def lerp(a, b, t):
    """Mix two Vecs (or two scalars) by scalar t."""
    if isinstance(a, Vec) or isinstance(b, Vec) or isinstance(a, tuple) or isinstance(b, tuple):
        a = a if isinstance(a, Vec) else Vec(a)
        b = b if isinstance(b, Vec) else Vec(b)
        return a + (b - a) * t
    return a + (b - a) * t


def ell(p, c, r):
    """Normalised ellipsoid distance: < 1 inside, 1 on the surface."""
    q = (p - Vec(c)) * Vec(tuple(1.0 / x for x in r))
    return q.length()


def noise(p, scale=5.0, detail=2.0, rough=0.5, distortion=0.0):
    """Perlin fBm, 0..1 (about 0.5 mean)."""
    n = _G.nodes.new('ShaderNodeTexNoise'); n.noise_dimensions = '3D'
    p = p if isinstance(p, Vec) else Vec(p)
    _G.links.new(p.sock, n.inputs['Vector'])
    n.inputs['Scale'].default_value = scale
    n.inputs['Detail'].default_value = detail
    n.inputs['Roughness'].default_value = rough
    n.inputs['Distortion'].default_value = distortion
    return V(n.outputs[0])


def noise_vec(p, scale=5.0, detail=2.0, rough=0.5):
    """Colour noise as a Vec (0..1 per channel)."""
    n = _G.nodes.new('ShaderNodeTexNoise'); n.noise_dimensions = '3D'
    _G.links.new(p.sock, n.inputs['Vector'])
    n.inputs['Scale'].default_value = scale
    n.inputs['Detail'].default_value = detail
    n.inputs['Roughness'].default_value = rough
    return Vec(n.outputs[1])


def voronoi(p, scale=5.0, feature='F1', randomness=1.0, smoothness=0.5):
    """Returns (distance V, colour Vec, position Vec)."""
    n = _G.nodes.new('ShaderNodeTexVoronoi'); n.voronoi_dimensions = '3D'; n.feature = feature
    _G.links.new(p.sock, n.inputs['Vector'])
    n.inputs['Scale'].default_value = scale
    n.inputs['Randomness'].default_value = randomness
    if feature == 'SMOOTH_F1':
        n.inputs['Smoothness'].default_value = smoothness
    pos = n.outputs.get('Position')
    return V(n.outputs['Distance']), Vec(n.outputs['Color']), (Vec(pos) if pos else None)


class Graph:
    def __init__(self, mat):
        self.mat = mat
        mat.use_nodes = True
        self.nt = mat.node_tree
        self.nodes = self.nt.nodes; self.links = self.nt.links
        self.nodes.clear()
        self._tc = None; self._geo = None

    def __enter__(self):
        global _G
        self._prev = _G
        _G = self
        return self

    def __exit__(self, *a):
        global _G
        _G = self._prev

    def P(self):
        """Object-space position."""
        if self._tc is None:
            self._tc = self.nodes.new('ShaderNodeTexCoord')
        return Vec(self._tc.outputs['Object'])

    def uv(self, name='param'):
        n = self.nodes.new('ShaderNodeUVMap'); n.uv_map = name
        return Vec(n.outputs[0])

    def attr(self, name):
        """A named mesh attribute as a scalar."""
        n = self.nodes.new('ShaderNodeAttribute'); n.attribute_name = name
        return V(n.outputs['Fac'] if 'Fac' in n.outputs else n.outputs[2])

    def normal(self):
        if self._geo is None:
            self._geo = self.nodes.new('ShaderNodeNewGeometry')
        return Vec(self._geo.outputs['Normal'])


def sock_of(val):
    """A socket carrying val (V or Vec); constants get a Value / RGB node."""
    if isinstance(val, Vec):
        if val.c is not None:
            n = _G.nodes.new('ShaderNodeCombineXYZ')
            for i in range(3):
                n.inputs[i].default_value = val.c[i]
            return n.outputs[0]
        return val.sock
    val = val if isinstance(val, V) else V(val)
    if val.const:
        n = _G.nodes.new('ShaderNodeValue'); n.outputs[0].default_value = val.x
        return n.outputs[0]
    return val.x
