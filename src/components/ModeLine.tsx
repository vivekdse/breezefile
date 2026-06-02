import { useEffect, useState } from 'react';
import { useStore } from '../store';
import './ModeLine.css';

/**
 * Bottom mode-line — transient status + pending-keys prefix.
 *
 * Motion roles:
 *   fm-30p — status messages slide up from below on change and auto-dismiss
 *            after ~3s via a local timer. Store-held statusMsg survives
 *            until the next setStatus call, but the line clears its own
 *            display so "log spam" doesn't accumulate.
 *   fm-pdx — mode/prefix cross-fade. Re-keyed spans animate on change so
 *            j→/→n reads as "gearing up" rather than a text swap.
 */
export function ModeLine() {
  const { state } = useStore();

  // Local copy of statusMsg + a monotonic key that bumps on every new
  // message so the animation re-runs even when the text repeats.
  const [msg, setMsg] = useState<string | null>(null);
  const [msgKey, setMsgKey] = useState(0);
  const [isError, setIsError] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!state.statusMsg) {
      setMsg(null);
      return;
    }
    setMsg(state.statusMsg);
    setMsgKey((k) => k + 1);
    setCopied(false);
    // Errors don't auto-dismiss: they stick until the next message or an
    // explicit dismiss, so there's always time to read AND copy them
    // (errors like "tunnel did not come up" need to be pasted elsewhere).
    const err = /failed|error|denied|refused|did not come up|timed out/i.test(
      state.statusMsg,
    );
    setIsError(err);
    if (err) return;
    const t = window.setTimeout(() => setMsg(null), 3000);
    return () => window.clearTimeout(t);
  }, [state.statusMsg]);

  if (!state.pending && !msg) return null;

  return (
    <div className="modeline" role="status" aria-live="polite">
      {state.pending && (
        <span
          key={`pending-${state.pending}`}
          className="modeline__pending modeline__xfade"
        >
          {state.pending}
        </span>
      )}
      {msg && (
        <span
          key={`msg-${msgKey}`}
          className={`modeline__status modeline__slide${
            isError ? ' modeline__status--error' : ''
          }`}
        >
          {msg}
        </span>
      )}
      {msg && isError && (
        <span className="modeline__actions">
          <button
            type="button"
            className="modeline__btn"
            title="Copy this message to the clipboard"
            onClick={() => {
              navigator.clipboard.writeText(msg).then(
                () => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                },
                () => {},
              );
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            className="modeline__btn"
            title="Dismiss"
            onClick={() => setMsg(null)}
          >
            ✕
          </button>
        </span>
      )}
    </div>
  );
}
