import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import pkg from './package.json';
// Shared with scripts/dev-main-rebuild.mjs (the `npm run dev:main` fallback,
// task-9256aea43313) so both consumers build main/preload from one config.
import { mainOptions, preloadOptions } from './electron/vite-electron-options.mjs';

export default defineConfig({
  define: {
    // Inject the package.json version at build time so the renderer can
    // compare against the latest GitHub release without bundling the
    // whole package.json.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    electron({
      // `codeSplitting` (inside preloadOptions.vite.build.rollupOptions.output)
      // isn't part of Rollup's typed `OutputOptions` — it's a
      // vite-plugin-electron-only convention read via duck-typing — hence the
      // cast at the shared options' definition site
      // (electron/vite-electron-options.mjs) rather than here.
      main: mainOptions,
      preload: preloadOptions,
      renderer: {},
    }),
  ],
  build: {
    outDir: 'dist',
  },
});
