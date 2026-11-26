# Blender assets

The penguin and every hat are built by Python scripts that drive Blender. Nothing is hand-edited: change a script,
run it again, and the `.glb` files in `src/assets/models/` are rebuilt.

## Setup

    pip install bpy pillow        # Blender as a Python module (Blender 5.x, Python 3.13)

## Rebuild

    python tools/blender/penguin.py                 # → src/assets/models/penguin.glb   (about 4 minutes)
    python tools/blender/hats.py                    # → src/assets/models/hats/*.glb    (about 3 minutes)
    python tools/blender/hats.py beanie crown       # just these hats

Useful options:

    penguin.py --size=1024        quicker draft (the real one is 2048)
    penguin.py --shapes           grey renders of the sculpt only, no baking
    hats.py --size=512 --ao=16    quick draft

Baked textures are also written to `tools/blender/out/` (not checked in).

## How it works

- `lib/geom.py`: shapes are written as maths (smooth blends of ellipsoids, capsules and so on) and skinned with clean
  quad grids. Every grid is its own rectangle in the texture, so nothing has to be unwrapped by hand.
- `lib/nodes.py`, `lib/looks.py`: materials are written as small formulas (knit stitches, quilting, feathers, scales).
- `lib/bake.py`: packs the texture atlas and bakes each look into colour, normal and
  occlusion/roughness/metal textures, so the game only draws ordinary textured meshes.
- `lib/rig.py`: the skeleton and skin weights. Every bone stands straight up, so in the game a joint's rotation is
  simply "how far from the rest pose".
- `lib/export.py`: writes the GLB with WebP textures.

## The penguin

One mesh, five materials: `Penguin` (feathers, beak, feet), `Eye`, `TeamJacket`, `TeamScarf` and `Mitten`. The last
three are baked in neutral greys and tinted in the game, which is how the two teams and the mitten upgrades get
their colours. The joints are listed in `bones()` in `penguin.py`; `src/render/PenguinModel.ts` animates them.

## Hats

Each hat is modelled around the penguin's head and saved with its origin at the head's `hat` joint. Parts named
`spin…` turn (the propeller) and parts named `jiggle…` wobble on a spring (pom-poms, the fish's tail).
To add a hat: write a `hat_<name>()` function in `hats.py`, add it to `HATS`, and add the name to `HATS` in
`src/sim/World.ts`.

## Guns

    python tools/blender/guns.py                 # → src/assets/models/guns/cocoa.glb, water.glb and blade.glb   (about 3 minutes)
    python tools/blender/guns.py water           # just one
    python tools/blender/guns.py cocoa --shapes  # quick Cycles renders for judging shape (no bake, no export)

`cocoa` is the Hot Chocolate Blaster (a mug of cocoa on a chocolate-dipped biscuit, candy-cane barrel, copper bell)
and `water` is the Freeze Soaker (water bottle on a teal body, yellow pump, frost and icicles at the nozzle). Each is
one mesh with one material (`Gun_cocoa`, `Gun_water`) and 1024 px baked textures.

What the game relies on:

- In the GLB the barrel points along -Z, up is +Y, the gun's right side is +X, and the origin is the middle of the
  grip, where the right mitten holds it.
- A child node called `muzzle` sits at the tip of the nozzle: the spray starts there.
- A child node called `foregrip` sits at the middle of the pump under the barrel, where the left mitten rests.
- About 0.65 to 0.69 m long, 0.36 m tall and 0.15 m wide; under 6,000 triangles; no team tint, skeleton or animation.

To change a gun, edit `gun_cocoa()` or `gun_water()` in `guns.py`. The grip, muzzle and foregrip positions are the
first lines of each. `guns.py` packs its own texture atlas (`pack_even`) so the texels stay square.

### Candy Cane Blade

    python tools/blender/guns.py blade           # → src/assets/models/guns/blade.glb   (about 40 seconds)
    python tools/blender/guns.py blade --shapes  # quick Cycles renders, no bake or export

`blade` is the melee weapon: one fat candy cane. The straight of the cane is sharpened into the blade (round back,
ground bevel, a crust of sugar along the edge, the point licked pink), the middle is wrapped in green wool as the grip,
and the crook turns back under the mitten as a knuckle guard. A peppermint sits where blade meets grip, with a sprig of
holly on the blade's back. It is built by `gun_blade()` in `guns.py`, the same way as the guns: one mesh, one material
(`Gun_blade`), 1024 px baked textures, about 3,700 triangles.

What the game relies on:

- In the GLB the blade points along -Z, up is +Y (the blade's back, where the holly is), and the origin is the middle
  of the grip. The crook hangs on the -Y side, so it faces forward when the blade is carried point up.
- A child node called `tip` sits at the very point, and one called `mid` halfway along the cutting part.
- 0.975 m long (0.149 m of it behind the origin: the crook), 0.21 m tall and 0.10 m wide. The grip is 0.067 m thick
  like the guns' grips, and the crook leaves 0.09 m clear between the grip's centre line and its inside.

The sizes are the first lines of `gun_blade()`. The stripes follow the blade's own texture rectangle, so they keep
winding evenly if the shape changes.

## Looking at the result

`npm run dev`, then open `/tools/viewer/`. It shows the real in-game model under the game's lighting.
`node tools/viewer/shots.mjs <folder> [turn poses teams hats hatclose guns blade]` saves screenshots (needs Playwright).

## Map props

The houses, ruins, candy canes, cargo sled and ice blocks on the maps are built by `props.py`, `houses.py`, `kit.py` and `textures.py` in this folder, into `public/models/` and `public/textures/`. They are described under "Props (Blender)" in the README at the top of the repository.
