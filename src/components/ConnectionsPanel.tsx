/*
 * ConnectionsPanel — the Connections surface. CATALOG-FIRST (docs/
 * connections-design.md §J, the Okta model): the default view shows
 * "Available connections" that an ADMIN provisioned centrally — the end user
 * just clicks Connect → OAuth in the system browser → the server materializes a
 * normal Connection (which then also appears under "Your connections"). No
 * credential is ever typed for a catalog Connect; the OAuth handshake happens
 * in the browser and the token lives server-side.
 *
 * The manual registration form (a REST API or MCP server + a pasted/typed
 * credential) is retained but DEMOTED behind an "Advanced" disclosure — most
 * users never need it. When used, THE CREDENTIAL GOES TO THE SERVER: it is sent
 * to fm.typebuild.connections.register/setCredential and NEVER stored on this
 * machine, never logged, never echoed back — every read (list/get) returns a
 * creds-STRIPPED ConnectionSummary whose `credentialDisplay` carries only
 * non-secret metadata. A captured secret lives only in this component's
 * transient form state and is dropped on submit/unmount.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fm } from '../bridge';
import type {
  ConnectionCatalogEntry,
  ConnectionCredential,
  ConnectionCredentialKind,
  ConnectionRegisterInput,
  ConnectionSummary,
  Group,
  Project,
} from '../types';
import { useOverlayExit } from '../useOverlayExit';
import { useTypebuildAuth } from '../tasks';
import './ConnectionsPanel.css';

function openTypebuildSignIn(): void {
  window.dispatchEvent(
    new CustomEvent('fm:openSettings', { detail: { section: 'typebuild' } }),
  );
}

type FormState = {
  name: string;
  kind: 'rest' | 'mcp';
  endpoint: string;
  scopeKind: 'none' | 'project' | 'group';
  projectId: string;
  groupId: string;
  specKind: 'live_url' | 'inline';
  specUrl: string;
  specInline: string;
  // REST credential fields — credKind selects among api_key/basic/bearer/oauth2
  credKind: ConnectionCredentialKind;
  bearerValue: string;
  basicUsername: string;
  basicPassword: string;
  apiKeyValue: string;
  apiKeyHeader: string;
  oauthAccessToken: string;
  oauthRefreshToken: string;
  oauthTokenType: string;
  // MCP credential field
  mcpTokenValue: string;
};

const EMPTY_FORM: FormState = {
  name: '',
  kind: 'rest',
  endpoint: '',
  scopeKind: 'none',
  projectId: '',
  groupId: '',
  specKind: 'live_url',
  specUrl: '',
  specInline: '',
  credKind: 'bearer',
  bearerValue: '',
  basicUsername: '',
  basicPassword: '',
  apiKeyValue: '',
  apiKeyHeader: 'X-API-Key',
  oauthAccessToken: '',
  oauthRefreshToken: '',
  oauthTokenType: '',
  mcpTokenValue: '',
};

function formFromConnection(c: ConnectionSummary): FormState {
  return {
    ...EMPTY_FORM,
    name: c.name,
    kind: c.kind,
    endpoint: c.endpoint,
    scopeKind: c.scope.type === 'project' ? 'project' : c.scope.type === 'group' ? 'group' : 'none',
    projectId: c.scope.type === 'project' ? c.scope.projectId : '',
    groupId: c.scope.type === 'group' ? c.scope.groupId : '',
    specKind: c.spec?.mode === 'inline' ? 'inline' : 'live_url',
    specUrl: c.spec?.specUrl ?? '',
    credKind: c.kind === 'mcp' ? 'mcp_token' : 'bearer',
  };
}

/** Builds the write-side `credential` object from the form, by `credKind`.
 *  Returns undefined when the credential fields are all empty — an edit that
 *  doesn't touch the credential must not clobber the one already stored. */
function credentialFromForm(f: FormState): ConnectionCredential | undefined {
  if (f.kind === 'mcp') {
    return f.mcpTokenValue ? { kind: 'mcp_token', value: f.mcpTokenValue } : undefined;
  }
  if (f.credKind === 'bearer') {
    return f.bearerValue ? { kind: 'bearer', value: f.bearerValue } : undefined;
  }
  if (f.credKind === 'basic') {
    return f.basicUsername || f.basicPassword
      ? { kind: 'basic', username: f.basicUsername, password: f.basicPassword }
      : undefined;
  }
  if (f.credKind === 'oauth2') {
    return f.oauthAccessToken
      ? {
          kind: 'oauth2',
          accessToken: f.oauthAccessToken,
          refreshToken: f.oauthRefreshToken || undefined,
          tokenType: f.oauthTokenType || undefined,
        }
      : undefined;
  }
  // api_key
  return f.apiKeyValue
    ? { kind: 'api_key', value: f.apiKeyValue, header: f.apiKeyHeader || undefined }
    : undefined;
}

function formatReason(reason: string): string {
  if (reason === 'not_owner') return "You don't own this connection.";
  if (reason === 'not_visible') return 'This connection is no longer visible.';
  if (reason === 'in_use') return 'This connection is in use and cannot be deleted.';
  if (reason === 'invalid') return 'That credential is not valid for this connection.';
  if (reason === 'unsupported') return 'Connections aren’t available on the server yet.';
  return `Failed: ${reason}`;
}

function formatCatalogReason(reason: string): string {
  if (reason === 'not_in_scope') return 'You don’t have access to this connection.';
  if (reason === 'not_found') return 'This connection is no longer available.';
  if (reason === 'conflict') return 'This connection is already being set up.';
  if (reason === 'in_use') return 'This connection is in use and can’t be disconnected.';
  if (reason === 'unsupported') return 'Connections aren’t available on the server yet.';
  return `Failed: ${reason}`;
}

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 180_000;

export function ConnectionsPanel({ onClose }: { onClose: () => void }) {
  const { exit, state } = useOverlayExit(onClose);
  const { signedIn } = useTypebuildAuth();

  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // Scope pickers (loaded once; used by the form's scope select).
  const [projects, setProjects] = useState<Project[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);

  // Create/edit form. `editingId` null = create; a string = editing that row.
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Admin-curated catalog (docs/connections-design.md §J). `pendingIds` tracks
  // entries whose OAuth authorize we opened and are polling; an entry may also
  // arrive already `status:'pending'` from the server (a poll started on
  // another machine), so the tile treats either as pending.
  const [catalog, setCatalog] = useState<ConnectionCatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [catalogBusyId, setCatalogBusyId] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState<string | null>(null);

  // Manual (custom) registration is demoted behind this disclosure — collapsed
  // by default; connections are usually provisioned by an admin.
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const mounted = useRef(true);
  // One live poll per pending entry (interval id keyed by entry id). Cleared on
  // connect/timeout and, wholesale, on unmount so no timer outlives the panel.
  const pollTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  useEffect(() => {
    // Reset on EVERY run, not just at ref init: StrictMode (dev) runs
    // mount → cleanup → mount on the same fiber, so a cleanup-only flag
    // stays false after the simulated remount and every mounted-guarded
    // setState silently no-ops (the panel hangs at "Loading…").
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const t of pollTimers.current.values()) clearInterval(t);
      pollTimers.current.clear();
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await fm.typebuild.connections.list();
      if (!mounted.current) return;
      setConnections([...list].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) {
      if (!mounted.current) return;
      setLoadError(err instanceof Error ? err.message : 'Could not load connections.');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const list = await fm.typebuild.connections.catalog.list();
      if (!mounted.current) return;
      setCatalog([...list].sort((a, b) => a.name.localeCompare(b.name)));
    } catch {
      // The route degrades to [] in the source; a throw here is unexpected —
      // treat it as "nothing provisioned" rather than blocking the panel.
      if (mounted.current) setCatalog([]);
    } finally {
      if (mounted.current) setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  const clearPoll = useCallback((entryId: string) => {
    const t = pollTimers.current.get(entryId);
    if (t) {
      clearInterval(t);
      pollTimers.current.delete(entryId);
    }
  }, []);

  const dropPending = useCallback((entryId: string) => {
    setPendingIds((prev) => {
      if (!prev.has(entryId)) return prev;
      const next = new Set(prev);
      next.delete(entryId);
      return next;
    });
  }, []);

  // Poll an entry's status every 3s for up to 3 minutes while its OAuth
  // authorize is pending. On `connected` refresh both the catalog and the
  // registered-connections list (the server has materialized a Connection);
  // on timeout revert to available with a gentle note.
  const startPoll = useCallback(
    (entryId: string) => {
      clearPoll(entryId);
      const started = Date.now();
      const timer = setInterval(() => {
        void (async () => {
          if (Date.now() - started > POLL_TIMEOUT_MS) {
            clearPoll(entryId);
            if (!mounted.current) return;
            dropPending(entryId);
            setCatalogError('Authorization timed out. Click Connect to try again.');
            return;
          }
          const st = await fm.typebuild.connections.catalog.status(entryId).catch(() => null);
          if (!mounted.current) return;
          if (st && st.status === 'connected') {
            clearPoll(entryId);
            dropPending(entryId);
            await refreshCatalog();
            await refresh();
          }
        })();
      }, POLL_INTERVAL_MS);
      pollTimers.current.set(entryId, timer);
    },
    [clearPoll, dropPending, refresh, refreshCatalog],
  );

  async function handleConnect(entry: ConnectionCatalogEntry) {
    if (catalogBusyId) return;
    setCatalogBusyId(entry.id);
    setCatalogError(null);
    try {
      const res = await fm.typebuild.connections.catalog.connect(entry.id);
      if (!res.ok) {
        setCatalogError(formatCatalogReason(res.reason));
        return;
      }
      if (res.redirectUrl) {
        // Hand the OAuth authorize URL to the system browser; then poll.
        await fm.openUrl(res.redirectUrl);
        setPendingIds((prev) => new Set(prev).add(entry.id));
        startPoll(entry.id);
      } else if (res.status === 'connected') {
        // Admin-managed / already-authorized — no browser hop needed.
        await refreshCatalog();
        await refresh();
      } else {
        // Pending with no redirect (e.g. admin_managed provisioning) — poll.
        setPendingIds((prev) => new Set(prev).add(entry.id));
        startPoll(entry.id);
      }
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : 'Could not start the connection.');
    } finally {
      setCatalogBusyId(null);
    }
  }

  function handleCancelPending(entryId: string) {
    clearPoll(entryId);
    dropPending(entryId);
  }

  async function handleCatalogDisconnect(entryId: string) {
    setCatalogBusyId(entryId);
    try {
      const res = await fm.typebuild.connections.catalog.disconnect(entryId);
      if (!res.ok) {
        setCatalogError(formatCatalogReason(res.reason));
        return;
      }
      setConfirmingDisconnect(null);
      await refreshCatalog();
      await refresh();
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : 'Could not disconnect.');
    } finally {
      setCatalogBusyId(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.all([fm.typebuild.projects.list(), fm.typebuild.groups.list()])
      .then(([p, g]) => {
        if (cancelled) return;
        setProjects(p);
        setGroups(g);
      })
      .catch(() => {
        /* scope picker degrades to no options — the form still works unscoped */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Drop any captured secret on unmount — never held longer than the form.
  useEffect(
    () => () => {
      setForm(EMPTY_FORM);
    },
    [],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (formOpen) {
          closeForm();
        } else {
          exit();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exit, formOpen]);

  function close() {
    exit();
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setFormError(null);
    setShowSecret(false);
    setFormOpen(true);
  }

  function openEdit(c: ConnectionSummary) {
    setForm(formFromConnection(c));
    setEditingId(c.id);
    setFormError(null);
    setShowSecret(false);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    const name = form.name.trim();
    const endpoint = form.endpoint.trim();
    if (!name) return setFormError('Enter a name.');
    if (!endpoint) return setFormError('Enter an endpoint URL.');

    const scope: ConnectionRegisterInput['scope'] | undefined =
      form.scopeKind === 'project' && form.projectId
        ? { type: 'project', projectId: form.projectId }
        : form.scopeKind === 'group' && form.groupId
          ? { type: 'group', groupId: form.groupId }
          : undefined;

    const spec: ConnectionRegisterInput['spec'] =
      form.specKind === 'live_url'
        ? form.specUrl.trim()
          ? { mode: 'live_url', specUrl: form.specUrl.trim() }
          : undefined
        : form.specInline.trim()
          ? { mode: 'inline', raw: form.specInline.trim() }
          : undefined;

    const credential = credentialFromForm(form);

    setSaving(true);
    setFormError(null);
    try {
      if (editingId) {
        const res = await fm.typebuild.connections.update(editingId, {
          name,
          kind: form.kind,
          endpoint,
          scope,
          spec,
        });
        if (!res.ok) {
          setFormError(formatReason(res.reason));
          setSaving(false);
          return;
        }
        // A credential edit is a SEPARATE, explicit write — never bundled
        // silently into the metadata patch above.
        if (credential) {
          const credRes = await fm.typebuild.connections.setCredential(editingId, credential);
          if (!credRes.ok) {
            setFormError(formatReason(credRes.reason));
            setSaving(false);
            return;
          }
        }
      } else {
        await fm.typebuild.connections.register({
          name,
          kind: form.kind,
          endpoint,
          scope,
          spec,
          credential,
        });
      }
      closeForm();
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save connection.');
      setSaving(false);
      return;
    }
    setSaving(false);
  }

  async function handleDelete(id: string) {
    setBusyId(id);
    try {
      const res = await fm.typebuild.connections.remove(id);
      if (!res.ok) {
        setLoadError(formatReason(res.reason));
        setBusyId(null);
        return;
      }
      setConfirmingDelete(null);
      await refresh();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not delete connection.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRefreshSpec(id: string) {
    setBusyId(id);
    try {
      const updated = await fm.typebuild.connections.refreshSpec(id);
      setConnections((prev) => prev.map((c) => (c.id === id ? updated : c)));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not refresh spec.');
    } finally {
      setBusyId(null);
    }
  }

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? connections.filter(
            (c) =>
              c.name.toLowerCase().includes(q) ||
              c.endpoint.toLowerCase().includes(q) ||
              c.kind.includes(q),
          )
        : connections,
    [connections, q],
  );

  function scopeLabel(c: ConnectionSummary): string {
    const scope = c.scope;
    if (scope.type === 'project') {
      return projects.find((p) => p.id === scope.projectId)?.name ?? scope.projectId;
    }
    if (scope.type === 'group') {
      return groups.find((g) => g.id === scope.groupId)?.name ?? scope.groupId;
    }
    return 'Unscoped';
  }

  return (
    <div className="overlay" data-state={state} onClick={close}>
      <div
        ref={dialogRef}
        className="connections-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connections-panel__title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="connections-panel__close"
          onClick={close}
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>

        <div className="connections-panel__eyebrow">TypeBuild</div>
        <h2 id="connections-panel__title" className="connections-panel__title">
          Connections
        </h2>
        <p className="connections-panel__lede">
          Connect the services your admin has provisioned — click Connect and finish
          the sign-in in your browser. Credentials stay on TypeBuild, never on this
          machine.
        </p>

        {!signedIn ? (
          <div className="connections-panel__signin" role="status">
            <p className="connections-panel__status">
              Sign in to TypeBuild to manage connections.
            </p>
            <button
              type="button"
              className="connections-panel__signin-btn"
              onClick={openTypebuildSignIn}
            >
              Sign in to TypeBuild
            </button>
          </div>
        ) : (
          <>
            <h3 className="connections-panel__section">Available connections</h3>
            {catalogError && (
              <p className="connections-panel__error" role="alert">
                {catalogError}
              </p>
            )}
            {catalogLoading ? (
              <p className="connections-panel__status" aria-live="polite">
                Loading…
              </p>
            ) : catalog.length === 0 ? (
              <p className="connections-panel__empty">No admin-provisioned connections yet.</p>
            ) : (
              <ul className="connections-panel__list connections-panel__catalog">
                {catalog.map((entry) => {
                  const isPending = pendingIds.has(entry.id) || entry.status === 'pending';
                  const isBusy = catalogBusyId === entry.id;
                  const isConfirming = confirmingDisconnect === entry.id;
                  return (
                    <li key={entry.id} className="connections-panel__row">
                      <div className="connections-panel__row-main">
                        <span className="connections-panel__kind-badge" data-kind={entry.kind}>
                          {entry.kind === 'mcp' ? 'MCP' : 'REST'}
                        </span>
                        <div className="connections-panel__row-text">
                          <div className="connections-panel__row-name">{entry.name}</div>
                          {entry.description && (
                            <div
                              className="connections-panel__row-endpoint"
                              title={entry.description}
                            >
                              {entry.description}
                            </div>
                          )}
                          {entry.status === 'connected' && (
                            <div className="connections-panel__row-meta">
                              <span className="connections-panel__cred connections-panel__cred--set">
                                Connected{entry.connectedAs ? ` as ${entry.connectedAs}` : ''}
                              </span>
                              {entry.auth === 'admin_managed' && (
                                <span>Managed by your admin</span>
                              )}
                              {entry.auth === 'first_party_mcp' && (
                                <span>Included with your account</span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="connections-panel__row-actions">
                        {isPending ? (
                          <span className="connections-panel__confirm">
                            <span
                              className="connections-panel__pending"
                              role="status"
                              aria-live="polite"
                            >
                              Waiting for authorization…
                            </span>
                            <button
                              type="button"
                              className="connections-panel__btn"
                              onClick={() => handleCancelPending(entry.id)}
                              aria-label={`Cancel connecting ${entry.name}`}
                            >
                              Cancel
                            </button>
                          </span>
                        ) : entry.status === 'connected' ? (
                          // Only a user-authorized (oauth) connection can be
                          // disconnected here; admin_managed is the admin's,
                          // and first_party_mcp has nothing to revoke.
                          entry.auth !== 'oauth' ? null : isConfirming ? (
                            <span className="connections-panel__confirm">
                              <span className="connections-panel__confirm-q">Disconnect?</span>
                              <button
                                type="button"
                                className="connections-panel__btn connections-panel__btn--danger"
                                onClick={() => void handleCatalogDisconnect(entry.id)}
                                disabled={isBusy}
                                aria-label={`Confirm disconnect ${entry.name}`}
                              >
                                {isBusy ? 'Disconnecting…' : 'Disconnect'}
                              </button>
                              <button
                                type="button"
                                className="connections-panel__btn"
                                onClick={() => setConfirmingDisconnect(null)}
                                aria-label="Cancel disconnect"
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="connections-panel__btn"
                              onClick={() => setConfirmingDisconnect(entry.id)}
                              aria-label={`Disconnect ${entry.name}`}
                            >
                              Disconnect
                            </button>
                          )
                        ) : (
                          <button
                            type="button"
                            className="btn btn--primary"
                            onClick={() => void handleConnect(entry)}
                            disabled={isBusy}
                            aria-label={`Connect ${entry.name}`}
                          >
                            {isBusy ? 'Connecting…' : 'Connect'}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <h3 className="connections-panel__section">Your connections</h3>
            {loadError && (
              <p className="connections-panel__error" role="alert">
                {loadError}
              </p>
            )}

            <div className="connections-panel__toolbar">
              <input
                className="connections-panel__search"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search connections…"
                autoComplete="off"
                spellCheck={false}
                aria-label="Search connections"
              />
            </div>

            {loading ? (
              <p className="connections-panel__status" aria-live="polite">
                Loading…
              </p>
            ) : filtered.length === 0 ? (
              <p className="connections-panel__empty">
                {q
                  ? 'No matching connections.'
                  : 'No connections yet — connect one above, or register a custom one below.'}
              </p>
            ) : (
              <ul className="connections-panel__list">
                {filtered.map((c) => {
                  const isConfirming = confirmingDelete === c.id;
                  const isBusy = busyId === c.id;
                  return (
                    <li key={c.id} className="connections-panel__row">
                      <div className="connections-panel__row-main">
                        <span className="connections-panel__kind-badge" data-kind={c.kind}>
                          {c.kind === 'mcp' ? 'MCP' : 'REST'}
                        </span>
                        <div className="connections-panel__row-text">
                          <div className="connections-panel__row-name">
                            {c.name}
                            {c.status === 'needs_attention' && (
                              <span
                                className="connections-panel__attention"
                                title="This connection may need attention (spec drift)"
                              >
                                ⚠ needs attention
                              </span>
                            )}
                            {c.status === 'disabled' && (
                              <span
                                className="connections-panel__attention"
                                title="This connection is disabled"
                              >
                                disabled
                              </span>
                            )}
                          </div>
                          <div className="connections-panel__row-endpoint" title={c.endpoint}>
                            {c.endpoint}
                          </div>
                          <div className="connections-panel__row-meta">
                            <span>{scopeLabel(c)}</span>
                            <span
                              className={
                                c.credentialDisplay
                                  ? 'connections-panel__cred connections-panel__cred--set'
                                  : 'connections-panel__cred'
                              }
                            >
                              {c.credentialDisplay
                                ? (Object.values(c.credentialDisplay)[0] ?? 'Credential set')
                                : 'No credential'}
                            </span>
                            {c.spec?.fetchedAt && (
                              <span>
                                Spec fetched {new Date(c.spec.fetchedAt).toLocaleDateString()}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="connections-panel__row-actions">
                        {c.spec?.specUrl && (
                          <button
                            type="button"
                            className="connections-panel__icon"
                            onClick={() => void handleRefreshSpec(c.id)}
                            disabled={isBusy}
                            aria-label={`Refresh spec for ${c.name}`}
                            title="Refresh spec"
                          >
                            {isBusy ? '…' : '⟳'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="connections-panel__icon"
                          onClick={() => openEdit(c)}
                          aria-label={`Edit ${c.name}`}
                          title="Edit"
                        >
                          ✎
                        </button>
                        {isConfirming ? (
                          <span className="connections-panel__confirm">
                            <span className="connections-panel__confirm-q">Delete?</span>
                            <button
                              type="button"
                              className="connections-panel__btn connections-panel__btn--danger"
                              onClick={() => void handleDelete(c.id)}
                              disabled={isBusy}
                              aria-label={`Confirm delete ${c.name}`}
                            >
                              {isBusy ? 'Deleting…' : 'Delete'}
                            </button>
                            <button
                              type="button"
                              className="connections-panel__btn"
                              onClick={() => setConfirmingDelete(null)}
                              aria-label="Cancel delete"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="connections-panel__icon connections-panel__icon--danger"
                            onClick={() => setConfirmingDelete(c.id)}
                            aria-label={`Delete ${c.name}`}
                            title="Delete"
                          >
                            🗑
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="connections-panel__advanced">
              <button
                type="button"
                className="connections-panel__advanced-toggle"
                onClick={() => setAdvancedOpen((v) => !v)}
                aria-expanded={advancedOpen}
              >
                {advancedOpen ? '▾' : '▸'} Advanced: register a custom connection
              </button>
              {advancedOpen && (
                <div className="connections-panel__advanced-body">
                  <p className="connections-panel__status">
                    Connections are usually provisioned by your admin. Register one
                    manually only if you hold the credential yourself.
                  </p>
                  <button type="button" className="btn btn--primary" onClick={openCreate}>
                    + New connection
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        <p className="connections-panel__privacy">
          Credentials are stored encrypted on TypeBuild and never persisted on this
          machine. Values are write-only from here on — this panel never reveals a
          stored credential.
        </p>
      </div>

      {formOpen && (
        <div className="nh-dialog-backdrop" onClick={closeForm}>
          <div
            className="nh-dialog nh-pdlg connections-form"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connections-form-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="nh-dialog__head">
              <div>
                <div id="connections-form-title" className="nh-dialog__title">
                  {editingId ? 'Edit connection' : 'New connection'}
                </div>
                <div className="nh-dialog__sub">
                  The credential is sent straight to the TypeBuild vault and is never
                  stored here.
                </div>
              </div>
              <button
                type="button"
                className="nh-dialog__close"
                onClick={closeForm}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <form onSubmit={(e) => void handleSave(e)}>
              <div className="nh-dialog__body">
                <div className="nh-dialog__section">
                  <label className="nh-pdlg__label" htmlFor="conn-name">
                    Name
                  </label>
                  <input
                    id="conn-name"
                    className="nh-pdlg__input"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. QuickBooks"
                    autoFocus
                  />
                </div>

                <div className="nh-dialog__section">
                  <label className="nh-pdlg__label" htmlFor="conn-kind">
                    Kind
                  </label>
                  <select
                    id="conn-kind"
                    className="nh-pdlg__select"
                    value={form.kind}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, kind: e.target.value as 'rest' | 'mcp' }))
                    }
                  >
                    <option value="rest">REST API</option>
                    <option value="mcp">MCP server</option>
                  </select>
                </div>

                <div className="nh-dialog__section">
                  <label className="nh-pdlg__label" htmlFor="conn-endpoint">
                    {form.kind === 'mcp' ? 'Server URL' : 'Base URL'}
                  </label>
                  <input
                    id="conn-endpoint"
                    className="nh-pdlg__input"
                    value={form.endpoint}
                    onChange={(e) => setForm((f) => ({ ...f, endpoint: e.target.value }))}
                    placeholder="https://api.example.com"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>

                <div className="nh-dialog__section">
                  <label className="nh-pdlg__label">Scope</label>
                  <div className="nh-pdlg__hint">Who can use this connection.</div>
                  <select
                    className="nh-pdlg__select"
                    value={form.scopeKind}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        scopeKind: e.target.value as FormState['scopeKind'],
                      }))
                    }
                  >
                    <option value="none">Unscoped (visible everywhere)</option>
                    <option value="project">A project</option>
                    <option value="group">A group</option>
                  </select>
                  {form.scopeKind === 'project' && (
                    <select
                      className="nh-pdlg__select connections-form__sub-select"
                      value={form.projectId}
                      onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value }))}
                    >
                      <option value="">(choose a project)</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {form.scopeKind === 'group' && (
                    <select
                      className="nh-pdlg__select connections-form__sub-select"
                      value={form.groupId}
                      onChange={(e) => setForm((f) => ({ ...f, groupId: e.target.value }))}
                    >
                      <option value="">(choose a group)</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="nh-dialog__section">
                  <label className="nh-pdlg__label">
                    {form.kind === 'mcp' ? 'MCP spec' : 'API spec'}{' '}
                    <span className="nh-pdlg__optional">(optional)</span>
                  </label>
                  <div className="nh-pdlg__hint">
                    A live URL is periodically re-fetched; a pasted spec is a one-time
                    snapshot.
                  </div>
                  <div className="connections-form__radio-row">
                    <label className="connections-form__radio">
                      <input
                        type="radio"
                        name="conn-spec-kind"
                        checked={form.specKind === 'live_url'}
                        onChange={() => setForm((f) => ({ ...f, specKind: 'live_url' }))}
                      />
                      Live URL
                    </label>
                    <label className="connections-form__radio">
                      <input
                        type="radio"
                        name="conn-spec-kind"
                        checked={form.specKind === 'inline'}
                        onChange={() => setForm((f) => ({ ...f, specKind: 'inline' }))}
                      />
                      Paste spec
                    </label>
                  </div>
                  {form.specKind === 'live_url' ? (
                    <input
                      className="nh-pdlg__input"
                      value={form.specUrl}
                      onChange={(e) => setForm((f) => ({ ...f, specUrl: e.target.value }))}
                      placeholder={
                        form.kind === 'mcp'
                          ? 'https://.../mcp'
                          : 'https://api.example.com/openapi.json'
                      }
                      autoComplete="off"
                      spellCheck={false}
                    />
                  ) : (
                    <textarea
                      className="nh-dialog__textarea"
                      value={form.specInline}
                      onChange={(e) => setForm((f) => ({ ...f, specInline: e.target.value }))}
                      placeholder="Paste the OpenAPI / MCP spec JSON"
                    />
                  )}
                </div>

                {/* ── Credential sub-form — shape changes by connection kind / credKind ── */}
                <div className="nh-dialog__section">
                  <label className="nh-pdlg__label">
                    Credential{' '}
                    {editingId && (
                      <span className="nh-pdlg__optional">
                        (leave blank to keep the one already stored)
                      </span>
                    )}
                  </label>

                  {form.kind === 'rest' ? (
                    <>
                      <select
                        className="nh-pdlg__select"
                        value={form.credKind}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            credKind: e.target.value as ConnectionCredentialKind,
                          }))
                        }
                      >
                        <option value="bearer">Bearer token</option>
                        <option value="basic">Basic auth (username/password)</option>
                        <option value="api_key">API key</option>
                        <option value="oauth2">OAuth2 token</option>
                      </select>

                      {form.credKind === 'bearer' && (
                        <div className="connections-form__secret-row">
                          <input
                            className="nh-pdlg__input"
                            type={showSecret ? 'text' : 'password'}
                            value={form.bearerValue}
                            onChange={(e) =>
                              setForm((f) => ({ ...f, bearerValue: e.target.value }))
                            }
                            placeholder="Bearer token"
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <button
                            type="button"
                            className="connections-form__eye"
                            onClick={() => setShowSecret((s) => !s)}
                            aria-label={showSecret ? 'Hide token' : 'Show token'}
                            title={showSecret ? 'Hide' : 'Show'}
                          >
                            {showSecret ? '🙈' : '👁'}
                          </button>
                        </div>
                      )}

                      {form.credKind === 'basic' && (
                        <>
                          <input
                            className="nh-pdlg__input connections-form__stacked"
                            value={form.basicUsername}
                            onChange={(e) =>
                              setForm((f) => ({ ...f, basicUsername: e.target.value }))
                            }
                            placeholder="Username"
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <div className="connections-form__secret-row">
                            <input
                              className="nh-pdlg__input"
                              type={showSecret ? 'text' : 'password'}
                              value={form.basicPassword}
                              onChange={(e) =>
                                setForm((f) => ({ ...f, basicPassword: e.target.value }))
                              }
                              placeholder="Password"
                              autoComplete="off"
                              spellCheck={false}
                            />
                            <button
                              type="button"
                              className="connections-form__eye"
                              onClick={() => setShowSecret((s) => !s)}
                              aria-label={showSecret ? 'Hide password' : 'Show password'}
                              title={showSecret ? 'Hide' : 'Show'}
                            >
                              {showSecret ? '🙈' : '👁'}
                            </button>
                          </div>
                        </>
                      )}

                      {form.credKind === 'api_key' && (
                        <>
                          <div className="connections-form__secret-row">
                            <input
                              className="nh-pdlg__input"
                              type={showSecret ? 'text' : 'password'}
                              value={form.apiKeyValue}
                              onChange={(e) =>
                                setForm((f) => ({ ...f, apiKeyValue: e.target.value }))
                              }
                              placeholder="API key"
                              autoComplete="off"
                              spellCheck={false}
                            />
                            <button
                              type="button"
                              className="connections-form__eye"
                              onClick={() => setShowSecret((s) => !s)}
                              aria-label={showSecret ? 'Hide key' : 'Show key'}
                              title={showSecret ? 'Hide' : 'Show'}
                            >
                              {showSecret ? '🙈' : '👁'}
                            </button>
                          </div>
                          <input
                            className="nh-pdlg__input connections-form__stacked"
                            value={form.apiKeyHeader}
                            onChange={(e) =>
                              setForm((f) => ({ ...f, apiKeyHeader: e.target.value }))
                            }
                            placeholder="Header name (e.g. X-API-Key)"
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </>
                      )}

                      {form.credKind === 'oauth2' && (
                        <>
                          <div className="connections-form__secret-row">
                            <input
                              className="nh-pdlg__input"
                              type={showSecret ? 'text' : 'password'}
                              value={form.oauthAccessToken}
                              onChange={(e) =>
                                setForm((f) => ({ ...f, oauthAccessToken: e.target.value }))
                              }
                              placeholder="Access token"
                              autoComplete="off"
                              spellCheck={false}
                            />
                            <button
                              type="button"
                              className="connections-form__eye"
                              onClick={() => setShowSecret((s) => !s)}
                              aria-label={showSecret ? 'Hide token' : 'Show token'}
                              title={showSecret ? 'Hide' : 'Show'}
                            >
                              {showSecret ? '🙈' : '👁'}
                            </button>
                          </div>
                          <input
                            className="nh-pdlg__input connections-form__stacked"
                            type={showSecret ? 'text' : 'password'}
                            value={form.oauthRefreshToken}
                            onChange={(e) =>
                              setForm((f) => ({ ...f, oauthRefreshToken: e.target.value }))
                            }
                            placeholder="Refresh token (optional)"
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <input
                            className="nh-pdlg__input connections-form__stacked"
                            value={form.oauthTokenType}
                            onChange={(e) =>
                              setForm((f) => ({ ...f, oauthTokenType: e.target.value }))
                            }
                            placeholder="Token type (e.g. Bearer, optional)"
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </>
                      )}
                    </>
                  ) : (
                    <div className="connections-form__secret-row">
                      <input
                        className="nh-pdlg__input"
                        type={showSecret ? 'text' : 'password'}
                        value={form.mcpTokenValue}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, mcpTokenValue: e.target.value }))
                        }
                        placeholder="MCP token (optional)"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="connections-form__eye"
                        onClick={() => setShowSecret((s) => !s)}
                        aria-label={showSecret ? 'Hide token' : 'Show token'}
                        title={showSecret ? 'Hide' : 'Show'}
                      >
                        {showSecret ? '🙈' : '👁'}
                      </button>
                    </div>
                  )}
                </div>

                {formError && <div className="nh-dialog__error">{formError}</div>}
              </div>

              <div className="nh-pdlg__foot">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={closeForm}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={saving || !form.name.trim() || !form.endpoint.trim()}
                >
                  {saving ? 'Saving…' : editingId ? 'Save changes' : 'Register connection'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
