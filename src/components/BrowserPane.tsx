import { useEffect, useRef, useState } from 'react';
import { fm } from '../bridge';
import { SavePasswordPrompt, type CapturedCredential } from './SavePasswordPrompt';

// SPIKE (spike/playwright-cdp): renderer half of an embedded browser tab.
//
// The actual web page is a main-process WebContentsView that floats ABOVE the
// React DOM — React can neither position nor clip it. So we render a normal
// toolbar (address + nav, real DOM) and an empty placeholder for the page; we
// measure the placeholder and stream its viewport rect to main
// (`browser:bounds`), which mirrors the view onto exactly that rect. The view
// sits BELOW the toolbar and fills the rest of the tab.
//
// The native view must OUTLIVE this component. App renders only the ACTIVE
// tab's content, so this unmounts on every tab switch — if we destroyed the
// view here, switching away would discard the page and switching back would
// reload the ORIGINAL url, losing navigation and killing any live CDP/Playwright
// session. Instead we key one persistent view per (stable) tab id: HIDE on
// unmount, REUSE on remount. App calls reapBrowserViews() to destroy a view
// only when its tab is actually closed.
const viewByTab = new Map<string, number>();

// Origins the user said "never save here" for, this session. Module-level so the
// opt-out survives BrowserPane remounts (tab switches). NON-secret (origins only).
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

// Persist an accepted captured credential. T3 ships the seam; T4
// (task-d60860fb4d7f) wires it to the site-keyed credential vault. Kept as a
// single chokepoint so the prompt's "Save" has exactly one persist path.
async function saveCapturedCredential(cred: CapturedCredential): Promise<void> {
  await fm.typebuild.credentials.save({
    origin: cred.origin,
    username: cred.username,
    password: cred.password,
  });
}

export function BrowserPane({ tabId, url }: { tabId: string; url: string }) {
  const viewRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<number | null>(null);
  const [addr, setAddr] = useState(url);
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false });
  const addrFocused = useRef(false);

  // The pending "Save password?" capture for THIS pane's view (task-ad89064bf45f).
  // Holds the captured password in trusted-UI state ONLY; cleared on save/dismiss
  // and on unmount. Never logged or persisted until the user accepts.
  const [pendingCred, setPendingCred] = useState<CapturedCredential | null>(null);

  // Return-visit autofill offer (task-4b786c018d78): a saved login for the
  // current origin we can fill. Holds NO password (origin+username only); the
  // password is resolved + injected in main on accept and never reaches here.
  const [autofillOffer, setAutofillOffer] = useState<{
    origin: string;
    username: string;
    count: number;
  } | null>(null);
  const [autofilling, setAutofilling] = useState(false);
  // Origins we've already offered/dismissed this mount, so a re-render or sub-
  // frame nav doesn't re-pester. (Session-level, per pane.)
  const offeredOrigins = useRef<Set<string>>(new Set());

  // Keyed on tabId, NOT url: the view persists across navigations, so we must
  // not tear it down when the (initial) url prop changes.
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
      // Return-visit autofill: if this origin has a saved login we haven't
      // offered yet this mount, offer to fill it (task-4b786c018d78). Origins
      // only — the password is never fetched here.
      let origin = '';
      try {
        origin = new URL(s.url).origin;
      } catch {
        /* non-http(s) url — no autofill */
      }
      if (!origin || origin === 'null') return;
      if (offeredOrigins.current.has(origin)) return;
      offeredOrigins.current.add(origin);
      void fm.typebuild.credentials
        .list(origin)
        .then((creds) => {
          if (idRef.current == null || creds.length === 0) return;
          // Offer the first saved username for this origin (minimal first cut).
          setAutofillOffer({
            origin,
            username: creds[0].username,
            count: creds.length,
          });
        })
        .catch(() => {
          /* not signed in / transport — silently skip the offer */
        });
    });

    // Captured login submit → offer to save (task-1188c6535e91/ad89064bf45f).
    // Only for THIS pane's view, and only if the user hasn't opted this origin
    // out. The password rides this event into trusted-UI state and nowhere else.
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

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      window.removeEventListener('resize', schedule);
      offState();
      offCred();
      // Drop any pending captured password when the pane unmounts (tab switch).
      setPendingCred(null);
      setAutofillOffer(null);
      const id = idRef.current;
      // HIDE, don't destroy — the view survives the tab switch. reapBrowserViews
      // destroys it when the tab is actually closed.
      if (id != null) fm.browserHide(id);
      idRef.current = null;
    };
  }, [tabId]);

  const go = () => {
    const id = idRef.current;
    if (id == null) return;
    let target = addr.trim();
    if (!target) return;
    if (!/^[a-z]+:\/\//i.test(target)) target = 'https://' + target;
    fm.browserNavigate(id, target);
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
        {!pendingCred && autofillOffer && (
          <div className="save-pw" role="dialog" aria-label="Fill saved password">
            <div className="save-pw__head">
              <span className="save-pw__key" aria-hidden="true">
                🔑
              </span>
              <span className="save-pw__title">
                Fill saved password
                {autofillOffer.username ? ` for ${autofillOffer.username}` : ''}?
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
                    .browserAutofill(id, autofillOffer.origin, autofillOffer.username)
                    .finally(() => {
                      setAutofilling(false);
                      setAutofillOffer(null);
                    });
                }}
              >
                {autofilling ? 'Filling…' : 'Fill'}
              </button>
              <button
                type="button"
                className="save-pw__btn"
                disabled={autofilling}
                onClick={() => setAutofillOffer(null)}
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
      </div>
      <div ref={viewRef} className="browser-pane__view" />
    </div>
  );
}
