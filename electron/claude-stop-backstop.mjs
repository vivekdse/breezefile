// Pure decision core for the Claude Code Stop-hook backstop (task-c926bbe959f6).
// Runtime is plain ESM so the node test runner imports it without a transpile
// step (same convention as typebuild-transitions.mjs / task-reminders.mjs). The
// async runner + api-server wiring live in claude-stop-backstop.ts, which
// re-exports these; keep the SIDE-EFFECT-FREE decision here so it stays
// exhaustively unit-testable.
//
// See claude-stop-backstop.ts for the full ADAPTER-seam + PHI rationale. In
// brief: this is the Claude-Code lifecycle wrapper onto the provider-agnostic
// ask/answer protocol; the rule is purely STRUCTURAL (stopped + task still
// in_progress + unadvanced → flag), never transcript parsing, so no PHI is
// extracted and a normally-completed session is never flagged.

/** The generic, PHI-free flag text. Intentionally NOT derived from any
 *  transcript content — the backstop never reads the transcript. */
export const GENERIC_STOP_QUESTION =
  'This session stopped without completing the task — did it need input? ' +
  '(auto-flagged: the session ended while still in progress.)';

/** Pure decision: given the stop signal and the task's current state (read back
 *  from the source), decide whether to flag via ask_user.
 *
 *  Flag ONLY when the task is still genuinely mid-flight and unadvanced:
 *    - status is still 'in_progress' (submit/release/complete/cancel would have
 *      moved it to done/pending/cancelled), AND
 *    - no pending_question is already present (don't stomp a question the model
 *      DID log via ask_user, and don't double-flag on repeated stops).
 *
 *  No task binding, task not found, or task already advanced → noop. This is
 *  the non-regression guard: a normal completed session is never flagged.
 *
 *  @param {{task_id?: string, source_id?: string}} signal
 *  @param {{status?: string, pending_question?: {text?: string}|null}|null} task
 *  @returns {{action:'noop', reason:string} | {action:'flag', taskId:string, sourceId:string, text:string}}
 */
export function decideStopBackstop(signal, task) {
  const taskId = ((signal && signal.task_id) || '').trim();
  if (!taskId) return { action: 'noop', reason: 'no task binding' };
  const sourceId = ((signal && signal.source_id) || '').trim() || 'typebuild';

  if (!task) return { action: 'noop', reason: 'task not found / not visible' };

  // Advanced normally → the happy path. Anything other than in_progress means
  // the session (or a human) already moved it on; nothing to backstop.
  if (task.status !== 'in_progress') {
    return { action: 'noop', reason: `task advanced (status=${task.status})` };
  }

  // A structured question is already on the task — the model DID log one (or a
  // prior stop already flagged). Leave it; the attention path already sees it.
  if (task.pending_question && task.pending_question.text) {
    return { action: 'noop', reason: 'pending_question already present' };
  }

  return { action: 'flag', taskId, sourceId, text: GENERIC_STOP_QUESTION };
}
