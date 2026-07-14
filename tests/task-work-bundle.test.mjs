// task-bd35fc4330c0 — unit tests for the pure bundle assembler
// (electron/typebuild/task-work-bundle.ts). That module is plain TypeScript
// with NO Electron dependency (by design — it's a pure function so the
// interactive launcher's stdin-injection logic can be unit tested without a
// live PTY). Same transpile-on-the-fly approach as
// tests/newhome-instantiate-template.test.mjs: this repo's `node --test`
// runner has no TS loader, but esbuild ships as a dependency (used by vite),
// so we transpile the real source with esbuild rather than reimplementing its
// logic in a separately-tested copy.
//
// WHAT WE'RE PINNING (the acceptance bar from the task spec):
//   1. Given a task detail + resolved input values, buildTaskWorkBundle
//      produces the exact first-message text — title, full body, resolved
//      values, output schema/evidence instruction, project instructions,
//      skills — in one shot.
//   2. That text does NOT leak values into anything that looks like an argv
//      array or a --append-system-prompt string — this module has no such
//      surface at all (it returns a plain string for stdin injection), so we
//      assert the NEGATIVE space too: the returned bundle is a self-contained
//      string, and nothing here ever constructs a CLI args array or writes to
//      disk (grep the module text for tells of either).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'electron', 'typebuild', 'task-work-bundle.ts');
const source = readFileSync(srcPath, 'utf8');

const { code } = esbuild.transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' });

const tmpFile = path.join(tmpdir(), `task-work-bundle.${process.pid}.${Date.now()}.mjs`);
writeFileSync(tmpFile, code);
const { buildTaskWorkBundle, buildTaskReentryBundle } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpFile, { force: true });

// ── fixtures ────────────────────────────────────────────────────────────────

const FIXTURE_TASK = {
  id: 'task-fixture-0001',
  title: 'Submit prior-auth for patient X',
  body: 'Log into the portal and submit a prior-auth request using the details below.',
  dataKeys: ['patient.first', 'patient.dob', 'patient.member_id'],
  outputSchema: [
    { key: 'confirmation_number', label: 'Confirmation #', type: 'text', required: true },
    { key: 'notes', label: 'Notes', type: 'text', required: false },
  ],
  projectInstructions: 'Always double check the payer name before submitting.',
  skills: [
    { name: 'Acme Portal prior-auth', body: 'Go to https://acme.example/portal and click New Request.' },
  ],
};

const FIXTURE_VALUES = [
  { key: 'patient.first', value: 'Jordan' },
  { key: 'patient.dob', value: '1990-01-01' },
  { key: 'patient.member_id', value: 'MBR-999-SECRET' },
];

test('buildTaskWorkBundle: includes title + full body', () => {
  const out = buildTaskWorkBundle(FIXTURE_TASK, FIXTURE_VALUES);
  assert.match(out, /# Submit prior-auth for patient X/);
  assert.match(out, /Log into the portal and submit a prior-auth request/);
});

test('buildTaskWorkBundle: resolved input VALUES appear alongside their keys', () => {
  const out = buildTaskWorkBundle(FIXTURE_TASK, FIXTURE_VALUES);
  assert.match(out, /patient\.first: Jordan/);
  assert.match(out, /patient\.dob: 1990-01-01/);
  assert.match(out, /patient\.member_id: MBR-999-SECRET/);
});

test('buildTaskWorkBundle: an unresolved key is flagged, not silently dropped', () => {
  const partial = [{ key: 'patient.first', value: 'Jordan' }];
  const out = buildTaskWorkBundle(FIXTURE_TASK, partial);
  assert.match(out, /patient\.dob: \(unresolved/);
  assert.match(out, /patient\.member_id: \(unresolved/);
});

test('buildTaskWorkBundle: output schema + evidence instruction present, REQUIRED flagged', () => {
  const out = buildTaskWorkBundle(FIXTURE_TASK, FIXTURE_VALUES);
  assert.match(out, /Required task outputs \(evidence\)/);
  assert.match(out, /confirmation_number.*REQUIRED/);
  assert.match(out, /notes.*optional/);
  assert.match(out, /submit_task_result\(type="fields"/);
});

test('buildTaskWorkBundle: project instructions + skills sections render', () => {
  const out = buildTaskWorkBundle(FIXTURE_TASK, FIXTURE_VALUES);
  assert.match(out, /Project instructions/);
  assert.match(out, /double check the payer name/);
  assert.match(out, /Attached skills/);
  assert.match(out, /Acme Portal prior-auth/);
  assert.match(out, /New Request/);
});

test('buildTaskWorkBundle: task id + submit contract framed up front, non-preclaimed', () => {
  const out = buildTaskWorkBundle(FIXTURE_TASK, FIXTURE_VALUES);
  const firstLine = out.split('\n')[0];
  assert.match(firstLine, /task-fixture-0001/);
  assert.match(firstLine, /Claim it/);
  assert.match(firstLine, /submit_task/);
  // The framing line is the FIRST thing in the bundle — before title/body —
  // so an agent reading top-to-bottom immediately knows the id + contract
  // without a get_task round-trip.
  assert.equal(out.indexOf(firstLine), 0);
});

test('buildTaskWorkBundle: preclaimed framing tells the agent not to re-claim', () => {
  const out = buildTaskWorkBundle({ ...FIXTURE_TASK, preclaimed: true }, FIXTURE_VALUES);
  const firstLine = out.split('\n')[0];
  assert.match(firstLine, /already claimed by me/);
  assert.doesNotMatch(firstLine, /Claim it/);
});

test('buildTaskWorkBundle: no body, no data keys, no schema, no instructions, no skills -> just the title framing', () => {
  const minimal = { id: 'task-min', title: 'Bare task', body: null };
  const out = buildTaskWorkBundle(minimal, []);
  assert.match(out, /# Bare task/);
  assert.doesNotMatch(out, /Required task outputs/);
  assert.doesNotMatch(out, /Project instructions/);
  assert.doesNotMatch(out, /Attached skills/);
});

test('buildTaskWorkBundle: malformed/unknown-shaped skills entries are skipped, not rendered as "undefined"', () => {
  const withJunk = {
    ...FIXTURE_TASK,
    skills: [null, 42, {}, { unrelatedField: 'x' }, 'A plain-string skill note'],
  };
  const out = buildTaskWorkBundle(withJunk, FIXTURE_VALUES);
  assert.doesNotMatch(out, /undefined/);
  assert.match(out, /A plain-string skill note/);
});

// ── task-reenter: the RE-ENTRY bundle (review a finished task) ──────────────

const REENTRY_CTX = {
  status: 'partial',
  result: {
    type: 'fields',
    payload: { confirmation_number: 'CPT-30140-OK', notes: 'no auth needed for this CPT' },
  },
  messages: [
    { text: 'Claimed and logged into the payer portal.', by: 'agent-smith', at: '2026-07-13T10:00:00Z' },
    { text: 'Confirmed CPT 30140 needs no prior auth; saved the screenshot.', by: 'agent-smith', at: '2026-07-13T10:05:00Z' },
    { text: 'Great — can you also grab the fax cover?', by: 'vivekdse@gmail.com', at: '2026-07-13T10:06:00Z' },
  ],
  agentName: 'agent-smith',
};

test('buildTaskReentryBundle: framing says RE-ENTERING, status, and do-not-restart', () => {
  const out = buildTaskReentryBundle(FIXTURE_TASK, REENTRY_CTX, FIXTURE_VALUES);
  const firstLine = out.split('\n')[0];
  assert.match(firstLine, /RE-ENTERING/);
  assert.match(firstLine, /task-fixture-0001/);
  assert.match(firstLine, /PARTIAL/);
  assert.match(firstLine, /Do NOT restart/i);
  assert.match(firstLine, /WAIT for the human/);
});

test('buildTaskReentryBundle: prior result payload is included', () => {
  const out = buildTaskReentryBundle(FIXTURE_TASK, REENTRY_CTX, FIXTURE_VALUES);
  assert.match(out, /Result submitted so far/);
  assert.match(out, /confirmation_number: CPT-30140-OK/);
  assert.match(out, /notes: no auth needed for this CPT/);
});

test('buildTaskReentryBundle: full conversation thread is included, agent turns labelled', () => {
  const out = buildTaskReentryBundle(FIXTURE_TASK, REENTRY_CTX, FIXTURE_VALUES);
  assert.match(out, /Conversation so far/);
  assert.match(out, /Claimed and logged into the payer portal/);
  assert.match(out, /agent-smith \(agent\)/);
  assert.match(out, /vivekdse@gmail.com: Great/);
});

test('buildTaskReentryBundle: still carries title, body, inputs, and required outputs (for editing)', () => {
  const out = buildTaskReentryBundle(FIXTURE_TASK, REENTRY_CTX, FIXTURE_VALUES);
  assert.match(out, /# Submit prior-auth for patient X/);
  assert.match(out, /patient\.member_id: MBR-999-SECRET/);
  assert.match(out, /Required task outputs \(evidence\)/);
});

test('buildTaskReentryBundle: empty result + empty thread degrade cleanly (no headers)', () => {
  const out = buildTaskReentryBundle(FIXTURE_TASK, { status: 'done' }, FIXTURE_VALUES);
  assert.match(out, /RE-ENTERING/);
  assert.doesNotMatch(out, /Result submitted so far/);
  assert.doesNotMatch(out, /Conversation so far/);
  assert.doesNotMatch(out, /undefined/);
});

// ── PHI/leak-surface assertions (the load-bearing constraint) ───────────────
//
// This module's ENTIRE public surface is buildTaskWorkBundle(task, values) ->
// string. It has no argv-building, no CLI-flag assembly, and no filesystem
// writes — the caller (electron/agents/interactive.ts) is solely responsible
// for the stdin-only delivery. We assert that invariant holds at the source
// level so a future edit can't quietly reintroduce an argv/disk path here.

test('module source never touches argv, spawn args, or the filesystem', () => {
  assert.doesNotMatch(source, /process\.argv/);
  // The module's header PROSE explains why it deliberately avoids
  // --append-system-prompt (that's the point of this test) — so we assert
  // there's no *usage* of it (e.g. as an actual CLI-arg string literal
  // assembled into an array), not merely that the word never appears at all.
  assert.doesNotMatch(source, /\[['"]--append-system-prompt['"]/);
  assert.doesNotMatch(source, /writeFileSync|readFileSync|mkdirSync/);
  assert.doesNotMatch(source, /\bspawn\(/);
});

test('the returned bundle is a plain string (the stdin-injection payload), not an array/object', () => {
  const out = buildTaskWorkBundle(FIXTURE_TASK, FIXTURE_VALUES);
  assert.equal(typeof out, 'string');
});
