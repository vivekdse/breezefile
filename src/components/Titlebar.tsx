/*
 * Titlebar — editorial chrome across the top of the window.
 *
 * Three lanes (left → right):
 *   1. Traffic-light gutter (macOS hiddenInset) + brand wordmark
 *      "file·manager" in Fraunces italic, accent-colored middle dot.
 *   2. Search pill — wired to the active tab's `filter` so the titlebar
 *      search and the `/` find-prompt are the same surface. ⌘K focuses
 *      it from anywhere (matches the mockup's trailing ⌘K hint).
 *   3. Restyle verb — opens a swatch-grid popover of all 10 palettes
 *      (THEMES from src/theme.ts). The popover is positioned by the
 *      button; outside-click and Esc dismiss; the active palette is
 *      ringed with --accent.
 *
 * Why a popover, not a dropdown? The mockup (design-assets/inspirations/
 * themes.html) treats palette choice as a visual decision — users pick
 * by swatch, not by name — so we show all 10 strips at once.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { THEMES, useTheme, type Theme } from '../theme';
import { useStore } from '../store';
import './Titlebar.css';

export function Titlebar() {
  const { activeTab, setTab } = useStore();
  const [theme, setTheme] = useTheme();
  const [popOpen, setPopOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  // ⌘K / Ctrl+K → focus the search pill from anywhere. Lets users treat
  // the titlebar as the canonical filter entry point (the `/` key is
  // still available for the legacy prompt).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Outside-click / Esc dismiss for the palette popover.
  useEffect(() => {
    if (!popOpen) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setPopOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPopOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [popOpen]);

  const filter = activeTab?.filter ?? '';

  function onPick(next: Theme) {
    setTheme(next);
    setPopOpen(false);
  }

  return (
    <div className="titlebar drag">
      <div className="titlebar__traffic" aria-hidden />
      <div className="titlebar__brand" aria-label="file manager">
        file<em>·</em>manager
      </div>

      <label className="titlebar__search no-drag" aria-label="Filter current folder">
        <Icon name="search" size={14} />
        <input
          ref={searchRef}
          className="titlebar__search-input"
          type="text"
          spellCheck={false}
          placeholder="search everywhere"
          value={filter}
          onChange={(e) => setTab({ filter: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setTab({ filter: '' });
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <kbd className="titlebar__kbd">⌘K</kbd>
      </label>

      <div className="titlebar__restyle-wrap no-drag">
        <button
          ref={btnRef}
          className="titlebar__restyle"
          aria-haspopup="true"
          aria-expanded={popOpen}
          onClick={() => setPopOpen((v) => !v)}
          title="Change palette"
        >
          <Icon name="palette" size={13} />
          <span>Restyle</span>
        </button>

        {popOpen && (
          <div
            ref={popRef}
            className="titlebar__pop"
            role="menu"
            aria-label="Pick a palette"
          >
            <h5>Pick a palette</h5>
            <div className="titlebar__pop-grid">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={
                    'titlebar__sw' + (t.id === theme ? ' titlebar__sw--active' : '')
                  }
                  onClick={() => onPick(t.id)}
                  role="menuitemradio"
                  aria-checked={t.id === theme}
                >
                  <span className="titlebar__sw-strip" aria-hidden>
                    <i style={{ background: t.swatch[0] }} />
                    <i style={{ background: t.swatch[1] }} />
                    <i style={{ background: t.swatch[2] }} />
                  </span>
                  <span className="titlebar__sw-name">{t.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
