// fm-b5at.10 — TypeBuild MCP session-expiry banner.
//
// The MCP token a TypeBuild session runs on lives ~8h and can't refresh
// mid-session. Main's expiry clock (electron/typebuild/expiry-clock.ts) warns
// at T-15min and, at/after expiry, asks the user to restart. This is the
// in-tab surface for both phases — a quiet, non-blocking strip pinned to the
// top of the session's terminal pane:
//
//   - 'warning'  → a soft heads-up ("This task session expires soon."),
//                  dismissible. Nothing is broken yet.
//   - 'expired'  → a friendly one-button relaunch ("Your secure session
//                  expired — restart task?" + [Restart task]). The user never
//                  sees the raw MCP/connection error underneath; this strip
//                  sits over it.
//
// PHI: the strip carries no task title/body — at most the opaque task id lives
// upstream; here we show only generic copy. Mounted by App.tsx over the active
// TypeBuild terminal tab.

import './TypebuildSessionBanner.css';

type Props = {
  phase: 'warning' | 'expired';
  /** Relaunch in flight — disables the button + shows a working label. */
  busy?: boolean;
  /** A friendly, PHI-free error if the last relaunch attempt failed (e.g. the
   *  mapped mint-failure message). Shown inline so the user can retry. */
  error?: string | null;
  /** 'expired' → relaunch. */
  onRestart: () => void;
  /** 'warning' → dismiss the heads-up. */
  onDismiss: () => void;
};

export function TypebuildSessionBanner({
  phase,
  busy = false,
  error,
  onRestart,
  onDismiss,
}: Props) {
  if (phase === 'warning') {
    return (
      <div className="tb-session-banner tb-session-banner--warning" role="status">
        <span className="tb-session-banner__text">
          This task session expires soon.
        </span>
        <button
          type="button"
          className="tb-session-banner__dismiss"
          onClick={onDismiss}
          aria-label="Dismiss"
          title="Dismiss"
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div className="tb-session-banner tb-session-banner--expired" role="alert">
      <span className="tb-session-banner__text">
        {error ?? 'Your secure session expired — restart task?'}
      </span>
      <button
        type="button"
        className="tb-session-banner__btn"
        onClick={onRestart}
        disabled={busy}
      >
        {busy ? 'Restarting…' : 'Restart task'}
      </button>
    </div>
  );
}
