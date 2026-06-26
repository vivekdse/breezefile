// fm-v3p — pure launcher-visibility helpers for the task action zone.
//
// Runtime is plain ESM so the node test runner can import it without a
// transpile step (same pattern as fileTypes.mjs / tagDsl.mjs). The stateful
// localStorage layer + React-facing API lives in launcherPrefs.ts, which
// re-exports these.
//
// Data model (renderer-side override; never touches the main-process launcher
// defs):
//   - hidden:    array of launcher ids the user has toggled OFF. Absent/empty
//                means "everything visible" — the additive, no-surprise default.
//   - defaultId: a single launcher id surfaced as the PRIMARY action in the
//                task action zone, or null/absent for "no forced default"
//                (preserve the existing flat order). Chosen over a per-launcher
//                `default?` boolean so exactly one launcher can ever be the
//                default — the type makes the invariant true.
//
// `applyLauncherPrefs(launchers, prefs)` is PURE: it takes the prefs explicitly
// and returns { visible, defaultId } where `visible` is the filtered list with
// the resolved default moved to the front. The stateful wrapper that reads the
// user's saved prefs lives in launcherPrefs.ts.

/**
 * @typedef {Object} LauncherPrefs
 * @property {string[]} [hidden]    launcher ids toggled off (default: none)
 * @property {string|null} [defaultId]  the default launcher id (default: null)
 */

/** Empty prefs: nothing hidden, no forced default. */
export const EMPTY_LAUNCHER_PREFS = { hidden: [], defaultId: null };

/**
 * Is a launcher hidden under these prefs?
 * @param {string} id
 * @param {LauncherPrefs} [prefs]
 * @returns {boolean}
 */
export function isLauncherHidden(id, prefs) {
  const hidden = prefs?.hidden;
  if (!Array.isArray(hidden)) return false;
  return hidden.includes(id);
}

/**
 * Resolve the effective default launcher id for a given launcher list + prefs.
 * Returns the saved defaultId only when it points at a launcher that is both
 * present AND visible; otherwise null. This keeps a stale or hidden default
 * from silently winning.
 * @param {Array<{id:string}>} launchers
 * @param {LauncherPrefs} [prefs]
 * @returns {string|null}
 */
export function resolveDefaultLauncherId(launchers, prefs) {
  const wanted = prefs?.defaultId ?? null;
  if (!wanted) return null;
  const hit = (launchers ?? []).some(
    (l) => l && l.id === wanted && !isLauncherHidden(l.id, prefs),
  );
  return hit ? wanted : null;
}

/**
 * PURE. Apply visibility + default prefs to a launcher list.
 *
 * Returns the launchers that should appear in the task action zone, with the
 * resolved default (if any) moved to the front so the action zone can render it
 * as the primary action and the rest as secondary/overflow. Input order is
 * otherwise preserved. When no prefs are set, this is the identity over the
 * input list with defaultId === null — i.e. existing behavior is untouched.
 *
 * @template {{id:string}} L
 * @param {L[]} launchers
 * @param {LauncherPrefs} [prefs]
 * @returns {{ visible: L[], defaultId: string|null }}
 */
export function applyLauncherPrefs(launchers, prefs) {
  const list = Array.isArray(launchers) ? launchers : [];
  const visible = list.filter((l) => l && !isLauncherHidden(l.id, prefs));
  const defaultId = resolveDefaultLauncherId(visible, prefs);
  if (!defaultId) return { visible, defaultId: null };
  const primary = visible.filter((l) => l.id === defaultId);
  const rest = visible.filter((l) => l.id !== defaultId);
  return { visible: [...primary, ...rest], defaultId };
}
