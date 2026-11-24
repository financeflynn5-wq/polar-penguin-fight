import { defineConfig } from 'vite';

// base './' so the build works from any sub-path (GitHub Pages, an iframe on Flynn's site, or the game server).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
