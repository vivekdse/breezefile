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

import { Notification, BrowserWindow } from 'electron';
import * as tasks from './tasks';
import type { Task, TaskRun, TaskRunErrorClass } from './tasks';
import { executeTaskRun, AgentNotAvailableError } from './agents/execute';
import { defaultAgentId } from './agents/registry';
import { nextFireFromExpr } from './cron';

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
  const next = tasks.nextScheduledFire();
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
  // If we couldn't dispatch everything (concurrency cap), the timer
  // re-arms via inFlight cleanup below; otherwise re-arm for the next
  // future fire.
  if (due.length === 0 || inFlight.size < MAX_CONCURRENT) rearm();
}

async function dispatch(task: Task, attempt = 1, existingRunId?: string): Promise<void> {
  inFlight.add(task.id);
  // Clear next_run_at immediately so a slow run + a re-arm cycle don't
  // double-fire the same task. We'll set it again after the run if cron
  // dictates a future fire.
  tasks.updateTask(task.id, { next_run_at: null });

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
  // Prefer system notification when supported; in headless / test
  // environments it's a no-op which is fine.
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: `Auto-execute failed: ${task.title}`,
        body,
        silent: false,
      });
      n.show();
    }
  } catch (e) {
    console.error('[scheduler] notify:', e);
  }
  // Also tell the renderer so it can update the sidebar badge.
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('task-runs:failed', { taskId: task.id, body });
    }
  }
}
