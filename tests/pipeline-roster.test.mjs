// task-a4397184def4 (T5) — unit tests for the pure pipeline-roster module
// (src/components/newhome/pipelineRoster.mjs). No React; runs under `node --test`.
// Mirrors tests/task-schema.test.mjs's conventions (same module family).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partitionJobs,
  pipelineColumns,
  buildJobValuesByRef,
  rewriteTaskFieldsBlock,
  runnableStepId,
  nextAutoContinueChildId,
  stepDisplayStatus,
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
