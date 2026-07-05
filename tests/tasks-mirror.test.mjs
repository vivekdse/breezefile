// task-3abb663aba25 — tests for the renderer diff-apply mirror merge. These
// exercise the SAME pure functions useTasks runs when it applies a peeked diff
// instead of re-pulling the whole list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTaskMirror, computeRemovedIds } from '../src/tasksMirror.mjs';

// Synthetic non-PHI rows (guardrail: never real task text in fixtures).
const row = (id, v = 'v') => ({ id, title: `synthetic-${id}`, tag: v });

test('update replaces a row IN PLACE, preserving order', () => {
  const mirror = [row('a'), row('b'), row('c')];
  const out = mergeTaskMirror(mirror, [row('b', 'updated')], []);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(out[1].tag, 'updated');
  // never mutates the input
  assert.equal(mirror[1].tag, 'v');
});

test('add appends a genuinely-new row', () => {
  const mirror = [row('a'), row('b')];
  const out = mergeTaskMirror(mirror, [row('z', 'new')], []);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b', 'z']);
  assert.equal(out[2].tag, 'new');
});

test('remove drops a row', () => {
  const mirror = [row('a'), row('b'), row('c')];
  const out = mergeTaskMirror(mirror, [], ['b']);
  assert.deepEqual(out.map((r) => r.id), ['a', 'c']);
});

test('remove wins over upsert for the same id', () => {
  const mirror = [row('a'), row('b')];
  const out = mergeTaskMirror(mirror, [row('b', 'changed')], ['b']);
  assert.deepEqual(out.map((r) => r.id), ['a']);
});

test('combined add + update + remove in one pass', () => {
  const mirror = [row('a'), row('b'), row('c')];
  const out = mergeTaskMirror(
    mirror,
    [row('a', 'A2'), row('d', 'D')],
    ['c'],
  );
  assert.deepEqual(out.map((r) => r.id), ['a', 'b', 'd']);
  assert.equal(out.find((r) => r.id === 'a').tag, 'A2');
});

test('empty diff returns an equivalent list', () => {
  const mirror = [row('a'), row('b')];
  const out = mergeTaskMirror(mirror, [], []);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b']);
});

test('computeRemovedIds: requested-but-not-returned ids are removed', () => {
  // asked for a,b,c; only a,b still match the slice's filter → c must leave.
  const removed = computeRemovedIds(['a', 'b', 'c'], ['a', 'b'], []);
  assert.deepEqual([...removed].sort(), ['c']);
});

test('computeRemovedIds: unions the explicit diff removals', () => {
  const removed = computeRemovedIds(['a', 'b'], ['a', 'b'], ['x', 'y']);
  assert.deepEqual([...removed].sort(), ['x', 'y']);
});

test('computeRemovedIds: no false removals when everything returned', () => {
  const removed = computeRemovedIds(['a', 'b'], ['a', 'b'], []);
  assert.deepEqual(removed, []);
});
