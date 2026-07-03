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
