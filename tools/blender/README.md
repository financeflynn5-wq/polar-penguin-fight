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

## The polar bear and the yeti

Two more playable characters, built the same way as the penguin:

    python tools/blender/polarbear.py               # → src/assets/models/polarbear.glb + polarbear.json  (about 4 minutes)
    python tools/blender/yeti.py                    # → src/assets/models/yeti.glb + yeti.json            (about 4½ minutes)

    polarbear.py --size=1024                        quicker draft (the real one is 2048)
    polarbear.py --shapes                           one-minute preview: the sculpt with its un-baked colours, lids open
    polarbear.py --shapes --views=face,back --res=700   pick the views (front back side face faceside top low feet q)
    polarbear.py --shapes --grey                    the same in plain grey
    polarbear.py --count                            triangles per part

- `lib/creature.py` holds what the two share: eyes and lids, the soft fur look, sculpted fur tufts, the puffer vest,
  the scarf, mittens, and the build pipeline (weights → atlas → bake → far-away copy → GLB → JSON).
- Both use the penguin's skeleton (same joint names and parents, every bone upright), so the game animates them with
  the same code. The numbers that differ per character are written to the `.json` next to the `.glb`, in game space
  (metres, y up, facing -z): `armRest`, `eyeYaw`, `lidOpen`, `height`, `hatScale`, where snow splats land
  (`chestFront`, `cheek`, `belly`), the belt (`belt`), how far down the arm the hand ends (`handTip`), and the
  triangle counts.
- Materials: `Bear` / `Yeti` (fur, skin, everything that keeps its colour), `Eye`, and the same tinted
  `TeamJacket`, `TeamScarf` and `Mitten` as the penguin. The far-away copy is the object named `…LOD`.
- The top of each skull is the penguin's head dome scaled by `hatScale`, and the `hat` joint sits in the matching
  place, so every hat fits when the game scales it by `hatScale`.

`python tools/blender/review.py polarbear` (or `yeti`) loads the exported GLB the way the game does and renders
pose tests into `tools/blender/out/review_<name>_<sheet>.png`: both team colours at rest (`rest`), arms overhead
(`up`), the charge lean (`lean`), bent elbows with the jaw open and a foot lifted (`bend`), a walk stride (`walk`)
and hats (`hats`). `review.py yeti up hats top --res=700` renders only those sheets; `top` is the view from above
and behind, `leanraw` the bear's charge without lifting the body.

## Hats

Each hat is modelled around the penguin's head and saved with its origin at the head's `hat` joint. Parts named
`spin…` turn (the propeller) and parts named `jiggle…` wobble on a spring (pom-poms, the fish's tail).
To add a hat: write a `hat_<name>()` function in `hats.py`, add it to `HATS`, and add the name to `HATS` in
`src/sim/World.ts`.

## Looking at the result

`npm run dev`, then open `/tools/viewer/`. It shows the real in-game model under the game's lighting.
`node tools/viewer/shots.mjs <folder> [turn poses teams hats hatclose]` saves screenshots (needs Playwright).

## Map props

The houses, ruins, candy canes, cargo sled and ice blocks on the maps are built by `props.py`, `houses.py`, `kit.py` and `textures.py` in this folder, into `public/models/` and `public/textures/`. They are described under "Props (Blender)" in the README at the top of the repository.
