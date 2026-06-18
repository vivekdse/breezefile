// Seed-tool installer.
//
// Ships the built-in reference tools (electron/browser/tools/seed/*) into the
// user's tool repository at ~/.breezefile/tools/ on app launch — the same
// "drop files in a dotfolder on every launch" pattern as the Claude hook
// script (electron/hooks-register.ts).
//
// NEVER clobbers a tool the user has touched: a seed is copied only when its
// destination directory does not already exist. So once a tool lands, the user
// (or the agent) owns it; we won't overwrite their edits on the next launch.
// To force a refresh of the bundled seeds, delete the tool's folder.

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Destination repo. Honors $BREEZE_TOOLS_DIR (kept in sync with registry.mjs). */
export function toolsDir() {
  return process.env.BREEZE_TOOLS_DIR || path.join(os.homedir(), '.breezefile', 'tools');
}

/** Locate the bundled seed directory across dev + packaged layouts.
 *  - dev / tsc build: this file sits at electron/browser/tools/install.mjs and
 *    the seeds are the sibling ./seed.
 *  - packaged: electron-builder ships the automation tree under
 *    Resources/automation preserving structure, so the seeds live at
 *    Resources/automation/electron/browser/tools/seed — which is ALSO the
 *    sibling ./seed when this file runs from there. The resourcesPath fallback
 *    below covers the case where install.mjs is loaded from inside the asar
 *    (main.ts's dynamic import) rather than from Resources/automation. */
export function seedDir() {
  const sibling = path.join(__dirname, 'seed');
  if (existsSync(sibling)) return sibling;
  if (process.resourcesPath) {
    const packaged = path.join(
      process.resourcesPath, 'automation', 'electron', 'browser', 'tools', 'seed',
    );
    if (existsSync(packaged)) return packaged;
  }
  return sibling; // best guess; installSeedTools tolerates a missing dir
}

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    const st = statSync(src);
    if (st.isDirectory()) copyDir(src, dst);
    else copyFileSync(src, dst);
  }
}

/** Copy every seed tool that isn't already present into the repo.
 *  Returns the list of tool-ids newly installed. Best-effort: per-tool errors
 *  are collected, never thrown, so one bad seed can't block the others or
 *  app startup. */
export function installSeedTools() {
  const src = seedDir();
  const dest = toolsDir();
  const installed = [];
  const errors = [];
  if (!existsSync(src)) return { installed, errors: [`seed dir not found: ${src}`] };
  mkdirSync(dest, { recursive: true });
  for (const id of readdirSync(src)) {
    const srcTool = path.join(src, id);
    let st;
    try { st = statSync(srcTool); } catch { continue; }
    if (!st.isDirectory()) continue;
    // Only seed tools that actually have a tool.json (skip stray files).
    if (!existsSync(path.join(srcTool, 'tool.json'))) continue;
    const destTool = path.join(dest, id);
    if (existsSync(destTool)) continue; // user owns it now — don't touch
    try {
      copyDir(srcTool, destTool);
      installed.push(id);
    } catch (e) {
      errors.push(`${id}: ${e.message}`);
    }
  }
  return { installed, errors };
}

// Allow `node install.mjs` to run it directly (useful for dev/testing).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = installSeedTools();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}
