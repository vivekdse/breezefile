// fm-h8g7 — main-process mirror of the renderer's "Task notifications"
// verbosity setting.
//
// Settings in Breeze are renderer-owned (localStorage, see src/store.tsx). But
// the task-notification gate must apply in the MAIN process, because that is
// where OS Notifications are constructed (electron-host.ts) — main can't read
// localStorage. So the renderer pushes its current value over a
// `settings:taskNotifications` IPC on boot AND on every change, and main caches
// it here. Default 'all' until the renderer reports in (matches the store
// default), so a notification fired before hydration isn't silently dropped.
//
// Authored as plain ESM with a co-located .d.mts so it has no transpile
// dependency and can be imported from both the TS main code and tests.
//
//   'all'      → failures + successes + remote transitions
//   'failures' → failures only (success + transitions suppressed)
//   'off'      → nothing
//
// Failures ALWAYS show unless 'off'. Success + transitions only when 'all'.

/** @typedef {'all'|'failures'|'off'} TaskNotifyVerbosity */

/** @type {TaskNotifyVerbosity} */
let verbosity = 'all';

/** @param {TaskNotifyVerbosity} v */
export function setTaskNotifyVerbosity(v) {
  if (v === 'all' || v === 'failures' || v === 'off') verbosity = v;
}

/** @returns {TaskNotifyVerbosity} */
export function getTaskNotifyVerbosity() {
  return verbosity;
}

/** Failures show unless the user turned notifications fully off. */
export function shouldNotifyFailure() {
  return verbosity !== 'off';
}

/** Successes + remote transitions show only at the most verbose level. */
export function shouldNotifySuccess() {
  return verbosity === 'all';
}

/** Remote transitions follow the same gate as successes. */
export function shouldNotifyTransition() {
  return verbosity === 'all';
}
