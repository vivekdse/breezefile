// task-f730389afa8a — the operator session split-pane chrome.
//
// Rendered (instead of the full App) as the WHOLE webContents of the operator
// window — see electron/browser/window.ts (`#operator=<ptyId>`) and main.tsx.
// Replaces the old floating, draggable AgentOverlay.
//
// Layout: browser on the LEFT (resizable), Claude Code terminal on the RIGHT,
// divided by ONE resizer. The page is a main-process WebContentsView that
// floats ABOVE this React DOM (React can neither position nor clip it), so the
// LEFT pane is just a measured placeholder div whose viewport rect we stream to
// main (`operator:browser-bounds`); main mirrors the page view onto exactly
// that rect (stopping at the divider). The RIGHT pane renders the agent's PTY
// terminal (a mirror of the same pty shown in the main app tab).
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
import { SavePasswordPrompt, type CapturedCredential } from './SavePasswordPrompt';
import './OperatorSession.css';

// Origins the operator chose "Never for this site" — module-scoped so the
// opt-out survives a re-render (mirrors BrowserPane's neverSaveOrigins).
const operatorNeverSaveOrigins = new Set<string>();

// Persist an accepted captured credential to the site-keyed credential vault
// (task-d60860fb4d7f), the SAME path the in-app BrowserPane uses. Encrypted at
// rest server-side; never written to this machine. Single chokepoint so the
// prompt's "Save" has exactly one persist path.
async function saveCapturedCredential(cred: CapturedCredential): Promise<void> {
  await fm.typebuild.credentials.save({
    origin: cred.origin,
    username: cred.username,
    password: cred.password,
  });
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

export function OperatorSession({ ptyId }: { ptyId: number | null }) {
  const initial = useRef(readGeom());
  const [frac, setFrac] = useState(initial.current.frac);
  const [collapsed, setCollapsed] = useState(initial.current.collapsed);
  const [waiting, setWaiting] = useState(false);
  const [nav, setNav] = useState({
    url: '',
    canGoBack: false,
    canGoForward: false,
  });
  const [addr, setAddr] = useState('');
  const addrFocused = useRef(false);
  // Captured login awaiting the "Save password?" decision (task-890b0a7483c5).
  // The password lives ONLY in this trusted-UI state and is dropped on dismiss.
  const [pendingCred, setPendingCred] = useState<CapturedCredential | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
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
    fm.termMirrorWithReplay(ptyId);
    const off = fm.onTermFg((id, _busy, _comm, state) => {
      if (id === ptyId) setWaiting(state === 'waiting');
    });
    return () => {
      off();
      fm.termUnmirror(ptyId);
    };
  }, [ptyId]);

  // ─── stream the LEFT pane's on-screen rect to main (page-view bounds) ─────
  // The effective browser fraction: full width when the Claude pane is
  // collapsed, else `frac`. We re-report whenever it changes or the window
  // resizes; a ResizeObserver on the placeholder catches layout settling.
  const reportBounds = useCallback(() => {
    const el = leftRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    fm.operatorBrowserBounds({
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
      winW: window.innerWidth,
      winH: window.innerHeight,
    });
  }, []);

  useEffect(() => {
    // Initial sync of url/nav state (the page may have navigated already).
    fm.operatorSync();
    const off = fm.onOperatorBrowserState((s) => {
      if (!addrFocused.current) setAddr(s.url);
      setNav({ url: s.url, canGoBack: s.canGoBack, canGoForward: s.canGoForward });
    });
    return off;
  }, []);

  // Captured login submit → offer to save (task-890b0a7483c5). Mirrors the
  // in-app BrowserPane consumer: honor the per-origin "never" opt-out; the
  // password rides this event into trusted-UI state and nowhere else. The
  // operator window has a single page view, so there is no id to match. We
  // synthesize id:0 only to satisfy SavePasswordPrompt's shared cred shape.
  useEffect(() => {
    return fm.onOperatorCredentialCaptured((c) => {
      if (operatorNeverSaveOrigins.has(c.origin)) return;
      setPendingCred({ id: 0, ...c });
    });
  }, []);

  useEffect(() => {
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(reportBounds);
    };
    schedule();
    const ro = new ResizeObserver(schedule);
    if (leftRef.current) ro.observe(leftRef.current);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', schedule);
    };
    // Re-run when the split changes so the page view follows the divider.
  }, [frac, collapsed, reportBounds]);

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

  // Address-bar navigation.
  const go = () => {
    let target = addr.trim();
    if (!target) return;
    if (!/^[a-z]+:\/\//i.test(target)) target = 'https://' + target;
    fm.operatorNavigate(target);
  };

  // Grid: [ browser | resizer | claude ]. When collapsed the Claude column and
  // the resizer collapse to 0 so the browser fills the window.
  const cols = collapsed
    ? '1fr 0px 0px'
    : `${frac}fr ${RESIZER_W}px ${1 - frac}fr`;

  return (
    <div
      ref={rootRef}
      className={`operator${waiting ? ' operator--waiting' : ''}`}
      style={{ gridTemplateColumns: cols }}
    >
      {/* LEFT — browser pane (toolbar + measured page-view placeholder) */}
      <div className="operator__browser">
        <div className="operator__bar">
          <button
            className="operator__btn"
            disabled={!nav.canGoBack}
            onClick={() => fm.operatorBack()}
            title="Back"
          >
            ‹
          </button>
          <button
            className="operator__btn"
            disabled={!nav.canGoForward}
            onClick={() => fm.operatorForward()}
            title="Forward"
          >
            ›
          </button>
          <button
            className="operator__btn"
            onClick={() => fm.operatorReload()}
            title="Reload"
          >
            ⟳
          </button>
          <input
            className="operator__addr"
            value={addr}
            spellCheck={false}
            onFocus={(e) => {
              addrFocused.current = true;
              e.currentTarget.select();
            }}
            onBlur={() => {
              addrFocused.current = false;
            }}
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                go();
                e.currentTarget.blur();
              }
            }}
          />
          {collapsed && (
            <button
              className="operator__btn operator__btn--show"
              onClick={toggleCollapsed}
              title="Show Claude (⅓)"
            >
              ✦ Claude
            </button>
          )}
          {/* task-6b9b0032feda — when the Claude pane is collapsed the ✕ in its
              chrome is hidden, so surface a persistent close affordance here.
              Same teardown path (PTY + window) as the Claude-pane close. */}
          {collapsed && (
            <button
              className="operator__btn operator__btn--close"
              title="Close session (ends browser + Claude)"
              aria-label="Close session"
              onClick={() => void onClose()}
            >
              ✕
            </button>
          )}
        </div>
        {/* "Save password?" prompt (task-890b0a7483c5). Anchored in the toolbar
            region (above the native page view, which floats over the React DOM),
            exactly like the in-app BrowserPane — an overlay painted "on the page"
            would be hidden behind the WebContentsView. */}
        {pendingCred && (
          <SavePasswordPrompt
            cred={pendingCred}
            onSave={async (c) => {
              await saveCapturedCredential(c);
              setPendingCred(null);
            }}
            onDismiss={() => setPendingCred(null)}
            onNever={(origin) => {
              operatorNeverSaveOrigins.add(origin);
              setPendingCred(null);
            }}
          />
        )}
        {/* Native page view is mirrored onto this rect by main. */}
        <div ref={leftRef} className="operator__view" />
      </div>

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
