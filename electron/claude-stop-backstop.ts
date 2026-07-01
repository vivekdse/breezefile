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
// The pure, side-effect-free decision core lives in the paired .mjs so the
// node test runner imports it without a transpile step (same convention as
// task-reminders.ts ← core/task-reminders.mjs). This .ts is only the async
// runner + api-server glue on top; it re-exports the pure surface so callers
// have a single import site.
import { decideStopBackstop, GENERIC_STOP_QUESTION } from './claude-stop-backstop.mjs';
import type { StopSignal, StopDecision } from './claude-stop-backstop.d.mts';

export { decideStopBackstop, GENERIC_STOP_QUESTION };
export type { StopSignal, StopDecision };

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
