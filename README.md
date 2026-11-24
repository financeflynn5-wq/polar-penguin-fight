# Polar Penguin Fight

A penguin snowball-fight arena that runs in the browser. Built live on stream by Future Flynn, all week, for game night on Saturday.

Push and pile real 3D snow, pat it into forts, dig tunnels, pack snowballs (carry 5, stash the rest in your team's stockpile), belly slide down hills, shove big snowballs downhill to flatten forts, and grab shiny snowflakes in no-man's-land to upgrade your mittens. 30 second build phase, then team splat-match: 3 hits sends you back to base, first team to 25 splats wins. 5v5 or 10v10, bots fill the empty slots.

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
| E | Grab snowballs from a stockpile (works on the enemy's too) |
| Hold E | Stash your snowballs in your stockpile |
| Shift | Belly slide |
| Space | Hop |
| Tab | Scoreboard |

## Build for the web

```
npm run build
```

The static site lands in `dist/` and works from any sub-path (GitHub Pages, an iframe on the site, or the game server).

Every push to `main` builds the game and publishes `dist/` to the `gh-pages` branch, which GitHub Pages serves at https://financeflynn5-wq.github.io/polar-penguin-fight/

## How it's put together

- `src/world/SnowField.ts`: the snow is a 3D density grid (0.5 m voxels). Push, dig, build, pack and the big-ball smashing are all edits to this grid.
- `src/render/SnowMesher.ts`: Surface Nets turns the grid into smooth snow meshes, re-meshed in 16³ chunks as the snow changes.
- `src/sim/`: the game rules, penguins, snowballs, big balls, snowflakes and bots. No Three.js here, so the same code can run on the multiplayer server.
- `src/render/`, `src/ui/`, `src/game/`: visuals, particles, HUD, menus, procedural sound.
- `src/sim/config.ts`: every gameplay number in one place for tuning.
