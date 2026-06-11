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
  /** When false, no local task_runs row is created (and no exit
   *  finalization runs). REQUIRED for remote sources whose task ids have no
   *  local `tasks` row: task_runs.task_id has a FK → tasks(id) with
   *  foreign_keys=ON, so inserting a run for a remote id would throw.
   *  Defaults to true (the local interactive path is unchanged). */
  recordRun?: boolean;
  /** Tab/terminal label broadcast to the renderer. Defaults to task.title.
   *  PHI-sensitive sources MUST pass a generic, content-free label (the
   *  title is PHI and the tab label can be surfaced in the renderer). */
  label?: string;
  /** Extra env layered onto the PTY (e.g. a marker so the renderer knows
   *  this is a TypeBuild tab for the OAuth hint). Never put PHI here. */
  env?: Record<string, string>;
  /** Called after the PTY exits (after any run finalization). Lets the
   *  caller react — e.g. TypeBuild refreshes the source + offers Release. */
  onExit?: (info: { exitCode: number; signal: number | null }) => void;
  /** Owning source id, threaded into the broadcast so the renderer can gate
   *  PHI-aware tab behavior. Defaults to 'local'. */
  source?: string;
};

export type InteractiveRunResult = {
  /** The recorded run row, or null when run recording was skipped. */
  run: TaskRun | null;
  ptyId: number;
  /** false when no window was available to host the tab (caller should fall
   *  back to a headless run). */
  launched: boolean;
};

export type InteractiveRunPayload = {
  taskId: string;
  /** Local run id, or null when run recording is skipped (remote sources). */
  runId: string | null;
  ptyId: number;
  /** Tab/terminal label. Generic + content-free for PHI-sensitive sources. */
  title: string;
  cwd: string;
  /** Owning source id ('local' by default). The renderer uses this to gate
   *  PHI-aware tab behavior (e.g. the TypeBuild OAuth hint). */
  source?: string;
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
    return { run: null, ptyId: 0, launched: false };
  }

  const agentId = opts.agentId ?? task.auto_agent ?? defaultAgentId() ?? 'claude';
  const cwd = (opts.cwd?.trim() || task.folder?.trim() || os.homedir());
  const prompt = (opts.prompt?.trim() || buildPrompt(task, cwd));

  // Local task_runs row — SKIPPED for remote sources. task_runs.task_id has a
  // FK → tasks(id) (foreign_keys=ON), and a remote (e.g. TypeBuild) id has no
  // local row, so inserting one would throw. The server tracks run status for
  // those; the live terminal is the local trace.
  const recordRun = opts.recordRun !== false;
  const run: TaskRun | null = recordRun
    ? tasks.createRun({
        task_id: task.id,
        agent: agentId,
        scheduled_for: Date.now(),
        attempt: opts.attempt ?? 1,
        status: 'running',
      })
    : null;
  if (run) tasks.updateRun(run.id, { started_at: Date.now() });

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
      ...(run ? { BREEZE_RUN_ID: run.id } : {}),
      ...(opts.env ?? {}),
    },
    onExit: ({ exitCode, signal }) => {
      if (run) {
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
      }
      try {
        opts.onExit?.({ exitCode, signal });
      } catch (e) {
        console.error('[interactive] onExit hook:', e);
      }
    },
  });

  const payload: InteractiveRunPayload = {
    taskId: task.id,
    runId: run ? run.id : null,
    ptyId,
    // PHI: for content-sensitive sources the caller passes a generic label;
    // otherwise we use the (local, non-PHI) task title.
    title: opts.label?.trim() || task.title,
    cwd,
    source: opts.source ?? 'local',
  };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('tasks:interactiveRun', payload);
  }

  return { run, ptyId, launched: true };
}
