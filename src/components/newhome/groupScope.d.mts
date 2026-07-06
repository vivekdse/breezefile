// task-group-scope-picker — type surface for the pure groupScope.mjs module
// (runtime is plain ESM so `node --test` imports it without a transpile step).
// Mirrors the rosterOrder.d.mts / selectedProjectPrefs.d.mts convention.

export function matchesGroup(
  task: { groupId?: string | null } | null | undefined,
  groupId: string | null | undefined,
): boolean;

export function filterByGroup<T extends { groupId?: string | null }>(
  tasks: T[] | null | undefined,
  groupId: string | null | undefined,
): T[];
