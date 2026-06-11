// fm-b5at.6 — TypeBuild side-by-side layout preferences.
//
// Two knobs: the Chrome (left) split percentage and whether to auto-enter
// side-by-side when a TypeBuild interactive session starts. Persisted in
// localStorage as a small self-contained pref (like fm.permissionsPrimed),
// rather than threaded through the main `fm-state-v1` reducer — this keeps
// the plugin's settings local to the plugin and avoids touching the core
// store's persist machinery.
//
// The auto-on-task-start default is ON: the bead specifies side-by-side
// should kick in for TypeBuild sessions by default (the human-gated submit
// is the whole reason to watch Chrome). App.tsx still gates the *Chrome*
// move on the capability probe — when arranging is unsupported it falls back
// to own-window-only, so "auto ON" stays useful even in degraded mode.

const KEY = 'fm.sideBySide.v1';

export type SideBySidePrefs = {
  splitPct: number; // Chrome (left) width as a percentage of the work area
  autoOnTaskStart: boolean;
};

const DEFAULTS: SideBySidePrefs = {
  splitPct: 67,
  autoOnTaskStart: true,
};

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return DEFAULTS.splitPct;
  return Math.min(85, Math.max(30, Math.round(n)));
}

export function loadSideBySidePrefs(): SideBySidePrefs {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<SideBySidePrefs>;
    return {
      splitPct: clampPct(parsed.splitPct ?? DEFAULTS.splitPct),
      autoOnTaskStart:
        typeof parsed.autoOnTaskStart === 'boolean'
          ? parsed.autoOnTaskStart
          : DEFAULTS.autoOnTaskStart,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSideBySidePrefs(prefs: SideBySidePrefs): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        splitPct: clampPct(prefs.splitPct),
        autoOnTaskStart: !!prefs.autoOnTaskStart,
      }),
    );
  } catch {
    /* ignore quota / unavailable storage */
  }
}

// Chrome split as a 0..1 fraction for the main-process API.
export function splitFraction(prefs: SideBySidePrefs): number {
  return clampPct(prefs.splitPct) / 100;
}
