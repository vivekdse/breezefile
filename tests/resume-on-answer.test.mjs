// task-c5cae3255a96 — unit tests for the PURE resume-on-answer decision core
// (electron/core/resume-on-answer.mjs). We test the DECISION, not the pty /
// subprocess: given what breezed is tracking + the freshly-observed task state,
// does it resume the right session_id, or correctly no-op?
//
// The whole tier is NON-LOAD-BEARING (a latency optimization over polling), so
// the tests focus on the four behaviors the task calls out:
//   - parked → cleared, live session tracked  → RESUME that session_id
//   - no live session                         → no-op
//   - still pending                           → no-op (keep watching)
//   - never tracked by breezed / not parked   → no-op
// plus the terminal / gone guards and the PHI-free observeTask distiller.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideResumeOnAnswer,
  observeTask,
} from '../electron/core/resume-on-answer.mjs';

const tracked = (over = {}) => ({
  taskId: 't1',
  sessionId: 'sess-abc',
  hadPendingQuestion: true,
  ...over,
});
const observed = (over = {}) => ({
  exists: true,
  hasPendingQuestion: false,
  status: 'in_progress',
  ...over,
});

// ─── the ONE transition we act on: parked → cleared, live session ─────────────

test('parked session whose question just cleared → resume that session_id', () => {
  const d = decideResumeOnAnswer(tracked(), observed({ hasPendingQuestion: false }));
  assert.equal(d.action, 'resume');
  assert.equal(d.taskId, 't1');
  assert.equal(d.sessionId, 'sess-abc');
});

// ─── no live session → no-op (this tier is absent without a session_id) ───────

test('no session id → no-op, drop (nothing to resume into)', () => {
  const d = decideResumeOnAnswer(
    tracked({ sessionId: '' }),
    observed({ hasPendingQuestion: false }),
  );
  assert.equal(d.action, 'noop');
  assert.equal(d.drop, true);
  assert.match(d.reason, /session/);
});

// ─── still pending → no-op, KEEP watching (not answered yet) ──────────────────

test('question still set → no-op, keep watching (no drop)', () => {
  const d = decideResumeOnAnswer(tracked(), observed({ hasPendingQuestion: true }));
  assert.equal(d.action, 'noop');
  assert.equal(d.reason, 'still pending');
  assert.notEqual(d.drop, true); // keep the entry so a later sweep can resume it
});

// ─── never tracked / not parked → no-op ───────────────────────────────────────

test('not tracked at all → no-op, drop', () => {
  assert.equal(decideResumeOnAnswer(null, observed()).action, 'noop');
  assert.equal(decideResumeOnAnswer(undefined, observed()).action, 'noop');
  assert.equal(decideResumeOnAnswer({}, observed()).action, 'noop');
  assert.equal(decideResumeOnAnswer(null, observed()).drop, true);
});

test('was never parked on a question → no-op, drop (not our transition to ride)', () => {
  const d = decideResumeOnAnswer(
    tracked({ hadPendingQuestion: false }),
    observed({ hasPendingQuestion: false }),
  );
  assert.equal(d.action, 'noop');
  assert.equal(d.drop, true);
  assert.match(d.reason, /parked/);
});

// ─── terminal / gone guards: never resume a finished or vanished task ─────────

test('task gone server-side → no-op, drop', () => {
  const d = decideResumeOnAnswer(tracked(), observeTask(null));
  assert.equal(d.action, 'noop');
  assert.equal(d.drop, true);
  assert.match(d.reason, /gone/);
});

test('task done → no-op, drop (do not re-open completed work)', () => {
  const d = decideResumeOnAnswer(
    tracked(),
    observed({ hasPendingQuestion: false, status: 'done' }),
  );
  assert.equal(d.action, 'noop');
  assert.equal(d.drop, true);
});

test('task cancelled → no-op, drop', () => {
  const d = decideResumeOnAnswer(
    tracked(),
    observed({ hasPendingQuestion: false, status: 'cancelled' }),
  );
  assert.equal(d.action, 'noop');
  assert.equal(d.drop, true);
});

// ─── observeTask: PHI-free distiller (presence only, never the text) ──────────

test('observeTask reports presence WITHOUT carrying the question text', () => {
  const o = observeTask({
    status: 'in_progress',
    pending_question: { text: 'PHI: is the patient allergic to X?' },
  });
  assert.equal(o.exists, true);
  assert.equal(o.hasPendingQuestion, true);
  assert.equal(o.status, 'in_progress');
  // The distilled shape is a boolean + status only — no `text` field anywhere.
  assert.equal('text' in o, false);
  assert.deepEqual(Object.keys(o).sort(), ['exists', 'hasPendingQuestion', 'status']);
});

test('observeTask treats null / empty / whitespace question as cleared', () => {
  assert.equal(observeTask({ pending_question: null }).hasPendingQuestion, false);
  assert.equal(observeTask({ pending_question: undefined }).hasPendingQuestion, false);
  assert.equal(observeTask({ pending_question: {} }).hasPendingQuestion, false);
  assert.equal(observeTask({ pending_question: { text: '' } }).hasPendingQuestion, false);
  assert.equal(observeTask({ pending_question: { text: '   ' } }).hasPendingQuestion, false);
});

test('observeTask on null task → exists:false (task gone)', () => {
  const o = observeTask(null);
  assert.equal(o.exists, false);
  assert.equal(o.hasPendingQuestion, false);
});

// ─── end-to-end via observeTask: the realistic set→null path ──────────────────

test('realistic flow: getTask returns cleared question on a live task → resume', () => {
  // Simulates a real get_task response after the human answered.
  const raw = { status: 'in_progress', pending_question: null };
  const d = decideResumeOnAnswer(tracked(), observeTask(raw));
  assert.equal(d.action, 'resume');
  assert.equal(d.sessionId, 'sess-abc');
});

test('realistic flow: getTask still shows the question → no-op keep', () => {
  const raw = { status: 'in_progress', pending_question: { text: 'still asking' } };
  const d = decideResumeOnAnswer(tracked(), observeTask(raw));
  assert.equal(d.action, 'noop');
  assert.equal(d.reason, 'still pending');
});
