// task-fd5b93809b1b — type surface for the pure selectedProjectPrefs.mjs
// module (runtime is plain ESM so the node test runner imports it without a
// transpile step).

export function normalizeStoredProjectId(raw: string | null | undefined): string | null;

export function isStaleProjectSelection(
  id: string | null | undefined,
  projects: { id: string }[] | null | undefined,
): boolean;
