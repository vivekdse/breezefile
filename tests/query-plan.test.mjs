// task-64815d2ed7b9 — unit tests for the declarative query-PLAN executor
// (src/components/newhome/queryPlan.mjs), the CopilotKit-facing layer over the
// pure queryEngine primitives. No React; runs under `node --test`. Proves the
// three acceptance questions are answerable by COMPOSING a plan (no hardcoded
// per-question tool), and that a malformed plan returns a typed error string
// instead of throwing into the UI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePlan,
  runQueryPlan,
  formatPlanResult,
  QUERY_PLAN_FIELDS,
} from '../src/components/newhome/queryPlan.mjs';

// ── PHI-safe metadata records, shaped the way actions.tsx reduces the live
//    roster + project list before handing them to the executor ──────────────

const projects = [
  { id: 'p-breeze', name: 'BreezeFile', folders: ['/home/vivek/git_repos/breezefile'], folderCount: 1, archived: false },
  { id: 'p-taskapi', name: 'TaskAPI', folders: ['/home/vivek/git_repos/task_manager_api'], folderCount: 1, archived: false },
  { id: 'p-multi', name: 'Multi', folders: ['/home/vivek/git_repos/breezefile', '/x'], folderCount: 2, archived: false },
  { id: 'p-none', name: 'NoFolder', folders: [], folderCount: 0, archived: false },
];

const tasks = [
  { id: 't1', title: 'Fix roster bug', projectId: 'p-breeze', status: 'failed', assignedTo: 'vivek@x.com', dataKeyCount: 1, outputCount: 0 },
  { id: 't2', title: 'Add tests', projectId: 'p-breeze', status: 'done', assignedTo: 'vivek@x.com', dataKeyCount: 0, outputCount: 0 },
  { id: 't3', title: 'Deploy API', projectId: 'p-taskapi', status: 'failed', assignedTo: 'agent@x.com', dataKeyCount: 0, outputCount: 2 },
  { id: 't4', title: 'Write docs', projectId: 'p-taskapi', status: 'done', assignedTo: 'agent@x.com', dataKeyCount: 0, outputCount: 0 },
  { id: 't5', title: 'Orphan', projectId: null, status: 'failed', assignedTo: 'vivek@x.com', dataKeyCount: 0, outputCount: 0 },
  { id: 't6', title: 'Follow-up', projectId: 'p-breeze', status: 'failed', assignedTo: 'agent@x.com', parentTaskId: 't1', dataKeyCount: 0, outputCount: 0 },
];

const data = { tasks, projects };

// ── acceptance (a): group projects by repo ──────────────────────────────────

test('(a) group projects by repo', () => {
  const res = runQueryPlan({ source: 'projects', groupBy: 'repo' }, data);
  assert.equal(res.ok, true);
  assert.equal(res.shape, 'groups');
  const byKey = new Map(res.rows.map((r) => [r.key, r.count]));
  // breezefile buckets p-breeze + p-multi (both derive 'breezefile').
  assert.equal(byKey.get('breezefile'), 2);
  assert.equal(byKey.get('task_manager_api'), 1);
  assert.equal(byKey.get(null), 1); // NoFolder → explicit null bucket
});

// ── acceptance (b): which repo has the most failed tasks ─────────────────────

test('(b) which repo has the most failed tasks', () => {
  const res = runQueryPlan(
    {
      source: 'tasks',
      join: 'project',
      where: [{ field: 'status', op: '=', value: 'failed' }],
      groupBy: 'repo',
      aggregate: { kind: 'count', as: 'failed' },
      sort: { by: 'value', desc: true },
      limit: 1,
    },
    data,
  );
  assert.equal(res.ok, true);
  assert.equal(res.rows.length, 1);
  // failed: t1(breeze), t3(taskapi), t5(no project→null), t6(breeze) → breeze wins with 2
  assert.equal(res.rows[0].key, 'breezefile');
  assert.equal(res.rows[0].failed, 2);
});

test('(b) full breakdown without the limit', () => {
  const res = runQueryPlan(
    {
      source: 'tasks',
      join: 'project',
      where: [{ field: 'status', op: '=', value: 'failed' }],
      groupBy: 'repo',
      aggregate: { kind: 'count', as: 'failed' },
      sort: { by: 'value', desc: true },
    },
    data,
  );
  const byKey = new Map(res.rows.map((r) => [r.key, r.failed]));
  assert.equal(byKey.get('breezefile'), 2);
  assert.equal(byKey.get('task_manager_api'), 1);
  assert.equal(byKey.get(null), 1); // orphaned failed task
});

// ── acceptance (c): count tasks per assignee grouped by project ─────────────

test('(c) count tasks per assignee grouped by project (composite groupBy)', () => {
  const res = runQueryPlan(
    { source: 'tasks', groupBy: ['projectId', 'assignedTo'], aggregate: { kind: 'count' } },
    data,
  );
  assert.equal(res.ok, true);
  const byKey = new Map(res.rows.map((r) => [r.key, r.count]));
  assert.equal(byKey.get('p-breeze / vivek@x.com'), 2);
  assert.equal(byKey.get('p-breeze / agent@x.com'), 1);
  assert.equal(byKey.get('p-taskapi / agent@x.com'), 2);
  assert.equal(byKey.get('none / vivek@x.com'), 1); // null projectId → 'none'
});

// ── scalar + rows shapes ─────────────────────────────────────────────────────

test('aggregate without groupBy → scalar', () => {
  const res = runQueryPlan(
    { source: 'tasks', where: [{ field: 'status', op: '=', value: 'failed' }], aggregate: { kind: 'count' } },
    data,
  );
  assert.equal(res.shape, 'scalar');
  assert.equal(res.value, 4);
});

test('sum over a numeric metadata field', () => {
  const res = runQueryPlan({ source: 'tasks', aggregate: { kind: 'sum', field: 'outputCount' } }, data);
  assert.equal(res.value, 2);
});

test('no groupBy/aggregate → filtered rows projected to safe fields', () => {
  const res = runQueryPlan(
    { source: 'tasks', where: [{ field: 'status', op: '=', value: 'done' }], sort: { by: 'id' } },
    data,
  );
  assert.equal(res.shape, 'rows');
  assert.deepEqual(res.rows.map((r) => r.id), ['t2', 't4']);
  // safe projection: title present, no stray body/value field leaks in
  assert.ok('title' in res.rows[0]);
  assert.ok(!('folders' in res.rows[0]));
});

test('projects rows never leak folders[] (only repo/folderCount)', () => {
  const res = runQueryPlan({ source: 'projects' }, data);
  assert.equal(res.shape, 'rows');
  assert.ok(!('folders' in res.rows[0]));
  assert.equal(res.rows.find((r) => r.id === 'p-breeze').repo, 'breezefile');
});

// ── where operators ─────────────────────────────────────────────────────────

test('where: in / != / ~ operators', () => {
  const inRes = runQueryPlan(
    { source: 'tasks', where: [{ field: 'status', op: 'in', value: ['done', 'failed'] }], aggregate: { kind: 'count' } },
    data,
  );
  assert.equal(inRes.value, 6);
  const neRes = runQueryPlan(
    { source: 'tasks', where: [{ field: 'status', op: '!=', value: 'failed' }], aggregate: { kind: 'count' } },
    data,
  );
  assert.equal(neRes.value, 2);
  const likeRes = runQueryPlan(
    { source: 'tasks', where: [{ field: 'title', op: '~', value: 'deploy' }], aggregate: { kind: 'count' } },
    data,
  );
  assert.equal(likeRes.value, 1);
});

test('parent join exposes parentStatus/parentTitle', () => {
  const res = runQueryPlan(
    { source: 'tasks', join: 'parent', where: [{ field: 'parentStatus', op: 'exists' }] },
    data,
  );
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].id, 't6');
  assert.equal(res.rows[0].parentTitle, 'Fix roster bug');
});

// ── defensive validation: malformed plans return typed errors, never throw ──

test('validatePlan rejects malformed plans with a helpful string', () => {
  assert.match(validatePlan(null) ?? '', /plan must be an object/);
  assert.match(validatePlan({}) ?? '', /source must be one of/);
  assert.match(validatePlan({ source: 'bogus' }) ?? '', /source must be one of/);
  assert.match(validatePlan({ source: 'tasks', join: 'nope' }) ?? '', /join must be one of/);
  assert.match(validatePlan({ source: 'projects', join: 'project' }) ?? '', /join is only valid/);
  assert.match(
    validatePlan({ source: 'tasks', where: [{ field: 'nope', op: '=', value: 1 }] }) ?? '',
    /unknown field "nope"/,
  );
  assert.match(
    validatePlan({ source: 'tasks', where: [{ field: 'status', op: 'LIKE', value: 1 }] }) ?? '',
    /unknown op/,
  );
  assert.match(
    validatePlan({ source: 'tasks', where: [{ field: 'status', op: 'in', value: 'x' }] }) ?? '',
    /"in" requires an array/,
  );
  assert.match(validatePlan({ source: 'tasks', groupBy: 'nope' }) ?? '', /groupBy: unknown field/);
  assert.match(validatePlan({ source: 'tasks', aggregate: { kind: 'nope' } }) ?? '', /aggregate.kind/);
  assert.match(
    validatePlan({ source: 'tasks', aggregate: { kind: 'sum' } }) ?? '',
    /needs a numeric field/,
  );
  assert.match(validatePlan({ source: 'tasks', limit: -1 }) ?? '', /non-negative/);
  // a well-formed plan validates clean
  assert.equal(validatePlan({ source: 'tasks', groupBy: 'status', aggregate: { kind: 'count' } }), null);
});

test('runQueryPlan returns {ok:false,error} on a bad plan and never throws', () => {
  const res = runQueryPlan({ source: 'tasks', groupBy: 'nonexistent' }, data);
  assert.equal(res.ok, false);
  assert.match(res.error, /groupBy: unknown field/);
});

test('runQueryPlan is defensive against missing datasets', () => {
  const res = runQueryPlan({ source: 'tasks', aggregate: { kind: 'count' } }, {});
  assert.equal(res.ok, true);
  assert.equal(res.value, 0);
});

// ── formatting (wire format handed to the model) ────────────────────────────

test('formatPlanResult renders each shape compactly', () => {
  const groups = runQueryPlan({ source: 'projects', groupBy: 'repo' }, data);
  const gs = formatPlanResult(groups);
  assert.match(gs, /grouped by repo/);
  assert.match(gs, /breezefile: 2/);
  assert.match(gs, /\(none\): 1/); // null group renders explicitly

  const scalar = runQueryPlan({ source: 'tasks', aggregate: { kind: 'count' } }, data);
  assert.match(formatPlanResult(scalar), /count = 6/);

  const bad = runQueryPlan({ source: 'nope' }, data);
  assert.match(formatPlanResult(bad), /^Failed:/);
});

// ── field catalogue is exported for the tool description (single source) ────

test('QUERY_PLAN_FIELDS exposes the catalogues the tool description advertises', () => {
  assert.ok(QUERY_PLAN_FIELDS.tasks.includes('status'));
  assert.ok(QUERY_PLAN_FIELDS.taskJoinProject.includes('repo'));
  assert.ok(QUERY_PLAN_FIELDS.projects.includes('repo'));
  assert.ok(QUERY_PLAN_FIELDS.aggregateKinds.includes('count'));
});
