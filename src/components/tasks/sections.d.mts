// fm-7909 — type surface for the pure sections.mjs module (runtime is plain
// ESM so the node test runner can import it without a transpile step).
import type { Task } from '../../types';

export const DONE_CAP: number;

export function isDone(task: Task): boolean;

export interface PartitionOpts {
  myEmail?: string | null;
  runningTaskIds?: Set<string>;
}

// fm-bq86 (S3) — one FOR AGENTS render row. depth 1 rows are children indented
// under their (visible) parent; parent rows carry child-progress + the
// readiness flag that strips Start while children are open.
export interface AgentRow {
  task: Task;
  depth: 0 | 1;
  /** Number of children grouped under this parent (parent rows only). */
  childCount?: number;
  /** How many of those children are terminal (done/cancelled/partial). */
  doneChildCount?: number;
  /** fm-8yky — children that actually render under this parent in-section
   *  (drives the collapse toggle; terminal kids live in DONE, not here). */
  visibleChildCount?: number;
  /** True when at least one child is still open — parent can't Start yet. */
  hasOpenChildren?: boolean;
}

export interface Partitioned {
  forYou: Task[];
  /** Flat FOR AGENTS tasks in grouped render order (parent, then children). */
  forAgents: Task[];
  /** Annotated FOR AGENTS rows for indented rendering; same order as forAgents. */
  forAgentsRows: AgentRow[];
  /** Capped at DONE_CAP, sorted completed_at desc. */
  done: Task[];
  /** Full count before the cap — for the collapsed header. */
  doneTotal: number;
}

export function partitionTasks(tasks: Task[], opts?: PartitionOpts): Partitioned;

/** Resolve blocked_by ids to titles from the in-memory list (renderer-only). */
export function resolveBlockedBy(
  ids: string[] | undefined | null,
  tasks: Task[],
): string[];
