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

import { useEffect, useRef, useState } from 'react';
import { getTask, todayISO, useTaskRuns } from '../../tasks';
import { TaskRunIndicator, TaskStatusDot } from '../TaskIndicators';
import { PrimaryActionButton } from './PrimaryActionButton';
import { STATUS_LABEL, homeRel, shortDate } from './helpers';
import type { PrimaryAction } from './primaryAction.mjs';
import type { Task, TaskSourceCapabilities, TaskStatus } from '../../types';

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
          <TaskStatusDot status={task.status} />
          <span>{STATUS_LABEL[task.status]}</span>
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
          <div className="tasks__detail-statusrow">
            {(['pending', 'in_progress', 'done', 'cancelled'] as TaskStatus[]).map((s) => (
              <button
                key={s}
                type="button"
                className={['tasks__chip', task.status === s && 'tasks__chip--on']
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => onSetStatus(s)}
              >
                {STATUS_LABEL[s]}
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
}: {
  task: Task;
  caps?: TaskSourceCapabilities;
  primary: PrimaryAction | null;
  myEmail: string | null;
  onPrimary: (action: PrimaryAction) => void;
  onOpenInTab: () => void;
  onGotoFolder: () => void;
  onSourceAction: (action: 'release' | 'reopen' | 'complete' | 'cancel') => void;
}) {
  // PHI: the decrypted body is fetched lazily and held in component state
  // ONLY. We clear it on task change / unmount and never write it anywhere.
  const [body, setBody] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const reqIdRef = useRef(0);

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
          <TaskStatusDot status={task.status} />
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
        <div>
          <dt>Status</dt>
          <dd>{task.rawStatus ?? task.status}</dd>
        </div>
        {claimedBy && (
          <div>
            <dt>Claimed by</dt>
            <dd>{claimedByMe ? 'you' : claimedBy}</dd>
          </div>
        )}
        {typeof task.priority === 'number' && (
          <div>
            <dt>Priority</dt>
            <dd>{task.priority}</dd>
          </div>
        )}
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
    </aside>
  );
}
