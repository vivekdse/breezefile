#!/usr/bin/env node
// `npm run dev:main` — task-9256aea43313 fallback.
//
// WHY THIS EXISTS: `npm run dev`'s watcher (vite-plugin-electron 1.1.0's
// `build.watch` path) can silently stop rebuilding electron/main.ts or
// electron/preload.ts after the first successful build. The concrete failure
// observed on this box is upstream, inside Vite's own bundled rollup +
// @rollup/plugin-commonjs: on an incremental (watch-mode) rebuild — but never
// the initial build — the commonjs plugin throws
//   [commonjs] Cannot read properties of undefined (reading 'resolved')
// which aborts that rebuild with NO error surfaced to the terminal beyond that
// one line, and NO new dist-electron/main-<hash>.js is written. Electron can
// still look like it picked up the change (it restarts, new pid) while it is
// actually still running the stale bundle — see main.ts's `[bundle] main
// process running from ...` log for the ground truth.
//
// This script does NOT try to fix that watcher. It deterministically rebuilds
// main + preload with a one-shot (non-watch) build using the SAME options
// vite.config.ts feeds the dev server's electron() plugin (shared via
// electron/vite-electron-options.mjs, so the two never drift), then restarts
// the Electron child pointed at the renderer dev server that is still running
// and unaffected (this bug is scoped to the main/preload watch — the renderer
// HMR path is a completely different Vite pipeline and keeps working fine).
//
// Usage:  npm run dev:main            (keep `npm run dev` running in another
//                                       pane/session; run this after an
//                                       electron/ edit whenever the pane goes
//                                       quiet — no "built in Nms" message, or
//                                       the [bundle] hash doesn't change)
//
// Safe to run alongside `npm run dev` — unlike `npm run build` / `vite build`
// at the project root (which rebuilds the RENDERER too and clobbers
// dist-electron/main.js with a production-hash build, desyncing it from the
// dev server — see this repo's CLAUDE.md), this script only touches the
// electron main/preload outputs via vite-plugin-electron's own `build()`
// helper, which is exactly what the watcher would have done had it not
// crashed.

import { execSync } from 'node:child_process';
import { mergeConfig } from 'vite';
import { build, startup, checkESModule, compatRollupOptions } from 'vite-plugin-electron';
import { mainOptions, preloadOptions } from '../electron/vite-electron-options.mjs';

// Reimplements vite-plugin-electron/simple's electronSimple() preload
// handling (see its simple.mjs) rather than importing it — it isn't
// exported, and its `input` is a `/simple`-only top-level shortcut that the
// plain `build()` API used below does NOT understand (only electronSimple()
// destructures `options.preload.input` and threads it through). Calling
// `build(preloadOptions)` naively drops `input` silently, and rollup's
// resolveInput() then falls back to scanning index.html, pulling in the
// ENTIRE renderer — confirmed while building this fix: 10000+ modules
// transformed for what should be a 2-file preload build. Nesting `input`
// under `vite.build.rollupOptions.input` up front (as this does) is the fix.
function preloadBuildOptions(esmodule) {
  const { input, vite: viteConfig = {}, ...rest } = preloadOptions;
  const defaultConfig = {
    build: compatRollupOptions({
      rolldownOptions: {
        input,
        platform: 'node',
        output: { format: esmodule ? 'es' : 'cjs' },
      },
    }),
  };
  return { ...rest, vite: mergeConfig(defaultConfig, viteConfig) };
}

function findViteDevServerUrl() {
  // Locate the running `npm run dev`'s vite process for THIS checkout (not
  // some other project's dev server on the same box) and read the port it's
  // actually listening on — vite doesn't pin a port, so we can't hardcode one.
  const cwd = process.cwd();
  let pids;
  try {
    pids = execSync(`pgrep -f "node_modules/\\.bin/vite$"`, { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    pids = [];
  }
  for (const pid of pids) {
    try {
      const procCwd = execSync(`readlink -f /proc/${pid}/cwd`, { encoding: 'utf8' }).trim();
      if (procCwd !== cwd) continue;
      const ss = execSync(`ss -ltnp 2>/dev/null | grep "pid=${pid},"`, { encoding: 'utf8' });
      const match = ss.match(/:(\d+)\s/);
      if (match) return `http://localhost:${match[1]}`;
    } catch {
      // keep trying other pids
    }
  }
  return null;
}

async function main() {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || findViteDevServerUrl();
  if (!devServerUrl) {
    console.error(
      '[dev:main] Could not find a running `npm run dev` vite server for this checkout.\n' +
        '           Start it first (in the `breeze` tmux session), or set\n' +
        '           VITE_DEV_SERVER_URL=http://localhost:<port> explicitly.',
    );
    process.exit(1);
  }
  console.log(`[dev:main] Using renderer dev server: ${devServerUrl}`);
  process.env.VITE_DEV_SERVER_URL = devServerUrl;

  console.log('[dev:main] Rebuilding preload...');
  const esmodule = checkESModule();
  const resolvedPreloadOptions = preloadBuildOptions(esmodule);
  await build({
    ...resolvedPreloadOptions,
    vite: { ...resolvedPreloadOptions.vite, mode: 'development' },
  });

  console.log('[dev:main] Rebuilding main...');
  await build({ ...mainOptions, vite: { ...mainOptions.vite, mode: 'development' } });

  console.log('[dev:main] Restarting Electron...');
  // Kill whatever Electron instance for this checkout is still running before
  // relaunching, mirroring package.json's `predev` pkill so we don't end up
  // with two app windows.
  try {
    execSync(`pkill -f "${process.cwd()}/node_modules/electron/dist/electron"`, { stdio: 'ignore' });
  } catch {
    // no previous instance running — fine
  }
  const started = await startup(['.', '--no-sandbox'], { cwd: process.cwd() });
  if (!started) {
    console.error('[dev:main] Electron startup was prevented (ELECTRON_STARTUP_PREVENT set?).');
    process.exit(1);
  }
  console.log('[dev:main] Done — watch the terminal for `[bundle] main process running from ...`');
}

main().catch((err) => {
  console.error('[dev:main] Failed:', err);
  process.exit(1);
});
