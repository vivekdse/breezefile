// Type surface for the pure claude-stop-backstop.mjs decision core
// (task-c926bbe959f6). Runtime is plain ESM so the node test runner imports it
// without a transpile step; the .ts side imports these types via ./name.mjs.

/** The wire shape the /claude-stopped endpoint receives from claude-hook.sh. */
export interface StopSignal {
  /** BREEZE_TASK_ID from the interactive spawn env — the task this session was
   *  bound to. Empty/absent when the session had no task binding (plain
   *  `claude` in a shell tab), in which case the backstop no-ops. */
  task_id?: string;
  /** BREEZE_SOURCE_ID — the owning TaskSource id (defaults to 'typebuild'). */
  source_id?: string;
  /** Claude Code session id from the Stop payload (diagnostic only). */
  session_id?: string;
  /** Claude Code transcript path — a POINTER we deliberately do NOT read. */
  transcript_path?: string;
}

/** The minimal task shape the decision reads (routing fields only — the caller
 *  passes a SourcedTask, which is a superset). */
export interface StopTaskView {
  status?: string;
  pending_question?: { text?: string } | null;
}

export type StopDecision =
  | { action: 'noop'; reason: string }
  | { action: 'flag'; taskId: string; sourceId: string; text: string };

export const GENERIC_STOP_QUESTION: string;

export function decideStopBackstop(
  signal: StopSignal,
  task: StopTaskView | null,
): StopDecision;
