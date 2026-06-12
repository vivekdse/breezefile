// fm-7909 — one row, one primary action. Layout:
//   [checkbox] [status glyph + title + rawStatus badge] [meta] [PRIMARY] [⋮]
// Pin, edit, open-tab, status-cycle all moved into the kebab. Row click moves
// the cursor (selection); Enter / double-click opens edit (manual) or focuses
// the detail panel (agent — edit is unsupported there).

import type { PrimaryAction } from './primaryAction.mjs';
import { PrimaryActionButton } from './PrimaryActionButton';
import { homeRel, shortDate } from './helpers';
import { TaskRunIndicator, TaskStatusDot } from '../TaskIndicators';
import type { RemoteSchedule, Task } from '../../types';

export function TaskRow({
  task,
  today,
  primary,
  schedule,
  runCount,
  hideFolder,
  selected,
  cursor,
  myEmail,
  onCheckbox,
  onClick,
  onDoubleClick,
  onPrimary,
  onKebab,
  onOpenRuns,
}: {
  task: Task;
  today: string;
  primary: PrimaryAction;
  schedule?: RemoteSchedule;
  runCount: number;
  hideFolder?: boolean;
  selected: boolean;
  cursor: boolean;
  myEmail: string | null;
  onCheckbox: () => void;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onPrimary: (action: PrimaryAction) => void;
  onKebab: (x: number, y: number) => void;
  onOpenRuns: () => void;
}) {
  const overdue =
    !!task.due_at &&
    task.due_at < today &&
    task.status !== 'done' &&
    task.status !== 'cancelled';
  const isClosed = task.status === 'done' || task.status === 'cancelled';
  // Source-native status that didn't map into the local enum (TypeBuild
  // failed/partial/blocked/done).
  const rawBadge =
    task.rawStatus && task.rawStatus !== task.status ? task.rawStatus : null;
  const claimedBy = task.claimedBy ?? null;
  const claimedByMe = !!claimedBy && claimedBy === myEmail;
  // fm-lji6 (S2) — a deferred TypeBuild task (defer_until in the future) isn't
  // claimable by claim-next until then; show a snooze pill so it reads as
  // "asleep" rather than just idle. deferUntil is a full ISO timestamp.
  const deferredUntil =
    task.deferUntil && new Date(task.deferUntil).getTime() > Date.now()
      ? task.deferUntil
      : null;

  return (
    <div
      role="listitem"
      data-task-id={task.id}
      className={[
        'tasks__row',
        selected && 'tasks__row--selected',
        cursor && 'tasks__row--cursor',
        isClosed && 'tasks__row--muted',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <label
        className="tasks__row-check"
        onClick={(e) => e.stopPropagation()}
        title={selected ? 'Unselect' : 'Select'}
      >
        <input type="checkbox" checked={selected} onChange={onCheckbox} />
      </label>

      <div className="tasks__row-main">
        <div className="tasks__row-title">
          <TaskStatusDot status={task.status} />
          {task.pinned && (
            <span className="tasks__row-pin-mark" aria-label="Pinned" title="Pinned">
              ★
            </span>
          )}
          <span className="tasks__row-title-text">{task.title}</span>
          {rawBadge && (
            <span
              className="tasks__raw-status"
              title={`Source status: ${rawBadge}`}
            >
              {rawBadge}
            </span>
          )}
        </div>
        <div className="tasks__row-sub">
          {!hideFolder && task.folder && (
            <span className="tasks__row-folder" title={task.folder}>
              {homeRel(task.folder)}
            </span>
          )}
          {claimedBy && (
            <span
              className={[
                'tasks__row-claimed',
                claimedByMe && 'tasks__row-claimed--me',
              ]
                .filter(Boolean)
                .join(' ')}
              title={claimedByMe ? 'Claimed by you' : `Claimed by ${claimedBy}`}
            >
              ◆ {claimedByMe ? 'you' : claimedBy}
            </span>
          )}
          {schedule && (
            <span
              className="tasks__row-schedule"
              title={`Scheduled (local cron): ${schedule.cron} · next ${new Date(
                schedule.nextRunAt,
              ).toLocaleString()}`}
            >
              ⏰ {schedule.cron}
            </span>
          )}
          {task.start_at && (
            <span className="tasks__date">start {shortDate(task.start_at, today)}</span>
          )}
          {task.due_at && (
            <span
              className={['tasks__date', overdue && 'tasks__date--overdue']
                .filter(Boolean)
                .join(' ')}
            >
              due {shortDate(task.due_at, today)}
            </span>
          )}
          {deferredUntil && (
            <span
              className="tasks__date tasks__date--deferred"
              title={`Deferred — not claimable until ${new Date(
                deferredUntil,
              ).toLocaleString()}`}
            >
              deferred until {shortDate(deferredUntil.slice(0, 10), today)}
            </span>
          )}
          {task.auto_mode && (
            <TaskRunIndicator task={task} onClick={onOpenRuns} />
          )}
          {runCount > 0 && (
            <button
              type="button"
              className="tasks__runs-pill"
              onClick={(e) => {
                e.stopPropagation();
                onOpenRuns();
              }}
              title={`${runCount} past run${runCount === 1 ? '' : 's'} — click to open history`}
            >
              {runCount} run{runCount === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>

      <div className="tasks__row-primary" onClick={(e) => e.stopPropagation()}>
        <PrimaryActionButton action={primary} onInvoke={onPrimary} variant="row" />
      </div>

      <div className="tasks__row-actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="tasks__row-btn"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onKebab(r.right, r.bottom);
          }}
          title="More actions"
          aria-label="More"
          aria-haspopup="menu"
        >
          ⋮
        </button>
      </div>
    </div>
  );
}
