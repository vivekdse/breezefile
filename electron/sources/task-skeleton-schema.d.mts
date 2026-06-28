// task-b3fb2928bb3c (Phase 1) — type surface for the pure PHI-free skeleton
// schema/diff module (runtime is plain ESM so the node test runner can import
// it without a transpile step).

export const SKELETON_COLUMNS: string[];
export const PHI_FORBIDDEN_SUBSTRINGS: string[];
export const SKELETON_TABLE_SQL: string;
export const SKELETON_INDEX_SQL: string;
export const PROJECT_COLUMNS: string[];
export const PROJECT_TABLE_SQL: string;
export const META_COLUMNS: string[];
export const META_TABLE_SQL: string;
export const SYNC_CURSOR_KEY: string;

export function parseColumnNames(createTableSql: string): string[];
export function isPhiColumn(name: string): boolean;

/** A routing-only skeleton row. NEVER carries titles/bodies (PHI). */
export interface SkeletonRow {
  id: string;
  status?: string | null;
  raw_status?: string | null;
  claimed_by?: string | null;
  assigned_to?: string | null;
  attempts?: number | null;
  max_attempts?: number | null;
  priority?: number | null;
  due_at?: string | null;
  defer_until?: string | null;
  project_id?: string | null;
  parent_task_id?: string | null;
}

export function routingSignature(row: SkeletonRow): string;

export interface SkeletonDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

export function diffSkeleton(
  prev: SkeletonRow[],
  fresh: SkeletonRow[],
): SkeletonDiff;

export function diffIsEmpty(diff: SkeletonDiff): boolean;

export function deltaSkeleton(
  prev: SkeletonRow[],
  changedFresh: SkeletonRow[],
  tombstoneIds: string[],
): SkeletonDiff;
