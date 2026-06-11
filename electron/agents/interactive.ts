// Interactive task run style (fm-b5at.7).
//
// The headless path (executeTaskRun + claudeAgent) runs `claude -p` as a
// fire-and-forget subprocess. The interactive path instead spawns `claude`
// as the process of an embedded PTY in a new tab, so the user converses
// and approves the run inside Breeze. The human-gated approval IS the UX:
// the fg-state hooks (fm-z7v) tint the tab and ping when claude goes to
// 'waiting', so the user is pulled back to the tab at each gate.
//
// We still record a task_runs row (status 'running' while the PTY lives,
// finalized from the exit code on close). Limitation, by design: no
// stream.jsonl / conversation_id capture in interactive mode — those stay
// null. The trace lives in the live terminal instead.

import os from 'node:os';
import { BrowserWindow } from 'electron';
import * as tasks from '../tasks';
import type { Task, TaskRun } from '../tasks';
import { buildPrompt } from './execute';
import { defaultAgentId } from './registry';
import { flagsToArgs } from './flags';
import { resolveClaudeBin } from './claude';
import { spawnManagedPty, reservePtyId } from '../ipc';

export type InteractiveRunOptions = {
  /** Agent id for the run row. Defaults to task.auto_agent or the registry
   *  default. Only 'claude' is launchable interactively today. */
  agentId?: string;
  /** Override the resolved prompt (TypeBuild Start passes a custom one). */
  prompt?: string;
  /** Override the working directory (else task.folder, else home). */
  cwd?: string;
  /** Extra claude args appended after the flags-derived args. */
  extraArgs?: string[];
  /** Window to attach the tab to. Defaults to the focused window, then the
   *  first open window. */
  window?: BrowserWindow;
  /** Attempt number for the run row. */
  attempt?: number;
};

export type InteractiveRunResult = {
  run: TaskRun;
  ptyId: number;
  /** false when no window was available to host the tab (caller should fall
   *  back to a headless run). */
  launched: boolean;
};

export type InteractiveRunPayload = {
  taskId: string;
  runId: string;
  ptyId: number;
  title: string;
  cwd: string;
};

/** Launch a task as an interactive embedded-terminal claude session.
 *  Creates a running task_runs row, spawns the PTY, broadcasts
 *  `tasks:interactiveRun` so the renderer opens a tab attached to the
 *  ptyId, and finalizes the run row on PTY exit. */
export async function runTaskInteractive(
  task: Task,
  opts: InteractiveRunOptions = {},
): Promise<InteractiveRunResult> {
  const win =
    opts.window ??
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
    null;
  if (!win || win.isDestroyed()) {
    // No GUI window to host the tab — caller decides whether to fall back
    // to headless. We don't create a run row in that case.
    return { run: undefined as unknown as TaskRun, ptyId: 0, launched: false };
  }

  const agentId = opts.agentId ?? task.auto_agent ?? defaultAgentId() ?? 'claude';
  const cwd = (opts.cwd?.trim() || task.folder?.trim() || os.homedir());
  const prompt = (opts.prompt?.trim() || buildPrompt(task, cwd));

  const run = tasks.createRun({
    task_id: task.id,
    agent: agentId,
    scheduled_for: Date.now(),
    attempt: opts.attempt ?? 1,
    status: 'running',
  });
  tasks.updateRun(run.id, { started_at: Date.now() });

  const bin = await resolveClaudeBin();
  const { args: flagArgs, unknown } = flagsToArgs(task.flags);
  if (unknown.length) {
    console.warn('[interactive] ignoring unknown task flags:', unknown.join(', '));
  }
  // Positional prompt arg launches claude interactively pre-seeded with the
  // task; flags map to CLI args; --add-dir grants the cwd. No -p (that's
  // the headless one-shot mode).
  const args = [
    ...flagArgs,
    ...(opts.extraArgs ?? []),
    '--add-dir', cwd,
    prompt,
  ];

  const ptyId = reservePtyId();
  spawnManagedPty({
    id: ptyId,
    file: bin,
    args,
    cwd,
    cols: 80,
    rows: 24,
    senderId: win.webContents.id,
    env: {
      BREEZE_TASK_ID: task.id,
      BREEZE_RUN_ID: run.id,
    },
    onExit: ({ exitCode }) => {
      try {
        tasks.updateRun(run.id, {
          status: exitCode === 0 ? 'succeeded' : 'failed',
          finished_at: Date.now(),
          exit_code: exitCode,
          // No stream capture in interactive mode.
          conversation_id: null,
          error_class: exitCode === 0 ? null : 'fatal',
          error_message: exitCode === 0 ? null : `claude exited ${exitCode}`,
        });
      } catch (e) {
        console.error('[interactive] finalize run:', e);
      }
    },
  });

  const payload: InteractiveRunPayload = {
    taskId: task.id,
    runId: run.id,
    ptyId,
    title: task.title,
    cwd,
  };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('tasks:interactiveRun', payload);
  }

  return { run, ptyId, launched: true };
}
