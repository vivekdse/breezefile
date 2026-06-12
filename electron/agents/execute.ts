// executeTaskRun — orchestration glue between tasks, agents, and the
// task_runs table (epic fm-zf3m). Used by both the scheduler and the
// `run-now` API path. Does NOT decide retry / reschedule policy; that
// belongs to the scheduler so it stays in one place.

import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import * as tasks from '../tasks';
import type { Task, TaskRun } from '../tasks';
import { getAgent, defaultAgentId } from './registry';
import type { AgentRunResult } from './types';
import { breezeHost } from '../core/host';

const RUNS_ROOT = path.join(os.homedir(), '.breezefile', 'runs');

export type ExecuteOptions = {
  /** Caller-supplied. If omitted, we pick the task's auto_agent or the
   *  registry default. Surfaces "no agent available" cleanly. */
  agentId?: string;
  /** Reuse an existing queued run row (scheduler path). When omitted we
   *  insert one with status=queued. */
  existingRunId?: string;
  /** Attempt number for new run rows; ignored when reusing. */
  attempt?: number;
  /** External cancellation. The runner will SIGTERM the subprocess. */
  signal?: AbortSignal;
  /** fm-femh — manual run-now path: override the task's anchored folder
   *  with a caller-supplied cwd (e.g. the active folder tab). Required
   *  when the task itself has no folder. Ignored on the scheduler path. */
  overrideCwd?: string;
  /** fm-femh — set when the user clicked Run (sidebar / task tab /
   *  Run-task modal). Disables the "one-shot success → mark task done"
   *  auto-completion: a user manually invoking a task means they want
   *  it stay reusable (especially on-demand tasks, which fundamentally
   *  expect to fire many times). The scheduler path leaves this unset
   *  so that genuine run-once-on-save tasks still complete cleanly. */
  manualInvocation?: boolean;
};

export type ExecuteOutcome = {
  run: TaskRun;
  result: AgentRunResult;
};

// fm-h8g7 — PHI guard for run-success notifications. executeTaskRun only ever
// runs LOCAL tasks (TypeBuild tasks run interactively via the source's runNow,
// never through this headless path), so in practice `source` is local/
// undefined here. We still guard structurally: a known PHI-sensitive source
// id forces a generic, content-free notification. Kept as a tiny local table
// rather than importing the source registry to avoid an import cycle and to
// keep this module Electron-free (it also runs under headless breezed).
const PHI_SENSITIVE_SOURCES = new Set<string>(['typebuild']);
function isPhiSensitiveSource(source: string | undefined): boolean {
  return !!source && PHI_SENSITIVE_SOURCES.has(source);
}

export class AgentNotAvailableError extends Error {
  constructor(public agentId: string) {
    super(`agent not available: ${agentId}`);
    this.name = 'AgentNotAvailableError';
  }
}

/** Thrown when a second run is requested for a task that already has
 *  one in flight. The renderer's UI guard catches the common case
 *  (disabled button), but the API server + scheduler can still race —
 *  this is the backend's last-line dedupe. */
export class TaskAlreadyRunningError extends Error {
  constructor(public taskId: string, public runId: string) {
    super(`task ${taskId} already has a run in progress (${runId})`);
    this.name = 'TaskAlreadyRunningError';
  }
}

// fm-femh — registry of in-flight runs so the renderer can cancel by
// run id. Populated only when the caller didn't provide their own
// signal — anyone who passes a signal is responsible for their own
// cancellation. Cleaned up in a finally block so a panic can't strand
// an entry forever.
const inflight = new Map<string, AbortController>();

/** Send SIGTERM to the subprocess of the given run. Returns true when a
 *  run was found and aborted. The agent runner translates the abort into
 *  a graceful shutdown + a `cancelled` result; updateRun then writes
 *  status='cancelled' to the row. */
export function cancelRun(runId: string): boolean {
  const c = inflight.get(runId);
  if (!c) return false;
  c.abort();
  return true;
}

export async function executeTaskRun(
  task: Task,
  opts: ExecuteOptions = {},
): Promise<ExecuteOutcome> {
  const agentId =
    opts.agentId ??
    task.auto_agent ??
    defaultAgentId() ??
    null;
  if (!agentId) throw new AgentNotAvailableError('<none registered>');
  const agent = getAgent(agentId);
  if (!agent) throw new AgentNotAvailableError(agentId);

  // Refuse to start a second concurrent run for the same task. Reusing
  // an existing row (scheduler retry path) is exempt — that's the same
  // run continuing, not a new one.
  if (!opts.existingRunId) {
    const inflight = tasks.getInflightRun(task.id);
    if (inflight) throw new TaskAlreadyRunningError(task.id, inflight.id);
  }

  const now = Date.now();
  let run: TaskRun;
  if (opts.existingRunId) {
    const existing = tasks.getRun(opts.existingRunId);
    if (!existing) throw new Error(`run not found: ${opts.existingRunId}`);
    run = existing;
  } else {
    run = tasks.createRun({
      task_id: task.id,
      agent: agentId,
      scheduled_for: now,
      attempt: opts.attempt ?? 1,
      status: 'queued',
    });
  }

  const outputDir = path.join(RUNS_ROOT, run.id);
  mkdirSync(outputDir, { recursive: true });

  run = tasks.updateRun(run.id, {
    status: 'running',
    started_at: Date.now(),
    output_path: outputDir,
  });

  // Register a cancellation handle if the caller didn't pre-supply one
  // — that's how the renderer's cancel button reaches into a running
  // subprocess (see cancelRun above).
  let ownedAbort: AbortController | null = null;
  let signal: AbortSignal;
  if (opts.signal) {
    signal = opts.signal;
  } else {
    ownedAbort = new AbortController();
    signal = ownedAbort.signal;
    inflight.set(run.id, ownedAbort);
  }

  const effectiveCwd = (opts.overrideCwd?.trim() || task.folder?.trim() || '');
  if (!effectiveCwd) {
    if (ownedAbort) inflight.delete(run.id);
    throw new Error(
      `task ${task.id} has no folder and no overrideCwd was supplied`,
    );
  }
  const prompt = buildPrompt(task, effectiveCwd);

  let result: AgentRunResult;
  try {
    result = await agent.run({
      prompt,
      cwd: effectiveCwd,
      taskId: task.id,
      runId: run.id,
      outputDir,
      signal,
      flags: task.flags,
    });
  } catch (e) {
    const err = e as Error;
    result = {
      ok: false,
      conversationId: null,
      exitCode: null,
      durationMs: 0,
      errorClass: 'fatal',
      errorMessage: err.message,
    };
  } finally {
    if (ownedAbort) inflight.delete(run.id);
  }

  // fm-femh — distinguish user-cancelled from genuine failures so the
  // run history doesn't paint a deliberate stop in red.
  const wasCancelled =
    !result.ok && (signal.aborted || result.errorMessage === 'cancelled');
  run = tasks.updateRun(run.id, {
    status: result.ok
      ? 'succeeded'
      : wasCancelled
        ? 'cancelled'
        : 'failed',
    finished_at: Date.now(),
    conversation_id: result.conversationId,
    exit_code: result.exitCode,
    error_class: result.errorClass ?? null,
    error_message: result.errorMessage ?? null,
  });

  // fm-h8g7 — run-success notification, mirror of the scheduler's failure
  // path. Fire on a SUCCESSFUL run so the user learns a long unattended run
  // finished without staring at the app. The host decides OS-notification
  // verbosity + the manual/focus suppression (manual run-now while a Breeze
  // window is focused → no OS noise; unfocused → notify).
  //
  // PHI guard: executeTaskRun only ever runs LOCAL tasks (TypeBuild runs are
  // interactive via the source's runNow, never here) — but guard anyway. A
  // task whose `source` is a phiSensitive source forces a generic, content-
  // free notification (no title/body in the OS notification or the body).
  // Local task titles are NOT PHI (per fm-h8g7) so they may appear.
  if (result.ok) {
    const phiSensitive = isPhiSensitiveSource((task as { source?: string }).source);
    // Short body: a generic line for now (run output isn't surfaced as text
    // here, and reading it risks leaking content for PHI sources). Truncate
    // defensively in case a future caller passes a richer body.
    const body = 'Agent run finished';
    try {
      breezeHost().onRunSucceeded?.(
        { id: task.id, title: task.title },
        body.slice(0, 80),
        { manualInvocation: opts.manualInvocation, phiSensitive },
      );
    } catch (e) {
      console.error('[execute] onRunSucceeded:', e);
    }
  }

  // fm-zf3m / fm-femh — status follow-through:
  //   scheduler one-shot + success  → mark task done (run-once-on-save
  //                                    semantic: scheduler fired it, the
  //                                    user said "do this once and stop")
  //   manual click + success        → leave status alone (user might
  //                                    re-run; on-demand explicitly so)
  //   recurring auto                → leave alone (should recur forever)
  //   any auto + failure            → leave alone (lets retry / re-run)
  // Re-fetch in case the user edited the task mid-run.
  if (result.ok && !opts.manualInvocation) {
    const fresh = tasks.getTask(task.id);
    if (fresh && !fresh.cron && fresh.status !== 'done') {
      tasks.updateTask(task.id, { status: 'done' });
    }
  }

  return { run, result };
}

/** Compose the prompt the agent sees. Override wins; otherwise we
 *  weave together the task's title + notes + a small context preamble
 *  so the agent knows why it's been invoked unattended. */
export function buildPrompt(task: Task, cwd: string = task.folder): string {
  if (task.auto_prompt && task.auto_prompt.trim()) {
    return task.auto_prompt.trim();
  }
  const parts: string[] = [];
  parts.push(
    `You are running unattended via Breeze auto-execute. Complete the task` +
      ` below in the current working directory (${cwd}). When you` +
      ` finish, summarise what you did in your final message.`,
  );
  parts.push('');
  parts.push(`# ${task.title}`);
  if (task.notes && task.notes.trim()) {
    parts.push('');
    parts.push(task.notes.trim());
  }
  return parts.join('\n');
}
