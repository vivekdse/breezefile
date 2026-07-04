// task-a4397184def4 (T5) — unit tests for the pure pipeline-roster module
// (src/components/newhome/pipelineRoster.mjs). No React; runs under `node --test`.
// Mirrors tests/task-schema.test.mjs's conventions (same module family).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partitionJobs,
  pipelineColumns,
  buildJobValuesByRef,
  classifyJob,
  fieldedSchemaSource,
  resolveFieldedJob,
  rewriteTaskFieldsBlock,
  runnableStepId,
  nextAutoContinueChildId,
  stepDisplayStatus,
  mergeChildStatus,
  childStatusOverride,
  chainStartTarget,
  toChildStatus,
  childStatusMap,
} from '../src/components/newhome/pipelineRoster.mjs';
import {
  buildTaskFieldsBlock,
  buildTaskOutputsBlock,
  parseTaskFieldsBlock,
  fieldRef,
} from '../src/components/newhome/taskSchema.mjs';

// ── partitionJobs ────────────────────────────────────────────────────────────
test('partitionJobs folds children under their parent and marks jobs', () => {
  const rows = [
    { id: 'job1', parentTaskId: null },
    { id: 'c1', parentTaskId: 'job1' },
    { id: 'c2', parentTaskId: 'job1' },
    { id: 'standalone', parentTaskId: null },
  ];
  const { topLevelIds, jobIds, childrenByParent } = partitionJobs(rows);
  assert.deepEqual(topLevelIds, ['job1', 'standalone']);
  assert.deepEqual(jobIds, ['job1']); // standalone has no children → not a job
  assert.deepEqual(childrenByParent, { job1: ['c1', 'c2'] });
});

test('partitionJobs tolerates empty / malformed input', () => {
  assert.deepEqual(partitionJobs([]), {
    topLevelIds: [],
    jobIds: [],
    childrenByParent: {},
  });
  assert.deepEqual(partitionJobs(undefined), {
    topLevelIds: [],
    jobIds: [],
    childrenByParent: {},
  });
  // A row without an id is skipped, not thrown on.
  const out = partitionJobs([{ parentTaskId: 'x' }, { id: 'ok', parentTaskId: null }]);
  assert.deepEqual(out.topLevelIds, ['ok']);
});

// ── pipelineColumns ──────────────────────────────────────────────────────────
test('pipelineColumns emits inputs-then-outputs per def, in chain order', () => {
  const taskDefs = [
    {
      id: 'intake',
      name: 'Intake',
      inputs: [{ key: 'customer', label: 'Customer', type: 'text' }],
      outputs: [{ key: 'has_stains', label: 'Stains?', type: 'bool', required: true }],
    },
    {
      id: 'wash',
      name: 'Wash',
      neededWhen: { ref: 'intake.has_stains', op: '==', value: 'Yes' },
      inputs: [],
      outputs: [{ key: 'done_at', label: 'Done at', type: 'date' }],
    },
  ];
  const groups = pipelineColumns(taskDefs);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].taskDefId, 'intake');
  assert.deepEqual(
    groups[0].columns.map((c) => [c.key, c.io, c.required]),
    [
      ['customer', 'in', false],
      ['has_stains', 'out', true],
    ],
  );
  // neededWhen threads through for the conditional group.
  assert.deepEqual(groups[1].neededWhen, { ref: 'intake.has_stains', op: '==', value: 'Yes' });
  assert.deepEqual(
    groups[1].columns.map((c) => [c.key, c.io]),
    [['done_at', 'out']],
  );
});

// ── buildJobValuesByRef ──────────────────────────────────────────────────────
test('buildJobValuesByRef merges input values + result outputs, indexed by def', () => {
  const children = [
    {
      id: 'c-intake',
      notes: `prompt\n\n${buildTaskFieldsBlock('tmpl', 'intake', { customer: 'Acme' })}`,
      result: { type: 'fields', payload: { taskDefId: 'intake', fields: { has_stains: 'Yes' } } },
    },
    {
      id: 'c-wash',
      notes: buildTaskFieldsBlock('tmpl', 'wash', { cycle: 'Hot' }),
      result: null,
    },
  ];
  const { valuesByRef, childIdByDefId } = buildJobValuesByRef(children);
  assert.equal(valuesByRef[fieldRef('intake', 'customer')], 'Acme');
  assert.equal(valuesByRef[fieldRef('intake', 'has_stains')], 'Yes');
  assert.equal(valuesByRef[fieldRef('wash', 'cycle')], 'Hot');
  assert.deepEqual(childIdByDefId, { intake: 'c-intake', wash: 'c-wash' });
});

test('buildJobValuesByRef ignores unfetched children (null notes/result)', () => {
  const { valuesByRef, childIdByDefId } = buildJobValuesByRef([
    { id: 'c1', notes: null, result: null },
  ]);
  assert.deepEqual(valuesByRef, {});
  assert.deepEqual(childIdByDefId, {});
});

// task-2638eeedd9ef: the server's canonical result is now FLAT ({key:value},
// no taskDefId). buildJobValuesByRef must still land those values under the
// right task-def group by falling back to the def id already known from the
// SAME child's task-fields/task-outputs blocks.
test('buildJobValuesByRef: FLAT result + task-fields block on the same child → indexed by that def', () => {
  const children = [
    {
      id: 'c-intake',
      notes: `prompt\n\n${buildTaskFieldsBlock('tmpl', 'intake', { customer: 'Acme' })}`,
      result: { type: 'fields', payload: { has_stains: 'Yes' } }, // flat, no taskDefId
    },
  ];
  const { valuesByRef, childIdByDefId } = buildJobValuesByRef(children);
  assert.equal(valuesByRef[fieldRef('intake', 'customer')], 'Acme');
  assert.equal(valuesByRef[fieldRef('intake', 'has_stains')], 'Yes');
  assert.deepEqual(childIdByDefId, { intake: 'c-intake' });
});

test('buildJobValuesByRef: FLAT result with only a task-outputs block (no task-fields) → still indexed', () => {
  const children = [
    {
      id: 'c-wash',
      notes: buildTaskOutputsBlock({
        id: 'wash',
        outputs: [{ key: 'done_at', label: 'Done at', type: 'text' }],
      }),
      result: { type: 'fields', payload: { done_at: '2026-07-03' } },
    },
  ];
  const { valuesByRef, childIdByDefId } = buildJobValuesByRef(children);
  assert.equal(valuesByRef[fieldRef('wash', 'done_at')], '2026-07-03');
  assert.deepEqual(childIdByDefId, { wash: 'c-wash' });
});

test('buildJobValuesByRef: legacy NESTED result (task-7d65e61fb581-style) still reads correctly', () => {
  const children = [
    {
      id: 'c-legacy',
      notes: null,
      result: { type: 'fields', payload: { taskDefId: 'intake', fields: { has_stains: 'Yes' } } },
    },
  ];
  const { valuesByRef, childIdByDefId } = buildJobValuesByRef(children);
  assert.equal(valuesByRef[fieldRef('intake', 'has_stains')], 'Yes');
  assert.deepEqual(childIdByDefId, { intake: 'c-legacy' });
});

// ── rewriteTaskFieldsBlock ───────────────────────────────────────────────────
test('rewriteTaskFieldsBlock replaces only the task-fields block, preserving surroundings', () => {
  const notes = [
    'Human prompt for the step.',
    buildTaskFieldsBlock('tmpl', 'intake', { customer: 'Acme', items: '12' }),
    buildTaskOutputsBlock({ id: 'intake', outputs: [{ key: 'x', label: 'X', type: 'text' }] }),
  ].join('\n\n');

  const next = rewriteTaskFieldsBlock(notes, 'tmpl', 'intake', {
    customer: 'Beta Corp',
    items: '12',
  });

  // The human prompt and the outputs block survive untouched.
  assert.ok(next.includes('Human prompt for the step.'));
  assert.ok(next.includes('```task-outputs'));
  // The value round-trips through the schema parser.
  const parsed = parseTaskFieldsBlock(next);
  assert.equal(parsed.templateId, 'tmpl');
  assert.equal(parsed.taskDefId, 'intake');
  assert.deepEqual(parsed.values, { customer: 'Beta Corp', items: '12' });
  // Exactly one task-fields block remains (no duplication).
  assert.equal(next.match(/```task-fields/g).length, 1);
});

test('rewriteTaskFieldsBlock appends a block when the body has none', () => {
  const next = rewriteTaskFieldsBlock('just some notes', 'tmpl', 'intake', { a: '1' });
  assert.ok(next.startsWith('just some notes'));
  const parsed = parseTaskFieldsBlock(next);
  assert.deepEqual(parsed.values, { a: '1' });
});

// ── runnableStepId (task-4045bcee23cb, U3a) ─────────────────────────────────
// The single "which step is runnable next" rule shared by the parent-row
// "▶ Start chain" action, the subtable group-header chips, and the detail
// Pipeline rollup.
test('runnableStepId returns the first non-done, non-skip def in chain order', () => {
  const taskDefs = [
    {
      id: 'intake',
      name: 'Intake',
      inputs: [],
      outputs: [{ key: 'has_stains', label: 'Stains?', type: 'bool', required: true }],
    },
    {
      id: 'wash',
      name: 'Wash',
      inputs: [],
      outputs: [{ key: 'done_at', label: 'Done at', type: 'date', required: true }],
    },
  ];
  // Nothing done yet → the FIRST def is runnable.
  assert.equal(runnableStepId(taskDefs, {}), 'intake');
  // intake done → wash is runnable next.
  assert.equal(
    runnableStepId(taskDefs, { [fieldRef('intake', 'has_stains')]: 'Yes' }),
    'wash',
  );
  // everything done → nothing left to run.
  assert.equal(
    runnableStepId(taskDefs, {
      [fieldRef('intake', 'has_stains')]: 'Yes',
      [fieldRef('wash', 'done_at')]: '2026-07-03',
    }),
    null,
  );
});

test('runnableStepId skips a conditionally-gated (n/a) def and lands on the next runnable one', () => {
  const taskDefs = [
    {
      id: 'intake',
      name: 'Intake',
      inputs: [],
      outputs: [{ key: 'has_stains', label: 'Stains?', type: 'bool', required: true }],
    },
    {
      id: 'wash',
      name: 'Wash',
      neededWhen: { ref: fieldRef('intake', 'has_stains'), op: '==', value: 'Yes' },
      inputs: [],
      outputs: [{ key: 'done_at', label: 'Done at', type: 'date', required: true }],
    },
    {
      id: 'deliver',
      name: 'Deliver',
      inputs: [],
      outputs: [{ key: 'delivered_at', label: 'Delivered at', type: 'date', required: true }],
    },
  ];
  // intake done, has_stains=No → wash is skipped (n/a) → deliver is runnable.
  const values = { [fieldRef('intake', 'has_stains')]: 'No' };
  assert.equal(runnableStepId(taskDefs, values), 'deliver');
});

test('runnableStepId returns null for an empty def list', () => {
  assert.equal(runnableStepId([], {}), null);
  assert.equal(runnableStepId(undefined, {}), null);
});

// ── nextAutoContinueChildId (task-6a14190fb2f7) ─────────────────────────────
// Chain continuation: given child N done, resolve child N+1's task id (never
// re-derive "what's next" — just runnableStepId + one lookup).
test('nextAutoContinueChildId: given child N done, returns child N+1', () => {
  const taskDefs = [
    {
      id: 'intake',
      name: 'Intake',
      inputs: [],
      outputs: [{ key: 'has_stains', label: 'Stains?', type: 'bool', required: true }],
    },
    {
      id: 'deliver',
      name: 'Deliver',
      inputs: [],
      outputs: [{ key: 'delivered_at', label: 'Delivered at', type: 'date', required: true }],
    },
  ];
  const childIdByDefId = { intake: 'child-1', deliver: 'child-2' };
  // Nothing done yet → step 1's child.
  assert.equal(nextAutoContinueChildId(taskDefs, {}, childIdByDefId), 'child-1');
  // intake (step 1) done → step 2's child.
  const values = { [fieldRef('intake', 'has_stains')]: 'Yes' };
  assert.equal(nextAutoContinueChildId(taskDefs, values, childIdByDefId), 'child-2');
});

test('nextAutoContinueChildId stops (returns null) at terminal — every def done', () => {
  const taskDefs = [
    {
      id: 'intake',
      name: 'Intake',
      inputs: [],
      outputs: [{ key: 'has_stains', label: 'Stains?', type: 'bool', required: true }],
    },
  ];
  const childIdByDefId = { intake: 'child-1' };
  const values = { [fieldRef('intake', 'has_stains')]: 'Yes' };
  assert.equal(nextAutoContinueChildId(taskDefs, values, childIdByDefId), null);
});

test('nextAutoContinueChildId returns null when the runnable step has no child yet', () => {
  const taskDefs = [
    { id: 'intake', name: 'Intake', inputs: [], outputs: [] },
  ];
  // Def exists but its child hasn't been resolved/created yet.
  assert.equal(nextAutoContinueChildId(taskDefs, {}, {}), null);
});

// ── stepDisplayStatus (task-c141c7765aa4, chip staleness — 3rd sighting) ────

test('stepDisplayStatus upgrades a pending step to active when its child is in_progress', () => {
  assert.equal(stepDisplayStatus('pending', true), 'active');
});

test('stepDisplayStatus upgrades an active (partial-output) step to active (stays active) when in_progress', () => {
  assert.equal(stepDisplayStatus('active', true), 'active');
});

test('stepDisplayStatus leaves pending alone when the child is NOT in_progress', () => {
  assert.equal(stepDisplayStatus('pending', false), 'pending');
});

test('stepDisplayStatus never downgrades a done step, even if the child row lags', () => {
  assert.equal(stepDisplayStatus('done', true), 'done');
  assert.equal(stepDisplayStatus('done', false), 'done');
});

test('stepDisplayStatus never promotes a skipped step', () => {
  assert.equal(stepDisplayStatus('skip', true), 'skip');
  assert.equal(stepDisplayStatus('skip', false), 'skip');
});

// ── task-f26e7745eda6: child server-status merge ────────────────────────────

test('childStatusOverride maps the high-signal server states', () => {
  assert.equal(childStatusOverride({ status: 'cancelled' }), 'cancelled');
  assert.equal(childStatusOverride({ rawStatus: 'cancelled' }), 'cancelled');
  assert.equal(childStatusOverride({ rawStatus: 'failed' }), 'failed');
  assert.equal(childStatusOverride({ rawStatus: 'blocked' }), 'failed');
  assert.equal(childStatusOverride({ rawStatus: 'in_progress' }), 'active');
  assert.equal(childStatusOverride({ status: 'in_progress' }), 'active');
  // open/pending/done carry no override — output-derived status stands.
  assert.equal(childStatusOverride({ rawStatus: 'open' }), null);
  assert.equal(childStatusOverride({ status: 'pending' }), null);
  assert.equal(childStatusOverride(null), null);
});

test('mergeChildStatus: a cancelled child → cancelled chip (not queued)', () => {
  assert.equal(mergeChildStatus('pending', { rawStatus: 'cancelled' }), 'cancelled');
});

test('mergeChildStatus: a blocked/failed child → failed chip', () => {
  assert.equal(mergeChildStatus('pending', { rawStatus: 'failed' }), 'failed');
  assert.equal(mergeChildStatus('pending', { rawStatus: 'blocked' }), 'failed');
});

test('mergeChildStatus: an in_progress child → active', () => {
  assert.equal(mergeChildStatus('pending', { rawStatus: 'in_progress' }), 'active');
});

test('mergeChildStatus: a skipped (n/a) step is NEVER overridden by child status', () => {
  assert.equal(mergeChildStatus('skip', { rawStatus: 'cancelled' }), 'skip');
  assert.equal(mergeChildStatus('skip', { rawStatus: 'failed' }), 'skip');
});

test('mergeChildStatus: a done step stays done (a late cancel never un-completes it)', () => {
  assert.equal(mergeChildStatus('done', { rawStatus: 'cancelled' }), 'done');
});

test('mergeChildStatus: no child / no override → the output-derived base stands', () => {
  assert.equal(mergeChildStatus('pending', null), 'pending');
  assert.equal(mergeChildStatus('active', { rawStatus: 'open' }), 'active');
});

// ── task-f26e7745eda6 + 48cd46a0e2da: runnable selection skips cancelled ─────

const CHAIN_DEFS = [
  { id: 'intake', name: 'Intake', inputs: [], outputs: [{ key: 'ok', required: true }] },
  { id: 'deliver', name: 'Deliver', inputs: [], outputs: [{ key: 'sent', required: true }] },
];

test('runnableStepId (no child status) picks the first not-done step — legacy behavior', () => {
  const values = { [fieldRef('intake', 'ok')]: 'yes' }; // intake done, deliver pending
  assert.equal(runnableStepId(CHAIN_DEFS, values), 'deliver');
});

test('runnableStepId SKIPS a cancelled child and returns null when nothing else runnable', () => {
  const values = { [fieldRef('intake', 'ok')]: 'yes' }; // intake done
  // deliver is server-cancelled → not runnable → nothing left.
  const childByDefId = { deliver: { rawStatus: 'cancelled' } };
  assert.equal(runnableStepId(CHAIN_DEFS, values, childByDefId), null);
});

test('runnableStepId picks the RIGHT step after a cancelled child is REOPENED', () => {
  const values = { [fieldRef('intake', 'ok')]: 'yes' };
  // deliver was cancelled, then reopened server-side → rawStatus back to 'open'.
  const childByDefId = { deliver: { rawStatus: 'open' } };
  assert.equal(runnableStepId(CHAIN_DEFS, values, childByDefId), 'deliver');
});

test('runnableStepId: a FAILED child is still runnable (retry lands on it)', () => {
  const values = { [fieldRef('intake', 'ok')]: 'yes' };
  const childByDefId = { deliver: { rawStatus: 'failed' } };
  assert.equal(runnableStepId(CHAIN_DEFS, values, childByDefId), 'deliver');
});

test('nextAutoContinueChildId SKIPS a cancelled child (auto-continue never starts it)', () => {
  const values = { [fieldRef('intake', 'ok')]: 'yes' };
  const childIdByDefId = { intake: 'c-intake', deliver: 'c-deliver' };
  const childByDefId = { deliver: { rawStatus: 'cancelled' } };
  assert.equal(
    nextAutoContinueChildId(CHAIN_DEFS, values, childIdByDefId, childByDefId),
    null,
  );
});

// ── task-48cd46a0e2da: chainStartTarget never returns a silent null ──────────

test('chainStartTarget returns the runnable child id when one exists', () => {
  const values = { [fieldRef('intake', 'ok')]: 'yes' };
  const childIdByDefId = { intake: 'c-intake', deliver: 'c-deliver' };
  const t = chainStartTarget(CHAIN_DEFS, values, childIdByDefId, { deliver: { rawStatus: 'open' } });
  assert.equal(t.childId, 'c-deliver');
  assert.equal(t.stepId, 'deliver');
});

test('chainStartTarget yields a REASON (never a bare null) when the remaining step is cancelled', () => {
  const values = { [fieldRef('intake', 'ok')]: 'yes' };
  const childIdByDefId = { intake: 'c-intake', deliver: 'c-deliver' };
  const t = chainStartTarget(CHAIN_DEFS, values, childIdByDefId, { deliver: { rawStatus: 'cancelled' } });
  assert.equal(t.childId, null);
  assert.match(t.reason, /cancelled/i);
});

test('chainStartTarget yields a "complete" reason when the whole chain is done', () => {
  const values = {
    [fieldRef('intake', 'ok')]: 'yes',
    [fieldRef('deliver', 'sent')]: 'yes',
  };
  const childIdByDefId = { intake: 'c-intake', deliver: 'c-deliver' };
  const t = chainStartTarget(CHAIN_DEFS, values, childIdByDefId, {});
  assert.equal(t.childId, null);
  assert.match(t.reason, /complete/i);
});

test('chainStartTarget yields a "loading" reason when the runnable step has no child yet', () => {
  const values = { [fieldRef('intake', 'ok')]: 'yes' };
  // deliver runnable but no child id resolved yet.
  const t = chainStartTarget(CHAIN_DEFS, values, { intake: 'c-intake' }, {});
  assert.equal(t.childId, null);
  assert.match(t.reason, /loading|no task/i);
});

// ── task-f26e7745eda6 (reviewer Angle-D): shared status-map helpers ─────────

test('toChildStatus projects a raw task to {status, rawStatus} (null for none)', () => {
  assert.deepEqual(toChildStatus({ status: 'pending', rawStatus: 'open', title: 'x' }), {
    status: 'pending',
    rawStatus: 'open',
  });
  assert.equal(toChildStatus(null), null);
  assert.equal(toChildStatus(undefined), null);
});

test('childStatusMap builds a def→status map from entries + a resolver', () => {
  const byId = { 'c-intake': { status: 'done', rawStatus: 'done' }, 'c-deliver': { status: 'pending', rawStatus: 'cancelled' } };
  const entries = Object.entries({ intake: 'c-intake', deliver: 'c-deliver' });
  const map = childStatusMap(entries, (id) => byId[id]);
  assert.deepEqual(map, {
    intake: { status: 'done', rawStatus: 'done' },
    deliver: { status: 'pending', rawStatus: 'cancelled' },
  });
});

test('childStatusMap skips defs whose child does not resolve', () => {
  const entries = Object.entries({ intake: 'c-intake', ghost: 'c-missing' });
  const map = childStatusMap(entries, (id) => (id === 'c-intake' ? { status: 'done' } : undefined));
  assert.deepEqual(map, { intake: { status: 'done', rawStatus: undefined } });
  assert.equal('ghost' in map, false);
});

test('childStatusMap feeds runnableStepId end-to-end (cancelled deliver → not runnable)', () => {
  const values = { [fieldRef('intake', 'ok')]: 'yes' };
  const byId = { 'c-intake': { rawStatus: 'done' }, 'c-deliver': { rawStatus: 'cancelled' } };
  const childByDefId = childStatusMap(
    Object.entries({ intake: 'c-intake', deliver: 'c-deliver' }),
    (id) => byId[id],
  );
  assert.equal(runnableStepId(CHAIN_DEFS, values, childByDefId), null);
});

// ── resolveFieldedJob (task-ce4b4c8ca955) ───────────────────────────────────
// Single-task (non-chained) output fields: fixture parity with
// task-73384d8e26e1 (flat result, server output_schema) and task-7d65e61fb581
// (legacy nested result, server output_schema).

test('resolveFieldedJob: server output_schema + flat result → one def, values populated', () => {
  const job = {
    id: 'task-73384d8e26e1',
    name: 'FIXTURE: done task with fields result',
    outputSchema: [{ key: 'widgets', label: 'Widgets counted', type: 'number', required: true }],
    notes: null,
    result: { type: 'fields', payload: { widgets: 42 } },
  };
  const resolved = resolveFieldedJob(job);
  assert.ok(resolved);
  assert.equal(resolved.defs.length, 1);
  const def = resolved.defs[0];
  assert.deepEqual(def.outputs, [{ key: 'widgets', label: 'Widgets counted', type: 'number', required: true }]);
  assert.deepEqual(def.inputs, []);
  assert.equal(resolved.valuesByRef[fieldRef(def.id, 'widgets')], 42);
  // Cell-click opens the task itself: the one def's child id IS the job id.
  assert.deepEqual(resolved.childIdByDefId, { [def.id]: 'task-73384d8e26e1' });
});

test('resolveFieldedJob: server output_schema + legacy nested result → all fields populated', () => {
  const job = {
    id: 'task-7d65e61fb581',
    name: 'Check time spent on devices',
    outputSchema: [
      { key: 'date', label: 'Date', type: 'date', required: true },
      { key: 'uma_time', label: 'Uma screen time', type: 'number', required: true },
      { key: 'kira_time', label: 'Kira screen time', type: 'number', required: true },
    ],
    notes: null,
    result: {
      type: 'fields',
      payload: { taskDefId: 'task', fields: { date: '2026-07-04', uma_time: 331, kira_time: 99 } },
    },
  };
  const resolved = resolveFieldedJob(job);
  assert.ok(resolved);
  const def = resolved.defs[0];
  assert.equal(resolved.valuesByRef[fieldRef(def.id, 'date')], '2026-07-04');
  assert.equal(resolved.valuesByRef[fieldRef(def.id, 'uma_time')], 331);
  assert.equal(resolved.valuesByRef[fieldRef(def.id, 'kira_time')], 99);
});

test('resolveFieldedJob: falls back to a legacy ```task-outputs body block when no server schema', () => {
  const taskDef = { id: 'legacy', name: 'Legacy', inputs: [], outputs: [{ key: 'n', label: 'N', type: 'number' }] };
  const notes = buildTaskOutputsBlock(taskDef);
  const job = { id: 'j1', name: 'Legacy job', outputSchema: null, notes, result: { type: 'fields', payload: { n: 7 } } };
  const resolved = resolveFieldedJob(job);
  assert.ok(resolved);
  assert.equal(resolved.defs[0].outputs[0].key, 'n');
  assert.equal(resolved.valuesByRef[fieldRef(resolved.defs[0].id, 'n')], 7);
});

test('resolveFieldedJob: server schema wins over a legacy body block when both present', () => {
  const legacyDef = { id: 'legacy', name: 'Legacy', inputs: [], outputs: [{ key: 'old', label: 'Old', type: 'text' }] };
  const notes = buildTaskOutputsBlock(legacyDef);
  const job = {
    id: 'j2',
    name: 'Both',
    outputSchema: [{ key: 'widgets', label: 'Widgets', type: 'number' }],
    notes,
    result: null,
  };
  const resolved = resolveFieldedJob(job);
  assert.deepEqual(resolved.defs[0].outputs, [{ key: 'widgets', label: 'Widgets', type: 'number' }]);
});

test('resolveFieldedJob: no schema source at all → null (stays a plain row, no regression)', () => {
  assert.equal(resolveFieldedJob({ id: 'j3', name: 'Plain', outputSchema: null, notes: null, result: null }), null);
  assert.equal(
    resolveFieldedJob({ id: 'j4', name: 'Plain notes', outputSchema: undefined, notes: 'just some human notes', result: null }),
    null,
  );
});

test('resolveFieldedJob: schema present but no result yet → def with empty values (mid-flight, not null)', () => {
  const job = {
    id: 'j5',
    name: 'Awaiting result',
    outputSchema: [{ key: 'widgets', label: 'Widgets', type: 'number', required: true }],
    notes: null,
    result: null,
  };
  const resolved = resolveFieldedJob(job);
  assert.ok(resolved);
  assert.deepEqual(resolved.valuesByRef, {});
});

test('resolveFieldedJob: invalid job (no id) → null', () => {
  assert.equal(resolveFieldedJob(null), null);
  assert.equal(resolveFieldedJob({ outputSchema: [{ key: 'a', label: 'A', type: 'text' }] }), null);
});

// ── fieldedSchemaSource (ROUND-18 wire/list-row threading gap) ───────────────
// THE BUG the earlier tests missed: resolveFieldedJob itself worked when handed
// a schema, but resolveJob sourced that schema from the schema-LESS LIST ROW
// (mapListRow never sets outputSchema) instead of the FETCHED DETAIL — so all
// three server-schema fixtures fell through to 'plain'. These pin the fix.
const SCHEMA = [{ key: 'widgets', label: 'Widgets', type: 'number', required: true }];

test('fieldedSchemaSource: schema on the DETAIL, ABSENT on the list row → uses the detail (the real fixture shape)', () => {
  // Exactly the round-18 fixtures: DONE top-level task, server output_schema on
  // the get_task detail, list row carries NO schema. Must NOT return null.
  const detail = { notes: null, result: { type: 'fields', payload: { widgets: 42 } }, outputSchema: SCHEMA };
  const listRow = { id: 'task-73384d8e26e1', title: 'Done widget task' }; // no outputSchema
  assert.deepEqual(fieldedSchemaSource(detail, listRow), SCHEMA);
});

test('fieldedSchemaSource: neither detail nor list row has a schema → null (plain, no regression)', () => {
  assert.equal(fieldedSchemaSource({ notes: null, result: null }, { id: 'x' }), null);
  assert.equal(fieldedSchemaSource(null, null), null);
  assert.equal(fieldedSchemaSource({ outputSchema: [] }, { outputSchema: [] }), null); // empty ≠ present
});

test('fieldedSchemaSource: list row carries a schema (future list), detail lacks it → falls back to list', () => {
  assert.deepEqual(fieldedSchemaSource({ notes: null }, { outputSchema: SCHEMA }), SCHEMA);
});

test('END-TO-END: detail-sourced server schema (no body block, list row schema-less) resolves fielded with columns + values', () => {
  // Reconstructs the EXACT call resolveJob makes after the fix: schema from the
  // fetched DETAIL via fieldedSchemaSource, notes/result from the detail. Proves
  // a server-schema'd DONE single task yields field columns + values — the
  // acceptance the three fixtures need. (Before the fix, outputSchema was read
  // off the list row → undefined → resolveFieldedJob returned null → 'plain'.)
  const detail = {
    notes: null, // NO legacy ```task-outputs body block — server schema only
    result: { type: 'fields', payload: { widgets: 42 } },
    outputSchema: SCHEMA,
  };
  const listRow = { id: 'task-73384d8e26e1', title: 'FIXTURE done widget task' }; // schema-less
  const resolved = resolveFieldedJob({
    id: 'task-73384d8e26e1',
    name: listRow.title,
    outputSchema: fieldedSchemaSource(detail, listRow),
    notes: detail.notes,
    result: detail.result,
  });
  assert.ok(resolved, 'must resolve fielded (not null → plain)');
  assert.equal(resolved.defs.length, 1);
  const def = resolved.defs[0];
  assert.deepEqual(def.outputs, SCHEMA);
  assert.equal(resolved.valuesByRef[fieldRef(def.id, 'widgets')], 42);
  assert.deepEqual(resolved.childIdByDefId, { [def.id]: 'task-73384d8e26e1' });
});

// ── classifyJob (chain-grouping regression guard) ────────────────────────────
// The single pure source of truth for a top-level candidate's classification.
// These four cases pin the invariant the d443423 candidate-set widening broke:
// a chain PARENT resolves 'chained' (children folded/hidden), its CHILDREN are
// never top-level, a CHILDLESS schema'd task is 'fielded', a plain task stays
// 'plain' — all simultaneously.
const FIELDED_FIXTURE = {
  name: 'Single task',
  defs: [{ id: '__fielded__', name: 'Single task', inputs: [], outputs: [{ key: 'ok', label: 'OK', type: 'text' }] }],
  valuesByRef: { '__fielded__.ok': 'yes' },
  childIdByDefId: { __fielded__: 'j1' },
};

test('classifyJob: detail not fetched yet → loading', () => {
  assert.deepEqual(
    classifyJob({ hasDetail: false, parsedDefs: null, childCount: 0, fielded: null }),
    { status: 'loading' },
  );
});

test('classifyJob: chain PARENT (template block, defs>0) → chained', () => {
  const defs = [{ id: 'intake', name: 'Intake', inputs: [], outputs: [] }];
  // Even with children present, a parsed template makes it chained (subtable);
  // children get folded in + hidden by the caller.
  assert.deepEqual(
    classifyJob({ hasDetail: true, parsedDefs: defs, childCount: 2, fielded: null }),
    { status: 'chained' },
  );
});

test('classifyJob: CONTAINER (children, no parseable template) → plain, NEVER fielded', () => {
  // THE REGRESSION GUARD: a task with children must never be 'fielded', or its
  // children leak out as top-level rows and the parent renders a bogus one-def
  // subtable over its own outputSchema. Even when a fielded resolution exists
  // (the parent carries an outputSchema), the child-count guard wins.
  assert.deepEqual(
    classifyJob({ hasDetail: true, parsedDefs: null, childCount: 2, fielded: FIELDED_FIXTURE }),
    { status: 'plain' },
  );
  assert.deepEqual(
    classifyJob({ hasDetail: true, parsedDefs: [], childCount: 1, fielded: FIELDED_FIXTURE }),
    { status: 'plain' },
  );
});

test('classifyJob: CHILDLESS schema-only task → fielded (task-ce4b4c8ca955, not regressed)', () => {
  const out = classifyJob({ hasDetail: true, parsedDefs: null, childCount: 0, fielded: FIELDED_FIXTURE });
  assert.equal(out.status, 'fielded');
  assert.deepEqual(out.defs, FIELDED_FIXTURE.defs);
  assert.deepEqual(out.childIdByDefId, FIELDED_FIXTURE.childIdByDefId);
});

test('classifyJob: childless, no template, no fielded fields → plain', () => {
  assert.deepEqual(
    classifyJob({ hasDetail: true, parsedDefs: null, childCount: 0, fielded: null }),
    { status: 'plain' },
  );
});

test('chain child is excluded from the top-level / candidate set', () => {
  // RosterTable derives candidateJobIds from partitionJobs(...).topLevelIds.
  // A chain child (carries parentTaskId) is NOT top-level, so it can never be a
  // candidate and can never render as its own row — it only ever appears folded
  // under its parent's subtable.
  const rows = [
    { id: 'parent', parentTaskId: null },
    { id: 'intake', parentTaskId: 'parent' },
    { id: 'deliver', parentTaskId: 'parent' },
  ];
  const { topLevelIds, childrenByParent } = partitionJobs(rows);
  assert.deepEqual(topLevelIds, ['parent']);
  assert.ok(!topLevelIds.includes('intake'));
  assert.ok(!topLevelIds.includes('deliver'));
  assert.deepEqual(childrenByParent, { parent: ['intake', 'deliver'] });
});
