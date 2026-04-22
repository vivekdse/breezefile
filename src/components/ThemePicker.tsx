/*
 * ThemePicker — centered modal for choosing a palette.
 *
 * Used by the 'theme' verb in the ChipPrompt (fm-5cv); replaces the old
 * Restyle button + popover that lived in the Titlebar. Same swatch grid,
 * same active/hover treatment — only the entry point and overlay shape
 * changed.
 *
 * Esc / outside-click / picking a palette all close it.
 */
import { useEffect, useRef, useState } from 'react';
import { THEMES, useTheme, type Theme } from '../theme';
import { useOverlayExit } from '../useOverlayExit';
import './ThemePicker.css';

// Picker grid is 2 columns wide (see ThemePicker.css → grid-template-columns).
// Keep the constant local so arrow nav stays in sync with the layout.
const GRID_COLS = 2;

export function ThemePicker({ onClose }: { onClose: () => void }) {
  const [theme, setTheme] = useTheme();
  const { exit, state } = useOverlayExit(onClose);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Cursor index for keyboard nav. Start on the currently-applied palette so
  // arrow keys feel anchored to "what you have now".
  const initialIdx = Math.max(0, THEMES.findIndex((t) => t.id === theme));
  const [cursor, setCursor] = useState<number>(initialIdx === -1 ? 0 : initialIdx);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        exitAndRevert();
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const t = THEMES[cursor];
        if (t) pick(t.id);
        return;
      }
      let next = cursor;
      if (e.key === 'ArrowDown') next = Math.min(THEMES.length - 1, cursor + GRID_COLS);
      else if (e.key === 'ArrowUp') next = Math.max(0, cursor - GRID_COLS);
      else if (e.key === 'ArrowRight') next = Math.min(THEMES.length - 1, cursor + 1);
      else if (e.key === 'ArrowLeft') next = Math.max(0, cursor - 1);
      else return;
      e.preventDefault();
      setCursor(next);
      // Live-preview the highlighted palette so the user sees the change as
      // they walk the grid; Esc reverts to whatever was applied on open.
      const t = THEMES[next];
      if (t) setTheme(t.id);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, exit]);

  // Snapshot the palette at open so Esc can revert the live-preview walks.
  const initialThemeRef = useRef<Theme>(theme);
  useEffect(() => {
    initialThemeRef.current = theme;
    // empty dep — capture only once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function exitAndRevert() {
    setTheme(initialThemeRef.current);
    exit();
  }

  function pick(t: Theme) {
    setTheme(t);
    exit();
  }

  return (
    <div className="overlay" data-state={state} onClick={exitAndRevert}>
      <div
        ref={boxRef}
        className="theme-picker"
        role="dialog"
        aria-label="Pick a palette"
        onClick={(e) => e.stopPropagation()}
      >
        <h5 className="theme-picker__title">Pick a palette</h5>
        <div className="theme-picker__grid">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={
                'theme-picker__sw' +
                (t.id === theme ? ' theme-picker__sw--active' : '')
              }
              onClick={() => pick(t.id)}
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
