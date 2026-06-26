// fm-m7q — recency of verbs run from the Cmd-K command palette.
//
// A small most-recently-used list of verb ids, persisted in localStorage (the
// same self-contained-pref pattern as projectsViewPrefs / launcherPrefs). The
// palette reads it to bias ordering so the actions you reach for surface first;
// it's recorded only when a verb is launched FROM the palette, so the typed
// ':' picker stays unaffected.

const KEY = 'fm.verbRecency.v1';
const CAP = 12;

export function loadVerbRecency(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, CAP);
  } catch {
    return [];
  }
}

/** Record a verb as just-used; returns the new MRU list (most-recent first). */
export function recordVerbUse(id: string): string[] {
  const cur = loadVerbRecency().filter((x) => x !== id);
  const next = [id, ...cur].slice(0, CAP);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore quota / unavailable storage */
    }
  }
  return next;
}
