// task-group-scope-picker — type surface for the pure selectedGroupPrefs.mjs
// module (runtime is plain ESM so the node test runner imports it without a
// transpile step). Mirrors selectedProjectPrefs.d.mts.

export function normalizeStoredGroupId(raw: string | null | undefined): string | null;

export function isStaleGroupSelection(
  id: string | null | undefined,
  groups: { id: string }[] | null | undefined,
): boolean;
