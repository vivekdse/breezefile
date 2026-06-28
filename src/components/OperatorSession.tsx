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
import './OperatorSession.css';

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
}: {
  ptyId: number | null;
  viewId: number | null;
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
          {ptyId != null ? (
            <Terminal ptyId={ptyId} cwd="" isActive />
          ) : (
            <div className="operator__no-pty">No agent session.</div>
          )}
        </div>
      </div>
    </div>
  );
}
