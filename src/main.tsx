import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { AgentOverlay } from './components/AgentOverlay';
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

// SPIKE (spike/playwright-cdp): the agent-chat overlay window loads this same
// bundle with `#overlay=<ptyId>` — render only the terminal for that pty, not
// the full app. See electron/browser/overlay.ts.
const overlayPty = new URLSearchParams(window.location.hash.slice(1)).get('overlay');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {overlayPty != null ? <AgentOverlay ptyId={Number(overlayPty)} /> : <App />}
  </React.StrictMode>,
);

// fm-ued6 — cold-start profiling: signal the main process once the browser has
// painted the first frame (double-rAF: the first callback runs before paint, the
// second after the commit). Only the main app window reports, not the overlay.
// Fire-and-forget + optional-chained so it's a no-op when the bridge predates
// this method. NON-PHI.
if (overlayPty == null) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => window.fm?.reportFirstPaint?.()),
  );
}
