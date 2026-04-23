/*
 * Theme system — single source of truth for which editorial palette
 * is active, with a minimal React API and a localStorage-backed
 * preference.
 *
 * Design notes:
 *   - Tokens live in src/styles/tokens.css under :root[data-theme="X"].
 *     This module owns *which* data-theme is on <html>, not the colors.
 *   - applyTheme() is a plain function callable before React mounts,
 *     so main.tsx can set the stored palette on <html> pre-render and
 *     avoid a paper→chosen-theme FOUC flash.
 *   - useTheme() is a thin React hook: it reads current state, writes
 *     on change, and persists. No Context needed — the shared state
 *     is the DOM attribute itself, which any component can subscribe
 *     to via a MutationObserver if it truly needs to react, but
 *     99% of consumers just call setTheme and let CSS handle the rest.
 *   - Titlebar UI (the Restyle popover from the mockup) will be built
 *     in fm-9w0; this module exposes everything that UI needs.
 */

import { useEffect, useState } from 'react';

export type Theme =
  | 'paper'
  | 'pastel'
  | 'peony'
  | 'clay'
  | 'moss'
  | 'linen'
  | 'rose'
  | 'dawn'
  | 'plum'
  | 'dusk';

export interface ThemeMeta {
  id: Theme;
  /** Display name for the swatch label (rendered in Fraunces). */
  label: string;
  /** Three-color strip shown in the picker: [panel, bg, accent]. */
  swatch: [string, string, string];
}

/**
 * Ordered catalog driving the theme picker. Dusk first (default),
 * Paper second (second most popular), then the rest.
 */
export const THEMES: readonly ThemeMeta[] = [
  { id: 'dusk', label: 'Dusk', swatch: ['#2b2032', '#150d1c', '#f4b09a'] },
  { id: 'paper', label: 'Paper', swatch: ['#fbf6ea', '#ebe3ce', '#a3391a'] },
  { id: 'pastel', label: 'Pastel', swatch: ['#fef8f6', '#f1dfd9', '#b56b7c'] },
  { id: 'peony', label: 'Peony', swatch: ['#f9f5f8', '#e7dde4', '#c04673'] },
  { id: 'clay', label: 'Clay', swatch: ['#fef6f4', '#f0cfcb', '#7a1f2f'] },
  { id: 'moss', label: 'Moss', swatch: ['#fcf1ed', '#f2d9cf', '#2f5a3e'] },
  { id: 'linen', label: 'Linen', swatch: ['#f1ecdf', '#dcd5c0', '#7d8a6e'] },
  { id: 'rose', label: 'Rose', swatch: ['#fbf4f4', '#ecd9da', '#b26a6a'] },
  { id: 'dawn', label: 'Dawn', swatch: ['#faf2f2', '#ecdfe3', '#c85b40'] },
  { id: 'plum', label: 'Plum', swatch: ['#2a1a30', '#faeff2', '#c1378b'] },
] as const;

/**
 * Map old theme IDs to new ones, so users with a stored legacy preference
 * land on the renamed palette instead of falling back to the default.
 * Safe to remove once we're confident no one is on a pre-rename build.
 */
const LEGACY_THEME_ALIASES: Record<string, Theme> = {
  feminism: 'peony',
  'feminism-night': 'plum',
  orchid: 'clay',
  garden: 'moss',
  sakura: 'rose',
};

export const DEFAULT_THEME: Theme = 'dusk';

const STORAGE_KEY = 'fm.theme';
// Presence of this key means the user explicitly picked a theme. Without
// it, any value in STORAGE_KEY is a stale artifact from an older build
// (when 'paper' was the default and we persisted the default on boot).
// We honor stored themes only when the chosen flag is set, so changing
// DEFAULT_THEME actually takes effect for users who never picked.
const CHOSEN_KEY = 'fm.theme.chosen';
const THEME_IDS = new Set<Theme>(THEMES.map((t) => t.id));

function isTheme(x: unknown): x is Theme {
  return typeof x === 'string' && THEME_IDS.has(x as Theme);
}

/** Read the stored preference, falling back to DEFAULT_THEME. */
export function getStoredTheme(): Theme {
  try {
    const chosen = localStorage.getItem(CHOSEN_KEY) === '1';
    if (!chosen) return DEFAULT_THEME;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (isTheme(raw)) return raw;
    if (typeof raw === 'string' && raw in LEGACY_THEME_ALIASES) {
      return LEGACY_THEME_ALIASES[raw];
    }
    return DEFAULT_THEME;
  } catch {
    // localStorage disabled / unavailable — default gracefully.
    return DEFAULT_THEME;
  }
}

/**
 * Set data-theme on <html>. Callable outside React — main.tsx invokes
 * this pre-render to eliminate the default→chosen-theme flash on
 * startup. Does NOT persist: use chooseTheme() for user-initiated
 * changes, otherwise we'd overwrite the user's pick with the default
 * on every boot.
 */
export function applyTheme(theme: Theme): Theme {
  const next = isTheme(theme) ? theme : DEFAULT_THEME;
  document.documentElement.dataset.theme = next;
  return next;
}

/**
 * User picks a theme. Sets the chosen flag (so the pick survives
 * future boots even when DEFAULT_THEME changes), persists the value,
 * and applies it.
 */
export function chooseTheme(theme: Theme): Theme {
  const next = applyTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, next);
    localStorage.setItem(CHOSEN_KEY, '1');
  } catch {
    // Persistence failed — palette still applied for this session.
  }
  return next;
}

/**
 * React hook: returns [theme, setTheme]. setTheme updates the DOM
 * (via applyTheme) and the hook's local state in one step so any
 * dependent UI (active swatch highlight, current-palette label)
 * rerenders immediately.
 */
export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => {
    // Read whatever main.tsx wrote to <html> before React mounted;
    // falls back to storage / default if called outside that flow.
    const current = document.documentElement.dataset.theme;
    return isTheme(current) ? current : getStoredTheme();
  });

  // Keep local state in sync if <html data-theme> is changed by some
  // other actor (e.g. devtools, a keyboard shortcut, another tab via
  // the `storage` event). This is defensive — it makes the hook safe
  // to use from multiple components without them racing.
  useEffect(() => {
    const obs = new MutationObserver(() => {
      const next = document.documentElement.dataset.theme;
      if (isTheme(next) && next !== theme) setThemeState(next);
    });
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && isTheme(e.newValue)) {
        applyTheme(e.newValue);
        setThemeState(e.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      obs.disconnect();
      window.removeEventListener('storage', onStorage);
    };
  }, [theme]);

  const setTheme = (next: Theme) => {
    const applied = chooseTheme(next);
    setThemeState(applied);
  };

  return [theme, setTheme];
}
