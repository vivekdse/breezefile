// Browser-automation RUNTIME installer.
//
// Installs the helper CLIs the agent runs (`node <cli> ...`) into a STABLE,
// user-owned location — ~/.breezefile/automation — on every launch, creating it
// if missing (the same "drop files in a dotfolder on launch" pattern as the
// seed tools and the Claude hook script).
//
// WHY not run them from the repo / Electron resources:
//   - In dev, automation.ts's path consts evaluate at IMPORT time, before
//     main.ts sets process.env.APP_ROOT, so a repo-relative path resolved to a
//     nonexistent node_modules/electron/dist/resources/automation and every
//     helper failed with MODULE_NOT_FOUND.
//   - The packaged build did not ship the tree under Resources either.
// Pointing at ~/.breezefile/automation makes the helper paths os.homedir()-based
// — correct regardless of APP_ROOT timing and identical in dev + packaged — and
// lets the user inspect/edit the installed helpers.
//
// The small helper .mjs are re-copied every launch (cheap; picks up dev edits).
// playwright-core (~13M, the only heavy dep — imported lazily by connect.mjs) is
// copied ONCE; delete ~/.breezefile/automation/node_modules/playwright-core to
// force a refresh, the same "you own it once it lands" rule as the seed tools.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
} from 'node:fs';

/** Stable runtime dir the helpers install into. Honors $BREEZE_AUTOMATION_DIR
 *  (kept in sync with electron/browser/automation.ts). */
export function automationDir() {
  return (
    process.env.BREEZE_AUTOMATION_DIR ||
    path.join(os.homedir(), '.breezefile', 'automation')
  );
}

/** Where to COPY FROM. dev: APP_ROOT (the repo root). packaged: the automation
 *  tree shipped under Resources. (APP_ROOT points inside app.asar when packaged,
 *  so we skip it then and use resourcesPath.) */
function sourceRoot() {
  const appRoot = process.env.APP_ROOT;
  if (appRoot && !/[\\/]app\.asar([\\/]|$)/.test(appRoot)) return appRoot;
  if (process.resourcesPath) {
    return path.join(process.resourcesPath, 'automation');
  }
  return appRoot || process.cwd();
}

// Small helper files (relative to the source/dest root) — re-copied each launch.
const HELPERS = [
  ['bin', 'breeze-tools.mjs'],
  ['electron', 'browser', 'cli.mjs'],
  ['electron', 'browser', 'connect.mjs'],
  ['electron', 'browser', 'scrub.mjs'],
  ['electron', 'browser', 'tools', 'registry.mjs'],
];

// Heavy deps — copied once (skipped when the destination already exists).
const DEPS = [['node_modules', 'playwright-core']];

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const s = path.join(from, name);
    const d = path.join(to, name);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

function copyFileInto(from, to) {
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}

/** Install/refresh the automation runtime into ~/.breezefile/automation.
 *  Best-effort: per-item errors are collected, never thrown, so one missing
 *  piece can't block the others or app startup. Returns
 *  { dir, installed: string[], errors: string[] }. */
export function installAutomation() {
  const src = sourceRoot();
  const dest = automationDir();
  const installed = [];
  const errors = [];

  for (const parts of HELPERS) {
    const from = path.join(src, ...parts);
    const to = path.join(dest, ...parts);
    if (!existsSync(from)) {
      errors.push(`missing source: ${parts.join('/')}`);
      continue;
    }
    try {
      copyFileInto(from, to);
      installed.push(parts.join('/'));
    } catch (e) {
      errors.push(`${parts.join('/')}: ${e.message}`);
    }
  }

  for (const parts of DEPS) {
    const from = path.join(src, ...parts);
    const to = path.join(dest, ...parts);
    if (existsSync(to)) continue; // own-it-once; delete the dir to refresh
    if (!existsSync(from)) {
      errors.push(`missing source: ${parts.join('/')}`);
      continue;
    }
    try {
      copyDir(from, to);
      installed.push(parts.join('/'));
    } catch (e) {
      errors.push(`${parts.join('/')}: ${e.message}`);
    }
  }

  return { dir: dest, installed, errors };
}

// Allow `node install-runtime.mjs` to run it directly (dev/testing).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(JSON.stringify(installAutomation(), null, 2) + '\n');
}
