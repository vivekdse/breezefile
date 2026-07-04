// task-fd5b93809b1b — New Home's project-picker selection used to live ONLY
// in NewHomePage's React state. The "+ New Task" / edit-task save path opens
// the canonical TaskComposer as a FULL-SCREEN swap in App.tsx (taskDialog ?
// <TaskComposer/> : ... <NewHomePage/>), which UNMOUNTS NewHomePage while the
// composer is open and remounts it fresh on close/save — silently resetting
// selectedProjectId to null and yanking the user back to "All projects" right
// after they created/edited a task. Persisting the selection here (mirroring
// the small self-contained localStorage prefs pattern in sideBySidePrefs.ts /
// fileTypes.ts) lets NewHomePage rehydrate its initial state across that
// remount instead of restarting at null every time.
//
// Deliberately tiny: one key, one value (a project id or null for "All
// projects"). Not a general prefs bag — if New Home grows more persisted UI
// state later, give it its own key rather than overloading this one.
//
// The pure normalize/staleness helpers live in selectedProjectPrefs.mjs
// (mirrors src/fileTypes.ts / src/launcherPrefs.ts: plain-ESM logic the node
// test runner can import without a transpile step) — this file is just the
// localStorage I/O wrapper around them.

import { normalizeStoredProjectId } from './selectedProjectPrefs.mjs';

const KEY = 'fm.newHome.selectedProjectId.v1';

export { isStaleProjectSelection } from './selectedProjectPrefs.mjs';

/** Last-selected project id, or null for "All projects" (including whenever
 *  storage is unavailable/corrupt — the safe default this page already used
 *  on first mount). */
export function loadSelectedProjectId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return normalizeStoredProjectId(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

/** Persist the current selection. `null` (or '') clears back to "All
 *  projects" rather than storing an empty string. */
export function saveSelectedProjectId(id: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore quota / unavailable storage */
  }
}
