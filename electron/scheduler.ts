// Auto-execution scheduler for breeze tasks (epic fm-zf3m).
//
// Single in-process timer keyed off MIN(next_run_at) across auto tasks.
// Re-arms whenever a task changes (created, edited, run finished). On
// fire: queue a task_runs row, dispatch via executeTaskRun, then:
//   - If cron is set, recompute next_run_at and re-arm.
//   - If one-shot, clear next_run_at so it never fires again.
//   - If the run failed with rate_limit / usage / transient → schedule
//     a retry attempt with backoff, capped at MAX_ATTEMPTS.
//   - On terminal failure → fire an electron Notification so the user
//     learns about it without staring at the app.
//
// We keep state minimal: a single Timeout, a per-task in-flight Set,
// and an in-memory backoff queue. Anything load-bearing lives in the
// task_runs / tasks tables so a crash doesn't lose work.

import { breezeHost } from './core/host';
import * as tasks from './tasks';
import type { Task, TaskRun, TaskRunErrorClass } from './tasks';
import { executeTaskRun, AgentNotAvailableError } from './agents/execute';
import { defaultAgentId } from './agents/registry';
import { isInteractive } from './agents/flags';
import { nextFireFromExpr } from './cron';
import * as overlay from './schedule-overlay';
import type { RemoteSchedule } from './schedule-overlay';
import { getTaskSource } from './sources/registry';
import type { SourcedTask } from './core/task-source';

const MAX_ATTEMPTS = 3;
const MAX_CONCURRENT = 2;

/** Backoff per attempt index (1-indexed: attempts[0] is the wait
 *  before attempt 2). Tuned for Claude rate / usage limits — first
 *  retry quick, second backs off enough to clear a per-minute bucket,
 *  third backs off enough to clear most short-window quotas. */
const BACKOFF_MS_BY_NEXT_ATTEMPT: Record<number, number> = {
  2: 60_000,        // 1 min
  3: 5 * 60_000,    // 5 min
  4: 30 * 60_000,   // 30 min (unused — we cap at 3 attempts)
};

let timer: NodeJS.Timeout | null = null;
let started = false;
const inFlight = new Set<string>(); // task ids currently running

export function startScheduler(): void {
  if (started) return;
  started = true;
  // Reap any queued/running rows from a previous process. They can't
  // recover (their setTimeout / child_process died with the old main),
  // and leaving them around makes "last run state" lie in the UI.
  reapStaleRuns();
  tasks.setTaskChangeHook(rearm);
  // fm-b5at.8 — re-arm when the remote schedule overlay changes (a schedule
  // set/cleared/rolled-forward may move the soonest fire).
  overlay.setScheduleChangeHook(rearm);
  // First arm at startup. Catches missed fires from when the app was
  // closed: any task with next_run_at <= now fires immediately.
  rearm();
  console.log('[scheduler] started');
}

function reapStaleRuns(): void {
  try {
    const reaped = tasks.reapInFlightRuns();
    if (reaped > 0) console.log(`[scheduler] reaped ${reaped} stale run row(s)`);
  } catch (e) {
    console.error('[scheduler] reap failed:', e);
  }
}

export function stopScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
}

function rearm(): void {
  if (!started) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  // Arm against the soonest fire across BOTH local auto tasks and the remote
  // schedule overlay (fm-b5at.8). Either can be null; we want the earlier of
  // the two when both exist.
  const localNext = tasks.nextScheduledFire();
  const overlayNext = safeNextOverlayFire();
  const next = minDefined(localNext, overlayNext);
  if (next == null) return;
  const wait = Math.max(0, next - Date.now());
  // Node's setTimeout caps at ~24.8 days; clamp so we re-arm before
  // overflow rather than firing at unexpected times.
  const clamped = Math.min(wait, 7 * 24 * 60 * 60 * 1000); // 7d ceiling
  timer = setTimeout(onTimer, clamped);
  if (timer.unref) timer.unref();
}

async function onTimer(): Promise<void> {
  timer = null;
  const now = Date.now();
  // Pull every task that's now due (handles a queue of catchup fires).
  const due = tasks.dueAutoTasks(now);
  for (const t of due) {
    if (inFlight.size >= MAX_CONCURRENT) break;
    if (inFlight.has(t.id)) continue;
    void dispatch(t);
  }

  // fm-b5at.8 — remote schedule overlay fires. These dispatch through the
  // owning TaskSource's runNow (interactive) rather than executeTaskRun. They
  // share the MAX_CONCURRENT budget with local auto runs. dispatchOverlay
  // ALWAYS rolls the cron forward (even on skip/notify) so a fire is never
  // burned silently and never re-fires the same minute.
  const dueOverlay = overlay.dueSchedules(now);
  for (const s of dueOverlay) {
    if (inFlight.size >= MAX_CONCURRENT) break;
    const key = overlayKey(s);
    if (inFlight.has(key)) continue;
    void dispatchOverlay(s);
  }

  // If we couldn't dispatch everything (concurrency cap), the timer
  // re-arms via inFlight cleanup below; otherwise re-arm for the next
  // future fire.
  if (
    (due.length === 0 && dueOverlay.length === 0) ||
    inFlight.size < MAX_CONCURRENT
  ) {
    rearm();
  }
}

// Overlay fires share the inFlight Set with local task ids; namespace them so
// a remote task id can't collide with a local one.
function overlayKey(s: { sourceId: string; taskId: string }): string {
  return `overlay:${s.sourceId}:${s.taskId}`;
}

// A short, content-free fragment of an opaque task id for PHI-free labels /
// notifications ("TypeBuild task a1b2c3"). The id is not PHI.
function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

/** Dispatch one due overlay schedule. Roll the cron forward UNCONDITIONALLY —
 *  whether we launch, skip, or fail — so the schedule keeps its cadence and we
 *  never burn a fire silently. The designed UX is: when registered (signed in)
 *  AND a GUI window exists, call source.runNow(taskId) (interactive — opens a
 *  tab and waits at the approval gate; the attention ping is the UX). When
 *  signed out, no window, or runNow throws (e.g. a mint error): raise a
 *  PHI-free notification pointing the user to sign in / open the app. */
async function dispatchOverlay(s: RemoteSchedule): Promise<void> {
  const key = overlayKey(s);
  inFlight.add(key);
  try {
    // Lazily prune this row first: if the task is gone or terminal server-side,
    // drop the schedule and skip the fire entirely.
    if (await overlayRowIsStale(s)) {
      overlay.clearSchedule(s.sourceId, s.taskId);
      return; // cleared — nothing to roll forward.
    }

    const source = getTaskSource(s.sourceId);
    const label = `${s.sourceId === 'typebuild' ? 'TypeBuild' : s.sourceId} task ${shortId(
      s.taskId,
    )}`;

    // Signed out: the source isn't registered. Don't burn the schedule —
    // roll forward and notify so the user knows to sign in.
    if (!source) {
      overlayNotify(
        s.taskId,
        `Scheduled ${label} could not start — open Breezefile and sign in`,
      );
      overlay.rollForward(s.sourceId, s.taskId);
      return;
    }

    // Interactive runs need a GUI window to host the tab. Under headless
    // breezed (no window) we can't open an interactive session — skip + notify.
    if (!breezeHost().hasInteractiveWindow?.()) {
      overlayNotify(
        s.taskId,
        `Scheduled ${label} could not start — open Breezefile to run it`,
      );
      overlay.rollForward(s.sourceId, s.taskId);
      return;
    }

    try {
      // runNow opens the interactive tab and waits at the approval gate (the
      // ping is the designed attention UX). manualInvocation:false marks it
      // as scheduler-driven for any source that cares.
      await source.runNow(s.taskId, { manualInvocation: false });
    } catch (e) {
      // Includes mint failures ([typebuild-mint:<code>]) and "needs an open
      // window" races. PHI-free message — only the opaque short id.
      const detail = (e as Error)?.message ?? '';
      const signedOut = /signed-out|signed out|401/i.test(detail);
      overlayNotify(
        s.taskId,
        signedOut
          ? `Scheduled ${label} could not start — open Breezefile and sign in`
          : `Scheduled ${label} could not start — open Breezefile to run it`,
      );
    }
    // Whether the launch succeeded or threw, advance the cron so we don't
    // re-fire this same minute.
    overlay.rollForward(s.sourceId, s.taskId);
  } finally {
    inFlight.delete(key);
    rearm();
  }
}

/** True when the overlay row's task no longer exists or is in a terminal state
 *  server-side. Resolves via the owning source (getTask). A source that isn't
 *  registered (signed out) or a transient lookup failure is NOT treated as
 *  stale — we keep the row so an outage doesn't silently drop a schedule. */
async function overlayRowIsStale(s: RemoteSchedule): Promise<boolean> {
  const source = getTaskSource(s.sourceId);
  if (!source) return false; // can't tell — keep it.
  try {
    const t = (await source.getTask(s.taskId)) as SourcedTask | null;
    if (t == null) return true; // gone server-side.
    return t.status === 'done' || t.status === 'cancelled';
  } catch {
    return false; // transient — keep it.
  }
}

function overlayNotify(taskId: string, body: string): void {
  // Reuse the host failure path. PHI-free: the synthetic "title" is the opaque
  // short id only (never a real task title); the full message is the body.
  try {
    breezeHost().onRunFailed({ id: taskId, title: `task ${shortId(taskId)}` }, body);
  } catch (e) {
    console.error('[scheduler] overlay notify:', e);
  }
}

function safeNextOverlayFire(): number | null {
  try {
    return overlay.nextOverlayFire();
  } catch (e) {
    console.error('[scheduler] nextOverlayFire:', e);
    return null;
  }
}

function minDefined(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

async function dispatch(task: Task, attempt = 1, existingRunId?: string): Promise<void> {
  inFlight.add(task.id);
  // Clear next_run_at immediately so a slow run + a re-arm cycle don't
  // double-fire the same task. We'll set it again after the run if cron
  // dictates a future fire.
  tasks.updateTask(task.id, { next_run_at: null });

  // fm-b5at.7 — interactive run style: a cron fire opens a tab with an
  // embedded claude session and waits at the approval gate (the fg-state
  // ping is the UX). Only when a GUI window exists; under headless breezed
  // the host reports no window and we fall through to a headless run as
  // today. We don't retry/backoff an interactive launch — the user owns
  // the session once it's open.
  if (isInteractive(task.flags) && breezeHost().hasInteractiveWindow?.()) {
    try {
      const { runTaskInteractive } = await import('./agents/interactive');
      const res = await runTaskInteractive(task, { attempt });
      if (res.launched) {
        inFlight.delete(task.id);
        rollForwardCron(task);
        rearm();
        return;
      }
      // No window after all (race) — fall through to headless.
    } catch (e) {
      notify(task, `Interactive launch failed: ${(e as Error).message}`);
      // Fall through to headless rather than dropping the fire.
    }
  }

  let run: TaskRun;
  let outcome: { ok: boolean; errorClass?: TaskRunErrorClass };
  try {
    const agentId = task.auto_agent ?? defaultAgentId() ?? undefined;
    const r = await executeTaskRun(task, {
      agentId,
      attempt,
      existingRunId,
    });
    run = r.run;
    outcome = { ok: r.result.ok, errorClass: r.result.errorClass };
  } catch (e) {
    if (e instanceof AgentNotAvailableError) {
      notify(task, `Agent unavailable: ${e.agentId}. Auto-execute skipped.`);
      inFlight.delete(task.id);
      // Don't reschedule — user must fix configuration.
      // For cron tasks we still want to roll the schedule forward so
      // we don't try this same agent every minute forever.
      rollForwardCron(task);
      rearm();
      return;
    }
    notify(task, `Auto-execute crashed: ${(e as Error).message}`);
    inFlight.delete(task.id);
    rollForwardCron(task);
    rearm();
    return;
  } finally {
    inFlight.delete(task.id);
  }

  if (outcome.ok) {
    rollForwardCron(task);
    rearm();
    return;
  }

  // Failed run. Decide retry vs. give up by error class + attempt count.
  const cls = outcome.errorClass ?? 'fatal';
  if (cls === 'fatal' || cls === 'auth' || attempt >= MAX_ATTEMPTS) {
    notifyFailure(task, run);
    rollForwardCron(task);
    rearm();
    return;
  }

  const nextAttempt = attempt + 1;
  const wait = BACKOFF_MS_BY_NEXT_ATTEMPT[nextAttempt] ?? 60_000;
  // Mark prior run as "retrying" for visibility (it'll stay 'failed'
  // in DB; we surface retry via the new run row instead).
  // Spawn a fresh queued run row so history shows each attempt.
  const queued = tasks.createRun({
    task_id: task.id,
    agent: run.agent,
    scheduled_for: Date.now() + wait,
    attempt: nextAttempt,
    status: 'queued',
  });
  setTimeout(() => {
    const fresh = tasks.getTask(task.id);
    if (!fresh) return;
    void dispatch(fresh, nextAttempt, queued.id);
  }, wait).unref?.();

  // Don't re-arm against next_run_at for the retry — we own its
  // schedule via setTimeout above. Still re-arm for unrelated tasks.
  rearm();
}

/** After a run finishes, advance next_run_at if the task has a cron
 *  expression. Keeps recurring tasks recurring; one-shot tasks stay
 *  with next_run_at=null and won't fire again unless re-saved. */
function rollForwardCron(task: Task): void {
  // Reload — task may have been edited mid-run.
  const fresh = tasks.getTask(task.id);
  if (!fresh) return;
  if (!fresh.cron) {
    // One-shot; keep auto_mode on so the user can re-trigger via UI,
    // but next_run_at stays null. We already cleared it in dispatch().
    return;
  }
  try {
    const next = nextFireFromExpr(fresh.cron, new Date());
    tasks.updateTask(fresh.id, { next_run_at: next });
  } catch (e) {
    notify(fresh, `Invalid cron "${fresh.cron}": ${(e as Error).message}`);
    tasks.updateTask(fresh.id, { auto_mode: false, next_run_at: null });
  }
}

function notifyFailure(task: Task, run: TaskRun): void {
  const cls = run.error_class ? `[${run.error_class}] ` : '';
  const msg = run.error_message ? run.error_message.slice(0, 200) : 'unknown error';
  notify(task, `${cls}${msg}`);
}

function notify(task: Task, body: string): void {
  // Delegated to the host: ElectronBreezeHost raises a system
  // Notification + renderer badge; HeadlessBreezeHost (breezed) logs.
  try {
    breezeHost().onRunFailed(task, body);
  } catch (e) {
    console.error('[scheduler] notify:', e);
  }
}
