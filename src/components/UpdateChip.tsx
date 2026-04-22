/*
 * UpdateChip — non-intrusive "update available" notification.
 *
 * Polls the GitHub Releases API on mount + every 24 hours via the
 * `fm.checkUpdate` IPC (CSP blocks direct external fetch from the
 * renderer; see electron/ipc.ts → 'app:checkUpdate'). When the latest
 * release tag is newer than the running app version, surfaces a small
 * pill in the bottom-left:
 *
 *   ↑  Update v0.1.2 available  brew upgrade --cask breezefile  ×
 *
 * Click the version → opens the release page in the browser.
 * Click the brew command → copies it to the clipboard.
 * Click ×    → dismisses for that specific version (a future, even
 *              newer release will still surface).
 */

import { useEffect, useState } from 'react';
import { fm } from '../bridge';
import './UpdateChip.css';

declare const __APP_VERSION__: string;

const STORAGE_KEY = 'fm.updateDismissed';
const RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h
const BREW_CMD = 'brew upgrade --cask breezefile';

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
  const [copied, setCopied] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  });

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
  if (dismissedVersion === latest.version) return null;

  function dismiss() {
    if (!latest) return;
    try {
      localStorage.setItem(STORAGE_KEY, latest.version);
    } catch {
      /* noop */
    }
    setDismissedVersion(latest.version);
  }

  async function copyBrewCmd() {
    try {
      await navigator.clipboard.writeText(BREW_CMD);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard API may be denied — fall through silently.
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
        className={['update-chip__cmd', copied && 'update-chip__cmd--copied'].filter(Boolean).join(' ')}
        onClick={copyBrewCmd}
        title="Copy upgrade command"
      >
        <code>{BREW_CMD}</code>
        <span className="update-chip__copy-hint">{copied ? 'copied' : 'copy'}</span>
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
