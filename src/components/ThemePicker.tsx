/*
 * ThemePicker — centered modal for choosing a palette.
 *
 * Opened by the 'theme' verb in the ChipPrompt. Arrow keys live-preview
 * the highlighted palette; Enter applies; Esc / outside-click / × close.
 */
import { useEffect, useRef, useState } from 'react';
import { THEMES, applyTheme, useTheme, type Theme } from '../theme';
import { useOverlayExit } from '../useOverlayExit';
import './ThemePicker.css';

// Picker grid is 2 columns wide (see ThemePicker.css → grid-template-columns).
const GRID_COLS = 2;

// Ignore outside-click for this many ms after mount so the click that
// opened the modal (bubbling up from the chip prompt) can't immediately
// dismiss it.
const READY_GUARD_MS = 200;

export function ThemePicker({ onClose }: { onClose: () => void }) {
  const [theme, setTheme] = useTheme();
  // Live-previewing (arrow-nav or hover) should NOT persist. Only
  // pick() — the user's explicit commit — goes through setTheme /
  // chooseTheme. Otherwise scrolling past paper locks it in as the
  // "chosen" theme, defeating DEFAULT_THEME on future boots.
  // `preview` just repaints <html data-theme> without touching storage.
  const preview = (t: Theme) => applyTheme(t);
  const { exit, state } = useOverlayExit(onClose);

  // Cursor index for keyboard nav. Start on the currently-applied palette.
  const initialIdx = Math.max(0, THEMES.findIndex((t) => t.id === theme));
  const [cursor, setCursor] = useState<number>(initialIdx === -1 ? 0 : initialIdx);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  // Snapshot theme at mount so Esc / outside-click can revert any
  // arrow-key live previews back to what was active when the user opened.
  const initialThemeRef = useRef<Theme>(theme);

  // Mount-ready guard: prevents the synthetic event that triggered the
  // open from immediately closing the freshly-mounted modal. (Bubbling
  // events from the chip prompt's verb-selection click/Enter were
  // dismissing the picker before the user saw it.)
  const readyRef = useRef(false);
  useEffect(() => {
    const id = window.setTimeout(() => {
      readyRef.current = true;
    }, READY_GUARD_MS);
    return () => window.clearTimeout(id);
  }, []);

  function exitAndRevert() {
    if (!readyRef.current) return;
    // Transient repaint only — do not persist the revert.
    preview(initialThemeRef.current);
    exit();
  }
  function pick(t: Theme) {
    // Explicit commit — persist via chooseTheme (through setTheme).
    setTheme(t);
    exit();
  }

  // Keydown listener — single attach via empty-dep useEffect, reads
  // current cursor from the ref so we don't churn the listener.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ignore any key event within the ready window. Prevents the
      // Enter press that opened the picker from auto-repeat-firing
      // pick() on the first swatch and instantly closing us.
      if (!readyRef.current) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        exitAndRevert();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const t = THEMES[cursorRef.current];
        if (t) pick(t.id);
        return;
      }
      const cur = cursorRef.current;
      let next = cur;
      if (e.key === 'ArrowDown') next = Math.min(THEMES.length - 1, cur + GRID_COLS);
      else if (e.key === 'ArrowUp') next = Math.max(0, cur - GRID_COLS);
      else if (e.key === 'ArrowRight') next = Math.min(THEMES.length - 1, cur + 1);
      else if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1);
      else return;
      e.preventDefault();
      setCursor(next);
      const t = THEMES[next];
      if (t) preview(t.id);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="overlay" data-state={state} onClick={exitAndRevert}>
      <div
        className="theme-picker"
        role="dialog"
        aria-label="Pick a palette"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="theme-picker__close"
          onClick={exitAndRevert}
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>
        <h5 className="theme-picker__title">Pick a palette</h5>
        <div className="theme-picker__grid">
          {THEMES.map((t, i) => (
            <button
              key={t.id}
              className={
                'theme-picker__sw' +
                (i === cursor ? ' theme-picker__sw--active' : '')
              }
              onClick={() => pick(t.id)}
              onMouseEnter={() => setCursor(i)}
              role="menuitemradio"
              aria-checked={t.id === theme}
            >
              <span className="theme-picker__sw-strip" aria-hidden>
                <i style={{ background: t.swatch[0] }} />
                <i style={{ background: t.swatch[1] }} />
                <i style={{ background: t.swatch[2] }} />
              </span>
              <span className="theme-picker__sw-name">{t.label}</span>
              {t.id === theme && (
                <span className="theme-picker__sw-check" aria-hidden>
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
