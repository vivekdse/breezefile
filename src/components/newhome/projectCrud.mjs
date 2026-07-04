// task-a9841cfc0e1b — pure logic backing the New Home project-CRUD UI
// (create/edit/archive/delete). Plain ESM (with a co-located projectCrud.d.mts
// for the TS app) so `node --test tests/` can import it directly without a
// transpile step — mirrors selectedProjectPrefs.mjs / tree.mjs.
//
// NON-PHI: only ever touches Project fields (name/description/instructions/
// folders — teaching context) and a task COUNT (never task titles/bodies).

/**
 * Whether a project can be hard-deleted, or must be archived instead. The
 * simplified model (see NewHomePage.tsx header) treats delete as available
 * ONLY for an empty project — one with zero tasks — so an accidental delete
 * can never silently orphan real work. `taskCount` is the number of tasks
 * whose projectId is this project (own count, NOT rolled up over children —
 * a project with sub-projects that themselves have tasks is not "empty"
 * either, so pass the ROLLED count when the project has children).
 *
 * @param {number} taskCount
 * @returns {{ canDelete: boolean, reason: 'empty' | 'has_tasks' }}
 */
export function projectDeleteDecision(taskCount) {
  const n = typeof taskCount === 'number' && taskCount > 0 ? taskCount : 0;
  return n === 0
    ? { canDelete: true, reason: 'empty' }
    : { canDelete: false, reason: 'has_tasks' };
}

/**
 * Candidate parent options for the create/edit dialog's "Parent project"
 * picker: every OTHER project, minus `excludeId` (the project being edited,
 * so it can't become its own parent) and anything in `excludeId`'s descendant
 * subtree (so a project can't become a descendant of its own descendant,
 * which would otherwise silently create a cycle that buildProjectTree has to
 * paper over by demoting the node back to a root).
 *
 * @param {{ id: string, parentProjectId: string | null }[]} projects
 * @param {string | null | undefined} excludeId
 * @returns {string[]} ids that are valid parent choices
 */
export function validParentOptions(projects, excludeId) {
  const list = Array.isArray(projects) ? projects : [];
  if (!excludeId) return list.map((p) => p.id);

  // Build id -> parentId, then find every descendant of excludeId (BFS/DFS).
  const childrenOf = new Map();
  for (const p of list) {
    const pid = p.parentProjectId || null;
    if (!pid) continue;
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid).push(p.id);
  }
  const excluded = new Set([excludeId]);
  const stack = [excludeId];
  while (stack.length) {
    const cur = stack.pop();
    for (const child of childrenOf.get(cur) ?? []) {
      if (!excluded.has(child)) {
        excluded.add(child);
        stack.push(child);
      }
    }
  }
  return list.filter((p) => !excluded.has(p.id)).map((p) => p.id);
}

/**
 * After an archive of the currently-selected project, what should the picker
 * fall back to? Mirrors isStaleProjectSelection's contract in
 * selectedProjectPrefs.mjs: archiving the selected project always falls back
 * to "All projects" (null) — archiving any OTHER project leaves the
 * selection untouched.
 *
 * @param {string | null} selectedProjectId
 * @param {string} archivedProjectId
 * @returns {string | null} the next selection
 */
export function nextSelectionAfterArchive(selectedProjectId, archivedProjectId) {
  if (selectedProjectId && selectedProjectId === archivedProjectId) return null;
  return selectedProjectId ?? null;
}

/**
 * After a delete of a project, what should the picker fall back to? Same
 * rule as archive (delete always removes the project from the list too).
 *
 * @param {string | null} selectedProjectId
 * @param {string} deletedProjectId
 * @returns {string | null} the next selection
 */
export function nextSelectionAfterDelete(selectedProjectId, deletedProjectId) {
  return nextSelectionAfterArchive(selectedProjectId, deletedProjectId);
}
