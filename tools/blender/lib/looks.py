"""Procedural looks (what gets baked) and the glTF materials that read the baked textures."""
import math
from . import bake as B
from .nodes import (rgb, Vec, V, sin, cos, absv, sqrt, frac, floor, vmin, vmax, clamp01, atan2, smooth, lerp, ell, noise,
                    noise_vec, voronoi, bump_band, gt, lt)

TAU = 2 * math.pi

# penguin proportions the looks need (kept in step with penguin.py)
EYE = (0.112, 0.196, 0.915)
EYE_RX, EYE_R, EYE_YAW = 0.074, 0.094, 0.30
JK_ZB, BAFFLE = 0.135, 0.1075
SHOULDER = (0.292, -0.005, 0.585)
ARM_ANG = 0.62


def knit(u, v, wale=0.013, course=0.0095, amp=0.0022):
    """Stockinette: columns of little V stitches. u across the fabric, v along it (metres). Returns height (m) and
    a 0..1 shade (1 = top of a strand)."""
    a = u / wale
    col = frac(a) - 0.5
    ac = absv(col)
    wale_h = 1.0 - (ac * 2.0) ** 2.2
    chev = 0.5 + 0.5 * cos((v / course - ac * 1.55) * TAU)
    h = wale_h * (0.42 + 0.58 * chev)
    return h * amp, h


def fuzz(p, amp=0.0010):
    return (noise(p, 190.0, 2.0, 0.6) - 0.5) * amp


def skin(g):
    p = g.P()
    ax = absv(p.x)
    pm = Vec((ax, p.y, p.z))
    wob = (noise(p, 16.0, 2.0, 0.55) - 0.5) * 0.085 + (noise(p * Vec((1.0, 1.0, 0.25)), 90.0, 1.0) - 0.5) * 0.05
    belly = ell(p, (0, 0.225, 0.335), (0.275, 0.30, 0.365))
    muzzle = ell(p, (0, 0.33, 0.775), (0.20, 0.22, 0.105))
    cheek = ell(pm, (0.135, 0.27, 0.795), (0.125, 0.20, 0.10))
    eyezone = ell(pm, (EYE[0] + 0.005, EYE[1] + 0.05, EYE[2] + 0.012), (0.105, 0.16, 0.118))
    m_belly = smooth(1.04, 0.96, belly + wob)
    m_face = vmax(smooth(1.05, 0.95, muzzle + wob * 0.6), smooth(1.05, 0.95, cheek + wob * 0.6)) * smooth(0.97, 1.09, eyezone + wob * 0.3)
    white = vmax(m_belly, m_face)
    # feathers: deep navy with a cooler, lighter bloom on the crown and back; soft mottling
    mott = noise(p, 9.0, 3.0, 0.6)
    navy = lerp(rgb('#141b2b'), rgb('#27344f'), smooth(0.25, 0.85, mott))
    navy = lerp(navy, rgb('#31405f'), smooth(0.55, 1.15, p.z) * 0.35)
    wcol = lerp(rgb('#eef2fa'), rgb('#fffdf6'), smooth(0.15, 0.6, p.z))
    wcol = lerp(wcol, rgb('#ffe9c4'), bump_band(0.60, 0.11, p.z) * smooth(0.10, 0.25, p.y) * 0.55)  # warm bib under the scarf
    blush = (1.0 - smooth(0.0, 1.0, ell(pm, (0.168, 0.235, 0.812), (0.062, 0.10, 0.043)))) * white
    wcol = lerp(wcol, rgb('#ff8fa6'), blush * 0.85)
    color = lerp(navy, wcol, white)
    # feathery border: tiny strokes where navy meets white
    edge = white * (1.0 - white) * 4.0
    stroke = noise(p * Vec((1.0, 1.0, 0.18)), 150.0, 1.0)
    color = lerp(color, navy, edge * smooth(0.45, 0.65, stroke) * 0.5)
    h = fuzz(p, 0.0005) + (noise(p * Vec((1.0, 1.0, 0.3)), 60.0, 2.0) - 0.5) * 0.0010
    rough = lerp(0.50, 0.66, white) + (mott - 0.5) * 0.10
    return dict(color=color, rough=rough, height=h)


def eye(g):
    p = g.P()
    s = smooth(-0.001, 0.001, p.x) * 2.0 - 1.0
    ax = absv(p.x)
    q = Vec((ax - EYE[0], p.y - EYE[1], p.z - EYE[2]))
    c, sn = math.cos(EYE_YAW), math.sin(EYE_YAW)
    lx = (q.x * c - q.y * sn) / EYE_RX
    ly = (q.x * sn + q.y * c) / EYE_R
    lz = q.z / EYE_R
    # gaze: straight ahead and a touch inward, in the eye's own frame
    gx, gy, gz = -0.07, 1.0, 0.0
    wl = math.sqrt(gx * gx + gy * gy + gz * gz)
    gw = (gx / wl, gy / wl, gz / wl)
    gl = (gw[0] * c - gw[1] * sn, gw[0] * sn + gw[1] * c, gw[2])
    d = Vec((lx - gl[0], ly - gl[1], lz - gl[2])).length()
    iris_r, pupil_r = 0.70, 0.40
    sclera = lerp(rgb('#f6f8fc'), rgb('#b9c4d8'), smooth(0.75, 1.5, d))
    ang_low = clamp01((gl[2] - lz) / iris_r * 0.5 + 0.5)  # 0 at the top of the iris, 1 at the bottom
    iris = lerp(rgb('#2a1608'), rgb('#9a5a1c'), smooth(0.35, 1.0, ang_low) * smooth(pupil_r * 0.8, iris_r, d))
    iris = lerp(iris, rgb('#120903'), smooth(iris_r * 0.86, iris_r, d))
    col = lerp(iris, sclera, smooth(iris_r - 0.02, iris_r + 0.02, d))
    col = lerp(rgb('#05060a'), col, smooth(pupil_r - 0.02, pupil_r + 0.02, d))
    # catchlights: a big one up and to the penguin's left, a small one opposite; same side on both eyes
    h1 = Vec((lx - gl[0] - s * 0.30 * (-1.0), ly - gl[1], lz - gl[2] - 0.30)).length()
    h1 = Vec((lx - (gl[0] + 0.30) , ly - gl[1], lz - (gl[2] + 0.30))).length()
    h2 = Vec((lx - (gl[0] - 0.24), ly - gl[1], lz - (gl[2] - 0.26))).length()
    hi = vmax(smooth(0.19, 0.15, h1), smooth(0.085, 0.06, h2) * 0.85)
    col = lerp(col, rgb('#ffffff'), hi)
    _ = s
    return dict(color=col, rough=lerp(0.07, 0.25, hi), height=V(0.0), emit_hint=hi)


def beak(g):
    p = g.P()
    t = smooth(0.24, 0.40, p.y)
    col = lerp(rgb('#ffab2e'), rgb('#f47a10'), t)
    col = lerp(col, rgb('#ffc85a'), smooth(0.815, 0.86, p.z) * 0.55)  # sunlit ridge on top
    col = lerp(col, rgb('#c9560a'), bump_band(0.793, 0.012, p.z + (p.y - 0.262) * 0.20) * 0.5)  # the mouth line
    ax = absv(p.x)
    nostril = 1.0 - smooth(0.0, 1.0, ell(Vec((ax, p.y, p.z)), (0.026, 0.300, 0.838), (0.007, 0.016, 0.012)))
    col = lerp(col, rgb('#8a3a06'), nostril * 0.8)
    h = (noise(p, 120.0, 2.0) - 0.5) * 0.0005 - nostril * 0.002
    return dict(color=col, rough=0.36 + (noise(p, 30.0) - 0.5) * 0.12, height=h)


def foot(g):
    p = g.P()
    d, _c, _p = voronoi(p * Vec((1.0, 1.0, 1.0)), 85.0, 'F1')
    col = lerp(rgb('#ff9d26'), rgb('#f07a12'), smooth(0.02, 0.09, p.z) * 0.6 + (noise(p, 20.0) - 0.5) * 0.4)
    col = lerp(col, rgb('#d8600a'), smooth(0.25, 0.6, d) * 0.25)
    h = (0.5 - d) * 0.0012
    return dict(color=col, rough=0.50 + d * 0.15, height=h)


def _quilt(p, ds, arc, wr_p):
    """Shared puffer look. ds: distance to the nearest seam (m); arc: arc length along the seam (m)."""
    seam = 1.0 - smooth(0.0, 0.0055, ds)
    dash = smooth(0.25, 0.45, absv(frac(arc / 0.0125) - 0.5) * 2.0)  # 1 on a stitch, 0 in the gap
    thread = (1.0 - smooth(0.0, 0.0022, ds)) * (1.0 - dash)
    near = 1.0 - smooth(0.0, 0.040, ds)
    wr = noise(wr_p, 75.0, 2.0, 0.55) - 0.5
    weave = (noise(p, 420.0, 1.0) - 0.5) * 0.0003
    h = -seam * 0.0030 + thread * 0.0016 + wr * 0.0055 * near * near + weave
    shade = 1.0 - seam * 0.22 + thread * 0.20 - near * (0.5 - wr) * 0.10
    v = 0.86 * shade
    col = Vec((v, v, v))
    rough = 0.50 + seam * 0.25 + (noise(p, 14.0) - 0.5) * 0.10
    return dict(color=col, rough=rough, height=h)


def jacket(g):
    p = g.P()
    t = (p.z - JK_ZB) / BAFFLE
    fr = frac(t)
    ds = vmin(fr, 1.0 - fr) * BAFFLE
    arc = atan2(p.x, p.y) * 0.36
    return _quilt(p, ds, arc, p * Vec((1.0, 1.0, 0.13)))


def sleeve(g):
    p = g.P()
    ax = absv(p.x)
    d = (ax - SHOULDER[0]) * math.sin(ARM_ANG) - (p.z - SHOULDER[2]) * math.cos(ARM_ANG)
    t = (d - 0.005) / 0.092
    fr = frac(t)
    ds = vmin(fr, 1.0 - fr) * 0.092
    # around the sleeve
    across = (ax - SHOULDER[0]) * math.cos(ARM_ANG) + (p.z - SHOULDER[2]) * math.sin(ARM_ANG)
    arc = atan2(p.y - SHOULDER[1], across) * 0.085
    # wrinkles run along the arm: stretch the noise space along the arm direction
    along = Vec((math.sin(ARM_ANG), 0.0, -math.cos(ARM_ANG)))
    pw = Vec((ax, p.y, p.z))
    wr_p = pw - along * (pw.dot(along) * 0.87)
    return _quilt(p, ds, arc, wr_p)


def fleece(g):
    p = g.P()
    d, _c, _p = voronoi(p, 62.0, 'SMOOTH_F1', 1.0, 0.6)
    n = noise(p, 150.0, 2.0, 0.6)
    h = (0.55 - d) * 0.0075 + (n - 0.5) * 0.0028
    col = lerp(rgb('#d9d4cb'), rgb('#fffdf8'), smooth(0.55, 0.10, d))
    return dict(color=col, rough=0.95, height=h)


def piping(g):
    p = g.P()
    teeth = smooth(0.2, 0.5, absv(frac(p.z / 0.011) - 0.5) * 2.0)
    col = lerp(rgb('#aab2c2'), rgb('#f2f5fa'), teeth)
    return dict(color=col, rough=lerp(0.55, 0.32, teeth), metal=V(0.0), height=teeth * 0.0016)


def scarf(g):
    uv = g.uv('param')
    p = g.P()
    h, shade = knit(uv.x, uv.y, 0.0135, 0.0098, 0.0026)
    # two darker stripes near the tail ends (the tint makes them a deeper shade of the team colour)
    stripe = bump_band(0.20, 0.022, p.z) + bump_band(0.135, 0.012, p.z)
    stripe = stripe * smooth(-0.20, -0.26, p.y)
    v = (0.70 + 0.26 * shade) * (1.0 - 0.45 * clamp01(stripe))
    h = h + fuzz(p, 0.0006)
    return dict(color=Vec((v, v, v)), rough=0.92, height=h)


def mitten(g):
    uv = g.uv('param')
    p = g.P()
    h, shade = knit(uv.x, uv.y, 0.0115, 0.0085, 0.0021)
    v = 0.72 + 0.25 * shade
    return dict(color=Vec((v, v, v)), rough=0.93, height=h + fuzz(p, 0.0006))


def mittencuff(g):
    uv = g.uv('param')
    p = g.P()
    rib = 0.5 + 0.5 * cos(uv.y / 0.0155 * TAU)
    h, shade = knit(uv.y, uv.x, 0.0155 / 2.0, 0.008, 0.0010)
    col = lerp(rgb('#cfc8ba'), rgb('#fbf8f0'), smooth(0.1, 0.8, rib) * (0.75 + 0.25 * shade))
    return dict(color=col, rough=0.93, height=rib * 0.0042 + h + fuzz(p, 0.0006))


def penguin_looks(preview_tint=None):
    def tinted(fn, k=1.0):
        def f(g):
            d = fn(g)
            if preview_tint is not None:
                d['color'] = d['color'] * Vec(tuple(1 - (1 - c) * k for c in preview_tint))
            return d
        return f
    fns = dict(skin=skin, eye=eye, beak=beak, foot=foot, jacket=jacket, sleeve=sleeve, fleece=fleece, piping=piping,
               scarf=scarf, mitten=mitten, mittencuff=mittencuff)
    for k in ('jacket', 'sleeve', 'scarf'):
        fns[k] = tinted(fns[k])
    fns['mitten'] = tinted(fns['mitten'], 0.9)
    return {k: B.look('look_' + k, f) for k, f in fns.items()}


def penguin_export_materials(paths):
    return {
        'Penguin': B.export_material('Penguin', paths, sheen=0.35, sheen_rough=0.5, sheen_tint=(0.55, 0.68, 1.0)),
        'Eye': B.export_material('Eye', paths, coat=1.0, coat_rough=0.03),
        'TeamJacket': B.export_material('TeamJacket', paths, tint=(0.03, 0.26, 1.0)),
        'TeamScarf': B.export_material('TeamScarf', paths, tint=(0.03, 0.26, 1.0), sheen=0.3, sheen_rough=0.7),
        'Mitten': B.export_material('Mitten', paths, tint=(0.12, 0.38, 1.0), sheen=0.3, sheen_rough=0.7),
    }
