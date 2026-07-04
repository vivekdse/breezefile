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
import { openBrowserWindow, markSessionEnded } from '../browser/window';
import { resolveClaudeBin } from './claude';
import { spawnManagedPty, reservePtyId } from '../ipc';
import { CDP_URL, BROWSER_CLI, TOOLS_CLI } from '../browser/automation';

export type InteractiveRunOptions = {
  /** Agent id for the run row. Defaults to task.auto_agent or the registry
   *  default. Only 'claude' is launchable interactively today. */
  agentId?: string;
  /** Override the resolved prompt (TypeBuild Start passes a custom one). */
  prompt?: string;
  /** When true, NO positional prompt is passed to claude. Used by the
   *  TypeBuild expiry relaunch (fm-b5at.10): it respawns with --continue
   *  (resume flag) to pick up the existing conversation, and a positional
   *  prompt alongside --continue would seed a NEW message (re-running the
   *  /work claim). Omitting it makes --continue a clean resume. */
  omitPrompt?: boolean;
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
   *  PHI-aware tab behavior. Omitted when not passed. */
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
  /** Owning source id (omitted when not passed). The renderer uses this to
   *  gate PHI-aware tab behavior (e.g. the TypeBuild OAuth hint). */
  source?: string;
  /** True when this session is hosted in the operator window (playwright/
   *  browser tasks). The operator window's terminal ADOPTS the pty directly, so
   *  the main window must NOT open a redundant owner tab — see src/App.tsx. */
  operator?: boolean;
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
  const { args: flagArgs, unknown, playwright } = flagsToArgs(task.flags);
  if (unknown.length) {
    console.warn('[interactive] ignoring unknown task flags:', unknown.join(', '));
  }

  // task-93576169693f — inject the GLOBAL server-hosted operator instructions
  // into standalone interactive sessions too (TypeBuild-launched ones already do
  // this in electron/sources/typebuild.ts; this covers the non-TypeBuild
  // `claude` path). REUSES the same fetch+append helper.
  //
  // SCOPE DECISION: the operator-instructions doc is the BROWSER playbook —
  // standing guidance for operating the user's browser (selectors / fast paths /
  // gotchas). It is browser-operator-specific, NOT general agent guidance, so we
  // inject it ONLY for browser runs — those carrying the `playwright` flag (the
  // in-app analog of `chrome`, the flag that points the helper CLIs at Breeze's
  // CDP and opens the operator window below). A plain interactive run (e.g. a
  // coding task) gets nothing, so the doc never bloats unrelated sessions.
  //
  // Defensive + additive: any failure (offline, unset doc) leaves it empty and
  // the launch proceeds on the bundled playbook. NON-PHI standing guidance —
  // never a value; never logged.
  let operatorInstructions = '';
  if (playwright) {
    try {
      const { fetchOperatorInstructions } = await import('../typebuild/operator-instructions');
      const oi = await fetchOperatorInstructions('global');
      operatorInstructions = oi.body.trim();
    } catch {
      /* server-hosted instructions are additive — never block a launch on them */
    }
  }

  // SPIKE (spike/playwright-cdp): the `playwright` flag is the in-app analog of
  // `chrome` — it opens the side-by-side browser WINDOW (below) and points the
  // helper CLIs at its CDP endpoint. The browser PLAYBOOK is no longer appended
  // here: a browser session loads it from workspace memory (a seeded CLAUDE.md
  // auto-loaded from cwd), or the caller folds it into the prompt when running
  // outside that workspace (electron/sources/typebuild.ts). The prompt we were
  // handed is therefore authoritative.
  const effectivePrompt = prompt;
  // Positional prompt arg launches claude interactively pre-seeded with the
  // task; flags map to CLI args; --add-dir grants the cwd. No -p (that's
  // the headless one-shot mode). On a resume relaunch (omitPrompt) we drop
  // the positional prompt entirely so --continue resumes the prior
  // conversation cleanly instead of injecting a fresh message.
  //
  // The `--` is load-bearing: `--add-dir <directories...>` is variadic, so a
  // bare positional prompt right after `--add-dir cwd` gets swallowed as a
  // second directory and claude launches with NO prompt (empty box, nothing
  // runs). `--` terminates option parsing so the prompt lands as the
  // positional arg. Only emitted when we actually pass a prompt.
  const args = [
    ...flagArgs,
    ...(opts.extraArgs ?? []),
    // task-93576169693f — global operator instructions as a system-prompt
    // addendum (browser runs only; empty when unset/offline → omitted).
    ...(operatorInstructions ? ['--append-system-prompt', operatorInstructions] : []),
    '--add-dir', cwd,
    ...(opts.omitPrompt ? [] : ['--', effectivePrompt]),
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
      // task-c926bbe959f6 — the Stop backstop forwards this so the app can
      // route the stopped-session check to the owning TaskSource. Defaults to
      // 'typebuild' (the only phiSensitive/ask_user-capable source today) when
      // the caller didn't tag a source.
      BREEZE_SOURCE_ID: opts.source ?? 'typebuild',
      ...(run ? { BREEZE_RUN_ID: run.id } : {}),
      // SPIKE (spike/playwright-cdp): point the helper CLIs at Breeze's CDP.
      // BREEZE_TOOLS_CLI is the tool-repository CLI the agent consults first.
      ...(playwright
        ? { BREEZE_CDP_URL: CDP_URL, BREEZE_BROWSER_CLI: BROWSER_CLI, BREEZE_TOOLS_CLI: TOOLS_CLI }
        : {}),
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
      // task-8997b15a37d9 — the operator splash only clears on a real agent
      // `goto`; a task that never touches the browser would otherwise show
      // "Setting up the browser" for the entire session and after it ends.
      // Swap it to the static "done" card if it's still showing.
      if (playwright) {
        try {
          markSessionEnded(ptyId);
        } catch (e) {
          console.error('[interactive] markSessionEnded:', e);
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
    ...(opts.source ? { source: opts.source } : {}),
    // Playwright sessions are hosted in the operator window (opened below); the
    // terminal there adopts the pty directly, so suppress the main-window tab.
    ...(playwright ? { operator: true } : {}),
  };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('tasks:interactiveRun', payload);
  }

  // SPIKE (spike/playwright-cdp): for playwright tasks, open the operator
  // session window — a split pane with the browser page LEFT and this pty's
  // Claude-Code terminal RIGHT — so the user sees the page AND what Claude is
  // doing at once. See electron/browser/window.ts + OperatorSession.tsx.
  // Reuse re-points the window to THIS ptyId (window.ts), so a second Start
  // shows the new session instead of a stale, dead mirror.
  //
  // No start url: the operator page view defaults to the themed "starting your
  // task" splash (task-3a49fb5adf24 / task-d85d23f3aea4) and the agent drives
  // the first REAL navigation via the helper's `goto`. We used to pass a literal
  // 'https://example.com' here, which made task start flash that meaningless
  // placeholder instead of the splash — never do that.
  if (playwright) openBrowserWindow(undefined, ptyId);

  return { run, ptyId, launched: true };
}
