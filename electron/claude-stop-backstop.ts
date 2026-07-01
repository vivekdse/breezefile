// Claude Code Stop-hook backstop for UNLOGGED questions (task-c926bbe959f6).
//
// THE FAILURE MODE: a model asks a question in plain conversational text and
// the session just ends. Nothing structured is recorded, so the question is
// invisible to the attention/polling system (which relies on the model
// remembering to call ask_user). This backstop fires DETERMINISTICALLY on
// session end (a Claude Code Stop hook) regardless of what the model did, and
// surfaces the miss.
//
// ADAPTER SEAM: the ask/answer protocol (ask_user / answer_question /
// pending_question) is provider-AGNOSTIC and lives in the TaskSource. This
// module is only the Claude-Code lifecycle wrapper onto it: it turns a Claude
// Code Stop-hook POST into a source.askUser() call. A different runtime (a
// future Codex/Gemini/etc. hook) needs ONLY its own lifecycle hook that posts
// the same {task_id, source_id, session_id, transcript_path} shape here — the
// protocol below does not change. Keep the Claude-specific bits (env var names,
// the transcript_path convention) in the hook script + decideStopBackstop's
// caller, not in the protocol.
//
// CONSERVATIVE, DETERMINISTIC by design: we do NOT try to parse the transcript
// and decide whether the last message "reads like a question". Extraction is
// unreliable AND PHI-risky (a transcript may contain patient data). Instead the
// rule is purely structural: a session stopped with its task STILL in_progress
// and UNADVANCED (still claimed, no formal submit/release) → flag it. A normal
// completed session has already moved the task out of in_progress, so it is
// NOT flagged (no false positives on happy-path runs). We attach a GENERIC,
// PHI-free question so nothing patient-visible is ever extracted here.
//
// PHI: transcript_path is a filesystem POINTER only — we never read the
// transcript, never log it, and never write it anywhere. The flag text is a
// fixed generic string (no PHI). If a future version DOES extract question text
// from the transcript, that text must go ONLY to source.askUser() (encrypted at
// rest server-side) and NEVER to disk/logs/skeleton — but this version does not
// extract, on purpose.

import type { SourcedTask } from './core/task-source';

/** The wire shape the /claude-stopped endpoint receives from claude-hook.sh. */
export type StopSignal = {
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
};

/** What the decision function tells the caller to do. */
export type StopDecision =
  | { action: 'noop'; reason: string }
  | { action: 'flag'; taskId: string; sourceId: string; text: string };

/** The generic, PHI-free flag text. Intentionally not derived from any
 *  transcript content — see the PHI note at the top of the file. */
export const GENERIC_STOP_QUESTION =
  'This session stopped without completing the task — did it need input? ' +
  '(auto-flagged: the session ended while still in progress.)';

/** Pure, testable decision: given the stop signal and the task's current state
 *  (as read back from the source), decide whether to flag via ask_user.
 *
 *  Flag ONLY when the task is still genuinely mid-flight and unadvanced:
 *    - status is still 'in_progress' (a submit/release/complete would have
 *      moved it to done/pending/cancelled), AND
 *    - there is no pending_question already (don't stomp a question the model
 *      DID log via ask_user, and don't double-flag on repeated stops).
 *
 *  No task binding, task not found, or task already advanced → noop. This is
 *  the non-regression guard: a normal completed session is never flagged. */
export function decideStopBackstop(
  signal: StopSignal,
  task: SourcedTask | null,
): StopDecision {
  const taskId = (signal.task_id ?? '').trim();
  if (!taskId) return { action: 'noop', reason: 'no task binding' };
  const sourceId = (signal.source_id ?? '').trim() || 'typebuild';

  if (!task) return { action: 'noop', reason: 'task not found / not visible' };

  // Advanced normally → the happy path. Anything that isn't in_progress means
  // the session (or a human) already moved it on; nothing to backstop.
  if (task.status !== 'in_progress') {
    return { action: 'noop', reason: `task advanced (status=${task.status})` };
  }

  // A structured question is already on the task — the model DID log one (or a
  // prior stop already flagged). Leave it; the attention path already sees it.
  if (task.pending_question && task.pending_question.text) {
    return { action: 'noop', reason: 'pending_question already present' };
  }

  return {
    action: 'flag',
    taskId,
    sourceId,
    text: GENERIC_STOP_QUESTION,
  };
}

/** The minimal source surface the backstop needs. Kept structural (not the full
 *  TaskSource) so a test can supply a stub, and so the dependency on the source
 *  is only these two calls. */
export interface BackstopSource {
  getTask(id: string): Promise<SourcedTask | null> | SourcedTask | null;
  askUser(
    taskId: string,
    text: string,
    options?: string[],
  ): Promise<{ ok: true } | { ok: false; reason: string; status: number }>;
}

/** Result of running the backstop end-to-end, for logging/telemetry (NON-PHI
 *  — never carries task body or question text beyond the fixed generic). */
export type BackstopOutcome =
  | { flagged: false; reason: string }
  | { flagged: true; taskId: string }
  | { flagged: false; reason: 'ask_failed'; askReason: string };

/** Run the backstop: resolve the task via the source, decide, and (if flagged)
 *  call ask_user through the SAME source the app already talks to — no new
 *  server client. Never throws: a hook-driven path must degrade quietly. */
export async function runStopBackstop(
  signal: StopSignal,
  source: BackstopSource | undefined,
): Promise<BackstopOutcome> {
  const taskId = (signal.task_id ?? '').trim();
  if (!taskId) return { flagged: false, reason: 'no task binding' };
  if (!source) return { flagged: false, reason: 'source unavailable' };

  let task: SourcedTask | null;
  try {
    task = await source.getTask(taskId);
  } catch {
    // A transient fetch failure must not flag spuriously — we can't confirm the
    // task is still in_progress, so we do nothing.
    return { flagged: false, reason: 'getTask failed' };
  }

  const decision = decideStopBackstop(signal, task);
  if (decision.action === 'noop') {
    return { flagged: false, reason: decision.reason };
  }

  try {
    const res = await source.askUser(decision.taskId, decision.text);
    if (res.ok) return { flagged: true, taskId: decision.taskId };
    return { flagged: false, reason: 'ask_failed', askReason: res.reason };
  } catch {
    return { flagged: false, reason: 'ask_failed', askReason: 'threw' };
  }
}
