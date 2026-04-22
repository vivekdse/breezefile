/*
 * Welcome — first-run card.
 *
 * Surfaces the four things a new user needs to know before they get
 * stuck in Finder muscle memory:
 *   1. Just type to act (the chip prompt is the verb surface)
 *   2. Space marks; left bar shows what's selected
 *   3. Copy/Move stage — navigate, then ph (paste here) drops
 *   4. ⌘F or `find` for recursive find with local-first ranking
 *
 * Persisted via localStorage so it shows once per machine. The user can
 * re-open it from the Settings drawer (added a "Show welcome again" link).
 */

import { useEffect } from 'react';
import { useOverlayExit } from '../useOverlayExit';
import './Welcome.css';

const STORAGE_KEY = 'fm.welcomeSeen';

export function shouldShowWelcome(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '1';
  } catch {
    return false;
  }
}

export function markWelcomeSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    /* localStorage unavailable — best-effort only */
  }
  // Let other floating UI (tips, tutorial) know they can show now.
  window.dispatchEvent(new CustomEvent('fm:welcomeDismissed'));
}

/** Expose a way to re-trigger the card (e.g. from Settings → Help). */
export function resetWelcome(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}

export function Welcome({ onClose }: { onClose: () => void }) {
  const { exit, state } = useOverlayExit(onClose);

  // Esc / Enter both close the card.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        markWelcomeSeen();
        exit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exit]);

  function dismiss() {
    markWelcomeSeen();
    exit();
  }

  return (
    <div className="overlay welcome-overlay" data-state={state} onClick={dismiss}>
      <div
        className="welcome"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="welcome__close"
          onClick={dismiss}
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>
        <div className="welcome__eyebrow">Welcome to</div>
        <h1 id="welcome-title" className="welcome__title">
          Breeze<em>·</em>File
        </h1>
        <p className="welcome__lede">
          Find &amp; Act with Keyboard First File Manager. Four ideas to know, then you're set.
        </p>

        <ol className="welcome__tips">
          <li>
            <span className="welcome__num">1</span>
            <div>
              <div className="welcome__tip-title">Just type to act</div>
              <div className="welcome__tip-body">
                Press any letter to open the verb prompt — <kbd>copy</kbd>,{' '}
                <kbd>move</kbd>, <kbd>sort</kbd>, <kbd>theme</kbd>,{' '}
                <kbd>find</kbd>, <kbd>delete</kbd>… Type, pick, done.
              </div>
            </div>
          </li>
          <li>
            <span className="welcome__num">2</span>
            <div>
              <div className="welcome__tip-title">Space marks files</div>
              <div className="welcome__tip-body">
                <kbd>space</kbd> on a row toggles selection. Selected rows
                get a bold checkbox + an accent bar. Marks reset when you
                change folders.
              </div>
            </div>
          </li>
          <li>
            <span className="welcome__num">3</span>
            <div>
              <div className="welcome__tip-title">Copy/Move, then explore</div>
              <div className="welcome__tip-body">
                Pick a destination — the app navigates you there with a
                floating chip. Drill into the right subfolder, then{' '}
                <kbd>ph</kbd> (paste here) or click the chip.
              </div>
            </div>
          </li>
          <li>
            <span className="welcome__num">4</span>
            <div>
              <div className="welcome__tip-title">Find with priority</div>
              <div className="welcome__tip-body">
                <kbd>⌘F</kbd> or <kbd>/</kbd> — current folder + subfolders
                rank above Spotlight hits. Recents and bookmarks too.
              </div>
            </div>
          </li>
        </ol>

        <div className="welcome__perms">
          <div className="welcome__perms-text">
            <strong>Folder access:</strong> macOS may ask permission per
            folder. To grant once, open <em>Privacy &amp; Security</em>{' '}
            below, then click <em>Files and Folders</em> (or{' '}
            <em>Full Disk Access</em> for everything).
          </div>
          <button
            type="button"
            className="welcome__btn welcome__btn--ghost"
            onClick={() => {
              window.dispatchEvent(new CustomEvent('fm:openPrivacyHelp'));
            }}
          >
            How to grant access
          </button>
        </div>

        <div className="welcome__footer">
          <span className="welcome__hint">
            Drag rows out to Slack, Gmail, Finder — that's the killer feature.
          </span>
          <div className="welcome__footer-btns">
            <button
              type="button"
              className="welcome__btn welcome__btn--ghost"
              onClick={() => {
                markWelcomeSeen();
                exit();
                window.dispatchEvent(new CustomEvent('fm:openTutorial'));
              }}
            >
              Try the tutorial
            </button>
            <button
              type="button"
              className="welcome__btn"
              onClick={dismiss}
              autoFocus
            >
              Got it
              <kbd className="welcome__btn-kbd">↵</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
