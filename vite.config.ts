import { defineConfig } from 'vite';

// base './' so the build works from any sub-path (GitHub Pages, an iframe on Flynn's site, or the game server).
// In dev, /ws and /status go to a local game server (npm run server, port 8080) so online play works too.
const GAME_SERVER = process.env.GAME_SERVER || 'http://localhost:8080';
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    proxy: {
      '/ws': { target: GAME_SERVER, ws: true },
      '/status': { target: GAME_SERVER },
    },
  },
});
