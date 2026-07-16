// task-c82d8e0f4eae — unit tests for the subproject aggregation seam:
//   • descendantProjectIds (src/projects/tree.mjs) — the subtree id set a
//     parent project's roster aggregates over.
//   • buildSubprojectSections (src/components/newhome/subprojectSections.mjs) —
//     partitioning that subtree roster into own tasks + navigable sections.
// Plain ESM so `node --test tests/subproject-sections.test.mjs` runs green with
// no transpile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectTree, descendantProjectIds } from '../src/projects/tree.mjs';
import { buildSubprojectSections } from '../src/components/newhome/subprojectSections.mjs';

function proj(id, parentProjectId = null, name = id) {
  return { id, name, parentProjectId, description: null, instructions: null, folders: [] };
}

// guruandai
//   ├── engine
//   │     └── engine-deep
//   ├── content
//   └── qa
const PROJECTS = [
  proj('guruandai', null, 'guruandai'),
  proj('engine', 'guruandai', 'Agent Engine'),
  proj('engine-deep', 'engine', 'Engine Deep'),
  proj('content', 'guruandai', 'Content & Rebrand'),
  proj('qa', 'guruandai', 'Manual QA'),
  proj('other-root', null, 'Other Root'),
];

test('descendantProjectIds — parent gathers its whole subtree', () => {
  const roots = buildProjectTree(PROJECTS);
  const ids = descendantProjectIds(roots, 'guruandai');
  assert.deepEqual(
    [...ids].sort(),
    ['content', 'engine', 'engine-deep', 'guruandai', 'qa'].sort(),
  );
});

test('descendantProjectIds — a leaf is just itself', () => {
  const roots = buildProjectTree(PROJECTS);
  assert.deepEqual([...descendantProjectIds(roots, 'qa')], ['qa']);
});

test('descendantProjectIds — mid-tree node includes its own descendants', () => {
  const roots = buildProjectTree(PROJECTS);
  assert.deepEqual(
    [...descendantProjectIds(roots, 'engine')].sort(),
    ['engine', 'engine-deep'].sort(),
  );
});

test('descendantProjectIds — unknown id degrades to a singleton (never blanks)', () => {
  const roots = buildProjectTree(PROJECTS);
  assert.deepEqual([...descendantProjectIds(roots, 'ghost')], ['ghost']);
});

test('buildSubprojectSections — parent with NO direct tasks still surfaces subtrees', () => {
  const roots = buildProjectTree(PROJECTS);
  const tasks = [
    { id: 't1', projectId: 'engine', status: 'needs' },
    { id: 't2', projectId: 'engine-deep', status: 'done' }, // deep — rolls into engine
    { id: 't3', projectId: 'content', status: 'open' },
    { id: 't4', projectId: 'qa', status: 'failed' },
  ];
  const { ownTaskIds, sections } = buildSubprojectSections(tasks, roots, 'guruandai');
  // Parent has no direct tasks.
  assert.deepEqual(ownTaskIds, []);
  // One section per non-empty direct child, name-sorted by the tree.
  assert.deepEqual(
    sections.map((s) => s.id),
    ['engine', 'content', 'qa'],
  );
  const engine = sections.find((s) => s.id === 'engine');
  assert.equal(engine.taskCount, 2); // t1 + the deep t2
  assert.deepEqual(engine.taskIds.sort(), ['t1', 't2']);
  assert.equal(engine.statusCounts.needs, 1);
  assert.equal(engine.statusCounts.done, 1);
});

test('buildSubprojectSections — own tasks stay own; subproject tasks section', () => {
  const roots = buildProjectTree(PROJECTS);
  const tasks = [
    { id: 'own1', projectId: 'guruandai', status: 'progress' },
    { id: 'sub1', projectId: 'content', status: 'open' },
  ];
  const { ownTaskIds, sections } = buildSubprojectSections(tasks, roots, 'guruandai');
  assert.deepEqual(ownTaskIds, ['own1']);
  assert.deepEqual(sections.map((s) => s.id), ['content']);
});

test('buildSubprojectSections — empty subprojects are omitted', () => {
  const roots = buildProjectTree(PROJECTS);
  const tasks = [{ id: 'a', projectId: 'content', status: 'done' }];
  const { sections } = buildSubprojectSections(tasks, roots, 'guruandai');
  assert.deepEqual(sections.map((s) => s.id), ['content']); // engine + qa dropped
});

test('buildSubprojectSections — "All projects" makes each top-level project a section', () => {
  const roots = buildProjectTree(PROJECTS);
  const tasks = [
    { id: 't1', projectId: 'engine', status: 'done' }, // under guruandai
    { id: 't2', projectId: 'other-root', status: 'needs' },
    { id: 't3', projectId: null, status: 'open' }, // orphan → own
  ];
  const { ownTaskIds, sections } = buildSubprojectSections(tasks, roots, null);
  assert.deepEqual(ownTaskIds, ['t3']);
  assert.deepEqual(sections.map((s) => s.id).sort(), ['guruandai', 'other-root'].sort());
  const guru = sections.find((s) => s.id === 'guruandai');
  assert.equal(guru.taskCount, 1); // the deep engine task rolls up to the root
});

test('buildSubprojectSections — leaf selection has own tasks, no sections', () => {
  const roots = buildProjectTree(PROJECTS);
  const tasks = [{ id: 'x', projectId: 'qa', status: 'failed' }];
  const { ownTaskIds, sections } = buildSubprojectSections(tasks, roots, 'qa');
  assert.deepEqual(ownTaskIds, ['x']);
  assert.deepEqual(sections, []);
});
