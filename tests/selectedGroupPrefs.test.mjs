// task-group-scope-picker — unit tests for the PURE New Home group-scope
// persistence helpers (src/components/newhome/selectedGroupPrefs.mjs). No
// Electron/localStorage; values are passed explicitly. Mirrors
// selectedProjectPrefs.test.mjs — these two pure helpers decide what a raw
// stored value normalizes to, and when a persisted group scope has gone stale
// (its group no longer present in the current set) and should fall back to
// "All groups".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStoredGroupId,
  isStaleGroupSelection,
} from '../src/components/newhome/selectedGroupPrefs.mjs';

test('normalizeStoredGroupId: a real id round-trips unchanged', () => {
  assert.equal(normalizeStoredGroupId('group-123'), 'group-123');
});

test('normalizeStoredGroupId: null/undefined/empty all mean "All groups"', () => {
  assert.equal(normalizeStoredGroupId(null), null);
  assert.equal(normalizeStoredGroupId(undefined), null);
  assert.equal(normalizeStoredGroupId(''), null);
});

const GROUPS = [
  { id: 'group-a', count: 3 },
  { id: 'group-b', count: 1 },
];

test('isStaleGroupSelection: null selection is never stale', () => {
  assert.equal(isStaleGroupSelection(null, GROUPS), false);
  assert.equal(isStaleGroupSelection(undefined, GROUPS), false);
});

test('isStaleGroupSelection: an id present in the current groups is not stale', () => {
  assert.equal(isStaleGroupSelection('group-a', GROUPS), false);
});

test('isStaleGroupSelection: an id absent from the current groups IS stale', () => {
  assert.equal(isStaleGroupSelection('group-gone', GROUPS), true);
});

test('isStaleGroupSelection: an empty/unloaded groups list is "not yet loaded", never stale', () => {
  // Guard against a false-positive before the roster populates: an empty
  // groups list must not evict a real persisted selection.
  assert.equal(isStaleGroupSelection('group-a', []), false);
  assert.equal(isStaleGroupSelection('group-a', null), false);
  assert.equal(isStaleGroupSelection('group-a', undefined), false);
});
