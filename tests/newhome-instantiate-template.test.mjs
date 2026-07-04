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
