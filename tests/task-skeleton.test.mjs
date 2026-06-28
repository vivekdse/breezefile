// task-b3fb2928bb3c (Phase 1) — tests for the PHI-FREE persistent task
// skeleton: (1) the schema literally CANNOT carry PHI (no title/body/notes/task
// column), and (2) the pure reconcile/diff converges (added/changed/removed,
// tombstones, and a removed id stops showing as live).
//
// NOTE: the better-sqlite3 store (task-skeleton-store.ts) is compiled against
// Electron's ABI and cannot load under the plain `node --test` runtime (it's
// TypeScript anyway). So these tests target the SHARED source of truth — the
// pure ESM schema/diff module the store imports — which is exactly what
// guarantees the no-PHI-columns property and the diff semantics the store relies
// on. The DB upsert/tombstone wiring is covered by typecheck + manual QA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKELETON_COLUMNS,
  PHI_FORBIDDEN_SUBSTRINGS,
  SKELETON_TABLE_SQL,
  PROJECT_TABLE_SQL,
  PROJECT_COLUMNS,
  parseColumnNames,
  isPhiColumn,
  routingSignature,
  diffSkeleton,
  diffIsEmpty,
} from '../electron/sources/task-skeleton-schema.mjs';

// ─── PHI-safety: the schema has NO PHI columns ─────────────────────────────

test('skeleton schema declares ONLY the documented non-PHI columns', () => {
  const parsed = parseColumnNames(SKELETON_TABLE_SQL);
  // The DDL and the allow-list must agree exactly (drift in either is a bug).
  assert.deepEqual(
    [...parsed].sort(),
    [...SKELETON_COLUMNS].sort(),
    'CREATE TABLE columns must equal SKELETON_COLUMNS',
  );
});

test('NO skeleton column carries PHI (title/body/notes/task)', () => {
  const parsed = parseColumnNames(SKELETON_TABLE_SQL);
  for (const col of parsed) {
    assert.equal(
      isPhiColumn(col),
      false,
      `column "${col}" must not be a PHI column`,
    );
  }
  // Belt-and-braces: the always-PHI substrings (title/body/notes) must appear
  // in NO column name, so a future rename like "task_title" is caught. ("task"
  // is allowed only inside an opaque *_id column — see isPhiColumn — so it's
  // covered by the isPhiColumn loop above, not this raw-substring check.)
  const ALWAYS_PHI = PHI_FORBIDDEN_SUBSTRINGS.filter((s) => s !== 'task');
  for (const bad of ALWAYS_PHI) {
    for (const col of parsed) {
      assert.ok(
        !col.toLowerCase().includes(bad),
        `column "${col}" contains forbidden PHI substring "${bad}"`,
      );
    }
  }
  // And no bare/`*_task`/`task_*` body column slipped in.
  for (const col of parsed) {
    assert.ok(
      !(col.toLowerCase() === 'task' || /(^|_)task(_|$)/.test(col.toLowerCase()) && !col.toLowerCase().endsWith('_id')),
      `column "${col}" looks like a task-body column`,
    );
  }
});

test('project skeleton schema is PHI-free too', () => {
  const parsed = parseColumnNames(PROJECT_TABLE_SQL);
  assert.deepEqual([...parsed].sort(), [...PROJECT_COLUMNS].sort());
  for (const col of parsed) {
    assert.equal(isPhiColumn(col), false, `project column "${col}" must be non-PHI`);
  }
});

test('isPhiColumn flags the forbidden substrings (guard sanity)', () => {
  assert.equal(isPhiColumn('title'), true);
  assert.equal(isPhiColumn('task_body'), true);
  assert.equal(isPhiColumn('notes'), true);
  assert.equal(isPhiColumn('encrypted_task'), true);
  assert.equal(isPhiColumn('status'), false);
  assert.equal(isPhiColumn('claimed_by'), false);
  assert.equal(isPhiColumn('project_id'), false);
});

// ─── Reconcile / diff convergence ──────────────────────────────────────────

const row = (id, over = {}) => ({
  id,
  status: 'pending',
  raw_status: 'open',
  claimed_by: null,
  assigned_to: null,
  attempts: 0,
  max_attempts: 3,
  priority: 0,
  due_at: null,
  defer_until: null,
  project_id: null,
  parent_task_id: null,
  ...over,
});

test('diffSkeleton: brand-new ids are added, none changed/removed', () => {
  const diff = diffSkeleton([], [row('a'), row('b')]);
  assert.deepEqual(diff.added.sort(), ['a', 'b']);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.removed, []);
  assert.equal(diffIsEmpty(diff), false);
});

test('diffSkeleton: identical sets produce an empty diff', () => {
  const prev = [row('a'), row('b')];
  const fresh = [row('a'), row('b')];
  const diff = diffSkeleton(prev, fresh);
  assert.deepEqual(diff, { added: [], changed: [], removed: [] });
  assert.equal(diffIsEmpty(diff), true);
});

test('diffSkeleton: a routing-field change marks the id changed', () => {
  const prev = [row('a', { status: 'pending', claimed_by: null })];
  const fresh = [row('a', { status: 'in_progress', claimed_by: 'me@x.com' })];
  const diff = diffSkeleton(prev, fresh);
  assert.deepEqual(diff.changed, ['a']);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
});

test('diffSkeleton: an id absent from fresh is removed (tombstone candidate)', () => {
  const prev = [row('a'), row('b')];
  const fresh = [row('a')];
  const diff = diffSkeleton(prev, fresh);
  assert.deepEqual(diff.removed, ['b']);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.changed, []);
});

test('routingSignature ignores non-routing noise but reflects routing fields', () => {
  const base = row('a');
  // Same routing → identical signature even if we pass extra junk.
  assert.equal(routingSignature({ ...base, junk: 1 }), routingSignature(base));
  // Different status → different signature.
  assert.notEqual(
    routingSignature(base),
    routingSignature(row('a', { status: 'done' })),
  );
});

// ─── Convergence model: apply the diff to a live set and prove a removed id
// stops showing as live (the tombstone semantics the store implements). ──────

// Reduce a live-set Map by a server poll: upsert fresh rows, drop (tombstone)
// removed ids. Mirrors task-skeleton-store.reconcile's live/tombstone effect.
function applyPoll(liveMap, fresh) {
  const diff = diffSkeleton([...liveMap.values()], fresh);
  const next = new Map();
  for (const r of fresh) next.set(r.id, r); // upsert = live
  // removed ids are simply absent from `next` (tombstoned → not live)
  return { live: next, diff };
}

test('reconcile model converges: add → change → remove, removed stops being live', () => {
  let live = new Map();

  // Poll 1: two new tasks.
  let r1 = applyPoll(live, [row('a'), row('b')]);
  live = r1.live;
  assert.deepEqual(r1.diff.added.sort(), ['a', 'b']);
  assert.ok(live.has('a') && live.has('b'));

  // Poll 2: 'a' progresses, 'c' appears.
  let r2 = applyPoll(live, [
    row('a', { status: 'in_progress' }),
    row('b'),
    row('c'),
  ]);
  live = r2.live;
  assert.deepEqual(r2.diff.added, ['c']);
  assert.deepEqual(r2.diff.changed, ['a']);
  assert.deepEqual(r2.diff.removed, []);

  // Poll 3: 'b' is gone from the server list → removed → no longer live.
  let r3 = applyPoll(live, [row('a', { status: 'in_progress' }), row('c')]);
  live = r3.live;
  assert.deepEqual(r3.diff.removed, ['b']);
  assert.equal(live.has('b'), false, 'removed id must stop showing as live');
  assert.ok(live.has('a') && live.has('c'));

  // Poll 4: nothing moves → empty diff.
  let r4 = applyPoll(live, [row('a', { status: 'in_progress' }), row('c')]);
  assert.equal(diffIsEmpty(r4.diff), true);
});

test('reconcile model: a re-appearing id is added again (untombstoned)', () => {
  let live = new Map([['a', row('a')]]);
  // 'a' drops out.
  let r1 = applyPoll(live, []);
  live = r1.live;
  assert.deepEqual(r1.diff.removed, ['a']);
  assert.equal(live.has('a'), false);
  // 'a' comes back → it's an add again (the store clears the tombstone).
  let r2 = applyPoll(live, [row('a')]);
  assert.deepEqual(r2.diff.added, ['a']);
  assert.ok(r2.live.has('a'));
});
