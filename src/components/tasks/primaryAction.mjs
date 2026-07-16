// fm-7909 — PURE primary-action state machine. One button per row; this is
// the single source of truth for which one. Authored as plain ESM (+ a
// co-located primaryAction.d.ts) so `node --test tests/` imports it directly.
//
// No React / IPC / DOM. Inputs are a Task + a small context object; output is
// a discriminated descriptor the row/detail render verbatim.
//
// Decision table (mirrors the plan, Phase C2):
//   local manual, open            → done-toggle (✓)
//   local manual, done/cancelled  → reopen (↺)
//   local auto, run in flight     → open-session (if we hold a session tab)
//                                    else view-run
//   local auto, idle              → run-now (▸)
//   typebuild, session running    → open-session  (focus the tab)
//   typebuild in_progress, no local session → none  (running elsewhere; stop
//                                    it first — Start would 409)
//   typebuild done/partial/cancelled → none  (lives in DONE; Reopen is a
//                                    kebab/detail action via PATCH {open})
//   typebuild blocked             → retry (composite reopen→claim→launch)
//   typebuild claimed by ME       → start ("you hold the claim")
//   typebuild claimed by OTHER    → none + "◆ claimed by {email}"
//   typebuild open/failed, free   → start (enabled gates on tbReady; the
//                                    disabled tooltip = startBlockedReason)

/** @typedef {import('../../types').Task} Task */

function isLocalSource(source) {
  return !source || source === 'local';
}

function isTerminal(task) {
  if (task.status === 'done' || task.status === 'cancelled') return true;
  const raw = task.rawStatus;
  // fm-alfz (S1) — cancelled is a real server terminal status now.
  return raw === 'done' || raw === 'partial' || raw === 'cancelled';
}

// task-269637c6a076 — a task is "effectively in_progress" when the server (or
// the normalized status) says a session is running. We key off this, NOT just
// claimedBy: a claim can be held while idle (legit Resume), but an in_progress
// row means a session is live somewhere — possibly on another machine — and we
// must not dangle a second/competing Start.
// Exported (task-c141c7765aa4) — the pipeline roster's step chip reuses this
// EXACT predicate to decide "is this step's child actually running right
// now", so a claimed/in_progress step reads as RUNNING promptly instead of
// waiting on output values to land (taskDefStatus alone has no notion of
// claim/in_progress — see pipelineRoster.mjs's stepDisplayStatus).
export function isInProgress(task) {
  return task.rawStatus === 'in_progress' || task.status === 'in_progress';
}

// Ported from the old TaskRow (lines 1652-1658): why Start is disabled.
// Returns null when Start is enabled.
function startBlockedReason(tbReady) {
  if (!tbReady) return 'Sign in to TypeBuild first (Settings → TypeBuild)';
  if (!tbReady.signedIn)
    return 'Sign in to TypeBuild first (Settings → TypeBuild)';
  if (!tbReady.claudeOk)
    return 'Install Claude Code first (Settings → TypeBuild onboarding)';
  if (!tbReady.chromeOk)
    return 'Install Google Chrome first (Settings → TypeBuild onboarding)';
  return null;
}

/**
 * @param {Task} task
 * @param {{
 *   caps?: { canEdit?: boolean, canClaim?: boolean, canDelete?: boolean } | undefined,
 *   tbReady?: { signedIn: boolean, claudeOk: boolean, chromeOk: boolean, ready: boolean } | undefined,
 *   myEmail?: string|null,
 *   session?: { ptyId: number, tabIndex: number } | undefined,
 *   lastRunRunning?: boolean,
 *   hasOpenChildren?: boolean,
 * }} ctx
 */
export function primaryActionFor(task, ctx) {
  const caps = (ctx && ctx.caps) || undefined;
  const session = (ctx && ctx.session) || undefined;
  const myEmail = (ctx && ctx.myEmail) || null;
  const isTypebuild = task.source === 'typebuild';
  const isAuto = isLocalSource(task.source) && !!task.auto_mode;
  const isManual = isLocalSource(task.source) && !task.auto_mode;

  // A live session tab beats everything — focus it instead of re-launching.
  if (session) {
    return { kind: 'open-session', tabIndex: session.tabIndex };
  }

  // ── local manual ──────────────────────────────────────────────────────
  if (isManual) {
    if (isTerminal(task)) return { kind: 'reopen' };
    return { kind: 'done-toggle', done: false };
  }

  // ── local auto-mode ───────────────────────────────────────────────────
  if (isAuto) {
    if (isTerminal(task)) return { kind: 'reopen' };
    if (ctx && ctx.lastRunRunning) {
      // No session tab (handled above) but a run is in flight → let the user
      // jump to its history.
      return { kind: 'view-run' };
    }
    return { kind: 'run-now' };
  }

  // ── TypeBuild ─────────────────────────────────────────────────────────
  if (isTypebuild) {
    if (isTerminal(task)) {
      // task-reenter — LAUNCH-FIRST re-entry. A done/partial/cancelled task
      // KEEPS its play button so the human can re-open the operator at ANY
      // time — to see what happened, ask what was done, or have the agent edit
      // the result. runNow is launch-first: claiming a terminal task fails for
      // state reasons, so it launches the operator UNCLAIMED and hands the
      // agent the reason to resolve. The task's terminal status is NOT
      // disturbed unless the agent reopens it. `reentry` lets the button label
      // read "Open operator" instead of "Start". Reopen (PATCH {status:'open'})
      // remains a separate kebab/detail action for actually re-activating it.
      const reason = startBlockedReason(ctx && ctx.tbReady);
      return {
        kind: 'start',
        reentry: true,
        enabled: reason === null,
        tooltip:
          reason ?? 'Open the operator — inspect, ask, or edit the result',
      };
    }
    // task-457dd1cc6c8b — a blocked TypeBuild task can't be relaunched by a
    // plain reopen: the server needs reopen → claim → launch in sequence, and
    // a bare "Reopen" button (the old behavior) left the row still not
    // runnable. Return a composite 'retry' action so the never-silent
    // wrapper (useStartAction) knows to run the full chain instead of a
    // single reopen call. `reason` is a human sentence (never the raw
    // 'not_claimable' token) surfaced as the button's tooltip/status line.
    if (task.rawStatus === 'blocked') {
      const attempts = typeof task.attempts === 'number' ? task.attempts : null;
      const maxAttempts = typeof task.maxAttempts === 'number' ? task.maxAttempts : null;
      const reason =
        attempts !== null && maxAttempts !== null && maxAttempts > 0
          ? `Blocked after ${attempts}/${maxAttempts} attempts — Retry will reopen and relaunch`
          : 'Blocked — Retry will reopen and relaunch';
      return { kind: 'retry', reason };
    }
    // fm-bq86 (S3) — a parent/container with non-terminal children can't be
    // started: the server won't hand out the container until its children
    // resolve (readiness rule). Surface a calm note rather than a dead Start.
    if (ctx && ctx.hasOpenChildren) {
      return { kind: 'none', note: 'children first' };
    }
    const claimedBy = task.claimedBy ?? null;
    if (claimedBy && claimedBy !== myEmail) {
      // Someone else holds it — no action, the row shows "◆ claimed by X".
      return { kind: 'none', note: `claimed by ${claimedBy}` };
    }
    // task-269637c6a076 — the task is in_progress but there is NO focusable
    // local session (a live `session` would have returned `open-session` at the
    // top). A session is running somewhere else (another machine, or the claim
    // is held while a session runs out-of-process). Do NOT offer Start: the
    // server would reject it 409 `in_progress_elsewhere`. Surface a calm note
    // that mirrors that 409 wording (src/errorMessages.ts) and tells the user
    // to stop the running session before starting again.
    if (isInProgress(task)) {
      return {
        kind: 'none',
        note: 'in progress — stop the running session to start again',
      };
    }
    // Free, or claimed-but-idle by me → Start (Start auto-claims; in-session
    // claim is a no-op when we already hold it). A held claim with an idle
    // (open/failed) status is a legit Resume.
    const reason = startBlockedReason(ctx && ctx.tbReady);
    return {
      kind: 'start',
      enabled: reason === null,
      tooltip:
        reason ??
        (claimedBy === myEmail
          ? 'Resume — you hold the claim'
          : 'Start a Claude session (claims the task for you)'),
    };
  }

  // Unknown source / shape: be safe, offer nothing actionable.
  return { kind: 'none' };
}

// ─── task-710003dbc2c6 (U3) — full action list ─────────────────────────────
// actionsFor() is the ONE action model behind every surface (roster row,
// detail dialog/panel, and — later — copilot): it returns an ORDERED list of
// every action applicable to `task` right now, each carrying enabled/reason
// so a disabled control always has a tooltip instead of just vanishing.
// primaryActionFor() remains the single "what's the ONE button" decision
// (used by the icon-only row slot); actionsFor() is the superset a kebab
// menu / detail footer renders from — no per-surface hardcoding of which
// verbs exist.
//
// STOP is the one action with no prior existence anywhere in the UI: it
// kills the task's live session (a managed pty, via window.fm.termKill) and
// releases the TypeBuild claim so the task frees up instead of staying
// claimed-but-dead. actionsFor() decides ELIGIBILITY only (pure, no IPC) —
// the actual kill+release call lives in useTaskActions().stop.

/**
 * @typedef {{
 *   id: 'start'|'stop'|'retry'|'cancel'|'reopen'|'answer'|'open-session'|'view-run'|'done-toggle',
 *   label: string,
 *   enabled: boolean,
 *   reason?: string,
 * }} TaskAction
 */

/**
 * @param {Task} task
 * @param {{
 *   caps?: { canEdit?: boolean, canClaim?: boolean, canDelete?: boolean } | undefined,
 *   tbReady?: { signedIn: boolean, claudeOk: boolean, chromeOk: boolean, ready: boolean } | undefined,
 *   myEmail?: string|null,
 *   session?: { ptyId: number, tabIndex: number } | undefined,
 *   lastRunRunning?: boolean,
 *   hasOpenChildren?: boolean,
 * }} ctx
 * @returns {TaskAction[]}
 */
export function actionsFor(task, ctx) {
  const out = [];
  const isTypebuild = task.source === 'typebuild';
  const session = (ctx && ctx.session) || undefined;
  const myEmail = (ctx && ctx.myEmail) || null;
  const claimedBy = task.claimedBy ?? null;
  const iAmClaimer = !claimedBy || claimedBy === myEmail;

  // ── ANSWER — a pending-question row always gets this first; it's not part
  // of primaryActionFor's table (that lives in the roster's own status
  // branch — see RowAction's 'needs' case), so actionsFor surfaces it
  // directly off task.status.
  if (task.status === 'needs') {
    out.push({ id: 'answer', label: 'Answer', enabled: true });
  }

  // ── STOP — offered whenever a session is plausibly live for this task: a
  // focusable local session tab, OR the server says in_progress (a session
  // may be running elsewhere/out-of-process — Stop still attempts the local
  // kill-if-any + release, and the release alone frees a claim stuck on a
  // dead remote session). Never offered for a local (non-TypeBuild) task —
  // there's no claim to free and no managed session-registry entry to kill
  // outside the pty-per-tab the row already offers via open-session.
  if (isTypebuild && (session || isInProgress(task))) {
    out.push({
      id: 'stop',
      label: 'Stop',
      enabled: true,
      reason: session
        ? 'End this session and free the claim'
        : 'Free the claim — no local session to kill, but this releases it server-side',
    });
  }

  // ── the primary (single) action, folded into the ordered list under its
  // own id so a surface that wants "everything" doesn't also need a second
  // call to primaryActionFor.
  const primary = primaryActionFor(task, ctx);
  switch (primary.kind) {
    case 'open-session':
      out.push({ id: 'open-session', label: 'Open session', enabled: true });
      break;
    case 'view-run':
      out.push({ id: 'view-run', label: 'View run', enabled: true });
      break;
    case 'done-toggle':
      out.push({ id: 'done-toggle', label: 'Mark done', enabled: true });
      break;
    case 'reopen':
      out.push({ id: 'reopen', label: 'Reopen', enabled: true });
      break;
    case 'retry':
      out.push({ id: 'retry', label: 'Retry', enabled: true, reason: primary.reason });
      break;
    case 'run-now':
      out.push({ id: 'start', label: 'Run now', enabled: true });
      break;
    case 'start':
      out.push({
        id: 'start',
        label: primary.reentry ? 'Open operator' : 'Start',
        enabled: primary.enabled,
        reason: primary.tooltip,
      });
      break;
    case 'none':
      // Nothing primary to add beyond STOP/ANSWER above — 'none' with a note
      // (claimed by someone else / children first / in-progress-elsewhere)
      // is already covered by primaryActionFor's tooltip text; a disabled
      // ghost 'start' with that reason keeps the row visually consistent
      // (a control to hover, not a silent gap) EXCEPT when Stop already
      // explains the row (in-progress-elsewhere — Stop's own reason covers
      // it, a second disabled Start would just repeat the same sentence).
      if (primary.note && !(isTypebuild && isInProgress(task))) {
        out.push({ id: 'start', label: 'Start', enabled: false, reason: primary.note });
      }
      break;
  }

  // ── CANCEL — any non-terminal TypeBuild task the caller isn't locked out
  // of (someone else's claim is a hard stop, same rule Start uses).
  if (isTypebuild && !isTerminal(task) && iAmClaimer) {
    out.push({ id: 'cancel', label: 'Cancel', enabled: true, reason: 'Withdraw this task' });
  }

  return out;
}
