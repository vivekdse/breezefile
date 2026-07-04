// task-fd5b93809b1b — pure helpers backing selectedProjectPrefs.ts, split out
// so the node test runner can import them without a transpile (mirrors
// src/fileTypes.mjs / src/launcherPrefs.mjs: pure logic here, localStorage
// I/O in the .ts wrapper).

/** Normalize a raw localStorage read (string | null | undefined | '') into
 *  the selection value NewHomePage wants: a project id, or null for "All
 *  projects". An empty string is treated the same as absent. */
export function normalizeStoredProjectId(raw) {
  return raw ? raw : null;
}

/** True when `id` (the persisted selection) is no longer present in the
 *  loaded `projects` list and should be dropped back to "All projects".
 *  `projects` empty is treated as "not yet loaded" (never stale) so this
 *  never fires against the initial pre-fetch render. */
export function isStaleProjectSelection(id, projects) {
  if (!id) return false;
  if (!projects || projects.length === 0) return false;
  return !projects.some((p) => p.id === id);
}
