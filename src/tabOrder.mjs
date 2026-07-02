// task-570f3471b28e / task-ee50c5c1be17 — single source of truth for the
// VISIBLE tab order so the ⌘/Ctrl+<n> shortcut and the rendered tab strip
// (Tabbar) can never disagree.
//
// The Tabbar paints tabs in two zones — "folder" on the left, "task" on the
// right — preserving each tab's original index in `state.tabs` (every dispatch
// targets that absolute index). The numbering shown on each tab is 1-based
// across the CONCATENATED zone order (folder zone first, then task zone), which
// is NOT the raw `state.tabs` array order. Home (kind:'home'), the All-tasks
// page (kind:'tasks'), the legacy Projects tab (kind:'projects') and bound task
// tabs (kind:'task') all live in the task zone regardless of when they were
// opened, so their array position differs from their visible slot.
//
// Keeping this mapping in one PURE place (no React / IPC / fs) means it is
// unit-testable and both consumers index identically. Authored as plain ESM
// (with a co-located .d.mts) so `node --test tests/` imports it without a
// transpile step.

// Kinds that render in the right-hand "task" zone of the Tabbar. Everything
// else (notably 'folder', 'edit', 'browser') renders in the left "folder" zone.
// Keep in sync with the partition in src/components/Tabbar.tsx.
const TASK_ZONE_KINDS = new Set(['task', 'tasks', 'projects', 'home', 'newhome']);

/**
 * @param {{ kind?: string }} tab
 * @returns {boolean} true if the tab renders in the right-hand task zone.
 */
export function isTaskZone(tab) {
  return TASK_ZONE_KINDS.has(tab && tab.kind);
}

/**
 * Produce the list of `state.tabs` indices in the order the Tabbar RENDERS
 * them: folder zone first (in array order), then task zone (in array order).
 * The position of an entry in the returned array + 1 is the number shown on
 * that tab and the digit that focuses it (⌘/Ctrl+<n>).
 *
 * @param {Array<{ kind?: string }>} tabs  the raw `state.tabs` array.
 * @returns {number[]} absolute indices into `tabs`, in visible order.
 */
export function visibleTabOrder(tabs) {
  const folderIdx = [];
  const taskIdx = [];
  tabs.forEach((tab, i) => (isTaskZone(tab) ? taskIdx : folderIdx).push(i));
  return [...folderIdx, ...taskIdx];
}

/**
 * Map a 1-based visible position (the number on the tab) to the absolute
 * `state.tabs` index it focuses, or undefined if out of range.
 *
 * @param {Array<{ kind?: string }>} tabs
 * @param {number} pos  1-based visible position (⌘/Ctrl+<pos>).
 * @returns {number | undefined}
 */
export function tabIndexForPosition(tabs, pos) {
  return visibleTabOrder(tabs)[pos - 1];
}
