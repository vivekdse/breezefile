// task-f730389afa8a — the operator session split-pane chrome.
//
// Rendered (instead of the full App) as the WHOLE webContents of the operator
// window — see electron/browser/window.ts (`#operator=<ptyId>&view=<id>`) and
// main.tsx. Replaces the old floating, draggable AgentOverlay.
//
// Layout: browser on the LEFT (resizable), Claude Code terminal on the RIGHT,
// divided by ONE resizer. The browser pane is the SHARED BrowserSurface (the
// same component the in-app tab uses) bound to a pre-created view id — so it has
// full parity (Record + saved-login autofill + "Save password?" capture) and
// streams its own bounds over `browser:*`. The page is a main-process
// WebContentsView that floats ABOVE this React DOM; BrowserSurface measures its
// placeholder and main mirrors the page onto exactly that rect (stopping at the
// divider, since the operator view is created with fill:'rect'). The RIGHT pane
// renders the agent's PTY terminal.
//
// A minimize button toggles the RIGHT (Claude) pane between 1/3 and 0 width;
// default is 1/3. The divider fraction + collapsed state persist to
// localStorage so the operator's chosen split survives across sessions.
//
// task-c4064f8a4994 — the single CLOSE button lives here: it tears down the PTY
// AND the window together, routing through the existing onSessionExit / release
// / keep-alive path (the PTY exit triggers it). See onClose().
import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from './Terminal';
import { fm } from '../bridge';
import { useTheme } from '../theme';
import { BrowserSurface } from './BrowserSurface';
import { TypebuildSessionBanner } from './TypebuildSessionBanner';
import './OperatorSession.css';

// task-63fd78520f53 — map a thrown TypeBuild MCP-token mint failure to the
// three exact in-app messages, for the operator-window relaunch path. This is
// the operator-window copy of App.tsx's relaunchErrorMessage (which is local
// to App and not exported); the message text is intentionally identical so the
// user sees the same wording in the operator window as in the main window.
const RELAUNCH_MINT_MESSAGES: Record<string, string> = {
  'signed-out': 'Please sign in again',
  unreachable: "Can't reach TypeBuild right now",
  'access-denied': 'Your access has changed, contact your admin',
};
function relaunchErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /\[typebuild-mint:([a-z-]+)\]/.exec(raw);
  if (m && RELAUNCH_MINT_MESSAGES[m[1]]) return RELAUNCH_MINT_MESSAGES[m[1]];
  return "Couldn't restart the session — try again";
}

// Persisted geometry. `frac` is the LEFT (browser) pane's fraction of the
// window width when the Claude pane is OPEN; `collapsed` hides the Claude pane.
const GEOM_KEY = 'breeze.operatorGeom';
// Default: Claude pane = 1/3 → browser = 2/3.
const DEFAULT_FRAC = 2 / 3;
// Clamp the browser fraction so neither pane can be dragged to nothing.
const MIN_FRAC = 0.2;
const MAX_FRAC = 0.85;
const RESIZER_W = 6; // px, must match .operator__resizer width in the CSS

type Geom = { frac: number; collapsed: boolean };

const clampFrac = (f: number) => Math.max(MIN_FRAC, Math.min(MAX_FRAC, f));

function readGeom(): Geom {
  try {
    const raw = localStorage.getItem(GEOM_KEY);
    if (raw) {
      const g = JSON.parse(raw) as Partial<Geom>;
      return {
        frac: typeof g.frac === 'number' ? clampFrac(g.frac) : DEFAULT_FRAC,
        collapsed: g.collapsed === true,
      };
    }
  } catch {
    /* unparseable / unavailable — fall back to default */
  }
  return { frac: DEFAULT_FRAC, collapsed: false };
}

function writeGeom(g: Geom): void {
  try {
    localStorage.setItem(GEOM_KEY, JSON.stringify(g));
  } catch {
    /* unavailable — geometry still applies for this session */
  }
}

export function OperatorSession({
  ptyId,
  viewId,
  launching = false,
}: {
  ptyId: number | null;
  viewId: number | null;
  // task-7ba4409eeb5c — true while the session is still starting (window opened
  // optimistically, pty not yet spawned). Drives the "Starting session…" pane
  // so a healthy launch doesn't read as "No agent session."
  launching?: boolean;
}) {
  const initial = useRef(readGeom());
  // The user's chosen UI theme. We report it to main so the "task starting"
  // splash in the page view matches the client (task-3a49fb5adf24); main only
  // re-themes the splash while it's still showing. `theme` updates live if the
  // user restyles, so a theme change before the agent navigates re-themes the
  // splash too.
  const [theme] = useTheme();
  const [frac, setFrac] = useState(initial.current.frac);
  const [collapsed, setCollapsed] = useState(initial.current.collapsed);
  const [waiting, setWaiting] = useState(false);

  // task-63fd78520f53 — TypeBuild MCP session-expiry banner, ported from the
  // main window (App.tsx). Operator sessions no longer open a main-window tab
  // (the operator terminal ADOPTS the pty directly), so the expiry strip that
  // App rendered over that tab never showed here. Subscribe to the same
  // fm.onTypebuildSessionExpiry feed, keyed to THIS session's ptyId, and render
  // the identical banner over the Claude terminal pane so the operator sees the
  // warning / one-click relaunch. The expiry-clock auto-relaunch and the global
  // "Release this task?" confirm still live in main — untouched here.
  //
  // PHI-free: state holds only the opaque taskId + phase (ptyId-keyed).
  const [expiry, setExpiry] = useState<{
    phase: 'warning' | 'expired';
    taskId: string;
  } | null>(null);
  const [expiryDismissed, setExpiryDismissed] = useState(false);
  const [relaunch, setRelaunch] = useState<{ error: string | null } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const fracRef = useRef(frac);
  fracRef.current = frac;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  // ─── mirror the agent's PTY terminal into the right pane ─────────────────
  // task-6b9b0032feda — subscribe WITH REPLAY: if this window's Claude pane
  // mounts after the PTY already emitted output (the common case — the PTY is
  // spawned by the main window before the operator window opens), main flushes
  // the recent scrollback to us on subscribe so the terminal repaints
  // immediately instead of showing nothing until the next chunk. The replay is
  // delivered as a normal term:data event the child Terminal renders; its mount
  // effect (and onTermData subscription) runs before this parent effect, so the
  // flush is never missed.
  useEffect(() => {
    if (ptyId == null) return;
    // ADOPT (not mirror): make this window the pty's OWNER so the terminal here
    // is the single, direct surface for the session. Previously this mirrored a
    // redundant main-window owner tab, leaving two xterms fighting over one
    // pty's size. The main window no longer opens a tab for operator sessions
    // (src/App.tsx). Replays recent scrollback so output emitted before this
    // pane mounted repaints immediately.
    fm.termAdopt(ptyId);
    const off = fm.onTermFg((id, _busy, _comm, state) => {
      if (id === ptyId) setWaiting(state === 'waiting');
    });
    return () => {
      off();
    };
  }, [ptyId]);

  // ─── TypeBuild MCP session-expiry banner (task-63fd78520f53) ─────────────
  // Track expiry phases for THIS session's ptyId only. Main's expiry clock
  // broadcasts 'warning' (T-15min) then 'expired' (at/after token lapse) per
  // live session, keyed by ptyId. A fresh 'expired' supersedes a dismissed
  // 'warning' (it's actionable). Clear when this pty exits / relaunches so a
  // stale banner never lingers.
  useEffect(() => {
    if (ptyId == null) return;
    const off = fm.onTypebuildSessionExpiry(({ ptyId: id, taskId, phase }) => {
      if (id !== ptyId) return;
      setExpiry({ phase, taskId });
      if (phase === 'expired') setExpiryDismissed(false);
    });
    return off;
  }, [ptyId]);

  useEffect(() => {
    if (ptyId == null) return;
    const off = fm.onTermExit((id) => {
      if (id !== ptyId) return;
      setExpiry(null);
      setExpiryDismissed(false);
      setRelaunch(null);
    });
    return off;
  }, [ptyId]);

  // After a successful relaunch main repoints the session onto a fresh pty.
  // The operator window is bound to a fixed ptyId for its lifetime, so the
  // surviving signal here is the OLD pty's exit (handled above, which clears
  // expiry state); we also clear directly on the relaunched event for the old
  // pty in case the orderings differ.
  useEffect(() => {
    if (ptyId == null) return;
    const off = fm.onTypebuildSessionRelaunched(({ oldPtyId }) => {
      if (oldPtyId !== ptyId) return;
      setExpiry(null);
      setExpiryDismissed(false);
      setRelaunch(null);
    });
    return off;
  }, [ptyId]);

  // One-click relaunch: kill the expired pty, mint fresh, resume. A typed mint
  // failure maps to the same in-app message as the main window and is shown
  // inline so the operator can retry.
  const doRelaunch = useCallback(
    async (taskId: string) => {
      if (ptyId == null) return;
      setRelaunch({ error: null });
      try {
        await fm.typebuildRelaunchSession({ ptyId, taskId });
        // Success clears via the term-exit / relaunched effects above.
      } catch (err) {
        setRelaunch({ error: relaunchErrorMessage(err) });
      }
    },
    [ptyId],
  );

  // Tell main which theme the splash should use (and re-tell on restyle).
  useEffect(() => {
    fm.operatorSetTheme(theme);
  }, [theme]);

  // ─── the single resizer drives BOTH panes ────────────────────────────────
  const dragging = useRef(false);
  const onResizerDown = (e: React.PointerEvent) => {
    // Dragging the divider implicitly re-opens a collapsed Claude pane.
    if (collapsedRef.current) setCollapsed(false);
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0) return;
    const f = clampFrac((e.clientX - rect.left) / rect.width);
    setFrac(f);
  };
  const onResizerUp = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    writeGeom({ frac: fracRef.current, collapsed: collapsedRef.current });
  };

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeGeom({ frac: fracRef.current, collapsed: next });
  };

  // ─── the single CLOSE action (task-c4064f8a4994) ─────────────────────────
  // Kill the PTY first (its exit routes through onSessionExit → keep-alive
  // disarm + the "release this task?" prompt on the MAIN window), THEN close
  // the operator window. Both halves go down as one user action. Guarded so a
  // failed kill still closes the window (no stranded session UI).
  const onClose = useCallback(async () => {
    if (ptyId != null) {
      try {
        await fm.termKill(ptyId);
      } catch {
        /* already gone — fall through and close the window anyway */
      }
    }
    fm.operatorClose();
  }, [ptyId]);

  // Grid: [ browser | resizer | claude ]. When collapsed the Claude column and
  // the resizer collapse to 0 so the browser fills the window.
  const cols = collapsed
    ? '1fr 0px 0px'
    : `${frac}fr ${RESIZER_W}px ${1 - frac}fr`;

  // When the Claude pane is collapsed its chrome (incl. ✕) is hidden, so surface
  // Show + Close affordances IN the browser toolbar (in-flow — a floating
  // overlay would be hidden behind the native page view). task-6b9b0032feda
  const collapsedControls = collapsed ? (
    <>
      <button
        className="operator__btn operator__btn--show"
        onClick={toggleCollapsed}
        title="Show Claude (⅓)"
      >
        ✦ Claude
      </button>
      <button
        className="operator__btn operator__btn--close"
        title="Close session (ends browser + Claude)"
        aria-label="Close session"
        onClick={() => void onClose()}
      >
        ✕
      </button>
    </>
  ) : null;

  return (
    <div
      ref={rootRef}
      className={`operator${waiting ? ' operator--waiting' : ''}`}
      style={{ gridTemplateColumns: cols }}
    >
      {/* LEFT — the shared browser surface bound to the pre-created view id. It
          owns its toolbar, bounds streaming, credential capture/fill + record. */}
      <BrowserSurface viewId={viewId ?? undefined} toolbarExtra={collapsedControls} />

      {/* RESIZER — one divider driving both panes */}
      <div
        className="operator__resizer"
        title="Drag to resize"
        onPointerDown={onResizerDown}
        onPointerMove={onResizerMove}
        onPointerUp={onResizerUp}
        style={{ display: collapsed ? 'none' : undefined }}
      />

      {/* RIGHT — Claude Code terminal pane */}
      <div
        className="operator__claude"
        style={{ display: collapsed ? 'none' : undefined }}
      >
        <div className="operator__claude-bar">
          <span className="operator__title">Claude</span>
          {waiting && <span className="operator__badge">needs you</span>}
          <span className="operator__spacer" />
          <button
            className="operator__btn"
            title="Minimize Claude pane"
            onClick={toggleCollapsed}
          >
            —
          </button>
          <button
            className="operator__btn operator__btn--close"
            title="Close session (ends browser + Claude)"
            onClick={() => void onClose()}
          >
            ✕
          </button>
        </div>
        <div className="operator__term">
          {/* task-63fd78520f53 — expiry strip pinned over the terminal pane
              (matches App.tsx). 'warning' is dismissible; 'expired' offers a
              one-click relaunch. The operator never sees the raw MCP error
              underneath — this strip sits over it. PHI-free. */}
          {expiry &&
            !(expiry.phase === 'warning' && expiryDismissed) && (
              <TypebuildSessionBanner
                phase={expiry.phase}
                busy={!!relaunch && !relaunch.error}
                error={relaunch?.error ?? null}
                onRestart={() => void doRelaunch(expiry.taskId)}
                onDismiss={() => setExpiryDismissed(true)}
              />
            )}
          {ptyId != null ? (
            <Terminal ptyId={ptyId} cwd="" isActive />
          ) : launching ? (
            // task-7ba4409eeb5c — the window opened optimistically (task-
            // 1b3eeb1aae1f); the pty is still spawning. Show a live "starting"
            // state for the whole wait so a healthy launch never reads as a
            // failed / empty session.
            <div className="operator__starting" role="status" aria-live="polite">
              <span className="operator__starting-spinner" aria-hidden="true" />
              <span className="operator__starting-label">Starting session…</span>
              <span className="operator__starting-sub">
                Connecting to the agent — this can take a moment.
              </span>
            </div>
          ) : (
            <div className="operator__no-pty">No agent session.</div>
          )}
        </div>
      </div>
    </div>
  );
}
