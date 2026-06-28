// Unit tests for the resumable-steps planning core (Operator Speed).
// Pure functions in electron/browser/tools/registry.mjs — no browser, no app.
// These pin the LOAD-BEARING side-effect-safety invariant: a completed
// side-effect step is never re-run, and a not-yet-fired side-effect step is
// never silently skipped. See docs/resumable-tool-steps.md.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  normalizeSteps,
  planResume,
  lastCursor,
  EXIT,
} from '../electron/browser/tools/registry.mjs';

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
