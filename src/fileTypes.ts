// fm-o5z8 — file-type registry: which extensions open in Breeze's in-app
// editor vs. the OS default app.
//
// Single source of truth. All the editable-test call sites (useKeyboard,
// App, ChipPrompt, EditShell, store.openPath) and the Settings → Editor
// section import from here, so there is exactly one editable-extension set.
//
// Persistence mirrors sideBySidePrefs.ts: a small self-contained localStorage
// pref rather than threading through the core `fm-state-v1` reducer. The pure
// helpers (normalizeExt / isEditable / extOf / DEFAULT_EDITABLE_EXTS) live in
// fileTypes.mjs so the node test runner can import them without a transpile.

import {
  DEFAULT_EDITABLE_EXTS,
  normalizeExt,
  isEditable,
  extOf,
} from './fileTypes.mjs';

export { DEFAULT_EDITABLE_EXTS, normalizeExt, isEditable, extOf };

const KEY = 'fm.editableExts.v1';

/** In-memory cache of the current editable set, lazily hydrated from storage. */
let cache: Set<string> | null = null;

type Listener = (exts: Set<string>) => void;
const listeners = new Set<Listener>();

function readStorage(): Set<string> {
  if (typeof localStorage === 'undefined') {
    return new Set(DEFAULT_EDITABLE_EXTS);
  }
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set(DEFAULT_EDITABLE_EXTS);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(DEFAULT_EDITABLE_EXTS);
    const norm = parsed
      .map((e) => normalizeExt(String(e)))
      .filter((e) => e.length > 0);
    // An explicitly-saved empty list is a legitimate "nothing is editable"
    // choice — honor it rather than falling back to defaults.
    return new Set(norm);
  } catch {
    return new Set(DEFAULT_EDITABLE_EXTS);
  }
}

function writeStorage(exts: Set<string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify([...exts].sort()));
  } catch {
    /* ignore quota / unavailable storage */
  }
}

/** The user's current editable-extension set (sorted copy). */
export function getEditableExts(): Set<string> {
  if (!cache) cache = readStorage();
  return new Set(cache);
}

/** Stateful editability test against the user's current set. */
export function isEditableExt(ext: string): boolean {
  if (!cache) cache = readStorage();
  return isEditable(ext, cache);
}

/** Stateful editability test for a full path/name. */
export function isEditablePath(pathOrName: string): boolean {
  return isEditableExt(extOf(pathOrName));
}

function commit(next: Set<string>): void {
  cache = next;
  writeStorage(next);
  for (const fn of listeners) {
    try {
      fn(new Set(next));
    } catch {
      /* a bad listener must not break others */
    }
  }
}

/** Add an extension to the editable set. No-op if already present. */
export function addEditableExt(ext: string): void {
  const norm = normalizeExt(ext);
  if (!norm) return;
  const next = getEditableExts();
  if (next.has(norm)) return;
  next.add(norm);
  commit(next);
}

/** Remove an extension from the editable set. */
export function removeEditableExt(ext: string): void {
  const norm = normalizeExt(ext);
  if (!norm) return;
  const next = getEditableExts();
  if (!next.delete(norm)) return;
  commit(next);
}

/** Restore the editable set to the shipped defaults. */
export function resetEditableExts(): void {
  commit(new Set(DEFAULT_EDITABLE_EXTS));
}

/**
 * Subscribe to editable-set changes. Returns an unsubscribe fn. Used by the
 * Settings → Editor section to stay live without a full store round-trip.
 */
export function subscribeEditableExts(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
