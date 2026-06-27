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

// task-f730389afa8a — the operator session window loads this same bundle with
// `#operator=<ptyId>` (or bare `#operator` for the no-agent open-browser verb).
// It renders the split-pane chrome (browser LEFT + Claude terminal RIGHT)
// instead of the full app. See electron/browser/window.ts and
// src/components/OperatorSession.tsx.
const operatorHash = new URLSearchParams(window.location.hash.slice(1)).get('operator');
const isOperator = operatorHash != null;
const operatorPty =
  operatorHash != null && operatorHash !== '' ? Number(operatorHash) : null;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isOperator ? <OperatorSession ptyId={operatorPty} /> : <App />}
  </React.StrictMode>,
);

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
