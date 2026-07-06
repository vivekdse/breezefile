// task-group-scope-picker — pure helpers backing selectedGroupPrefs.ts, split
// out so the node test runner can import them without a transpile (mirrors
// selectedProjectPrefs.mjs: pure logic here, localStorage I/O in the .ts
// wrapper).

/** Normalize a raw localStorage read (string | null | undefined | '') into
 *  the group-scope value NewHomePage wants: a group id, or null for "All
 *  groups". An empty string is treated the same as absent. */
export function normalizeStoredGroupId(raw) {
  return raw ? raw : null;
}

/** True when `id` (the persisted group scope) is no longer present in the
 *  groups derived from the current (project-scoped) task set, and should be
 *  dropped back to "All groups". `groups` empty is treated as "nothing
 *  group-scoped / not yet loaded" (never stale) so this never evicts a real
 *  selection before the roster has populated — the same guard
 *  isStaleProjectSelection uses. */
export function isStaleGroupSelection(id, groups) {
  if (!id) return false;
  if (!groups || groups.length === 0) return false;
  return !groups.some((g) => g.id === id);
}
