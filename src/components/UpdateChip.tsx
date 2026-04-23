/*
 * UpdateChip — non-intrusive "update available" notification.
 *
 * Polls the GitHub Releases API on mount + every 24 hours via the
 * `fm.checkUpdate` IPC (CSP blocks direct external fetch from the
 * renderer; see electron/ipc.ts → 'app:checkUpdate'). When a newer
 * release tag is found, surfaces a pill in the bottom-left with an
 * "Update now" button that hands off to `fm.upgrade()` — brew in-place
 * when available, Terminal.app fallback otherwise. The app quits after
 * the handoff so brew can replace the .app bundle; the spawned shell
 * relaunches Breeze File on success.
 *
 * Click the version → opens the release page in the browser.
 * Click ×    → dismisses for that specific version (a future, even
 *              newer release will still surface).
 */

import { useEffect, useState } from 'react';
import { fm } from '../bridge';
import './UpdateChip.css';

declare const __APP_VERSION__: string;

const STORAGE_KEY = 'fm.updateDismissed';
const RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h
// Dismiss is intentionally non-permanent: if the user still hasn't upgraded
// after a week, resurface the chip. The `:upgrade` verb is the permanent
// escape hatch for users who want to run it on demand instead.
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type Dismissal = { version: string; until: number };

function readDismissal(): Dismissal | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Dismissal>;
    if (typeof parsed.version === 'string' && typeof parsed.until === 'number') {
      return { version: parsed.version, until: parsed.until };
    }
    return null;
  } catch {
    // Legacy plain-string format or malformed JSON — treat as not dismissed
    // so the user gets a fresh nudge. Worst case: one extra chip impression.
    return null;
  }
}

type LatestRelease = {
  tag: string;
  version: string;
  url: string;
};

/** Compare semver-ish strings: returns >0 if a > b, <0 if a < b, 0 if equal.
 *  Tolerates prerelease suffixes ("0.1.2-beta") by ignoring them. */
function cmpVersion(a: string, b: string): number {
  const norm = (v: string) =>
    v.replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const A = norm(a);
  const B = norm(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const da = A[i] ?? 0;
    const db = B[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export function UpdateChip() {
  const [latest, setLatest] = useState<LatestRelease | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [dismissal, setDismissal] = useState<Dismissal | null>(() => readDismissal());

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const r = await fm.checkUpdate();
        if (cancelled || !r) return;
        if (cmpVersion(r.version, __APP_VERSION__) > 0) {
          setLatest({ tag: r.tag, version: r.version, url: r.url });
        }
      } catch {
        // Network blip — try again at next interval.
      }
    }
    void check();
    const id = window.setInterval(check, RECHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (!latest) return null;
  if (
    dismissal &&
    dismissal.version === latest.version &&
    dismissal.until > Date.now()
  ) {
    return null;
  }

  function dismiss() {
    if (!latest) return;
    const next: Dismissal = {
      version: latest.version,
      until: Date.now() + DISMISS_TTL_MS,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* noop */
    }
    setDismissal(next);
  }

  async function runUpgrade() {
    if (upgrading) return;
    setUpgrading(true);
    try {
      await fm.upgrade();
      // On success the main process quits ~600ms later and the spawned
      // shell relaunches the app. Nothing more to do here.
    } catch {
      setUpgrading(false);
    }
  }

  return (
    <div className="update-chip" role="status" aria-label={`Version ${latest.version} available`}>
      <span className="update-chip__icon" aria-hidden>↑</span>
      <button
        type="button"
        className="update-chip__version"
        onClick={() => void fm.open(latest.url)}
        title="Open release notes"
      >
        Update {latest.tag} available
      </button>
      <button
        type="button"
        className="update-chip__go"
        onClick={runUpgrade}
        disabled={upgrading}
        title="Run brew upgrade and relaunch"
      >
        {upgrading ? 'Upgrading…' : 'Update now'}
      </button>
      <button
        type="button"
        className="update-chip__dismiss"
        onClick={dismiss}
        aria-label="Dismiss for this version"
        title="Dismiss for this version"
      >
        ×
      </button>
    </div>
  );
}
