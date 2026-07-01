// task-19ba9f7f43f1 — unit tests for the pure task-result module
// (src/components/tasks/taskResult.mjs). No React; runs under `node --test`.
//
// The React dispatcher (<TaskResultView>) is a thin wrapper over these pure
// helpers: it renders the `table` renderer only when resultRendererKind() is
// truthy and normalizeTablePayload() succeeds, else returns null → the host
// falls back to today's notes view. So testing the pure layer covers the
// dispatch + fallback contract that guarantees NON-REGRESSION.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWN_RESULT_TYPES,
  resultRendererKind,
  coerceCell,
  normalizeTablePayload,
} from '../src/components/tasks/taskResult.mjs';

// ── resultRendererKind: the type→renderer dispatch key + fallback gate ───────
test('resultRendererKind returns the type for a known, well-shaped result', () => {
  assert.equal(
    resultRendererKind({ type: 'table', payload: { headers: [], rows: [] } }),
    'table',
  );
});

test('resultRendererKind falls back (null) for missing/unknown/malformed', () => {
  // Missing result → fall back (no regression for tasks that don't opt in).
  assert.equal(resultRendererKind(undefined), null);
  assert.equal(resultRendererKind(null), null);
  // Unknown type → fall back to notes.
  assert.equal(resultRendererKind({ type: 'chart', payload: {} }), null);
  // Malformed shapes → fall back, never throw.
  assert.equal(resultRendererKind({}), null);
  assert.equal(resultRendererKind({ type: '' }), null);
  assert.equal(resultRendererKind({ type: 123 }), null);
  assert.equal(resultRendererKind('table'), null);
  assert.equal(resultRendererKind(42), null);
});

test('table is a known result type', () => {
  assert.ok(KNOWN_RESULT_TYPES.includes('table'));
});

// ── coerceCell: safe stringification of any cell value ───────────────────────
test('coerceCell coerces numbers, booleans, and null/undefined safely', () => {
  assert.equal(coerceCell('hi'), 'hi');
  assert.equal(coerceCell(0), '0');
  assert.equal(coerceCell(42), '42');
  assert.equal(coerceCell(3.14), '3.14');
  assert.equal(coerceCell(true), 'true');
  assert.equal(coerceCell(false), 'false');
  // null/undefined → blank cell (NOT the literal word "null").
  assert.equal(coerceCell(null), '');
  assert.equal(coerceCell(undefined), '');
  // Non-finite numbers → blank rather than "NaN"/"Infinity".
  assert.equal(coerceCell(NaN), '');
  assert.equal(coerceCell(Infinity), '');
  // Objects/arrays → best-effort JSON (never throws).
  assert.equal(coerceCell({ a: 1 }), '{"a":1}');
  assert.equal(coerceCell([1, 2]), '[1,2]');
});

test('coerceCell does not throw on a circular object', () => {
  const o = {};
  o.self = o;
  assert.doesNotThrow(() => coerceCell(o));
  assert.equal(typeof coerceCell(o), 'string');
});

// ── normalizeTablePayload: renders headers + rows; degrades gracefully ───────
test('normalizeTablePayload produces string headers + rows', () => {
  const t = normalizeTablePayload({
    headers: ['Name', 'Age', 'Active'],
    rows: [
      ['Ada', 36, true],
      ['Bo', null, false],
    ],
  });
  assert.ok(t);
  assert.deepEqual(t.headers, ['Name', 'Age', 'Active']);
  assert.equal(t.width, 3);
  // Cells are coerced to strings (number, null, boolean handled).
  assert.deepEqual(t.rows[0], ['Ada', '36', 'true']);
  assert.deepEqual(t.rows[1], ['Bo', '', 'false']);
});

test('normalizeTablePayload pads short rows to the header width', () => {
  const t = normalizeTablePayload({
    headers: ['A', 'B', 'C'],
    rows: [['x'], ['y', 'z']],
  });
  assert.ok(t);
  assert.equal(t.width, 3);
  assert.deepEqual(t.rows[0], ['x', '', '']);
  assert.deepEqual(t.rows[1], ['y', 'z', '']);
});

test('normalizeTablePayload widens to the widest row when headers are short', () => {
  const t = normalizeTablePayload({
    headers: ['A'],
    rows: [['x', 'y', 'z']],
  });
  assert.ok(t);
  assert.equal(t.width, 3);
  assert.deepEqual(t.rows[0], ['x', 'y', 'z']);
});

test('normalizeTablePayload coerces non-string headers', () => {
  const t = normalizeTablePayload({ headers: [1, 2], rows: [] });
  assert.ok(t);
  assert.deepEqual(t.headers, ['1', '2']);
});

test('normalizeTablePayload falls back (null) for empty/malformed payloads', () => {
  // A malformed/empty payload degrades gracefully → null → host falls back.
  assert.equal(normalizeTablePayload(null), null);
  assert.equal(normalizeTablePayload(undefined), null);
  assert.equal(normalizeTablePayload('nope'), null);
  assert.equal(normalizeTablePayload(42), null);
  assert.equal(normalizeTablePayload({}), null);
  assert.equal(normalizeTablePayload({ headers: [], rows: [] }), null);
  assert.equal(normalizeTablePayload({ headers: 'no', rows: 'no' }), null);
});

test('normalizeTablePayload drops non-array rows without throwing', () => {
  const t = normalizeTablePayload({
    headers: ['A', 'B'],
    rows: [['x', 'y'], 'garbage', null, ['z']],
  });
  assert.ok(t);
  // Only the two array rows survive; the short one is padded.
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[0], ['x', 'y']);
  assert.deepEqual(t.rows[1], ['z', '']);
});
