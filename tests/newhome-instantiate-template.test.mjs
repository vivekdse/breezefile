// task-fb31518201da (T4) / task-a7214605a998 (create pass) — unit tests for
// instantiateTemplate (src/components/newhome/newHomePrefs.ts). That file is
// plain TypeScript (not .mjs), and this repo's `node --test` runner has no TS
// loader — but it DOES ship esbuild (used by vite), so this test transpiles
// newHomePrefs.ts on the fly rather than duplicating its logic. The relative
// `from './taskSchema.mjs'` import is rewritten to an absolute file:// URL since
// the transpiled copy is written to a temp file outside src/components/newhome/.
// This exercises the REAL instantiateTemplate source, not a reimplementation.
//
// task-a7214605a998 — instantiateTemplate no longer creates tasks one-at-a-time
// with the chain embedded as ```task-template / ```task-outputs / ```task-fields
// note-blocks. It builds ONE bulk request: a thin parent container + one child
// per step, each carrying its step's fields as FIRST-CLASS task schema
// (outputSchema = output fields; data = input-field keys, values empty at create
// time), with linear ordering via dependsOnIndexes. These tests assert that new
// shape against an injected `bulkCreateTasks` stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { effectiveFieldKey, aggregateInputs } from '../src/components/newhome/taskSchema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'components', 'newhome', 'newHomePrefs.ts');
const taskSchemaUrl = pathToFileURL(
  path.join(here, '..', 'src', 'components', 'newhome', 'taskSchema.mjs'),
).href;

const source = readFileSync(srcPath, 'utf8')
  .replace("from './taskSchema.mjs'", `from '${taskSchemaUrl}'`);

const { code } = esbuild.transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' });

const tmpFile = path.join(tmpdir(), `newHomePrefs.instantiateTemplate.${process.pid}.${Date.now()}.mjs`);
writeFileSync(tmpFile, code);

const { instantiateTemplate } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpFile, { force: true });

// ── fixtures ────────────────────────────────────────────────────────────

function makeDefs() {
  return [
    {
      id: 'intake',
      name: 'Intake',
      notes: 'Collect the customer drop-off.',
      inputs: [{ key: 'customer', label: 'Customer', type: 'text' }],
      outputs: [{ key: 'has_stains', label: 'Stains present?', type: 'bool', required: true }],
    },
    {
      id: 'stain',
      name: 'Stain treatment',
      // conditional on intake.has_stains == "Yes" — instantiation must NOT
      // filter this out; only rendering/status derivation does.
      neededWhen: { ref: 'intake.has_stains', op: '==', value: 'Yes' },
      inputs: [{ key: 'method', label: 'Method', type: 'text' }],
      outputs: [{ key: 'treated', label: 'Treated?', type: 'bool', required: true }],
    },
    {
      id: 'wash',
      name: 'Wash',
      inputs: [],
      outputs: [{ key: 'done', label: 'Done?', type: 'bool', required: true }],
    },
  ];
}

/** A `bulkCreateTasks` stub that records the ONE call it receives and returns
 *  fabricated ids in the server's shape: [parentId, child0, child1, ...]. */
function stubBulk(captured, { fail } = {}) {
  return async (input) => {
    captured.push(input);
    if (fail) throw new Error('boom bulk create');
    const ids = ['p1', ...input.tasks.map((_, i) => `c${i + 1}`)];
    return { parentId: 'p1', ids };
  };
}

// ── one bulk call: thin parent + first-class children + linear ordering ─────

test('instantiateTemplate makes ONE bulk call: a thin parent container + one child per task-def with first-class fields, linearly ordered', async () => {
  const captured = [];
  const result = await instantiateTemplate({
    name: 'Order #42',
    projectId: 'proj-1',
    defs: makeDefs(),
    values: { 'intake.customer': 'Acme Cleaners', 'stain.method': 'enzymatic' },
    bulkCreateTasks: stubBulk(captured),
  });

  assert.equal(captured.length, 1, 'exactly ONE bulk round-trip for the whole chain');
  const { parent, tasks } = captured[0];

  // parent is a THIN container — title + project only, no note-blocks, no fields.
  assert.deepEqual(parent, { title: 'Order #42', projectId: 'proj-1' });

  assert.equal(tasks.length, 3); // ALL task-defs, incl. the conditional one

  // intake child — its own title/body + first-class output_schema + data (input
  // field key, value collected). First step => no ordering dep.
  const [intake, stain, wash] = tasks;
  assert.equal(intake.title, 'Intake');
  assert.equal(intake.notes, 'Collect the customer drop-off.');
  assert.equal(intake.projectId, 'proj-1');
  assert.deepEqual(intake.outputSchema, [
    { key: 'has_stains', label: 'Stains present?', type: 'bool', required: true },
  ]);
  assert.deepEqual(intake.data, { customer: 'Acme Cleaners' });
  assert.equal(intake.dependsOnIndexes, undefined);

  // stain child (conditional): STILL created, ordered after intake (index 0).
  assert.equal(stain.title, 'Stain treatment');
  assert.deepEqual(stain.outputSchema, [
    { key: 'treated', label: 'Treated?', type: 'bool', required: true },
  ]);
  assert.deepEqual(stain.data, { method: 'enzymatic' });
  assert.deepEqual(stain.dependsOnIndexes, [0]);

  // wash child: ordered after stain (index 1); no inputs => no data bag.
  assert.equal(wash.title, 'Wash');
  assert.deepEqual(wash.outputSchema, [
    { key: 'done', label: 'Done?', type: 'bool', required: true },
  ]);
  assert.equal(wash.data, undefined);
  assert.deepEqual(wash.dependsOnIndexes, [1]);

  // result maps the returned ids: parent first, then children in step order.
  assert.equal(result.parentId, 'p1');
  assert.deepEqual(result.childIds, ['c1', 'c2', 'c3']);
});

// ── empty values map: fields DEFINED (keys present), values empty ───────────

test('instantiateTemplate with an empty values map still declares each step`s input-field keys (empty values) + its output_schema', async () => {
  const captured = [];
  await instantiateTemplate({
    name: 'Order',
    defs: makeDefs(),
    values: {}, // creation defines fields, collects no values
    bulkCreateTasks: stubBulk(captured),
  });
  const { tasks } = captured[0];

  // intake/stain declare their input key with an EMPTY value (defines data_keys).
  assert.deepEqual(tasks[0].data, { customer: '' });
  assert.deepEqual(tasks[1].data, { method: '' });
  // wash has no inputs => no data bag at all.
  assert.equal(tasks[2].data, undefined);

  // outputs (the evidence contract) still ride every child, first-class.
  assert.deepEqual(tasks[0].outputSchema, [
    { key: 'has_stains', label: 'Stains present?', type: 'bool', required: true },
  ]);
});

// ── no projectId ────────────────────────────────────────────────────────────

test('instantiateTemplate omits projectId entirely when none is given', async () => {
  const captured = [];
  await instantiateTemplate({
    name: 'Order',
    defs: makeDefs(),
    values: {},
    bulkCreateTasks: stubBulk(captured),
  });
  const { parent, tasks } = captured[0];
  assert.ok(!('projectId' in parent), 'parent projectId key absent, not undefined-valued');
  for (const t of tasks) {
    assert.ok(!('projectId' in t), 'child projectId key absent, not undefined-valued');
  }
});

// ── failure propagation ──────────────────────────────────────────────────────

test('instantiateTemplate propagates a bulk-create failure', async () => {
  const captured = [];
  await assert.rejects(
    () =>
      instantiateTemplate({
        name: 'Order',
        defs: makeDefs(),
        values: {},
        bulkCreateTasks: stubBulk(captured, { fail: true }),
      }),
    /boom bulk create/,
  );
});

// ── empty chain guarded ──────────────────────────────────────────────────────

test('instantiateTemplate rejects an empty chain (a chain is an ordered list of tasks)', async () => {
  const captured = [];
  await assert.rejects(
    () =>
      instantiateTemplate({
        name: 'Empty job',
        defs: [],
        values: {},
        bulkCreateTasks: stubBulk(captured),
      }),
    /at least one step/,
  );
  assert.equal(captured.length, 0, 'no bulk call for an empty chain');
});

// ── from-template chain: instantiateTemplate with COLLECTED values ──────────
// The from-template flow fills values in at creation via the same seam — the
// collected values land in each child's first-class `data` bag.

test('from-template chain: collected values populate each child`s data bag; project inherited on parent + every child', async () => {
  const captured = [];
  await instantiateTemplate({
    name: 'Order #99',
    projectId: 'proj-inherited',
    defs: makeDefs(),
    values: { 'intake.customer': 'Acme Cleaners', 'stain.method': 'enzymatic' },
    bulkCreateTasks: stubBulk(captured),
  });
  const { parent, tasks } = captured[0];

  assert.equal(parent.projectId, 'proj-inherited');
  for (const t of tasks) assert.equal(t.projectId, 'proj-inherited');

  assert.deepEqual(tasks[0].data, { customer: 'Acme Cleaners' });
  assert.deepEqual(tasks[1].data, { method: 'enzymatic' });
  // wash got no typed value (none collected) and has no inputs => no data bag.
  assert.equal(tasks[2].data, undefined);
});

// ── task-257bb4870c6c — "New from Template" single-task assembly contract ────
//
// The from-template SINGLE-task flow (TaskComposer.saveFromTemplate) reuses
// aggregateInputs + effectiveFieldKey to turn a template's field DEFS + collected
// VALUES into a first-class create payload (data + inherited output_schema),
// asking ZERO other questions. It does NOT go through instantiateTemplate (that
// is the chained path), so these tests exercise the shared taskSchema seams
// directly — unchanged by the create-pass refactor.

function makeSingleTaskTemplateDef() {
  return {
    id: 'task',
    name: 'Get second headline',
    inputs: [{ key: 'news_site_url', label: 'news_site_url', type: 'text' }],
    outputs: [{ key: 'headline', label: 'Second headline', type: 'text', required: true }],
  };
}

/** Pure re-implementation of saveFromTemplate()'s single-task payload assembly
 *  (outputSchema/data only). Mirrors the real function line for line:
 *  effectiveFieldKey normalizes each input's key before writing its value. */
function assembleSingleTemplateData(def, values) {
  const data = {};
  for (const f of def.inputs ?? []) {
    const key = effectiveFieldKey(f);
    if (!key) continue;
    data[key] = values[`${def.id}.${f.key}`] ?? '';
  }
  return {
    ...((def.outputs ?? []).length > 0 ? { outputSchema: def.outputs } : {}),
    ...(Object.keys(data).length > 0 ? { data } : {}),
  };
}

test('from-template single task: one input value collected -> data populated (normalized) + inherited output_schema, zero other fields asked', () => {
  const def = makeSingleTaskTemplateDef();
  const collected = { 'task.news_site_url': 'https://cnn.com' };

  const entries = aggregateInputs([def]);
  assert.equal(entries.length, 1, 'exactly one value question — the single input field');

  const payload = assembleSingleTemplateData(def, collected);
  assert.deepEqual(payload.data, { news_site_url: 'https://cnn.com' });
  assert.deepEqual(payload.outputSchema, [
    { key: 'headline', label: 'Second headline', type: 'text', required: true },
  ]);
});

test('from-template single task: a messy/blank field key still normalizes via effectiveFieldKey, never silently dropping the typed value', () => {
  const def = {
    id: 'task',
    name: 'Headline check',
    inputs: [{ key: '', label: 'News site URL', type: 'text' }], // blank key, label only
    outputs: [],
  };
  const collected = { 'task.': 'https://cnn.com' };
  const payload = assembleSingleTemplateData(def, collected);
  assert.deepEqual(payload.data, { news_site_url: 'https://cnn.com' });
  assert.ok(!('outputSchema' in payload), 'no outputs defined -> outputSchema omitted, not empty-arrayed');
});

test('from-template single task: no input fields at all -> no data key, still fine (zero questions asked)', () => {
  const def = { id: 'task', name: 'No-input task', inputs: [], outputs: [] };
  const entries = aggregateInputs([def]);
  assert.equal(entries.length, 0);
  const payload = assembleSingleTemplateData(def, {});
  assert.ok(!('data' in payload));
  assert.ok(!('outputSchema' in payload));
});
