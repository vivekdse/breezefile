// task-6255239581b2 — unit tests for the pure "needs my attention" model.
// Imports the plain ESM module directly (Node has no TS loader), so
// `node --test tests/projects-attention.test.mjs` runs green without transpile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectTree } from '../src/projects/tree.mjs';
import {
  computeProjectAttention,
  attentionSummary,
  classify,
  todayKey,
  needsAttention,
} from '../src/projects/attention.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 25, 12, 0, 0); // fixed "now" for determinism

function proj(over = {}) {
  return {
    id: over.id,
    name: over.name ?? over.id,
    description: null,
    instructions: null,
    parentProjectId: over.parentProjectId ?? null,
    folders: [],
    createdBy: null,
    groupId: null,
    createdAt: null,
    updatedAt: null,
  };
}

function task(over = {}) {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    title: 't',
    notes: null,
    status: over.status ?? 'pending',
    folder: '/tmp',
    start_at: null,
    due_at: over.due_at ?? null,
    pinned: false,
    cron: null,
    next_run_at: null,
    auto_mode: false,
    auto_agent: null,
    auto_prompt: null,
    created_at: over.created_at ?? 0,
    updated_at: over.updated_at ?? 0,
    completed_at: null,
    rawStatus: over.rawStatus,
    claimedBy: over.claimedBy ?? null,
    claimedAt: over.claimedAt ?? null,
    attempts: over.attempts,
    maxAttempts: over.maxAttempts,
    projectId: over.projectId,
    // task-91d13f9d5469 — a pending question drives the `asked` bucket.
    pending_question: over.pending_question ?? null,
  };
}

test('classifies open / blocked / overdue / failed and counts each once-per-bucket', () => {
  const roots = buildProjectTree([proj({ id: 'p' })]);
  const today = todayKey(NOW);
  const yesterday = todayKey(NOW - DAY);
  const tasks = [
    task({ projectId: 'p', status: 'pending' }), // open
    task({ projectId: 'p', status: 'pending', rawStatus: 'blocked' }), // blocked
    task({ projectId: 'p', status: 'pending', due_at: yesterday }), // overdue (also open-ish, but blocked? no)
    task({ projectId: 'p', status: 'pending', attempts: 3, maxAttempts: 3 }), // failed (exhausted)
    task({ projectId: 'p', status: 'in_progress' }), // stalled (no live worker)
    task({ projectId: 'p', status: 'done' }), // terminal → none
    task({ projectId: 'p', status: 'pending', claimedBy: 'agent@x' }), // claimed → not open
  ];
  void today;
  const a = computeProjectAttention(roots, tasks, { now: NOW }).get('p');
  assert.equal(a.blocked, 1);
  assert.equal(a.overdue, 1);
  assert.equal(a.failed, 1);
  // task-80be320f06b3 — the bare in_progress row (no live claim) is now stalled.
  assert.equal(a.stalled, 1);
  // open = pending, not blocked, not in_progress, unclaimed. The overdue one is
  // also open; the claimed one is not; blocked/failed excluded from "open".
  assert.equal(a.open, 2);
  // total = distinct attention rows (open, blocked, overdue, failed, stalled) = 5.
  assert.equal(a.total, 5);
  assert.ok(a.score > 0);
});

test('rolls child attention up into ancestors', () => {
  const roots = buildProjectTree([
    proj({ id: 'parent' }),
    proj({ id: 'child', parentProjectId: 'parent' }),
  ]);
  const tasks = [task({ projectId: 'child', status: 'pending' })];
  const m = computeProjectAttention(roots, tasks, { now: NOW });
  assert.equal(m.get('child').open, 1);
  assert.equal(m.get('parent').open, 1); // rolled up
});

test('idle: no attention AND stale real activity → idle', () => {
  const roots = buildProjectTree([proj({ id: 'p' })]);
  const tasks = [
    task({
      projectId: 'p',
      status: 'done',
      created_at: NOW - 30 * DAY,
      updated_at: NOW - 30 * DAY,
    }),
  ];
  const a = computeProjectAttention(roots, tasks, {
    now: NOW,
    activityFloorMs: NOW - 1000, // the stale ts is below the floor → real
  }).get('p');
  assert.equal(a.total, 0);
  assert.equal(a.idle, true);
  assert.equal(a.lastActivityMs, NOW - 30 * DAY);
});

test('unknown activity (only placeholder timestamps) is NOT idle', () => {
  const roots = buildProjectTree([proj({ id: 'p' })]);
  // Both timestamps are placeholders stamped at/after the floor (mount time).
  const tasks = [
    task({ projectId: 'p', status: 'done', created_at: NOW, updated_at: NOW }),
  ];
  const a = computeProjectAttention(roots, tasks, {
    now: NOW,
    activityFloorMs: NOW - 1000, // floor below NOW → NOW is a placeholder
  }).get('p');
  assert.equal(a.total, 0);
  assert.equal(a.lastActivityMs, null); // unknown
  assert.equal(a.idle, false); // degrade: nothing important hides
});

test('recent (no attention, fresh real activity) is not idle', () => {
  const roots = buildProjectTree([proj({ id: 'p' })]);
  const tasks = [
    task({
      projectId: 'p',
      status: 'done',
      created_at: NOW - 2 * DAY,
      updated_at: NOW - 2 * DAY,
    }),
  ];
  const a = computeProjectAttention(roots, tasks, {
    now: NOW,
    activityFloorMs: NOW - 1000,
  }).get('p');
  assert.equal(a.idle, false);
});

// task-18902d433658 — the filter behind "N need you" must use the SAME
// predicate as the count, so the filtered list and the count can never disagree.
test('needsAttention matches each classify bucket (open/blocked/overdue/failed)', () => {
  const today = todayKey(NOW);
  const yesterday = todayKey(NOW - DAY);
  // counts: open, blocked, overdue, failed
  assert.equal(needsAttention(task({ status: 'pending' }), today), true); // open
  assert.equal(
    needsAttention(task({ status: 'pending', rawStatus: 'blocked' }), today),
    true,
  ); // blocked
  assert.equal(
    needsAttention(task({ status: 'pending', due_at: yesterday }), today),
    true,
  ); // overdue
  assert.equal(
    needsAttention(task({ status: 'pending', attempts: 3, maxAttempts: 3 }), today),
    true,
  ); // failed (exhausted)
  // task-80be320f06b3 — an in_progress row with NO live worker is now STALLED
  // and DOES count (this was the gap: a stranded task was invisible before).
  assert.equal(needsAttention(task({ status: 'in_progress' }), today), true);
  // does NOT count: done, claimed-by-an-agent (pending), and an in_progress row
  // whose claim is still LIVE (a worker is on it).
  assert.equal(needsAttention(task({ status: 'done' }), today), false);
  assert.equal(
    needsAttention(task({ status: 'pending', claimedBy: 'agent@x' }), today),
    false,
  );
  assert.equal(
    needsAttention(
      task({
        status: 'in_progress',
        claimedBy: 'agent@x',
        claimedAt: new Date(NOW - 5 * 60_000).toISOString(),
      }),
      today,
      NOW,
    ),
    false,
  );
});

// task-80be320f06b3 — STALLED: an in_progress row with no live worker. classify
// must surface it (the old classify never flagged in_progress, so a crashed/quit
// worker's task was invisible to attention). Count + filter both route through
// needsAttention/classify so they can never disagree.
test('classify: stalled in_progress (no live claim) counts; live-claimed does not', () => {
  const today = todayKey(NOW);
  const liveAt = new Date(NOW - 5 * 60_000).toISOString();
  const lapsedAt = new Date(NOW - 9 * 24 * 60 * 60 * 1000).toISOString();

  // unclaimed in_progress → stalled
  const c1 = classify(task({ status: 'in_progress', claimedBy: null }), today, NOW);
  assert.equal(c1.stalled, true);

  // in_progress with a LIVE claim → not stalled
  const c2 = classify(
    task({ status: 'in_progress', claimedBy: 'a@x', claimedAt: liveAt }),
    today,
    NOW,
  );
  assert.equal(c2.stalled, false);

  // in_progress with a long-LAPSED claim → stalled
  const c3 = classify(
    task({ status: 'in_progress', claimedBy: 'a@x', claimedAt: lapsedAt }),
    today,
    NOW,
  );
  assert.equal(c3.stalled, true);

  // pending is never stalled
  assert.equal(classify(task({ status: 'pending' }), today, NOW).stalled, false);
  // terminal is never stalled
  assert.equal(classify(task({ status: 'done' }), today, NOW).stalled, false);
});

test('computeProjectAttention tallies stalled into total + score + summary', () => {
  const roots = buildProjectTree([proj({ id: 'p' })]);
  const tasks = [
    task({ projectId: 'p', status: 'in_progress', claimedBy: null }), // stalled
    task({ projectId: 'p', status: 'pending' }), // open
  ];
  const a = computeProjectAttention(roots, tasks, { now: NOW }).get('p');
  assert.equal(a.stalled, 1);
  assert.equal(a.open, 1);
  assert.equal(a.total, 2);
  assert.ok(a.score >= 6); // stalled(5) + open(1)
  assert.match(attentionSummary(a), /1 stalled/);
});

test('needsAttention filter cardinality equals the project attention total', () => {
  const roots = buildProjectTree([proj({ id: 'p' })]);
  const today = todayKey(NOW);
  const yesterday = todayKey(NOW - DAY);
  const tasks = [
    task({ projectId: 'p', status: 'pending' }),
    task({ projectId: 'p', status: 'pending', rawStatus: 'blocked' }),
    task({ projectId: 'p', status: 'pending', due_at: yesterday }),
    task({ projectId: 'p', status: 'pending', attempts: 3, maxAttempts: 3 }),
    task({ projectId: 'p', status: 'in_progress' }),
    task({ projectId: 'p', status: 'done' }),
    task({ projectId: 'p', status: 'pending', claimedBy: 'agent@x' }),
  ];
  const total = computeProjectAttention(roots, tasks, { now: NOW }).get('p').total;
  const filtered = tasks.filter((t) => needsAttention(t, today)).length;
  assert.equal(filtered, total); // the list shows EXACTLY the counted tasks
});

test('attentionSummary lists only non-zero buckets in order', () => {
  assert.equal(
    attentionSummary({ open: 3, blocked: 1, overdue: 1, failed: 0 }),
    '3 open · 1 blocked · 1 overdue',
  );
  assert.equal(attentionSummary({ open: 0, blocked: 0, overdue: 0, failed: 0 }), '');
  assert.equal(attentionSummary({ open: 0, blocked: 0, overdue: 0, failed: 2 }), '2 failed');
});

// task-91d13f9d5469 — ASKED: a non-terminal task carrying a pending_question
// (ask_user) is a HUMAN-ONLY unblock. classify must surface it; needsAttention
// must count it; a terminal task's stale question must NOT count.
test('classify: a non-terminal task with a pending_question is asked; terminal is not', () => {
  const today = todayKey(NOW);
  const q = { text: 'Which patient?', options: ['A', 'B'] };

  const c1 = classify(task({ status: 'pending', pending_question: q }), today, NOW);
  assert.equal(c1.asked, true);

  // in_progress + a live claim would normally NOT be stalled, but a pending
  // question still makes it asked (the worker is blocked on the human).
  const c2 = classify(
    task({
      status: 'in_progress',
      claimedBy: 'a@x',
      claimedAt: new Date(NOW - 5 * 60_000).toISOString(),
      pending_question: q,
    }),
    today,
    NOW,
  );
  assert.equal(c2.asked, true);

  // no question → not asked
  assert.equal(classify(task({ status: 'pending' }), today, NOW).asked, false);
  // terminal task with a (stale) question → not asked
  assert.equal(
    classify(task({ status: 'done', pending_question: q }), today, NOW).asked,
    false,
  );
  assert.equal(
    classify(task({ status: 'cancelled', pending_question: q }), today, NOW).asked,
    false,
  );
});

test('needsAttention counts an asked task; a question-less task is unchanged', () => {
  const today = todayKey(NOW);
  assert.equal(
    needsAttention(
      task({ status: 'pending', pending_question: { text: '?' } }),
      today,
      NOW,
    ),
    true,
  );
  // NON-REGRESSION: a task with no pending_question is exactly as before.
  assert.equal(needsAttention(task({ status: 'pending', claimedBy: 'a@x' }), today, NOW), false);
});

test('asked outranks blocked: one asked task scores louder than one blocked', () => {
  const roots = buildProjectTree([proj({ id: 'asked' }), proj({ id: 'blocked' })]);
  const tasks = [
    // claimed so the pending-question task is asked-ONLY (a claimed pending row
    // is not also "open") — isolates W_ASKED from W_OPEN for the score compare.
    task({
      projectId: 'asked',
      status: 'pending',
      claimedBy: 'a@x',
      pending_question: { text: '?' },
    }),
    task({ projectId: 'blocked', status: 'pending', rawStatus: 'blocked' }),
  ];
  const m = computeProjectAttention(roots, tasks, { now: NOW });
  const asked = m.get('asked');
  const blocked = m.get('blocked');
  assert.equal(asked.asked, 1);
  assert.equal(blocked.blocked, 1);
  // W_ASKED (6) > W_BLOCKED (5): the asked project must rank strictly higher.
  assert.ok(asked.score > blocked.score);
  assert.equal(asked.score, 6);
  assert.equal(blocked.score, 5);
});

test('computeProjectAttention tallies asked into total + score + summary + rollup', () => {
  const roots = buildProjectTree([
    proj({ id: 'parent' }),
    proj({ id: 'child', parentProjectId: 'parent' }),
  ]);
  const tasks = [
    // claimed → asked-ONLY (not also open), so the two rows land in distinct
    // buckets and total is an unambiguous 2 (1 asked + 1 open).
    task({
      projectId: 'child',
      status: 'pending',
      claimedBy: 'a@x',
      pending_question: { text: '?' },
    }),
    task({ projectId: 'child', status: 'pending' }), // open
  ];
  const child = computeProjectAttention(roots, tasks, { now: NOW }).get('child');
  assert.equal(child.asked, 1);
  assert.equal(child.open, 1);
  assert.equal(child.total, 2);
  assert.ok(child.score >= 7); // asked(6) + open(1)
  assert.match(attentionSummary(child), /1 asked/);
  // rolls UP into the parent exactly like the other buckets.
  const parent = computeProjectAttention(roots, tasks, { now: NOW }).get('parent');
  assert.equal(parent.asked, 1);
  assert.equal(parent.total, 2);
});

test('asked filter cardinality equals the counted asked total (count/list in sync)', () => {
  const roots = buildProjectTree([proj({ id: 'p' })]);
  const tasks = [
    task({ projectId: 'p', status: 'pending', pending_question: { text: 'q1' } }),
    task({ projectId: 'p', status: 'in_progress', pending_question: { text: 'q2' } }),
    task({ projectId: 'p', status: 'done', pending_question: { text: 'moot' } }), // terminal → not asked
    task({ projectId: 'p', status: 'pending' }), // no question
  ];
  const askedTotal = computeProjectAttention(roots, tasks, { now: NOW }).get('p').asked;
  const filtered = tasks.filter((t) => classify(t, undefined, NOW).asked).length;
  assert.equal(filtered, askedTotal);
  assert.equal(askedTotal, 2);
});
