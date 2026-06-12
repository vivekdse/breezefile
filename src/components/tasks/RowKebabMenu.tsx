// fm-7909 — per-row "more actions" popover. The page now shows ONE primary
// action per row; everything else lives here (pin, edit, open-tab,
// status-cycle, due presets, go-to-folder, schedule, delete) plus the
// source-native verbs for TypeBuild (Release when you hold it, Mark complete,
// Cancel, Reopen). Fully capability-gated: an item the owning source can't
// perform is never rendered, so a click is never a silent no-op.
//
// fm-alfz (S1) — the v2 PATCH management verb shipped, so the previously
// deferred reopen-from-done/cancelled is now a real kebab action.

import { useEffect } from 'react';
import type { RemoteSchedule, Task, TaskSourceCapabilities } from '../../types';

export type KebabAction =
  | 'edit'
  | 'open-tab'
  | 'open-terminal'
  | 'mark-pending'
  | 'mark-in-progress'
  | 'mark-done'
  | 'mark-cancelled'
  | 'pin'
  | 'goto-folder'
  | 'due-today'
  | 'due-tomorrow'
  | 'due-friday'
  | 'due-next-week'
  | 'due-clear'
  | 'schedule'
  | 'release'
  | 'complete'
  // fm-alfz (S1) — TypeBuild source verbs via PATCH /chromeext/{id}.
  | 'tb-cancel'
  | 'tb-reopen'
  | 'delete';

export function RowKebabMenu({
  task,
  caps,
  schedule,
  myEmail,
  x,
  y,
  onClose,
  onAction,
}: {
  task: Task;
  caps?: TaskSourceCapabilities;
  schedule?: RemoteSchedule;
  myEmail: string | null;
  x: number;
  y: number;
  onClose: () => void;
  onAction: (action: KebabAction) => void;
}) {
  const canEdit = caps ? caps.canEdit : true;
  const canDelete = caps ? caps.canDelete : true;
  const canClaim = !!caps?.canClaim;
  const isTypebuild = task.source === 'typebuild';
  const claimedBy = task.claimedBy ?? null;
  // A remote source that can't schedule natively (TypeBuild) can still get a
  // LOCAL cron overlay.
  const canOverlaySchedule =
    !!task.source && task.source !== 'local' && !!caps && !caps.canSchedule;

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.tasks__kebab')) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const style = {
    left: Math.min(x, window.innerWidth - 240),
    top: Math.min(y, window.innerHeight - 460),
  };

  const isClosed = task.status === 'done' || task.status === 'cancelled';

  return (
    <div className="tasks__kebab" style={style} role="menu">
      {canEdit && (
        <button className="tasks__kebab-item" onClick={() => onAction('edit')}>
          Edit…
        </button>
      )}
      <button className="tasks__kebab-item" onClick={() => onAction('open-tab')}>
        Open in task tab
      </button>
      <button className="tasks__kebab-item" onClick={() => onAction('open-terminal')}>
        Open terminal
      </button>

      {/* fm-7909 / fm-alfz (S1) — TypeBuild source verbs via PATCH. Release
          only when YOU hold the claim. Mark complete + Cancel on non-terminal
          rows; Reopen on terminal rows (done/partial/cancelled/failed/blocked). */}
      {isTypebuild &&
        (() => {
          const raw = task.rawStatus ?? task.status;
          const isTerminalRaw =
            raw === 'done' || raw === 'partial' || raw === 'cancelled';
          const canReopen =
            raw === 'done' ||
            raw === 'partial' ||
            raw === 'cancelled' ||
            raw === 'failed' ||
            raw === 'blocked';
          return (
            <>
              <div className="tasks__kebab-sep" />
              {canClaim && claimedBy && claimedBy === myEmail && (
                <button className="tasks__kebab-item" onClick={() => onAction('release')}>
                  Release claim
                </button>
              )}
              {!isTerminalRaw && (
                <button className="tasks__kebab-item" onClick={() => onAction('complete')}>
                  Mark complete
                </button>
              )}
              {!isTerminalRaw && (
                <button className="tasks__kebab-item" onClick={() => onAction('tb-cancel')}>
                  Cancel
                </button>
              )}
              {canReopen && (
                <button className="tasks__kebab-item" onClick={() => onAction('tb-reopen')}>
                  Reopen
                </button>
              )}
            </>
          );
        })()}

      {canEdit && (
        <>
          <div className="tasks__kebab-sep" />
          <div className="tasks__kebab-section">Status</div>
          {task.status !== 'pending' && (
            <button className="tasks__kebab-item" onClick={() => onAction('mark-pending')}>
              Pending
            </button>
          )}
          {task.status !== 'in_progress' && (
            <button className="tasks__kebab-item" onClick={() => onAction('mark-in-progress')}>
              In progress
            </button>
          )}
          {!isClosed && (
            <button className="tasks__kebab-item" onClick={() => onAction('mark-done')}>
              Done
            </button>
          )}
          {task.status !== 'cancelled' && (
            <button className="tasks__kebab-item" onClick={() => onAction('mark-cancelled')}>
              Cancelled
            </button>
          )}
          <div className="tasks__kebab-sep" />
          <div className="tasks__kebab-section">Set due</div>
          <button className="tasks__kebab-item" onClick={() => onAction('due-today')}>
            Today
          </button>
          <button className="tasks__kebab-item" onClick={() => onAction('due-tomorrow')}>
            Tomorrow
          </button>
          <button className="tasks__kebab-item" onClick={() => onAction('due-friday')}>
            Friday
          </button>
          <button className="tasks__kebab-item" onClick={() => onAction('due-next-week')}>
            Next week
          </button>
          {task.due_at && (
            <button className="tasks__kebab-item" onClick={() => onAction('due-clear')}>
              Clear due date
            </button>
          )}
          <div className="tasks__kebab-sep" />
          <button className="tasks__kebab-item" onClick={() => onAction('pin')}>
            {task.pinned ? 'Unpin' : 'Pin'}
          </button>
        </>
      )}

      {!canEdit && <div className="tasks__kebab-sep" />}
      {task.folder && (
        <button className="tasks__kebab-item" onClick={() => onAction('goto-folder')}>
          Go to folder
        </button>
      )}
      {canOverlaySchedule && (
        <button className="tasks__kebab-item" onClick={() => onAction('schedule')}>
          {schedule ? `Schedule… (⏰ ${schedule.cron})` : 'Schedule…'}
        </button>
      )}

      {canDelete && (
        <>
          <div className="tasks__kebab-sep" />
          <button
            className="tasks__kebab-item tasks__kebab-item--danger"
            onClick={() => onAction('delete')}
          >
            Delete…
          </button>
        </>
      )}
    </div>
  );
}
