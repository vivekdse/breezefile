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
  META_TABLE_SQL,
  META_COLUMNS,
  SYNC_CURSOR_KEY,
  parseColumnNames,
  isPhiColumn,
  routingSignature,
  diffSkeleton,
  diffIsEmpty,
  deltaSkeleton,
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

// ─── Phase 2 (task-b1fe80e2669b): sync-meta schema is PHI-free ──────────────

test('sync_meta schema declares ONLY the documented non-PHI columns', () => {
  const parsed = parseColumnNames(META_TABLE_SQL);
  assert.deepEqual(
    [...parsed].sort(),
    [...META_COLUMNS].sort(),
    'sync_meta CREATE TABLE columns must equal META_COLUMNS',
  );
});

test('NO sync_meta column carries PHI (cursor is a timestamp)', () => {
  const parsed = parseColumnNames(META_TABLE_SQL);
  for (const col of parsed) {
    assert.equal(isPhiColumn(col), false, `meta column "${col}" must be non-PHI`);
  }
  // The cursor KEY is a fixed, content-free string (not patient text).
  assert.equal(SYNC_CURSOR_KEY, 'sync_cursor');
});

// ─── Phase 2: deltaSkeleton — changed-only + EXPLICIT tombstones, no inference ─

test('deltaSkeleton: a changed row not previously live is added', () => {
  const prev = [row('a')];
  const diff = deltaSkeleton(prev, [row('b', { status: 'in_progress' })], []);
  assert.deepEqual(diff.added, ['b']);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.removed, []);
});

test('deltaSkeleton: a changed row that was live + moved routing is changed', () => {
  const prev = [row('a', { status: 'pending' })];
  const diff = deltaSkeleton(prev, [row('a', { status: 'in_progress' })], []);
  assert.deepEqual(diff.changed, ['a']);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
});

test('deltaSkeleton: absence does NOT infer removal (unlike the full diff)', () => {
  // 'b' is live but NOT in the changed set and NOT tombstoned → it stays. This
  // is the core delta invariant: only explicit tombstones remove.
  const prev = [row('a'), row('b')];
  const diff = deltaSkeleton(prev, [row('a', { status: 'done' })], []);
  assert.deepEqual(diff.removed, [], 'b must NOT be removed by absence');
  assert.deepEqual(diff.changed, ['a']);
});

test('deltaSkeleton: an explicit tombstone removes a live id', () => {
  const prev = [row('a'), row('b')];
  const diff = deltaSkeleton(prev, [], ['b']);
  assert.deepEqual(diff.removed, ['b']);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.changed, []);
});

test('deltaSkeleton: a tombstone for an unknown id is a no-op (not a phantom)', () => {
  const prev = [row('a')];
  const diff = deltaSkeleton(prev, [], ['zzz-never-seen']);
  assert.deepEqual(diff.removed, []);
});

test('deltaSkeleton: a changed row with no routing move is neither add nor change', () => {
  // e.g. a title-only rename: title is not a routing field, so the signature is
  // unchanged → no structured add/change (the poll re-broadcasts to refresh the
  // memory-only title separately).
  const prev = [row('a')];
  const diff = deltaSkeleton(prev, [row('a')], []);
  assert.deepEqual(diff, { added: [], changed: [], removed: [] });
  assert.equal(diffIsEmpty(diff), true);
});

// ─── Phase 2: delta-apply convergence model (cache + tombstone) ─────────────
// Mirror reconcileDelta's effect on the live set: upsert changed rows, DELETE
// the tombstoned ids (NOT inference). Prove a tombstone removes the id and that
// the unchanged majority is untouched.
function applyDeltaModel(liveMap, changedFresh, tombstoneIds) {
  const diff = deltaSkeleton([...liveMap.values()], changedFresh, tombstoneIds);
  const next = new Map(liveMap); // start from the FULL live set (delta-preserve)
  for (const r of changedFresh) next.set(r.id, r); // upsert changed
  for (const id of tombstoneIds) next.delete(id); // explicit delete
  return { live: next, diff };
}

test('delta-apply converges: untouched rows persist, tombstone deletes id', () => {
  // Seed (full) with three rows.
  let live = new Map([
    ['a', row('a')],
    ['b', row('b')],
    ['c', row('c')],
  ]);

  // Delta 1: only 'a' changed; 'b'/'c' not in the payload → they MUST stay.
  let d1 = applyDeltaModel(live, [row('a', { status: 'in_progress' })], []);
  live = d1.live;
  assert.deepEqual(d1.diff.changed, ['a']);
  assert.ok(live.has('a') && live.has('b') && live.has('c'),
    'unchanged rows survive a delta that omits them');

  // Delta 2: 'b' deleted server-side (tombstone), 'd' newly created.
  let d2 = applyDeltaModel(live, [row('d')], ['b']);
  live = d2.live;
  assert.deepEqual(d2.diff.added, ['d']);
  assert.deepEqual(d2.diff.removed, ['b']);
  assert.equal(live.has('b'), false, 'tombstoned id is deleted, not inferred');
  assert.ok(live.has('a') && live.has('c') && live.has('d'));

  // Delta 3: empty (no changes, no tombstones) → empty diff, set unchanged.
  let d3 = applyDeltaModel(live, [], []);
  assert.equal(diffIsEmpty(d3.diff), true);
  assert.equal(d3.live.size, live.size);
});

// ─── Phase 2: full-reconcile safety net converges on a missed tombstone ─────
// If a delta tombstone was ever missed, the live set carries a stale id. The
// periodic FULL pull (absence-based) drops it. Prove the full path recovers.
test('full-reconcile safety net drops an id a delta never tombstoned', () => {
  // Live set still carries 'ghost' (a delete whose tombstone we missed).
  let live = new Map([
    ['a', row('a')],
    ['ghost', row('ghost')],
  ]);
  // A FULL pull returns the true live set (no 'ghost'). Absence → removed.
  const r = applyPoll(live, [row('a')]);
  live = r.live;
  assert.deepEqual(r.diff.removed, ['ghost'], 'full pull converges on server truth');
  assert.equal(live.has('ghost'), false);
  assert.ok(live.has('a'));
});

// ─── Phase 2: cursor round-trip semantics (pure model) ─────────────────────
// The store persists server_time as the next updated_since. Model the
// advance-only-on-success rule: a failed/empty delta keeps the OLD cursor; a
// successful one advances it. (The DB read/write is covered by typecheck +
// manual QA; this asserts the contract the poll loop relies on.)
test('cursor advances only when server_time is present and non-empty', () => {
  // maybeAdvanceCursor's rule, modeled purely.
  const advance = (cur, serverTime) =>
    typeof serverTime === 'string' && serverTime !== '' ? serverTime : cur;

  let cursor = '2026-06-28T00:00:00Z';
  // A delta with a fresh server_time advances.
  cursor = advance(cursor, '2026-06-28T00:05:00Z');
  assert.equal(cursor, '2026-06-28T00:05:00Z');
  // A response missing server_time keeps the old cursor (defensive: next poll
  // replays the window rather than skipping it).
  cursor = advance(cursor, undefined);
  assert.equal(cursor, '2026-06-28T00:05:00Z');
  // An empty string is treated as missing.
  cursor = advance(cursor, '');
  assert.equal(cursor, '2026-06-28T00:05:00Z');
});
