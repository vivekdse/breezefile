// task-a9841cfc0e1b — unit tests for the PURE New Home project-CRUD helpers
// (src/components/newhome/projectCrud.mjs). No Electron/IPC/network; values
// are passed explicitly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectDeleteDecision,
  validParentOptions,
  nextSelectionAfterArchive,
  nextSelectionAfterDelete,
} from '../src/components/newhome/projectCrud.mjs';

test('projectDeleteDecision: zero tasks -> can delete', () => {
  assert.deepEqual(projectDeleteDecision(0), { canDelete: true, reason: 'empty' });
});

test('projectDeleteDecision: any tasks -> must archive instead', () => {
  assert.deepEqual(projectDeleteDecision(1), { canDelete: false, reason: 'has_tasks' });
  assert.deepEqual(projectDeleteDecision(42), { canDelete: false, reason: 'has_tasks' });
});

test('projectDeleteDecision: negative/NaN/undefined treated as zero (empty)', () => {
  assert.equal(projectDeleteDecision(-1).canDelete, true);
  assert.equal(projectDeleteDecision(NaN).canDelete, true);
  assert.equal(projectDeleteDecision(undefined).canDelete, true);
});

const FLAT = [
  { id: 'a', parentProjectId: null },
  { id: 'b', parentProjectId: null },
  { id: 'c', parentProjectId: null },
];

test('validParentOptions: with no excludeId (creating new), every project is a candidate', () => {
  assert.deepEqual(validParentOptions(FLAT, null).sort(), ['a', 'b', 'c']);
  assert.deepEqual(validParentOptions(FLAT, undefined).sort(), ['a', 'b', 'c']);
});

test('validParentOptions: excludes self', () => {
  assert.deepEqual(validParentOptions(FLAT, 'a').sort(), ['b', 'c']);
});

test('validParentOptions: excludes descendants (prevents a cycle)', () => {
  // a -> b -> c (b's parent is a, c's parent is b)
  const chain = [
    { id: 'a', parentProjectId: null },
    { id: 'b', parentProjectId: 'a' },
    { id: 'c', parentProjectId: 'b' },
    { id: 'd', parentProjectId: null },
  ];
  // Editing 'a': b and c are descendants, must be excluded (else a cycle).
  assert.deepEqual(validParentOptions(chain, 'a').sort(), ['d']);
  // Editing 'b': only c (b's own descendant) is excluded; a and d are fine.
  assert.deepEqual(validParentOptions(chain, 'b').sort(), ['a', 'd']);
  // Editing 'c' (leaf, no descendants): a, b, d all valid.
  assert.deepEqual(validParentOptions(chain, 'c').sort(), ['a', 'b', 'd']);
});

test('validParentOptions: empty/missing project list degrades to []', () => {
  assert.deepEqual(validParentOptions([], 'a'), []);
  assert.deepEqual(validParentOptions(null, 'a'), []);
  assert.deepEqual(validParentOptions(undefined, 'a'), []);
});

test('nextSelectionAfterArchive: archiving the SELECTED project falls back to All projects (null)', () => {
  assert.equal(nextSelectionAfterArchive('proj-a', 'proj-a'), null);
});

test('nextSelectionAfterArchive: archiving a DIFFERENT project leaves the selection untouched', () => {
  assert.equal(nextSelectionAfterArchive('proj-a', 'proj-b'), 'proj-a');
});

test('nextSelectionAfterArchive: no selection stays null regardless', () => {
  assert.equal(nextSelectionAfterArchive(null, 'proj-a'), null);
});

test('nextSelectionAfterDelete: mirrors archive semantics', () => {
  assert.equal(nextSelectionAfterDelete('proj-a', 'proj-a'), null);
  assert.equal(nextSelectionAfterDelete('proj-a', 'proj-b'), 'proj-a');
  assert.equal(nextSelectionAfterDelete(null, 'proj-a'), null);
});
