import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { fm, type UrlSuggestion } from '../bridge';
import { SavePasswordPrompt, type CapturedCredential } from './SavePasswordPrompt';
import { Icon } from './Icon';
import { useIsMac } from '../platform';

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
  onTitle,
}: {
  tabId?: string;
  url?: string;
  viewId?: number;
  // Extra controls appended to the toolbar, in-flow (a floating overlay would be
  // hidden behind the native page view). The operator session passes its
  // collapsed-state Show/Close buttons here.
  toolbarExtra?: ReactNode;
  // task-7eb4b6cdae0f — the current page's title, streamed from 'browser:state'.
  // The in-app tab uses this to label its tab with the page title (BrowserPane).
  onTitle?: (title: string) => void;
}) {
  // Operator mode binds to a pre-created view; tab mode attaches its own.
  const operatorMode = viewId != null;
  // Cmd (macOS) vs Ctrl (Linux/Windows) for the browser shortcuts below. Read
  // from PlatformContext via useIsMac() — never navigator/process.platform in
  // the renderer (docs/cross-platform-strategy.md rule 5). We check the exact
  // modifier for the platform so a stray Ctrl on macOS (or Cmd on Linux)
  // doesn't fire a browser action.
  const isMac = useIsMac();
  const viewRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<number | null>(null);
  const [addr, setAddr] = useState(url ?? '');
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false });
  const [recording, setRecording] = useState(false);
  const [capturingPdf, setCapturingPdf] = useState(false);
  const addrFocused = useRef(false);

  // ─── Address-bar autocomplete (task-ff707aea93d8) ─────────────────────────
  // Suggestions come from MAIN (visited-URL history + known-host seed, ranked
  // there); we own the dropdown, keyboard selection, and inline "ghost"
  // completion of the most-likely host. Lives in this ONE shared surface, so
  // both the in-app tab and the operator pane get it automatically.
  const addrRef = useRef<HTMLInputElement>(null);
  const [suggestions, setSuggestions] = useState<UrlSuggestion[]>([]);
  const [acOpen, setAcOpen] = useState(false);
  // Highlighted suggestion index; -1 = "the typed text itself" (no row).
  const [acIndex, setAcIndex] = useState(-1);
  // The inline ghost completion: the remaining host characters after what the
  // user typed (e.g. typed "git" → ghost "hub.com"). Empty when not applicable.
  const [ghost, setGhost] = useState('');
  // Guards: don't re-fetch/complete on programmatic value changes (ↆ/Enter), and
  // suppress the ghost right after a Backspace/Delete so deletion isn't fought.
  const suppressComplete = useRef(false);
  // Monotonic token so a slow suggest() reply can't clobber a newer query.
  const acSeq = useRef(0);

  // The pending "Save password?" capture for THIS view (task-ad89064bf45f).
  // Holds the captured password in trusted-UI state ONLY; cleared on save/dismiss
  // and on unmount. Never logged or persisted until the user accepts.
  const [pendingCred, setPendingCred] = useState<CapturedCredential | null>(null);

  // The saved logins available for the CURRENT origin (task-4b786c018d78 +
  // ef6d465816b3). Holds NO passwords — origin + the list of usernames only; the
  // password is resolved + injected in main on fill and never reaches here. Set
  // SILENTLY on navigation when the vault has a match — it drives the toolbar key
  // button, NOT a pop-out. The user triggers the fill explicitly via the 🔑 key
  // button (matches the operator session, which never auto-offers). When MORE
  // THAN ONE login exists for the origin we show a username PICKER instead of
  // silently filling the first.
  const [savedLogin, setSavedLogin] = useState<{
    origin: string;
    usernames: string[];
  } | null>(null);
  // Whether the manual fill-confirm dialog is open (opened by the key button).
  const [fillDialogOpen, setFillDialogOpen] = useState(false);
  const [autofilling, setAutofilling] = useState(false);
  // The origin we last queried the vault for, so a re-render or in-page nav
  // doesn't re-query the SAME origin within one page visit. Reset on every
  // committed navigation (did-navigate) so a sign-out / fresh load RE-OFFERS the
  // saved login rather than offering only once per mount.
  const checkedOrigin = useRef<string>('');
  // The full URL we last saw, so a same-origin navigation (e.g. an explicit
  // sign-out) re-enables the offer without a vault re-query (task-ef6d465816b3).
  const lastUrl = useRef<string>('');

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
      // Surface the streamed page title so the owning tab can label itself with
      // it (task-7eb4b6cdae0f). onTitle is a no-op in operator mode (no prop).
      onTitle?.(s.title ?? '');
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
        checkedOrigin.current = '';
        lastUrl.current = '';
        return;
      }
      // RE-OFFER discipline (task-ef6d465816b3): a committed navigation to a new
      // URL — including a same-origin sign-out (…/account → …/login) — should let
      // the saved login be offered AGAIN, not just once per mount. So we key the
      // "already offered" guard on the full URL, and re-enable the fill dialog's
      // availability whenever the URL changes. We still only HIT the vault when
      // the ORIGIN changes (the username list is origin-keyed), reusing the cached
      // list on same-origin navigations to avoid a re-fetch storm in SPAs.
      const urlChanged = s.url !== lastUrl.current;
      lastUrl.current = s.url;
      if (urlChanged) {
        // A fresh page: close any left-open dialog so the next offer is explicit.
        setFillDialogOpen(false);
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
          // Keep ALL usernames for this origin so the UI can offer a PICKER when
          // there is more than one (task-ef6d465816b3). Names only — never a
          // value. Order is the vault's (most-recently-updated first).
          setSavedLogin({ origin, usernames: creds.map((c) => c.username) });
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

  // Navigate to an explicit URL/term, normalizing a bare host to https://.
  const navigateTo = (raw: string) => {
    const id = idRef.current;
    if (id == null) return;
    let target = raw.trim();
    if (!target) return;
    if (!/^[a-z]+:\/\//i.test(target)) target = 'https://' + target;
    closeAutocomplete();
    fm.browserNavigate(id, target);
  };

  // Enter / Go: navigate to the highlighted suggestion if one is selected,
  // otherwise to what the user typed (plus any accepted ghost completion).
  const go = () => {
    if (acOpen && acIndex >= 0 && suggestions[acIndex]) {
      navigateTo(suggestions[acIndex].url);
      return;
    }
    navigateTo(addr + ghost);
  };

  const closeAutocomplete = () => {
    setAcOpen(false);
    setAcIndex(-1);
    setSuggestions([]);
    setGhost('');
  };

  // Fetch + rank suggestions for the current query, set the dropdown, and
  // compute the inline ghost. Ghost only when the top suggestion's HOST starts
  // with what the user typed (so accepting it just finishes the host) and we
  // aren't mid-deletion.
  const refreshSuggestions = (query: string) => {
    const seq = ++acSeq.current;
    const q = query.trim();
    if (!q) {
      closeAutocomplete();
      return;
    }
    void fm.browserSuggest(q).then((list) => {
      if (seq !== acSeq.current) return; // a newer query superseded us
      if (!addrFocused.current) return; // bar lost focus while we waited
      setSuggestions(list);
      setAcOpen(list.length > 0);
      setAcIndex(-1);
      // Inline ghost from the best host-prefix match.
      let g = '';
      if (!suppressComplete.current && list.length > 0) {
        const qBare = q.replace(/^[a-z]+:\/\//i, '').toLowerCase();
        const best = list.find((s) => s.host.toLowerCase().startsWith(qBare));
        if (best && qBare && best.host.toLowerCase() !== qBare) {
          g = best.host.slice(qBare.length);
        }
      }
      setGhost(g);
    });
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

  // Full-page screenshot → PDF: auto-scroll the view, screenshot each
  // viewport, and save one PDF (electron/browser/screenshot-pdf.ts). Reveals
  // the saved file in the OS file manager on success, same as other silent
  // saves in this app (e.g. `fm.reveal`).
  const takeScreenshotPdf = async () => {
    const id = idRef.current;
    if (id == null || capturingPdf) return;
    setCapturingPdf(true);
    try {
      const r = await fm.browserScreenshotPdf(id);
      if (r.ok && r.path) {
        console.info(`[browser:screenshot-pdf] saved ${r.pages} page(s) to ${r.path}`);
        void fm.reveal(r.path);
      } else {
        console.warn('[browser:screenshot-pdf] failed:', r.error);
      }
    } finally {
      setCapturingPdf(false);
    }
  };

  // Resolve + inject the saved password for one chosen username (task-4b786c018d78
  // + ef6d465816b3). Main resolves the value from the vault and injects it into
  // the page; it NEVER returns here — only a value-free FillResult. Used by both
  // the single-login Fill button and the multi-login picker.
  const fillSavedLogin = (username: string): void => {
    const id = idRef.current;
    if (id == null || !savedLogin) return;
    setAutofilling(true);
    void fm
      .browserAutofill(id, savedLogin.origin, username)
      .finally(() => {
        setAutofilling(false);
        setFillDialogOpen(false);
      });
  };

  // Chromium-style browser shortcuts, SCOPED to this surface: the handler is
  // attached to the `.browser-pane` container's onKeyDown (below), so it only
  // fires when focus is inside a mounted browser surface — it never installs a
  // document/window listener, so it can't hijack keys app-wide when the browser
  // isn't visible. Maps the platform modifier + key to the browser actions that
  // ALREADY exist on this surface (back/forward/reload/focus-address). We do NOT
  // bind new-tab (⌘T) — this surface has no tab model; App owns tabs and reuses a
  // single browser tab — or bookmark (⌘D) — there is no bookmark action here
  // (bookmark is only an autocomplete suggestion kind).
  const onPaneKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const id = idRef.current;
    if (id == null) return;
    // The platform's primary modifier: Cmd on macOS, Ctrl elsewhere.
    const primaryMod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;

    // Alt+Left / Alt+Right → back / forward (works regardless of the primary mod).
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      if (e.key === 'ArrowLeft') {
        if (nav.canGoBack) {
          e.preventDefault();
          fm.browserBack(id);
        }
        return;
      }
      if (e.key === 'ArrowRight') {
        if (nav.canGoForward) {
          e.preventDefault();
          fm.browserForward(id);
        }
        return;
      }
    }

    if (!primaryMod || e.altKey || e.shiftKey) return;

    // ⌘/Ctrl+L → focus + select the address bar.
    if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      addrRef.current?.focus();
      addrRef.current?.select();
      return;
    }
    // ⌘/Ctrl+R → reload.
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      fm.browserReload(id);
      return;
    }
    // ⌘/Ctrl+[ / ⌘/Ctrl+] → back / forward (Chromium's alt shortcuts).
    if (e.key === '[') {
      if (nav.canGoBack) {
        e.preventDefault();
        fm.browserBack(id);
      }
      return;
    }
    if (e.key === ']') {
      if (nav.canGoForward) {
        e.preventDefault();
        fm.browserForward(id);
      }
      return;
    }
  };

  return (
    <div className="browser-pane" ref={paneRef} onKeyDown={onPaneKeyDown}>
      <div className="browser-pane__bar" ref={barRef}>
        <button
          className="browser-pane__btn"
          disabled={!nav.canGoBack}
          onClick={() => idRef.current != null && fm.browserBack(idRef.current)}
          title="Back"
        >
          <Icon name="chevron-left" size={16} />
        </button>
        <button
          className="browser-pane__btn"
          disabled={!nav.canGoForward}
          onClick={() => idRef.current != null && fm.browserForward(idRef.current)}
          title="Forward"
        >
          <Icon name="chevron-right" size={16} />
        </button>
        <button
          className="browser-pane__btn"
          onClick={() => idRef.current != null && fm.browserReload(idRef.current)}
          title="Reload"
        >
          <Icon name="refresh" size={15} />
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
          <Icon name={recording ? 'stop' : 'record'} size={15} />
        </button>
        <button
          className="browser-pane__btn"
          onClick={() => void takeScreenshotPdf()}
          disabled={capturingPdf}
          title={
            capturingPdf
              ? 'Capturing full-page screenshot…'
              : 'Save a full-page screenshot as a PDF'
          }
        >
          <Icon name="download" size={16} className={capturingPdf ? 'browser-pane__btn-icon--busy' : undefined} />
        </button>
        {/* Address bar + autocomplete. The wrapper is positioned so the ghost
            overlay and the suggestion dropdown anchor to the input. */}
        <div className="browser-pane__addrwrap">
          <input
            ref={addrRef}
            className="browser-pane__addr"
            value={addr}
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded={acOpen}
            aria-autocomplete="both"
            aria-controls="browser-ac-list"
            aria-activedescendant={
              acOpen && acIndex >= 0 ? `browser-ac-opt-${acIndex}` : undefined
            }
            onFocus={(e) => {
              addrFocused.current = true;
              e.currentTarget.select();
            }}
            onBlur={() => {
              addrFocused.current = false;
              // Defer so a click on a suggestion row (mousedown) lands first.
              setTimeout(() => {
                if (!addrFocused.current) closeAutocomplete();
              }, 120);
            }}
            onChange={(e) => {
              setAddr(e.target.value);
              setGhost('');
              refreshSuggestions(e.target.value);
            }}
            onKeyDown={(e) => {
              suppressComplete.current = e.key === 'Backspace' || e.key === 'Delete';
              if (e.key === 'Enter') {
                e.preventDefault();
                go();
                e.currentTarget.blur();
                return;
              }
              if (e.key === 'Escape') {
                if (acOpen || ghost) {
                  e.preventDefault();
                  closeAutocomplete();
                }
                return;
              }
              if (e.key === 'ArrowDown') {
                if (suggestions.length === 0) return;
                e.preventDefault();
                setAcOpen(true);
                setGhost('');
                setAcIndex((i) => {
                  const next = i + 1 >= suggestions.length ? -1 : i + 1;
                  if (next >= 0) setAddr(suggestions[next].url);
                  return next;
                });
                return;
              }
              if (e.key === 'ArrowUp') {
                if (suggestions.length === 0) return;
                e.preventDefault();
                setAcOpen(true);
                setGhost('');
                setAcIndex((i) => {
                  const next = i - 1 < -1 ? suggestions.length - 1 : i - 1;
                  if (next >= 0) setAddr(suggestions[next].url);
                  return next;
                });
                return;
              }
              // Accept the inline ghost completion with → / Tab when the caret is
              // at the end and a ghost is showing.
              if ((e.key === 'ArrowRight' || e.key === 'Tab') && ghost) {
                const el = e.currentTarget;
                const atEnd = el.selectionStart === addr.length && el.selectionEnd === addr.length;
                if (atEnd) {
                  e.preventDefault();
                  const completed = addr + ghost;
                  setAddr(completed);
                  setGhost('');
                  refreshSuggestions(completed);
                }
              }
            }}
          />
          {/* Inline ghost completion: render the typed text invisibly to push the
              ghost to the right caret position, then the remaining host in muted
              ink. Pointer-events off so it never intercepts clicks. */}
          {ghost && acIndex < 0 && (
            <div className="browser-pane__ghost" aria-hidden="true">
              <span className="browser-pane__ghost-typed">{addr}</span>
              <span className="browser-pane__ghost-rest">{ghost}</span>
            </div>
          )}
          {acOpen && suggestions.length > 0 && (
            <ul className="browser-ac" id="browser-ac-list" role="listbox">
              {suggestions.map((s, i) => (
                <li
                  key={s.url}
                  id={`browser-ac-opt-${i}`}
                  role="option"
                  aria-selected={i === acIndex}
                  className={
                    'browser-ac__row' + (i === acIndex ? ' browser-ac__row--active' : '')
                  }
                  // mousedown (not click) so it fires before the input's blur.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    navigateTo(s.url);
                    addrRef.current?.blur();
                  }}
                  onMouseEnter={() => setAcIndex(i)}
                >
                  <span className="browser-ac__kind" aria-hidden="true">
                    {s.kind === 'history' ? '🕘' : s.kind === 'bookmark' ? '★' : '🌐'}
                  </span>
                  <span className="browser-ac__host">{s.host}</span>
                  {s.title ? <span className="browser-ac__title">{s.title}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
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
              ? savedLogin.usernames.length > 1
                ? `Fill a saved password (${savedLogin.usernames.length} logins)`
                : `Fill saved password${
                    savedLogin.usernames[0] ? ` for ${savedLogin.usernames[0]}` : ''
                  }`
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
              {savedLogin.usernames.length > 1
                ? 'Fill which saved login?'
                : `Fill saved password${
                    savedLogin.usernames[0] ? ` for ${savedLogin.usernames[0]}` : ''
                  }?`}
            </span>
          </div>
          <div className="save-pw__actions">
            {savedLogin.usernames.length > 1 ? (
              // PICKER (task-ef6d465816b3): one button per saved username so the
              // user chooses instead of us silently filling the first. The
              // username is a NAME only; the password is resolved + injected in
              // main on click and never reaches the renderer.
              savedLogin.usernames.map((u) => (
                <button
                  key={u}
                  type="button"
                  className="save-pw__btn save-pw__btn--primary"
                  disabled={autofilling}
                  onClick={() => fillSavedLogin(u)}
                  title={`Fill saved password for ${u}`}
                >
                  {u || '(no username)'}
                </button>
              ))
            ) : (
              <button
                type="button"
                className="save-pw__btn save-pw__btn--primary"
                disabled={autofilling}
                onClick={() => fillSavedLogin(savedLogin.usernames[0] ?? '')}
              >
                {autofilling ? 'Filling…' : 'Fill'}
              </button>
            )}
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
