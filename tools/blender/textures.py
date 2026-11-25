"""Tileable PBR texture sets for the Blender-made props (gingerbread, icing, candy, wood, snow, ice ...).

Every set is three square images that tile seamlessly in both directions:
  <name>_color.webp   base colour (sRGB)
  <name>_normal.webp  tangent-space normal map (OpenGL convention, +Y up)
  <name>_orm.webp     occlusion (R), roughness (G), metalness (B), the layout three.js and glTF expect

The noise is made in the frequency domain (random phases, a shaped spectrum), which is what makes it wrap perfectly.
Run:  python tools/blender/textures.py   (needs numpy and Pillow; no Blender needed for this step)
"""
import os
import numpy as np
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'textures')


def fnoise(n, beta, seed, lo=1.0, hi=None, aniso=(1.0, 1.0)):
    """Tileable noise in 0..1 with a 1/f^beta spectrum between wavelengths n/hi and n/lo pixels.
    aniso stretches it: (4, 1) gives streaks that run along x."""
    rng = np.random.default_rng(seed)
    fy = np.fft.fftfreq(n)[:, None] * n * aniso[1]
    fx = np.fft.fftfreq(n)[None, :] * n * aniso[0]
    f = np.sqrt(fx * fx + fy * fy)
    amp = np.zeros_like(f)
    mask = f >= lo
    if hi is not None:
        mask &= f <= hi
    amp[mask] = f[mask] ** (-beta)
    spec = amp * np.exp(2j * np.pi * rng.random((n, n)))
    v = np.real(np.fft.ifft2(spec))
    v -= v.min()
    return v / v.max()


def blur(a, r):
    """Wrapped gaussian blur (frequency domain)."""
    n = a.shape[0]
    fy = np.fft.fftfreq(n)[:, None]
    fx = np.fft.fftfreq(n)[None, :]
    g = np.exp(-2 * (np.pi * r) ** 2 * (fx * fx + fy * fy))
    return np.real(np.fft.ifft2(np.fft.fft2(a) * g))


def norm01(a):
    a = a - a.min()
    return a / max(1e-9, a.max())


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def normal_map(height, strength):
    """height in 0..1 (wrapping) to an RGB normal map. strength = how tall 1.0 of height is, in texels."""
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * 0.5 * strength
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * 0.5 * strength
    nz = 1.0 / np.sqrt(dx * dx + dy * dy + 1)
    # image rows run downward, the normal map's green points up
    return np.stack([(-dx * nz) * 0.5 + 0.5, (dy * nz) * 0.5 + 0.5, nz * 0.5 + 0.5], -1)


def ao_from_height(height, r=6, amount=1.0):
    """Cheap cavity occlusion: how far a texel sits below its blurred surroundings."""
    return np.clip(1 - np.clip(blur(height, r) - height, 0, 1) * amount, 0, 1)


def srgb(hexcol):
    return np.array([(hexcol >> 16) & 255, (hexcol >> 8) & 255, hexcol & 255], float) / 255


def ramp(t, stops):
    """Colour ramp: stops = [(pos, 0xRRGGBB), ...] in rising order, t in 0..1."""
    t = np.clip(t, 0, 1)
    out = np.zeros(t.shape + (3,))
    for (p0, c0), (p1, c1) in zip(stops[:-1], stops[1:]):
        k = np.clip((t - p0) / max(1e-9, p1 - p0), 0, 1)[..., None]
        m = ((t >= p0) & (t <= p1))[..., None]
        out = np.where(m, srgb(c0) * (1 - k) + srgb(c1) * k, out)
    out = np.where((t < stops[0][0])[..., None], srgb(stops[0][1]), out)
    out = np.where((t > stops[-1][0])[..., None], srgb(stops[-1][1]), out)
    return out


def save(name, color, normal, ao, rough, metal=0.0, quality=90):
    os.makedirs(OUT, exist_ok=True)
    n = color.shape[0]
    to8 = lambda a: (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(to8(color)).save(os.path.join(OUT, f'{name}_color.webp'), quality=quality, method=6)
    Image.fromarray(to8(normal)).save(os.path.join(OUT, f'{name}_normal.webp'), quality=max(quality, 92), method=6)
    m = np.full((n, n), metal) if np.isscalar(metal) else metal
    Image.fromarray(to8(np.stack([ao, rough, m], -1))).save(os.path.join(OUT, f'{name}_orm.webp'), quality=quality, method=6)
    print('wrote', name, n)


def spots(n, count, r0, r1, seed, soft=0.5):
    """Round pits scattered at random (wrapping). Returns 0..1, 1 at a pit's centre."""
    rng = np.random.default_rng(seed)
    out = np.zeros((n, n))
    yy, xx = np.mgrid[0:n, 0:n]
    for _ in range(count):
        cx, cy, r = rng.random() * n, rng.random() * n, r0 + rng.random() ** 2 * (r1 - r0)
        dx = np.abs(xx - cx); dx = np.minimum(dx, n - dx)
        dy = np.abs(yy - cy); dy = np.minimum(dy, n - dy)
        # only touch the neighbourhood
        d = np.sqrt(dx * dx + dy * dy)
        out = np.maximum(out, 1 - smooth(r * soft, r, d))
    return out


def gingerbread(n=1024):
    """Baked biscuit: warm brown, darker where it caught the oven, tiny air holes, a soft orange-peel surface."""
    big = fnoise(n, 2.2, 1, 1, 6)
    mid = fnoise(n, 1.6, 2, 6, 40)
    fine = fnoise(n, 0.8, 3, 40, 220)
    grain = fnoise(n, 0.2, 4, 150, 500)
    pores = spots(n, 900, 1.2, 4.5, 5, soft=0.35)
    cracks = smooth(0.80, 0.9, fnoise(n, 1.4, 6, 8, 60, aniso=(1, 1))) * smooth(0.55, 0.75, fnoise(n, 2, 7, 2, 10))
    height = 0.5 + (mid - 0.5) * 0.5 + (fine - 0.5) * 0.25 + (grain - 0.5) * 0.06 - pores * 0.5 - cracks * 0.12
    height = norm01(height)
    tone = np.clip(0.5 + (big - 0.5) * 0.42 + (mid - 0.5) * 0.5 + (fine - 0.5) * 0.3, 0, 1)
    col = ramp(tone, [(0.0, 0x5e2d10), (0.35, 0x7c4019), (0.6, 0x8f4f20), (0.85, 0xa05e29), (1.0, 0xb27034)])
    col *= (1 - pores * 0.42)[..., None]
    col *= (0.93 + grain * 0.14)[..., None]
    rough = np.clip(0.80 + (fine - 0.5) * 0.25 + pores * 0.1, 0, 1)
    save('gingerbread', col, normal_map(height, 26), ao_from_height(height, 5, 1.6), rough)


def icing(n=512):
    """Royal icing: off-white, satin, set with a slightly lumpy skin and the odd pinhole."""
    big = fnoise(n, 2.4, 11, 1, 5)
    mid = fnoise(n, 1.8, 12, 5, 30)
    fine = fnoise(n, 1.0, 13, 40, 200)
    holes = spots(n, 60, 1.0, 2.6, 14, soft=0.4)
    height = norm01(0.5 + (big - 0.5) * 0.6 + (mid - 0.5) * 0.35 + (fine - 0.5) * 0.05 - holes * 0.25)
    col = ramp(0.5 + (big - 0.5) * 0.9 + (mid - 0.5) * 0.4, [(0.0, 0xf1e9dc), (0.5, 0xfbf6ee), (1.0, 0xffffff)])
    col *= (1 - holes * 0.12)[..., None]
    rough = np.clip(0.42 + (mid - 0.5) * 0.25 + (fine - 0.5) * 0.12, 0, 1)
    save('icing', col, normal_map(height, 9), ao_from_height(height, 6, 0.8), rough)


def candy(n=512):
    """Candy cane stripes for a tube whose u runs round it and v along it: one wide red band and two thin ones,
    spiralling. Hard, glossy boiled sugar with faint pull lines along the stripes."""
    yy, xx = np.mgrid[0:n, 0:n] / n
    t = (xx + yy) % 1.0
    aa = 1.5 / n
    band = lambda a, b: smooth(a - aa, a + aa, t) * (1 - smooth(b - aa, b + aa, t))
    red = np.clip(band(0.04, 0.36) + band(0.50, 0.56) + band(0.80, 0.86), 0, 1)
    pull = fnoise(n, 1.2, 21, 2, 120, aniso=(1, 1))
    # pull lines follow the spiral: sample noise in a sheared frame
    streak = np.sin((xx - yy) * np.pi * 2 * 1) * 0  # (kept flat: boiled sugar is smooth)
    white = ramp(0.5 + (pull - 0.5) * 0.5, [(0, 0xf3eee6), (1, 0xffffff)])
    redc = ramp(0.5 + (pull - 0.5) * 0.7, [(0, 0xb50f1c), (0.5, 0xd61f2c), (1, 0xe8383f)])
    col = white * (1 - red[..., None]) + redc * red[..., None]
    edge = np.abs(np.gradient(red, axis=0)) + np.abs(np.gradient(red, axis=1))
    height = norm01(0.5 + red * 0.04 + (blur(pull, 2) - 0.5) * 0.08 + streak)
    rough = np.clip(0.16 + (pull - 0.5) * 0.1 + np.clip(edge * 2, 0, 0.08), 0, 1)
    save('candy', col, normal_map(height, 3.5), np.ones((n, n)), rough)


def sugar(n=512):
    """Sugar-crusted jelly (gumdrops): almost white so the vertex colour tints it, with a sharp crystalline grain."""
    grain = fnoise(n, 0.0, 31, 60, 256)
    mid = fnoise(n, 1.5, 32, 4, 30)
    crystals = smooth(0.62, 0.8, grain)
    height = norm01(grain * 0.8 + crystals * 0.5 + (mid - 0.5) * 0.3)
    v = 0.80 + crystals * 0.2 + (mid - 0.5) * 0.08
    col = np.stack([v, v, v], -1)
    rough = np.clip(0.55 - crystals * 0.3 + (mid - 0.5) * 0.1, 0, 1)
    save('sugar', col, normal_map(height, 14), ao_from_height(height, 3, 1.2), rough)


def wood(n=1024, name='wood', boards=4, seed=40, palette=None):
    """Sawn planks, grain running along v. `boards` planks across the tile, each with its own tone, a few knots,
    dark seams between them."""
    yy, xx = np.mgrid[0:n, 0:n] / n
    grain = fnoise(n, 1.0, seed, 3, 400, aniso=(1, 28))
    rings = fnoise(n, 1.8, seed + 1, 1, 12, aniso=(1, 8))
    fine = fnoise(n, 0.4, seed + 2, 80, 400, aniso=(1, 5))
    lines = 0.5 + 0.5 * np.sin((xx * boards * 9 + rings * 14) * np.pi * 2)
    knots = spots(n, 9, 10, 26, seed + 3, soft=0.2)
    knots = np.clip(knots * 1.2, 0, 1)
    bx = (xx * boards) % 1.0
    bid = np.floor(xx * boards)
    seam = 1 - smooth(0.0, 0.035, np.minimum(bx, 1 - bx))
    rng = np.random.default_rng(seed + 4)
    tones = rng.random(boards)
    tone_b = tones[bid.astype(int) % boards]
    if boards == 1:
        seam *= 0
        tone_b = np.full((n, n), 0.5)
    tone = np.clip(0.5 + (tone_b - 0.5) * 0.45 + (grain - 0.5) * 0.7 + (lines - 0.5) * 0.22 - knots * 0.5, 0, 1)
    pal = palette or [(0.0, 0x4b2d17), (0.3, 0x6e4526), (0.6, 0x8a5c34), (0.85, 0xa5733f), (1.0, 0xb98a52)]
    col = ramp(tone, pal)
    col *= (1 - seam * 0.6)[..., None]
    height = norm01(0.6 + (grain - 0.5) * 0.5 + (lines - 0.5) * 0.12 + (fine - 0.5) * 0.12 - seam * 0.9 - knots * 0.15)
    rough = np.clip(0.72 + (grain - 0.5) * 0.2 + seam * 0.1, 0, 1)
    save(name, col, normal_map(height, 16), ao_from_height(height, 5, 1.8), rough)


def logend(n=512):
    """The sawn end of a log: growth rings round a slightly off-centre pith, a few radial checks. Not tiling."""
    yy, xx = np.mgrid[0:n, 0:n] / n - 0.5
    wob = fnoise(n, 2.0, 61, 1, 6) - 0.5
    r = np.sqrt((xx - 0.03) ** 2 + (yy + 0.02) ** 2) * (1 + wob * 0.25)
    a = np.arctan2(yy, xx)
    rings = 0.5 + 0.5 * np.sin(r * 2 * np.pi * 26 + wob * 6)
    fine = fnoise(n, 0.5, 62, 60, 250)
    checks = np.zeros((n, n))
    for a0, w, l0 in [(0.4, 0.035, 0.05), (2.3, 0.03, 0.12), (-1.6, 0.04, 0.02), (-2.8, 0.025, 0.2)]:
        da = np.abs(np.angle(np.exp(1j * (a - a0))))
        checks = np.maximum(checks, (1 - smooth(0, w * (0.25 / np.maximum(r, 0.02)) * 0.4, da)) * smooth(l0, l0 + 0.05, r) * (1 - smooth(0.38, 0.47, r)))
    tone = np.clip(0.62 + (rings - 0.5) * 0.3 - smooth(0.36, 0.5, r) * 0.45 + (fine - 0.5) * 0.15 - checks * 0.6 - smooth(0.04, 0.0, r) * 0.3, 0, 1)
    col = ramp(tone, [(0.0, 0x4a2c16), (0.35, 0x8a5a30), (0.7, 0xc0935a), (1.0, 0xdcb680)])
    height = norm01(0.5 + (rings - 0.5) * 0.25 + (fine - 0.5) * 0.2 - checks * 0.9)
    rough = np.clip(0.8 + (fine - 0.5) * 0.15, 0, 1)
    save('logend', col, normal_map(height, 10), ao_from_height(height, 4, 1.5), rough)


def snow(n=512):
    """Settled snow on roofs and ledges: soft lumps, a fine sparkle grain, the faintest blue in the hollows."""
    big = fnoise(n, 2.6, 71, 1, 6)
    mid = fnoise(n, 2.0, 72, 6, 40)
    grain = fnoise(n, 0.3, 73, 90, 256)
    height = norm01(0.5 + (big - 0.5) * 0.9 + (mid - 0.5) * 0.3 + (grain - 0.5) * 0.05)
    col = ramp(height, [(0.0, 0xdfe9f7), (0.5, 0xf2f6fc), (1.0, 0xffffff)])
    rough = np.clip(0.86 - smooth(0.7, 0.9, grain) * 0.35, 0, 1)
    save('snow', col, normal_map(blur(height, 0.6) + (grain - 0.5) * 0.02, 7), ao_from_height(height, 10, 0.5), rough)


def ice(n=1024):
    """Sawn lake ice: glassy blue with trapped white bubbles in streaks, frost bloom, and the saw's marks across it."""
    yy, xx = np.mgrid[0:n, 0:n] / n
    big = fnoise(n, 2.2, 81, 1, 5)
    veins = fnoise(n, 1.4, 82, 2, 60, aniso=(0.25, 1))
    bubbles = smooth(0.62, 0.86, fnoise(n, 0.9, 83, 20, 200, aniso=(0.4, 1))) * smooth(0.45, 0.7, fnoise(n, 2, 84, 1, 6))
    frost = smooth(0.52, 0.8, fnoise(n, 1.7, 85, 2, 80)) * 0.8
    saw = 0.5 + 0.5 * np.sin((yy * 46 + fnoise(n, 2, 86, 1, 4) * 1.6) * 2 * np.pi)
    saw2 = fnoise(n, 0.6, 87, 30, 300, aniso=(0.06, 1))
    cracks = smooth(0.86, 0.93, fnoise(n, 1.3, 88, 3, 50))
    tone = np.clip(0.42 + (big - 0.5) * 0.5 + (veins - 0.5) * 0.3, 0, 1)
    col = ramp(tone, [(0.0, 0x4a9fdb), (0.4, 0x6fbbe9), (0.75, 0x98d2f3), (1.0, 0xc4e7fa)])
    white = np.clip(bubbles * 0.5 + frost * 0.28 + cracks * 0.75, 0, 1)[..., None]
    col = col * (1 - white) + srgb(0xf2fbff) * white
    height = norm01(0.5 + (saw - 0.5) * 0.10 + (saw2 - 0.5) * 0.25 + frost * 0.12 - cracks * 0.3 + (big - 0.5) * 0.2)
    rough = np.clip(0.08 + frost * 0.3 + bubbles * 0.15 + (saw2 - 0.5) * 0.1 + cracks * 0.3, 0.04, 1)
    save('ice', col, normal_map(height, 7), ao_from_height(height, 4, 0.8), rough)


def canvas(n=512):
    """Waxed canvas tarp: an over-under weave, slubs in the thread, pale so the vertex colour dyes it."""
    yy, xx = np.mgrid[0:n, 0:n] / n
    k = 64
    warp = 0.5 + 0.5 * np.sin(xx * k * 2 * np.pi)
    weft = 0.5 + 0.5 * np.sin(yy * k * 2 * np.pi)
    over = (np.floor(xx * k) + np.floor(yy * k)) % 2
    weave = np.where(over > 0.5, warp * 0.9 + weft * 0.25, weft * 0.9 + warp * 0.25)
    slub = fnoise(n, 1.0, 91, 4, 120, aniso=(1, 0.08)) * 0.5 + fnoise(n, 1.0, 92, 4, 120, aniso=(0.08, 1)) * 0.5
    wear = fnoise(n, 2.2, 93, 1, 8)
    height = norm01(weave * 0.7 + (slub - 0.5) * 0.5 + (wear - 0.5) * 0.4)
    v = 0.74 + (weave - 0.5) * 0.16 + (slub - 0.5) * 0.14 + (wear - 0.5) * 0.18
    col = np.stack([v, v * 0.985, v * 0.96], -1)
    rough = np.clip(0.78 + (wear - 0.5) * 0.2 - (weave - 0.5) * 0.08, 0, 1)
    save('canvas', col, normal_map(height, 5), ao_from_height(height, 2, 1.2), rough)


def stone(n=512):
    """Rounded river stone for chimneys: grey with warm and cool patches, pitted, a little lichen."""
    big = fnoise(n, 2.2, 101, 1, 6)
    mid = fnoise(n, 1.5, 102, 6, 50)
    fine = fnoise(n, 0.7, 103, 50, 250)
    pits = spots(n, 260, 1.0, 3.5, 104, soft=0.4)
    tone = np.clip(0.5 + (big - 0.5) * 0.9 + (mid - 0.5) * 0.5 + (fine - 0.5) * 0.2, 0, 1)
    col = ramp(tone, [(0.0, 0x5a5f69), (0.4, 0x7d8088), (0.7, 0x9a9790), (1.0, 0xb9b4a8)])
    col *= (1 - pits * 0.3)[..., None]
    height = norm01(0.5 + (mid - 0.5) * 0.6 + (fine - 0.5) * 0.3 - pits * 0.4)
    rough = np.clip(0.82 + (fine - 0.5) * 0.2, 0, 1)
    save('stone', col, normal_map(height, 18), ao_from_height(height, 5, 1.6), rough)


def mint(n=512):
    """A peppermint: red blades swirling out from the middle of a white disc. Not tiling (it maps onto a disc)."""
    yy, xx = np.mgrid[0:n, 0:n] / n - 0.5
    r = np.sqrt(xx * xx + yy * yy) * 2
    a = np.arctan2(yy, xx)
    t = ((a + r * 2.4) / (2 * np.pi) * 8) % 1.0
    aa = 0.02 / np.maximum(r, 0.05)
    red = smooth(0.0, aa, t) * (1 - smooth(0.46, 0.46 + aa, t))
    red *= smooth(0.06, 0.12, r) * (1 - smooth(0.9, 0.93, r))
    pull = fnoise(n, 1.4, 111, 2, 80)
    white = ramp(0.5 + (pull - 0.5) * 0.4, [(0, 0xf4efe8), (1, 0xffffff)])
    redc = ramp(0.5 + (pull - 0.5) * 0.6, [(0, 0xb50f1c), (0.5, 0xd61f2c), (1, 0xe8383f)])
    col = white * (1 - red[..., None]) + redc * red[..., None]
    height = norm01(0.5 + red * 0.05 + (blur(pull, 2) - 0.5) * 0.06 - smooth(0.9, 1.0, r) * 0.3)
    rough = np.clip(0.18 + (pull - 0.5) * 0.1, 0, 1)
    save('mint', col, normal_map(height, 3.5), np.ones((n, n)), rough)


if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1:
        for name in sys.argv[1:]: globals()[name]()
        sys.exit()
    gingerbread()
    icing()
    candy()
    sugar()
    wood()
    wood(1024, 'log', boards=1, seed=50, palette=[(0.0, 0x3f2614), (0.3, 0x65401f), (0.6, 0x84572c), (0.85, 0x9d6c3a), (1.0, 0xb1824b)])
    logend()
    snow()
    ice()
    canvas()
    stone()
    mint()
