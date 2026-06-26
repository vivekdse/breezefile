// fm-5xy — tests for the pure start-at / near-due reminder selector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectReminderTasks,
  normalizeReminderMode,
} from '../electron/core/task-reminders.mjs';

const TODAY = '2026-06-26';
const TOMORROW = '2026-06-27';

test("mode 'off' selects nothing", () => {
  const tasks = [{ id: 'a', start_at: TODAY }];
  const out = selectReminderTasks({ tasks, today: TODAY, tomorrow: TOMORROW, mode: 'off' });
  assert.deepEqual(out, { startToday: [], dueTomorrow: [] });
});

test("mode 'start' selects tasks whose start_at is today", () => {
  const tasks = [
    { id: 'a', start_at: TODAY, due_at: null },
    { id: 'b', start_at: '2026-06-30', due_at: null },
    { id: 'c', start_at: null, due_at: TODAY },
  ];
  const out = selectReminderTasks({ tasks, today: TODAY, tomorrow: TOMORROW, mode: 'start' });
  assert.deepEqual(out.startToday.map((t) => t.id), ['a']);
  assert.deepEqual(out.dueTomorrow, []);
});

test("mode 'start' ignores due-tomorrow tasks", () => {
  const tasks = [{ id: 'a', start_at: null, due_at: TOMORROW }];
  const out = selectReminderTasks({ tasks, today: TODAY, tomorrow: TOMORROW, mode: 'start' });
  assert.deepEqual(out.startToday, []);
  assert.deepEqual(out.dueTomorrow, []);
});

test("mode 'start-near-due' adds due-tomorrow tasks", () => {
  const tasks = [
    { id: 'a', start_at: TODAY },
    { id: 'b', start_at: null, due_at: TOMORROW },
    { id: 'c', start_at: null, due_at: '2026-07-01' },
  ];
  const out = selectReminderTasks({
    tasks,
    today: TODAY,
    tomorrow: TOMORROW,
    mode: 'start-near-due',
  });
  assert.deepEqual(out.startToday.map((t) => t.id), ['a']);
  assert.deepEqual(out.dueTomorrow.map((t) => t.id), ['b']);
});

test('a task that already notified today is skipped (dedupe)', () => {
  const tasks = [
    { id: 'a', start_at: TODAY, last_notified_for_date: TODAY },
    { id: 'b', start_at: TODAY, last_notified_for_date: '2026-06-25' },
    { id: 'c', start_at: TODAY, last_notified_for_date: null },
  ];
  const out = selectReminderTasks({ tasks, today: TODAY, tomorrow: TOMORROW, mode: 'start' });
  assert.deepEqual(out.startToday.map((t) => t.id), ['b', 'c']);
});

test('start wins over due — a task that both starts today and is due tomorrow counts once', () => {
  const tasks = [{ id: 'a', start_at: TODAY, due_at: TOMORROW }];
  const out = selectReminderTasks({
    tasks,
    today: TODAY,
    tomorrow: TOMORROW,
    mode: 'start-near-due',
  });
  assert.deepEqual(out.startToday.map((t) => t.id), ['a']);
  assert.deepEqual(out.dueTomorrow, []);
});

test('malformed / empty inputs are tolerated', () => {
  assert.deepEqual(
    selectReminderTasks({ tasks: [], today: TODAY, tomorrow: TOMORROW, mode: 'start' }),
    { startToday: [], dueTomorrow: [] },
  );
  assert.deepEqual(
    selectReminderTasks({ tasks: null, today: TODAY, tomorrow: TOMORROW, mode: 'start' }),
    { startToday: [], dueTomorrow: [] },
  );
  const tasks = [{ start_at: TODAY }, null, { id: 7, start_at: TODAY }];
  const out = selectReminderTasks({ tasks, today: TODAY, tomorrow: TOMORROW, mode: 'start' });
  assert.deepEqual(out.startToday, []);
});

test('normalizeReminderMode defaults unknown values to start', () => {
  assert.equal(normalizeReminderMode('off'), 'off');
  assert.equal(normalizeReminderMode('start'), 'start');
  assert.equal(normalizeReminderMode('start-near-due'), 'start-near-due');
  assert.equal(normalizeReminderMode('garbage'), 'start');
  assert.equal(normalizeReminderMode(undefined), 'start');
  assert.equal(normalizeReminderMode(null), 'start');
});
