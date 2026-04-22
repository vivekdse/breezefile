/*
 * Titlebar — editorial chrome across the top of the window.
 *
 * Lanes (left → right):
 *   1. Traffic-light gutter (macOS hiddenInset) + brand wordmark
 *      "breeze·file" with a short tagline in Fraunces italic.
 *   2. Search button — opens the recursive Find prompt. The old local-
 *      filter pill was removed (fm-31d) because it didn't actually
 *      filter anything; the verb system is the one true entry point.
 *
 * Palette switching lives in the 'theme' verb (fm-5cv).
 */

import { Icon } from './Icon';
import { useStore } from '../store';
import './Titlebar.css';

export function Titlebar() {
  const { dispatch } = useStore();

  function openFind() {
    // Same surface as ⌘F / `/` — recursive find prompt.
    dispatch({ type: 'setMode', mode: 'find', buffer: '' });
  }

  return (
    <div className="titlebar drag">
      <div className="titlebar__traffic" aria-hidden />
      <div className="titlebar__brand" aria-label="Breeze File — ranger-style file manager for macOS">
        <span className="titlebar__brand-name">Breeze<em>·</em>File</span>
        <span className="titlebar__brand-tag">Ranger-style file manager for macOS.</span>
      </div>

      <button
        type="button"
        className="titlebar__search-btn no-drag"
        onClick={openFind}
        aria-label="Search files (⌘F)"
        title="Search files (⌘F)"
      >
        <Icon name="search" size={14} />
        <span className="titlebar__search-label">Search</span>
        <kbd className="titlebar__kbd">⌘F</kbd>
      </button>
    </div>
  );
}
