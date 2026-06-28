// task-6255239581b2 — unit tests for the pure "needs my attention" model.
// Imports the plain ESM module directly (Node has no TS loader), so
// `node --test tests/projects-attention.test.mjs` runs green without transpile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectTree } from '../src/projects/tree.mjs';
import {
  computeProjectAttention,
  attentionSummary,
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
    attempts: over.attempts,
    maxAttempts: over.maxAttempts,
    projectId: over.projectId,
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
    task({ projectId: 'p', status: 'in_progress' }), // working → no attention
    task({ projectId: 'p', status: 'done' }), // terminal → none
    task({ projectId: 'p', status: 'pending', claimedBy: 'agent@x' }), // claimed → not open
  ];
  void today;
  const a = computeProjectAttention(roots, tasks, { now: NOW }).get('p');
  assert.equal(a.blocked, 1);
  assert.equal(a.overdue, 1);
  assert.equal(a.failed, 1);
  // open = pending, not blocked, not in_progress, unclaimed. The overdue one is
  // also open; the claimed one is not; blocked/failed excluded from "open".
  assert.equal(a.open, 2);
  // total = distinct attention rows (open, blocked, overdue, failed) = 4.
  assert.equal(a.total, 4);
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
  // does NOT count: in_progress, done, claimed-by-an-agent.
  assert.equal(needsAttention(task({ status: 'in_progress' }), today), false);
  assert.equal(needsAttention(task({ status: 'done' }), today), false);
  assert.equal(
    needsAttention(task({ status: 'pending', claimedBy: 'agent@x' }), today),
    false,
  );
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
