// task-fb31518201da (T4) / task-a7214605a998 (template-picker model) — unit
// tests for instantiateChain (src/components/newhome/newHomePrefs.ts). That file
// is plain TypeScript; this repo's `node --test` runner has no TS loader, but it
// ships esbuild (used by vite), so we transpile newHomePrefs.ts on the fly
// rather than duplicating its logic. This exercises the REAL source.
//
// task-a7214605a998 — a CHAIN IS A HIGHER-ORDER TEMPLATE: an ORDERED LIST OF
// SAVED TEMPLATES. instantiateChain creates a thin parent container, then
// instantiates each referenced template IN ORDER into a real child, linking each
// to the parent (parent_task_id) and its predecessor (depends_on). The
// instantiate endpoint accepts neither link field, so linkage is a second pass —
// modeled here by the injected createParent/instantiateTemplate/linkTask thunks.

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

const source = readFileSync(srcPath, 'utf8');
const { code } = esbuild.transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' });

const tmpFile = path.join(tmpdir(), `newHomePrefs.instantiateChain.${process.pid}.${Date.now()}.mjs`);
writeFileSync(tmpFile, code);

const { instantiateChain, InstantiateChainError } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpFile, { force: true });

// ── stub thunks recording their calls in order ──────────────────────────────

function makeStubs(calls, { failOn } = {}) {
  return {
    createParent: async (input) => {
      calls.push(['parent', input]);
      return { id: 'p1' };
    },
    instantiateTemplate: async (templateId, opts) => {
      if (failOn && templateId === failOn) throw new Error(`boom ${templateId}`);
      calls.push(['inst', templateId, opts]);
      const n = calls.filter((c) => c[0] === 'inst').length;
      return { id: `c${n}` };
    },
    linkTask: async (taskId, patch) => {
      calls.push(['link', taskId, patch]);
    },
  };
}

// ── parent-first + ordered instantiate + parent/predecessor linkage ─────────

// task-1b70093cc04e perf — instantiate + link now run in PARALLEL (all
// templates instantiated, THEN all links), not interleaved one-by-one, so the
// order is: parent, [inst × N] (in template order), [link × N] (in child
// order). Ordering/linkage semantics are unchanged — depends_on still chains
// each child to its predecessor.
test('instantiateChain creates a thin parent, instantiates all templates in order, then links parent + predecessor', async () => {
  const calls = [];
  const result = await instantiateChain({
    name: 'Order #42',
    projectId: 'proj-1',
    templates: [
      { templateId: 't-a', name: 'A' },
      { templateId: 't-b', name: 'B' },
      { templateId: 't-c', name: 'C' },
    ],
    ...makeStubs(calls),
  });

  // parent FIRST — a thin { title, projectId } container.
  assert.deepEqual(calls[0], ['parent', { title: 'Order #42', projectId: 'proj-1' }]);

  // then instantiate every template IN ORDER (parallel batch, recorded in
  // template order).
  assert.deepEqual(calls[1], ['inst', 't-a', { projectId: 'proj-1' }]);
  assert.deepEqual(calls[2], ['inst', 't-b', { projectId: 'proj-1' }]);
  assert.deepEqual(calls[3], ['inst', 't-c', { projectId: 'proj-1' }]);

  // then link each child to the parent + its predecessor (parallel batch, in
  // child order). First child: parent link only, no predecessor.
  assert.deepEqual(calls[4], ['link', 'c1', { parentTaskId: 'p1' }]);
  assert.deepEqual(calls[5], ['link', 'c2', { parentTaskId: 'p1', dependsOn: ['c1'] }]);
  assert.deepEqual(calls[6], ['link', 'c3', { parentTaskId: 'p1', dependsOn: ['c2'] }]);

  assert.equal(result.parentId, 'p1');
  assert.deepEqual(result.childIds, ['c1', 'c2', 'c3']);
});

// ── no projectId ────────────────────────────────────────────────────────────

test('instantiateChain omits projectId entirely when none is given', async () => {
  const calls = [];
  await instantiateChain({
    name: 'Order',
    templates: [{ templateId: 't-a' }],
    ...makeStubs(calls),
  });
  assert.deepEqual(calls[0], ['parent', { title: 'Order' }]);
  assert.deepEqual(calls[1], ['inst', 't-a', {}]);
  assert.deepEqual(calls[2], ['link', 'c1', { parentTaskId: 'p1' }]);
});

// ── single template ─────────────────────────────────────────────────────────

test('instantiateChain with one template creates parent + one linked child', async () => {
  const calls = [];
  const result = await instantiateChain({
    name: 'Solo',
    templates: [{ templateId: 't-only', name: 'Only' }],
    ...makeStubs(calls),
  });
  assert.equal(result.parentId, 'p1');
  assert.deepEqual(result.childIds, ['c1']);
  // parent, instantiate, link — no depends_on (no predecessor).
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], ['link', 'c1', { parentTaskId: 'p1' }]);
});

// ── failure propagation ──────────────────────────────────────────────────────

test('instantiateChain throws InstantiateChainError with parentId + all created childIds when a template fails', async () => {
  const calls = [];
  await assert.rejects(
    () =>
      instantiateChain({
        name: 'Order',
        templates: [{ templateId: 't-a' }, { templateId: 't-b' }, { templateId: 't-c' }],
        ...makeStubs(calls, { failOn: 't-b' }),
      }),
    (err) => {
      assert.ok(err instanceof InstantiateChainError);
      assert.equal(err.parentId, 'p1');
      // Parallel batch: t-a AND t-c both instantiated before we surface t-b's
      // failure — the error carries every child that WAS created (for
      // cleanup/resume), not just the ones before the failing index.
      assert.deepEqual(err.childIds, ['c1', 'c2']);
      assert.match(err.message, /t-b/);
      assert.ok(err.cause instanceof Error);
      assert.match(err.cause.message, /boom t-b/);
      return true;
    },
  );
  // parent + the two succeeding instantiates; NO links (we throw before the
  // link pass once any instantiate failed).
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['parent', 'inst', 'inst'],
  );
});

// ── empty chain guarded ──────────────────────────────────────────────────────

test('instantiateChain rejects an empty chain (a chain needs at least one template)', async () => {
  const calls = [];
  await assert.rejects(
    () =>
      instantiateChain({
        name: 'Empty',
        templates: [],
        ...makeStubs(calls),
      }),
    /at least one template/,
  );
  assert.equal(calls.length, 0, 'no parent created for an empty chain');
});

// ── task-257bb4870c6c — "New from Template" single-task assembly contract ────
//
// The from-template SINGLE-task flow (TaskComposer.saveFromTemplate) turns a
// template's field DEFS + collected VALUES into a first-class create payload
// (data + inherited output_schema), via shared taskSchema seams (aggregateInputs
// + effectiveFieldKey). It does NOT go through instantiateChain, so these tests
// exercise those seams directly — unchanged by the chain refactor.

function makeSingleTaskTemplateDef() {
  return {
    id: 'task',
    name: 'Get second headline',
    inputs: [{ key: 'news_site_url', label: 'news_site_url', type: 'text' }],
    outputs: [{ key: 'headline', label: 'Second headline', type: 'text', required: true }],
  };
}

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
