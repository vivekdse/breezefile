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
  normalizeFieldKey,
  isValidFieldKey,
  effectiveFieldKey,
  inferFieldsFromProse,
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

// ── task-template block round-trip (v2 — task-2fd63b922beb) ────────────────
test('buildTaskTemplateBlock → parseTaskTemplateBlock v2 round-trips full TaskDefs', () => {
  const taskDefs = [
    {
      id: 'intake',
      name: 'Intake',
      notes: 'Collect the drop-off.',
      inputs: [{ key: 'customer', label: 'Customer', type: 'text' }],
      outputs: [{ key: 'has_stains', label: 'Stains present?', type: 'bool', required: true }],
    },
    {
      id: 'stain',
      name: 'Stain treatment',
      neededWhen: { ref: 'intake.has_stains', op: '==', value: 'Yes' },
      inputs: [],
      outputs: [{ key: 'treated', label: 'Treated?', type: 'bool', required: true }],
    },
    { id: 'wash', name: 'Wash', inputs: [], outputs: [] },
  ];
  const block = buildTaskTemplateBlock('Order pipeline', taskDefs);
  const parsed = parseTaskTemplateBlock(block);
  assert.deepEqual(parsed, {
    name: 'Order pipeline',
    defs: [
      {
        id: 'intake',
        name: 'Intake',
        notes: 'Collect the drop-off.',
        inputs: [{ key: 'customer', label: 'Customer', type: 'text' }],
        outputs: [{ key: 'has_stains', label: 'Stains present?', type: 'bool', required: true }],
      },
      {
        id: 'stain',
        name: 'Stain treatment',
        neededWhen: { ref: 'intake.has_stains', op: '==', value: 'Yes' },
        inputs: [],
        outputs: [{ key: 'treated', label: 'Treated?', type: 'bool', required: true }],
      },
      { id: 'wash', name: 'Wash', inputs: [], outputs: [] },
    ],
  });
});

test('parseTaskTemplateBlock v2 sanitizes malformed defs/fields rather than rejecting the block', () => {
  const body = [
    '```task-template',
    JSON.stringify({
      v: 2,
      name: 'Order pipeline',
      defs: [
        { id: 'intake', name: 'Intake', inputs: [{ key: 'c', label: 'C', type: 'text' }], outputs: [] },
        { id: 'bad-no-name' }, // dropped: no name
        'garbage', // dropped: not an object
        {
          id: 'stain',
          name: 'Stain',
          inputs: [{ bad: 'field' }, { key: 'method', label: 'Method', type: 'text' }],
          outputs: [],
          neededWhen: { ref: 'x', op: 'nope', value: 1 }, // malformed condition dropped
        },
      ],
    }),
    '```',
  ].join('\n');
  const parsed = parseTaskTemplateBlock(body);
  assert.equal(parsed.name, 'Order pipeline');
  assert.equal(parsed.defs.length, 2); // 'bad-no-name' and 'garbage' dropped
  assert.equal(parsed.defs[0].id, 'intake');
  assert.equal(parsed.defs[1].id, 'stain');
  assert.deepEqual(parsed.defs[1].inputs, [{ key: 'method', label: 'Method', type: 'text' }]);
  assert.equal(parsed.defs[1].neededWhen, undefined); // malformed condition dropped, not kept
});

test('parseTaskTemplateBlock v1 legacy bodies surface distinctly (name/defs null, legacy populated)', () => {
  const block = '```task-template\n{"templateId":"tmpl-1","taskDefIds":["intake","stain","wash"]}\n```';
  const parsed = parseTaskTemplateBlock(block);
  assert.deepEqual(parsed, {
    name: null,
    defs: null,
    legacy: { templateId: 'tmpl-1', taskDefIds: ['intake', 'stain', 'wash'] },
  });
});

test('parseTaskTemplateBlock returns null for missing/malformed input', () => {
  assert.equal(parseTaskTemplateBlock(undefined), null);
  assert.equal(parseTaskTemplateBlock('```task-template\n{"v":2}\n```'), null); // v2 but no name
  assert.equal(parseTaskTemplateBlock('```task-template\n{"templateId":"x"}\n```'), null); // legacy, no taskDefIds
  assert.equal(
    parseTaskTemplateBlock('```task-template\n{"taskDefIds":["a"]}\n```'),
    null,
  ); // legacy, no templateId
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

// task-2638eeedd9ef: the server adopted FLAT as canonical
// (submit_task_result(type="fields", payload={key: value, ...})) — no
// taskDefId wrapper. resultFields must read this shape too, alongside the
// legacy nested one above (still read so e.g. task-7d65e61fb581 renders).
test('resultFields reads a FLAT (canonical) payload — taskDefId comes back null', () => {
  const result = { type: 'fields', payload: { has_stains: 'Yes', count: 3, ok: true } };
  assert.deepEqual(resultFields(result), {
    taskDefId: null,
    fields: { has_stains: 'Yes', count: 3, ok: true },
  });
});

test('resultFields (flat) drops non-primitive values without throwing', () => {
  const result = { type: 'fields', payload: { good: 'x', bad: { nested: true }, alsoBad: [1, 2] } };
  assert.deepEqual(resultFields(result), { taskDefId: null, fields: { good: 'x' } });
});

test('resultFields (flat) with zero usable entries → null (falls back)', () => {
  assert.equal(resultFields({ type: 'fields', payload: {} }), null);
  assert.equal(resultFields({ type: 'fields', payload: { onlyObj: { a: 1 } } }), null);
});

test('resultFields returns null for non-"fields" or malformed results', () => {
  assert.equal(resultFields(undefined), null);
  assert.equal(resultFields({ type: 'table', payload: {} }), null);
  assert.equal(resultFields({ type: 'fields', payload: null }), null);
});

// `{taskDefId:'x', fields:'nope'}` isn't a valid LEGACY NESTED payload (its
// `fields` isn't an object) — it falls through to the FLAT reading, where
// `taskDefId` and `fields` are just two string-valued keys.
test('resultFields: a not-quite-nested payload (fields not an object) reads as flat', () => {
  assert.deepEqual(resultFields({ type: 'fields', payload: { taskDefId: 'x', fields: 'nope' } }), {
    taskDefId: null,
    fields: { taskDefId: 'x', fields: 'nope' },
  });
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

// task-f8ae99553691 — LIVE E2E repro: an agent's flat `{ok: true}` submit
// (a real boolean) must satisfy a chain-builder condition value typed as the
// string 'Yes' (what the composer UI historically stored before the
// type-constrained input landed) — the bug was `String(true) === 'Yes'` →
// false, silently inverting the gate. Boolean/string-boolean comparisons must
// be normalized on BOTH sides, regardless of which side is the literal bool.
test('evalCondition: boolean actual vs "Yes"/"No" string condition (bug repro)', () => {
  assert.equal(evalCondition({ ref: 'intake.ok', op: '==', value: 'Yes' }, { 'intake.ok': true }), true);
  assert.equal(evalCondition({ ref: 'intake.ok', op: '==', value: 'Yes' }, { 'intake.ok': false }), false);
  assert.equal(evalCondition({ ref: 'intake.ok', op: '==', value: 'No' }, { 'intake.ok': false }), true);
  assert.equal(evalCondition({ ref: 'intake.ok', op: '==', value: 'No' }, { 'intake.ok': true }), false);
  // != mirrors ==.
  assert.equal(evalCondition({ ref: 'intake.ok', op: '!=', value: 'Yes' }, { 'intake.ok': false }), true);
  assert.equal(evalCondition({ ref: 'intake.ok', op: '!=', value: 'Yes' }, { 'intake.ok': true }), false);
});

test('evalCondition: boolean normalization is case-insensitive and symmetric', () => {
  // condition value spelled various cases; actual is a real boolean.
  assert.equal(evalCondition({ ref: 'a.b', op: '==', value: 'yes' }, { 'a.b': true }), true);
  assert.equal(evalCondition({ ref: 'a.b', op: '==', value: 'TRUE' }, { 'a.b': true }), true);
  assert.equal(evalCondition({ ref: 'a.b', op: '==', value: 'False' }, { 'a.b': false }), true);
  // Reversed: actual is a boolean-ish STRING, condition value is a real boolean
  // (the type-constrained composer input now stores a real boolean; this
  // covers a hand-authored/legacy condition storing the reverse shape).
  assert.equal(evalCondition({ ref: 'a.b', op: '==', value: true }, { 'a.b': 'Yes' }), true);
  assert.equal(evalCondition({ ref: 'a.b', op: '==', value: false }, { 'a.b': 'no' }), true);
  assert.equal(evalCondition({ ref: 'a.b', op: '==', value: true }, { 'a.b': 'No' }), false);
});

test('evalCondition: plain string/number equality is unaffected by bool normalization', () => {
  // Neither side is boolean-ish — falls through to the original stringified
  // comparison, unchanged.
  assert.equal(evalCondition({ ref: 'a.b', op: '==', value: 'blue' }, { 'a.b': 'blue' }), true);
  assert.equal(evalCondition({ ref: 'a.b', op: '==', value: 'blue' }, { 'a.b': 'red' }), false);
  assert.equal(evalCondition({ ref: 'a.n', op: '==', value: 3 }, { 'a.n': 3 }), true);
  // A select field whose OPTIONS happen to include 'Yes'/'No' as a business
  // choice (not a bool) still normalizes if the actual matches — this is a
  // known, accepted tradeoff: 'yes'/'no'/'true'/'false' are reserved
  // spellings across select AND bool fields.
  assert.equal(evalCondition({ ref: 'a.b', op: '==', value: 'Yes' }, { 'a.b': 'Yes' }), true);
});

// task-f8ae99553691 — bool/number/select condition round-trips through
// instantiate (valuesByRef merge) → agent-flat-submit (resultFields) →
// evalCondition, mirroring how RosterTable/taskDefStatus actually consume a
// child job's merged values.
test('evalCondition: bool output round-trips through resultFields → valuesByRef', () => {
  const submitted = resultFields({ type: 'fields', payload: { ok: true } });
  assert.deepEqual(submitted, { taskDefId: null, fields: { ok: true } });
  const valuesByRef = { [fieldRef('intake', 'ok')]: submitted.fields.ok };
  assert.equal(
    evalCondition({ ref: 'intake.ok', op: '==', value: 'Yes' }, valuesByRef),
    true,
  );
  assert.equal(
    taskDefStatus(
      {
        id: 'deliver',
        name: 'Deliver',
        inputs: [],
        outputs: [{ key: 'sent', label: 'Sent?', type: 'bool', required: true }],
        neededWhen: { ref: 'intake.ok', op: '==', value: 'Yes' },
      },
      valuesByRef,
    ),
    'pending', // gate met (not 'skip'); no output filled yet → pending, not n/a.
  );
});

test('evalCondition: number condition round-trip through resultFields → valuesByRef', () => {
  const submitted = resultFields({ type: 'fields', payload: { count: 12 } });
  const valuesByRef = { [fieldRef('intake', 'count')]: submitted.fields.count };
  assert.equal(evalCondition({ ref: 'intake.count', op: '>', value: 10 }, valuesByRef), true);
  assert.equal(evalCondition({ ref: 'intake.count', op: '<', value: 10 }, valuesByRef), false);
});

test('evalCondition: select condition round-trip through resultFields → valuesByRef', () => {
  const submitted = resultFields({ type: 'fields', payload: { grade: 'B' } });
  const valuesByRef = { [fieldRef('intake', 'grade')]: submitted.fields.grade };
  assert.equal(evalCondition({ ref: 'intake.grade', op: '==', value: 'B' }, valuesByRef), true);
  assert.equal(evalCondition({ ref: 'intake.grade', op: '==', value: 'A' }, valuesByRef), false);
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

// ── field key normalization (task-f9a723379aa8) ─────────────────────────────
// USER REPRO: a composer input field labeled "News site url" with a typed
// value ("test") produced a created task with data_keys: [] — the input
// VALUE never reached the server data bag, even though output_schema landed
// fine. Root cause: the composer's save-assembly used the field's raw,
// un-normalized `key` (which can contain spaces/uppercase straight from a
// label-derived or user-typed string) to key the `data` map, with no
// validation catching a malformed key before send. These tests guard the
// normalization contract the fix relies on.

test('normalizeFieldKey lowercases, trims, and collapses invalid runs to underscores', () => {
  assert.equal(normalizeFieldKey('News site url'), 'news_site_url');
  assert.equal(normalizeFieldKey('  Customer Name  '), 'customer_name');
  assert.equal(normalizeFieldKey('patient.ssn'), 'patient.ssn');
  assert.equal(normalizeFieldKey('already-valid_key.1'), 'already-valid_key.1');
  assert.equal(normalizeFieldKey(''), '');
  assert.equal(normalizeFieldKey(undefined), '');
  assert.equal(normalizeFieldKey(null), '');
  // all-invalid-character input (e.g. just punctuation/emoji) trims to ''
  assert.equal(normalizeFieldKey('!!!'), '');
});

test('isValidFieldKey normalizes-then-checks (mirrors taskDataInputs.mjs), and rejects all-invalid input', () => {
  assert.equal(isValidFieldKey('news_site_url'), true);
  assert.equal(isValidFieldKey('patient.ssn'), true);
  // "News site url" normalizes to 'news_site_url', which IS well-formed —
  // isValidFieldKey checks the NORMALIZED shape, same contract as
  // normalizeDataKey/isValidDataKey in taskDataInputs.mjs.
  assert.equal(isValidFieldKey('News site url'), true);
  assert.equal(isValidFieldKey(''), false);
  assert.equal(isValidFieldKey('!!!'), false); // nothing survives normalization
});

test('effectiveFieldKey normalizes a typed key when present', () => {
  const field = { key: 'News site url', label: 'News site URL', type: 'text' };
  assert.equal(effectiveFieldKey(field), 'news_site_url');
});

test('effectiveFieldKey derives from label when key is blank', () => {
  const field = { key: '', label: 'News site url', type: 'text' };
  assert.equal(effectiveFieldKey(field), 'news_site_url');
});

test('effectiveFieldKey is "" when neither key nor label yields anything valid', () => {
  assert.equal(effectiveFieldKey({ key: '', label: '', type: 'text' }), '');
  assert.equal(effectiveFieldKey({ key: '   ', label: '!!!', type: 'text' }), '');
  assert.equal(effectiveFieldKey(null), '');
  assert.equal(effectiveFieldKey(undefined), '');
});

// ── composer save-assembly regression guard ────────────────────────────────
// Reconstructs TaskComposer.tsx's dataForSave-building loop (the fix) from
// field defs + typed answers, without importing React. Proves the exact
// repro shape — a spaces/uppercase label field with a filled value — now
// lands in the assembled `data` map under the normalized key, matching what
// get_task's data_keys / resolve should show server-side.
function buildDataForSave(taskInputs, templateValues) {
  const inputVals = {};
  for (const f of taskInputs) {
    const key = effectiveFieldKey(f);
    if (!key) continue;
    const v = templateValues[fieldRef('task', f.key)] ?? '';
    if (v !== '') inputVals[key] = v;
  }
  return Object.keys(inputVals).length > 0 ? inputVals : undefined;
}

test('composer save-assembly: "News site url" input with a value populates data under the normalized key (task-f9a723379aa8 regression guard)', () => {
  const taskInputs = [
    { key: 'News site url', label: 'News site url', type: 'text' },
    { key: 'Headline count', label: 'Headline count', type: 'number' },
  ];
  const templateValues = {
    [fieldRef('task', 'News site url')]: 'FAKE_VALUE_not_a_real_url',
    [fieldRef('task', 'Headline count')]: '2',
  };
  const data = buildDataForSave(taskInputs, templateValues);
  assert.deepEqual(data, {
    news_site_url: 'FAKE_VALUE_not_a_real_url',
    headline_count: '2',
  });
  // Never silently drop: both fields' keys land, not an empty bag.
  assert.equal(Object.keys(data).length, 2);
});

test('composer save-assembly: a key-blank, label-only field still saves under the label-derived key', () => {
  const taskInputs = [{ key: '', label: 'News site url', type: 'text' }];
  const templateValues = { [fieldRef('task', '')]: 'FAKE_VALUE' };
  const data = buildDataForSave(taskInputs, templateValues);
  assert.deepEqual(data, { news_site_url: 'FAKE_VALUE' });
});

test('composer save-assembly: an empty field (no key, no label, no value) contributes nothing', () => {
  const taskInputs = [{ key: '', label: '', type: 'text' }];
  const templateValues = {};
  assert.equal(buildDataForSave(taskInputs, templateValues), undefined);
});

// ── inferFieldsFromProse (task-fe8c822c3838) ──────────────────────────────

test('inferFieldsFromProse: task-22fdf07763ee acceptance case — "Input:"/"Output:" on their own lines', () => {
  const body = 'Input: Site name (or URL)\nOutput: First headline from the site';
  const { inputs, outputs } = inferFieldsFromProse(body);
  assert.equal(inputs.length, 1);
  assert.equal(outputs.length, 1);
  assert.equal(inputs[0].key, 'site_name');
  assert.equal(inputs[0].label, 'Site name (or URL)');
  assert.equal(inputs[0].type, 'text');
  assert.equal(inputs[0].urlHint, true);
  assert.equal(outputs[0].key, 'first_headline');
  assert.equal(outputs[0].label, 'First headline from the site');
});

test('inferFieldsFromProse: plural "Inputs:"/"Outputs:" headers are recognized', () => {
  const { inputs, outputs } = inferFieldsFromProse('Inputs: Customer name\nOutputs: Summary of the call');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].key, 'customer_name');
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].label, 'Summary of the call');
});

test('inferFieldsFromProse: bulleted "- Input: X" lines are recognized (leading marker stripped)', () => {
  const { inputs } = inferFieldsFromProse('- Input: Company website\n* Input: Contact email\n1. Input: Region');
  assert.equal(inputs.length, 3);
  assert.deepEqual(inputs.map((f) => f.key), ['company_website', 'contact_email', 'region']);
});

test('inferFieldsFromProse: verb forms "needs ..." / "produces ..." are recognized (line-leading)', () => {
  const { inputs, outputs } = inferFieldsFromProse(
    'needs a customer email address.\nproduces a summary of the call.',
  );
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].label, 'a customer email address');
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].label, 'a summary of the call');
});

test('inferFieldsFromProse: a slash-packed single line ("Input: X / Output: Y") is split into both sides', () => {
  const { inputs, outputs } = inferFieldsFromProse('Input: Site name / Output: First headline');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].key, 'site_name');
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].key, 'first_headline');
});

test('inferFieldsFromProse: URL-flavored label stays type "text" (only schema-valid type) but sets urlHint', () => {
  const { inputs } = inferFieldsFromProse('Input: Company website URL');
  assert.equal(inputs[0].type, 'text');
  assert.equal(inputs[0].urlHint, true);
});

test('inferFieldsFromProse: plain (non-URL) label defaults to type "text" with no urlHint', () => {
  const { inputs } = inferFieldsFromProse('Input: Customer name');
  assert.equal(inputs[0].type, 'text');
  assert.equal(inputs[0].urlHint, undefined);
});

test('inferFieldsFromProse: dedupes repeated inputs by normalized key, first occurrence wins', () => {
  const { inputs } = inferFieldsFromProse('Input: Customer Name\nInput: customer name\nInput: Customer  Name!!');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].key, 'customer_name');
  assert.equal(inputs[0].label, 'Customer Name');
});

test('inferFieldsFromProse: plain prose with no input/output intent yields no suggestion', () => {
  assert.deepEqual(inferFieldsFromProse('Just some notes about this task, nothing structured here.'), {
    inputs: [],
    outputs: [],
  });
});

test('inferFieldsFromProse: empty/whitespace-only/non-string body yields no suggestion (never throws)', () => {
  assert.deepEqual(inferFieldsFromProse(''), { inputs: [], outputs: [] });
  assert.deepEqual(inferFieldsFromProse('   \n  '), { inputs: [], outputs: [] });
  assert.deepEqual(inferFieldsFromProse(null), { inputs: [], outputs: [] });
  assert.deepEqual(inferFieldsFromProse(undefined), { inputs: [], outputs: [] });
  assert.deepEqual(inferFieldsFromProse(42), { inputs: [], outputs: [] });
});

test('inferFieldsFromProse: garbage label ("Input: " with nothing after it) contributes nothing', () => {
  assert.deepEqual(inferFieldsFromProse('Input: \nOutput:   '), { inputs: [], outputs: [] });
});

test('inferFieldsFromProse: every returned field satisfies the TaskDefField shape used by isTaskDefFieldLike', () => {
  const { inputs, outputs } = inferFieldsFromProse('Input: Site name (or URL)\nOutput: First headline from the site');
  for (const f of [...inputs, ...outputs]) {
    assert.equal(typeof f.key, 'string');
    assert.equal(typeof f.label, 'string');
    assert.ok(['text', 'number', 'date', 'select', 'bool'].includes(f.type));
  }
});
