// task-6255239581b2 — type surface for attention.mjs (pure ESM at runtime so
// the node test runner imports it without a transpile step).
import type { Task } from '../types';
import type { ProjectNode } from './tree.d.mts';

/**
 * Per-project attention tally. Each count is the number of (rolled-up,
 * descendant-inclusive) tasks in that bucket:
 *   open     → unclaimed/open work wanting a human or agent to pick it up
 *   blocked  → blocked OR failed (a row that can't proceed)
 *   overdue  → past its due_at and not terminal
 *   failed   → attempts exhausted (attempts >= maxAttempts) and not terminal
 * `score` ranks projects (higher = more attention); `total` is the sum of the
 * distinct attention tasks. `lastActivityMs` is the max created/updated across
 * the project's (rolled-up) tasks, or null when unknown.
 */
export interface ProjectAttention {
  open: number;
  blocked: number;
  overdue: number;
  failed: number;
  /** task-80be320f06b3 — in_progress rows with no live worker (stranded). */
  stalled: number;
  total: number;
  score: number;
  /** Max(created_at, updated_at) over rolled-up tasks; null when unknown. */
  lastActivityMs: number | null;
  /** True when the project has zero attention AND no recent activity. */
  idle: boolean;
}

/** Today as a 'YYYY-MM-DD' string (local). Exported for callers/tests. */
export function todayKey(now?: number): string;

/** Which attention buckets a single task lands in. `stalled` = a stranded
 *  in_progress row (no live worker). `now` is injectable for deterministic
 *  tests and to share the page-mount clock with the count/list. */
export function classify(
  task: Task,
  today?: string,
  now?: number,
): {
  open: boolean;
  blocked: boolean;
  overdue: boolean;
  failed: boolean;
  stalled: boolean;
};

/**
 * task-18902d433658 — the single predicate behind a project's "N need you"
 * tally: true iff the task lands in ANY classify() bucket. Use this (not a
 * re-implemented OR) to FILTER a task list to exactly the tasks the count
 * counts, so the count and the filtered list can never disagree.
 */
export function needsAttention(
  task: Task,
  today?: string,
  now?: number,
): boolean;

/**
 * Compute per-project attention from the already-loaded task list, rolling
 * descendant project tasks UP into ancestors (same containment model as
 * rollUpTaskStats). Pure: no IPC, no DOM. Reads only Task routing/scheduling
 * fields (never titles/bodies — nothing PHI flows through here).
 *
 * @param roots project forest
 * @param tasks every loaded task (incl. done)
 * @param opts.now ms epoch "now" (defaults to Date.now())
 * @param opts.idleAfterDays activity older than this (and no attention) = idle
 * @param opts.activityFloorMs timestamps <= this are treated as UNKNOWN (the
 *   TypeBuild list endpoint stamps now() as a placeholder; pass the app/page
 *   mount time so those placeholders don't masquerade as "recent activity").
 *   When a project's only timestamps are placeholders we treat activity as
 *   unknown → NOT idle (nothing important hides).
 */
export function computeProjectAttention(
  roots: ProjectNode[],
  tasks: Task[],
  opts?: { now?: number; idleAfterDays?: number; activityFloorMs?: number },
): Map<string, ProjectAttention>;

/** One-line "3 open · 1 blocked · 1 overdue" summary (non-zero counts only). */
export function attentionSummary(a: ProjectAttention): string;
