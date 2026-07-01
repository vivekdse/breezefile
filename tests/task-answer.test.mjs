// task-a763ca5be676 — unit tests for the pure task-answer module
// (src/components/tasks/taskAnswer.mjs) plus a PHI guard against the skeleton.
//
// The React <TaskAnswerBox> is a thin wrapper over these helpers: it enables the
// Send button (and the Enter handler) via canSubmitAnswer, sends normalizeAnswer's
// trimmed value, and renders one option CHIP per answerOptions entry (and NONE
// when there are no options). So testing the pure layer covers the
// render/enablement contract AND the NON-REGRESSION guarantee (a question-less
// task, or a question with no options, surfaces no chips / nothing to submit).
//
// The source method's error mapping (electron/sources/typebuild.ts answerQuestion
// — 409 no_pending_question / 404 not_visible / 400 empty) is TypeScript and is
// covered by typecheck + manual QA against the live server, like the message
// poster's mapping (task-messages.test.mjs's note).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAnswer,
  canSubmitAnswer,
  answerOptions,
} from '../src/components/tasks/taskAnswer.mjs';
import {
  SKELETON_COLUMNS,
  SKELETON_TABLE_SQL,
  parseColumnNames,
} from '../electron/sources/task-skeleton-schema.mjs';

// ─── normalizeAnswer: the exact string a submit sends ─────────────────────────

test('normalizeAnswer trims and passes a real answer through', () => {
  assert.equal(normalizeAnswer('  yes please  '), 'yes please');
  assert.equal(normalizeAnswer('no'), 'no');
});

test('normalizeAnswer collapses empty/whitespace/non-string to ""', () => {
  assert.equal(normalizeAnswer(''), '');
  assert.equal(normalizeAnswer('   '), '');
  assert.equal(normalizeAnswer(undefined), '');
  assert.equal(normalizeAnswer(null), '');
  assert.equal(normalizeAnswer(42), '');
});

// ─── canSubmitAnswer: Send-button + Enter enablement ──────────────────────────

test('canSubmitAnswer allows a non-empty answer that is not in flight', () => {
  assert.equal(canSubmitAnswer('yes', false), true);
  assert.equal(canSubmitAnswer('  a  ', false), true);
});

test('canSubmitAnswer blocks empty answers (nothing to send)', () => {
  assert.equal(canSubmitAnswer('', false), false);
  assert.equal(canSubmitAnswer('   ', false), false);
  assert.equal(canSubmitAnswer(undefined, false), false);
});

test('canSubmitAnswer blocks a resend while one is already in flight', () => {
  assert.equal(canSubmitAnswer('yes', true), false);
});

// ─── answerOptions: quick-reply chips, defensive against a bad payload ────────

test('answerOptions returns the option strings when present', () => {
  assert.deepEqual(
    answerOptions({ text: 'pick one', options: ['Yes', 'No', 'Maybe'] }),
    ['Yes', 'No', 'Maybe'],
  );
});

test('answerOptions returns [] when there are no options (no chips, NON-REGRESSION)', () => {
  assert.deepEqual(answerOptions({ text: 'free text only' }), []);
  assert.deepEqual(answerOptions({ text: 'q', options: [] }), []);
  assert.deepEqual(answerOptions(null), []);
  assert.deepEqual(answerOptions(undefined), []);
});

test('answerOptions drops non-string / empty options and never throws', () => {
  assert.deepEqual(
    answerOptions({ options: ['Yes', '', '   ', 3, null, 'No'] }),
    ['Yes', 'No'],
  );
  // A malformed (non-array) options payload degrades to no chips.
  assert.deepEqual(answerOptions({ options: 'nope' }), []);
  assert.deepEqual(answerOptions({ options: 42 }), []);
});

// ─── PHI guard: neither the question nor the answer touches the skeleton ──────

test('the persistent skeleton has NO pending_question / answer column (PHI stays in memory)', () => {
  const parsed = parseColumnNames(SKELETON_TABLE_SQL);
  for (const col of [...parsed, ...SKELETON_COLUMNS]) {
    const lc = col.toLowerCase();
    assert.ok(
      !lc.includes('question') && !lc.includes('answer'),
      `column "${col}" must not carry pending-question / answer text`,
    );
  }
});
