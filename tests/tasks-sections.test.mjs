// fm-7909 — unit tests for the pure partition/sort module. Imports the plain
// ESM module directly (Node 20 has no TS loader), so `node --test tests/`
// runs these green without a transpile step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partitionTasks,
  isDone,
  resolveBlockedBy,
  DONE_CAP,
} from '../src/components/tasks/sections.mjs';

function task(over = {}) {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    title: over.title ?? 't',
    notes: null,
    status: over.status ?? 'pending',
    folder: over.folder ?? '/tmp',
    start_at: over.start_at ?? null,
    due_at: over.due_at ?? null,
    pinned: over.pinned ?? false,
    cron: null,
    next_run_at: null,
    auto_mode: over.auto_mode ?? false,
    auto_agent: null,
    auto_prompt: null,
    created_at: over.created_at ?? 0,
    updated_at: 0,
    completed_at: over.completed_at ?? null,
    source: over.source,
    rawStatus: over.rawStatus,
    priority: over.priority,
    claimedBy: over.claimedBy,
    attempts: over.attempts,
    maxAttempts: over.maxAttempts,
    parentTaskId: over.parentTaskId,
    dependsOn: over.dependsOn,
    depsSatisfied: over.depsSatisfied,
    blockedBy: over.blockedBy,
  };
}

test('FOR YOU = manual local open tasks', () => {
  const t = task({ source: 'local', status: 'pending' });
  const { forYou, forAgents, done } = partitionTasks([t]);
  assert.equal(forYou.length, 1);
  assert.equal(forAgents.length, 0);
  assert.equal(done.length, 0);
});

test('undefined source counts as local (legacy rows)', () => {
  const t = task({ source: undefined, status: 'in_progress' });
  const { forYou } = partitionTasks([t]);
  assert.equal(forYou.length, 1);
});

test('FOR AGENTS = typebuild + local auto', () => {
  const tb = task({ source: 'typebuild', rawStatus: 'open' });
  const auto = task({ source: 'local', auto_mode: true, status: 'pending' });
  const { forAgents, forYou } = partitionTasks([tb, auto]);
  assert.equal(forAgents.length, 2);
  assert.equal(forYou.length, 0);
});

test('local auto-mode does NOT land in FOR YOU', () => {
  const auto = task({ source: 'local', auto_mode: true, status: 'pending' });
  const { forYou } = partitionTasks([auto]);
  assert.equal(forYou.length, 0);
});

test('DONE includes done/cancelled local + typebuild done|partial', () => {
  const a = task({ status: 'done' });
  const b = task({ status: 'cancelled' });
  const c = task({ source: 'typebuild', rawStatus: 'done', status: 'in_progress' });
  const d = task({ source: 'typebuild', rawStatus: 'partial', status: 'in_progress' });
  const { done, doneTotal } = partitionTasks([a, b, c, d]);
  assert.equal(doneTotal, 4);
  assert.equal(done.length, 4);
});

test('isDone treats typebuild done/partial as terminal', () => {
  assert.equal(isDone(task({ source: 'typebuild', rawStatus: 'done' })), true);
  assert.equal(isDone(task({ source: 'typebuild', rawStatus: 'partial' })), true);
  assert.equal(isDone(task({ source: 'typebuild', rawStatus: 'open' })), false);
});

// fm-alfz (S1) — cancelled is a real terminal server status now.
test('isDone treats typebuild cancelled as terminal', () => {
  assert.equal(
    isDone(task({ source: 'typebuild', rawStatus: 'cancelled', status: 'cancelled' })),
    true,
  );
});

test('a cancelled typebuild task lands in DONE, not FOR AGENTS', () => {
  const c = task({
    source: 'typebuild',
    rawStatus: 'cancelled',
    status: 'cancelled',
    completed_at: 5,
  });
  const { forAgents, done, doneTotal } = partitionTasks([c]);
  assert.equal(forAgents.length, 0);
  assert.equal(doneTotal, 1);
  assert.equal(done.length, 1);
});

test('FOR YOU sort: pinned first, then due asc nulls-last, then created desc', () => {
  const pinned = task({ id: 'p', pinned: true, due_at: '2030-01-01' });
  const dueSoon = task({ id: 'soon', due_at: '2020-01-01' });
  const dueLate = task({ id: 'late', due_at: '2020-12-31' });
  const noDue = task({ id: 'none', due_at: null, created_at: 100 });
  const noDueNewer = task({ id: 'none2', due_at: null, created_at: 200 });
  const { forYou } = partitionTasks([noDue, dueLate, pinned, dueSoon, noDueNewer]);
  assert.deepEqual(
    forYou.map((t) => t.id),
    ['p', 'soon', 'late', 'none2', 'none'],
  );
});

test('FOR AGENTS sort: running first, then claimed-by-me, then rawStatus, then priority', () => {
  const running = task({ id: 'run', source: 'typebuild', rawStatus: 'open' });
  const mine = task({ id: 'mine', source: 'typebuild', rawStatus: 'open', claimedBy: 'me@x' });
  const open = task({ id: 'open', source: 'typebuild', rawStatus: 'open' });
  const failed = task({ id: 'fail', source: 'typebuild', rawStatus: 'failed' });
  const blocked = task({ id: 'block', source: 'typebuild', rawStatus: 'blocked' });
  const { forAgents } = partitionTasks([blocked, failed, open, mine, running], {
    myEmail: 'me@x',
    runningTaskIds: new Set(['run']),
  });
  assert.deepEqual(
    forAgents.map((t) => t.id),
    ['run', 'mine', 'open', 'fail', 'block'],
  );
});

test('FOR AGENTS priority breaks ties within the same rawStatus', () => {
  const lo = task({ id: 'lo', source: 'typebuild', rawStatus: 'open', priority: 1 });
  const hi = task({ id: 'hi', source: 'typebuild', rawStatus: 'open', priority: 9 });
  const { forAgents } = partitionTasks([hi, lo]);
  assert.deepEqual(forAgents.map((t) => t.id), ['lo', 'hi']);
});

// ── fm-bq86 (S3) — parent/child grouping + dependency presentation ──────────

function tb(over = {}) {
  return task({ source: 'typebuild', rawStatus: over.rawStatus ?? 'open', ...over });
}

test('S3: children group under a visible parent, indented, parent first', () => {
  const parent = tb({ id: 'P', created_at: 100 });
  const c1 = tb({ id: 'c1', parentTaskId: 'P', created_at: 50 });
  const c2 = tb({ id: 'c2', parentTaskId: 'P', created_at: 60 });
  const other = tb({ id: 'O', created_at: 200 });
  const { forAgents, forAgentsRows } = partitionTasks([c1, other, parent, c2]);
  // Flat order: parent then its children grouped, contiguous.
  const ids = forAgentsRows.map((r) => r.task.id);
  const pIdx = ids.indexOf('P');
  assert.deepEqual(ids.slice(pIdx, pIdx + 3), ['P', 'c2', 'c1']); // created desc among siblings
  assert.deepEqual(forAgents, forAgentsRows.map((r) => r.task));
  // Depth annotations.
  const byId = new Map(forAgentsRows.map((r) => [r.task.id, r]));
  assert.equal(byId.get('P').depth, 0);
  assert.equal(byId.get('c1').depth, 1);
  assert.equal(byId.get('c2').depth, 1);
  assert.equal(byId.get('O').depth, 0);
});

test('S3: orphan child (parent not visible) renders as a top-level row', () => {
  const orphan = tb({ id: 'orph', parentTaskId: 'GONE' });
  const { forAgentsRows } = partitionTasks([orphan]);
  assert.equal(forAgentsRows.length, 1);
  assert.equal(forAgentsRows[0].depth, 0);
  assert.equal(forAgentsRows[0].task.id, 'orph');
});

test('S3: child whose parent is in DONE is an orphan top-level row', () => {
  const doneParent = tb({ id: 'P', rawStatus: 'done', status: 'in_progress' });
  const child = tb({ id: 'c1', parentTaskId: 'P' });
  const { forAgents, forAgentsRows, done } = partitionTasks([doneParent, child]);
  assert.equal(done.length, 1); // parent lives in DONE
  assert.equal(forAgents.length, 1);
  assert.equal(forAgentsRows[0].task.id, 'c1');
  assert.equal(forAgentsRows[0].depth, 0);
});

test('S3: parent progress counts (done vs total) + hasOpenChildren', () => {
  const parent = tb({ id: 'P' });
  const open1 = tb({ id: 'c1', parentTaskId: 'P' });
  const open2 = tb({ id: 'c2', parentTaskId: 'P' });
  const { forAgentsRows } = partitionTasks([parent, open1, open2]);
  const prow = forAgentsRows.find((r) => r.task.id === 'P');
  assert.equal(prow.childCount, 2);
  assert.equal(prow.doneChildCount, 0);
  assert.equal(prow.hasOpenChildren, true);
});

test('S3: progress counts include terminal children that moved to DONE', () => {
  // Done/cancelled children leave FOR AGENTS, but the parent's chip must
  // still count them — otherwise progress is stuck at 0/N and N shrinks as
  // children complete. Counts come from the FULL list; only the open child
  // renders indented.
  const parent = tb({ id: 'P' });
  const open1 = tb({ id: 'c1', parentTaskId: 'P' });
  const doneChild = tb({ id: 'c2', parentTaskId: 'P', status: 'done' });
  const cancelled = tb({ id: 'c3', parentTaskId: 'P', status: 'cancelled' });
  const { forAgentsRows, done } = partitionTasks([parent, open1, doneChild, cancelled]);
  assert.equal(done.length, 2);
  const prow = forAgentsRows.find((r) => r.task.id === 'P');
  assert.equal(prow.childCount, 3);
  assert.equal(prow.doneChildCount, 2);
  assert.equal(prow.hasOpenChildren, true);
  const indented = forAgentsRows.filter((r) => r.depth === 1);
  assert.deepEqual(indented.map((r) => r.task.id), ['c1']);
});

test('S3: parent with ALL children terminal keeps Start (no open children)', () => {
  const parent = tb({ id: 'P' });
  const doneChild = tb({ id: 'c1', parentTaskId: 'P', status: 'done' });
  const { forAgentsRows } = partitionTasks([parent, doneChild]);
  const prow = forAgentsRows.find((r) => r.task.id === 'P');
  assert.equal(prow.childCount, 1);
  assert.equal(prow.doneChildCount, 1);
  assert.equal(prow.hasOpenChildren, false);
});

test('S3: resolveBlockedBy maps ids to titles, drops unknowns, keeps order', () => {
  const a = task({ id: 'a', title: 'Alpha' });
  const b = task({ id: 'b', title: 'Beta' });
  assert.deepEqual(resolveBlockedBy(['b', 'a', 'zzz'], [a, b]), ['Beta', 'Alpha']);
  assert.deepEqual(resolveBlockedBy([], [a, b]), []);
  assert.deepEqual(resolveBlockedBy(undefined, [a, b]), []);
});

test('DONE sort: completed_at desc, capped at DONE_CAP', () => {
  const many = [];
  for (let i = 0; i < DONE_CAP + 10; i++) {
    many.push(task({ id: `d${i}`, status: 'done', completed_at: i }));
  }
  const { done, doneTotal } = partitionTasks(many);
  assert.equal(doneTotal, DONE_CAP + 10);
  assert.equal(done.length, DONE_CAP);
  // Newest completion first.
  assert.equal(done[0].completed_at, DONE_CAP + 9);
});
