// Profile isolation — run a stable (packaged) instance and an experimental
// (`npm run dev`) instance side-by-side on one machine without sharing state.
//
// A "profile" names an isolated slice of on-disk state (~/.breezefile[-<name>])
// and a CDP port. The packaged app runs as profile 'default' (the stable
// instance the user relies on); `npm run dev` runs as profile 'dev' (an
// experimental instance that must NOT touch the stable instance's auth token,
// encrypted DB, or settings). BREEZE_PROFILE selects an arbitrary extra profile.
//
// Pure Node, NO electron imports: this module is consumed by standalone CLI
// .mjs files (electron/browser/*) that run OUTSIDE Electron, inheriting
// BREEZE_PROFILE from the parent process env.

import os from 'node:os';
import path from 'node:path';

// Default the profile HERE, as a module side-effect, not in main.ts: ESM
// imports are hoisted, so module-level consts (e.g. api-server.ts's
// API_FILE_DIR) call stateDir() before main.ts's body runs. Every consumer
// imports this module, so this assignment precedes any stateDir()/cdpPort()
// call. `process.defaultApp` exists only in the Electron main process and is
// true exactly when running unpackaged (`electron .`, i.e. `npm run dev`);
// packaged apps and standalone node CLIs keep the env-provided value (or
// 'default'). Written back to the env so child processes (agent CLIs, hooks)
// inherit the same profile.
if (
  !process.env.BREEZE_PROFILE &&
  process.versions.electron &&
  /** @type {NodeJS.Process & {defaultApp?: boolean}} */ (process).defaultApp
) {
  process.env.BREEZE_PROFILE = 'dev';
}

/** Active profile name. Sanitized to [a-z0-9-]; empties fall back to 'default'. */
export function profileName() {
  const raw = process.env.BREEZE_PROFILE || 'default';
  const name = raw.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return name || 'default';
}

/** State dir for the active profile: ~/.breezefile for 'default', else
 *  ~/.breezefile-<name>. Everything Breeze persists locally hangs off here. */
export function stateDir() {
  const name = profileName();
  return name === 'default'
    ? path.join(os.homedir(), '.breezefile')
    : path.join(os.homedir(), '.breezefile-' + name);
}

/** CDP port the instance exposes (electron/main.ts --remote-debugging-port).
 *  Fixed for the two common profiles so tooling is predictable; other profiles
 *  get a deterministic port in 9224–9299 derived from the name. */
export function cdpPort() {
  if (process.env.BREEZE_CDP_PORT) return Number(process.env.BREEZE_CDP_PORT);
  const name = profileName();
  if (name === 'default') return 9222;
  if (name === 'dev') return 9223;
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return 9224 + (hash % 76); // 9224–9299
}

/** CDP endpoint URL. Override with $BREEZE_CDP_URL. */
export function cdpUrl() {
  return process.env.BREEZE_CDP_URL || 'http://localhost:' + cdpPort();
}
