/*
 * SecretsPanel — the user's credential vault (their OWN identifiers).
 *
 * Opened by the `:secrets` verb. Manages the keys the user stores about
 * THEMSELVES — NPI, practice Tax ID, portal login IDs — NOT patient PHI.
 *
 * The renderer reaches the vault through `fm.typebuild.vault`:
 *   - list()          → key names only (never values)
 *   - reveal(ref)     → ONE decrypted value, on explicit user action
 *   - set(key, value) → create/replace; returns the canonical ref written
 *   - remove(ref)     → delete (idempotent)
 *
 * Privacy rules baked into this UI: values are revealed one at a time, on an
 * explicit click, and re-masked on a second click / blur / close. Revealed
 * values live ONLY in transient component state and are cleared on re-mask
 * and unmount — they are never written anywhere persistent.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fm } from '../bridge';
import type { VaultEntry } from '../bridge';
import { useOverlayExit } from '../useOverlayExit';
import './SecretsPanel.css';

const MASK = '••••••••';

export function SecretsPanel({ onClose }: { onClose: () => void }) {
  const { exit, state } = useOverlayExit(onClose);

  const [keys, setKeys] = useState<VaultEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Which ref is currently revealed, and its transient decrypted value.
  // Only ever holds ONE value at a time, and is cleared on re-mask/close.
  const [revealedRef, setRevealedRef] = useState<string | null>(null);
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [revealing, setRevealing] = useState<string | null>(null);

  // Inline delete confirmation: which ref is awaiting "Delete me.npi?".
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  // Create form.
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Drop any revealed plaintext from memory.
  const remask = useCallback(() => {
    setRevealedRef(null);
    setRevealedValue(null);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await fm.typebuild.vault.list();
      setKeys([...list].sort((a, b) => a.key.localeCompare(b.key)));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load secrets.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Clear any revealed plaintext when the component unmounts.
  useEffect(() => () => remask(), [remask]);

  // Escape closes; close re-masks first (handled by unmount cleanup too).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        remask();
        exit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exit, remask]);

  function close() {
    remask();
    exit();
  }

  async function toggleReveal(ref: string) {
    if (revealedRef === ref) {
      remask();
      return;
    }
    // Switching reveal target — drop the previous plaintext immediately.
    remask();
    setRevealing(ref);
    try {
      const value = await fm.typebuild.vault.reveal(ref);
      setRevealedRef(ref);
      setRevealedValue(value);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : `Could not reveal ${ref}.`,
      );
    } finally {
      setRevealing(null);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setFormError(null);
    const key = newKey.trim();
    const value = newValue;
    if (!key) {
      setFormError('Enter a key, e.g. npi.');
      return;
    }
    if (!value) {
      setFormError('Enter a value to store.');
      return;
    }
    setSaving(true);
    try {
      await fm.typebuild.vault.set(key, value);
      setNewKey('');
      setNewValue('');
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save secret.');
    } finally {
      setSaving(false);
    }
  }

  async function confirmRemove(ref: string) {
    try {
      if (revealedRef === ref) remask();
      await fm.typebuild.vault.remove(ref);
      setConfirmingDelete(null);
      await refresh();
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : `Could not delete ${ref}.`,
      );
    }
  }

  return (
    <div className="overlay" data-state={state} onClick={close}>
      <div
        ref={dialogRef}
        className="secrets-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="secrets-panel__title"
        onClick={(e) => e.stopPropagation()}
        // Re-mask when focus leaves the panel entirely (click-away within the
        // overlay, tab out, etc.). relatedTarget null/outside => panel blur.
        onBlur={(e) => {
          const next = e.relatedTarget as Node | null;
          if (!next || !e.currentTarget.contains(next)) remask();
        }}
      >
        <button
          type="button"
          className="secrets-panel__close"
          onClick={close}
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>

        <div className="secrets-panel__eyebrow">Vault</div>
        <h2 id="secrets-panel__title" className="secrets-panel__title">
          Your secrets
        </h2>
        <p className="secrets-panel__lede">
          Your own identifiers — NPI, practice Tax ID, portal login IDs. Not
          patient data.
        </p>

        {loadError && (
          <p className="secrets-panel__error" role="alert">
            {loadError}
          </p>
        )}

        {loading ? (
          <p className="secrets-panel__status" aria-live="polite">
            Loading…
          </p>
        ) : keys.length === 0 ? (
          <p className="secrets-panel__empty">
            No secrets yet — add your NPI, Tax ID, or login IDs below.
          </p>
        ) : (
          <ul className="secrets-panel__list">
            {keys.map(({ key: ref, secret }) => {
              const isRevealed = revealedRef === ref;
              const isRevealing = revealing === ref;
              const isConfirming = confirmingDelete === ref;
              return (
                <li key={ref} className="secrets-panel__row">
                  <span className="secrets-panel__key" title={ref}>
                    {ref}
                  </span>
                  <span
                    className="secrets-panel__value"
                    aria-live="polite"
                    data-revealed={isRevealed ? 'true' : 'false'}
                  >
                    {secret ? (
                      // Write-only field: the server refuses to reveal it, so we
                      // never even attempt a reveal — show a short note instead.
                      <span className="secrets-panel__writeonly">
                        {MASK}
                        <span className="secrets-panel__writeonly-note">
                          {' '}
                          write-only (cannot be shown)
                        </span>
                      </span>
                    ) : isRevealed ? (
                      <code className="secrets-panel__plain">
                        {revealedValue}
                      </code>
                    ) : (
                      <span className="secrets-panel__mask" aria-hidden="true">
                        {MASK}
                      </span>
                    )}
                  </span>

                  {secret ? (
                    // No reveal toggle for write-only fields — keep the column
                    // aligned with a disabled, labelled placeholder.
                    <button
                      type="button"
                      className="secrets-panel__icon"
                      disabled
                      aria-disabled="true"
                      aria-label={`${ref} is write-only and cannot be revealed`}
                      title="Write-only (cannot be shown)"
                    >
                      🔒
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secrets-panel__icon"
                      onClick={() => void toggleReveal(ref)}
                      disabled={isRevealing}
                      aria-pressed={isRevealed}
                      aria-label={
                        isRevealed ? `Hide value of ${ref}` : `Reveal value of ${ref}`
                      }
                      title={isRevealed ? 'Hide' : 'Reveal'}
                    >
                      {isRevealing ? '…' : isRevealed ? '🙈' : '👁'}
                    </button>
                  )}

                  {isConfirming ? (
                    <span className="secrets-panel__confirm">
                      <span className="secrets-panel__confirm-q">
                        Delete {ref}?
                      </span>
                      <button
                        type="button"
                        className="secrets-panel__btn secrets-panel__btn--danger"
                        onClick={() => void confirmRemove(ref)}
                        aria-label={`Confirm delete ${ref}`}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        className="secrets-panel__btn"
                        onClick={() => setConfirmingDelete(null)}
                        aria-label="Cancel delete"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="secrets-panel__icon secrets-panel__icon--danger"
                      onClick={() => setConfirmingDelete(ref)}
                      aria-label={`Delete ${ref}`}
                      title="Delete"
                    >
                      🗑
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <form className="secrets-panel__form" onSubmit={save}>
          <div className="secrets-panel__form-eyebrow">Add a secret</div>
          <div className="secrets-panel__fields">
            <label className="secrets-panel__field">
              <span className="secrets-panel__field-label">Key</span>
              <input
                className="secrets-panel__input"
                type="text"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="npi"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="secrets-panel__key-help"
              />
            </label>
            <label className="secrets-panel__field secrets-panel__field--value">
              <span className="secrets-panel__field-label">Value</span>
              <input
                className="secrets-panel__input"
                type="password"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="1234567890"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button
              type="submit"
              className="secrets-panel__btn secrets-panel__btn--primary"
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          <p id="secrets-panel__key-help" className="secrets-panel__help">
            stored as <code>me.&lt;key&gt;</code>
          </p>
          {formError && (
            <p className="secrets-panel__error" role="alert">
              {formError}
            </p>
          )}
        </form>

        <p className="secrets-panel__privacy">
          Stored encrypted on TypeBuild, scoped to you. Values never touch this
          machine's disk.
        </p>
      </div>
    </div>
  );
}
