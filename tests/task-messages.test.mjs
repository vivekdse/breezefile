// task-da23979fd907 — unit tests for the pure task-messages module
// (src/components/tasks/taskMessages.mjs) plus a PHI guard against the skeleton.
//
// The React <TaskMessages> feed is a thin wrapper over normalizeTaskMessages +
// relativeMessageTime: it renders one card per normalized entry, in order, and
// renders NOTHING when there are no well-shaped messages and posting is
// unavailable. So testing the pure layer covers the render/format + the
// absent/empty/malformed fallback contract that guarantees NON-REGRESSION.
//
// The mapper in electron/sources/typebuild.ts (mapMessages) is TypeScript and
// applies the SAME defensive shape as normalizeTaskMessages (drop non-array,
// drop text-less entries, pass through in order, `undefined` when empty). We
// assert that contract here against the pure twin (the store's DB wiring is
// covered by typecheck + manual QA, like the result mapper's tests).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTaskMessages,
  hasTaskMessages,
  relativeMessageTime,
} from '../src/components/tasks/taskMessages.mjs';
import {
  SKELETON_COLUMNS,
  SKELETON_TABLE_SQL,
  parseColumnNames,
} from '../electron/sources/task-skeleton-schema.mjs';

// ─── normalizeTaskMessages: pass-through in order, defensive fallback ─────────

test('normalizeTaskMessages passes well-shaped messages through IN ORDER', () => {
  const wire = [
    { text: 'first', by: 'a@x.com', at: '2026-06-28T10:00:00Z' },
    { text: 'second', by: 'b@x.com', at: '2026-06-28T11:00:00Z' },
    { text: 'third', by: 'a@x.com', at: '2026-06-28T12:00:00Z' },
  ];
  const out = normalizeTaskMessages(wire);
  // Order is PRESERVED (newest-last), nothing re-sorted.
  assert.deepEqual(
    out.map((m) => m.text),
    ['first', 'second', 'third'],
  );
  assert.deepEqual(out[0], { text: 'first', by: 'a@x.com', at: '2026-06-28T10:00:00Z' });
});

test('normalizeTaskMessages returns [] for absent/empty/malformed input', () => {
  // Absent → nothing (a message-less task renders exactly as today).
  assert.deepEqual(normalizeTaskMessages(undefined), []);
  assert.deepEqual(normalizeTaskMessages(null), []);
  assert.deepEqual(normalizeTaskMessages([]), []);
  // Not an array → [], never throws.
  assert.deepEqual(normalizeTaskMessages('nope'), []);
  assert.deepEqual(normalizeTaskMessages(42), []);
  assert.deepEqual(normalizeTaskMessages({ text: 'x' }), []);
});

test('normalizeTaskMessages drops entries with no usable text (never throws)', () => {
  const out = normalizeTaskMessages([
    { text: 'keep', by: 'a@x.com', at: '2026-06-28T10:00:00Z' },
    { by: 'b@x.com', at: '2026-06-28T11:00:00Z' }, // no text → dropped
    { text: '', by: 'c@x.com', at: '2026-06-28T12:00:00Z' }, // empty text → dropped
    { text: 123 }, // non-string text → dropped
    null, // non-object → skipped
    'garbage', // non-object → skipped
    { text: 'also-keep', by: 'd@x.com', at: '2026-06-28T13:00:00Z' },
  ]);
  assert.deepEqual(out.map((m) => m.text), ['keep', 'also-keep']);
});

test('normalizeTaskMessages degrades missing by/at to empty strings', () => {
  const out = normalizeTaskMessages([{ text: 'only text' }]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { text: 'only text', by: '', at: '' });
});

test('hasTaskMessages gates on at least one well-shaped entry', () => {
  assert.equal(hasTaskMessages(undefined), false);
  assert.equal(hasTaskMessages([]), false);
  assert.equal(hasTaskMessages([{ by: 'a@x.com' }]), false); // no text
  assert.equal(hasTaskMessages([{ text: 'hi' }]), true);
});

// ─── relativeMessageTime: compact relative age, blank on unparseable ──────────

test('relativeMessageTime formats a compact relative age', () => {
  const now = Date.parse('2026-06-28T12:00:00Z');
  assert.equal(relativeMessageTime('2026-06-28T11:59:30Z', now), 'just now');
  assert.equal(relativeMessageTime('2026-06-28T11:55:00Z', now), '5m ago');
  assert.equal(relativeMessageTime('2026-06-28T09:00:00Z', now), '3h ago');
  assert.equal(relativeMessageTime('2026-06-26T12:00:00Z', now), '2d ago');
});

test('relativeMessageTime returns "" for absent/unparseable at', () => {
  assert.equal(relativeMessageTime(undefined), '');
  assert.equal(relativeMessageTime(null), '');
  assert.equal(relativeMessageTime(''), '');
  assert.equal(relativeMessageTime('not-a-date'), '');
});

test('relativeMessageTime treats a small future skew as "just now"', () => {
  const now = Date.parse('2026-06-28T12:00:00Z');
  // A timestamp slightly ahead of `now` (clock skew) must not read as a negative
  // age — it degrades to "just now".
  assert.equal(relativeMessageTime('2026-06-28T12:00:10Z', now), 'just now');
});

// ─── PHI guard: `messages` is NEVER a skeleton column ─────────────────────────

test('the persistent skeleton has NO messages column (PHI stays in memory)', () => {
  const parsed = parseColumnNames(SKELETON_TABLE_SQL);
  assert.ok(
    !parsed.includes('messages'),
    'skeleton table must not carry a messages column',
  );
  assert.ok(
    !SKELETON_COLUMNS.includes('messages'),
    'SKELETON_COLUMNS must not list messages',
  );
  // Nothing message-shaped anywhere in the column set.
  for (const col of parsed) {
    assert.ok(
      !col.toLowerCase().includes('message'),
      `column "${col}" must not carry message text`,
    );
  }
});
