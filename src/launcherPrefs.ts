// fm-v3p — launcher-visibility prefs for the task action zone: which launchers
// show, and which one is the default (primary) action.
//
// Single source of truth, renderer-side. The launcher DEFINITIONS still live in
// main (userData/launchers.json, surfaced via fm.launchersList()); these prefs
// are a thin per-launcher OVERRIDE layered on top at render time. Keeping them
// renderer-side (localStorage) is the lower-risk choice — main never has to
// learn about visibility, and an empty pref set means "behave exactly as
// before."
//
// Persistence mirrors fileTypes.ts / sideBySidePrefs.ts: a small self-contained
// localStorage pref rather than threading through the core `fm-state-v1`
// reducer. The pure helpers (applyLauncherPrefs / isLauncherHidden /
// resolveDefaultLauncherId) live in launcherPrefs.mjs so the node test runner
// can import them without a transpile.

import {
  EMPTY_LAUNCHER_PREFS,
  applyLauncherPrefs,
  isLauncherHidden,
  resolveDefaultLauncherId,
} from './launcherPrefs.mjs';

export {
  EMPTY_LAUNCHER_PREFS,
  applyLauncherPrefs,
  isLauncherHidden,
  resolveDefaultLauncherId,
};

export type LauncherPrefs = {
  /** Launcher ids the user has toggled off. Absent/empty = all visible. */
  hidden: string[];
  /** The default (primary) launcher id, or null for no forced default. */
  defaultId: string | null;
};

const KEY = 'fm.launcherPrefs.v1';

/** In-memory cache, lazily hydrated from storage. */
let cache: LauncherPrefs | null = null;

type Listener = (prefs: LauncherPrefs) => void;
const listeners = new Set<Listener>();

function emptyPrefs(): LauncherPrefs {
  return { hidden: [], defaultId: null };
}

function readStorage(): LauncherPrefs {
  if (typeof localStorage === 'undefined') return emptyPrefs();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyPrefs();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyPrefs();
    const hidden = Array.isArray(parsed.hidden)
      ? parsed.hidden.map((x: unknown) => String(x)).filter((s: string) => s.length > 0)
      : [];
    const defaultId =
      typeof parsed.defaultId === 'string' && parsed.defaultId.length > 0
        ? parsed.defaultId
        : null;
    return { hidden, defaultId };
  } catch {
    return emptyPrefs();
  }
}

function writeStorage(prefs: LauncherPrefs): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* ignore quota / unavailable storage */
  }
}

/** The user's current launcher prefs (fresh copy). */
export function getLauncherPrefs(): LauncherPrefs {
  if (!cache) cache = readStorage();
  return { hidden: [...cache.hidden], defaultId: cache.defaultId };
}

function commit(next: LauncherPrefs): void {
  cache = next;
  writeStorage(next);
  for (const fn of listeners) {
    try {
      fn(getLauncherPrefs());
    } catch {
      /* a bad listener must not break others */
    }
  }
}

/** Show or hide a launcher in the task action zone. */
export function setLauncherHidden(id: string, hidden: boolean): void {
  if (!id) return;
  const prefs = getLauncherPrefs();
  const has = prefs.hidden.includes(id);
  if (hidden && has) return;
  if (!hidden && !has) return;
  const nextHidden = hidden
    ? [...prefs.hidden, id]
    : prefs.hidden.filter((x) => x !== id);
  // Hiding the current default clears it — a hidden launcher can't be primary.
  const defaultId = hidden && prefs.defaultId === id ? null : prefs.defaultId;
  commit({ hidden: nextHidden, defaultId });
}

/**
 * Set (or clear, with null) the default launcher. Setting a hidden launcher as
 * default un-hides it — you can't have a hidden primary action.
 */
export function setDefaultLauncherId(id: string | null): void {
  const prefs = getLauncherPrefs();
  if (!id) {
    if (prefs.defaultId === null) return;
    commit({ hidden: prefs.hidden, defaultId: null });
    return;
  }
  const nextHidden = prefs.hidden.filter((x) => x !== id);
  commit({ hidden: nextHidden, defaultId: id });
}

/** Clear all launcher prefs: everything visible, no forced default. */
export function resetLauncherPrefs(): void {
  commit(emptyPrefs());
}

/**
 * Subscribe to launcher-pref changes. Returns an unsubscribe fn. Lets the
 * Settings section and the task action zone stay live without a store
 * round-trip (same shape as subscribeEditableExts).
 */
export function subscribeLauncherPrefs(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
