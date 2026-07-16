// task-6589ec3934a4 — unit tests for the fixed poll-window guard.
//
// Same transpile-on-the-fly approach as tests/typebuild-http.test.mjs: this
// repo's `node --test` runner has no TS loader, so we transpile the real
// electron/core/host.ts (the breezeHost() seam) with esbuild rather than
// reimplementing it in a separately-tested copy. host.ts has zero imports
// (deliberately Electron-free), so it transpiles and runs standalone.
//
// WHAT WE'RE PINNING:
//   1. breezeHost()/setBreezeHost() wiring: the injected host is what callers
//      see; the default (no host registered) is a safe no-op.
//   2. hasInteractiveWindow's contract: the default/noop host answers `false`,
//      but a host that simply doesn't implement the optional method answers
//      `undefined` via the `?.()` call — these are DIFFERENT signals, and the
//      bug this task fixes was conflating "false" with "can't tell".
//   3. The poll guard's own fail-open predicate — `pollOnce` in
//      electron/sources/typebuild.ts now computes
//        const hasWindow = breezeHost().hasInteractiveWindow?.();
//        const skip = hasWindow === false;
//      We pin that predicate directly (it's a one-line boolean rule, the
//      actual bug-fix contract) against true/false/undefined, since exercising
//      the full pollOnce() requires a live TypeBuildTaskSource with network/DB
//      dependencies far beyond this seam — see the task write-up for why a
//      live main-process run wasn't reachable in this sandbox.
//   4. electron/sources/typebuild.ts no longer references `require('electron')`
//      or a `browserWindows()` helper at all — the ReferenceError/vacuous-`[]`
//      failure mode this task fixes cannot resurface by source inspection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));

async function loadHostModule() {
  const srcPath = path.join(here, '..', 'electron', 'core', 'host.ts');
  const source = readFileSync(srcPath, 'utf8');
  const { code } = esbuild.transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' });
  const tmpFile = path.join(
    tmpdir(),
    `typebuild-host.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.mjs`,
  );
  writeFileSync(tmpFile, code);
  const mod = await import(pathToFileURL(tmpFile).href);
  rmSync(tmpFile, { force: true });
  return mod;
}

// Mirrors the exact one-line rule now inlined at the top of pollOnce() in
// electron/sources/typebuild.ts. Kept here as a literal re-derivation (not an
// import — pollOnce is a private method on a class with heavy deps) so this
// test breaks loudly if the guard's semantics ever drift from "fail open".
function shouldSkipPoll(hasInteractiveWindowResult) {
  return hasInteractiveWindowResult === false;
}

test('poll guard: skips ONLY on an explicit false ("definitely no window")', () => {
  assert.equal(shouldSkipPoll(false), true);
});

test('poll guard: fails OPEN on undefined ("host cannot answer")', () => {
  assert.equal(shouldSkipPoll(undefined), false);
});

test('poll guard: polls on true ("a window exists")', () => {
  assert.equal(shouldSkipPoll(true), false);
});

test('default (noop) host: hasInteractiveWindow() is false, not undefined', async () => {
  const { breezeHost } = await loadHostModule();
  // Before any setBreezeHost() call, the module falls back to its internal
  // noop host, which explicitly answers `false` (a real, if degenerate,
  // answer) rather than leaving the method unimplemented.
  assert.equal(breezeHost().hasInteractiveWindow(), false);
});

test('a host that omits hasInteractiveWindow answers undefined via optional-call, not false', async () => {
  const { setBreezeHost, breezeHost } = await loadHostModule();
  // Mirrors HeadlessBreezeHost in daemon/breezed.ts, which does not implement
  // hasInteractiveWindow at all.
  setBreezeHost({
    onTasksChanged() {},
    onRunsChanged() {},
    onRunFailed() {},
  });
  const result = breezeHost().hasInteractiveWindow?.();
  assert.equal(result, undefined);
  // And per the fail-open contract, that undefined must NOT be treated as skip.
  assert.equal(shouldSkipPoll(result), false);
});

test('setBreezeHost() swaps the active host seen by breezeHost()', async () => {
  const { setBreezeHost, breezeHost } = await loadHostModule();
  let calls = 0;
  setBreezeHost({
    onTasksChanged() { calls += 1; },
    onRunsChanged() {},
    onRunFailed() {},
    hasInteractiveWindow() { return true; },
  });
  assert.equal(breezeHost().hasInteractiveWindow(), true);
  breezeHost().onTasksChanged();
  assert.equal(calls, 1);
});

test('electron/sources/typebuild.ts no longer requires electron directly', () => {
  const srcPath = path.join(here, '..', 'electron', 'sources', 'typebuild.ts');
  const source = readFileSync(srcPath, 'utf8');
  // Check live code only — drop full-line `//` comments first so the
  // explanatory history comment (which mentions the old `require('electron')`
  // call by name) doesn't trip this assertion.
  const codeOnly = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.equal(/require\(\s*['"]electron['"]\s*\)/.test(codeOnly), false);
  assert.equal(/function browserWindows/.test(codeOnly), false);
  // The two former browserWindows() call sites now route through the
  // injected host instead of a raw BrowserWindow/webContents lookup.
  assert.match(codeOnly, /breezeHost\(\)\.onSessionRelaunched\?\.\(/);
  assert.match(codeOnly, /breezeHost\(\)\.onReleasePrompt\?\.\(/);
  // The poll guard now reads hasInteractiveWindow() and fails open on
  // anything other than an explicit `false`.
  assert.match(codeOnly, /hasInteractiveWindow\?\.\(\)/);
  assert.match(codeOnly, /hasWindow === false/);
});
