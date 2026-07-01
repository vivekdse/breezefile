// task-c926bbe959f6 — tests for the PURE Stop-hook backstop decision core.
// Unit-tests decideStopBackstop (the side-effect-free .mjs), not the IPC/hook
// plumbing. The rule is structural: a session stopped with its task STILL
// in_progress + unadvanced → flag with a fixed GENERIC PHI-free question;
// anything already advanced (submitted/released/terminal) or a missing task
// binding → no-op (no false positives on happy-path / completed sessions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideStopBackstop,
  GENERIC_STOP_QUESTION,
} from '../electron/claude-stop-backstop.mjs';

const SIGNAL = {
  task_id: 'task-abc',
  source_id: 'typebuild',
  session_id: 'sess-1',
  // A transcript POINTER is present but the decision never reads it (PHI).
  transcript_path: '/home/user/.claude/transcripts/sess-1.jsonl',
};

// ── FLAG: stopped while task is still in_progress + unadvanced ─────────────
test('flags when task is still in_progress with no pending question', () => {
  const task = { status: 'in_progress', pending_question: null };
  const out = decideStopBackstop(SIGNAL, task);
  assert.equal(out.action, 'flag');
  assert.equal(out.taskId, 'task-abc');
  assert.equal(out.sourceId, 'typebuild');
  // Fixed GENERIC PHI-free string — never derived from transcript content.
  assert.equal(out.text, GENERIC_STOP_QUESTION);
});

test('flag text is a fixed generic PHI-free string (no patient-visible content)', () => {
  const task = { status: 'in_progress' };
  const out = decideStopBackstop(SIGNAL, task);
  assert.equal(out.action, 'flag');
  assert.equal(out.text, GENERIC_STOP_QUESTION);
  // The generic text is not templated from any signal field — same for any task.
  const other = decideStopBackstop({ ...SIGNAL, task_id: 'task-xyz' }, task);
  assert.equal(other.text, GENERIC_STOP_QUESTION);
});

test('defaults sourceId to typebuild when the signal omits it', () => {
  const out = decideStopBackstop({ task_id: 'task-abc' }, { status: 'in_progress' });
  assert.equal(out.action, 'flag');
  assert.equal(out.sourceId, 'typebuild');
});

// ── NO-OP: task already advanced (submitted / released / terminal) ─────────
for (const status of ['done', 'pending', 'cancelled', 'blocked', 'todo']) {
  test(`no-op when task advanced (status=${status})`, () => {
    const out = decideStopBackstop(SIGNAL, { status, pending_question: null });
    assert.equal(out.action, 'noop');
    assert.match(out.reason, /task advanced/);
  });
}

// ── NO-OP: a structured question is already logged (don't stomp / double-flag)
test('no-op when a pending_question is already present', () => {
  const task = {
    status: 'in_progress',
    pending_question: { text: 'the model already asked something' },
  };
  const out = decideStopBackstop(SIGNAL, task);
  assert.equal(out.action, 'noop');
  assert.match(out.reason, /pending_question already present/);
});

// ── NO-OP: no task binding (plain `claude` in a shell tab) ─────────────────
test('no-op when the signal has no task binding', () => {
  const out = decideStopBackstop({}, { status: 'in_progress' });
  assert.equal(out.action, 'noop');
  assert.match(out.reason, /no task binding/);
});

test('no-op when task_id is blank/whitespace only', () => {
  const out = decideStopBackstop({ task_id: '   ' }, { status: 'in_progress' });
  assert.equal(out.action, 'noop');
  assert.match(out.reason, /no task binding/);
});

// ── NO-OP: task not found / not visible from the source ────────────────────
test('no-op when the task is missing (not found / not visible)', () => {
  const out = decideStopBackstop(SIGNAL, null);
  assert.equal(out.action, 'noop');
  assert.match(out.reason, /not found/);
});
