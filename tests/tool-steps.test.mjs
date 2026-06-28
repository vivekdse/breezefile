// Unit tests for the resumable-steps planning core (Operator Speed).
// Pure functions in electron/browser/tools/registry.mjs — no browser, no app.
// These pin the LOAD-BEARING side-effect-safety invariant: a completed
// side-effect step is never re-run, and a not-yet-fired side-effect step is
// never silently skipped. See docs/resumable-tool-steps.md.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  normalizeSteps,
  planResume,
  lastCursor,
  stepPlanSummary,
  EXIT,
} from '../electron/browser/tools/registry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const seedDir = join(here, '..', 'electron', 'browser', 'tools', 'seed');
const loadSeedMeta = (id) => JSON.parse(readFileSync(join(seedDir, id, 'tool.json'), 'utf8'));
const importSeed = (id) => import(`../electron/browser/tools/seed/${id}/tool.mjs`);

const noop = async () => ({});

// ─── normalizeSteps ──────────────────────────────────────────────────────────
test('legacy single-run tool becomes ONE implicit side-effect step', () => {
  const n = normalizeSteps({ run: noop });
  assert.equal(n.ok, true);
  assert.equal(n.implicit, true);
  assert.equal(n.steps.length, 1);
  assert.equal(n.steps[0].name, 'run');
  // safe default: opaque legacy run is treated as side-effecting (never replayed)
  assert.equal(n.steps[0].sideEffect, true);
});

test('a module with neither run nor steps is invalid', () => {
  const n = normalizeSteps({});
  assert.equal(n.ok, false);
  assert.ok(n.errors.some((e) => /run.*or.*steps/.test(e)));
});

test('steps[] is normalized; sideEffect defaults false; hooks preserved', () => {
  const pre = async () => true;
  const n = normalizeSteps({
    steps: [
      { name: 'a', run: noop },
      { name: 'b', sideEffect: true, pre, run: noop },
    ],
  });
  assert.equal(n.ok, true);
  assert.equal(n.implicit, false);
  assert.equal(n.steps[0].sideEffect, false);
  assert.equal(n.steps[1].sideEffect, true);
  assert.equal(n.steps[1].pre, pre);
});

test('normalizeSteps rejects bad names, dupes, non-function run', () => {
  assert.equal(normalizeSteps({ steps: [{ name: 'A B', run: noop }] }).ok, false);
  assert.equal(normalizeSteps({ steps: [{ name: 'a', run: noop }, { name: 'a', run: noop }] }).ok, false);
  assert.equal(normalizeSteps({ steps: [{ name: 'a', run: 5 }] }).ok, false);
});

// ─── planResume: clean run ───────────────────────────────────────────────────
const STEPS = normalizeSteps({
  steps: [
    { name: 'compose', sideEffect: false, run: noop },
    { name: 'send', sideEffect: true, run: noop },
  ],
}).steps;

test('clean run plans all steps from index 0', () => {
  const p = planResume(STEPS, null, []);
  assert.equal(p.ok, true);
  assert.equal(p.startIndex, 0);
  assert.deepEqual(p.skip, []);
  assert.deepEqual(p.plan, ['compose', 'send']);
});

// ─── planResume: the safety invariant ────────────────────────────────────────
test('resume AT the broken side-effect step is allowed (first fire, not replay)', () => {
  // compose done, send broke and was NOT recorded done → resume at send.
  const p = planResume(STEPS, 'send', ['compose']);
  assert.equal(p.ok, true);
  assert.equal(p.startIndex, 1);
  assert.deepEqual(p.skip, ['compose']);
  assert.deepEqual(p.plan, ['send']);
});

test('REFUSE re-running a completed side-effect step (no double-submit)', () => {
  // send already recorded done; a resume that would re-run it must be refused.
  const p = planResume(STEPS, 'send', ['compose', 'send']);
  assert.equal(p.ok, false);
  assert.ok(p.errors.some((e) => /re-run completed side-effecting step "send"/.test(e)));
});

test('REFUSE skipping a not-yet-fired side-effect step (no phantom effect)', () => {
  // Cursor past send, but send was never recorded done → skipping it is wrong.
  const p = planResume(STEPS, null, []); // baseline ok
  assert.equal(p.ok, true);
  // Force a cursor past send via resume-from a (nonexistent) later step is N/A
  // with 2 steps; instead use a 3-step tool.
  const three = normalizeSteps({
    steps: [
      { name: 'compose', sideEffect: false, run: noop },
      { name: 'send', sideEffect: true, run: noop },
      { name: 'confirm', sideEffect: false, run: noop },
    ],
  }).steps;
  const bad = planResume(three, 'confirm', ['compose']); // send skipped, not done
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /skip side-effecting step "send"/.test(e)));
});

test('auto-resume starts at the first step not recorded done', () => {
  const p = planResume(STEPS, null, ['compose']);
  assert.equal(p.startIndex, 1);
  assert.deepEqual(p.plan, ['send']);
});

test('resume-from an unknown step name is refused', () => {
  const p = planResume(STEPS, 'nope', ['compose']);
  assert.equal(p.ok, false);
  assert.ok(p.errors.some((e) => /no such step/.test(e)));
});

test('idempotent step before a done side-effect is fine to skip', () => {
  // 3 steps; first two done (compose idempotent, send side-effect-done), resume
  // at confirm. Skipping send is allowed because it IS recorded done.
  const three = normalizeSteps({
    steps: [
      { name: 'compose', sideEffect: false, run: noop },
      { name: 'send', sideEffect: true, run: noop },
      { name: 'confirm', sideEffect: false, run: noop },
    ],
  }).steps;
  const p = planResume(three, 'confirm', ['compose', 'send']);
  assert.equal(p.ok, true);
  assert.deepEqual(p.skip, ['compose', 'send']);
  assert.deepEqual(p.plan, ['confirm']);
});

// ─── lastCursor (runs.jsonl) ─────────────────────────────────────────────────
let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'bt-steps-')); });
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('lastCursor reads the most recent step-bearing record', () => {
  const runs = join(dir, 'runs.jsonl');
  appendFileSync(runs, JSON.stringify({ timestamp: '2026-06-28T00:00:00Z', status: 'success' }) + '\n');
  appendFileSync(runs, JSON.stringify({ timestamp: '2026-06-28T01:00:00Z', status: 'partial', steps_done: ['compose'], failed_step: 'send' }) + '\n');
  const c = lastCursor(runs);
  assert.deepEqual(c.steps_done, ['compose']);
  assert.equal(c.failed_step, 'send');
  assert.equal(c.status, 'partial');
});

test('lastCursor is empty for no history', () => {
  const c = lastCursor(join(dir, 'none.jsonl'));
  assert.deepEqual(c.steps_done, []);
  assert.equal(c.failed_step, null);
});

test('EXIT.PARTIAL is the resumable signal (6)', () => {
  assert.equal(EXIT.PARTIAL, 6);
});

// ─── seed-tool conversions: web-form-login & extract-table ───────────────────
// The module's exported steps[] is authoritative; tool.json mirrors it (name +
// sideEffect) for help/discovery. These pin both halves stay in sync and that
// the side-effect/idempotence marks are right.

test('web-form-login: steps[] is locate-fields (idempotent) → submit (side-effect)', async () => {
  const mod = await importSeed('web-form-login');
  const n = normalizeSteps(mod);
  assert.equal(n.ok, true);
  assert.deepEqual(n.steps.map((s) => s.name), ['locate-fields', 'submit']);
  // locate-fields just types creds (reversible) — idempotent.
  assert.equal(n.steps[0].sideEffect, false);
  // submit POSTs the form — the irreversible / human-gated step.
  assert.equal(n.steps[1].sideEffect, true);
  // back-compat shim preserved.
  assert.equal(typeof mod.run, 'function');
});

test('web-form-login: tool.json DECLARES the same steps + sideEffect marks (and bumped version)', () => {
  const meta = loadSeedMeta('web-form-login');
  assert.equal(meta.version, '1.1');
  assert.deepEqual(meta.steps.map((s) => s.name), ['locate-fields', 'submit']);
  assert.equal(meta.steps[0].sideEffect, false);
  assert.equal(meta.steps[1].sideEffect, true);
});

test('web-form-login: resume REFUSES re-running a completed submit (no double-submit)', async () => {
  const mod = await importSeed('web-form-login');
  const steps = normalizeSteps(mod).steps;
  // submit already recorded done → any resume that would re-run it is refused.
  const p = planResume(steps, 'submit', ['locate-fields', 'submit']);
  assert.equal(p.ok, false);
  assert.ok(p.errors.some((e) => /re-run completed side-effecting step "submit"/.test(e)));
});

test('web-form-login: resume AT submit after a break is allowed (first fire, not replay)', async () => {
  const mod = await importSeed('web-form-login');
  const steps = normalizeSteps(mod).steps;
  // locate-fields done, submit broke and was NOT recorded → resume at submit.
  const p = planResume(steps, 'submit', ['locate-fields']);
  assert.equal(p.ok, true);
  assert.equal(p.startIndex, 1);
  assert.deepEqual(p.skip, ['locate-fields']);
  assert.deepEqual(p.plan, ['submit']);
});

test('extract-table: steps[] are all idempotent reads (extract → validate)', async () => {
  const mod = await importSeed('extract-table');
  const n = normalizeSteps(mod);
  assert.equal(n.ok, true);
  assert.deepEqual(n.steps.map((s) => s.name), ['extract', 'validate']);
  assert.equal(n.steps.every((s) => s.sideEffect === false), true);
  assert.equal(typeof mod.run, 'function'); // back-compat shim
  // No side-effect step → no replay/skip refusal anywhere; resume at any step ok.
  assert.equal(planResume(n.steps, 'validate', ['extract']).ok, true);
});

test('extract-table: tool.json mirrors steps (all sideEffect:false, bumped version)', () => {
  const meta = loadSeedMeta('extract-table');
  assert.equal(meta.version, '1.1');
  assert.deepEqual(meta.steps.map((s) => s.name), ['extract', 'validate']);
  assert.equal(meta.steps.every((s) => s.sideEffect === false), true);
});

// ─── stepPlanSummary (help/available surface) ────────────────────────────────
test('stepPlanSummary surfaces the declared plan + side-effecting steps (NON-PHI)', () => {
  const meta = loadSeedMeta('web-form-login');
  const s = stepPlanSummary(meta, null); // no runs.jsonl
  assert.deepEqual(s.steps.map((x) => x.name), ['locate-fields', 'submit']);
  assert.deepEqual(s.steps.map((x) => x.index), [0, 1]);
  assert.deepEqual(s.side_effecting, ['submit']);
  // No history → nothing resumable.
  assert.equal(s.cursor.status, null);
  assert.equal(s.cursor.resumable, false);
  assert.equal(s.cursor.resume_from, null);
});

test('stepPlanSummary reads a partial cursor and reports resume_from', () => {
  const meta = loadSeedMeta('web-form-login');
  const dir2 = mkdtempSync(join(tmpdir(), 'bt-plan-'));
  try {
    const runs = join(dir2, 'runs.jsonl');
    appendFileSync(runs, JSON.stringify({ timestamp: '2026-06-28T00:00:00Z', status: 'partial', steps_done: ['locate-fields'], failed_step: 'submit' }) + '\n');
    const s = stepPlanSummary(meta, runs);
    assert.equal(s.cursor.status, 'partial');
    assert.deepEqual(s.cursor.steps_done, ['locate-fields']);
    assert.equal(s.cursor.failed_step, 'submit');
    assert.equal(s.cursor.resume_from, 'submit');
    assert.equal(s.cursor.resumable, true);
  } finally { rmSync(dir2, { recursive: true, force: true }); }
});

test('stepPlanSummary: a legacy tool with no declared steps yields steps:null, non-resumable', () => {
  const s = stepPlanSummary({ id: 'legacy', name: 'x' }, null);
  assert.equal(s.steps, null);
  assert.deepEqual(s.side_effecting, []);
  assert.equal(s.cursor.resume_from, null);
  assert.equal(s.cursor.resumable, false);
});
