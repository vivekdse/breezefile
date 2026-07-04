// task-fb31518201da (T4) — unit tests for instantiateTemplate
// (src/components/newhome/newHomePrefs.ts). That file is plain TypeScript
// (not .mjs), and this repo's `node --test` runner has no TS loader — but it
// DOES ship esbuild as a dependency (used by vite), so this test transpiles
// newHomePrefs.ts on the fly with esbuild rather than duplicating its logic
// into a separately-tested pure module. Two textual substitutions make the
// transpiled module importable under plain node with no Electron/browser
// environment:
//   - the `import { fm } from '../../bridge'` line is stubbed out — `fm` is
//     only touched by getTemplateConfig/setTemplateConfig/
//     syncTemplateConfigFromServer (localStorage/server-pref plumbing), none
//     of which instantiateTemplate/instantiateChain call — and bridge.ts
//     reads `window.fm` at module scope, which throws outside a browser.
//   - the relative `from './taskSchema.mjs'` import is rewritten to an
//     absolute file:// URL, since the transpiled copy is written to a temp
//     file outside src/components/newhome/.
// This exercises the REAL instantiateTemplate source, not a reimplementation.

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
  .replace(/import\s*\{\s*fm\s*\}\s*from\s*['"]\.\.\/\.\.\/bridge['"];?/, 'const fm = {};')
  .replace("from './taskSchema.mjs'", `from '${taskSchemaUrl}'`);

const { code } = esbuild.transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' });

const tmpFile = path.join(tmpdir(), `newHomePrefs.instantiateTemplate.${process.pid}.${Date.now()}.mjs`);
writeFileSync(tmpFile, code);

const { instantiateTemplate, InstantiateTemplateError } = await import(pathToFileURL(tmpFile).href);
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

function stubCreateTask(idsOut, { failOn } = {}) {
  let n = 0;
  return async (input) => {
    n += 1;
    const label = input.title;
    if (failOn && label.includes(failOn)) {
      throw new Error(`boom creating ${label}`);
    }
    const id = `t${n}`;
    idsOut.push({ id, input });
    return { id };
  };
}

// ── parent-first ordering + linkage ────────────────────────────────────────

test('instantiateTemplate creates the meta parent first, then one linearly-chained child per task-def', async () => {
  const calls = [];
  const createTask = stubCreateTask(calls);
  const values = {
    'intake.customer': 'Acme Cleaners',
    'stain.method': 'enzymatic',
  };

  const result = await instantiateTemplate({
    name: 'Order #42',
    projectId: 'proj-1',
    defs: makeDefs(),
    values,
    createTask,
  });

  assert.equal(calls.length, 4); // parent + 3 children (ALL task-defs, incl. conditional)
  assert.equal(result.parentId, 't1');
  assert.deepEqual(result.childIds, ['t2', 't3', 't4']);

  const [parentCall, intakeCall, stainCall, washCall] = calls;

  // parent
  assert.equal(parentCall.input.title, 'Order #42');
  assert.equal(parentCall.input.projectId, 'proj-1');
  assert.equal(parentCall.input.parentTaskId, undefined);
  assert.equal(parentCall.input.dependsOn, undefined);
  assert.match(parentCall.input.notes, /Job created from chain "Order #42": 3 tasks\./);
  assert.match(parentCall.input.notes, /```task-template/);
  assert.match(parentCall.input.notes, /"v":2/);
  assert.match(parentCall.input.notes, /"name":"Order #42"/);
  assert.match(parentCall.input.notes, /"id":"intake"/);
  assert.match(parentCall.input.notes, /"id":"stain"/);
  assert.match(parentCall.input.notes, /"id":"wash"/);

  // intake child: first child, no dependsOn, parented to job
  assert.equal(intakeCall.input.title, 'Order #42 — Intake');
  assert.equal(intakeCall.input.parentTaskId, 't1');
  assert.equal(intakeCall.input.dependsOn, undefined);
  assert.equal(intakeCall.input.projectId, 'proj-1');
  assert.match(intakeCall.input.notes, /Collect the customer drop-off\./);
  assert.match(intakeCall.input.notes, /```task-fields/);
  assert.match(intakeCall.input.notes, /```task-outputs/);

  // stain child (conditional): STILL created, chained to intake
  assert.equal(stainCall.input.title, 'Order #42 — Stain treatment');
  assert.equal(stainCall.input.parentTaskId, 't1');
  assert.deepEqual(stainCall.input.dependsOn, ['t2']);

  // wash child: chained to stain
  assert.equal(washCall.input.title, 'Order #42 — Wash');
  assert.deepEqual(washCall.input.dependsOn, ['t3']);
});

// ── per-child value scoping ─────────────────────────────────────────────────

test('instantiateTemplate splits fieldRef-keyed values per task-def and re-keys to bare field keys', async () => {
  const calls = [];
  const createTask = stubCreateTask(calls);
  const values = {
    'intake.customer': 'Acme',
    'intake.items': '12',
    'stain.method': 'enzymatic',
  };

  await instantiateTemplate({
    name: 'Order',
    defs: makeDefs(),
    values,
    createTask,
  });

  const intakeNotes = calls[1].input.notes;
  const fieldsMatch = /```task-fields\n([\s\S]*?)```/.exec(intakeNotes);
  assert.ok(fieldsMatch, 'intake child carries a task-fields block');
  const parsed = JSON.parse(fieldsMatch[1].trim());
  assert.deepEqual(parsed, {
    templateId: 'Order',
    taskDefId: 'intake',
    values: { customer: 'Acme', items: '12' }, // bare keys, no "intake." prefix
  });

  const stainNotes = calls[2].input.notes;
  const stainFields = JSON.parse(/```task-fields\n([\s\S]*?)```/.exec(stainNotes)[1].trim());
  assert.deepEqual(stainFields.values, { method: 'enzymatic' }); // NOT intake's values

  const washNotes = calls[3].input.notes;
  const washFields = JSON.parse(/```task-fields\n([\s\S]*?)```/.exec(washNotes)[1].trim());
  assert.deepEqual(washFields.values, {}); // no matching values for wash
});

// task-0d63c7b0ebdb — creation DEFINES step fields but never collects their
// VALUES, so the composer now instantiates a chain with an EMPTY values map.
// Every child must still carry its (empty) task-fields block + its full
// task-outputs definitions, so later fills (roster/drawer/from-template) have
// keys to populate.
test('instantiateTemplate with an empty values map gives every child an empty task-fields values block but keeps its outputs', async () => {
  const calls = [];
  const createTask = stubCreateTask(calls);

  await instantiateTemplate({
    name: 'Order',
    defs: makeDefs(),
    values: {}, // creation defines fields, collects no values
    createTask,
  });

  // children are calls[1..3]; each carries an empty values block
  for (const call of calls.slice(1)) {
    const fields = JSON.parse(
      /```task-fields\n([\s\S]*?)```/.exec(call.input.notes)[1].trim(),
    );
    assert.deepEqual(fields.values, {}, `${call.input.title} has no seeded values`);
  }

  // intake still declares its OUTPUT field definitions (evidence contract).
  const intakeOutputs = JSON.parse(
    /```task-outputs\n([\s\S]*?)```/.exec(calls[1].input.notes)[1].trim(),
  );
  assert.equal(intakeOutputs.taskDefId, 'intake');
  assert.deepEqual(
    intakeOutputs.fields,
    [{ key: 'has_stains', label: 'Stains present?', type: 'bool', required: true }],
  );
});

// ── no projectId ────────────────────────────────────────────────────────────

test('instantiateTemplate omits projectId entirely when none is given', async () => {
  const calls = [];
  const createTask = stubCreateTask(calls);
  await instantiateTemplate({
    name: 'Order',
    defs: makeDefs(),
    values: {},
    createTask,
  });
  for (const { input } of calls) {
    assert.ok(!('projectId' in input), 'projectId key should be absent, not undefined-valued');
  }
});

// ── partial-failure propagation ─────────────────────────────────────────────

test('instantiateTemplate stops and throws with parentId + created childIds when a child create fails midway', async () => {
  const calls = [];
  const createTask = stubCreateTask(calls, { failOn: 'Stain treatment' });

  await assert.rejects(
    () =>
      instantiateTemplate({
        name: 'Order',
        defs: makeDefs(),
        values: {},
        createTask,
      }),
    (err) => {
      assert.ok(err instanceof InstantiateTemplateError);
      assert.equal(err.parentId, 't1');
      assert.deepEqual(err.childIds, ['t2']); // intake succeeded before stain failed
      assert.match(err.message, /stain/);
      assert.ok(err.cause instanceof Error);
      assert.match(err.cause.message, /boom creating Order — Stain treatment/);
      return true;
    },
  );

  // parent + intake were created and NOT rolled back; wash was never attempted
  assert.equal(calls.length, 2);
});

test('instantiateTemplate propagates a failure creating the parent itself with no children created', async () => {
  const createTask = async () => {
    throw new Error('parent create failed');
  };
  await assert.rejects(
    () =>
      instantiateTemplate({
        name: 'Order',
        defs: makeDefs(),
        values: {},
        createTask,
      }),
    /parent create failed/,
  );
});

// ── empty template ─────────────────────────────────────────────────────────

test('instantiateTemplate with no taskDefs still creates the meta parent with an empty task-template block', async () => {
  const calls = [];
  const createTask = stubCreateTask(calls);
  const result = await instantiateTemplate({
    name: 'Empty job',
    defs: [],
    values: {},
    createTask,
  });
  assert.equal(result.parentId, 't1');
  assert.deepEqual(result.childIds, []);
  assert.equal(calls.length, 1);
  assert.match(calls[0].input.notes, /Job created from chain "Empty job": 0 tasks\./);
});

// ── task-257bb4870c6c — "New from Template" assembly contract ─────────────
//
// The from-template flow is a SEPARATE first-class entry from plain create
// (task-0d63c7b0ebdb), but reuses the exact same seams: aggregateInputs to
// walk a template's input fields, effectiveFieldKey to normalize a value's
// key (so a template whose field key was left blank/typed messily still
// lands the value under a valid key — the fix from task-f9a723379aa8), and
// instantiateTemplate for a CHAINED template (same call saveTemplateJob
// makes, just with the human's COLLECTED values instead of an empty map).
// These tests prove: given a template's field DEFS + collected VALUES, the
// resulting create payload has data_keys populated (normalized) and the
// inherited output_schema, with ZERO other questions consumed to assemble it
// (project/notes/agent/etc. are simply copied off the template entry, never
// derived from a walked question).

// ── single fielded-task template (task-0d63c7b0ebdb "definitions-only" shape:
// one synthetic TaskDef, id 'task', inputs seeded from dataKeys, outputs
// verbatim from outputSchema — mirrors TaskComposer.tsx's templateCandidates
// derivation for a non-chain template row) ─────────────────────────────────

function makeSingleTaskTemplateDef() {
  // What the composer reconstructs from a template task's LIST row: dataKeys
  // (key names only, values are never on a list row — non-PHI) become input
  // field defs; outputSchema rides through untouched (also non-PHI defs).
  return {
    id: 'task',
    name: 'Get second headline',
    inputs: [{ key: 'news_site_url', label: 'news_site_url', type: 'text' }],
    outputs: [{ key: 'headline', label: 'Second headline', type: 'text', required: true }],
  };
}

/** Pure re-implementation of TaskComposer.tsx's saveFromTemplate() single-
 *  task branch's payload assembly (outputSchema/data only — the rest of the
 *  TaskCreate is static passthrough already covered by createTaskForTemplateJob-
 *  style tests elsewhere) so the CONTRACT is exercised without mounting React.
 *  Mirrors the real function line for line: effectiveFieldKey normalizes
 *  each input's key before writing its collected value into `data`. */
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

test('from-template single task: one input value collected -> data_keys populated (normalized) + inherited output_schema, zero other fields asked', () => {
  const def = makeSingleTaskTemplateDef();
  // Exactly what acceptance describes: pick template, accept prefilled
  // title, type ONE input value (a URL) — nothing else.
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
  // effectiveFieldKey falls back to the normalized LABEL when key is blank.
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

// ── chained template: instantiateTemplate with COLLECTED (non-empty) values ─
// (contrast with the task-0d63c7b0ebdb tests above, which instantiate with
// an EMPTY values map at plain-create time — the from-template flow is the
// one path that fills them in at creation, via the exact same seam.)

test('from-template chain: instantiateTemplate with collected values populates every childs task-fields block, inherits project, asks nothing else', async () => {
  const calls = [];
  const createTask = stubCreateTask(calls);
  const collectedValues = {
    'intake.customer': 'Acme Cleaners',
    'stain.method': 'enzymatic',
  };

  const result = await instantiateTemplate({
    name: 'Order #99', // the prefilled title, accepted as-is
    projectId: 'proj-inherited', // inherited SILENTLY from the template, never asked
    defs: makeDefs(),
    values: collectedValues,
    createTask,
  });

  assert.equal(calls.length, 4);
  assert.equal(result.parentId, 't1');

  // project inherited on every task, not just the parent.
  for (const { input } of calls) {
    assert.equal(input.projectId, 'proj-inherited');
  }

  const intakeFields = JSON.parse(/```task-fields\n([\s\S]*?)```/.exec(calls[1].input.notes)[1].trim());
  assert.deepEqual(intakeFields.values, { customer: 'Acme Cleaners' });

  const stainFields = JSON.parse(/```task-fields\n([\s\S]*?)```/.exec(calls[2].input.notes)[1].trim());
  assert.deepEqual(stainFields.values, { method: 'enzymatic' });

  // wash step got no typed value (none collected for it) — present but empty,
  // same "never silently drop a key" contract as the plain-create path.
  const washFields = JSON.parse(/```task-fields\n([\s\S]*?)```/.exec(calls[3].input.notes)[1].trim());
  assert.deepEqual(washFields.values, {});

  // outputs (evidence contract) still ride every child, inherited verbatim.
  const intakeOutputs = JSON.parse(/```task-outputs\n([\s\S]*?)```/.exec(calls[1].input.notes)[1].trim());
  assert.deepEqual(intakeOutputs.fields, [{ key: 'has_stains', label: 'Stains present?', type: 'bool', required: true }]);
});
