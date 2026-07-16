// task-c82d8e0f4eae — type surface for the pure subprojectSections.mjs module
// (runtime is plain ESM so `node --test` imports it without a transpile step).
import type { ProjectNode } from '../../projects/tree.d.mts';
import type { StatusBucket } from './rosterGroups.d.mts';

/** One direct child subproject rolled up into a navigable roster section. */
export type SubprojectSection = {
  id: string;
  name: string;
  /** Every task id in this subproject's whole subtree (scoped roster). */
  taskIds: string[];
  /** Per-bucket status rollup over the subtree — drives the hero-stat chips. */
  statusCounts: Record<StatusBucket, number>;
  /** taskIds.length — the section's Runs count. */
  taskCount: number;
};

export function buildSubprojectSections(
  tasks: {
    id: string;
    projectId?: string | null;
    status?: string;
    /** Schedule metadata ONLY — statusBucket reads `cron`/`next_run_at` off it
     *  to tell 'scheduled' from 'open'. No field values are read. */
    raw?: { cron?: string | null; next_run_at?: number | null } | null;
  }[],
  roots: ProjectNode[],
  selectedProjectId: string | null | undefined,
): { ownTaskIds: string[]; sections: SubprojectSection[] };
