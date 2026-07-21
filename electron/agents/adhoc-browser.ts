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

// Which agent Ctrl+B spawns (task-c4846651004b v1). 'pi' is the CURRENT
// default so the Pi operator path is testable end-to-end; flip back to
// 'claude' here (one line) to restore the Claude Code ad-hoc session. A
// per-launch/user-visible selector is the productized follow-up
// (task-98a63ab4466e).
const ADHOC_AGENT_ID: 'claude' | 'pi' = 'pi';

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
    auto_agent: ADHOC_AGENT_ID,
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
  // Server-populated playbook refresh — fire-and-forget (this launch reads the
  // copy already on disk; the fetched update lands for the next one).
  void import('./instruction-assembly').then((m) => m.refreshWorkspaceInstructions());
  const task = syntheticAdHocTask(plan.flags);

  // Pi-only pre-spawn wiring (both best-effort — the ad-hoc session is useful
  // as a pure browser driver even without TypeBuild MCP access):
  //   - seed the pi-mcp-adapter's mcp.json entry (env-var reference only,
  //     never a token on disk);
  //   - mint a TypeBuild MCP token into the PTY env, same env-var contract as
  //     the operator task launch (typebuild.ts MCP_TOKEN_ENV). Signed-out /
  //     offline → no token, the adapter's typebuild server just fails to
  //     connect and the session proceeds browser-only.
  // The Claude ad-hoc path stays MCP-less by design (see extraArgs below).
  let piEnv: Record<string, string> = {};
  if (ADHOC_AGENT_ID === 'pi') {
    try {
      await (await import('./pi')).ensurePiMcpConfig();
    } catch {
      /* config seed is additive — never block the launch */
    }
    try {
      const { mintMcpToken } = await import('../typebuild/mcp-token');
      piEnv = { TYPEBUILD_MCP_TOKEN: (await mintMcpToken()).accessToken };
    } catch {
      /* signed out / unreachable → browser-only session */
    }
  }

  // Captured before the await so the onExit closure below never references the
  // yet-unassigned `res` (mirrors the operator launcher's `let ptyId` pattern).
  let launchedPtyId = 0;
  const res = await runTaskInteractive(task, {
    agentId: ADHOC_AGENT_ID,
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
    // Claude: match the operator task flow — pin the model + load the seeded
    // permission grant explicitly (so it applies regardless of folder-trust);
    // no MCP config (browser-only by design).
    // Pi: --no-session is MANDATORY (pi session transcripts are plaintext
    // JSONL and PHI can flow through the typebuild MCP tools mid-session);
    // provider/model come from the user's own ~/.pi/agent settings. Pi has no
    // permission system — nothing to grant, nothing gates its tools (v1
    // trade-off; the tool_call-gating pi extension is task-7782ec5b0cca).
    extraArgs:
      ADHOC_AGENT_ID === 'pi'
        ? ['--no-session']
        : ['--settings', settingsPath, '--model', 'claude-sonnet-5'],
    env: piEnv,
    // Clear the reuse guard when the pty exits so the NEXT Ctrl+B spawns fresh.
    onExit: () => {
      if (adHocPtyId === launchedPtyId) adHocPtyId = null;
    },
  });

  launchedPtyId = res.ptyId;
  if (res.launched) adHocPtyId = res.ptyId;
  return { launched: res.launched, reused: false, ptyId: res.ptyId };
}
