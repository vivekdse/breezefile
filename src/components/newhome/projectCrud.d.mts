// task-a9841cfc0e1b — type surface for the pure projectCrud.mjs module
// (runtime is plain ESM so the node test runner imports it without a
// transpile step).

export function projectDeleteDecision(taskCount: number): {
  canDelete: boolean;
  reason: 'empty' | 'has_tasks';
};

export function validParentOptions(
  projects: { id: string; parentProjectId: string | null }[] | null | undefined,
  excludeId: string | null | undefined,
): string[];

export function nextSelectionAfterArchive(
  selectedProjectId: string | null,
  archivedProjectId: string,
): string | null;

export function nextSelectionAfterDelete(
  selectedProjectId: string | null,
  deletedProjectId: string,
): string | null;
