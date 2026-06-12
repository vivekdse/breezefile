// fm-7909 — unit tests for the pure partition/sort module. Imports the plain
// ESM module directly (Node 20 has no TS loader), so `node --test tests/`
// runs these green without a transpile step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partitionTasks,
  isDone,
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
