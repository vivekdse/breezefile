// fm-v3p — type surface for the pure launcherPrefs.mjs helpers.

export type LauncherPrefs = {
  hidden?: string[];
  defaultId?: string | null;
};

/** Empty prefs: nothing hidden, no forced default. */
export const EMPTY_LAUNCHER_PREFS: { hidden: string[]; defaultId: null };

/** Is a launcher hidden under these prefs? */
export function isLauncherHidden(id: string, prefs?: LauncherPrefs): boolean;

/** The effective default launcher id (present + visible), or null. */
export function resolveDefaultLauncherId(
  launchers: ReadonlyArray<{ id: string }>,
  prefs?: LauncherPrefs,
): string | null;

/**
 * PURE. Filter to visible launchers and move the resolved default to the front.
 */
export function applyLauncherPrefs<L extends { id: string }>(
  launchers: L[],
  prefs?: LauncherPrefs,
): { visible: L[]; defaultId: string | null };
