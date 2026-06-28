// task-b8306d2b85c2 — unit tests for the pure lifecycle/timeline helpers.
// Imports the plain ESM module directly (Node has no TS loader), so
// `node --test tests/` runs green without a transpile step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_TTL_MS,
  relAge,
  claimFreshness,
  claimSummary,
  shortActor,
  buildTimeline,
} from '../src/components/tasks/lifecycle.mjs';

const NOW = Date.parse('2026-06-28T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

test('relAge formats coarse relative ages', () => {
  assert.equal(relAge(10_000), 'just now');
  assert.equal(relAge(12 * MIN), '12m ago');
  assert.equal(relAge(HOUR + 50 * MIN), '1h 50m ago');
  assert.equal(relAge(2 * HOUR), '2h ago');
  assert.equal(relAge(3 * 24 * HOUR), '3d ago');
  assert.equal(relAge(NaN), '');
});

test('claimFreshness: fresh claim is not near-expiry', () => {
  const f = claimFreshness(ago(12 * MIN), NOW);
  assert.ok(f);
  assert.equal(f.relative, '12m ago');
  assert.equal(f.expiresSoon, false);
  assert.equal(f.expired, false);
});

test('claimFreshness: a claim inside the last 20m of the 2h TTL is near-expiry', () => {
  // 1h50m old → 10m of TTL left → expiresSoon.
  const f = claimFreshness(ago(HOUR + 50 * MIN), NOW);
  assert.ok(f);
  assert.equal(f.expiresSoon, true);
  assert.equal(f.expired, false);
});

test('claimFreshness: past the TTL is expired', () => {
  const f = claimFreshness(ago(CLAIM_TTL_MS + MIN), NOW);
  assert.ok(f);
  assert.equal(f.expired, true);
  assert.equal(f.expiresSoon, false);
});

test('claimFreshness: nullish / unparseable → null (no faking)', () => {
  assert.equal(claimFreshness(null, NOW), null);
  assert.equal(claimFreshness('', NOW), null);
  assert.equal(claimFreshness('not-a-date', NOW), null);
});

test('claimFreshness: accepts epoch ms and seconds', () => {
  assert.ok(claimFreshness(NOW - 5 * MIN, NOW));
});

test('claimSummary: who + age + near-expiry tail', () => {
  assert.equal(
    claimSummary('me@x.com', true, ago(12 * MIN), NOW),
    'claimed by you 12m ago',
  );
  assert.equal(
    claimSummary('alice@x.com', false, ago(HOUR + 50 * MIN), NOW),
    'claimed by alice@x.com 1h 50m ago (claim expires soon)',
  );
  // No timestamp → degrade gracefully to bare ownership (list rows).
  assert.equal(
    claimSummary('alice@x.com', false, null, NOW),
    'claimed by alice@x.com',
  );
});

test('shortActor: email local-part, else raw principal', () => {
  assert.equal(shortActor('alice@example.com'), 'alice');
  assert.equal(shortActor('uid-123'), 'uid-123');
  assert.equal(shortActor(''), 'unknown');
});

test('buildTimeline: folds audit oldest→newest, classifies lanes', () => {
  // Audit arrives newest-first; the fold should sort ascending.
  const events = [
    { user: 'bob@x.com', action: 'done', detail: '', at: ago(1 * MIN) },
    { user: 'bob@x.com', action: 'claim', detail: '', at: ago(30 * MIN) },
    { user: 'alice@x.com', action: 'create', detail: '', at: ago(2 * HOUR) },
  ];
  const tl = buildTimeline(events, {});
  assert.equal(tl.length, 3);
  assert.deepEqual(
    tl.map((e) => e.kind),
    ['created', 'claimed', 'status'],
  );
  assert.equal(tl[0].label, 'Created');
  assert.equal(tl[0].actor, 'alice@x.com');
  assert.equal(tl[2].label, 'Completed');
});

test('buildTimeline: synthesizes Created from task fields when audit lacks it', () => {
  const tl = buildTimeline([], {
    createdAtIso: ago(3 * HOUR),
    createdBy: 'alice@x.com',
  });
  assert.equal(tl.length, 1);
  assert.equal(tl[0].kind, 'created');
  assert.equal(tl[0].actor, 'alice@x.com');
});

test('buildTimeline: synthesizes current claim when audit lacks a claim event', () => {
  const tl = buildTimeline(
    [{ user: 'alice@x.com', action: 'create', detail: '', at: ago(3 * HOUR) }],
    { claimedAt: ago(10 * MIN), claimedBy: 'bob@x.com' },
  );
  const claim = tl.find((e) => e.kind === 'claimed');
  assert.ok(claim);
  assert.equal(claim.actor, 'bob@x.com');
});

test('buildTimeline: unknown action verbs fall back to Title Case, not dropped', () => {
  const tl = buildTimeline(
    [{ user: 'x@y.com', action: 'note_added', detail: '', at: ago(MIN) }],
    {},
  );
  assert.equal(tl.length, 1);
  assert.equal(tl[0].label, 'Note Added');
});

test('buildTimeline: empty input → empty timeline', () => {
  assert.deepEqual(buildTimeline(null, {}), []);
  assert.deepEqual(buildTimeline([], {}), []);
});
