// task-749ecd0c34a4 — unit tests for the pure query-primitive engine
// (src/components/newhome/queryEngine.mjs). No React; runs under
// `node --test`. Mirrors tests/roster-groups.test.mjs's conventions (same
// module family).
//
// Motivating failure this proves fixed: the in-app copilot couldn't answer
// "group projects by repo" because it had no composable query layer and
// didn't know `repo` is derivable from `project.folders`. These tests
// exercise the primitives standing in for that copilot layer, composed
// directly (no CopilotKit — that wiring is a deliberate follow-up).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  from,
  deriveProjectRepo,
  withProjectDerived,
  withDerivedProjects,
  where,
  whereEq,
  whereIn,
  select,
  sort,
  limit,
  groupBy,
  aggregate,
  groupAggregate,
  indexBy,
  joinTaskProject,
  joinTaskParent,
  taskParentChain,
} from '../src/components/newhome/queryEngine.mjs';

// ── sample data ──────────────────────────────────────────────────────────────

const projects = [
  { id: 'p-breeze', name: 'BreezeFile', folders: ['/home/vivek/git_repos/breezefile'] },
  { id: 'p-taskapi', name: 'TaskAPI', folders: ['/home/vivek/git_repos/task_manager_api'] },
  { id: 'p-multi', name: 'Multi', folders: ['/home/vivek/git_repos/breezefile', '/home/vivek/other'] },
  { id: 'p-none', name: 'NoFolder', folders: [] },
  { id: 'p-null', name: 'NullFolders' }, // folders key entirely absent
];

const tasks = [
  { id: 't1', title: 'Fix roster bug', projectId: 'p-breeze', status: 'failed', assignedTo: 'vivek@example.com' },
  { id: 't2', title: 'Add tests', projectId: 'p-breeze', status: 'done', assignedTo: 'vivek@example.com' },
  { id: 't3', title: 'Deploy API', projectId: 'p-taskapi', status: 'failed', assignedTo: 'agent@example.com' },
  { id: 't4', title: 'Write docs', projectId: 'p-taskapi', status: 'done', assignedTo: 'agent@example.com' },
  { id: 't5', title: 'No project task', projectId: null, status: 'failed', assignedTo: 'vivek@example.com' },
  { id: 't6', title: 'Follow-up', projectId: 'p-breeze', status: 'failed', assignedTo: 'agent@example.com', parentTaskId: 't1' },
];

// ── derived repo field ───────────────────────────────────────────────────────

test('deriveProjectRepo: basename of folders[0]', () => {
  assert.deepEqual(deriveProjectRepo(projects[0]), { repo: 'breezefile', repoDir: '/home/vivek/git_repos' });
});

test('deriveProjectRepo: multiple folders — only folders[0] used', () => {
  assert.deepEqual(deriveProjectRepo(projects[2]), { repo: 'breezefile', repoDir: '/home/vivek/git_repos' });
});

test('deriveProjectRepo: (d) empty folders array -> null/null', () => {
  assert.deepEqual(deriveProjectRepo(projects[3]), { repo: null, repoDir: null });
});

test('deriveProjectRepo: (d) missing folders key entirely -> null/null', () => {
  assert.deepEqual(deriveProjectRepo(projects[4]), { repo: null, repoDir: null });
});

test('deriveProjectRepo: null/undefined project -> null/null (defensive)', () => {
  assert.deepEqual(deriveProjectRepo(null), { repo: null, repoDir: null });
  assert.deepEqual(deriveProjectRepo(undefined), { repo: null, repoDir: null });
});

test('withProjectDerived: attaches repo/repoDir without losing original fields', () => {
  const p = withProjectDerived(projects[0]);
  assert.equal(p.id, 'p-breeze');
  assert.equal(p.name, 'BreezeFile');
  assert.equal(p.repo, 'breezefile');
});

// ── (a) group projects by repo ───────────────────────────────────────────────

test('(a) group projects by repo: groups keyed by derived repo basename', () => {
  const derived = withDerivedProjects(projects);
  const groups = groupBy(derived, 'repo');
  const byKey = new Map(groups.map((g) => [g.key, g.items.map((i) => i.id)]));

  // breezefile groups p-breeze and p-multi together (both derive 'breezefile').
  assert.deepEqual(new Set(byKey.get('breezefile')), new Set(['p-breeze', 'p-multi']));
  assert.deepEqual(byKey.get('task_manager_api'), ['p-taskapi']);
  // No-folder / missing-folder projects bucket under the null key.
  assert.deepEqual(new Set(byKey.get(null)), new Set(['p-none', 'p-null']));
});

// ── (b) count failed tasks per repo (join task->project->repo, filter, group, count) ──

test('(b) count failed tasks per repo', () => {
  const joined = joinTaskProject(tasks, projects);
  const failed = whereEq(joined, 'status', 'failed');
  const rows = groupAggregate(failed, (t) => t.project?.repo ?? null, 'count');
  const byKey = new Map(rows.map((r) => [r.key, r.count]));

  // failed: t1 (breeze), t3 (taskapi), t5 (no project -> null), t6 (breeze)
  assert.equal(byKey.get('breezefile'), 2);
  assert.equal(byKey.get('task_manager_api'), 1);
  assert.equal(byKey.get(null), 1);
});

test('(b) joinTaskProject exposes derived repo on the attached project', () => {
  const joined = joinTaskProject(tasks, projects);
  const t1 = joined.find((t) => t.id === 't1');
  assert.equal(t1.project.repo, 'breezefile');
  const t5 = joined.find((t) => t.id === 't5'); // no projectId
  assert.equal(t5.project, null);
});

// ── (c) novel composition: count tasks per assignee grouped by project ──────

test('(c) count tasks per assignee grouped by project (novel composition)', () => {
  // Group by projectId first, then within each project group by assignee and count.
  const byProject = groupBy(tasks, 'projectId');
  /** @type {Record<string, Record<string, number>>} */
  const result = {};
  for (const projectGroup of byProject) {
    const key = projectGroup.key ?? 'none';
    const perAssignee = groupAggregate(projectGroup.items, 'assignedTo', 'count');
    result[key] = Object.fromEntries(perAssignee.map((r) => [r.key ?? 'unassigned', r.count]));
  }

  assert.deepEqual(result['p-breeze'], { 'vivek@example.com': 2, 'agent@example.com': 1 });
  assert.deepEqual(result['p-taskapi'], { 'agent@example.com': 2 });
  assert.deepEqual(result.none, { 'vivek@example.com': 1 });
});

// ── (e) aggregates: count / sum / avg / min / max / collect ─────────────────

test('(e) aggregate: count', () => {
  assert.equal(aggregate(tasks, 'count'), 6);
});

test('(e) aggregate: sum / avg / min / max over a numeric field', () => {
  const scored = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];
  assert.equal(aggregate(scored, 'sum', 'n'), 10);
  assert.equal(aggregate(scored, 'avg', 'n'), 2.5);
  assert.equal(aggregate(scored, 'min', 'n'), 1);
  assert.equal(aggregate(scored, 'max', 'n'), 4);
});

test('(e) aggregate: sum/avg/min/max skip non-numeric/missing values', () => {
  const mixed = [{ n: 1 }, { n: 'oops' }, { n: null }, { n: 5 }];
  assert.equal(aggregate(mixed, 'sum', 'n'), 6);
  assert.equal(aggregate(mixed, 'avg', 'n'), 3);
  assert.equal(aggregate(mixed, 'min', 'n'), 1);
  assert.equal(aggregate(mixed, 'max', 'n'), 5);
});

test('(e) aggregate: min/avg/max on an empty set is null (not NaN/Infinity)', () => {
  assert.equal(aggregate([], 'avg', 'n'), null);
  assert.equal(aggregate([], 'min', 'n'), null);
  assert.equal(aggregate([], 'max', 'n'), null);
});

test('(e) aggregate: collect', () => {
  assert.deepEqual(aggregate(tasks, 'collect', 'id'), ['t1', 't2', 't3', 't4', 't5', 't6']);
  assert.equal(aggregate(tasks.slice(0, 2), 'collect').length, 2); // whole records when field omitted
});

// ── where / select / sort / limit primitives ─────────────────────────────────

test('where/whereEq/whereIn filter records by predicate or value', () => {
  assert.equal(where(tasks, (t) => t.status === 'done').length, 2);
  assert.equal(whereEq(tasks, 'status', 'failed').length, 4);
  assert.equal(whereIn(tasks, 'status', ['done', 'failed']).length, 6);
  assert.equal(whereIn(tasks, 'status', []).length, 0);
});

test('select projects a subset of fields or maps records', () => {
  const rows = select(tasks.slice(0, 1), ['id', 'status']);
  assert.deepEqual(rows, [{ id: 't1', status: 'failed' }]);
  const mapped = select(tasks.slice(0, 1), (t) => ({ upper: t.id.toUpperCase() }));
  assert.deepEqual(mapped, [{ upper: 'T1' }]);
});

test('sort orders ascending by default, descending with opts, missing values first', () => {
  const rows = [{ id: 'b', n: 2 }, { id: 'a', n: 1 }, { id: 'c', n: undefined }];
  const asc = sort(rows, 'n').map((r) => r.id);
  assert.deepEqual(asc, ['c', 'a', 'b']);
  const desc = sort(rows, 'n', { desc: true }).map((r) => r.id);
  assert.deepEqual(desc, ['b', 'a', 'c']);
});

test('limit takes the first n records', () => {
  assert.equal(limit(tasks, 2).length, 2);
  assert.deepEqual(limit(tasks, 2).map((t) => t.id), ['t1', 't2']);
  assert.equal(limit(tasks, 0).length, 0);
});

// ── lookup / join: task<->parent chain ───────────────────────────────────────

test('joinTaskParent attaches the parent task, null when absent/unresolved', () => {
  const joined = joinTaskParent(tasks, tasks);
  const t6 = joined.find((t) => t.id === 't6');
  assert.equal(t6.parent.id, 't1');
  const t1 = joined.find((t) => t.id === 't1');
  assert.equal(t1.parent, null);
});

test('taskParentChain walks parentTaskId to the root and stops on cycles', () => {
  const t6 = tasks.find((t) => t.id === 't6');
  const chain = taskParentChain(t6, tasks);
  assert.deepEqual(chain.map((t) => t.id), ['t1']);

  // Cycle guard: a synthetic 2-node cycle must terminate, not loop forever.
  const cyc = [{ id: 'x', parentTaskId: 'y' }, { id: 'y', parentTaskId: 'x' }];
  const chainCyc = taskParentChain(cyc[0], cyc);
  assert.ok(chainCyc.length <= cyc.length);
});

test('indexBy builds a lookup map, last write wins on duplicate keys', () => {
  const idx = indexBy(projects, 'id');
  assert.equal(idx.get('p-breeze').name, 'BreezeFile');
  const dup = indexBy([{ id: 'x', v: 1 }, { id: 'x', v: 2 }], 'id');
  assert.equal(dup.get('x').v, 2);
});

test('from() is defensive against non-array input', () => {
  assert.deepEqual(from(null), []);
  assert.deepEqual(from(undefined), []);
  assert.deepEqual(from(tasks), tasks);
});
