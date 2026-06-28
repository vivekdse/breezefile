// fm-7909 — rebuilt detail panel. Three layouts driven by the task's owner:
//
//   Manual (local, !auto_mode): title, folder, dates, status chips (only if
//     caps.canEdit), notes COLLAPSED beyond ~8 lines with a "Show more" expand
//     + inner scroll when expanded (fixes the standing complaint about
//     unreadable long notes), Edit/Open tab/Terminal/Go to folder, Delete.
//
//   Agent — TypeBuild: lazy-fetch the full row on focus via getTask(id,
//     'typebuild') to get the DECRYPTED body; held in component state ONLY and
//     cleared on unmount / task change (PHI — never persist or log). Lifecycle
//     block (rawStatus, claimedBy, attempts, priority), the mirrored primary
//     action, Release (claimedBy===myEmail), Reopen (blocked), Mark complete.
//     NO delete, NO status chips.
//
//   Agent — local auto: the manual layout plus an agent prompt block, run
//     history, and the primary action (Run now / View run / Open session).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getTask,
  listTypebuildUsers,
  taskSourceAction,
  todayISO,
  useTaskRuns,
} from '../../tasks';
import { useStore } from '../../store';
import { formatOpError, formatSourceReason } from '../../errorMessages';
import { TaskRunIndicator, TaskStatusDot } from '../TaskIndicators';
import { PrimaryActionButton } from './PrimaryActionButton';
import { STATUS_LABEL, homeRel, shortDate } from './helpers';
import { claimSummary } from './lifecycle.mjs';
import { TaskTimeline } from './TaskTimeline';
import type { PrimaryAction } from './primaryAction.mjs';
import type {
  Task,
  TaskSourceCapabilities,
  TaskStatus,
  TaskUser,
} from '../../types';

const NOTES_COLLAPSE_LINES = 8;

export function TaskDetailPanel({
  task,
  caps,
  primary,
  myEmail,
  selectedCount,
  onPrimary,
  onEdit,
  onOpenInTab,
  onOpenTerminal,
  onGotoFolder,
  onSetStatus,
  onTogglePin,
  onDelete,
  onSourceAction,
  onOpenRuns,
  onOpenDetail,
}: {
  task: Task | null;
  caps?: TaskSourceCapabilities;
  primary: PrimaryAction | null;
  myEmail: string | null;
  selectedCount: number;
  onPrimary: (action: PrimaryAction) => void;
  onEdit: () => void;
  onOpenInTab: () => void;
  onOpenTerminal: () => void;
  onGotoFolder: () => void;
  onSetStatus: (s: TaskStatus) => void;
  onTogglePin: () => void;
  onDelete: () => void;
  onSourceAction: (action: 'release' | 'reopen' | 'complete' | 'cancel') => void;
  onOpenRuns: () => void;
  // task-5e9d866a377f — open the full detail DRAWER (Trace · Config · Session).
  onOpenDetail: (tab?: 'trace' | 'config' | 'session') => void;
}) {
  if (selectedCount > 1) {
    return (
      <aside className="tasks__detail tasks__detail--empty">
        <div className="tasks__detail-empty">
          <div className="tasks__detail-empty-glyph">⊞</div>
          <div className="tasks__detail-empty-title">{selectedCount} selected</div>
          <div className="tasks__detail-empty-body">
            Type <kbd>:</kbd> to act on the selection — <code>:done</code>,{' '}
            <code>:due</code>, <code>:delete</code>.
          </div>
        </div>
      </aside>
    );
  }
  if (!task) {
    return (
      <aside className="tasks__detail tasks__detail--empty">
        <div className="tasks__detail-empty">
          <div className="tasks__detail-empty-glyph">·</div>
          <div className="tasks__detail-empty-title">No task selected</div>
          <div className="tasks__detail-empty-body">
            Pick a row to see its details. ↑↓ to move, <kbd>Enter</kbd> to edit.
          </div>
        </div>
      </aside>
    );
  }

  const isTypebuild = task.source === 'typebuild';
  if (isTypebuild) {
    return (
      <AgentDetail
        task={task}
        caps={caps}
        primary={primary}
        myEmail={myEmail}
        onPrimary={onPrimary}
        onOpenInTab={onOpenInTab}
        onGotoFolder={onGotoFolder}
        onSourceAction={onSourceAction}
        onDelete={onDelete}
        onOpenDetail={onOpenDetail}
      />
    );
  }

  return (
    <ManualDetail
      task={task}
      caps={caps}
      primary={primary}
      onPrimary={onPrimary}
      onEdit={onEdit}
      onOpenInTab={onOpenInTab}
      onOpenTerminal={onOpenTerminal}
      onGotoFolder={onGotoFolder}
      onSetStatus={onSetStatus}
      onTogglePin={onTogglePin}
      onDelete={onDelete}
      onOpenRuns={onOpenRuns}
      onOpenDetail={onOpenDetail}
    />
  );
}

// ── collapsible notes ──────────────────────────────────────────────────────
function CollapsibleNotes({ notes }: { notes: string }) {
  const [expanded, setExpanded] = useState(false);
  const lineCount = notes.split('\n').length;
  const longByChars = notes.length > 400;
  const collapsible = lineCount > NOTES_COLLAPSE_LINES || longByChars;
  return (
    <div className="tasks__detail-notes">
      <div className="tasks__detail-section">Notes</div>
      <p
        className={[
          'tasks__detail-notes-body',
          collapsible && !expanded && 'tasks__detail-notes-body--clamped',
          expanded && 'tasks__detail-notes-body--scroll',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {notes}
      </p>
      {collapsible && (
        <button
          type="button"
          className="tasks__notes-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

// ── manual (and local-auto) detail ──────────────────────────────────────────
function ManualDetail({
  task,
  caps,
  primary,
  onPrimary,
  onEdit,
  onOpenInTab,
  onOpenTerminal,
  onGotoFolder,
  onSetStatus,
  onTogglePin,
  onDelete,
  onOpenRuns,
  onOpenDetail,
}: {
  task: Task;
  caps?: TaskSourceCapabilities;
  primary: PrimaryAction | null;
  onPrimary: (action: PrimaryAction) => void;
  onEdit: () => void;
  onOpenInTab: () => void;
  onOpenTerminal: () => void;
  onGotoFolder: () => void;
  onSetStatus: (s: TaskStatus) => void;
  onTogglePin: () => void;
  onDelete: () => void;
  onOpenRuns: () => void;
  onOpenDetail: (tab?: 'trace' | 'config' | 'session') => void;
}) {
  const today = todayISO();
  const overdue =
    !!task.due_at &&
    task.due_at < today &&
    task.status !== 'done' &&
    task.status !== 'cancelled';
  const canEdit = caps ? caps.canEdit : true;
  const canDelete = caps ? caps.canDelete : true;
  const runs = useTaskRuns(task.auto_mode ? task.id : null, 8);

  return (
    <aside className="tasks__detail">
      <header className="tasks__detail-head">
        <div className="tasks__detail-status">
          {/* fm-mhtz — status is the colored dot + tooltip only; the text label
              was the redundant half of the old two-semantic display. */}
          <TaskStatusDot
            status={task.status}
            rawStatus={task.rawStatus ?? null}
          />
          {task.auto_mode && (
            <TaskRunIndicator task={task} onClick={onOpenRuns} />
          )}
        </div>
        {canEdit && (
          <button
            type="button"
            className={['tasks__pin', task.pinned && 'tasks__pin--on']
              .filter(Boolean)
              .join(' ')}
            onClick={onTogglePin}
            title={task.pinned ? 'Unpin' : 'Pin'}
          >
            {task.pinned ? '★' : '☆'}
          </button>
        )}
      </header>

      <h2 className="tasks__detail-title">{task.title}</h2>

      {primary && primary.kind !== 'none' && (
        <div className="tasks__detail-primary">
          <PrimaryActionButton action={primary} onInvoke={onPrimary} variant="detail" />
        </div>
      )}

      <dl className="tasks__detail-meta">
        {task.folder && (
          <div>
            <dt>Folder</dt>
            <dd className="tasks__detail-mono" title={task.folder}>
              {homeRel(task.folder)}
            </dd>
          </div>
        )}
        {task.start_at && (
          <div>
            <dt>Start</dt>
            <dd>{shortDate(task.start_at, today)}</dd>
          </div>
        )}
        {task.due_at && (
          <div>
            <dt>Due</dt>
            <dd className={overdue ? 'tasks__detail-overdue' : undefined}>
              {shortDate(task.due_at, today)}
            </dd>
          </div>
        )}
        {task.auto_mode && (
          <>
            <div>
              <dt>Agent</dt>
              <dd>{task.auto_agent || '—'}</dd>
            </div>
            {task.cron && (
              <div>
                <dt>Schedule</dt>
                <dd className="tasks__detail-mono">{task.cron}</dd>
              </div>
            )}
          </>
        )}
      </dl>

      {task.notes && <CollapsibleNotes notes={task.notes} />}

      {task.auto_mode && task.auto_prompt && (
        <div className="tasks__detail-notes">
          <div className="tasks__detail-section">Prompt</div>
          <pre className="tasks__detail-prompt">{task.auto_prompt}</pre>
        </div>
      )}

      {task.auto_mode && runs.length > 0 && (
        <div className="tasks__detail-notes">
          <div className="tasks__detail-section">Recent runs</div>
          <ul className="tasks__detail-runs">
            {runs.map((r) => (
              <li key={r.id} className="tasks__detail-run">
                <span className={`tasks__run-status tasks__run-status--${r.status}`}>
                  {r.status}
                </span>
                <span className="tasks__detail-mono">
                  {new Date(r.scheduled_for).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
          <button type="button" className="tasks__btn tasks__btn--ghost" onClick={onOpenRuns}>
            Run history…
          </button>
        </div>
      )}

      <div className="tasks__detail-actions">
        <button
          type="button"
          className="tasks__btn"
          onClick={() => onOpenDetail()}
          title="Open the full detail drawer (Trace · Config · Session)"
        >
          Open ↗
        </button>
        {canEdit && (
          <button type="button" className="tasks__btn" onClick={onEdit}>
            Edit
          </button>
        )}
        <button type="button" className="tasks__btn" onClick={onOpenInTab}>
          Open tab
        </button>
        <button type="button" className="tasks__btn" onClick={onOpenTerminal}>
          Terminal
        </button>
        {task.folder && (
          <button type="button" className="tasks__btn" onClick={onGotoFolder}>
            Go to folder
          </button>
        )}
      </div>

      {canEdit && (
        <>
          <div className="tasks__detail-section tasks__detail-section--spaced">Status</div>
          {/* fm-mhtz — set-status controls are icon-only too: a colored dot per
              status with the label in the tooltip. They carry an elevated /
              raised button look (and a pressed state for the current status) so
              they still read clearly as clickable, not as passive dots. */}
          <div className="tasks__detail-statusrow" role="group" aria-label="Set status">
            {(['pending', 'in_progress', 'done', 'cancelled'] as TaskStatus[]).map((s) => (
              <button
                key={s}
                type="button"
                className={['tasks__status-btn', task.status === s && 'tasks__status-btn--on']
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => onSetStatus(s)}
                aria-pressed={task.status === s}
                aria-label={`Set ${STATUS_LABEL[s]}`}
                title={`Set ${STATUS_LABEL[s]}`}
              >
                <TaskStatusDot status={s} />
              </button>
            ))}
          </div>
        </>
      )}

      {canDelete && (
        <div className="tasks__detail-foot">
          <button type="button" className="tasks__btn tasks__btn--danger" onClick={onDelete}>
            Delete…
          </button>
        </div>
      )}
    </aside>
  );
}

// ── agent (TypeBuild) detail ────────────────────────────────────────────────
function AgentDetail({
  task,
  caps,
  primary,
  myEmail,
  onPrimary,
  onOpenInTab,
  onGotoFolder,
  onSourceAction,
  onDelete,
  onOpenDetail,
}: {
  task: Task;
  caps?: TaskSourceCapabilities;
  primary: PrimaryAction | null;
  myEmail: string | null;
  onPrimary: (action: PrimaryAction) => void;
  onOpenInTab: () => void;
  onGotoFolder: () => void;
  onSourceAction: (action: 'release' | 'reopen' | 'complete' | 'cancel') => void;
  onDelete: () => void;
  onOpenDetail: (tab?: 'trace' | 'config' | 'session') => void;
}) {
  const { dispatch } = useStore();
  const say = useCallback(
    (msg: string) => dispatch({ type: 'setStatus', msg }),
    [dispatch],
  );

  // PHI: the decrypted body is fetched lazily and held in component state
  // ONLY. We clear it on task change / unmount and never write it anywhere.
  const [body, setBody] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const reqIdRef = useRef(0);

  // fm-j7w0 (S4) — write a whitelisted field edit (assigned_to/priority/...)
  // via the generic 'patch' source action. The typebuild source patches its
  // cache + broadcasts on success, so the row re-pulls; a rejection comes back
  // as { ok:false, reason } which we humanize into the status line.
  const patchField = useCallback(
    async (fields: Record<string, unknown>, label: string) => {
      try {
        const res = (await taskSourceAction(
          'typebuild',
          task.id,
          'patch',
          fields,
        )) as { ok?: boolean; reason?: string; claimedBy?: string | null } | undefined;
        if (res && res.ok === false) {
          say(`couldn’t update · ${formatSourceReason(res.reason, { claimedBy: res.claimedBy })}`);
          return;
        }
        say(label);
      } catch (e) {
        say(formatOpError('update', e));
      }
    },
    [task.id, say],
  );

  useEffect(() => {
    const myReq = ++reqIdRef.current;
    setBody(null);
    setBodyLoading(true);
    let cancelled = false;
    void getTask(task.id, 'typebuild')
      .then((full) => {
        if (cancelled || reqIdRef.current !== myReq) return;
        // Only the notes/body field carries PHI; ignore everything else here.
        setBody(full?.notes ?? null);
      })
      .catch(() => {
        if (!cancelled && reqIdRef.current === myReq) setBody(null);
      })
      .finally(() => {
        if (!cancelled && reqIdRef.current === myReq) setBodyLoading(false);
      });
    return () => {
      cancelled = true;
      // Drop the decrypted body the instant we leave this task.
      setBody(null);
    };
  }, [task.id]);

  const claimedBy = task.claimedBy ?? null;
  const claimedByMe = !!claimedBy && claimedBy === myEmail;
  const canClaim = !!caps?.canClaim;
  // fm-alfz (S1) — lifecycle affordances. The smart `reopen` action routes
  // 'blocked' through the legacy /reopen and every other terminal state
  // through PATCH {status:'open'}.
  const raw = task.rawStatus ?? task.status;
  const isBlocked = raw === 'blocked';
  // Terminal states the user can reopen: done | partial | cancelled | failed
  // (blocked is handled by its own legacy path but uses the same Reopen verb).
  const canReopen =
    raw === 'done' ||
    raw === 'partial' ||
    raw === 'cancelled' ||
    raw === 'failed' ||
    isBlocked;
  // Cancel is offered for any NON-terminal state (open/in_progress/blocked/
  // failed). done/partial/cancelled are already terminal — nothing to cancel.
  const isTerminalRaw =
    raw === 'done' || raw === 'partial' || raw === 'cancelled';
  const canCancel = !isTerminalRaw;

  return (
    <aside className="tasks__detail">
      <header className="tasks__detail-head">
        <div className="tasks__detail-status">
          {/* fm-mhtz — status dot carries the raw TypeBuild status in its
              tooltip; the "Status" meta row below is dropped (it was the text
              duplicate that conflicted with the dot). */}
          <TaskStatusDot status={task.status} rawStatus={task.rawStatus ?? null} />
          <span className="tasks__detail-source-badge">TypeBuild</span>
        </div>
      </header>

      <h2 className="tasks__detail-title">{task.title}</h2>

      {primary && primary.kind !== 'none' && (
        <div className="tasks__detail-primary">
          <PrimaryActionButton action={primary} onInvoke={onPrimary} variant="detail" />
        </div>
      )}
      {primary && primary.kind === 'none' && primary.note && (
        <div className="tasks__detail-primary">
          <span className="tasks__primary-note">◆ {primary.note}</span>
        </div>
      )}

      <dl className="tasks__detail-meta">
        {/* fm-mhtz — the "Status" text row was dropped; the colored dot in the
            header (with the raw status in its tooltip) is the status signal. */}
        {claimedBy && (
          <div>
            <dt>Claimed</dt>
            {/* task-b8306d2b85c2 — claim FRESHNESS, not just ownership: who +
                relative age + a near-expiry flag against the 2h claim TTL. */}
            <dd>
              <ClaimFreshnessLine
                claimedBy={claimedBy}
                claimedByMe={claimedByMe}
                claimedAt={task.claimedAt ?? null}
              />
            </dd>
          </div>
        )}
        {/* fm-j7w0 (S4) — assignee row + lazy picker. */}
        <div>
          <dt>Assignee</dt>
          <dd>
            <AssigneePicker
              value={task.assignedTo ?? null}
              myEmail={myEmail}
              onChange={(principal) =>
                void patchField(
                  { assigned_to: principal },
                  principal ? `assigned to ${principal}` : 'assignee cleared',
                )
              }
            />
          </dd>
        </div>
        {/* fm-j7w0 (S4) — editable priority via a compact stepper. */}
        <div>
          <dt>Priority</dt>
          <dd>
            <PriorityStepper
              value={typeof task.priority === 'number' ? task.priority : 0}
              onChange={(p) => void patchField({ priority: p }, `priority ${p}`)}
            />
          </dd>
        </div>
        {(typeof task.attempts === 'number' || typeof task.maxAttempts === 'number') && (
          <div>
            <dt>Attempts</dt>
            <dd>
              {task.attempts ?? 0}
              {typeof task.maxAttempts === 'number' ? ` / ${task.maxAttempts}` : ''}
            </dd>
          </div>
        )}
      </dl>

      <div className="tasks__detail-notes">
        <div className="tasks__detail-section">Details</div>
        {bodyLoading ? (
          <p className="tasks__detail-notes-body tasks__detail-muted">Loading…</p>
        ) : body ? (
          <p className="tasks__detail-notes-body tasks__detail-notes-body--scroll">{body}</p>
        ) : (
          <p className="tasks__detail-notes-body tasks__detail-muted">No details.</p>
        )}
      </div>

      <div className="tasks__detail-actions">
        <button
          type="button"
          className="tasks__btn"
          onClick={() => onOpenDetail()}
          title="Open the full detail drawer (Trace · Config · Session)"
        >
          Open ↗
        </button>
        <button type="button" className="tasks__btn" onClick={onOpenInTab}>
          Open tab
        </button>
        {task.folder && (
          <button type="button" className="tasks__btn" onClick={onGotoFolder}>
            Go to folder
          </button>
        )}
      </div>

      <div className="tasks__detail-section tasks__detail-section--spaced">Lifecycle</div>
      <div className="tasks__detail-actions">
        {canClaim && claimedByMe && (
          <button
            type="button"
            className="tasks__btn"
            onClick={() => onSourceAction('release')}
          >
            Release claim
          </button>
        )}
        {/* fm-alfz (S1) — Mark complete only while there's something to
            complete (non-terminal); a terminal row offers Reopen instead. */}
        {!isTerminalRaw && (
          <button
            type="button"
            className="tasks__btn"
            onClick={() => onSourceAction('complete')}
          >
            Mark complete
          </button>
        )}
        {canCancel && (
          <button
            type="button"
            className="tasks__btn"
            onClick={() => onSourceAction('cancel')}
          >
            Cancel
          </button>
        )}
        {canReopen && (
          <button
            type="button"
            className="tasks__btn"
            onClick={() => onSourceAction('reopen')}
          >
            Reopen
          </button>
        )}
      </div>

      {/* task-b8306d2b85c2 — lifecycle timeline (Created → Claimed → status
          transitions), folded from the per-task audit trail. Supersedes the
          old flat "History" list. */}
      <TaskTimeline task={task} />

      {/* fm-iwlc (S6) — Delete (creator-only server-side; a 403 not_owner /
          409 in_progress_elsewhere surfaces a distinct status-line reason).
          Routed through the same fm:confirm destructive dialog as local. */}
      {caps?.canDelete && (
        <div className="tasks__detail-foot">
          <button type="button" className="tasks__btn tasks__btn--danger" onClick={onDelete}>
            Delete…
          </button>
        </div>
      )}
    </aside>
  );
}

// ── assignee picker (fm-j7w0/S4) ────────────────────────────────────────────
// A small select populated LAZILY from the user registry on first open. The
// current value renders as the closed-state label even before the list loads
// (so a known assignee shows immediately); the option list fills in on open.
// "Unassigned" maps to '' which the patch action sends as a clear. Identities
// are NON-PHI, so rendering emails is fine.
function AssigneePicker({
  value,
  myEmail,
  onChange,
}: {
  value: string | null;
  myEmail: string | null;
  onChange: (principal: string) => void;
}) {
  const [users, setUsers] = useState<TaskUser[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadUsers = useCallback(() => {
    if (users !== null || loading) return;
    setLoading(true);
    void listTypebuildUsers()
      .then((list) => setUsers(list))
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }, [users, loading]);

  // Build the option set: always include Unassigned + the current value (so
  // the closed select shows it pre-load), then merge the fetched registry.
  const seen = new Set<string>();
  const options: Array<{ principal: string; label: string }> = [];
  const push = (principal: string, label: string) => {
    if (seen.has(principal)) return;
    seen.add(principal);
    options.push({ principal, label });
  };
  if (value) push(value, value === myEmail ? `${value} (you)` : value);
  for (const u of users ?? []) {
    const label = u.email || u.principal;
    push(u.principal, u.principal === myEmail ? `${label} (you)` : label);
  }

  return (
    <select
      className="tasks__detail-assignee"
      value={value ?? ''}
      onFocus={loadUsers}
      onMouseDown={loadUsers}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Unassigned</option>
      {options.map((o) => (
        <option key={o.principal} value={o.principal}>
          {o.label}
        </option>
      ))}
      {loading && <option disabled>Loading…</option>}
    </select>
  );
}

// ── priority stepper (fm-j7w0/S4) ───────────────────────────────────────────
// A compact − N + control. Clamped to a sane non-negative range; the server
// stores any integer but the UI keeps it tidy. Writes on each step.
function PriorityStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (p: number) => void;
}) {
  const set = (next: number) => {
    const clamped = Math.max(0, Math.min(99, next));
    if (clamped !== value) onChange(clamped);
  };
  return (
    <span className="tasks__detail-priority">
      <button
        type="button"
        className="tasks__priority-step"
        aria-label="Lower priority"
        onClick={() => set(value - 1)}
        disabled={value <= 0}
      >
        −
      </button>
      <span className="tasks__priority-value">{value}</span>
      <button
        type="button"
        className="tasks__priority-step"
        aria-label="Raise priority"
        onClick={() => set(value + 1)}
      >
        +
      </button>
    </span>
  );
}

// ── claim freshness line (task-b8306d2b85c2) ────────────────────────────────
// "you · 12m ago" / "alice · 1h 50m ago (expires soon)". Re-renders on a 60s
// tick so the relative age stays honest while the panel is open. The summary
// math lives in the pure lifecycle.mjs helper (shared with the row tooltip).
function ClaimFreshnessLine({
  claimedBy,
  claimedByMe,
  claimedAt,
}: {
  claimedBy: string | null;
  claimedByMe: boolean;
  claimedAt: string | null;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(h);
  }, []);
  // claimSummary already prefixes "claimed by …"; strip it for the <dd> since
  // the <dt> already reads "Claimed".
  const summary = claimSummary(claimedBy, claimedByMe, claimedAt).replace(
    /^claimed by /,
    '',
  );
  const expiry = /expires soon|lapsed/.test(summary);
  return (
    <span className={expiry ? 'tasks__claim-expiry' : undefined}>{summary}</span>
  );
}
