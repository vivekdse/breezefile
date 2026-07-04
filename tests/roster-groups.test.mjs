// task-b8fa34a80a34 — unit tests for the pure roster-grouping module
// (src/components/newhome/rosterGroups.mjs). No React; runs under `node --test`.
// Mirrors tests/pipeline-roster.test.mjs's conventions (same module family).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isFieldBearing,
  groupNameFor,
  groupKeyFor,
  deriveInstanceId,
  buildRosterGroups,
} from '../src/components/newhome/rosterGroups.mjs';

const out = (key, label, extra = {}) => ({ key, label, type: 'text', ...extra });

// ── field-bearing detection ──────────────────────────────────────────────────
test('isFieldBearing: any input or output field makes a task field-bearing', () => {
  assert.equal(isFieldBearing({ id: 'a', dataKeys: ['source'], outputSchema: [] }), true);
  assert.equal(isFieldBearing({ id: 'b', dataKeys: [], outputSchema: [out('h1', 'Headline 1')] }), true);
  assert.equal(isFieldBearing({ id: 'c', dataKeys: [], outputSchema: [] }), false);
  assert.equal(isFieldBearing({ id: 'd' }), false); // no field arrays at all
});

// ── grouping key: templateId preferred, (name,project) fallback ───────────────
test('groupKeyFor: templateId wins when present', () => {
  const a = { id: '1', templateId: 'tmpl-x', title: 'A', projectId: 'p1' };
  const b = { id: '2', templateId: 'tmpl-x', title: 'B', projectId: 'p2' };
  // Same templateId → same key, regardless of title/project.
  assert.equal(groupKeyFor(a), groupKeyFor(b));
  assert.equal(groupKeyFor(a), 'tid:tmpl-x');
});

test('groupKeyFor: fallback groups by (name, project) when templateId absent', () => {
  const a = { id: '1', title: 'Get top 5 headlines', projectId: 'p1' };
  const b = { id: '2', title: 'Get top 5 headlines', projectId: 'p1' };
  const c = { id: '3', title: 'Get top 5 headlines', projectId: 'p2' };
  assert.equal(groupKeyFor(a), groupKeyFor(b)); // same title + project → together
  assert.notEqual(groupKeyFor(a), groupKeyFor(c)); // different project → apart
});

test('groupNameFor: templateName preferred over title', () => {
  assert.equal(groupNameFor({ id: '1', templateName: 'Lead qualification', title: 'x' }), 'Lead qualification');
  assert.equal(groupNameFor({ id: '2', title: 'Get top 5 headlines' }), 'Get top 5 headlines');
  assert.equal(groupNameFor({ id: '3' }), '3'); // id last resort
});

// ── column order: inputs first, then outputs; union across the group ──────────
test('buildRosterGroups: columns are inputs-then-outputs, unioned across tasks', () => {
  const { groups } = buildRosterGroups([
    {
      id: 't1',
      title: 'Get top 5 headlines',
      projectId: 'p1',
      dataKeys: ['source'],
      outputSchema: [out('h1', 'Headline 1'), out('h2', 'Headline 2')],
      createdAt: 1,
    },
    {
      id: 't2',
      title: 'Get top 5 headlines',
      projectId: 'p1',
      // Union in an extra output that only the 2nd instance declares.
      dataKeys: ['source'],
      outputSchema: [out('h1', 'Headline 1'), out('h3', 'Headline 3', { required: true })],
      createdAt: 2,
    },
  ]);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.name, 'Get top 5 headlines');
  assert.deepEqual(g.inputCols.map((c) => c.key), ['source']);
  assert.deepEqual(g.inputCols.map((c) => c.io), ['in']);
  // Outputs unioned, first-seen order: h1, h2 (from t1), then h3 (new in t2).
  assert.deepEqual(g.outputCols.map((c) => c.key), ['h1', 'h2', 'h3']);
  assert.deepEqual(g.outputCols.map((c) => c.io), ['out', 'out', 'out']);
  assert.equal(g.outputCols.find((c) => c.key === 'h3').required, true);
});

// ── instance-id derivation + #n fallback ──────────────────────────────────────
test('buildRosterGroups: instanceId falls back to #n in created order', () => {
  const { groups } = buildRosterGroups([
    { id: 'b', title: 'Get top 5 headlines', outputSchema: [out('h1', 'H1')], createdAt: 200 },
    { id: 'a', title: 'Get top 5 headlines', outputSchema: [out('h1', 'H1')], createdAt: 100 },
  ]);
  const g = groups[0];
  // Sorted by createdAt asc → a (#1) then b (#2); title === group name → #n.
  assert.deepEqual(g.rows.map((r) => r.taskId), ['a', 'b']);
  assert.deepEqual(g.rows.map((r) => r.instanceId), ['#1', '#2']);
});

test('deriveInstanceId: uses title when it differs from the group name', () => {
  assert.equal(deriveInstanceId({ id: '1', title: 'Acme run' }, 'Lead qualification', 0), 'Acme run');
  assert.equal(deriveInstanceId({ id: '1', title: 'Lead qualification' }, 'Lead qualification', 2), '#3');
});

// ── template-less tasks → "other" bucket ──────────────────────────────────────
test('buildRosterGroups: field-less tasks go to the other bucket, not a section', () => {
  const { groups, other } = buildRosterGroups([
    { id: 'f1', title: 'Get top 5 headlines', outputSchema: [out('h1', 'H1')], status: 'done', createdAt: 1 },
    { id: 'p1', title: 'Email the ops report', status: 'queued' }, // no fields
    { id: 'p2', title: 'Get first headline', status: 'failed', dataKeys: [], outputSchema: [] },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].rows.map((r) => r.taskId), ['f1']);
  assert.deepEqual(other.map((o) => o.taskId), ['p1', 'p2']);
  assert.equal(other[0].title, 'Email the ops report');
  assert.equal(other[0].status, 'queued');
});

// ── the "news selection" acceptance case ──────────────────────────────────────
test('news selection: multiple headline instances group into ONE section; other → other', () => {
  const { groups, other } = buildRosterGroups([
    { id: 'cnn', title: 'Get top 5 headlines', projectId: 'p', dataKeys: ['source'], outputSchema: [out('h1', 'H1')], status: 'done', createdAt: 1 },
    { id: 'bbc', title: 'Get top 5 headlines', projectId: 'p', dataKeys: ['source'], outputSchema: [out('h1', 'H1')], status: 'done', createdAt: 2 },
    { id: 'ie', title: 'Get top 5 headlines', projectId: 'p', dataKeys: ['source'], outputSchema: [out('h1', 'H1')], status: 'progress', createdAt: 3 },
    { id: 'oneoff', title: 'Email the ops report', projectId: 'p', status: 'queued' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'Get top 5 headlines');
  assert.equal(groups[0].rows.length, 3);
  assert.deepEqual(other.map((o) => o.taskId), ['oneoff']);
});

test('buildRosterGroups: tolerates empty / malformed input', () => {
  assert.deepEqual(buildRosterGroups([]), { groups: [], other: [] });
  assert.deepEqual(buildRosterGroups(undefined), { groups: [], other: [] });
  const { groups, other } = buildRosterGroups([{ parentTaskId: 'x' }, { id: 'ok', outputSchema: [out('k', 'K')] }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rows[0].taskId, 'ok');
  assert.equal(other.length, 0);
});
