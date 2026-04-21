import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { applyTheme, getStoredTheme } from './theme';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ornaments.css';

// Apply the persisted palette BEFORE React mounts so the first paint is
// already in the user's chosen theme. Without this, the page would render
// once in the default (paper) palette and then swap — a visible flash.
applyTheme(getStoredTheme());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
