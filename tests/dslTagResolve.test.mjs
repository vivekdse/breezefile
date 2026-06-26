// task-317c7fe41f90 — end-to-end proof of the resolveTag BRIDGE.
//
// The acceptance criterion of the foundation task: a DSL tag created in the
// store, then evaluate(parse('tag:<name>'), entry, { resolveTag }) returns
// correct membership. This wires the three pieces — tagStore (persistence),
// makeResolveTag (the bridge), tagDsl parse/evaluate (the engine) — together,
// exactly as the renderer host does (store list → makeResolveTag → evaluate).
//
// Runs under `node --test tests/` with no Electron; each test gets a temp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TagStore } from '../src/tagStore.mjs';
import { parse, evaluate } from '../src/tagDsl.mjs';
import { makeResolveTag } from '../src/dslTagResolve.mjs';

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsl-resolve-test-'));
  return new TagStore({ dir });
}

const pdf = { path: '/docs/report.pdf', name: 'report.pdf', ext: 'pdf', size: 8 * 1024 * 1024 };
const png = { path: '/img/photo.png', name: 'photo.png', ext: 'png', size: 2 * 1024 * 1024 };

test('resolveTag: create a DSL tag, then evaluate tag:<name> end-to-end', async () => {
  const store = await freshStore();
  await store.create({ name: 'big-pdfs', selector: 'ext = pdf and size > 4MB' });

  // Host flow: pull the stored tags, build the resolver, evaluate a tag atom.
  const tags = await store.list();
  const resolveTag = makeResolveTag(tags);
  const ast = parse('tag:big-pdfs');

  assert.equal(evaluate(ast, pdf, { resolveTag }), true, 'matching entry → member');
  assert.equal(evaluate(ast, png, { resolveTag }), false, 'non-matching entry → not member');
});

test('resolveTag: a tag referencing another tag resolves recursively', async () => {
  const store = await freshStore();
  await store.create({ name: 'pdfs', selector: 'ext = pdf' });
  await store.create({ name: 'big', selector: 'size > 4MB' });
  // `important` is the AND of two other tags via tag: atoms.
  await store.create({ name: 'important', selector: 'tag:pdfs and tag:big' });

  const resolveTag = makeResolveTag(await store.list());
  const ast = parse('tag:important');
  assert.equal(evaluate(ast, pdf, { resolveTag }), true); // pdf AND >4MB
  assert.equal(evaluate(ast, png, { resolveTag }), false); // png fails tag:pdfs
});

test('resolveTag: a frozen tag tests snapshot membership by path', async () => {
  const store = await freshStore();
  await store.create({
    name: 'pinned',
    selector: 'is_dir', // ignored for frozen tags — snapshot wins
    mode: 'frozen',
    snapshot: [pdf.path],
  });
  const resolveTag = makeResolveTag(await store.list());
  const ast = parse('tag:pinned');
  assert.equal(evaluate(ast, pdf, { resolveTag }), true); // path in snapshot
  assert.equal(evaluate(ast, png, { resolveTag }), false); // path not in snapshot
});

test('resolveTag: a reference cycle degrades to no-match (no stack overflow)', async () => {
  // a → b → a. The bridge's in-flight guard breaks the cycle, treating the
  // back-reference as false. We silence the expected console.warn.
  const tags = [
    { name: 'a', selector: 'tag:b', mode: 'live' },
    { name: 'b', selector: 'tag:a', mode: 'live' },
  ];
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const resolveTag = makeResolveTag(tags);
    assert.equal(evaluate(parse('tag:a'), pdf, { resolveTag }), false);
  } finally {
    console.warn = origWarn;
  }
});

test('resolveTag: an unknown tag name resolves to no-match', async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const resolveTag = makeResolveTag([]);
    assert.equal(evaluate(parse('tag:missing'), pdf, { resolveTag }), false);
  } finally {
    console.warn = origWarn;
  }
});
