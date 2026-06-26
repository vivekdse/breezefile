// fm-v3p — unit tests for the PURE launcher-visibility helpers
// (src/launcherPrefs.mjs). No Electron/localStorage; prefs are passed
// explicitly. Covers the "given launchers + prefs → visible ordered list with
// default first" contract plus the no-prefs identity case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLauncherPrefs,
  isLauncherHidden,
  resolveDefaultLauncherId,
  EMPTY_LAUNCHER_PREFS,
} from '../src/launcherPrefs.mjs';

const LAUNCHERS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'OpenAI Codex' },
  { id: 'gemini', label: 'Gemini' },
];

const ids = (list) => list.map((l) => l.id);

test('no prefs → identity order, no default', () => {
  const r = applyLauncherPrefs(LAUNCHERS, undefined);
  assert.deepEqual(ids(r.visible), ['claude', 'codex', 'gemini']);
  assert.equal(r.defaultId, null);
});

test('EMPTY_LAUNCHER_PREFS behaves like no prefs', () => {
  const r = applyLauncherPrefs(LAUNCHERS, EMPTY_LAUNCHER_PREFS);
  assert.deepEqual(ids(r.visible), ['claude', 'codex', 'gemini']);
  assert.equal(r.defaultId, null);
});

test('hidden launchers are filtered out, order otherwise preserved', () => {
  const r = applyLauncherPrefs(LAUNCHERS, { hidden: ['codex'], defaultId: null });
  assert.deepEqual(ids(r.visible), ['claude', 'gemini']);
  assert.equal(r.defaultId, null);
});

test('default launcher is moved to the front', () => {
  const r = applyLauncherPrefs(LAUNCHERS, { hidden: [], defaultId: 'gemini' });
  assert.deepEqual(ids(r.visible), ['gemini', 'claude', 'codex']);
  assert.equal(r.defaultId, 'gemini');
});

test('default + hidden: visible filtered, surviving default still first', () => {
  const r = applyLauncherPrefs(LAUNCHERS, {
    hidden: ['claude'],
    defaultId: 'gemini',
  });
  assert.deepEqual(ids(r.visible), ['gemini', 'codex']);
  assert.equal(r.defaultId, 'gemini');
});

test('a hidden default does not win (and is filtered out)', () => {
  const r = applyLauncherPrefs(LAUNCHERS, {
    hidden: ['gemini'],
    defaultId: 'gemini',
  });
  assert.deepEqual(ids(r.visible), ['claude', 'codex']);
  assert.equal(r.defaultId, null);
});

test('a default pointing at an absent launcher is ignored', () => {
  const r = applyLauncherPrefs(LAUNCHERS, { hidden: [], defaultId: 'nope' });
  assert.deepEqual(ids(r.visible), ['claude', 'codex', 'gemini']);
  assert.equal(r.defaultId, null);
});

test('isLauncherHidden reads the hidden array', () => {
  assert.equal(isLauncherHidden('codex', { hidden: ['codex'] }), true);
  assert.equal(isLauncherHidden('claude', { hidden: ['codex'] }), false);
  assert.equal(isLauncherHidden('claude', undefined), false);
});

test('resolveDefaultLauncherId only resolves present + visible defaults', () => {
  assert.equal(
    resolveDefaultLauncherId(LAUNCHERS, { hidden: [], defaultId: 'codex' }),
    'codex',
  );
  assert.equal(
    resolveDefaultLauncherId(LAUNCHERS, { hidden: ['codex'], defaultId: 'codex' }),
    null,
  );
  assert.equal(resolveDefaultLauncherId(LAUNCHERS, { defaultId: null }), null);
});

test('empty/garbage inputs are safe', () => {
  assert.deepEqual(applyLauncherPrefs([], { hidden: ['x'], defaultId: 'x' }), {
    visible: [],
    defaultId: null,
  });
  assert.deepEqual(applyLauncherPrefs(undefined, undefined), {
    visible: [],
    defaultId: null,
  });
});
