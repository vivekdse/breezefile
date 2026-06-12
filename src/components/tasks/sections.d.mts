// fm-7909 — type surface for the pure sections.mjs module (runtime is plain
// ESM so the node test runner can import it without a transpile step).
import type { Task } from '../../types';

export const DONE_CAP: number;

export function isDone(task: Task): boolean;

export interface PartitionOpts {
  myEmail?: string | null;
  runningTaskIds?: Set<string>;
}

export interface Partitioned {
  forYou: Task[];
  forAgents: Task[];
  /** Capped at DONE_CAP, sorted completed_at desc. */
  done: Task[];
  /** Full count before the cap — for the collapsed header. */
  doneTotal: number;
}

export function partitionTasks(tasks: Task[], opts?: PartitionOpts): Partitioned;
