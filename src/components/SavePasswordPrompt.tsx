/*
 * SavePasswordPrompt — Chrome-style "Save password for <user>@<origin>?" banner
 * (task-ad89064bf45f). Shown when the embedded browser captures a login submit
 * (browser:credential-captured, task-1188c6535e91).
 *
 * It renders as REAL DOM in the browser toolbar region, NOT over the page: the
 * embedded page is a native WebContentsView that floats above the React DOM, so
 * an overlay painted "on top of the page" would be hidden behind it. Anchoring
 * the banner in the toolbar (which sits above the native view) keeps it visible,
 * exactly like Chrome anchors its prompt under the omnibox.
 *
 * SECURITY: the captured password lives ONLY in this trusted-UI component's
 * transient props/state. It is shown masked by default (an eye toggle reveals it
 * for the user to confirm), and is DROPPED when the prompt is dismissed or the
 * component unmounts. It is never logged, persisted, or sent anywhere until the
 * user clicks Save — at which point the parent's onSave hands it to the persist
 * path (the site-keyed credential vault, task-d60860fb4d7f).
 */

import { useEffect, useState } from 'react';
import './SavePasswordPrompt.css';

export interface CapturedCredential {
  id: number;
  origin: string;
  username: string;
  password: string;
}

export function SavePasswordPrompt({
  cred,
  mode = 'save',
  onSave,
  onDismiss,
  onNever,
}: {
  cred: CapturedCredential;
  /** task-e550e3a1f512 — 'save' for a brand-new login; 'update' when a saved
   *  password already exists for this {origin, username} but the captured one
   *  differs (the headline + primary button read "Update"). */
  mode?: 'save' | 'update';
  /** Persist the credential (origin, username, password). May reject; the prompt
   *  surfaces the error and stays open so the user can retry or dismiss. */
  onSave: (cred: CapturedCredential) => Promise<void>;
  /** Close without saving — the parent drops the password. */
  onDismiss: () => void;
  /** Never offer to save for this origin — the parent records the opt-out and
   *  drops the password. */
  onNever: (origin: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // task-e550e3a1f512 — auto-dismiss after 30s so an ignored banner doesn't
  // linger forever (the parent drops the password on dismiss). Cleared if the
  // user starts interacting (saving) or the component unmounts.
  useEffect(() => {
    if (saving) return;
    const t = setTimeout(onDismiss, 30_000);
    return () => clearTimeout(t);
  }, [saving, onDismiss]);

  // A friendly host label for the headline (strip the scheme); fall back to the
  // raw origin if it doesn't parse.
  let host = cred.origin;
  try {
    host = new URL(cred.origin).host || cred.origin;
  } catch {
    /* keep raw origin */
  }
  const who = cred.username ? `${cred.username} on ${host}` : host;

  async function save() {
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      await onSave(cred);
      // Parent clears the prompt on success.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save password.');
      setSaving(false);
    }
  }

  return (
    <div className="save-pw" role="dialog" aria-label="Save password">
      <div className="save-pw__head">
        <span className="save-pw__key" aria-hidden="true">
          🔑
        </span>
        <span className="save-pw__title">
          {mode === 'update' ? 'Update password for' : 'Save password for'} {who}?
        </span>
      </div>

      <div className="save-pw__creds">
        <span className="save-pw__user" title={cred.username}>
          {cred.username || <em className="save-pw__nouser">(no username)</em>}
        </span>
        <span className="save-pw__pw">
          <code className="save-pw__pwval">
            {revealed ? cred.password : '••••••••'}
          </code>
          <button
            type="button"
            className="save-pw__eye"
            onClick={() => setRevealed((r) => !r)}
            aria-pressed={revealed}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            title={revealed ? 'Hide' : 'Show'}
          >
            {revealed ? '🙈' : '👁'}
          </button>
        </span>
      </div>

      {error && (
        <p className="save-pw__error" role="alert">
          {error}
        </p>
      )}

      <div className="save-pw__actions">
        <button
          type="button"
          className="save-pw__btn save-pw__btn--primary"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? 'Saving…' : mode === 'update' ? 'Update' : 'Save'}
        </button>
        <button
          type="button"
          className="save-pw__btn"
          onClick={onDismiss}
          disabled={saving}
        >
          Not now
        </button>
        <button
          type="button"
          className="save-pw__btn save-pw__btn--ghost"
          onClick={() => onNever(cred.origin)}
          disabled={saving}
          title={`Never save passwords for ${host}`}
        >
          Never for this site
        </button>
      </div>
    </div>
  );
}
