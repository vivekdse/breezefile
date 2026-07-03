// task-ae0ec0348930 — unit tests for the PURE FormExtension effect reducer
// (src/copilot/formEffects.mjs). The interpreter APPLIES declarative effects
// only — never eval's, never injects markup. These tests pin the two security-
// critical guarantees:
//   1. sanitizeEffects keeps ONLY the four allowlisted keys and drops malformed
//      sub-values (a compromised/erroneous server can't smuggle behavior).
//   2. applyEffectsToState applies each of the four effects correctly + purely
//      (new state, additive, unrelated fields untouched).
// The IPC/fetch plumbing is Electron-coupled (CI lacks it); the reducer is pure,
// so it's the right unit to test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const {
  sanitizeEffects,
  applyEffectsToState,
  valueWritesFromEffects,
  emptyInterpreterState,
  resolveApplicableExtension,
} = await import(join(repoRoot, 'src', 'copilot', 'formEffects.mjs'));

test('sanitizeEffects keeps only the four allowlisted keys', () => {
  const out = sanitizeEffects({
    setValue: { a: 'x' },
    setVisible: { b: false },
    setOptions: { c: ['1', '2'] },
    validate: { d: 'bad' },
    // Not allowlisted — must be dropped (the security guarantee).
    evilKey: { z: 'run me' },
    dangerouslySetInnerHTML: { z: '<script>' },
  });
  assert.deepEqual(Object.keys(out).sort(), ['setOptions', 'setValue', 'setVisible', 'validate']);
  assert.equal(out.evilKey, undefined);
  assert.equal(out.dangerouslySetInnerHTML, undefined);
});

test('sanitizeEffects drops malformed sub-values per key', () => {
  const out = sanitizeEffects({
    setVisible: { b: 'nope', c: true }, // non-boolean dropped
    setOptions: { d: 'nope', e: ['ok', 3, 'also'] }, // non-array dropped; non-strings filtered
    validate: { f: 5, g: null, h: 'msg' }, // number dropped; null kept (clears); string kept
  });
  assert.deepEqual(out.setVisible, { c: true });
  assert.deepEqual(out.setOptions, { e: ['ok', 'also'] });
  assert.deepEqual(out.validate, { g: null, h: 'msg' });
});

test('sanitizeEffects is defensive on non-objects', () => {
  assert.deepEqual(sanitizeEffects(null), {});
  assert.deepEqual(sanitizeEffects('x'), {});
  assert.deepEqual(sanitizeEffects(undefined), {});
  assert.deepEqual(sanitizeEffects({ setValue: 'not-an-object' }), {});
});

test('applyEffectsToState: setVisible hides and shows', () => {
  let state = emptyInterpreterState();
  state = applyEffectsToState(state, { setVisible: { a: false } });
  assert.equal(state.hidden.a, true);
  state = applyEffectsToState(state, { setVisible: { a: true } });
  assert.equal(state.hidden.a, undefined); // shown again
});

test('applyEffectsToState: setOptions replaces the option list', () => {
  const state = applyEffectsToState(emptyInterpreterState(), {
    setOptions: { dx: ['flu', 'cold'] },
  });
  assert.deepEqual(state.options.dx, ['flu', 'cold']);
});

test('applyEffectsToState: validate sets a string error and null clears it', () => {
  let state = applyEffectsToState(emptyInterpreterState(), { validate: { age: 'too high' } });
  assert.equal(state.errors.age, 'too high');
  state = applyEffectsToState(state, { validate: { age: null } });
  assert.equal(state.errors.age, undefined);
});

test('applyEffectsToState is pure and additive (unrelated fields untouched)', () => {
  const base = applyEffectsToState(emptyInterpreterState(), {
    setVisible: { a: false },
    validate: { b: 'err' },
  });
  const next = applyEffectsToState(base, { setOptions: { c: ['x'] } });
  // Original not mutated.
  assert.equal(base.options.c, undefined);
  // New state carries all three, additively.
  assert.equal(next.hidden.a, true);
  assert.equal(next.errors.b, 'err');
  assert.deepEqual(next.options.c, ['x']);
});

test('valueWritesFromEffects coerces setValue to a string map', () => {
  assert.deepEqual(
    valueWritesFromEffects({ setValue: { a: 'x', n: 42, nil: null } }),
    { a: 'x', n: '42' }, // null skipped
  );
  assert.deepEqual(valueWritesFromEffects({}), {});
});

test('resolveApplicableExtension matches approved appliesTo.template', () => {
  const exts = [
    { id: '1', status: 'draft', appliesTo: { template: 'intake' }, projectId: null },
    { id: '2', status: 'approved', appliesTo: { template: 'other' }, projectId: null },
    { id: '3', status: 'approved', appliesTo: { template: 'intake' }, projectId: null },
  ];
  assert.equal(resolveApplicableExtension(exts, 'intake', null)?.id, '3'); // skips draft #1
  assert.equal(resolveApplicableExtension(exts, 'missing', null), null);
  assert.equal(resolveApplicableExtension(exts, null, null), null);
});

test('resolveApplicableExtension respects project scoping', () => {
  const exts = [
    { id: '4', status: 'approved', appliesTo: { template: 'intake' }, projectId: 'projA' },
  ];
  assert.equal(resolveApplicableExtension(exts, 'intake', 'projB'), null); // wrong project
  assert.equal(resolveApplicableExtension(exts, 'intake', 'projA')?.id, '4');
});
