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
//   typebuild blocked             → reopen
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
function isInProgress(task) {
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
      // In DONE. Reopen-from-done/partial/cancelled/failed is a kebab/detail
      // action now (PATCH {status:'open'}), not the row's primary — keep the
      // primary `none` so the row stays calm in the collapsed DONE section.
      return { kind: 'none' };
    }
    if (task.rawStatus === 'blocked') {
      return { kind: 'reopen' };
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
