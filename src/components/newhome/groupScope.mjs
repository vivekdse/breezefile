// task-group-scope-picker — pure group-scope filter for the New Home roster.
// Plain ESM (mirrors rosterOrder.mjs / rosterGroups.mjs) so it runs under
// `node --test` with no transpile; the .d.mts sibling types it.
//
// The New Home group picker scopes the roster / hero stats / subproject
// sections to a single owning GROUP. This module holds the one pure predicate
// that decision turns on, extracted from useNewHomeData so it is unit-tested
// in isolation and shared by any surface that needs "does this task belong to
// the scoped group?".
//
// NON-PHI: reads only the task's opaque `groupId` — never title/body text.
// Nothing here logs or persists.

/**
 * True when `task` belongs to the scoped group. A null/undefined/empty
 * `groupId` means "All groups" (no scoping) — every task matches. A task with
 * no `groupId` matches only the unscoped case (it can never belong to a
 * specific group).
 *
 * @param {{ groupId?: string | null }} task
 * @param {string | null | undefined} groupId  the selected group, or null for "All groups"
 * @returns {boolean}
 */
export function matchesGroup(task, groupId) {
  if (!groupId) return true; // "All groups" — no scoping.
  return !!task && task.groupId === groupId;
}

/**
 * Narrow `tasks` to the scoped group. A null/undefined/empty `groupId` returns
 * the list unchanged (same contract as the other roster filters). Pure — never
 * mutates.
 *
 * @template {{ groupId?: string | null }} T
 * @param {T[]} tasks
 * @param {string | null | undefined} groupId
 * @returns {T[]}
 */
export function filterByGroup(tasks, groupId) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!groupId) return list;
  return list.filter((t) => matchesGroup(t, groupId));
}
