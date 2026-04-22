/*
 * Titlebar — editorial chrome across the top of the window.
 *
 * Two lanes (left → right):
 *   1. Traffic-light gutter (macOS hiddenInset) + brand wordmark
 *      "breeze·file" in Fraunces italic, accent-colored middle dot.
 *   2. Search pill — wired to the active tab's `filter` so the titlebar
 *      search and the `/` find-prompt are the same surface. ⌘K focuses
 *      it from anywhere.
 *
 * The old "Restyle" button was removed in fm-5cv — palette switching is
 * now a typeable verb in the chip prompt ("theme"), which opens the
 * shared ThemePicker modal.
 */

import { useEffect, useRef } from 'react';
import { Icon } from './Icon';
import { useStore } from '../store';
import './Titlebar.css';

export function Titlebar() {
  const { activeTab, setTab } = useStore();
  const searchRef = useRef<HTMLInputElement | null>(null);

  // ⌘K / Ctrl+K → focus the local-filter pill (current folder only).
  // ⌘F is reserved for the recursive-find verb (handled in useKeyboard.ts).
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

  const filter = activeTab?.filter ?? '';

  return (
    <div className="titlebar drag">
      <div className="titlebar__traffic" aria-hidden />
      <div className="titlebar__brand" aria-label="Breeze File — Your Keyboard Friendly File Manager">
        <span className="titlebar__brand-name">Breeze<em>·</em>File</span>
        <span className="titlebar__brand-tag">Your Keyboard Friendly File Manager</span>
      </div>

      <label className="titlebar__search no-drag" aria-label="Filter current folder">
        <Icon name="search" size={14} />
        <input
          ref={searchRef}
          className="titlebar__search-input"
          type="text"
          spellCheck={false}
          placeholder="filter this folder"
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
    </div>
  );
}
