/*
 * Welcome — first-run card.
 *
 * Two-phase:
 *   1. Brand + demo + caption + CTAs.
 *   2. Permissions notice — shown once the user commits (either CTA).
 *      Explains that macOS will prompt for protected-folder access the
 *      first time those folders are visited. User has to click OK (or
 *      press Enter) to move on; *then* the chosen action runs (tutorial
 *      or dismiss).
 *
 * Persisted via localStorage so phase 1 only shows once per machine.
 * Re-openable via the :welcome verb.
 */

import { useEffect, useState } from 'react';
import { useOverlayExit } from '../useOverlayExit';
import { WelcomeDemo } from './WelcomeDemo';
import { TipsChip } from './TipsChip';
import './Welcome.css';

const STORAGE_KEY = 'fm.welcomeSeen';
const PERMS_PRIMED_KEY = 'fm.permissionsPrimed';

// Has the user already been through the TCC-priming flow once? We can't
// query TCC state from Node without triggering prompts, so we track a
// local flag — good enough to skip the notice on a re-shown Welcome.
function permissionsPrimed(): boolean {
  try {
    return localStorage.getItem(PERMS_PRIMED_KEY) === '1';
  } catch {
    return false;
  }
}
function markPermissionsPrimed(): void {
  try {
    localStorage.setItem(PERMS_PRIMED_KEY, '1');
  } catch {
    /* noop */
  }
}

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
  window.dispatchEvent(new CustomEvent('fm:welcomeDismissed'));
}

export function resetWelcome(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}

type PendingAction = null | 'tutorial' | 'dismiss';

export function Welcome({ onClose }: { onClose: () => void }) {
  const { exit, state } = useOverlayExit(onClose);
  const [shake, setShake] = useState(false);
  // Null = main view. 'tutorial' or 'dismiss' = show permissions
  // notice; the value is the action to run on confirm.
  const [pending, setPending] = useState<PendingAction>(null);

  // While Welcome is open NO other keyboard shortcut should fire —
  // we listen in capture phase with stopImmediatePropagation so the
  // global useKeyboard handler never sees these events. Behavior
  // differs between the main view and the permissions notice:
  //
  //   MAIN VIEW
  //     Enter / T / t → commit 'tutorial' (advance to notice)
  //     Esc          → commit 'dismiss'  (advance to notice)
  //     anything else → blocked + shake
  //
  //   NOTICE VIEW
  //     Enter / Esc → confirm, run pending action, close
  //     anything else → blocked + shake
  useEffect(() => {
    function shakeOnce() {
      setShake(true);
      window.setTimeout(() => setShake(false), 380);
    }

    function runPending(action: Exclude<PendingAction, null>) {
      markWelcomeSeen();
      markPermissionsPrimed();
      // Fire-and-forget: triggers macOS TCC prompts for Desktop, Documents,
      // Downloads, and iCloud Drive while Breeze is focused. Prompts appear
      // sequentially right after the Welcome overlay dismisses. No-op if
      // already granted.
      void window.fm.primePermissions?.();
      exit();
      if (action === 'tutorial') {
        window.dispatchEvent(new CustomEvent('fm:openTutorial'));
      }
    }

    function onKey(e: KeyboardEvent) {
      if (
        e.key === 'Shift' ||
        e.key === 'Meta' ||
        e.key === 'Control' ||
        e.key === 'Alt'
      ) {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();

      if (pending) {
        if (e.key === 'Enter' || e.key === 'Escape') {
          runPending(pending);
          return;
        }
        shakeOnce();
        return;
      }

      // Main view.
      const isTutorialKey =
        e.key === 'Enter' ||
        ((e.key === 't' || e.key === 'T') && !e.metaKey && !e.ctrlKey && !e.altKey);
      if (isTutorialKey) {
        if (permissionsPrimed()) runPending('tutorial');
        else setPending('tutorial');
        return;
      }
      if (e.key === 'Escape') {
        if (permissionsPrimed()) runPending('dismiss');
        else setPending('dismiss');
        return;
      }
      shakeOnce();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [exit, pending]);

  function confirmNotice() {
    if (!pending) return;
    markWelcomeSeen();
    markPermissionsPrimed();
    void window.fm.primePermissions?.();
    exit();
    if (pending === 'tutorial') {
      window.dispatchEvent(new CustomEvent('fm:openTutorial'));
    }
  }

  function commit(action: Exclude<PendingAction, null>) {
    if (permissionsPrimed()) {
      markWelcomeSeen();
      exit();
      if (action === 'tutorial') {
        window.dispatchEvent(new CustomEvent('fm:openTutorial'));
      }
    } else {
      setPending(action);
    }
  }

  return (
    <div
      className="overlay welcome-overlay"
      data-state={state}
      onClick={() => {
        // Clicking outside the card: if we're on the notice, confirm;
        // otherwise it's a no-op (buttons are the only exit from main).
        if (pending) confirmNotice();
      }}
    >
      <div
        className={'welcome' + (shake ? ' welcome--shake' : '')}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        onClick={(e) => e.stopPropagation()}
      >
        {pending === null ? (
          <>
            <div className="welcome__eyebrow">Welcome to</div>
            <h1 id="welcome-title" className="welcome__title">
              Breeze<em>·</em>File
            </h1>

            <WelcomeDemo />

            <p className="welcome__caption">
              Keyboard-first Fast File Management
            </p>

            <div className="welcome__footer">
              <div className="welcome__footer-btns">
                <button
                  type="button"
                  className="welcome__btn welcome__btn--ghost"
                  onClick={() => commit('dismiss')}
                >
                  Get started
                  <kbd className="welcome__btn-kbd welcome__btn-kbd--ghost">Esc</kbd>
                </button>
                <button
                  type="button"
                  className="welcome__btn"
                  onClick={() => commit('tutorial')}
                  autoFocus
                >
                  Try the tutorial
                  <kbd className="welcome__btn-kbd">↵</kbd>
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <h2 id="welcome-title" className="welcome__notice-title">
              Your Mac will ask for some permissions.
            </h2>
            <p className="welcome__notice-body">
              To protect your privacy, macOS will ask Breeze File for
              permission to read Desktop, Documents, Downloads, and
              iCloud Drive. Click <strong>Allow</strong> on each prompt
              that appears after this. Nothing leaves your machine.
            </p>
            <div className="welcome__footer welcome__footer--notice">
              <button
                type="button"
                className="welcome__btn"
                onClick={confirmNotice}
                autoFocus
              >
                OK
                <kbd className="welcome__btn-kbd">↵</kbd>
              </button>
            </div>
          </>
        )}
      </div>
      {/* Rotating tip centered beneath the card — only on the main
          view, not the permissions notice (which needs focus). */}
      {pending === null && <TipsChip variant="centered" />}
    </div>
  );
}
