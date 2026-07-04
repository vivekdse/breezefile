// task-fd5b93809b1b — unit tests for the PURE New Home project-selection
// persistence helpers (src/components/newhome/selectedProjectPrefs.mjs). No
// Electron/localStorage; values are passed explicitly. Covers the bug this
// guards against: the "+ New Task" / edit-and-save path remounts NewHomePage
// (App.tsx swaps <TaskComposer/> in over the whole page, then swaps it back
// out), which used to reset selectedProjectId to null via plain useState —
// yanking the user back to "All projects" right after they created/edited a
// task. NewHomePage now seeds its state from loadSelectedProjectId() and
// mirrors every change to storage; these two pure helpers are what decide
// what a raw stored value normalizes to, and when a persisted pick has gone
// stale (project deleted/archived) and should fall back to "All projects".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStoredProjectId,
  isStaleProjectSelection,
} from '../src/components/newhome/selectedProjectPrefs.mjs';

test('normalizeStoredProjectId: a real id round-trips unchanged', () => {
  assert.equal(normalizeStoredProjectId('proj-123'), 'proj-123');
});

test('normalizeStoredProjectId: null/undefined/empty all mean "All projects"', () => {
  assert.equal(normalizeStoredProjectId(null), null);
  assert.equal(normalizeStoredProjectId(undefined), null);
  assert.equal(normalizeStoredProjectId(''), null);
});

const PROJECTS = [{ id: 'proj-a' }, { id: 'proj-b' }];

test('isStaleProjectSelection: null selection is never stale', () => {
  assert.equal(isStaleProjectSelection(null, PROJECTS), false);
  assert.equal(isStaleProjectSelection(undefined, PROJECTS), false);
});

test('isStaleProjectSelection: an id present in the loaded projects is not stale', () => {
  assert.equal(isStaleProjectSelection('proj-a', PROJECTS), false);
});

test('isStaleProjectSelection: an id absent from the loaded projects IS stale', () => {
  assert.equal(isStaleProjectSelection('proj-deleted', PROJECTS), true);
});

test('isStaleProjectSelection: an empty/unloaded project list is treated as "not yet loaded", never stale', () => {
  // This is the guard against the false-positive on first render: projects
  // hasn't been fetched yet (empty array), so a real persisted selection
  // must not be evicted before the registry has even loaded.
  assert.equal(isStaleProjectSelection('proj-a', []), false);
  assert.equal(isStaleProjectSelection('proj-a', null), false);
  assert.equal(isStaleProjectSelection('proj-a', undefined), false);
});
