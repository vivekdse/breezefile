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
import {
  spawnManagedPty,
  reservePtyId,
  awaitPtyLiveness,
  awaitPtyInputReady,
  writeManagedPty,
  killManagedPty,
} from '../ipc';
import type { PtyLivenessVerdict } from '../ipc';
import { browserCliEnv } from '../browser/automation';
import { startTiming, timing } from '../core/launch-timing';

export type InteractiveRunOptions = {
  /** Agent id for the run row AND the spawned binary. Defaults to
   *  task.auto_agent or the registry default. 'claude' and 'pi' are launchable
   *  interactively today (task-c4846651004b v1: pi rides the same pty/window/
   *  CDP plumbing; only the binary + argv shape differ — see the arg build
   *  below). */
  agentId?: string;
  /** Override the resolved prompt (TypeBuild Start passes a custom one). */
  prompt?: string;
  /** When true, NO positional prompt is passed to claude. Used by the
   *  TypeBuild expiry relaunch (fm-b5at.10): it respawns with --continue
   *  (resume flag) to pick up the existing conversation, and a positional
   *  prompt alongside --continue would seed a NEW message (re-running the
   *  /work claim). Omitting it makes --continue a clean resume. */
  omitPrompt?: boolean;
  /** task-bd35fc4330c0 (follow-up) — when true, the positional prompt is
   *  SUPPRESSED and the `workBundle` (injected over stdin once the session is
   *  live) is the agent's FIRST and only seeded turn. This is how a pre-claimed
   *  TypeBuild Start avoids the agent's opening `get_task`: the old argv prompt
   *  ("Run /typebuild:typebuild-work for task X") launches the work loop
   *  immediately, so the agent calls get_task to read the body BEFORE the
   *  ~5s-delayed bundle lands. With this flag the agent instead sits at an idle
   *  TUI for the liveness window and its first turn is the full bundle (body +
   *  inputs + outputs + run-the-loop instruction) — zero opening fetch.
   *  The CALLER must only set this when `workBundle` is non-empty: suppressing
   *  the prompt with an empty bundle would launch an agent with NO instruction
   *  at all. Distinct from `omitPrompt` (a --continue resume, which seeds
   *  NOTHING — neither prompt nor bundle). */
  promptViaBundle?: boolean;
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
  /** task-6fc9e503623e — when set, the launcher AWAITS a liveness verdict
   *  before returning: the result's `liveness` says whether the claude child
   *  stayed alive `minAliveMs` (or emitted first output) vs exited early. The
   *  TypeBuild Start passes this so an instantly-dying auto-continue session is
   *  caught (claim released + exit code/tail recorded) instead of reported as a
   *  running session. Omitted → legacy fire-and-forget (returns as soon as the
   *  pty is spawned). */
  awaitLiveness?: { minAliveMs?: number };
  /** task-bd35fc4330c0 — a pre-assembled, PHI-bearing task-work bundle (title +
   *  full body + resolved input values + output schema/evidence instruction +
   *  project instructions + attached skills) delivered as the agent's FIRST
   *  message via STDIN INJECTION, not argv and not --append-system-prompt —
   *  see electron/typebuild/task-work-bundle.ts for why (PHI must never ride
   *  argv or disk). Paired with `promptViaBundle`: when that flag is set the
   *  positional `prompt` is suppressed and THIS bundle is the agent's first and
   *  only seeded turn (typed into the pty's stdin once the session proves live),
   *  so its framing line must itself start the work loop — see
   *  electron/typebuild/task-work-bundle.ts. When `promptViaBundle` is NOT set
   *  (e.g. the non-liveness `claude` path), the positional prompt still seeds
   *  turn one and this bundle follows as a second stdin message. Omitted →
   *  legacy behavior (positional prompt only, agent fetches the rest itself via
   *  get_task). Ignored when `omitPrompt` is set (a --continue resume already
   *  has this context). */
  workBundle?: string;
  /** task-aaa1bf931e32 — the GLOBAL server-hosted operator instructions, when the
   *  CALLER has already fetched them (the TypeBuild launcher fetches the doc in
   *  its parallel pre-spawn wave). When DEFINED (even the empty string), it is
   *  appended verbatim for browser runs and this launcher SKIPS its own
   *  fetchOperatorInstructions call — de-duplicating the round-trip AND the
   *  system-prompt addendum that otherwise happened once here and once in the
   *  caller's extraArgs. When UNDEFINED (the plain `claude` path), the launcher
   *  fetches the doc itself for a playwright run, exactly as before. NON-PHI. */
  operatorInstructions?: string;
  /** Host this session's terminal in the OPERATOR window even when the run
   *  style isn't `playwright` (QA 2026-07-12: every TypeBuild task launch is
   *  operator-hosted — one consistent surface; the left pane sits on the
   *  splash until/unless the agent actually opens a page there). The main
   *  window then never opens a task tab for this session (payload.operator
   *  suppresses it), so the confusing terminal-beside-copilot layout and the
   *  "operator opened later without my terminal" hole both disappear. */
  hostInOperator?: boolean;
};

export type InteractiveRunResult = {
  /** The recorded run row, or null when run recording was skipped. */
  run: TaskRun | null;
  ptyId: number;
  /** false when no window was available to host the tab (caller should fall
   *  back to a headless run). */
  launched: boolean;
  /** task-6fc9e503623e — the liveness verdict. Present only when the caller
   *  passed `awaitLiveness`. `alive:false` means the claude child spawned but
   *  EXITED within the grace window — the caller must treat this as a launch
   *  failure (release the claim + record the exitCode/tail), NOT a success.
   *  Absent (undefined) when liveness wasn't awaited (the legacy behavior). */
  liveness?: PtyLivenessVerdict;
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
  // task-3f0c6a6abe41 — ROOT CAUSE of "auto-continue claims but never spawns".
  // The manual ▶ fires from a user gesture, so getFocusedWindow() returns the
  // live main Breeze window. The auto-continue effect fires from a
  // refresh/timer tick right AFTER the previous step's session exited — at that
  // instant there is often NO focused window (focus was just lost with the
  // closing operator window), so we fell through to
  // `getAllWindows().find(w => !w.isDestroyed())`. That find can return a
  // window that is not-yet-`isDestroyed()` but whose `webContents` is already
  // gone/tearing down (the just-closed operator window). Binding the pty's
  // `senderId` to a dead webContents — or merely reading `win.webContents.id`
  // on it — throws BEFORE spawnManagedPty runs, so no claude process is ever
  // created; the claim is held but nothing launched. We now require a window
  // whose webContents is ALIVE (not destroyed, not crashed), preferring the
  // focused one, then any window that can actually host a tab.
  const hostable = (w: BrowserWindow | null | undefined): w is BrowserWindow => {
    if (!w || w.isDestroyed()) return false;
    try {
      const wc = w.webContents;
      return !!wc && !wc.isDestroyed() && !wc.isCrashed();
    } catch {
      return false;
    }
  };
  const focused = BrowserWindow.getFocusedWindow();
  const win =
    (hostable(opts.window) ? opts.window : null) ??
    (hostable(focused) ? focused : null) ??
    BrowserWindow.getAllWindows().find((w) => hostable(w)) ??
    null;
  if (!hostable(win)) {
    // No GUI window with a live webContents to host the tab — caller decides
    // whether to fall back to headless or surface the reason. We don't create
    // a run row in that case.
    console.warn(
      `[interactive] no hostable window for task ${task.id} — cannot spawn interactive session`,
    );
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

  const bin = agentId === 'pi'
    ? await (await import('./pi')).resolvePiBin()
    : await resolveClaudeBin();
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
  //
  // task-aaa1bf931e32 — DE-DUP: when the caller already fetched the doc (the
  // TypeBuild launcher does, in its parallel pre-spawn wave, and passes it via
  // opts.operatorInstructions), use that value verbatim and SKIP the fetch — the
  // doc was previously fetched here AND in the caller's extraArgs, a double
  // round-trip and a duplicated addendum. `opts.operatorInstructions === undefined`
  // (the plain `claude` path) falls back to fetching it ourselves for a browser run.
  let operatorInstructions = opts.operatorInstructions ?? '';
  if (opts.operatorInstructions === undefined && playwright) {
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
  //
  // Suppressed in two cases: `omitPrompt` (a --continue resume) and
  // `promptViaBundle` (the full task bundle is injected over stdin as the
  // agent's first turn instead — see injectWorkBundle; this is what stops the
  // pre-claimed agent from opening with a redundant get_task).
  const suppressPositional = opts.omitPrompt || opts.promptViaBundle;
  // Pi argv shape (task-c4846651004b v1): pi shares NONE of claude's flag
  // vocabulary — no --permission-mode/--continue (flagArgs), no
  // --append-system-prompt (the workspace CLAUDE.md playbook still loads:
  // pi reads CLAUDE.md context files natively from cwd; the server-hosted
  // operator-instructions addendum is a v1 degradation, folded in when the
  // first-party pi extension lands), no --add-dir (cwd-scoped), and the
  // positional prompt needs no `--` sentinel. Callers pass pi-native flags
  // (e.g. --no-session) via extraArgs.
  const args = agentId === 'pi'
    ? [
        ...(opts.extraArgs ?? []),
        ...(suppressPositional ? [] : [effectivePrompt]),
      ]
    : [
        ...flagArgs,
        ...(opts.extraArgs ?? []),
        // task-93576169693f — global operator instructions as a system-prompt
        // addendum (browser runs only; empty when unset/offline → omitted).
        ...(operatorInstructions ? ['--append-system-prompt', operatorInstructions] : []),
        '--add-dir', cwd,
        ...(suppressPositional ? [] : ['--', effectivePrompt]),
      ];

  const ptyId = reservePtyId();
  // task fix/launch-latency-debug — pty-scoped timing flow. Started here so
  // ipc.ts's onData can log the child's FIRST OUTPUT against the same epoch,
  // separating "main-process fetch hang" from "claude cold-start hang".
  const ptyFlow = `pty:${ptyId}`;
  startTiming(ptyFlow);
  timing(ptyFlow, 'spawnManagedPty call');
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
      // The SAME env the on-demand escalation verb echoes back (browserCliEnv,
      // task-63406211c0ee) so the start + escalate paths can't drift.
      ...(playwright ? browserCliEnv() : {}),
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
    // Operator-hosted sessions (playwright runs, and any caller passing
    // hostInOperator — every TypeBuild task launch) adopt the pty in the
    // operator window below, so suppress the main-window tab.
    ...(playwright || opts.hostInOperator ? { operator: true } : {}),
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
  //
  // task-207afa3fcec2 — the singleton window may already be hosting a
  // DIFFERENT live session (a task's operator window vs. an ad-hoc Ctrl+B
  // pair, or two overlapping tasks); openBrowserWindow now asks before
  // stealing it and returns false if the human declined. Operator-hosted
  // sessions have NO fallback tab (App.tsx's tasks:interactiveRun handler
  // returns early on payload.operator — see its comment), so a pty that
  // loses the takeover has no UI anywhere it could ever become reachable
  // from. Kill it immediately and report an unlaunched run rather than
  // leaving an invisible orphan `claude` process the user can't see or
  // stop: this lands the child's onExit before awaitLiveness even starts,
  // so liveness resolves dead and callers take the existing "died right
  // away" path (release claim, record why) instead of a new failure mode.
  if (playwright || opts.hostInOperator) {
    const hosted = await openBrowserWindow(undefined, ptyId, undefined, payload.title);
    if (!hosted) {
      console.warn(
        '[interactive] operator window takeover declined; killing pty',
        ptyId,
        '(no UI surface to run it in)',
      );
      try {
        killManagedPty(ptyId);
      } catch {
        /* already gone */
      }
      return { run, ptyId, launched: false };
    }
  }

  // task-6fc9e503623e — LIVENESS GATE. When the caller asked, wait for the
  // verdict: the child must stay alive (or emit first output) within the grace
  // window to count as started. An early exit here is the exact "got a pty id
  // but the child died instantly" bug — the caller (TypeBuild Start) inspects
  // `liveness.alive` and, when false, releases the claim and records the exit
  // code + tail instead of reporting a running session.
  if (opts.awaitLiveness) {
    timing(ptyFlow, 'awaitLiveness start');
    const liveness = await awaitPtyLiveness(ptyId, {
      minAliveMs: opts.awaitLiveness.minAliveMs,
    });
    timing(ptyFlow, `awaitLiveness result alive=${liveness.alive}`);
    if (liveness.alive) {
      // Fire-and-forget: injection now WAITS for TUI input-readiness (below)
      // and must not delay the launcher's return.
      void injectWorkBundle(ptyId, opts);
      timing(ptyFlow, `injectWorkBundle scheduled (len=${opts.workBundle?.length ?? 0})`);
    }
    return { run, ptyId, launched: true, liveness };
  }

  // No liveness gate requested — the caller (a non-TypeBuild `claude` launch)
  // still gets the bundle; injectWorkBundle's own input-readiness wait covers
  // the "TUI not up yet" window on this path too.
  if (opts.workBundle && !opts.omitPrompt) {
    void injectWorkBundle(ptyId, opts);
  }

  return { run, ptyId, launched: true };
}

// task-bd35fc4330c0 — write the pre-assembled task-work bundle into the pty's
// stdin as the agent's first message, right after we've confirmed the claude
// child is genuinely up (liveness alive / TUI ready for input). PHI-safe: the
// bundle text lives in process memory only and crosses straight into the
// pty's stdin fd (writeManagedPty → node-pty's proc.write) — never argv, never
// a file, never a --append-system-prompt string. Trailing `\r` submits it,
// same as a human pressing Enter in the embedded terminal.
//
// Skipped on a resume (`omitPrompt`): --continue resumes a conversation that
// already received this bundle on its original launch, so re-injecting would
// duplicate it into the transcript.
async function injectWorkBundle(ptyId: number, opts: InteractiveRunOptions): Promise<void> {
  if (!opts.workBundle || opts.omitPrompt) return;
  // WAIT FOR THE TUI TO BE READY FIRST (fix 2026-07-05, stuck-operator bug).
  // The liveness verdict resolves on the child's FIRST OUTPUT (~400-700ms in),
  // while claude is still booting — stdin written then is SWALLOWED, not
  // buffered: the bundle never reached the input box, and with promptViaBundle
  // suppressing the argv prompt the agent sat at an empty prompt forever.
  // awaitPtyInputReady resolves once the input prompt ('❯') has painted and the
  // welcome-banner output has gone quiet; its maxWait cap injects anyway as a
  // best-effort rather than never.
  const ready = await awaitPtyInputReady(ptyId, { quietMs: 600, maxWaitMs: 12_000 });
  timing(`pty:${ptyId}`, `injectWorkBundle write (inputReady=${ready})`);
  if (!ready) return; // pty died while we waited — nothing to inject into
  // Write the bundle body FIRST, then submit with a SEPARATE, slightly-delayed
  // Enter. Sending `${bundle}\r` in a single write lets the trailing \r be
  // absorbed into the multi-line block (it lands as a newline, not a submit), so
  // the text populates in the TUI but never sends — the user then has to press
  // Enter by hand (reported 2026-07-05). A standalone \r after the paste has
  // settled is processed as a real submit keypress, same as pressing Enter.
  writeManagedPty(ptyId, opts.workBundle);
  setTimeout(() => writeManagedPty(ptyId, '\r'), 400);
}
