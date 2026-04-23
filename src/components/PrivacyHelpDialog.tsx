/*
 * PrivacyHelpDialog — per-folder permission status + grant trigger.
 *
 * Opened by the `:privacy` / `:permissions` verb. Shows whether Breeze has
 * been granted access to each TCC-protected location, and re-runs the
 * prime flow so missing grants prompt the user right now instead of
 * punting them to System Settings.
 *
 * macOS TCC rule that shapes this UI: a folder that was denied once will
 * NOT re-prompt — it can only be flipped in System Settings. So the
 * "Open System Settings" fallback only appears if something is denied.
 */

import { useCallback, useEffect, useState } from 'react';
import { fm } from '../bridge';
import { useOverlayExit } from '../useOverlayExit';
import './PrivacyHelpDialog.css';

type Status = 'granted' | 'denied' | 'missing' | 'checking';

const FOLDERS: Array<{ key: string; name: string; path: string }> = [
  { key: 'desktop', name: 'Desktop', path: '~/Desktop' },
  { key: 'documents', name: 'Documents', path: '~/Documents' },
  { key: 'downloads', name: 'Downloads', path: '~/Downloads' },
  { key: 'icloud', name: 'iCloud Drive', path: '~/Library/Mobile Documents' },
];

function statusLabel(s: Status): string {
  switch (s) {
    case 'granted': return 'Allowed';
    case 'denied': return 'Denied';
    case 'missing': return 'Not present';
    case 'checking': return 'Checking…';
  }
}

export function PrivacyHelpDialog({ onClose }: { onClose: () => void }) {
  const { exit, state } = useOverlayExit(onClose);
  const [statuses, setStatuses] = useState<Record<string, Status>>(() =>
    Object.fromEntries(FOLDERS.map((f) => [f.key, 'checking'])),
  );
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fm.primePermissions();
      const next: Record<string, Status> = {};
      for (const f of FOLDERS) {
        next[f.key] = (res[f.key] as Status) ?? 'denied';
      }
      setStatuses(next);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        exit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exit]);

  async function openSettings() {
    await fm.openPrivacyPane('files');
  }

  const hasDenied = FOLDERS.some((f) => statuses[f.key] === 'denied');
  const allGranted = FOLDERS.every(
    (f) => statuses[f.key] === 'granted' || statuses[f.key] === 'missing',
  );

  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div
        className="privacy-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="privacy-help-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="privacy-help__close"
          onClick={exit}
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>
        <div className="privacy-help__eyebrow">Privacy</div>
        <h2 id="privacy-help-title" className="privacy-help__title">
          {allGranted ? 'All set. Your files stay yours.' : 'Folder access'}
        </h2>
        <p className="privacy-help__lede">
          Breeze File runs locally. macOS asks once per protected folder.
          Anywhere else in your home folder opens without a prompt.
        </p>

        <ul className="privacy-help__dirs">
          {FOLDERS.map((f) => {
            const s = statuses[f.key];
            return (
              <li key={f.key} data-status={s}>
                <span className="privacy-help__dir-name">{f.name}</span>
                <span className="privacy-help__dir-path">{f.path}</span>
                <span className={`privacy-help__badge privacy-help__badge--${s}`}>
                  {statusLabel(s)}
                </span>
              </li>
            );
          })}
        </ul>

        {hasDenied && (
          <p className="privacy-help__note">
            Denied folders can only be re-enabled in{' '}
            <em>System Settings → Privacy &amp; Security → Files and Folders</em>.
            macOS won't re-prompt once a permission has been refused.
          </p>
        )}

        <div className="privacy-help__actions">
          {hasDenied && (
            <button
              type="button"
              className="privacy-help__btn"
              onClick={openSettings}
              title="Open macOS Privacy & Security settings"
            >
              Open System Settings
            </button>
          )}
          <button
            type="button"
            className="privacy-help__btn"
            onClick={() => void check()}
            disabled={busy}
            title="Re-run the permission check; prompts for anything not yet decided"
          >
            {busy ? 'Checking…' : 'Re-check'}
          </button>
          <button
            type="button"
            className="privacy-help__btn privacy-help__btn--primary"
            onClick={exit}
            autoFocus
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
