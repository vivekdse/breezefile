// Floating paste affordance (fm-3km).
//
// Persists across navigation while `state.yank` has items. The user can pick
// a destination via the chip prompt (Copy / Move verbs) — those verbs now
// stage the yank and navigate the active tab to the destination, leaving
// this chip on screen so the user can confirm the paste with a click or pp.
//
// The chip pastes into the *current* cwd, not the originally-picked
// destination — so the user is free to keep navigating into a sub-folder.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { runPaste, type PasteSuccessDetail } from '../clipboard';
import { basename, dirname, lastCol } from '../actions';
import './PasteChip.css';

type SuccessState = { count: number; verb: 'Pasted' | 'Moved' } | null;

// How long the success pill stays before auto-dismissing.
const SUCCESS_LINGER_MS = 2200;

export function PasteChip() {
  const { state, dispatch, activeTab, refreshActive } = useStore();
  const [exiting, setExiting] = useState(false);
  const [success, setSuccess] = useState<SuccessState>(null);
  const dismissTimer = useRef<number | null>(null);

  const yankCount = state.yank.length;
  const mode = state.yank[0]?.mode;

  // Reset exit animation flag whenever a new yank arrives.
  useEffect(() => {
    if (yankCount > 0) {
      setExiting(false);
      setSuccess(null);
    }
  }, [yankCount]);

  // Listen for paste-success → flip the chip to its success state, then
  // auto-dismiss after SUCCESS_LINGER_MS. Works for both click-paste and
  // the `ph` chord since both go through runPaste in clipboard.ts.
  useEffect(() => {
    function onSuccess(e: Event) {
      const detail = (e as CustomEvent<PasteSuccessDetail>).detail;
      if (!detail) return;
      setSuccess({
        count: detail.count,
        verb: detail.mode === 'move' ? 'Moved' : 'Pasted',
      });
      // Clear yank for copy too (move already cleared in runPaste) so the
      // chip can fully retire instead of returning to its idle "Paste here"
      // state when the success state ends.
      if (detail.mode !== 'move') dispatch({ type: 'setYank', yank: [] });
      if (dismissTimer.current != null) window.clearTimeout(dismissTimer.current);
      // Step 1: linger in success state with progress-bar drain.
      dismissTimer.current = window.setTimeout(() => {
        setExiting(true);
        // Step 2: after the exit animation, fully unmount.
        window.setTimeout(() => {
          setSuccess(null);
          setExiting(false);
        }, 180);
        dismissTimer.current = null;
      }, SUCCESS_LINGER_MS);
    }
    window.addEventListener('fm:paste-success', onSuccess);
    return () => {
      window.removeEventListener('fm:paste-success', onSuccess);
      if (dismissTimer.current != null) window.clearTimeout(dismissTimer.current);
    };
  }, [dispatch]);

  // Esc dismisses when no input/textarea is focused.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
      if (state.yank.length === 0) return;
      // Don't fight overlays — only act in normal mode so Esc still closes
      // the chip prompt / find prompt first.
      if (state.mode !== 'normal') return;
      e.preventDefault();
      dismiss();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.yank.length, state.mode]);

  if (yankCount === 0 && !exiting && !success) return null;
  if (!activeTab) return null;

  function dismiss() {
    setExiting(true);
    // Wait for the exit animation before clearing yank — keeps the chip
    // visible during the slide-down so it doesn't pop.
    window.setTimeout(() => {
      dispatch({ type: 'setYank', yank: [] });
      setExiting(false);
    }, 160);
  }

  async function doPaste() {
    if (!activeTab) return;
    const cwd = activeTab.trail[lastCol(activeTab)];
    const yank = state.yank;
    // fm-294 — confirm before a destructive move. Copy proceeds without
    // a prompt (originals stay put, easy to undo).
    if (yank.length > 0 && yank[0].mode === 'move') {
      const names = yank.map((y) => basename(y.path));
      const head = names.slice(0, 5);
      const more = names.length > 5 ? names.length - 5 : 0;
      const detail = head.join(', ') + (more > 0 ? ` and ${more} more` : '');
      const fromDir = dirname(yank[0].path);
      const body = `From  ${fromDir}\n  →   ${cwd}\n\n${detail}`;
      window.dispatchEvent(
        new CustomEvent('fm:confirm', {
          detail: {
            title: `Move ${yank.length} item${yank.length === 1 ? '' : 's'}?`,
            body,
            confirmLabel: 'Move',
            destructive: false,
            confirmShortcuts: ['m'],
            onConfirm: async () => {
              await runPaste({ yank, cwd, dispatch, refreshActive });
              setExiting(true);
            },
          },
        }),
      );
      return;
    }
    // Don't manually setExiting here — the runPaste helper emits
    // `fm:paste-success` which our event listener consumes to flip the
    // chip into success state and auto-dismiss after a short delay.
    await runPaste({ yank, cwd, dispatch, refreshActive });
  }

  const verb = mode === 'move' ? 'Move' : 'Paste';
  const label = `${verb} ${yankCount} file${yankCount === 1 ? '' : 's'} here`;

  if (success) {
    const successLabel = `${success.verb} ${success.count} file${success.count === 1 ? '' : 's'}`;
    return (
      <div
        className={['paste-chip', 'paste-chip--success', exiting ? 'paste-chip--out' : '']
          .filter(Boolean)
          .join(' ')}
        role="status"
        aria-label={successLabel}
      >
        <span className="paste-chip__icon" aria-hidden>✓</span>
        <span className="paste-chip__label">{successLabel}</span>
        <span
          className="paste-chip__progress"
          style={{ animationDuration: `${SUCCESS_LINGER_MS}ms` }}
          aria-hidden
        />
      </div>
    );
  }

  return (
    <div
      className={['paste-chip', exiting ? 'paste-chip--out' : ''].filter(Boolean).join(' ')}
      role="dialog"
      aria-label={label}
    >
      <button
        type="button"
        className="paste-chip__action"
        onClick={doPaste}
        title="Paste into the current folder"
      >
        <span className="paste-chip__icon" aria-hidden>↓</span>
        <span className="paste-chip__label">{label}</span>
        <kbd className="paste-chip__kbd">ph</kbd>
      </button>
      <button
        type="button"
        className="paste-chip__dismiss"
        onClick={dismiss}
        aria-label="Clear clipboard"
        title="Clear clipboard (Esc)"
      >
        ×
      </button>
    </div>
  );
}
