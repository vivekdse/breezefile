// task-group-scope-picker — New Home's group-scope selection, persisted across
// the "+ New Task" / edit-and-save remount the SAME way selectedProjectPrefs.ts
// persists the project picker (App.tsx swaps <TaskComposer/> in over the whole
// page, unmounting NewHomePage, and remounts it fresh on close/save). Without
// this the group scope would reset to "All groups" every time, exactly as the
// project picker used to reset to "All projects".
//
// Deliberately tiny: one key, one value (a group id or null for "All groups").
// The pure normalize/staleness helpers live in selectedGroupPrefs.mjs (plain
// ESM the node test runner imports without a transpile) — this file is just the
// localStorage I/O wrapper around them.

import { normalizeStoredGroupId } from './selectedGroupPrefs.mjs';

const KEY = 'fm.newHome.selectedGroupId.v1';

export { isStaleGroupSelection } from './selectedGroupPrefs.mjs';

/** Last-selected group scope, or null for "All groups" (including whenever
 *  storage is unavailable/corrupt — the safe default). */
export function loadSelectedGroupId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return normalizeStoredGroupId(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

/** Persist the current group scope. `null` (or '') clears back to "All groups"
 *  rather than storing an empty string. */
export function saveSelectedGroupId(id: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore quota / unavailable storage */
  }
}
