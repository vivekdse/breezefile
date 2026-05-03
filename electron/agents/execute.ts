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
};

export type ExecuteOutcome = {
  run: TaskRun;
  result: AgentRunResult;
};

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

  const signal = opts.signal ?? new AbortController().signal;
  const prompt = buildPrompt(task);

  let result: AgentRunResult;
  try {
    result = await agent.run({
      prompt,
      cwd: task.folder,
      taskId: task.id,
      runId: run.id,
      outputDir,
      signal,
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
  }

  run = tasks.updateRun(run.id, {
    status: result.ok ? 'succeeded' : 'failed',
    finished_at: Date.now(),
    conversation_id: result.conversationId,
    exit_code: result.exitCode,
    error_class: result.errorClass ?? null,
    error_message: result.errorMessage ?? null,
  });

  // fm-zf3m — status follow-through:
  //   one-shot auto + success  → mark task done (user said "do this once",
  //                              succeeding satisfies that intent)
  //   recurring auto           → leave status alone (it should recur forever)
  //   any auto + failure       → leave status alone (lets retry / re-run)
  // Re-fetch in case the user edited the task mid-run.
  if (result.ok) {
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
export function buildPrompt(task: Task): string {
  if (task.auto_prompt && task.auto_prompt.trim()) {
    return task.auto_prompt.trim();
  }
  const parts: string[] = [];
  parts.push(
    `You are running unattended via Breeze auto-execute. Complete the task` +
      ` below in the current working directory (${task.folder}). When you` +
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
