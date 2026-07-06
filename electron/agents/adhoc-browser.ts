// Task-less ad-hoc browser session (task-2e6c926c466c).
//
// Ctrl/Cmd+B launches the embedded browser WITH a live Claude Code agent
// attached — the SAME arrangement a TypeBuild browser (operator) task gets:
// the operator window (browser LEFT, agent terminal RIGHT) driven over CDP.
// The HARD CONSTRAINT (memory: "unify, don't mirror") is that this reuses the
// ONE session-spawn + browser-pairing implementation the operator flow uses —
// runTaskInteractive — rather than hand-writing a parallel copy. We reuse:
//   - pty spawn + managed-terminal registry
//   - CDP hookup (the `playwright` flag wires BREEZE_CDP_URL/BROWSER_CLI/…)
//   - operator window open + adopt (openBrowserWindow inside runTaskInteractive)
//   - teardown-on-close (closing the operator window kills the pty)
//   - the app-owned workspace + permission grant + browser playbook
// The ONLY difference is there is NO task: we feed a synthetic, task-less Task
// with generic browser-driving instructions (no task/PHI in the prompt).

import type { Task } from '../tasks';
import { runTaskInteractive } from './interactive';
import { ensureTasksWorkspace } from './tasks-workspace';
import { buildAdHocBrowserPlan } from './adhoc-browser-plan.mjs';
import { getBrowserWindow, getPrimaryHostWindow } from '../browser/window';

// A stable, non-PHI id for the ad-hoc session. It never maps to a real task
// row (recordRun is false), only rides BREEZE_TASK_ID env for the helper CLI.
const ADHOC_TASK_ID = 'adhoc-browser';

// The pty of the CURRENTLY-LIVE ad-hoc browser session, or null when none is
// running. This is the reuse guard: a second Ctrl+B focuses the existing pair
// instead of spawning a second orphan session (requirement #5). Cleared on the
// pty's exit, so a stale id can never block a fresh launch after teardown.
let adHocPtyId: number | null = null;

export type AdHocBrowserResult = {
  /** true when a session is now live (freshly launched OR the reused one). */
  launched: boolean;
  /** true when an existing session was focused instead of spawning a new one. */
  reused: boolean;
  ptyId: number;
};

/** A minimal, task-LESS synthetic Task fed to runTaskInteractive. It carries
 *  NOTHING task-specific: no title/body content, only the generic ad-hoc
 *  flags. The prompt (generic browser-driving instructions) is passed
 *  explicitly via opts.prompt, so this task's title/notes are never used to
 *  build one. */
function syntheticAdHocTask(flags: string[]): Task {
  const now = Date.now();
  return {
    id: ADHOC_TASK_ID,
    title: 'Browser',
    notes: null,
    status: 'in_progress',
    folder: '',
    start_at: null,
    due_at: null,
    pinned: false,
    cron: null,
    next_run_at: null,
    auto_mode: false,
    auto_agent: 'claude',
    auto_prompt: null,
    flags,
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
}

/**
 * Launch (or focus) the ad-hoc browser + agent pair. Reuses the operator
 * session-spawn path via runTaskInteractive with the `playwright` flag; the
 * operator window is opened + adopted inside that call.
 */
export async function runAdHocBrowserSession(): Promise<AdHocBrowserResult> {
  // REUSE (requirement #5): if a live ad-hoc session already exists, focus its
  // operator window rather than spawning a second one. If the tracked pty is
  // set but the window is gone (e.g. the pty outlived a closed window in some
  // edge case), fall through and spawn fresh after clearing the stale id.
  if (adHocPtyId !== null) {
    const win = getBrowserWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      return { launched: true, reused: true, ptyId: adHocPtyId };
    }
    adHocPtyId = null;
  }

  const plan = buildAdHocBrowserPlan();
  // Same app-owned workspace the operator task flow uses: seeds the browser
  // playbook CLAUDE.md (auto-loaded from cwd) and the permission grant for the
  // browser helper CLI, so the agent can drive the browser without stalling on
  // per-tool prompts.
  const { cwd, settingsPath } = ensureTasksWorkspace();
  const task = syntheticAdHocTask(plan.flags);

  // Captured before the await so the onExit closure below never references the
  // yet-unassigned `res` (mirrors the operator launcher's `let ptyId` pattern).
  let launchedPtyId = 0;
  const res = await runTaskInteractive(task, {
    agentId: 'claude',
    // Bind the pty to a live MAIN window (never the operator window, which may
    // be focused after a prior session) — the operator window ADOPTS the pty
    // from the term registry regardless. undefined falls through to
    // runTaskInteractive's own hostable-window resolution.
    window: getPrimaryHostWindow() ?? undefined,
    prompt: plan.prompt,
    cwd,
    // No local task_runs row: there is no real task to key one to.
    recordRun: false,
    label: plan.label,
    source: plan.source,
    // Match the operator task flow: pin the model + load the seeded permission
    // grant explicitly (so it applies regardless of folder-trust). No MCP
    // config — this session drives the browser only; it is not a TypeBuild task.
    extraArgs: ['--settings', settingsPath, '--model', 'claude-sonnet-5'],
    // Clear the reuse guard when the pty exits so the NEXT Ctrl+B spawns fresh.
    onExit: () => {
      if (adHocPtyId === launchedPtyId) adHocPtyId = null;
    },
  });

  launchedPtyId = res.ptyId;
  if (res.launched) adHocPtyId = res.ptyId;
  return { launched: res.launched, reused: false, ptyId: res.ptyId };
}
