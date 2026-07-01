// task-c5cae3255a96 — type surface for resume-on-answer.mjs (runtime is plain
// ESM). See the .mjs header for the design; this file only declares the shapes.

/** A session breezed started and is tracking for the resume-on-answer tier. */
export interface TrackedSession {
  /** Opaque task id (non-PHI). */
  taskId: string;
  /** claude session_id captured at launch (non-PHI). */
  sessionId: string;
  /** True iff the task was observed parked on a question when tracked. */
  hadPendingQuestion: boolean;
}

/** Freshly-observed task state, distilled to the PHI-free bits the decision
 *  needs (never the question text). */
export interface ObservedTask {
  /** False when getTask returned null (task gone server-side). */
  exists: boolean;
  /** True iff pending_question is currently set. */
  hasPendingQuestion: boolean;
  /** Mapped status ('in_progress' | 'done' | 'cancelled' | ...). */
  status?: string;
}

export type ResumeDecision =
  | { action: 'resume'; taskId: string; sessionId: string }
  | { action: 'noop'; reason: string; drop?: boolean };

/** Decide whether an answered question should resume a breezed-tracked session.
 *  Pure + conservative; keys only on the structural set→null transition plus the
 *  session_id and status. Never sees the question text. */
export function decideResumeOnAnswer(
  tracked: TrackedSession | null | undefined,
  observed: ObservedTask | null | undefined,
): ResumeDecision;

/** Distill a getTask result into the PHI-free ObservedTask shape (drops the
 *  question text; keeps only presence + status). */
export function observeTask(
  task:
    | { status?: string; pending_question?: { text?: unknown } | null }
    | null
    | undefined,
): ObservedTask;
