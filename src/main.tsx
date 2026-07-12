import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { OperatorSession } from './components/OperatorSession';
import { applyTheme, getStoredTheme } from './theme';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ornaments.css';
import './styles/motion.css';
import './styles/buttons.css';
import './styles/typography.css';

// Apply the persisted palette BEFORE React mounts so the first paint is
// already in the user's chosen theme. Without this, the page would render
// once in the default (paper) palette and then swap — a visible flash.
applyTheme(getStoredTheme());

// Stamp <html data-profile> at boot (dev amber stripe, styles/base.css) —
// component-mounted stamping missed the LoginGate screen, exactly where a
// user can't tell the dev and stable windows apart.
void import('./appInfo').then(({ loadAppInfo }) => void loadAppInfo());

// task-f730389afa8a — the operator session window loads this same bundle with
// `#operator=<ptyId>&view=<id>` (or bare `#operator` for the no-agent
// open-browser verb). It renders the split-pane chrome (browser LEFT + Claude
// terminal RIGHT) instead of the full app. The `view` id is the shared browser
// view (electron/browser/views.ts) the left pane drives over `browser:*`. See
// electron/browser/window.ts and src/components/OperatorSession.tsx.
// The hash is RE-PARSED on every render pass, and we re-render on `hashchange`:
// loadOperatorChrome re-points a REUSED operator window to a new session via
// loadURL with only the fragment changed, which Chromium treats as a
// SAME-DOCUMENT navigation — no reload, no module re-eval. A one-shot
// module-load parse therefore left the pane stuck on the optimistic
// "Starting session…" splash (launching=1, ptyId=null) forever while the real
// session ran headless underneath (bug 2026-07-05).
function readOperatorParams() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const hash = params.get('operator');
  const viewParam = params.get('view');
  return {
    isOperator: hash != null,
    pty: hash != null && hash !== '' ? Number(hash) : null,
    view: viewParam != null && viewParam !== '' ? Number(viewParam) : null,
    // task-7ba4409eeb5c — set on the OPTIMISTIC-launch open (window up, pty not
    // yet spawned). Distinguishes a healthy in-flight launch (show "Starting
    // session…") from a genuinely session-less window (the bare open-browser
    // verb, "No agent session."). Cleared when the real pty attaches (the hash
    // becomes `operator=<ptyId>` with no launching flag).
    launching: params.get('launching') === '1',
  };
}
const isOperator = readOperatorParams().isOperator;

const root = ReactDOM.createRoot(document.getElementById('root')!);
function renderRoot() {
  const op = readOperatorParams();
  root.render(
    <React.StrictMode>
      {op.isOperator ? (
        // Key on the pty so a re-point to a NEW session remounts the pane (fresh
        // terminal subscribe + replay) instead of diffing into a stale one.
        <OperatorSession key={op.pty ?? 'none'} ptyId={op.pty} viewId={op.view} launching={op.launching} />
      ) : (
        <App />
      )}
    </React.StrictMode>,
  );
}
renderRoot();
if (isOperator) window.addEventListener('hashchange', renderRoot);

// fm-ued6 — cold-start profiling: signal the main process once the browser has
// painted the first frame (double-rAF: the first callback runs before paint, the
// second after the commit). Only the main app window reports, not the operator
// session. Fire-and-forget + optional-chained so it's a no-op when the bridge
// predates this method. NON-PHI.
if (!isOperator) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => window.fm?.reportFirstPaint?.()),
  );
}
