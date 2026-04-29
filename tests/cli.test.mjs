// Runtime smoke test for the breeze CLI. Uses node:test (built-in,
// no devDep cost). Spawns bin/breeze and asserts on its output. Each
// test that needs the live API skips when ~/.breezefile/api.json is
// missing — i.e. when the Electron app isn't running — so this can run
// in CI or on a fresh dev machine without exploding.
//
// Pair this with tests/cli.contract.ts: that one is compile-time
// (catches schema drift), this one is runtime (catches launcher bugs
// like the symlink-resolution regression we just fixed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const breeze = join(repoRoot, 'bin', 'breeze');
const apiFile = join(homedir(), '.breezefile', 'api.json');

function run(args, opts = {}) {
  return spawnSync(breeze, args, { encoding: 'utf8', timeout: 5000, ...opts });
}

test('shim and mjs exist and are executable', () => {
  assert.ok(existsSync(breeze), 'bin/breeze missing');
  assert.ok(existsSync(breeze + '.mjs'), 'bin/breeze.mjs missing');
});

test('help subcommand returns 0 with usage text', () => {
  const r = run(['help']);
  assert.equal(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stdout, /breeze prime/);
  assert.match(r.stdout, /breeze install-hooks/);
});

test('unknown subcommand exits 2', () => {
  const r = run(['definitely-not-a-command']);
  assert.equal(r.status, 2);
});

test('prime emits header markdown when API is reachable', { skip: !existsSync(apiFile) }, () => {
  const r = run(['prime']);
  assert.equal(r.status, 0);
  // No output means readApi() returned null OR fetch failed — both are
  // valid silent-fail paths but make the test useless. Force the loud
  // case: api.json exists, so we expect actual content.
  assert.ok(r.stdout.length > 0, 'prime emitted nothing despite api.json present');
  assert.match(r.stdout, /^# Breeze: Active Work Context/);
  assert.match(r.stdout, /## Active Tasks/);
});

test('add → list → done → rm round trip', { skip: !existsSync(apiFile) }, () => {
  const title = `cli-test probe ${Date.now()}`;
  const a = run(['add', title, '--folder', '/tmp']);
  assert.equal(a.status, 0, `add failed: ${a.stderr}`);
  const id = a.stdout.trim();
  assert.match(id, /^[0-9a-f-]{36}$/, `unexpected id: ${id}`);

  const l = run(['list', '--all']);
  assert.equal(l.status, 0);
  assert.ok(l.stdout.includes(id), `list --all missing new id ${id}`);

  const d = run(['done', id]);
  assert.equal(d.status, 0, `done failed: ${d.stderr}`);

  const r = run(['rm', id]);
  assert.equal(r.status, 0, `rm failed: ${r.stderr}`);

  const l2 = run(['list', '--all']);
  assert.ok(!l2.stdout.includes(id), 'task still listed after rm');
});

test('prime exits 0 silently when api.json absent', () => {
  // Simulate "app not running" by pointing HOME at an empty dir. Hook
  // contract: SessionStart must never block, so prime must exit 0 with
  // no output here.
  const r = run(['prime'], { env: { ...process.env, HOME: '/tmp/__breeze_no_api__' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
