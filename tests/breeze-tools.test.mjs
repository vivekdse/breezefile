// Runtime tests for the breeze-tools CLI (bin/breeze-tools.mjs) and the seed
// installer. Discovery (available/help/list) must work WITHOUT a running app or
// a browser, so these run anywhere. The `run` path is only smoke-tested up to
// the point it needs a live CDP browser (asserting the precondition exit code).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const cli = join(repoRoot, 'bin', 'breeze-tools.mjs');
const installer = join(repoRoot, 'electron', 'browser', 'tools', 'install.mjs');

function run(args, toolsDir) {
  return spawnSync('node', [cli, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, BREEZE_TOOLS_DIR: toolsDir },
  });
}

function freshRepoWithSeeds() {
  const dir = mkdtempSync(join(tmpdir(), 'bt-cli-'));
  const r = spawnSync('node', [installer], {
    encoding: 'utf8',
    env: { ...process.env, BREEZE_TOOLS_DIR: dir },
  });
  assert.equal(r.status, 0, `installer failed: ${r.stderr}`);
  return dir;
}

test('shim + mjs exist', () => {
  assert.ok(existsSync(cli), 'bin/breeze-tools.mjs missing');
  assert.ok(existsSync(join(repoRoot, 'bin', 'breeze-tools')), 'bin/breeze-tools shim missing');
});

test('no args prints usage, exit 64', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-cli-'));
  try {
    const r = run([], dir);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /breeze-tools/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown command exits 64', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-cli-'));
  try {
    assert.equal(run(['frobnicate'], dir).status, 64);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('installer seeds the three built-in tools, idempotently', () => {
  const dir = freshRepoWithSeeds();
  try {
    for (const id of ['gmail-prefill-send', 'web-form-login', 'extract-table']) {
      assert.ok(existsSync(join(dir, id, 'tool.json')), `${id}/tool.json missing`);
      assert.ok(existsSync(join(dir, id, 'tool.mjs')), `${id}/tool.mjs missing`);
    }
    // Second run installs nothing new.
    const second = spawnSync('node', [installer], {
      encoding: 'utf8',
      env: { ...process.env, BREEZE_TOOLS_DIR: dir },
    });
    assert.deepEqual(JSON.parse(second.stdout).installed, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('list shows seeded tools', () => {
  const dir = freshRepoWithSeeds();
  try {
    const r = run(['list', '--json'], dir);
    assert.equal(r.status, 0);
    const ids = JSON.parse(r.stdout).tools.map((t) => t.id).sort();
    assert.deepEqual(ids, ['extract-table', 'gmail-prefill-send', 'web-form-login']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('available matches a Gmail URL (specific + generic tools)', () => {
  const dir = freshRepoWithSeeds();
  try {
    const r = run(['available', 'https://mail.google.com/mail/u/0/#inbox'], dir);
    assert.equal(r.status, 0);
    const ids = JSON.parse(r.stdout).tools.map((t) => t.id);
    assert.ok(ids.includes('gmail-prefill-send'));
    assert.ok(ids.includes('web-form-login')); // matches '*'
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('available on an unrelated URL returns only the generic * tools', () => {
  const dir = freshRepoWithSeeds();
  try {
    const r = run(['available', 'https://intranet.local/x'], dir);
    const ids = JSON.parse(r.stdout).tools.map((t) => t.id).sort();
    // gmail (mail.google.com) must NOT match; the two '*' tools must.
    assert.ok(!ids.includes('gmail-prefill-send'));
    assert.deepEqual(ids, ['extract-table', 'web-form-login']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('help returns full metadata + validity for a real tool', () => {
  const dir = freshRepoWithSeeds();
  try {
    const r = run(['help', 'web-form-login'], dir);
    assert.equal(r.status, 0);
    const meta = JSON.parse(r.stdout);
    assert.equal(meta.id, 'web-form-login');
    assert.equal(meta._valid, true);
    assert.ok(meta.params.username.required);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('help on a missing tool exits 1', () => {
  const dir = freshRepoWithSeeds();
  try {
    assert.equal(run(['help', 'nope'], dir).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('run with a missing required param exits 7 (precondition) with JSON', () => {
  const dir = freshRepoWithSeeds();
  try {
    const r = run(['run', 'web-form-login', '--username', 'a'], dir); // no --password
    assert.equal(r.status, 7);
    const out = JSON.parse(r.stdout);
    assert.equal(out.code, 7);
    assert.equal(out.error.category, 'precondition_not_met');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('run with no live browser exits with a precondition/timeout code', () => {
  const dir = freshRepoWithSeeds();
  try {
    // gmail tool needs no required params; with no app/CDP it cannot connect.
    const r = run(['run', 'extract-table'], dir);
    // 3 = timeout/connection-refused, 7 = no browser window. Either is a
    // graceful, structured failure (not a crash).
    assert.ok([3, 7].includes(r.status), `unexpected exit ${r.status}: ${r.stdout}${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.status, 'error');
    assert.ok(out.error && out.error.category);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
