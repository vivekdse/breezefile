// Runtime tests for the breeze-tools CLI (bin/breeze-tools.mjs) and the seed
// installer. Discovery (available/help/list) must work WITHOUT a running app or
// a browser, so these run anywhere. The `run` path is only smoke-tested up to
// the point it needs a live CDP browser (asserting the precondition exit code).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
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

test('help surfaces the step plan (names + sideEffect markers) and a cursor', () => {
  const dir = freshRepoWithSeeds();
  try {
    const r = run(['help', 'web-form-login'], dir);
    assert.equal(r.status, 0);
    const meta = JSON.parse(r.stdout);
    const plan = meta._step_plan;
    assert.ok(plan, '_step_plan present');
    assert.deepEqual(plan.steps.map((s) => s.name), ['locate-fields', 'submit']);
    // sideEffect markers visible without importing the module.
    assert.equal(plan.steps[0].sideEffect, false);
    assert.equal(plan.steps[1].sideEffect, true);
    assert.deepEqual(plan.side_effecting, ['submit']);
    // cursor block present (no history yet → nothing resumable).
    assert.equal(plan.cursor.resumable, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('help cursor reflects a partial run in runs.jsonl (resume_from)', () => {
  const dir = freshRepoWithSeeds();
  try {
    appendFileSync(
      join(dir, 'web-form-login', 'runs.jsonl'),
      JSON.stringify({ timestamp: '2026-06-28T00:00:00Z', status: 'partial', steps_done: ['locate-fields'], failed_step: 'submit' }) + '\n',
    );
    const meta = JSON.parse(run(['help', 'web-form-login'], dir).stdout);
    assert.equal(meta._step_plan.cursor.status, 'partial');
    assert.equal(meta._step_plan.cursor.resume_from, 'submit');
    assert.equal(meta._step_plan.cursor.resumable, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('available surfaces step_plan per tool', () => {
  const dir = freshRepoWithSeeds();
  try {
    const r = run(['available', 'https://intranet.local/x'], dir);
    assert.equal(r.status, 0);
    const tools = JSON.parse(r.stdout).tools;
    const login = tools.find((t) => t.id === 'web-form-login');
    assert.ok(login.step_plan, 'step_plan present on available entry');
    assert.deepEqual(login.step_plan.side_effecting, ['submit']);
    const table = tools.find((t) => t.id === 'extract-table');
    assert.deepEqual(table.step_plan.steps.map((s) => s.name), ['extract', 'validate']);
    assert.deepEqual(table.step_plan.side_effecting, []);
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
    // OUTPUT CONTRACT: every failing result carries a machine-readable cause.
    assert.equal(out.error.likely_cause, 'precondition');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─── likely_cause field (Operator Speed — repair tier) ───────────────────────

import {
  LIKELY_CAUSE,
  LIKELY_CAUSES,
  likelyCause,
  ERROR_CATEGORY,
} from '../electron/browser/tools/registry.mjs';

test('LIKELY_CAUSE maps every ERROR_CATEGORY to a valid closed-vocab cause', () => {
  // The map is the deterministic category→likely_cause contract the playbook
  // branch keys off. Pin the exact expected mapping.
  const expected = {
    selector_not_found: 'selector_drift',
    auth_failed: 'auth',
    timeout: 'timeout',
    rate_limited: 'timeout',
    precondition_not_met: 'precondition',
    element_disabled: 'precondition',
    validation_failed: 'param',
    partial_success: 'param',
    unexpected_state: 'unknown',
    navigation_failed: 'unknown',
  };
  assert.deepEqual(LIKELY_CAUSE, expected);
  // Every known error category has a mapping in the closed vocabulary…
  for (const category of Object.keys(ERROR_CATEGORY)) {
    assert.ok(LIKELY_CAUSES.includes(LIKELY_CAUSE[category]), `category ${category} → unknown cause`);
  }
  // …and the resolver is total: unknown/missing categories fall back to 'unknown'.
  assert.equal(likelyCause('not_a_real_category'), 'unknown');
  assert.equal(likelyCause(undefined), 'unknown');
});

test('a no-such-tool run still stamps likely_cause on the error', () => {
  const dir = freshRepoWithSeeds();
  try {
    const r = run(['run', 'does-not-exist'], dir);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error.category, 'precondition_not_met');
    assert.equal(out.error.likely_cause, 'precondition');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─── resumable steps (Operator Speed) — offline via --dry-run ────────────────

test('--dry-run shows the step plan for a steps[] tool (no browser)', () => {
  const dir = freshRepoWithSeeds();
  try {
    const r = run(['run', 'gmail-prefill-send', '--to', 'a@b.com', '--dry-run'], dir);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.dry_run, true);
    assert.equal(o.implicit_single_step, false);
    // ordered, named, side-effect-marked
    assert.deepEqual(o.steps, [
      { name: 'compose', sideEffect: false },
      { name: 'send', sideEffect: true },
    ]);
    assert.deepEqual(o.plan, ['compose', 'send']); // clean run plans all
    assert.deepEqual(o.skip, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--dry-run --resume-from send skips the done compose step', () => {
  const dir = freshRepoWithSeeds();
  try {
    // Seed a partial cursor: compose done, send broke (not done).
    appendFileSync(
      join(dir, 'gmail-prefill-send', 'runs.jsonl'),
      JSON.stringify({ timestamp: '2026-06-28T00:00:00Z', status: 'partial', steps_done: ['compose'], failed_step: 'send' }) + '\n',
    );
    const r = run(['run', 'gmail-prefill-send', '--to', 'a@b.com', '--resume-from', 'send', '--dry-run'], dir);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.start_index, 1);
    assert.deepEqual(o.skip, ['compose']);
    assert.deepEqual(o.plan, ['send']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resume REFUSES to re-fire a completed side-effect step (exit 7)', () => {
  const dir = freshRepoWithSeeds();
  try {
    // Cursor says send ALREADY fired. Asking to resume-from send must be refused
    // — this is the load-bearing no-double-submit gate.
    appendFileSync(
      join(dir, 'gmail-prefill-send', 'runs.jsonl'),
      JSON.stringify({ timestamp: '2026-06-28T00:00:00Z', status: 'partial', steps_done: ['compose', 'send'], failed_step: null }) + '\n',
    );
    const r = run(['run', 'gmail-prefill-send', '--to', 'a@b.com', '--resume-from', 'send', '--dry-run'], dir);
    assert.equal(r.status, 7, r.stdout + r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.error.category, 'precondition_not_met');
    assert.match(o.error.message, /re-run completed side-effecting step "send"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy single-run tool dry-run shows ONE implicit side-effect step', () => {
  const dir = freshRepoWithSeeds();
  try {
    // A genuinely legacy tool exporting only `run` (no steps[]) — proves the
    // single-`run` back-compat path (normalized to one implicit side-effect step).
    mkdirSync(join(dir, 'legacy-runner'), { recursive: true });
    writeFileSync(join(dir, 'legacy-runner', 'tool.json'),
      JSON.stringify({ id: 'legacy-runner', name: 'Legacy', description: 'legacy', match: ['*'] }) + '\n');
    writeFileSync(join(dir, 'legacy-runner', 'tool.mjs'),
      'export async function run(){return {ok:true};}\n');
    const r = run(['run', 'legacy-runner', '--dry-run'], dir);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.implicit_single_step, true);
    assert.deepEqual(o.steps, [{ name: 'run', sideEffect: true }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('converted web-form-login dry-run shows the 2-step plan (locate-fields → submit)', () => {
  const dir = freshRepoWithSeeds();
  try {
    const r = run(['run', 'web-form-login', '--username', 'u', '--password', 'p', '--dry-run'], dir);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.implicit_single_step, false);
    assert.deepEqual(o.steps, [
      { name: 'locate-fields', sideEffect: false },
      { name: 'submit', sideEffect: true },
    ]);
    assert.deepEqual(o.plan, ['locate-fields', 'submit']);
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
