// Shared `vite-plugin-electron/simple` main/preload options, factored out of
// vite.config.ts so `scripts/dev-main-rebuild.mjs` (the `npm run dev:main`
// fallback — see task-9256aea43313) can rebuild the exact same main/preload
// bundles standalone, without duplicating (and risking drift from) the
// config vite.config.ts feeds the dev server's `electron()` plugin.
export const mainOptions = {
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
          'better-sqlite3-multiple-ciphers',
          'electron',
          // Playwright must load from node_modules at runtime, not be
          // bundled into the main ESM bundle: its coreBundle.js pulls in
          // an unresolved 'chromium-bidi' require that Rollup externalizes
          // and which then crashes the main process on load (ERR_MODULE_
          // NOT_FOUND). The browser helper already runs playwright from
          // node_modules, so keep main consistent.
          'playwright-core',
          'chromium-bidi',
        ],
      },
    },
  },
};

export const preloadOptions = {
  // Two preloads: the main-window bridge, and the page-side
  // teach-by-recording capture script injected into embedded browser
  // views (electron/browser/record-preload.mjs). Both land in
  // dist-electron/ as <name>.mjs. Multiple preload inputs require
  // disabling Rollup's default inlineDynamicImports (single-entry only).
  input: {
    preload: 'electron/preload.ts',
    'record-preload': 'electron/browser/record-preload.mjs',
  },
  vite: {
    build: {
      rollupOptions: {
        output: {
          // vite-plugin-electron >=1.x re-derives `inlineDynamicImports`
          // from `codeSplitting` on every internal config merge pass
          // (see setBuildOptions in its utils chunk); setting
          // `inlineDynamicImports` directly gets clobbered back to
          // `true` by that re-derivation. `codeSplitting: true` is the
          // key the library treats as the source of truth, so use it
          // instead to keep the two preload entries in separate chunks.
          // Not part of Rollup's typed `OutputOptions` — it's a
          // vite-plugin-electron-only convention read via duck-typing —
          // hence the cast.
          codeSplitting: true,
          entryFileNames: '[name].mjs',
        },
      },
    },
  },
};
