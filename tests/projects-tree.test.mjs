// task-897a13d67632 — unit tests for the pure project-tree model + roll-up.
// Imports the plain ESM module directly (Node has no TS loader), so
// `node --test tests/projects-tree.test.mjs` runs green without a transpile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProjectTree,
  indexTree,
  ancestorChain,
  breadcrumbPath,
  rollUpTaskStats,
} from '../src/projects/tree.mjs';

function proj(over = {}) {
  return {
    id: over.id,
    name: over.name ?? over.id,
    description: over.description ?? null,
    instructions: over.instructions ?? null,
    parentProjectId: over.parentProjectId ?? null,
    folders: over.folders ?? [],
    createdBy: null,
    groupId: null,
    createdAt: null,
    updatedAt: null,
    effectiveInstructions: over.effectiveInstructions,
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
    due_at: null,
    pinned: false,
    cron: null,
    next_run_at: null,
    auto_mode: false,
    auto_agent: null,
    auto_prompt: null,
    created_at: 0,
    updated_at: 0,
    completed_at: null,
    rawStatus: over.rawStatus,
    projectId: over.projectId,
  };
}

// ─── tree construction ───────────────────────────────────────────────────────

test('buildProjectTree: nests children under parents, arbitrary depth', () => {
  const roots = buildProjectTree([
    proj({ id: 'ins', name: 'Insurance Authorization' }),
    proj({ id: 'aetna', name: 'Aetna HMO', parentProjectId: 'ins' }),
    proj({ id: 'aetna-2024', name: '2024 batch', parentProjectId: 'aetna' }),
  ]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].project.id, 'ins');
  assert.equal(roots[0].depth, 0);
  assert.equal(roots[0].children.length, 1);
  const aetna = roots[0].children[0];
  assert.equal(aetna.project.id, 'aetna');
  assert.equal(aetna.depth, 1);
  assert.equal(aetna.children[0].project.id, 'aetna-2024');
  assert.equal(aetna.children[0].depth, 2);
});

test('buildProjectTree: orphan (parent not in list) becomes a root', () => {
  const roots = buildProjectTree([
    proj({ id: 'child', name: 'Child', parentProjectId: 'missing-parent' }),
  ]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].project.id, 'child');
  assert.equal(roots[0].parentId, null);
});

test('buildProjectTree: cycles are broken (never hangs, all nodes present)', () => {
  const roots = buildProjectTree([
    proj({ id: 'a', name: 'A', parentProjectId: 'b' }),
    proj({ id: 'b', name: 'B', parentProjectId: 'a' }),
  ]);
  // Every node still appears exactly once across the forest.
  const index = indexTree(roots);
  assert.equal(index.size, 2);
  assert.ok(index.has('a'));
  assert.ok(index.has('b'));
});

test('buildProjectTree: self-parent degrades to a root', () => {
  const roots = buildProjectTree([proj({ id: 's', name: 'S', parentProjectId: 's' })]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].parentId, null);
});

test('buildProjectTree: children sorted by name (case-insensitive)', () => {
  const roots = buildProjectTree([
    proj({ id: 'p', name: 'Parent' }),
    proj({ id: 'z', name: 'zebra', parentProjectId: 'p' }),
    proj({ id: 'a', name: 'Apple', parentProjectId: 'p' }),
    proj({ id: 'm', name: 'mango', parentProjectId: 'p' }),
  ]);
  assert.deepEqual(
    roots[0].children.map((c) => c.project.name),
    ['Apple', 'mango', 'zebra'],
  );
});

test('buildProjectTree: empty / garbage input → empty forest', () => {
  assert.deepEqual(buildProjectTree([]), []);
  assert.deepEqual(buildProjectTree(null), []);
  assert.deepEqual(buildProjectTree(undefined), []);
});

// ─── path helpers ────────────────────────────────────────────────────────────

test('ancestorChain: root→target, general→specific', () => {
  const roots = buildProjectTree([
    proj({ id: 'ins', name: 'Insurance Authorization' }),
    proj({ id: 'aetna', name: 'Aetna HMO', parentProjectId: 'ins' }),
  ]);
  assert.deepEqual(
    ancestorChain(roots, 'aetna').map((p) => p.id),
    ['ins', 'aetna'],
  );
  assert.deepEqual(ancestorChain(roots, 'missing'), []);
});

test('breadcrumbPath: human " › " trail', () => {
  const roots = buildProjectTree([
    proj({ id: 'ins', name: 'Insurance Authorization' }),
    proj({ id: 'aetna', name: 'Aetna HMO', parentProjectId: 'ins' }),
  ]);
  assert.equal(breadcrumbPath(roots, 'aetna'), 'Insurance Authorization › Aetna HMO');
  assert.equal(breadcrumbPath(roots, 'ins'), 'Insurance Authorization');
  assert.equal(breadcrumbPath(roots, 'aetna', ' / '), 'Insurance Authorization / Aetna HMO');
  assert.equal(breadcrumbPath(roots, 'missing'), '');
});

// ─── roll-up ─────────────────────────────────────────────────────────────────

test('rollUpTaskStats: own vs rolled (children sum into parents)', () => {
  const roots = buildProjectTree([
    proj({ id: 'ins', name: 'Insurance' }),
    proj({ id: 'aetna', name: 'Aetna', parentProjectId: 'ins' }),
  ]);
  const tasks = [
    task({ projectId: 'ins', status: 'pending' }),
    task({ projectId: 'aetna', status: 'done' }),
    task({ projectId: 'aetna', status: 'in_progress' }),
  ];
  const stats = rollUpTaskStats(roots, tasks);

  const ins = stats.get('ins');
  assert.equal(ins.own.total, 1);
  assert.equal(ins.rolled.total, 3); // 1 own + 2 from aetna
  assert.equal(ins.rolled.done, 1);
  assert.equal(ins.rolled.inProgress, 1);
  assert.equal(ins.rolled.open, 1);

  const aetna = stats.get('aetna');
  assert.equal(aetna.own.total, 2);
  assert.equal(aetna.rolled.total, 2); // leaf: own === rolled
});

test('rollUpTaskStats: needsYou counts open + blocked, not in_progress/done', () => {
  const roots = buildProjectTree([proj({ id: 'p', name: 'P' })]);
  const tasks = [
    task({ projectId: 'p', status: 'pending' }), // needs you
    task({ projectId: 'p', status: 'pending', rawStatus: 'blocked' }), // needs you + blocked
    task({ projectId: 'p', status: 'in_progress' }), // not
    task({ projectId: 'p', status: 'done' }), // not
  ];
  const s = rollUpTaskStats(roots, tasks).get('p');
  assert.equal(s.own.needsYou, 2);
  assert.equal(s.own.blocked, 1);
  assert.equal(s.own.inProgress, 1);
  assert.equal(s.own.done, 1);
});

test('rollUpTaskStats: tasks with no/unknown projectId are ignored', () => {
  const roots = buildProjectTree([proj({ id: 'p', name: 'P' })]);
  const tasks = [
    task({ status: 'pending' }), // no projectId
    task({ projectId: 'ghost', status: 'pending' }), // project not in forest
    task({ projectId: 'p', status: 'pending' }),
  ];
  const s = rollUpTaskStats(roots, tasks).get('p');
  assert.equal(s.own.total, 1);
  assert.equal(s.rolled.total, 1);
});

test('rollUpTaskStats: deep roll-up (grandchild → parent → root)', () => {
  const roots = buildProjectTree([
    proj({ id: 'a', name: 'A' }),
    proj({ id: 'b', name: 'B', parentProjectId: 'a' }),
    proj({ id: 'c', name: 'C', parentProjectId: 'b' }),
  ]);
  const tasks = [
    task({ projectId: 'a', status: 'pending' }),
    task({ projectId: 'b', status: 'pending' }),
    task({ projectId: 'c', status: 'pending' }),
  ];
  const stats = rollUpTaskStats(roots, tasks);
  assert.equal(stats.get('a').rolled.total, 3);
  assert.equal(stats.get('b').rolled.total, 2);
  assert.equal(stats.get('c').rolled.total, 1);
  assert.equal(stats.get('a').own.total, 1);
});
