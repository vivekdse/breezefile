import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fm } from '../bridge';
import { SavePasswordPrompt, type CapturedCredential } from './SavePasswordPrompt';

// The ONE embedded-browser surface (browser/operator unification). Drives a
// main-process WebContentsView (created by electron/browser/views.ts) over the
// shared `browser:*` IPC, keyed by a numeric view id. Used in two modes:
//
//  - **Tab mode** (`tabId`): the in-app browser tab. We ATTACH our own view on
//    mount (or reuse the persistent one for this tab), HIDE on unmount, and let
//    App reap it when the tab closes. See viewByTab / reapBrowserViews.
//  - **Operator mode** (`viewId`): the operator session's left pane. The view
//    is pre-created in MAIN (electron/browser/window.ts, eagerly, so the agent's
//    CDP target exists before this mounts); we just bind to that id and stream
//    bounds. We do NOT attach/hide/destroy — the operator window owns its view.
//
// The web page floats ABOVE this React DOM (React can neither position nor clip
// it), so we render a normal toolbar (real DOM) + an empty placeholder, measure
// the placeholder, and stream its viewport rect to main (`browser:bounds`),
// which mirrors the view onto exactly that rect below the toolbar.
const viewByTab = new Map<string, number>();

// Origins the user said "never save here" for, this session. Module-level so the
// opt-out survives remounts (tab switches). NON-secret (origins only).
const neverSaveOrigins = new Set<string>();

/** Destroy the native views of tabs that are no longer open. Called by App
 *  whenever the tab set changes, so a closed browser tab releases its view. */
export function reapBrowserViews(liveTabIds: Set<string>): void {
  for (const [tabId, id] of viewByTab) {
    if (!liveTabIds.has(tabId)) {
      void fm.browserDestroy(id);
      viewByTab.delete(tabId);
    }
  }
}

// Persist an accepted captured credential to the site-keyed credential vault
// (task-d60860fb4d7f). Single chokepoint so the prompt's "Save" has exactly one
// persist path.
async function saveCapturedCredential(cred: CapturedCredential): Promise<void> {
  await fm.typebuild.credentials.save({
    origin: cred.origin,
    username: cred.username,
    password: cred.password,
  });
}

export function BrowserSurface({
  tabId,
  url,
  viewId,
  toolbarExtra,
}: {
  tabId?: string;
  url?: string;
  viewId?: number;
  // Extra controls appended to the toolbar, in-flow (a floating overlay would be
  // hidden behind the native page view). The operator session passes its
  // collapsed-state Show/Close buttons here.
  toolbarExtra?: ReactNode;
}) {
  // Operator mode binds to a pre-created view; tab mode attaches its own.
  const operatorMode = viewId != null;
  const viewRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<number | null>(null);
  const [addr, setAddr] = useState(url ?? '');
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false });
  const [recording, setRecording] = useState(false);
  const addrFocused = useRef(false);

  // The pending "Save password?" capture for THIS view (task-ad89064bf45f).
  // Holds the captured password in trusted-UI state ONLY; cleared on save/dismiss
  // and on unmount. Never logged or persisted until the user accepts.
  const [pendingCred, setPendingCred] = useState<CapturedCredential | null>(null);

  // A saved login available for the CURRENT origin (task-4b786c018d78). Holds NO
  // password (origin+username+count only); the password is resolved + injected
  // in main on fill and never reaches here. Set SILENTLY on navigation when the
  // vault has a match — it drives the toolbar key button, NOT a pop-out. The
  // user triggers the fill explicitly via the 🔑 key button (matches the
  // operator session, which never auto-offers).
  const [savedLogin, setSavedLogin] = useState<{
    origin: string;
    username: string;
    count: number;
  } | null>(null);
  // Whether the manual fill-confirm dialog is open (opened by the key button).
  const [fillDialogOpen, setFillDialogOpen] = useState(false);
  const [autofilling, setAutofilling] = useState(false);
  // The origin we last queried the vault for, so a re-render or in-page nav
  // doesn't re-query the same origin. (Per mount.)
  const checkedOrigin = useRef<string>('');

  // View lifecycle + state/credential listeners. Keyed on tabId (tab mode) or
  // viewId (operator mode) — whichever identifies the bound view.
  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    let rafId = 0;

    const report = () => {
      const el = viewRef.current;
      const id = idRef.current;
      if (!el || id == null) return;
      const r = el.getBoundingClientRect();
      // Mid-layout (HMR, grid collapse) can briefly measure ~0 — don't pin the
      // view to a tiny rect; retry next frame until the slot has real size.
      if (r.width < 2 || r.height < 2) {
        schedule();
        return;
      }
      // Send CSS-pixel corner + the renderer's CSS window size. Main scales
      // these into device-independent pixels (the unit setBounds expects) —
      // critical on HiDPI / fractionally-scaled displays where CSS px ≠ DIP.
      fm.browserBounds(id, {
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
        winW: window.innerWidth,
        winH: window.innerHeight,
      });
    };
    const schedule = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(report);
    };

    const offState = fm.onBrowserState((s) => {
      if (s.id !== idRef.current) return;
      if (!addrFocused.current) setAddr(s.url);
      setNav({ canGoBack: s.canGoBack, canGoForward: s.canGoForward });
      // Return-visit autofill: SILENTLY note whether this origin has a saved
      // login so the toolbar key button can appear (task-4b786c018d78). We do
      // NOT pop a dialog — the user fills explicitly via that button. Origins
      // only — the password is never fetched here.
      let origin = '';
      try {
        origin = new URL(s.url).origin;
      } catch {
        /* non-http(s) url — no saved-login lookup */
      }
      if (!origin || origin === 'null') {
        setSavedLogin(null);
        return;
      }
      if (origin === checkedOrigin.current) return;
      checkedOrigin.current = origin;
      // New origin: drop any stale match + close a left-open dialog.
      setSavedLogin(null);
      setFillDialogOpen(false);
      void fm.typebuild.credentials
        .list(origin)
        .then((creds) => {
          // Ignore a late reply if the view is gone or we've since moved on.
          if (idRef.current == null || origin !== checkedOrigin.current) return;
          if (creds.length === 0) return;
          // Note the first saved username for this origin (minimal first cut).
          setSavedLogin({ origin, username: creds[0].username, count: creds.length });
        })
        .catch(() => {
          /* not signed in / transport — silently skip */
        });
    });

    // Captured login submit → offer to save (task-1188c6535e91/ad89064bf45f).
    // Only for THIS view, and only if the user hasn't opted this origin out. The
    // password rides this event into trusted-UI state and nowhere else.
    const offCred = fm.onBrowserCredentialCaptured((c) => {
      if (c.id !== idRef.current) return;
      if (neverSaveOrigins.has(c.origin)) return;
      setPendingCred(c);
    });

    // Show the view (fresh or reused) at our slot and start tracking its rect.
    const activate = (id: number) => {
      idRef.current = id;
      report();
      schedule();
      ro = new ResizeObserver(schedule);
      if (viewRef.current) ro.observe(viewRef.current);
      window.addEventListener('resize', schedule);
      // Pull the view's CURRENT url/nav: while we were unmounted it may have
      // navigated (address bar, a click, or Playwright), so the prop is stale.
      fm.browserSync(id);
    };

    if (operatorMode) {
      // Bind to the pre-created operator view — no attach, no teardown.
      activate(viewId);
    } else if (tabId != null) {
      const existing = viewByTab.get(tabId);
      if (existing != null) {
        activate(existing);
      } else {
        void fm.browserAttach({ url }).then((id) => {
          viewByTab.set(tabId, id);
          if (disposed) {
            // Switched away before attach resolved — keep the view (the tab is
            // still open) but hide it; activate happens on the next remount.
            fm.browserHide(id);
            return;
          }
          activate(id);
        });
      }
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      window.removeEventListener('resize', schedule);
      offState();
      offCred();
      // Drop any pending captured password / fill state on unmount.
      setPendingCred(null);
      setSavedLogin(null);
      setFillDialogOpen(false);
      const id = idRef.current;
      // Tab mode: HIDE (don't destroy) — the view survives the tab switch;
      // reapBrowserViews destroys it when the tab is actually closed. Operator
      // mode: leave the view alone — the operator window owns its lifecycle.
      if (!operatorMode && id != null) fm.browserHide(id);
      idRef.current = null;
    };
  }, [tabId, viewId, operatorMode]);

  const go = () => {
    const id = idRef.current;
    if (id == null) return;
    let target = addr.trim();
    if (!target) return;
    if (!/^[a-z]+:\/\//i.test(target)) target = 'https://' + target;
    fm.browserNavigate(id, target);
  };

  // Teach-by-recording (task-01facbf6b0bc): record the human's actions in this
  // view, capturing every selector candidate so Claude Code can learn the most
  // stable one and save it as a shared NON-PHI skill. We capture STRUCTURE only,
  // never field values. The agent's Playwright session must be paused while the
  // human drives (CDP is single-client).
  const toggleRecord = async () => {
    const id = idRef.current;
    if (id == null) return;
    if (!recording) {
      const r = await fm.browserRecordStart(id);
      if (r.ok) setRecording(true);
      else console.warn('[browser:record] start failed:', r.error);
    } else {
      const r = await fm.browserRecordStop();
      setRecording(false);
      if (r.ok) {
        console.info(
          `[browser:record] captured ${r.actions?.length ?? 0} action(s)` +
            (r.site ? ` on ${r.site}` : '') +
            (r.saved ? ' — saved to site memory' : ''),
        );
      } else {
        console.warn('[browser:record] stop failed:', r.error);
      }
    }
  };

  return (
    <div className="browser-pane" ref={paneRef}>
      <div className="browser-pane__bar" ref={barRef}>
        <button
          className="browser-pane__btn"
          disabled={!nav.canGoBack}
          onClick={() => idRef.current != null && fm.browserBack(idRef.current)}
          title="Back"
        >
          ‹
        </button>
        <button
          className="browser-pane__btn"
          disabled={!nav.canGoForward}
          onClick={() => idRef.current != null && fm.browserForward(idRef.current)}
          title="Forward"
        >
          ›
        </button>
        <button
          className="browser-pane__btn"
          onClick={() => idRef.current != null && fm.browserReload(idRef.current)}
          title="Reload"
        >
          ⟳
        </button>
        <button
          className={
            'browser-pane__btn' + (recording ? ' browser-pane__btn--recording' : '')
          }
          onClick={() => void toggleRecord()}
          title={
            recording
              ? 'Stop recording — save the captured actions as a skill'
              : 'Record actions to teach a stable selector skill'
          }
        >
          {recording ? '◼ Rec' : '● Rec'}
        </button>
        <input
          className="browser-pane__addr"
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
        {/* Manual saved-login fill (task-4b786c018d78). Appears only when the
            vault has a login for the current origin; click to open the fill
            confirm. Deliberately NOT auto-popped — matches the operator session
            and stops the per-visit "Fill saved password?" pestering. */}
        <button
          className="browser-pane__btn"
          hidden={!savedLogin}
          disabled={!savedLogin}
          onClick={() => savedLogin && setFillDialogOpen(true)}
          title={
            savedLogin
              ? `Fill saved password${savedLogin.username ? ` for ${savedLogin.username}` : ''}`
              : 'No saved login for this site'
          }
        >
          🔑
        </button>
        {toolbarExtra}
      </div>
      {/* Credential banners live BETWEEN the toolbar and the page view, in flow,
          so they take real column space and shrink the view slot (the native
          WebContentsView composites over all DOM, so a floating overlay would be
          hidden behind it). Main re-syncs the view below the banner. task-890b0a7483c5 */}
      {!pendingCred && fillDialogOpen && savedLogin && (
        <div className="save-pw" role="dialog" aria-label="Fill saved password">
          <div className="save-pw__head">
            <span className="save-pw__key" aria-hidden="true">
              🔑
            </span>
            <span className="save-pw__title">
              Fill saved password
              {savedLogin.username ? ` for ${savedLogin.username}` : ''}?
            </span>
          </div>
          <div className="save-pw__actions">
            <button
              type="button"
              className="save-pw__btn save-pw__btn--primary"
              disabled={autofilling}
              onClick={() => {
                const id = idRef.current;
                if (id == null) return;
                setAutofilling(true);
                // Main resolves + injects the password; it never returns here.
                void fm
                  .browserAutofill(id, savedLogin.origin, savedLogin.username)
                  .finally(() => {
                    setAutofilling(false);
                    setFillDialogOpen(false);
                  });
              }}
            >
              {autofilling ? 'Filling…' : 'Fill'}
            </button>
            <button
              type="button"
              className="save-pw__btn"
              disabled={autofilling}
              onClick={() => setFillDialogOpen(false)}
            >
              Not now
            </button>
          </div>
        </div>
      )}
      {pendingCred && (
        <SavePasswordPrompt
          cred={pendingCred}
          onSave={async (c) => {
            // Persist to the site-keyed credential vault (task-d60860fb4d7f):
            // encrypted at rest server-side, never written to this machine.
            await saveCapturedCredential(c);
            setPendingCred(null);
          }}
          onDismiss={() => setPendingCred(null)}
          onNever={(origin) => {
            neverSaveOrigins.add(origin);
            setPendingCred(null);
          }}
        />
      )}
      <div ref={viewRef} className="browser-pane__view" />
    </div>
  );
}
