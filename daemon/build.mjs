// breezed bundle builder (fm-typebuild-repoint).
//
// Bundles daemon/breezed.ts → daemon/dist/breezed.mjs for Node (server).
//
// The daemon constructs a TypeBuildTaskSource for its poll-claim-execute loop,
// but it ONLY uses claimNext + the REST verbs (list/get/claim/release/
// complete). It never calls the source's GUI-only interactive methods
// (runNow / relaunchSession), which reach the PTY + Electron layer via DYNAMIC
// imports of `../ipc` and `../agents/interactive` (→ electron, node-pty).
//
// We mark those GUI-only relative modules (plus `electron` itself and the
// native node-pty binary) EXTERNAL so esbuild does not pull the Electron/PTY
// graph into the headless bundle. Because they're reached only via DYNAMIC
// import() inside methods the daemon never calls, the externalized specifiers
// are never resolved at runtime headlessly — so leaving them external is safe
// (and keeps the daemon's import graph Electron-free, which is the gate).
//
// better-sqlite3 stays external (its .node binary is installed on the server).

import { build } from 'esbuild';

// Relative specifiers (as written in source) for the GUI-only dynamic imports.
// Matching is on the import path as written, so we anchor on the exact strings
// used in electron/sources/typebuild.ts:
//   await import('../ipc')
//   await import('../agents/interactive')
const GUI_ONLY_DYNAMIC = new Set(['../ipc', '../agents/interactive']);

/** esbuild plugin: mark the GUI-only dynamic relative imports external so the
 *  bundler doesn't follow them into the Electron/PTY graph. */
const externalizeGuiOnly = {
  name: 'externalize-gui-only',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (GUI_ONLY_DYNAMIC.has(args.path) && args.kind === 'dynamic-import') {
        return { path: args.path, external: true };
      }
      return null;
    });
  },
};

await build({
  entryPoints: ['daemon/breezed.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'daemon/dist/breezed.mjs',
  // Native + Electron deps resolved at runtime (or never, for the GUI-only
  // ones) — never bundled.
  external: [
    'better-sqlite3',
    '@homebridge/node-pty-prebuilt-multiarch',
    'electron',
  ],
  plugins: [externalizeGuiOnly],
  banner: {
    js: "import{createRequire}from'module';const require=createRequire(import.meta.url);",
  },
});

console.log('[build:daemon] bundled daemon/dist/breezed.mjs');
