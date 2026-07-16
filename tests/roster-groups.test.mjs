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
  isScheduled,
  statusBucket,
  summarizeGroupRows,
  STATUS_BUCKETS,
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
  assert.equal(other[0].status, 'queued'); // raw input status, echoed verbatim
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

// ── task-ecabeafa41e1: Level-1 group summary (status buckets + assignees) ─────
// task-c0edffef25c6 — cancelled got its own bucket, split out of the old
// catch-all, so it never gets counted as (or confused with) failed.
test('statusBucket: raw/coarse statuses map onto the seven buckets', () => {
  assert.equal(statusBucket('done'), 'done');
  assert.equal(statusBucket('completed'), 'done');
  assert.equal(statusBucket('succeeded'), 'done');
  assert.equal(statusBucket('partial'), 'done');
  assert.equal(statusBucket('in_progress'), 'progress');
  assert.equal(statusBucket('progress'), 'progress');
  assert.equal(statusBucket('running'), 'progress');
  assert.equal(statusBucket('claimed'), 'progress');
  assert.equal(statusBucket('failed'), 'failed');
  assert.equal(statusBucket('error'), 'failed');
  assert.equal(statusBucket('needs'), 'needs');
  assert.equal(statusBucket('needs_review'), 'needs');
  assert.equal(statusBucket('blocked'), 'needs');
  assert.equal(statusBucket('asked'), 'needs');
  // cancelled/canceled are their own bucket — NOT failed, NOT open.
  assert.equal(statusBucket('cancelled'), 'cancelled');
  assert.equal(statusBucket('canceled'), 'cancelled');
  // pending/queued/unknown/empty all fall to open when NO task is supplied:
  // without the task we cannot see a schedule, and 'open' is the honest answer.
  assert.equal(statusBucket('queued'), 'open');
  assert.equal(statusBucket('pending'), 'open');
  assert.equal(statusBucket('deferred'), 'open');
  assert.equal(statusBucket('something-odd'), 'open');
  assert.equal(statusBucket(undefined), 'open');
  assert.equal(statusBucket(null), 'open');
});

// A pending task is 'scheduled' ONLY when something will actually run it.
test('statusBucket: a pending task with a real schedule is scheduled, not open', () => {
  assert.equal(statusBucket('pending', { cron: '0 9 * * *' }), 'scheduled');
  assert.equal(statusBucket('pending', { next_run_at: 1700000000000 }), 'scheduled');
  assert.equal(statusBucket('pending', { cron: null, next_run_at: null }), 'open');
  assert.equal(statusBucket('pending', { cron: '   ' }), 'open');
  assert.equal(statusBucket('pending', {}), 'open');
  assert.equal(statusBucket('pending', null), 'open');
  // A due date is a HUMAN deadline, not an execution schedule — still open.
  assert.equal(statusBucket('pending', { due_at: '2026-01-01', start_at: '2026-01-01' }), 'open');
  // A schedule never overrides a settled bucket.
  assert.equal(statusBucket('done', { cron: '0 9 * * *' }), 'done');
  assert.equal(statusBucket('failed', { cron: '0 9 * * *' }), 'failed');
  assert.equal(statusBucket('cancelled', { next_run_at: 1 }), 'cancelled');
});

test('isScheduled: only cron / next_run_at count', () => {
  assert.equal(isScheduled({ cron: '0 9 * * *' }), true);
  assert.equal(isScheduled({ next_run_at: 0 }), false); // 0 = unset sentinel, not epoch
  assert.equal(isScheduled({ cron: '', next_run_at: null }), false);
  assert.equal(isScheduled({ next_run_at: Number.NaN }), false);
  assert.equal(isScheduled({ next_run_at: 1700000000000 }), true);
  assert.equal(isScheduled({ due_at: '2026-01-01' }), false);
  assert.equal(isScheduled(null), false);
  assert.equal(isScheduled(undefined), false);
});

test('STATUS_BUCKETS lists the seven buckets in display order', () => {
  assert.deepEqual(STATUS_BUCKETS, [
    'done',
    'progress',
    'scheduled',
    'open',
    'needs',
    'failed',
    'cancelled',
  ]);
});

test('summarizeGroupRows: counts runs, buckets statuses, and de-dups assignees', () => {
  const s = summarizeGroupRows([
    { status: 'done', assignee: 'a@x.com' },
    { status: 'done', assignee: 'a@x.com' }, // same assignee → still 1 distinct
    { status: 'in_progress', assignee: 'b@x.com' },
    { status: 'failed', assignee: null }, // no assignee → not counted
    { status: 'queued' }, // missing assignee → not counted; no raw → open
  ]);
  assert.equal(s.runCount, 5);
  assert.deepEqual(s.statusCounts, {
    done: 2,
    progress: 1,
    scheduled: 0,
    open: 1,
    needs: 0,
    failed: 1,
    cancelled: 0,
  });
  assert.deepEqual([...s.assignees].sort(), ['a@x.com', 'b@x.com']); // 2 distinct
});

test('summarizeGroupRows: a cancelled run counts as cancelled, not failed', () => {
  const s = summarizeGroupRows([
    { status: 'cancelled', assignee: 'a@x.com' },
    { status: 'failed', assignee: 'b@x.com' },
  ]);
  assert.deepEqual(s.statusCounts, {
    done: 0,
    progress: 0,
    scheduled: 0,
    open: 0,
    needs: 0,
    failed: 1,
    cancelled: 1,
  });
});

// A run carrying its underlying task splits scheduled from open; one without
// falls through to open, so a mixed group reports both.
test('summarizeGroupRows: a run whose task has a schedule counts as scheduled', () => {
  const s = summarizeGroupRows([
    { status: 'pending', raw: { cron: '0 9 * * *' } },
    { status: 'pending', raw: { next_run_at: 1700000000000 } },
    { status: 'pending', raw: { cron: null, next_run_at: null } },
    { status: 'pending' },
  ]);
  assert.equal(s.statusCounts.scheduled, 2);
  assert.equal(s.statusCounts.open, 2);
});

test('summarizeGroupRows: multiple distinct assignees across chain-like runs (can exceed 1)', () => {
  const s = summarizeGroupRows([
    { status: 'done', assignee: 'alice@x.com' },
    { status: 'progress', assignee: 'bob@x.com' },
    { status: 'queued', assignee: 'carol@x.com' },
  ]);
  assert.equal(s.assignees.length, 3);
});

test('summarizeGroupRows: empty input yields zeroed summary, no throw', () => {
  const s = summarizeGroupRows([]);
  assert.equal(s.runCount, 0);
  assert.deepEqual(s.statusCounts, {
    done: 0,
    progress: 0,
    scheduled: 0,
    open: 0,
    needs: 0,
    failed: 0,
    cancelled: 0,
  });
  assert.deepEqual(s.assignees, []);
  // defensive: non-array
  const s2 = summarizeGroupRows(undefined);
  assert.equal(s2.runCount, 0);
});

test('summarizeGroupRows: whitespace-only assignee is treated as unassigned', () => {
  const s = summarizeGroupRows([{ status: 'done', assignee: '   ' }]);
  assert.deepEqual(s.assignees, []);
});
