// fm-294 — single reusable confirm dialog.
//
// Used by the destructive 'delete' verb and chords (dD/dF), and by the
// move-on-paste step. Mounted globally in App.tsx and driven by a custom
// 'fm:confirm' event so any surface (ChipPrompt, useKeyboard, PasteChip)
// can request a confirm without prop-drilling.
//
// Keyboard contract:
//   • Esc / N → cancel
//   • Enter / Y / any extra confirmShortcuts char → confirm
//   • Tab cycles between the two action buttons (focus is trapped).
//   • Confirm button autofocuses on mount.

import { useEffect, useRef } from 'react';
import { useOverlayExit } from '../useOverlayExit';
import './ConfirmDialog.css';

export type ConfirmRequest = {
  title: string;
  body?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  // Single-character shortcuts (case-insensitive) that also trigger confirm.
  // Enter and Y are always accepted.
  confirmShortcuts?: string[];
  onConfirm: () => void | Promise<void>;
};

type Props = ConfirmRequest & { onClose: () => void };

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  confirmShortcuts = [],
  onConfirm,
  onClose,
}: Props) {
  const { exit, state } = useOverlayExit(onClose);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);

  // Always accept Enter and Y for confirm; merge in caller-supplied chars.
  const confirmKeys = new Set<string>(
    ['enter', 'y', ...confirmShortcuts.map((s) => s.toLowerCase())],
  );

  async function fire() {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await onConfirm();
    } finally {
      exit();
    }
  }

  useEffect(() => {
    // autofocus the destructive/primary action so Enter just works
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      // Defensive — there are no inputs in this dialog, but if some
      // future child sprouts one, don't hijack typing.
      if (
        tgt &&
        (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')
      ) {
        return;
      }
      const key = e.key;
      if (key === 'Escape' || key === 'n' || key === 'N') {
        e.preventDefault();
        e.stopPropagation();
        exit();
        return;
      }
      if (key === 'Tab') {
        // trap focus between the two buttons
        e.preventDefault();
        const cur = document.activeElement;
        if (cur === confirmRef.current) cancelRef.current?.focus();
        else confirmRef.current?.focus();
        return;
      }
      if (confirmKeys.has(key.toLowerCase())) {
        e.preventDefault();
        e.stopPropagation();
        void fire();
      }
    }
    // capture: ensure we beat other window keydown listeners (PasteChip's
    // Esc handler, useKeyboard's chord engine) while the dialog is open.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="overlay confirm-overlay" data-state={state} onClick={exit}>
      <div
        className="overlay__box confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="confirm__close"
          onClick={exit}
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>
        <div id="confirm-title" className="confirm__title">{title}</div>
        {body && <div className="confirm__body">{body}</div>}
        <div className="confirm__actions">
          <button
            ref={cancelRef}
            type="button"
            className="confirm__btn confirm__btn--cancel"
            onClick={exit}
          >
            <span>{cancelLabel}</span>
            <kbd className="confirm__btn__kbd">N</kbd>
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={[
              'confirm__btn',
              destructive ? 'confirm__btn--destructive' : 'confirm__btn--primary',
            ].join(' ')}
            onClick={() => void fire()}
          >
            <span>{confirmLabel}</span>
            <kbd className="confirm__btn__kbd">Y</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

// Tiny helper used by call sites to render a "Foo, Bar, Baz and N more"
// preview of file names. Keeps the message scannable for big selections.
export function summarizeNames(names: string[], cap = 5): React.ReactNode {
  if (names.length === 0) return null;
  if (names.length <= cap) {
    return (
      <ul className="confirm__list">
        {names.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    );
  }
  const head = names.slice(0, cap);
  const rest = names.length - cap;
  return (
    <ul className="confirm__list">
      {head.map((n) => (
        <li key={n}>{n}</li>
      ))}
      <li className="confirm__list-more">and {rest} more</li>
    </ul>
  );
}
