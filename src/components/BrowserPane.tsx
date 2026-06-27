import { useEffect, useRef, useState } from 'react';
import { fm } from '../bridge';

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

export function BrowserPane({ tabId, url }: { tabId: string; url: string }) {
  const viewRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<number | null>(null);
  const [addr, setAddr] = useState(url);
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false });
  const [recording, setRecording] = useState(false);
  const addrFocused = useRef(false);

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
      </div>
      <div ref={viewRef} className="browser-pane__view" />
    </div>
  );
}
