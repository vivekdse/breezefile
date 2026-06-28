// task-80be320f06b3 — unit tests for the pure task-vitals helpers
// (time-in-status, last-activity, stalled detection). Imports the plain ESM
// module directly (Node has no TS loader) so `node --test tests/` runs green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastActivity,
  enteredCurrentStatusAt,
  timeInStatus,
  compactDuration,
  isStalled,
  statusDotHealth,
  lastActivitySummary,
  hasLiveClaim,
} from '../src/components/tasks/vitals.mjs';

const NOW = Date.parse('2026-06-28T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('compactDuration: minutes / hours / days, no "ago" suffix', () => {
  assert.equal(compactDuration(30 * 1000), 'just now');
  assert.equal(compactDuration(12 * MIN), '12m');
  assert.equal(compactDuration(HOUR + 30 * MIN), '1h 30m');
  assert.equal(compactDuration(2 * HOUR), '2h');
  assert.equal(compactDuration(6 * DAY), '6d');
  assert.equal(compactDuration(-1), '');
});

test('lastActivity: picks the NEWEST audit row (actor+action+time)', () => {
  const events = [
    { user: 'alice@x.com', action: 'create', at: ago(3 * HOUR) },
    { user: 'bob@x.com', action: 'release', at: ago(6 * DAY) }, // older
    { user: 'bob@x.com', action: 'start', at: ago(10 * MIN) }, // newest
  ];
  const la = lastActivity(events);
  assert.ok(la);
  assert.equal(la.action, 'start');
  assert.equal(la.actor, 'bob@x.com');
  assert.equal(la.ms, NOW - 10 * MIN);
});

test('lastActivity: empty / unparseable → null', () => {
  assert.equal(lastActivity([]), null);
  assert.equal(lastActivity(null), null);
  assert.equal(lastActivity([{ action: 'x', at: 'nope' }]), null);
});

test('enteredCurrentStatusAt: newest STATUS-lane event, NOT a claim/release', () => {
  const events = [
    { user: 'a@x.com', action: 'create', at: ago(6 * DAY) },
    { user: 'a@x.com', action: 'start', at: ago(6 * DAY - HOUR) }, // entered in_progress
    { user: 'a@x.com', action: 'claim', at: ago(5 * MIN) }, // newer but NOT status
  ];
  const e = enteredCurrentStatusAt(events, {});
  assert.ok(e);
  assert.equal(e.action, 'start');
  assert.equal(e.source, 'audit');
  assert.equal(e.ms, NOW - (6 * DAY - HOUR));
});

test('enteredCurrentStatusAt: falls back to createdAtIso when no status event', () => {
  const e = enteredCurrentStatusAt([{ user: 'a', action: 'claim', at: ago(MIN) }], {
    createdAtIso: ago(2 * DAY),
  });
  assert.ok(e);
  assert.equal(e.source, 'created');
  assert.equal(e.ms, NOW - 2 * DAY);
});

test('enteredCurrentStatusAt: nothing usable → null (no faking)', () => {
  assert.equal(enteredCurrentStatusAt([], {}), null);
  assert.equal(enteredCurrentStatusAt(null, {}), null);
});

test('timeInStatus: NEVER uses list updated_at — measures from entered ms', () => {
  const entered = NOW - 6 * DAY;
  const v = timeInStatus({ status: 'in_progress' }, entered, NOW);
  assert.equal(v.ms, 6 * DAY);
  assert.equal(v.label, 'In progress · 6d');
  assert.equal(v.since, '6d ago');
});

test('timeInStatus: unknown entry time → ok severity, no duration', () => {
  const v = timeInStatus({ status: 'in_progress' }, null, NOW);
  assert.equal(v.ms, null);
  assert.equal(v.severity, 'ok');
  assert.equal(v.label, 'In progress');
});

test('timeInStatus: in_progress past grace with NO live claim → warn→over', () => {
  // grace is 4h; 5h with no claim → warn
  const warn = timeInStatus({ status: 'in_progress' }, NOW - 5 * HOUR, NOW);
  assert.equal(warn.severity, 'warn');
  // 3x grace (>12h) → over (red)
  const over = timeInStatus({ status: 'in_progress' }, NOW - 13 * HOUR, NOW);
  assert.equal(over.severity, 'over');
});

test('timeInStatus: a LIVE claim excuses a long in_progress (no escalation)', () => {
  const v = timeInStatus(
    { status: 'in_progress', claimedBy: 'a@x.com', claimedAt: ago(5 * MIN) },
    NOW - 5 * HOUR,
    NOW,
  );
  assert.equal(v.severity, 'ok');
});

test('timeInStatus: terminal statuses never overstay', () => {
  const v = timeInStatus({ status: 'done' }, NOW - 99 * DAY, NOW);
  assert.equal(v.severity, 'ok');
});

test('hasLiveClaim: no claimer → false; lapsed → false; fresh → true', () => {
  assert.equal(hasLiveClaim({ claimedBy: null }, NOW), false);
  assert.equal(hasLiveClaim({ claimedBy: 'a', claimedAt: ago(5 * MIN) }, NOW), true);
  assert.equal(hasLiveClaim({ claimedBy: 'a', claimedAt: ago(3 * HOUR) }, NOW), false);
  // claimed but no timestamp → can't disprove → live
  assert.equal(hasLiveClaim({ claimedBy: 'a', claimedAt: null }, NOW), true);
});

test('isStalled: unclaimed in_progress past grace is stalled', () => {
  assert.equal(isStalled({ status: 'in_progress' }, NOW - 5 * HOUR, NOW), true);
});

test('isStalled: unclaimed in_progress with unknown entry time is stalled', () => {
  // started-then-abandoned, no audit/created — the core stranded case.
  assert.equal(isStalled({ status: 'in_progress', claimedBy: null }, null, NOW), true);
});

test('isStalled: a live claim is never stalled', () => {
  assert.equal(
    isStalled(
      { status: 'in_progress', claimedBy: 'a', claimedAt: ago(5 * MIN) },
      NOW - 9 * DAY,
      NOW,
    ),
    false,
  );
});

test('isStalled: a lapsed claim past grace IS stalled', () => {
  assert.equal(
    isStalled(
      { status: 'in_progress', claimedBy: 'a', claimedAt: ago(9 * DAY) },
      NOW - 9 * DAY,
      NOW,
    ),
    true,
  );
});

test('isStalled: non-in_progress is never stalled', () => {
  assert.equal(isStalled({ status: 'pending' }, NOW - 99 * DAY, NOW), false);
  assert.equal(isStalled({ status: 'done' }, NOW - 99 * DAY, NOW), false);
});

test('isStalled: within grace is not yet stalled', () => {
  assert.equal(isStalled({ status: 'in_progress' }, NOW - 2 * HOUR, NOW), false);
});

test('statusDotHealth: stalled outranks lapsed; healthy → null', () => {
  assert.equal(
    statusDotHealth({ status: 'in_progress', claimedBy: null }, NOW - 9 * DAY, NOW),
    'stalled',
  );
  // lapsed claim but not (yet) stalled by grace
  assert.equal(
    statusDotHealth(
      { status: 'pending', claimedBy: 'a', claimedAt: ago(3 * HOUR) },
      NOW - MIN,
      NOW,
    ),
    'lapsed',
  );
  assert.equal(
    statusDotHealth(
      { status: 'in_progress', claimedBy: 'a', claimedAt: ago(5 * MIN) },
      NOW - MIN,
      NOW,
    ),
    null,
  );
});

test('lastActivitySummary: "<age> — <verb> by <actor>"', () => {
  const la = lastActivity([{ user: 'vivek@x.com', action: 'release', at: ago(6 * DAY) }]);
  assert.equal(lastActivitySummary(la, NOW), '6d ago — released by vivek');
  assert.equal(lastActivitySummary(null, NOW), '');
});
