// Groups management surface — a singleton full-screen tab (kind:'groups').
//
// Master-detail team management on top of the frozen `fm.typebuild.groups`
// bridge API (see src/bridge.ts + electron/typebuild/ipc-projects.ts):
//   - LEFT rail: pending invites (accept/decline) + the caller's groups (each
//     with a role badge, member count, pending count) + a "+ New group" form.
//   - RIGHT pane: the selected group's header (admin-only rename + guarded
//     delete), a members table (with admin-only remove + role toggle), an
//     "Invited" subsection for pending members, an admin-only invite form, and
//     the group's projects.
//
// Every MUTATION on this API REJECTS with a human-readable Error message
// (not_admin / last_admin / …). We catch each and surface `err.message`
// inline — never swallow it. Authorization is enforced SERVER-side; hiding
// controls for non-admins (myRole !== 'admin') / unknown role (myRole === null,
// FAIL CLOSED) is courtesy, not the security boundary.
//
// The role toggle is FEATURE-DETECTED: setMemberRole may resolve
// { unsupported: true } (the server route isn't deployed yet, task-15e74c46cffa).
// On the first such result we collapse all role toggles for the session and
// show a muted note — NOT an error.
//
// PHI: group names, emails, roles are NON-PHI and safe to render. Nothing here
// is written to disk or logs.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fm } from '../../bridge';
import { useTypebuildAuth } from '../../tasks';
import type { GroupDetail, GroupInvite, Project } from '../../types';
import './GroupsPage.css';

// ── inline SVG icons (no dependency; matches the app's inline-glyph approach) ─
function ShieldIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.5 2.5 3.6v4.2c0 3.2 2.3 5.4 5.5 6.7 3.2-1.3 5.5-3.5 5.5-6.7V3.6L8 1.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function FolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.75 4.5c0-.7.55-1.25 1.25-1.25h2.8c.4 0 .77.18 1 .5l.6.75h5.6c.7 0 1.25.55 1.25 1.25v6c0 .7-.55 1.25-1.25 1.25H3c-.7 0-1.25-.55-1.25-1.25v-7.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Extract a human error message, never leaking `[object Object]`. */
function errText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'Something went wrong.';
}

/** The initial shown in a member avatar. */
function initialOf(principal: string, displayName: string | null): string {
  const src = (displayName || principal || '?').trim();
  return src.charAt(0) || '?';
}

export function GroupsPage() {
  const { email: myEmail } = useTypebuildAuth();

  const [groups, setGroups] = useState<GroupDetail[]>([]);
  const [invites, setInvites] = useState<GroupInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A running-out-of-band error for the currently-selected group's mutations.
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // New-group form (left rail).
  const [newName, setNewName] = useState('');

  // Rename (inline, admin-only) — holds the draft when renaming.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  // Delete-confirm flow.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [reassignTo, setReassignTo] = useState<string>('');

  // Invite form (admin-only).
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');

  // Feature-detect: once a setMemberRole returns { unsupported: true } we hide
  // every role toggle for the rest of the session.
  const [roleToggleUnsupported, setRoleToggleUnsupported] = useState(false);

  // Projects for the selected group (fetched from the all-projects list and
  // filtered client-side on `groupId`).
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadGroups = useCallback(async (): Promise<GroupDetail[]> => {
    const [detailed, inv] = await Promise.all([
      fm.typebuild.groups.listDetailed(),
      fm.typebuild.groups.invites().catch(() => [] as GroupInvite[]),
    ]);
    if (!mounted.current) return detailed;
    setGroups(detailed);
    setInvites(inv);
    return detailed;
  }, []);

  // Initial + full refresh (keeps selection if it still exists).
  const refresh = useCallback(async () => {
    try {
      const detailed = await loadGroups();
      if (!mounted.current) return;
      setSelectedId((prev) => {
        if (prev && detailed.some((g) => g.id === prev)) return prev;
        return detailed[0]?.id ?? null;
      });
      setLoadError(null);
    } catch (err) {
      if (mounted.current) setLoadError(errText(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [loadGroups]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Projects (for the group's Projects section). Best-effort; a failure shows a
  // small inline note but never blocks the rest of the surface.
  useEffect(() => {
    let cancelled = false;
    fm.typebuild.projects
      .list()
      .then((list) => {
        if (!cancelled) {
          setAllProjects(list);
          setProjectsError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setProjectsError(errText(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(
    () => groups.find((g) => g.id === selectedId) ?? null,
    [groups, selectedId],
  );

  // Clear per-group transient state whenever the selection changes.
  useEffect(() => {
    setActionError(null);
    setConfirmingDelete(false);
    setReassignTo('');
    setInviteOpen(false);
    setInviteEmail('');
    setInviteRole('member');
    setRenaming(null);
  }, [selectedId]);

  const isAdmin = selected?.myRole === 'admin';

  const groupProjects = useMemo(
    () => (selected ? allProjects.filter((p) => p.groupId === selected.id) : []),
    [allProjects, selected],
  );

  // Count of pending members for a group (for the rail badge).
  const pendingCount = (g: GroupDetail) =>
    g.members.filter((m) => m.status === 'pending').length;

  /** Wrap a mutation: set busy, clear error, run, refresh, catch → actionError. */
  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setActionError(null);
      try {
        await fn();
        await loadGroups();
      } catch (err) {
        if (mounted.current) setActionError(errText(err));
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [loadGroups],
  );

  // ── invites ────────────────────────────────────────────────────────────
  const respondInvite = (groupId: string, accept: boolean) =>
    run(async () => {
      await fm.typebuild.groups.respondToInvite(groupId, accept);
      if (accept && mounted.current) setSelectedId(groupId);
    });

  // ── create ─────────────────────────────────────────────────────────────
  const createGroup = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    void run(async () => {
      const created = await fm.typebuild.groups.create(name);
      if (mounted.current) {
        setNewName('');
        setSelectedId(created.id);
      }
    });
  };

  // ── rename ─────────────────────────────────────────────────────────────
  const startRename = () => {
    if (!selected) return;
    setRenameDraft(selected.name);
    setRenaming(selected.id);
  };
  const submitRename = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    const name = renameDraft.trim();
    if (!name || name === selected.name) {
      setRenaming(null);
      return;
    }
    void run(async () => {
      await fm.typebuild.groups.update(selected.id, name);
      if (mounted.current) setRenaming(null);
    });
  };

  // ── delete ─────────────────────────────────────────────────────────────
  const confirmDelete = () => {
    if (!selected) return;
    void run(async () => {
      await fm.typebuild.groups.remove(
        selected.id,
        reassignTo || undefined,
      );
      if (mounted.current) {
        setConfirmingDelete(false);
        setSelectedId(null);
      }
    });
  };

  // ── members ────────────────────────────────────────────────────────────
  const removeMember = (principal: string) => {
    if (!selected) return;
    void run(() => fm.typebuild.groups.removeMember(selected.id, principal));
  };

  const setRole = (principal: string, role: 'admin' | 'member') => {
    if (!selected) return;
    void run(async () => {
      const res = await fm.typebuild.groups.setMemberRole(
        selected.id,
        principal,
        role,
      );
      // Feature-detect: an unsupported result is NOT an error — collapse the
      // toggles for the session and leave the roster unchanged.
      if (res && res.unsupported && mounted.current) {
        setRoleToggleUnsupported(true);
      }
    });
  };

  // ── invite a member ────────────────────────────────────────────────────
  const submitInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    const em = inviteEmail.trim();
    if (!em) return;
    void run(async () => {
      // Default is an INVITE (pending) — leave `direct` false.
      const res = await fm.typebuild.groups.addMember(selected.id, em, {
        role: inviteRole,
      });
      if (mounted.current) {
        setInviteEmail('');
        setInviteOpen(false);
        setActionError(null);
        // Surface the returned status ("Invited" vs "Added").
        const label = res.status === 'active' ? 'Added' : 'Invited';
        setActionError(`${label} ${em} as ${res.role}.`);
      }
    });
  };

  // Is `m` the signed-in caller?
  const isSelf = (principal: string) =>
    !!myEmail && principal.toLowerCase() === myEmail.toLowerCase();

  // ─────────────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="grp">
        <div className="grp__state">Loading groups…</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="grp">
        <div className="grp__detail">
          <div className="grp__error">
            <span>⚠</span>
            <span>{loadError}</span>
          </div>
          <button className="grp__btn" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const activeMembers = selected
    ? selected.members.filter((m) => m.status === 'active')
    : [];
  const pendingMembers = selected
    ? selected.members.filter((m) => m.status === 'pending')
    : [];
  const activeAdmins = activeMembers.filter((m) => m.role === 'admin').length;

  return (
    <div className="grp">
      {/* ── left rail ───────────────────────────────────────────────────── */}
      <aside className="grp__rail">
        <div className="grp__rail-head">
          <div className="grp__rail-title">Groups</div>
        </div>

        <div className="grp__rail-scroll">
          {/* pending invites */}
          {invites.length > 0 && (
            <div className="grp__invites">
              <div className="grp__invites-title">
                Pending invites ({invites.length})
              </div>
              {invites.map((inv) => (
                <div key={inv.groupId} className="grp__invite">
                  <div className="grp__invite-name">{inv.groupName}</div>
                  <div className="grp__invite-by">
                    invited by {inv.invitedBy || 'someone'} · as {inv.role}
                  </div>
                  <div className="grp__invite-actions">
                    <button
                      className="grp__btn grp__btn--primary grp__btn--sm"
                      disabled={busy}
                      onClick={() => void respondInvite(inv.groupId, true)}
                    >
                      Accept
                    </button>
                    <button
                      className="grp__btn grp__btn--ghost grp__btn--sm"
                      disabled={busy}
                      onClick={() => void respondInvite(inv.groupId, false)}
                    >
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* group list */}
          {groups.length === 0 ? (
            <div className="grp__state">
              You’re not in any groups yet. Create one below.
            </div>
          ) : (
            <ul className="grp__list">
              {groups.map((g) => {
                const pend = pendingCount(g);
                const active = g.id === selectedId;
                return (
                  <li key={g.id}>
                    <button
                      className={`grp__row${active ? ' grp__row--active' : ''}`}
                      onClick={() => setSelectedId(g.id)}
                      aria-current={active}
                    >
                      <span className="grp__row-glyph">
                        <ShieldIcon />
                      </span>
                      <span className="grp__row-body">
                        <span className="grp__row-name">{g.name}</span>
                        <span className="grp__row-meta">
                          <span
                            className={`grp__role${
                              g.myRole === 'admin' ? ' grp__role--admin' : ''
                            }`}
                            title={g.myRole ?? 'unknown role'}
                          >
                            {g.myRole === 'admin'
                              ? '★ admin'
                              : g.myRole === 'member'
                                ? '● member'
                                : '– '}
                          </span>
                          <span>
                            {g.members.filter((m) => m.status === 'active').length}{' '}
                            member
                            {g.members.filter((m) => m.status === 'active')
                              .length === 1
                              ? ''
                              : 's'}
                          </span>
                          {pend > 0 && (
                            <span className="grp__pending-count">
                              · {pend} pending
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* new group */}
        <div className="grp__newgroup">
          <form className="grp__newgroup-form" onSubmit={createGroup}>
            <input
              className="grp__input"
              placeholder="New group name…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              disabled={busy}
              aria-label="New group name"
            />
            <button
              className="grp__btn grp__btn--primary"
              type="submit"
              disabled={busy || !newName.trim()}
            >
              + New group
            </button>
          </form>
        </div>
      </aside>

      {/* ── right pane ──────────────────────────────────────────────────── */}
      {!selected ? (
        <div className="grp__placeholder">
          {groups.length === 0
            ? 'Create your first group to get started.'
            : 'Select a group to manage its members and projects.'}
        </div>
      ) : (
        <section className="grp__detail">
          {/* header */}
          <div className="grp__detail-head">
            {renaming === selected.id ? (
              <form className="grp__rename-form" onSubmit={submitRename}>
                <input
                  className="grp__input"
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  autoFocus
                  disabled={busy}
                  aria-label="Group name"
                />
                <button
                  className="grp__btn grp__btn--primary grp__btn--sm"
                  type="submit"
                  disabled={busy || !renameDraft.trim()}
                >
                  Save
                </button>
                <button
                  className="grp__btn grp__btn--ghost grp__btn--sm"
                  type="button"
                  onClick={() => setRenaming(null)}
                  disabled={busy}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <div>
                  <h1 className="grp__detail-title">
                    <span className="grp__detail-title-glyph">
                      <ShieldIcon />
                    </span>
                    {selected.name}
                  </h1>
                  <div className="grp__detail-sub">
                    {activeMembers.length} member
                    {activeMembers.length === 1 ? '' : 's'}
                    {pendingMembers.length > 0
                      ? ` · ${pendingMembers.length} invited`
                      : ''}
                    {selected.myRole
                      ? ` · you are ${selected.myRole}`
                      : ' · read-only'}
                  </div>
                </div>
                {isAdmin && (
                  <div className="grp__detail-actions">
                    <button
                      className="grp__btn grp__btn--sm"
                      onClick={startRename}
                      disabled={busy}
                    >
                      Rename
                    </button>
                    {/* Never allow deleting the only group. */}
                    <button
                      className="grp__btn grp__btn--danger grp__btn--sm"
                      onClick={() => setConfirmingDelete(true)}
                      disabled={busy || groups.length <= 1}
                      title={
                        groups.length <= 1
                          ? 'You must keep at least one group.'
                          : 'Delete this group'
                      }
                    >
                      Delete
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* action error / status message */}
          {actionError && (
            <div className="grp__error">
              <span>⚠</span>
              <span>{actionError}</span>
              <button
                className="grp__error-dismiss"
                onClick={() => setActionError(null)}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          )}

          {/* delete-confirm card */}
          {confirmingDelete && isAdmin && (
            <div className="grp__confirm">
              <div className="grp__confirm-title">Delete “{selected.name}”?</div>
              <div className="grp__confirm-body">
                This group’s projects and tasks will be re-homed. This can’t be
                undone. Optionally move them to another group you belong to:
              </div>
              <div className="grp__confirm-reassign">
                <label htmlFor="grp-reassign">Re-home projects & tasks to</label>
                <select
                  id="grp-reassign"
                  className="grp__select"
                  value={reassignTo}
                  onChange={(e) => setReassignTo(e.target.value)}
                  disabled={busy}
                >
                  <option value="">Leave ungrouped</option>
                  {groups
                    .filter((g) => g.id !== selected.id)
                    .map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="grp__confirm-actions">
                <button
                  className="grp__btn grp__btn--danger"
                  onClick={confirmDelete}
                  disabled={busy}
                >
                  Delete group
                </button>
                <button
                  className="grp__btn grp__btn--ghost"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={busy}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* members */}
          <div className="grp__section">
            <div className="grp__section-head">
              <div className="grp__section-title">
                Members ({activeMembers.length})
              </div>
              {isAdmin && !inviteOpen && (
                <button
                  className="grp__btn grp__btn--sm"
                  onClick={() => setInviteOpen(true)}
                  disabled={busy}
                >
                  + Invite
                </button>
              )}
            </div>

            {isAdmin && inviteOpen && (
              <form className="grp__invite-form" onSubmit={submitInvite}>
                <input
                  className="grp__input"
                  type="email"
                  placeholder="person@example.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  disabled={busy}
                  autoFocus
                  aria-label="Invite email"
                />
                <select
                  className="grp__select"
                  value={inviteRole}
                  onChange={(e) =>
                    setInviteRole(e.target.value as 'member' | 'admin')
                  }
                  disabled={busy}
                  aria-label="Invite role"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <button
                  className="grp__btn grp__btn--primary grp__btn--sm"
                  type="submit"
                  disabled={busy || !inviteEmail.trim()}
                >
                  Send invite
                </button>
                <button
                  className="grp__btn grp__btn--ghost grp__btn--sm"
                  type="button"
                  onClick={() => setInviteOpen(false)}
                  disabled={busy}
                >
                  Cancel
                </button>
              </form>
            )}

            {roleToggleUnsupported && isAdmin && (
              <div className="grp__note" style={{ marginTop: 'var(--sp-2)' }}>
                Role changes aren’t available yet.
              </div>
            )}

            <div className="grp__members" style={{ marginTop: 'var(--sp-3)' }}>
              {activeMembers.length === 0 ? (
                <div className="grp__state">No active members.</div>
              ) : (
                activeMembers.map((m) => {
                  const self = isSelf(m.principal);
                  // The server 409s on removing / demoting the last admin. We
                  // still render the control (fail-open UI) and surface the
                  // server message; but for the obvious self-last-admin case we
                  // disable to save a round-trip.
                  const lastAdminSelf =
                    self && m.role === 'admin' && activeAdmins <= 1;
                  return (
                    <div key={m.principal} className="grp__member">
                      <span className="grp__avatar">
                        {initialOf(m.principal, m.displayName)}
                      </span>
                      <span className="grp__member-body">
                        <span className="grp__member-principal">
                          {m.principal}
                          {self && <span className="grp__member-you">(you)</span>}
                        </span>
                        {m.displayName && (
                          <span className="grp__member-sub">{m.displayName}</span>
                        )}
                      </span>
                      <span className="grp__member-actions">
                        <span
                          className={`grp__role${
                            m.role === 'admin' ? ' grp__role--admin' : ''
                          }`}
                        >
                          {m.role === 'admin' ? '★ admin' : '● member'}
                        </span>
                        {isAdmin && !roleToggleUnsupported && (
                          <button
                            className="grp__btn grp__btn--sm grp__btn--ghost"
                            disabled={busy || lastAdminSelf}
                            title={
                              lastAdminSelf
                                ? 'A group must keep at least one admin.'
                                : m.role === 'admin'
                                  ? 'Demote to member'
                                  : 'Promote to admin'
                            }
                            onClick={() =>
                              setRole(
                                m.principal,
                                m.role === 'admin' ? 'member' : 'admin',
                              )
                            }
                          >
                            {m.role === 'admin' ? 'Demote' : 'Promote'}
                          </button>
                        )}
                        {isAdmin && (
                          <button
                            className="grp__icon-btn"
                            disabled={busy || lastAdminSelf}
                            title={
                              lastAdminSelf
                                ? 'A group must keep at least one admin.'
                                : 'Remove from group'
                            }
                            aria-label={`Remove ${m.principal}`}
                            onClick={() => removeMember(m.principal)}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* invited (pending) members */}
          {pendingMembers.length > 0 && (
            <div className="grp__section">
              <div className="grp__section-head">
                <div className="grp__section-title">
                  Invited ({pendingMembers.length})
                </div>
              </div>
              <div className="grp__members">
                {pendingMembers.map((m) => (
                  <div
                    key={m.principal}
                    className="grp__member grp__member--pending"
                  >
                    <span className="grp__avatar">
                      {initialOf(m.principal, m.displayName)}
                    </span>
                    <span className="grp__member-body">
                      <span className="grp__member-principal">{m.principal}</span>
                      <span className="grp__member-sub">
                        invited by {m.invitedBy || 'someone'} · as {m.role}
                      </span>
                    </span>
                    <span className="grp__member-actions">
                      <span
                        className={`grp__role${
                          m.role === 'admin' ? ' grp__role--admin' : ''
                        }`}
                      >
                        pending
                      </span>
                      {isAdmin && (
                        <button
                          className="grp__icon-btn"
                          disabled={busy}
                          title="Revoke invite"
                          aria-label={`Revoke invite for ${m.principal}`}
                          onClick={() => removeMember(m.principal)}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* projects */}
          <div className="grp__section">
            <div className="grp__section-head">
              <div className="grp__section-title">
                Projects ({groupProjects.length})
              </div>
            </div>
            {projectsError ? (
              <div className="grp__note">
                Couldn’t load projects: {projectsError}
              </div>
            ) : groupProjects.length === 0 ? (
              <div className="grp__note">No projects in this group.</div>
            ) : (
              <div className="grp__projects">
                {groupProjects.map((p) => (
                  <div key={p.id} className="grp__project">
                    <span className="grp__project-glyph">
                      <FolderIcon />
                    </span>
                    <span className="grp__project-body">
                      <span className="grp__project-name">{p.name}</span>
                      {p.description && (
                        <span className="grp__project-desc">{p.description}</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
