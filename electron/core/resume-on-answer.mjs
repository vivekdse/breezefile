// task-c5cae3255a96 — PURE decision core for the OPTIONAL push-based wake-up
// of breezed-tracked sessions when a pending question is answered.
//
// THE TIER (non-load-bearing, latency only): the DEFAULT wake-up when an agent
// is parked on a `pending_question` is POLLING — a scheduled re-check of
// get_task until the question clears, then the agent continues on its own next
// tick. THIS module powers an optional improvement layered on top: breezed
// already starts sessions and knows their session_id, so when it observes a
// task it started go from "question set" → "question cleared" (answered), it can
// RESUME that local session promptly (`claude --resume <session_id>`) instead of
// waiting for the agent's own poll. If breezed isn't present, or a task isn't
// tied to a live tracked session, this tier is simply ABSENT and polling still
// works. Nothing here is load-bearing.
//
// This file is the PURE decision: given what breezed is tracking for a task and
// the freshly-observed task state, decide "resume this session_id" | "no-op"
// (and why). No I/O, no Date.now(), no electron, no subprocess — so it's
// trivially unit-testable and identical in main, breezed, and tests. The side
// effects (poll cadence, spawning the resume, updating the tracking map) live in
// the small .ts runner that consumes this (electron/agents/resume-on-answer.ts).
//
// PHI: the question TEXT is PHI. This decision never needs it — it keys only on
// the STRUCTURAL transition (a question was present, now it is not) plus the
// session_id (opaque, non-PHI) and the task status. Callers log opaque short ids
// only. We deliberately take a boolean `hadPendingQuestion` and a boolean
// `hasPendingQuestion` rather than the question objects, so no PHI can flow
// through this module at all.

/**
 * A session breezed started and is tracking for the resume-on-answer tier.
 * @typedef {Object} TrackedSession
 * @property {string} taskId          opaque task id (non-PHI)
 * @property {string} sessionId       claude session_id captured at launch (non-PHI)
 * @property {boolean} hadPendingQuestion  true iff the task was observed parked on a question when tracked
 */

/**
 * The freshly-observed task state, distilled to the PHI-free bits the decision
 * needs. `hasPendingQuestion` is derived by the caller from the task's
 * `pending_question` field (present + non-empty → true) WITHOUT passing the
 * question text here.
 * @typedef {Object} ObservedTask
 * @property {boolean} exists              false when getTask returned null (task gone server-side)
 * @property {boolean} hasPendingQuestion  true iff pending_question is currently set
 * @property {string} [status]             mapped status ('in_progress' | 'done' | 'cancelled' | ...)
 */

/**
 * @typedef {(
 *   | { action: 'resume', taskId: string, sessionId: string }
 *   | { action: 'noop', reason: string, drop?: boolean }
 * )} ResumeDecision
 *
 * `drop: true` on a noop tells the runner to STOP tracking this session (it is
 * terminal / gone / has no session to resume) so the tracking map doesn't leak.
 * A plain noop (no `drop`) means "keep watching — nothing to do yet."
 */

/**
 * Decide whether an answered question should resume a breezed-tracked session.
 *
 * The rule is purely structural and conservative:
 *   - Not tracked / no session_id     → noop (never our concern). drop.
 *   - Task gone server-side           → noop, drop (nothing to resume).
 *   - Task terminal (done/cancelled)  → noop, drop (the run finished; a resume
 *                                       would be meaningless / could re-open work).
 *   - Was NOT parked on a question    → noop, drop (we only wake sessions that we
 *                                       saw go to a question; anything else is
 *                                       the poll path's job, not ours).
 *   - Still has a pending question    → noop, KEEP watching (not answered yet).
 *   - Was parked, now cleared, still  → RESUME that session_id. This is the one
 *     live/non-terminal                 transition set→null we act on.
 *
 * @param {TrackedSession | null | undefined} tracked
 * @param {ObservedTask | null | undefined} observed
 * @returns {ResumeDecision}
 */
export function decideResumeOnAnswer(tracked, observed) {
  if (!tracked || typeof tracked.taskId !== 'string' || !tracked.taskId) {
    return { action: 'noop', reason: 'not tracked', drop: true };
  }
  if (typeof tracked.sessionId !== 'string' || !tracked.sessionId) {
    // No live session id to resume into — the whole point of this tier is a
    // known session_id; without one there is nothing to push. Poll still works.
    return { action: 'noop', reason: 'no session id', drop: true };
  }
  if (!tracked.hadPendingQuestion) {
    // We only wake sessions we saw PARK on a question. If it was never parked,
    // there is no set→null transition for us to ride.
    return { action: 'noop', reason: 'was not parked on a question', drop: true };
  }
  if (!observed || observed.exists === false) {
    // Task vanished server-side — nothing to resume.
    return { action: 'noop', reason: 'task gone', drop: true };
  }
  if (observed.status === 'done' || observed.status === 'cancelled') {
    // Terminal server-side — the work is closed; resuming would be wrong.
    return { action: 'noop', reason: 'task terminal', drop: true };
  }
  if (observed.hasPendingQuestion) {
    // Still waiting on an answer — keep watching, don't drop.
    return { action: 'noop', reason: 'still pending' };
  }
  // Was parked on a question, question is now cleared, task still live: resume.
  return { action: 'resume', taskId: tracked.taskId, sessionId: tracked.sessionId };
}

/**
 * Distill a getTask result into the PHI-free ObservedTask shape the decision
 * consumes. Takes ONLY the structural bits — never carries the question text.
 * `hasPendingQuestion` is true when pending_question is a non-empty object with
 * some text; a null/undefined/empty question counts as cleared.
 *
 * @param {{ status?: string, pending_question?: { text?: unknown } | null } | null | undefined} task
 * @returns {ObservedTask}
 */
export function observeTask(task) {
  if (!task) return { exists: false, hasPendingQuestion: false };
  const pq = task.pending_question;
  const hasPendingQuestion =
    !!pq && typeof pq === 'object' && typeof pq.text === 'string' && pq.text.trim().length > 0;
  return {
    exists: true,
    hasPendingQuestion,
    status: typeof task.status === 'string' ? task.status : undefined,
  };
}
