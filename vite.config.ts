import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import pkg from './package.json';

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
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            rollupOptions: {
              // Native modules — their .node binaries must be resolved
              // at runtime from node_modules, not bundled into the ESM
              // main bundle (bundling drags in __filename/require which
              // aren't defined in ESM and crash on first call).
              external: [
                '@homebridge/node-pty-prebuilt-multiarch',
                'better-sqlite3',
                'electron',
              ],
            },
          },
        },
      },
      preload: {
        input: 'electron/preload.ts',
      },
      renderer: {},
    }),
  ],
  build: {
    outDir: 'dist',
  },
});
