/*
 * PrivacyHelpDialog — instructional pre-step before deep-linking into
 * macOS System Settings → Privacy & Security.
 *
 * The privacy pane lists ~30 items; first-time users don't know which
 * to tap or what comes next. This dialog walks through it before we
 * hand them off to the OS:
 *
 *   1. Open System Settings → Privacy & Security
 *   2. Scroll to Full Disk Access (or Files and Folders)
 *   3. Click + → pick Breeze File from /Applications → toggle on
 *   4. Restart Breeze File
 *
 * "Open Settings" button fires fm.openPrivacyPane and dismisses.
 */

import { useEffect } from 'react';
import { fm } from '../bridge';
import { useOverlayExit } from '../useOverlayExit';
import './PrivacyHelpDialog.css';

export function PrivacyHelpDialog({ onClose }: { onClose: () => void }) {
  const { exit, state } = useOverlayExit(onClose);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        exit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exit]);

  async function continueToSettings() {
    await fm.openPrivacyPane('files');
    exit();
  }

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
        <div className="privacy-help__eyebrow">Folder access</div>
        <h2 id="privacy-help-title" className="privacy-help__title">
          Granting Full Disk Access
        </h2>
        <p className="privacy-help__lede">
          macOS won't let unsigned apps read your folders without
          permission. Easiest fix: grant Breeze File <em>Full Disk Access</em>
          {' '}once.
        </p>

        <ol className="privacy-help__steps">
          <li>
            <span className="privacy-help__num">1</span>
            <div>Click <strong>Continue</strong> below — System Settings opens to <em>Privacy &amp; Security</em>.</div>
          </li>
          <li>
            <span className="privacy-help__num">2</span>
            <div>Scroll down and click <strong>Full Disk Access</strong>.</div>
          </li>
          <li>
            <span className="privacy-help__num">3</span>
            <div>Click the <strong>+</strong> button at the bottom of the list, then pick <strong>Breeze File</strong> from <code>/Applications</code>.</div>
          </li>
          <li>
            <span className="privacy-help__num">4</span>
            <div>Toggle the switch <strong>on</strong>. macOS may ask you to re-launch Breeze File.</div>
          </li>
        </ol>

        <p className="privacy-help__note">
          Prefer per-folder grants? After step 1, click{' '}
          <strong>Files and Folders</strong> instead and switch on the
          folders you want Breeze File to read.
        </p>

        <div className="privacy-help__actions">
          <button
            type="button"
            className="privacy-help__btn privacy-help__btn--cancel"
            onClick={exit}
          >
            Cancel
          </button>
          <button
            type="button"
            className="privacy-help__btn privacy-help__btn--primary"
            onClick={continueToSettings}
            autoFocus
          >
            Continue to Settings
          </button>
        </div>
      </div>
    </div>
  );
}
