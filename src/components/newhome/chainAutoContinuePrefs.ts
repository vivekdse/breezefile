// task-6a14190fb2f7 — per-job "auto-continue" preference: when ON, the roster
// automatically starts a chained job's next runnable step as soon as the
// previous one completes, instead of only surfacing a "ready ▶" chip for a
// human to click. DEFAULT ON for agent-run chains (this file just stores the
// bool; RosterTable gates the actual auto-start on "is this an agent-run
// chain" — see its chainAutoContinueEligible check — so a human-run chain is
// never force-advanced even if this pref were somehow flipped on for it).
//
// Persisted in localStorage exactly like sideBySidePrefs.ts (a small
// self-contained UI pref, not threaded through the core fm-state-v1 reducer).
// Keyed per JOB id (not global) so a human can opt one noisy/sensitive chain
// out without turning auto-continue off everywhere else.

const KEY_PREFIX = 'fm.newhome.chainAutoContinue.v1.';

/** Read this job's auto-continue preference. Defaults to `true` (ON) when
 *  never explicitly set — matches the task's "DEFAULT ON for agent-run
 *  chains" requirement. */
export function isAutoContinueOn(jobId: string): boolean {
  if (typeof localStorage === 'undefined') return true;
  try {
    const raw = localStorage.getItem(KEY_PREFIX + jobId);
    if (raw === null) return true;
    return raw === '1';
  } catch {
    return true;
  }
}

/** Explicitly set (or clear back to the default) this job's preference. */
export function setAutoContinue(jobId: string, on: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY_PREFIX + jobId, on ? '1' : '0');
  } catch {
    /* ignore quota / unavailable storage */
  }
}
