// task-570f3471b28e / task-ee50c5c1be17 — the ⌘/Ctrl+<n> shortcut and the
// Tabbar render must agree on the VISIBLE tab order. These tests pin the pure
// mapping: task-zone kinds (task/tasks/projects/home) render after the folder
// zone regardless of open order, so Ctrl+<n> follows the rendered sequence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTaskZone,
  visibleTabOrder,
  tabIndexForPosition,
} from '../src/tabOrder.mjs';

const t = (kind) => ({ kind });

test('isTaskZone: task-zone kinds vs folder-zone kinds', () => {
  for (const k of ['task', 'tasks', 'projects', 'home']) {
    assert.equal(isTaskZone(t(k)), true, `${k} should be task zone`);
  }
  for (const k of ['folder', 'edit', 'browser', undefined]) {
    assert.equal(isTaskZone(t(k)), false, `${k} should be folder zone`);
  }
});

test('repro: Home opened first, file manager opened after → fm is visible #1', () => {
  // state.tabs order: Home at array index 0, folder (file manager) at index 1.
  // The bug: Ctrl+1 used to focus Home (array index 0). Expected: Ctrl+1 →
  // the folder tab, which the Tabbar paints first (folder zone before task).
  const tabs = [t('home'), t('folder')];
  assert.deepEqual(visibleTabOrder(tabs), [1, 0]);
  assert.equal(tabIndexForPosition(tabs, 1), 1, 'Ctrl+1 → folder (visible #1)');
  assert.equal(tabIndexForPosition(tabs, 2), 0, 'Ctrl+2 → Home (visible #2)');
});

test('visibleTabOrder: folder zone first (array order), then task zone (array order)', () => {
  // Interleaved: folder, home, folder, task, tasks.
  const tabs = [t('folder'), t('home'), t('folder'), t('task'), t('tasks')];
  // folder zone preserves array order: indices 0, 2; task zone: 1, 3, 4.
  assert.deepEqual(visibleTabOrder(tabs), [0, 2, 1, 3, 4]);
});

test('tabIndexForPosition maps every visible slot for Home + file manager', () => {
  const tabs = [t('home'), t('folder')];
  // every position the user sees resolves to the tab shown there.
  const order = visibleTabOrder(tabs);
  for (let pos = 1; pos <= tabs.length; pos++) {
    assert.equal(tabIndexForPosition(tabs, pos), order[pos - 1]);
  }
});

test('tabIndexForPosition: out-of-range positions return undefined', () => {
  const tabs = [t('folder'), t('home')];
  assert.equal(tabIndexForPosition(tabs, 0), undefined);
  assert.equal(tabIndexForPosition(tabs, 3), undefined);
  assert.equal(tabIndexForPosition(tabs, 9), undefined);
});

test('full 1-9 range follows rendered zone order', () => {
  // 4 folder tabs then 5 task-zone tabs, but stored interleaved in state.tabs.
  const tabs = [
    t('task'), // 0
    t('folder'), // 1
    t('home'), // 2
    t('folder'), // 3
    t('tasks'), // 4
    t('folder'), // 5
    t('projects'), // 6
    t('folder'), // 7
    t('task'), // 8
  ];
  // folder zone (array order): 1, 3, 5, 7 → positions 1..4
  // task zone (array order): 0, 2, 4, 6, 8 → positions 5..9
  const expected = [1, 3, 5, 7, 0, 2, 4, 6, 8];
  assert.deepEqual(visibleTabOrder(tabs), expected);
  for (let pos = 1; pos <= 9; pos++) {
    assert.equal(tabIndexForPosition(tabs, pos), expected[pos - 1]);
  }
});
