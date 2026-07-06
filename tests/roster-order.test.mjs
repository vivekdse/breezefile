// Unit tests for the pure roster ordering/recency/pagination module
// (src/components/newhome/rosterOrder.mjs). No React; runs under `node --test`.
// Mirrors tests/roster-groups.test.mjs conventions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recencyOf,
  sortByRecency,
  partitionByRecency,
  paginateGroupAware,
} from '../src/components/newhome/rosterOrder.mjs';

const DAY = 86_400_000;
const row = (id, status, lastActionAt, extra = {}) => ({ id, status, lastActionAt, ...extra });

// ── recencyOf ────────────────────────────────────────────────────────────────
test('recencyOf: reads lastActionAt, 0 when missing/invalid', () => {
  assert.equal(recencyOf({ lastActionAt: 123 }), 123);
  assert.equal(recencyOf({ lastActionAt: null }), 0);
  assert.equal(recencyOf({}), 0);
  assert.equal(recencyOf(null), 0);
});

// ── sortByRecency ────────────────────────────────────────────────────────────
test('sortByRecency: newest activity first', () => {
  const out = sortByRecency([
    row('a', 'done', 100),
    row('b', 'queued', 300),
    row('c', 'progress', 200),
  ]);
  assert.deepEqual(out.map((r) => r.id), ['b', 'c', 'a']);
});

test('sortByRecency: ties break by priority (higher first) then id', () => {
  const out = sortByRecency([
    row('a', 'queued', 100, { priority: 1 }),
    row('b', 'queued', 100, { priority: 5 }),
    row('c', 'queued', 100, { priority: 5 }),
  ]);
  // b and c both priority 5 (b<c by id), then a.
  assert.deepEqual(out.map((r) => r.id), ['b', 'c', 'a']);
});

test('sortByRecency: reads priority off raw.priority when not top-level', () => {
  const out = sortByRecency([
    row('a', 'queued', 100, { raw: { priority: 2 } }),
    row('b', 'queued', 100, { raw: { priority: 9 } }),
  ]);
  assert.deepEqual(out.map((r) => r.id), ['b', 'a']);
});

test('sortByRecency: does not mutate input; missing timestamps sort last', () => {
  const input = [row('a', 'queued', null), row('b', 'queued', 500)];
  const out = sortByRecency(input);
  assert.deepEqual(out.map((r) => r.id), ['b', 'a']);
  assert.deepEqual(input.map((r) => r.id), ['a', 'b']); // unmutated
});

test('sortByRecency: tolerates empty / non-array', () => {
  assert.deepEqual(sortByRecency([]), []);
  assert.deepEqual(sortByRecency(undefined), []);
});

// ── partitionByRecency ───────────────────────────────────────────────────────
test('partitionByRecency: old DONE tasks go cold; live work stays hot', () => {
  const now = 100 * DAY;
  const { hot, cold } = partitionByRecency(
    [
      row('recent-done', 'done', now - 2 * DAY),
      row('old-done', 'done', now - 30 * DAY),
      row('old-queued', 'queued', now - 30 * DAY), // live status → never cold
      row('old-progress', 'progress', now - 30 * DAY),
      row('old-needs', 'needs', now - 30 * DAY),
    ],
    { now, hotDays: 7 },
  );
  assert.deepEqual(cold.map((r) => r.id), ['old-done']);
  assert.deepEqual(
    hot.map((r) => r.id).sort(),
    ['old-needs', 'old-progress', 'old-queued', 'recent-done'],
  );
});

test('partitionByRecency: failed tasks never age out (only done ages)', () => {
  const now = 100 * DAY;
  const { hot, cold } = partitionByRecency(
    [row('old-failed', 'failed', now - 60 * DAY)],
    { now, hotDays: 7 },
  );
  assert.equal(cold.length, 0);
  assert.deepEqual(hot.map((r) => r.id), ['old-failed']);
});

test('partitionByRecency: a done task with no timestamp stays hot (cannot prove stale)', () => {
  const now = 100 * DAY;
  const { hot, cold } = partitionByRecency([row('done-nots', 'done', null)], { now, hotDays: 7 });
  assert.equal(cold.length, 0);
  assert.deepEqual(hot.map((r) => r.id), ['done-nots']);
});

test('partitionByRecency: cutoff boundary — exactly hotDays old is still hot', () => {
  const now = 100 * DAY;
  const exactly = now - 7 * DAY; // not strictly < cutoff
  const { cold } = partitionByRecency([row('edge', 'done', exactly)], { now, hotDays: 7 });
  assert.equal(cold.length, 0);
});

// ── paginateGroupAware ───────────────────────────────────────────────────────
const noGroups = () => null;

test('paginateGroupAware: limits ungrouped rows to N units', () => {
  const rows = [row('a', 'queued', 5), row('b', 'queued', 4), row('c', 'queued', 3)];
  const { page, shown, total, hasMore } = paginateGroupAware(rows, noGroups, { limit: 2 });
  assert.deepEqual(page.map((r) => r.id), ['a', 'b']);
  assert.equal(shown, 2);
  assert.equal(total, 3);
  assert.equal(hasMore, true);
});

test('paginateGroupAware: a group counts as ONE unit and never splits', () => {
  // g1 has two rows (a,c) interleaved with an ungrouped row b in sort order.
  const rows = [
    row('a', 'done', 9), // g1
    row('b', 'queued', 8), // ungrouped
    row('c', 'done', 7), // g1 (same group as a)
    row('d', 'queued', 6), // ungrouped
  ];
  const key = (r) => (r.id === 'a' || r.id === 'c' ? 'g1' : null);
  // limit 2 units: unit1 = g1 (admits a AND its later row c), unit2 = b. d dropped.
  const { page, shown, total, hasMore } = paginateGroupAware(rows, key, { limit: 2 });
  assert.deepEqual(page.map((r) => r.id), ['a', 'b', 'c']); // c kept with its group
  assert.equal(shown, 2);
  assert.equal(total, 3); // g1, b, d
  assert.equal(hasMore, true);
});

test('paginateGroupAware: limit >= total units returns everything, hasMore false', () => {
  const rows = [row('a', 'queued', 2), row('b', 'queued', 1)];
  const { page, shown, total, hasMore } = paginateGroupAware(rows, noGroups, { limit: 10 });
  assert.deepEqual(page.map((r) => r.id), ['a', 'b']);
  assert.equal(shown, 2);
  assert.equal(total, 2);
  assert.equal(hasMore, false);
});

test('paginateGroupAware: an already-admitted group later row is kept even past the unit limit', () => {
  const rows = [
    row('a', 'done', 9), // g1
    row('b', 'queued', 8), // ungrouped (unit 2)
    row('c', 'done', 1), // g1 again, sorts last
  ];
  const key = (r) => (r.id === 'a' || r.id === 'c' ? 'g1' : null);
  const { page } = paginateGroupAware(rows, key, { limit: 2 });
  // units: g1 (a), b → both admitted. c belongs to admitted g1 → kept.
  assert.deepEqual(page.map((r) => r.id), ['a', 'b', 'c']);
});

test('paginateGroupAware: tolerates empty / no-limit', () => {
  assert.deepEqual(paginateGroupAware([], noGroups, { limit: 5 }).page, []);
  const rows = [row('a', 'queued', 1)];
  // limit 0 falls back to "all"
  const r = paginateGroupAware(rows, noGroups, { limit: 0 });
  assert.deepEqual(r.page.map((x) => x.id), ['a']);
});
