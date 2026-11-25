# Polar Penguin Fight

A penguin snowball-fight arena that runs in the browser. Built live on stream by Future Flynn, all week, for game night on Saturday.

Push and pile real 3D snow, pat it into forts, dig tunnels, pack snowballs (carry 5, stash the rest in your team's stockpile), belly slide down hills, shove big snowballs downhill to flatten forts, and grab shiny snowflakes in no-man's-land to upgrade your mittens. One minute build phase, then team splat-match: 3 hits sends you back to base, first team to 25 splats wins. 5v5 or 10v10, bots fill the empty slots.

## Game modes

- **Team Deathmatch** on Frostbite Bay: first team to 25 splats. Splat streaks of 3, 5 and 7 earn a Snowball Frenzy, an Insta-Turret and an Avalanche. Each team comes back along a spawn line that runs the whole length of its side of the map (not at the igloo), and has three stockpiles on that line: one by the igloo and one at a camp at each end. The far north (the Drifts) and the far south (the Inlet, a strip of sea ice) are ways round the middle.
- **Conquest** on Glacier Gap: three flags (A, B, C). Stand in a flag's ring to take it, held flags earn points, first team to 250 wins. You respawn at a flag your team holds, so build forts and snowman turrets around them. No splat streaks here.
- **Breakthrough** on Peppermint Pass: Team Blizzard attacks, Team Sunrise defends, and the map is three sections taken one after another. The Flats is open ground with a few trees, stacks of sawn ice and a couple of snow mounds (objectives A and B). Crumble Town is a broken-down gingerbread village round a frozen lake with icebergs and giant candy canes (A and B again). The Summit is a steep, snowy hill with a walled village of log cabins and gingerbread houses on top, and cargo sleds for cover on the way up (one objective). The attackers take a section by holding all of its objectives at once; then the defenders fall back, their old turrets crumble, and the attackers get tickets back. Defenders who are splatted come back on a line well behind their objectives (and wait a little longer than attackers), so going down as a defender leaves the objective short-handed. Every attacker who goes down costs a ticket. At zero the attackers stop coming back and have one last minute; if they are all down, or the clock runs out, the defenders win. Pick Attack or Defend on the menu. No splat streaks here.

Snowman turrets work in every mode: hold T to scoop a lot of snow into one. It throws at any enemy it can see, runs out of snowballs unless you hand it more (hold E beside it), and four hits knock it down.

Every map has jump ramps on its hills (icy decks with gold arrows and candy-cane rails): belly slide into one at speed and you fly. Every map also has a surfboard that pops up shortly after the fight starts: grab it to ride faster than a slide until you are splatted. In Breakthrough the board appears in the section being fought over.

## Play locally

```
npm install
npm run dev
```

Then open the link Vite prints (usually http://localhost:5173).

## Controls

| Key | Action |
| --- | --- |
| WASD + mouse | Move and look |
| Left click | Throw (hold to throw farther) |
| Right click (hold) | Push snow with your mittens |
| F (hold) | Pack a snowball (max 5) |
| R (hold) | Build snow where you aim |
| Q (hold) | Dig snow where you aim (tunnels!) |
| G (hold) | Pack a giant snowball to roll |
| T (hold) | Build a snowman turret (takes a lot of snow) |
| 1 / 2 / 3 | Use a splat-streak reward (Team Deathmatch) |
| E | Grab snowballs from a stockpile (works on the enemy's too) |
| Hold E | Stash your snowballs in your stockpile, or load a turret beside you |
| Shift | Belly slide. A / D steer left and right as you see it on screen, W bends the slide toward where you look, S brakes. Hit a jump ramp at speed to fly |
| Space | Hop |
| Tab | Scoreboard |

## Build for the web

```
npm run build
```

The static site lands in `dist/` and works from any sub-path (GitHub Pages, an iframe on the site, or the game server).

Every push to `main` builds the game and publishes `dist/` to the `gh-pages` branch, which GitHub Pages serves at https://financeflynn5-wq.github.io/polar-penguin-fight/

## Online play

`npm run build` also bundles the game server into `server-dist/main.mjs`. One Node process serves the game page and runs the online matches on `/ws`, the same way Flynn's other server games work.

```
npm run build
npm start                 # http://localhost:8080, open it in a few tabs to play each other
```

- **Matches:** pick Team Deathmatch or Conquest and 5v5 or 10v10 on the menu and press **Play online**. You take a bot's place on the team with fewer people; when you leave, a bot takes your penguin back. When every slot in a match is a person, the next person starts a new match of that mode and size. After the results screen the next match starts by itself and everyone stays in.
- **Practice with bots** is the offline game, and it's all the GitHub Pages copy offers until it knows where the server is.
- **Settings** (environment): `PORT` (8080), `MAX_PLAYERS` across all matches (40), `MAX_CONN_PER_IP` (6). Each player downloads about 30 KB/s.
- `GET /status` is the menu's head count, `GET /healthz` is for hosts and the Flynn Arcade hub (`server/arcade.js` and `server/names.js` are the same files Time of War, Flynn Fall and Scrapforge use: kick/ban hooks and the stream-safe name filter).

### Putting it on a server

With Docker (Flynn's Hetzner box, or anything that runs containers):

```
docker build -t polar-penguin-fight .
docker run -d --restart unless-stopped -p 8080:8080 --name penguin polar-penguin-fight
```

Then point a subdomain at port 8080 with whatever already fronts the other games (for example `penguin.5-222-13-73.sslip.io`). The reverse proxy must pass WebSocket upgrades on `/ws` (Caddy does by default).

Without Docker: `npm ci && npm run build && PORT=8080 node server-dist/main.mjs` on Node 22.

To make the GitHub Pages copy offer online play too, set the repository variable `GAME_SERVER_URL` (Settings → Secrets and variables → Actions → Variables) to the server's address, such as `https://penguin.5-222-13-73.sslip.io`, and push. Any copy of the game also takes `?server=https://…` in its address.

For the Flynn Arcade hub, add `{ "id": "penguin", "name": "Polar Penguin Fight", "dir": "<this folder>", "subdomain": "penguin", "port": 5188, "build": false, "start": "server-dist/main.mjs" }` to `hub/config.json` and run `npm run build` here after pulling.

### How online works

- The server runs the real match with the same code as the offline game (`src/sim`), 60 steps a second, and sends a binary snapshot 30 times a second: every penguin, snowball, big ball, snowflake and the surfboard, the snow voxels that changed, and the events (hits, splats, throws). See `src/net/Protocol.ts`.
- Your own penguin moves the moment you press a key: the browser runs the same movement code ahead of the server and quietly corrects itself when the server disagrees (`src/net/NetClient.ts`). Everyone else is shown 0.1 s in the past, blended between snapshots.
- The server does all the digging, building, packing, throwing, hits and pickups.
- Tests: `npm run test:net` plays a match with three fake players in-process and checks that each one's copy of the snow matches the server's exactly. `npm run test:online` starts the real server and connects two headless players over a laggy connection (`LAG=120 JITTER=60 npm run test:online` for a bad one) and reports how far prediction drifts. Put `MODE=conquest` or `MODE=breakthrough` in front of either to test those modes on their own maps.

## How it's put together

- `src/world/SnowField.ts`: the snow is a 3D density grid (0.5 m voxels). Push, dig, build, pack and the big-ball smashing are all edits to this grid.
- `src/render/SnowMesher.ts`: Surface Nets turns the grid into smooth snow meshes, re-meshed in 16³ chunks as the snow changes.
- `src/sim/`: the game rules, penguins, snowballs, big balls, snowflakes and bots. No Three.js here, so the same code runs on the multiplayer server.
- `src/net/`, `server/`: online play (see above).
- `src/render/`, `src/ui/`, `src/game/`: visuals, particles, HUD, menus, procedural sound.
- `src/world/Maps.ts`: the maps by id (`MapDef.ts` is Frostbite Bay, `ConquestMap.ts` is Glacier Gap, `BreakthroughMap.ts` is Peppermint Pass). `Landmarks.ts` is what you bump into: ice, houses, ruins, candy canes, sleds, ice blocks, and the jump ramps (their curve, the launch and the snow shaped around them).
- `public/models/*.glb`, `public/textures/*.webp`: the houses and props, modelled in Blender. See "Props" below.
- `src/sim/config.ts`: every gameplay number in one place for tuning.

## Props (Blender)

The gingerbread house, its two ruins, the log cabin, the candy canes, the cargo sled, the ice blocks and the jump ramp (`ramp.py`) are built by Python scripts that drive Blender, in `tools/blender/`:

- `textures.py` makes the tiling texture sets in `public/textures/` (colour, normal and occlusion/roughness for gingerbread, icing, candy, wood, logs, snow, ice, canvas, stone). Needs numpy and Pillow.
- `props.py` and `houses.py` build the models and write them to `public/models/` as `.glb`; `kit.py` is the shared toolbox. Run them with Blender's Python (`pip install bpy` in a virtualenv is enough): `python tools/blender/props.py` builds everything, `python tools/blender/props.py sled cabin` only those, and `--render` also writes review renders to `tools/blender/renders/`.

The models carry shape, UVs, a material name per mesh and vertex colours (a tint times ambient occlusion that is ray-cast in Blender). The game builds the actual materials from the shared textures in `src/render/PropMaterials.ts` and draws every copy of a prop in one instanced call (`src/render/Landmarks.ts`). The sizes you collide with live in `src/world/Landmarks.ts` (`PROP_SHAPES` and the house makers); the models are built to those numbers, so change them together.
