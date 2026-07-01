// task-c5cae3255a96 — OPTIONAL push-based wake-up runner for breezed.
//
// This is the small, side-effecting layer over the pure decision core
// (electron/core/resume-on-answer.mjs). It lives on the daemon side (breezed)
// and does three things:
//
//   1. TRACK — when breezed finishes running a task it started and that run
//      left the task parked on a `pending_question` (the agent asked something
//      and stopped), record (taskId → sessionId) so we can wake it later. The
//      session_id is the claude conversation id captured from the headless run
//      (AgentRunResult.conversationId).
//
//   2. SWEEP — on the daemon's EXISTING poll cadence (the poll-claim-execute
//      loop already sleeps POLL_IDLE_MS between claims), re-check each tracked
//      task's pending_question via the source's getTask. The pure decision
//      classifies the transition; when a question we saw go SET now reads
//      CLEARED (answered) and the task is still live, we RESUME.
//
//   3. RESUME — spawn `claude --resume <sessionId>` headlessly in the task's
//      cwd, so the parked session picks up the answer PROMPTLY instead of
//      waiting for the agent's own next poll tick. Same resume mechanism the
//      GUI uses (src/openResumeInTab.ts sends `claude --resume <id>`); we reuse
//      the same resolved claude binary (agents/claude.ts resolveClaudeBin).
//
// NON-LOAD-BEARING (the load-bearing constraint): this whole tier is a pure
// latency optimization on top of POLLING. The agent's own scheduled re-check of
// get_task is what actually unblocks it; this just wakes it sooner when breezed
// happens to hold the live session. Therefore:
//   - No breezed / this module never wired in → tier absent, poll still works.
//   - Task never tracked (no captured session, or wasn't parked) → sweep no-ops.
//   - getTask throws during a sweep → we skip that entry this pass (keep it) and
//     try next sweep; never throw up into the loop.
//   - The resume spawn fails (ENOENT, non-zero exit, whatever) → we LOG an
//     opaque short id and move on; the poll path still delivers the answer.
// Nothing here may break, hang, or drop a wake-up if it's off or failing.
//
// PHI: task titles/bodies/pending_question.text are PHI. We never read or log
// them — the pure core takes only booleans + the session_id + status, and we
// log opaque short ids only (the scheduler's shortId pattern). The session_id
// and task id are opaque, non-PHI.
//
// CROSS-PLATFORM / HEADLESS: breezed is headless (no BrowserWindow, no pty tab).
// We resume with a detached, output-discarded child process — no GUI required.
// The win32 note: breezed only runs on Linux/macOS servers today, but the spawn
// path uses resolveClaudeBin (which itself handles win32) and no OS-coupled
// calls, so it degrades cleanly anywhere.

import { spawn } from 'node:child_process';
import { resolveClaudeBin } from './claude';
import { decideResumeOnAnswer, observeTask } from '../core/resume-on-answer.mjs';
import type { TrackedSession } from '../core/resume-on-answer.d.mts';

/** The minimal source surface the sweep needs — just getTask. Kept structural
 *  (not the full TaskSource) so a test can stub it and so the dependency is a
 *  single call. Matches TypeBuildTaskSource.getTask. */
export interface ResumeSource {
  getTask(id: string): Promise<{
    status?: string;
    pending_question?: { text?: unknown } | null;
  } | null> | ({ status?: string; pending_question?: { text?: unknown } | null } | null);
}

/** What we hold per tracked task: the session + the cwd to resume it in. */
type Entry = TrackedSession & { cwd: string };

/** A short, content-free fragment of an opaque id for PHI-free logs (mirrors
 *  the scheduler's shortId). The id is not PHI. */
function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

/** Tracker for breezed-started sessions parked on a pending question. One
 *  instance per daemon; the sweep is driven off the existing poll loop. All
 *  methods are guarded so nothing here can crash the loop. */
export class ResumeOnAnswer {
  private readonly tracked = new Map<string, Entry>();

  /** How many sessions are currently tracked (for logging / tests). */
  get size(): number {
    return this.tracked.size;
  }

  /** Record that a breezed-started run ended parked on a question, so a later
   *  sweep can wake it when answered. No-op (the tier is simply absent) unless
   *  we have BOTH a session id to resume into AND a cwd. `hadPendingQuestion`
   *  MUST be true — we only track sessions we saw park; the caller decides that
   *  from the fresh task state (PHI-free boolean). */
  track(args: {
    taskId: string;
    sessionId: string | null | undefined;
    cwd: string | null | undefined;
    hadPendingQuestion: boolean;
  }): boolean {
    const { taskId, sessionId, cwd, hadPendingQuestion } = args;
    if (!taskId || !sessionId || !cwd || !hadPendingQuestion) {
      // Missing any piece → this tier can't apply. Absent, not an error.
      return false;
    }
    this.tracked.set(taskId, { taskId, sessionId, cwd, hadPendingQuestion: true });
    console.log(
      `[resume-on-answer] tracking session for task ${shortId(taskId)} (parked on a question)`,
    );
    return true;
  }

  /** Stop tracking a task (e.g. it was resumed, went terminal, or vanished). */
  untrack(taskId: string): void {
    this.tracked.delete(taskId);
  }

  /** One sweep over all tracked sessions: re-check each task's pending_question
   *  and resume the ones whose question just cleared. Safe to call on every poll
   *  tick. Never throws. Returns the number of resumes it kicked off (for tests
   *  / logging). */
  async sweep(source: ResumeSource): Promise<number> {
    if (this.tracked.size === 0) return 0;
    let resumed = 0;
    // Snapshot the entries so mutation during the loop is safe.
    for (const entry of [...this.tracked.values()]) {
      let observedRaw:
        | { status?: string; pending_question?: { text?: unknown } | null }
        | null;
      try {
        observedRaw = await source.getTask(entry.taskId);
      } catch {
        // Transient lookup failure — keep the entry, try again next sweep. The
        // poll path still delivers the answer regardless.
        continue;
      }
      const decision = decideResumeOnAnswer(entry, observeTask(observedRaw));
      if (decision.action === 'noop') {
        if (decision.drop) this.untrack(entry.taskId);
        continue;
      }
      // decision.action === 'resume'
      this.untrack(entry.taskId); // one-shot: don't re-resume the same clear.
      const ok = await this.spawnResume(entry);
      if (ok) resumed += 1;
    }
    return resumed;
  }

  /** Spawn `claude --resume <sessionId>` headlessly in the task's cwd. Detached,
   *  output discarded — breezed has no terminal to attach it to; the resumed
   *  session continues the work server-side (it will re-consult get_task, see
   *  the answer, and proceed). NEVER throws: any failure logs an opaque id and
   *  returns false so the caller falls back to the poll path. */
  private async spawnResume(entry: Entry): Promise<boolean> {
    const label = shortId(entry.taskId);
    try {
      const bin = await resolveClaudeBin();
      // Match the GUI's resume command shape (src/openResumeInTab.ts):
      //   claude --resume <conversationId>
      // Headless: no positional prompt (a resume continues the prior thread),
      // detached + stdio ignored (no tty). We do NOT wait on it — the resumed
      // session runs independently; our job is only to WAKE it.
      const child = spawn(bin, ['--resume', entry.sessionId], {
        cwd: entry.cwd,
        // Strip API-key envs like the headless runner does, so the resume uses
        // the same OAuth login (see agents/claude.ts rationale). We keep this
        // minimal: inherit env, drop the two override vars.
        env: stripApiKeyEnv(process.env),
        stdio: 'ignore',
        detached: true,
      });
      child.on('error', (e) => {
        // ENOENT / spawn failure — log opaque id, fall back to poll.
        console.error(
          `[resume-on-answer] resume spawn error for task ${label}:`,
          (e as Error).message,
        );
      });
      // Let the child outlive us; we don't track its lifecycle.
      child.unref();
      console.log(`[resume-on-answer] resumed session for task ${label} (question answered)`);
      return true;
    } catch (e) {
      // resolveClaudeBin or spawn threw synchronously — never propagate.
      console.error(
        `[resume-on-answer] resume failed for task ${label}:`,
        (e as Error).message,
      );
      return false;
    }
  }
}

/** Copy the environment with the two API-key overrides removed, so a resumed
 *  session uses the stored OAuth login (same reasoning as agents/claude.ts). */
function stripApiKeyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.ANTHROPIC_API_KEY;
  delete out.ANTHROPIC_AUTH_TOKEN;
  return out;
}
