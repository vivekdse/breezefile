// task-8b694714b13c — unit tests for the pure Task Templates schema module
// (src/components/newhome/taskSchema.mjs). No React; runs under `node --test`.
// Mirrors tests/task-result.test.mjs's conventions (same module family).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fieldRef,
  buildTaskFieldsBlock,
  buildTaskOutputsBlock,
  buildTaskTemplateBlock,
  parseTaskFieldsBlock,
  parseTaskOutputsBlock,
  parseTaskTemplateBlock,
  resultFields,
  evalCondition,
  taskDefStatus,
  metaStatus,
  aggregateInputs,
} from '../src/components/newhome/taskSchema.mjs';

// ── fieldRef ───────────────────────────────────────────────────────────────
test('fieldRef joins taskDefId and key', () => {
  assert.equal(fieldRef('intake', 'customer'), 'intake.customer');
});

// ── task-fields block round-trip ────────────────────────────────────────────
test('buildTaskFieldsBlock → parseTaskFieldsBlock round-trips', () => {
  const block = buildTaskFieldsBlock('tmpl-1', 'intake', { customer: 'Acme', items: '12' });
  const body = `Some notes.\n\n${block}\n`;
  const parsed = parseTaskFieldsBlock(body);
  assert.deepEqual(parsed, {
    templateId: 'tmpl-1',
    taskDefId: 'intake',
    values: { customer: 'Acme', items: '12' },
  });
});

test('parseTaskFieldsBlock defaults missing values to {}', () => {
  const block = buildTaskFieldsBlock('tmpl-1', 'intake', undefined);
  const parsed = parseTaskFieldsBlock(block);
  assert.deepEqual(parsed, { templateId: 'tmpl-1', taskDefId: 'intake', values: {} });
});

test('parseTaskFieldsBlock returns null for missing/malformed input', () => {
  assert.equal(parseTaskFieldsBlock(undefined), null);
  assert.equal(parseTaskFieldsBlock(''), null);
  assert.equal(parseTaskFieldsBlock('no fenced block here'), null);
  assert.equal(parseTaskFieldsBlock('```task-fields\n{not json\n```'), null);
  assert.equal(parseTaskFieldsBlock('```task-fields\n{"values":{}}\n```'), null); // missing ids
  assert.equal(parseTaskFieldsBlock('```task-fields\n[1,2,3]\n```'), null); // not an object
});

// ── task-outputs block round-trip ───────────────────────────────────────────
test('buildTaskOutputsBlock → parseTaskOutputsBlock round-trips', () => {
  const taskDef = {
    id: 'intake',
    name: 'Intake',
    inputs: [],
    outputs: [{ key: 'has_stains', label: 'Stains present?', type: 'bool', required: true }],
  };
  const block = buildTaskOutputsBlock(taskDef);
  const parsed = parseTaskOutputsBlock(block);
  assert.deepEqual(parsed, {
    taskDefId: 'intake',
    fields: [{ key: 'has_stains', label: 'Stains present?', type: 'bool', required: true }],
  });
});

test('parseTaskOutputsBlock filters malformed field entries but keeps well-shaped ones', () => {
  const body = [
    '```task-outputs',
    JSON.stringify({
      taskDefId: 'wash',
      fields: [
        { key: 'ok', label: 'OK?', type: 'bool' },
        { key: 'bad-type', label: 'Bad', type: 'not-a-type' },
        { missing: 'key' },
        'garbage',
      ],
    }),
    '```',
  ].join('\n');
  const parsed = parseTaskOutputsBlock(body);
  assert.equal(parsed.taskDefId, 'wash');
  assert.deepEqual(parsed.fields, [{ key: 'ok', label: 'OK?', type: 'bool' }]);
});

test('parseTaskOutputsBlock returns null for missing/malformed input', () => {
  assert.equal(parseTaskOutputsBlock(null), null);
  assert.equal(parseTaskOutputsBlock('```task-outputs\n{"fields":[]}\n```'), null); // missing taskDefId
  assert.equal(parseTaskOutputsBlock('```task-outputs\nnope\n```'), null);
});

// ── task-template block round-trip ──────────────────────────────────────────
test('buildTaskTemplateBlock → parseTaskTemplateBlock round-trips', () => {
  const taskDefs = [{ id: 'intake' }, { id: 'stain' }, { id: 'wash' }];
  const block = buildTaskTemplateBlock('tmpl-1', taskDefs);
  const parsed = parseTaskTemplateBlock(block);
  assert.deepEqual(parsed, { templateId: 'tmpl-1', taskDefIds: ['intake', 'stain', 'wash'] });
});

test('parseTaskTemplateBlock returns null for missing/malformed input', () => {
  assert.equal(parseTaskTemplateBlock(undefined), null);
  assert.equal(parseTaskTemplateBlock('```task-template\n{"templateId":"x"}\n```'), null); // no taskDefIds
  assert.equal(
    parseTaskTemplateBlock('```task-template\n{"taskDefIds":["a"]}\n```'),
    null,
  ); // no templateId
});

// ── resultFields (submit_task_result type:"fields") ─────────────────────────
test('resultFields extracts taskDefId + fields from a well-shaped fields result', () => {
  const result = {
    type: 'fields',
    payload: { taskDefId: 'intake', fields: { has_stains: 'Yes', count: 3, ok: true } },
  };
  assert.deepEqual(resultFields(result), {
    taskDefId: 'intake',
    fields: { has_stains: 'Yes', count: 3, ok: true },
  });
});

test('resultFields drops non-primitive field values without throwing', () => {
  const result = {
    type: 'fields',
    payload: { taskDefId: 'intake', fields: { good: 'x', bad: { nested: true }, alsoBad: [1, 2] } },
  };
  assert.deepEqual(resultFields(result), { taskDefId: 'intake', fields: { good: 'x' } });
});

test('resultFields returns null for non-"fields" or malformed results', () => {
  assert.equal(resultFields(undefined), null);
  assert.equal(resultFields({ type: 'table', payload: {} }), null);
  assert.equal(resultFields({ type: 'fields', payload: null }), null);
  assert.equal(resultFields({ type: 'fields', payload: { fields: {} } }), null); // no taskDefId
  assert.equal(
    resultFields({ type: 'fields', payload: { taskDefId: 'x', fields: 'nope' } }),
    null,
  );
});

// ── evalCondition ────────────────────────────────────────────────────────
test('evalCondition: no condition → always true', () => {
  assert.equal(evalCondition(null, {}), true);
  assert.equal(evalCondition(undefined, {}), true);
});

test('evalCondition: unknown upstream value → false', () => {
  const cond = { ref: 'intake.has_stains', op: '==', value: 'Yes' };
  assert.equal(evalCondition(cond, {}), false);
  assert.equal(evalCondition(cond, { 'intake.has_stains': undefined }), false);
  assert.equal(evalCondition(cond, null), false);
});

test('evalCondition: == and != compare stringified values', () => {
  assert.equal(evalCondition({ ref: 'a.b', op: '==', value: 'Yes' }, { 'a.b': 'Yes' }), true);
  assert.equal(evalCondition({ ref: 'a.b', op: '==', value: 'Yes' }, { 'a.b': 'No' }), false);
  assert.equal(evalCondition({ ref: 'a.b', op: '!=', value: 'Yes' }, { 'a.b': 'No' }), true);
  // Numeric value stored, string compared in the condition.
  assert.equal(evalCondition({ ref: 'a.b', op: '==', value: 3 }, { 'a.b': 3 }), true);
});

test('evalCondition: < and > compare numerically', () => {
  assert.equal(evalCondition({ ref: 'a.n', op: '<', value: 10 }, { 'a.n': 5 }), true);
  assert.equal(evalCondition({ ref: 'a.n', op: '<', value: 10 }, { 'a.n': 15 }), false);
  assert.equal(evalCondition({ ref: 'a.n', op: '>', value: 10 }, { 'a.n': 15 }), true);
  assert.equal(evalCondition({ ref: 'a.n', op: '>', value: 10 }, { 'a.n': '5' }), false);
});

test('evalCondition: unknown op → false', () => {
  assert.equal(evalCondition({ ref: 'a.b', op: '~=', value: 'x' }, { 'a.b': 'x' }), false);
});

// ── taskDefStatus ──────────────────────────────────────────────────────────
const gatedDef = {
  id: 'stain',
  name: 'Stain treatment',
  inputs: [],
  outputs: [{ key: 'treated', label: 'Treated?', type: 'bool', required: true }],
  neededWhen: { ref: 'intake.has_stains', op: '==', value: 'Yes' },
};

test('taskDefStatus: skip when neededWhen is unmet', () => {
  assert.equal(taskDefStatus(gatedDef, { 'intake.has_stains': 'No' }), 'skip');
  assert.equal(taskDefStatus(gatedDef, {}), 'skip'); // unknown upstream → false → unmet → skip
});

test('taskDefStatus: no required outputs — any output present → done, else pending', () => {
  const noRequired = {
    id: 'note',
    name: 'Note',
    inputs: [],
    outputs: [{ key: 'summary', label: 'Summary', type: 'text' }],
  };
  assert.equal(taskDefStatus(noRequired, {}), 'pending');
  assert.equal(taskDefStatus(noRequired, { 'note.summary': 'done writing' }), 'done');
});

test('taskDefStatus: required outputs — 0/some/all filled → pending/active/done', () => {
  const twoRequired = {
    id: 'wash',
    name: 'Wash',
    inputs: [],
    outputs: [
      { key: 'cycle', label: 'Cycle', type: 'text', required: true },
      { key: 'temp', label: 'Temp', type: 'number', required: true },
    ],
  };
  assert.equal(taskDefStatus(twoRequired, {}), 'pending');
  assert.equal(taskDefStatus(twoRequired, { 'wash.cycle': 'normal' }), 'active');
  assert.equal(
    taskDefStatus(twoRequired, { 'wash.cycle': 'normal', 'wash.temp': 30 }),
    'done',
  );
});

test('taskDefStatus: neededWhen met → normal (non-skip) status derivation applies', () => {
  assert.equal(
    taskDefStatus(gatedDef, { 'intake.has_stains': 'Yes' }),
    'pending',
  );
  assert.equal(
    taskDefStatus(gatedDef, { 'intake.has_stains': 'Yes', 'stain.treated': true }),
    'done',
  );
});

// ── metaStatus ─────────────────────────────────────────────────────────────
test('metaStatus: all non-skip defs done → done', () => {
  const defs = [
    { id: 'a', name: 'A', inputs: [], outputs: [{ key: 'x', label: 'X', type: 'text', required: true }] },
    { id: 'b', name: 'B', inputs: [], outputs: [{ key: 'y', label: 'Y', type: 'text', required: true }] },
  ];
  const values = { 'a.x': '1', 'b.y': '2' };
  assert.equal(metaStatus(defs, values), 'done');
});

test('metaStatus: any done/active among non-skip → active', () => {
  const defs = [
    { id: 'a', name: 'A', inputs: [], outputs: [{ key: 'x', label: 'X', type: 'text', required: true }] },
    { id: 'b', name: 'B', inputs: [], outputs: [{ key: 'y', label: 'Y', type: 'text', required: true }] },
  ];
  assert.equal(metaStatus(defs, { 'a.x': '1' }), 'active');
});

test('metaStatus: nothing started, or everything skipped → pending', () => {
  const defs = [
    { id: 'a', name: 'A', inputs: [], outputs: [{ key: 'x', label: 'X', type: 'text', required: true }] },
  ];
  assert.equal(metaStatus(defs, {}), 'pending');

  const allSkipped = [
    {
      id: 'a',
      name: 'A',
      inputs: [],
      outputs: [],
      neededWhen: { ref: 'z.z', op: '==', value: '1' },
    },
  ];
  assert.equal(metaStatus(allSkipped, {}), 'pending');
});

test('metaStatus: empty task-def list → pending', () => {
  assert.equal(metaStatus([], {}), 'pending');
  assert.equal(metaStatus(undefined, {}), 'pending');
});

// ── aggregateInputs ────────────────────────────────────────────────────────
test('aggregateInputs flattens in task-def order, then field order', () => {
  const defs = [
    {
      id: 'intake',
      name: 'Intake',
      inputs: [
        { key: 'customer', label: 'Customer', type: 'text' },
        { key: 'items', label: 'Items', type: 'number' },
      ],
      outputs: [],
    },
    {
      id: 'wash',
      name: 'Wash',
      inputs: [{ key: 'cycle', label: 'Cycle', type: 'text' }],
      outputs: [],
    },
  ];
  const agg = aggregateInputs(defs);
  assert.deepEqual(
    agg.map((a) => `${a.taskDef.id}.${a.field.key}`),
    ['intake.customer', 'intake.items', 'wash.cycle'],
  );
});

test('aggregateInputs skips task-defs with no inputs and handles an empty/undefined list', () => {
  const defs = [
    { id: 'a', name: 'A', inputs: [], outputs: [] },
    { id: 'b', name: 'B', inputs: [{ key: 'x', label: 'X', type: 'text' }], outputs: [] },
  ];
  assert.deepEqual(
    aggregateInputs(defs).map((a) => a.field.key),
    ['x'],
  );
  assert.deepEqual(aggregateInputs([]), []);
  assert.deepEqual(aggregateInputs(undefined), []);
});
