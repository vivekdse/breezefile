import { useEffect, useRef, useState } from 'react';
import { fm } from '../bridge';

// SPIKE (spike/playwright-cdp): renderer half of an embedded browser tab.
//
// The actual web page is a main-process WebContentsView that floats ABOVE the
// React DOM — React can neither position nor clip it. So we render a normal
// toolbar (address + nav, real DOM) and an empty placeholder for the page; we
// measure the placeholder and stream its viewport rect to main
// (`browser:bounds`), which mirrors the view onto exactly that rect. The view
// therefore sits BELOW the toolbar and fills the rest of the tab. On unmount
// (tab closed / switched away) we destroy the view.
export function BrowserPane({ url }: { url: string }) {
  const viewRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<number | null>(null);
  const [addr, setAddr] = useState(url);
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false });
  const addrFocused = useRef(false);

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

    fm.browserAttach({ url }).then((id) => {
      if (disposed) {
        void fm.browserDestroy(id);
        return;
      }
      idRef.current = id;
      // Measure once now and again next frame (after the grid settles).
      report();
      schedule();
      ro = new ResizeObserver(schedule);
      if (viewRef.current) ro.observe(viewRef.current);
      window.addEventListener('resize', schedule);
      // SPIKE diag — after layout settles, dump where every element actually
      // landed so we can see why the address bar isn't visible.
      setTimeout(() => {
        const rectOf = (el: HTMLElement | null) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            x: Math.round(r.x), y: Math.round(r.y),
            w: Math.round(r.width), h: Math.round(r.height),
            display: cs.display, bg: cs.backgroundColor,
          };
        };
        fm.browserDebug({
          dpr: window.devicePixelRatio,
          win: { w: window.innerWidth, h: window.innerHeight },
          bar: rectOf(barRef.current),
          view: rectOf(viewRef.current),
          pane: rectOf(paneRef.current),
          main: rectOf(document.querySelector('.shell__main')),
        });
      }, 500);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      window.removeEventListener('resize', schedule);
      offState();
      const id = idRef.current;
      if (id != null) {
        void fm.browserDestroy(id);
        idRef.current = null;
      }
    };
  }, [url]);

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
      </div>
      <div ref={viewRef} className="browser-pane__view" />
    </div>
  );
}
