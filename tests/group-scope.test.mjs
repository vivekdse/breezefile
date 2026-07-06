// task-group-scope-picker — unit tests for the PURE New Home group-scope
// predicate (src/components/newhome/groupScope.mjs). No React/Electron; tasks
// are plain objects. Covers the contract useNewHomeData relies on: "All groups"
// (null scope) is a no-op, a specific group narrows to exactly its tasks, and
// a task with no groupId can never belong to a specific group.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesGroup, filterByGroup } from '../src/components/newhome/groupScope.mjs';

const TASKS = [
  { id: 't1', groupId: 'group-a' },
  { id: 't2', groupId: 'group-b' },
  { id: 't3', groupId: 'group-a' },
  { id: 't4', groupId: null },
  { id: 't5' }, // groupId absent entirely
];

test('matchesGroup: a null/undefined/empty scope means "All groups" — everything matches', () => {
  assert.equal(matchesGroup({ groupId: 'group-a' }, null), true);
  assert.equal(matchesGroup({ groupId: 'group-a' }, undefined), true);
  assert.equal(matchesGroup({ groupId: 'group-a' }, ''), true);
  // Even a task with no group matches the unscoped case.
  assert.equal(matchesGroup({ groupId: null }, null), true);
  assert.equal(matchesGroup({}, null), true);
});

test('matchesGroup: a specific scope matches only tasks in that group', () => {
  assert.equal(matchesGroup({ groupId: 'group-a' }, 'group-a'), true);
  assert.equal(matchesGroup({ groupId: 'group-b' }, 'group-a'), false);
});

test('matchesGroup: a task with no groupId never belongs to a specific group', () => {
  assert.equal(matchesGroup({ groupId: null }, 'group-a'), false);
  assert.equal(matchesGroup({}, 'group-a'), false);
});

test('matchesGroup: a null/undefined task is safe (false) under a specific scope', () => {
  assert.equal(matchesGroup(null, 'group-a'), false);
  assert.equal(matchesGroup(undefined, 'group-a'), false);
});

test('filterByGroup: null scope returns the list unchanged (same reference)', () => {
  assert.equal(filterByGroup(TASKS, null), TASKS);
  assert.equal(filterByGroup(TASKS, undefined), TASKS);
  assert.equal(filterByGroup(TASKS, ''), TASKS);
});

test('filterByGroup: a specific scope keeps only that group’s tasks', () => {
  assert.deepEqual(
    filterByGroup(TASKS, 'group-a').map((t) => t.id),
    ['t1', 't3'],
  );
  assert.deepEqual(
    filterByGroup(TASKS, 'group-b').map((t) => t.id),
    ['t2'],
  );
});

test('filterByGroup: a scope with no matching tasks yields an empty list', () => {
  assert.deepEqual(filterByGroup(TASKS, 'group-zzz'), []);
});

test('filterByGroup: a non-array input degrades to an empty list', () => {
  assert.deepEqual(filterByGroup(null, 'group-a'), []);
  assert.deepEqual(filterByGroup(undefined, null), []);
});
