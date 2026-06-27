/*
 * SecretsPanel — the secrets surface (task-2b5725de1fb0). A file-manager-style
 * panel with searchable rows, grouped into two sources:
 *
 *   1. YOUR IDENTITY  — the user's OWN identifiers (NPI, Tax ID, login IDs), the
 *      "me.*" entity fields, via `fm.typebuild.vault`. Reveal one value on the
 *      eye toggle; create/delete; write-only secret fields (ssn/dob/bank) cannot
 *      be revealed.
 *   2. SAVED LOGINS   — site-keyed web logins (origin, username) → password, via
 *      `fm.typebuild.credentials`. Grouped by site/origin. Reveal one password on
 *      the eye toggle (an explicit resolve hop); create/delete.
 *
 * Interaction (ranger-like): a search box filters every row; rows are keyboard-
 * navigable; Enter on a focused row toggles reveal (the row's "edit/open" action).
 *
 * Privacy rules (unchanged + extended): values are revealed ONE at a time, on an
 * explicit click/Enter, and re-masked on a second toggle / blur / close. A
 * revealed value lives ONLY in transient component state and is cleared on
 * re-mask and unmount — never written anywhere persistent, never logged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fm } from '../bridge';
import type { VaultEntry, SavedCredential } from '../bridge';
import { useOverlayExit } from '../useOverlayExit';
import './SecretsPanel.css';

const MASK = '••••••••';

// A revealed value is keyed by a unique row id so only ONE is ever shown.
type RevealKey = string;

function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

export function SecretsPanel({ onClose }: { onClose: () => void }) {
  const { exit, state } = useOverlayExit(onClose);

  // ── Data ──────────────────────────────────────────────────────────────────
  const [identity, setIdentity] = useState<VaultEntry[]>([]);
  const [logins, setLogins] = useState<SavedCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── Reveal (one value at a time) ────────────────────────────────────────────
  const [revealedKey, setRevealedKey] = useState<RevealKey | null>(null);
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [revealing, setRevealing] = useState<RevealKey | null>(null);

  // ── Search + inline confirm ─────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState<RevealKey | null>(null);

  // ── Create forms ────────────────────────────────────────────────────────────
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);

  const [newOrigin, setNewOrigin] = useState('');
  const [newUser, setNewUser] = useState('');
  const [newPass, setNewPass] = useState('');
  const [savingLogin, setSavingLogin] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);

  const remask = useCallback(() => {
    setRevealedKey(null);
    setRevealedValue(null);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [ids, creds] = await Promise.all([
        fm.typebuild.vault.list(),
        fm.typebuild.credentials.list(),
      ]);
      setIdentity([...ids].sort((a, b) => a.key.localeCompare(b.key)));
      setLogins(
        [...creds].sort(
          (a, b) =>
            hostOf(a.origin).localeCompare(hostOf(b.origin)) ||
            a.username.localeCompare(b.username),
        ),
      );
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

  // Reveal/hide a value. `key` is the row id; `load` fetches the value (vault
  // reveal or credential resolve). Switching target drops the previous plaintext.
  const toggleReveal = useCallback(
    async (key: RevealKey, load: () => Promise<string>) => {
      if (revealedKey === key) {
        remask();
        return;
      }
      remask();
      setRevealing(key);
      try {
        const value = await load();
        setRevealedKey(key);
        setRevealedValue(value);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Could not reveal value.');
      } finally {
        setRevealing(null);
      }
    },
    [revealedKey, remask],
  );

  // ── Identity (me.*) create/delete ───────────────────────────────────────────
  async function saveIdentity(e: React.FormEvent) {
    e.preventDefault();
    if (savingIdentity) return;
    setIdentityError(null);
    const key = newKey.trim();
    if (!key) return setIdentityError('Enter a key, e.g. npi.');
    if (!newValue) return setIdentityError('Enter a value to store.');
    setSavingIdentity(true);
    try {
      await fm.typebuild.vault.set(key, newValue);
      setNewKey('');
      setNewValue('');
      await refresh();
    } catch (err) {
      setIdentityError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSavingIdentity(false);
    }
  }

  async function removeIdentity(ref: string, key: RevealKey) {
    try {
      if (revealedKey === key) remask();
      await fm.typebuild.vault.remove(ref);
      setConfirmingDelete(null);
      await refresh();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : `Could not delete ${ref}.`);
    }
  }

  // ── Saved logins (site-keyed) create/delete ──────────────────────────────────
  async function saveLogin(e: React.FormEvent) {
    e.preventDefault();
    if (savingLogin) return;
    setLoginError(null);
    let origin = newOrigin.trim();
    if (!origin) return setLoginError('Enter a site, e.g. https://portal.example.com.');
    if (!/^[a-z]+:\/\//i.test(origin)) origin = 'https://' + origin;
    if (!newPass) return setLoginError('Enter a password to store.');
    setSavingLogin(true);
    try {
      await fm.typebuild.credentials.save({
        origin,
        username: newUser.trim(),
        password: newPass,
      });
      setNewOrigin('');
      setNewUser('');
      setNewPass('');
      await refresh();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Could not save login.');
    } finally {
      setSavingLogin(false);
    }
  }

  async function removeLogin(origin: string, username: string, key: RevealKey) {
    try {
      if (revealedKey === key) remask();
      await fm.typebuild.credentials.remove(origin, username);
      setConfirmingDelete(null);
      await refresh();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not delete login.');
    }
  }

  // ── Search filtering + grouping ──────────────────────────────────────────────
  const q = query.trim().toLowerCase();
  const filteredIdentity = useMemo(
    () => (q ? identity.filter((e) => e.key.toLowerCase().includes(q)) : identity),
    [identity, q],
  );
  const filteredLogins = useMemo(
    () =>
      q
        ? logins.filter(
            (c) =>
              c.origin.toLowerCase().includes(q) ||
              c.username.toLowerCase().includes(q) ||
              hostOf(c.origin).toLowerCase().includes(q),
          )
        : logins,
    [logins, q],
  );
  // Group logins by host for the file-manager-style site sections.
  const loginGroups = useMemo(() => {
    const m = new Map<string, SavedCredential[]>();
    for (const c of filteredLogins) {
      const h = hostOf(c.origin);
      const arr = m.get(h);
      if (arr) arr.push(c);
      else m.set(h, [c]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredLogins]);

  // A row that toggles reveal on Enter (the ranger-like "open/edit" action).
  function rowKeyDown(e: React.KeyboardEvent, onEnter: () => void) {
    if (e.key === 'Enter') {
      e.preventDefault();
      onEnter();
    }
  }

  return (
    <div className="overlay" data-state={state} onClick={close}>
      <div
        ref={dialogRef}
        className="secrets-panel secrets-panel--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="secrets-panel__title"
        onClick={(e) => e.stopPropagation()}
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
          Secrets
        </h2>

        <input
          className="secrets-panel__search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search identifiers and logins…"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search secrets"
        />

        {loadError && (
          <p className="secrets-panel__error" role="alert">
            {loadError}
          </p>
        )}

        {loading ? (
          <p className="secrets-panel__status" aria-live="polite">
            Loading…
          </p>
        ) : (
          <>
            {/* ── Section 1: your identity (me.* entity fields) ── */}
            <section className="secrets-panel__section">
              <div className="secrets-panel__section-head">Your identity</div>
              <p className="secrets-panel__section-lede">
                Your own identifiers — NPI, practice Tax ID, login IDs. Not patient
                data.
              </p>
              {filteredIdentity.length === 0 ? (
                <p className="secrets-panel__empty">
                  {q ? 'No matching identifiers.' : 'No identifiers yet — add one below.'}
                </p>
              ) : (
                <ul className="secrets-panel__list">
                  {filteredIdentity.map(({ key: ref, secret }) => {
                    const key = `id:${ref}`;
                    const isRevealed = revealedKey === key;
                    const isRevealing = revealing === key;
                    const isConfirming = confirmingDelete === key;
                    return (
                      <li
                        key={key}
                        className="secrets-panel__row"
                        tabIndex={0}
                        onKeyDown={(e) =>
                          !secret &&
                          rowKeyDown(e, () =>
                            void toggleReveal(key, () => fm.typebuild.vault.reveal(ref)),
                          )
                        }
                      >
                        <span className="secrets-panel__key" title={ref}>
                          {ref}
                        </span>
                        <span
                          className="secrets-panel__value"
                          aria-live="polite"
                          data-revealed={isRevealed ? 'true' : 'false'}
                        >
                          {secret ? (
                            <span className="secrets-panel__writeonly">
                              {MASK}
                              <span className="secrets-panel__writeonly-note">
                                {' '}
                                write-only (cannot be shown)
                              </span>
                            </span>
                          ) : isRevealed ? (
                            <code className="secrets-panel__plain">{revealedValue}</code>
                          ) : (
                            <span className="secrets-panel__mask" aria-hidden="true">
                              {MASK}
                            </span>
                          )}
                        </span>

                        {secret ? (
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
                            onClick={() =>
                              void toggleReveal(key, () => fm.typebuild.vault.reveal(ref))
                            }
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
                            <span className="secrets-panel__confirm-q">Delete {ref}?</span>
                            <button
                              type="button"
                              className="secrets-panel__btn secrets-panel__btn--danger"
                              onClick={() => void removeIdentity(ref, key)}
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
                            onClick={() => setConfirmingDelete(key)}
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

              <form className="secrets-panel__form" onSubmit={saveIdentity}>
                <div className="secrets-panel__fields">
                  <input
                    className="secrets-panel__input"
                    type="text"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    placeholder="npi"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Identifier key"
                  />
                  <input
                    className="secrets-panel__input secrets-panel__input--grow"
                    type="password"
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    placeholder="value (stored as me.<key>)"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Identifier value"
                  />
                  <button
                    type="submit"
                    className="secrets-panel__btn secrets-panel__btn--primary"
                    disabled={savingIdentity}
                  >
                    {savingIdentity ? 'Saving…' : 'Add'}
                  </button>
                </div>
                {identityError && (
                  <p className="secrets-panel__error" role="alert">
                    {identityError}
                  </p>
                )}
              </form>
            </section>

            {/* ── Section 2: saved logins (site-keyed credentials) ── */}
            <section className="secrets-panel__section">
              <div className="secrets-panel__section-head">Saved logins</div>
              <p className="secrets-panel__section-lede">
                Website logins captured when you sign in, or added here. Grouped by
                site.
              </p>
              {loginGroups.length === 0 ? (
                <p className="secrets-panel__empty">
                  {q ? 'No matching logins.' : 'No saved logins yet.'}
                </p>
              ) : (
                loginGroups.map(([host, creds]) => (
                  <div key={host} className="secrets-panel__group">
                    <div className="secrets-panel__group-head" title={host}>
                      {host}
                    </div>
                    <ul className="secrets-panel__list">
                      {creds.map((c) => {
                        const key = `cred:${c.origin} ${c.username}`;
                        const isRevealed = revealedKey === key;
                        const isRevealing = revealing === key;
                        const isConfirming = confirmingDelete === key;
                        return (
                          <li
                            key={key}
                            className="secrets-panel__row"
                            tabIndex={0}
                            onKeyDown={(e) =>
                              rowKeyDown(e, () =>
                                void toggleReveal(key, () =>
                                  fm.typebuild.credentials.resolve(c.origin, c.username),
                                ),
                              )
                            }
                          >
                            <span
                              className="secrets-panel__key"
                              title={`${c.username} on ${c.origin}`}
                            >
                              {c.username || <em className="secrets-panel__nouser">(no username)</em>}
                            </span>
                            <span
                              className="secrets-panel__value"
                              aria-live="polite"
                              data-revealed={isRevealed ? 'true' : 'false'}
                            >
                              {isRevealed ? (
                                <code className="secrets-panel__plain">{revealedValue}</code>
                              ) : (
                                <span className="secrets-panel__mask" aria-hidden="true">
                                  {MASK}
                                </span>
                              )}
                            </span>
                            <button
                              type="button"
                              className="secrets-panel__icon"
                              onClick={() =>
                                void toggleReveal(key, () =>
                                  fm.typebuild.credentials.resolve(c.origin, c.username),
                                )
                              }
                              disabled={isRevealing}
                              aria-pressed={isRevealed}
                              aria-label={
                                isRevealed
                                  ? `Hide password for ${c.username || host}`
                                  : `Reveal password for ${c.username || host}`
                              }
                              title={isRevealed ? 'Hide' : 'Reveal'}
                            >
                              {isRevealing ? '…' : isRevealed ? '🙈' : '👁'}
                            </button>
                            {isConfirming ? (
                              <span className="secrets-panel__confirm">
                                <span className="secrets-panel__confirm-q">Delete?</span>
                                <button
                                  type="button"
                                  className="secrets-panel__btn secrets-panel__btn--danger"
                                  onClick={() => void removeLogin(c.origin, c.username, key)}
                                  aria-label="Confirm delete login"
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
                                onClick={() => setConfirmingDelete(key)}
                                aria-label="Delete login"
                                title="Delete"
                              >
                                🗑
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))
              )}

              <form className="secrets-panel__form" onSubmit={saveLogin}>
                <div className="secrets-panel__fields">
                  <input
                    className="secrets-panel__input"
                    type="text"
                    value={newOrigin}
                    onChange={(e) => setNewOrigin(e.target.value)}
                    placeholder="https://portal.example.com"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Site origin"
                  />
                  <input
                    className="secrets-panel__input"
                    type="text"
                    value={newUser}
                    onChange={(e) => setNewUser(e.target.value)}
                    placeholder="username"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Login username"
                  />
                  <input
                    className="secrets-panel__input"
                    type="password"
                    value={newPass}
                    onChange={(e) => setNewPass(e.target.value)}
                    placeholder="password"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Login password"
                  />
                  <button
                    type="submit"
                    className="secrets-panel__btn secrets-panel__btn--primary"
                    disabled={savingLogin}
                  >
                    {savingLogin ? 'Saving…' : 'Add'}
                  </button>
                </div>
                {loginError && (
                  <p className="secrets-panel__error" role="alert">
                    {loginError}
                  </p>
                )}
              </form>
            </section>
          </>
        )}

        <p className="secrets-panel__privacy">
          Stored encrypted on TypeBuild, scoped to you. Values are revealed one at a
          time and never touch this machine's disk.
        </p>
      </div>
    </div>
  );
}
