// fm-7909 — one row, one primary action. Layout:
//   [checkbox] [status glyph + title + rawStatus badge] [meta] [PRIMARY] [⋮]
// Pin, edit, open-tab, status-cycle all moved into the kebab. Row click moves
// the cursor (selection); Enter / double-click opens edit (manual) or focuses
// the detail panel (agent — edit is unsupported there).

import type { PrimaryAction } from './primaryAction.mjs';
import { PrimaryActionButton } from './PrimaryActionButton';
import { homeRel, shortDate } from './helpers';
import { claimSummary, claimFreshness } from './lifecycle.mjs';
import { classify } from '../../projects/attention.mjs';
import { TaskStatusDot } from '../TaskIndicators';
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
  depth,
  childCount,
  doneChildCount,
  visibleChildCount,
  expanded,
  onToggleExpand,
  blockedByTitles,
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
  // fm-bq86 (S3) — parent/child grouping. depth 1 rows indent under a parent.
  depth?: 0 | 1;
  /** Parent rows: total children grouped beneath. */
  childCount?: number;
  /** Parent rows: how many of those children are terminal. */
  doneChildCount?: number;
  /** fm-8yky — parent rows: children that actually render in-section (drives
   *  the disclosure toggle; the chip still shows done/total via childCount). */
  visibleChildCount?: number;
  /** fm-8yky — parent rows: whether the child subtree is expanded. */
  expanded?: boolean;
  /** fm-8yky — parent rows: toggle the child subtree open/closed. */
  onToggleExpand?: () => void;
  /** Dependency presentation: resolved titles of blocking tasks (if known). */
  blockedByTitles?: string[];
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
  // task-9907ba321561 — the dimmed (muted) row is the ONLY visual that's
  // unexplained: bright = open/in-progress/blocked/failed, dull = closed.
  // Give the whole row a tooltip on hover so the dimming is self-explanatory,
  // and distinguish cancelled from done (they look identical otherwise).
  const closedTooltip = isClosed
    ? task.status === 'cancelled'
      ? 'Cancelled — closed without completing (dimmed)'
      : 'Done — completed (dimmed)'
    : undefined;
  // Source-native status that didn't map into the local enum (TypeBuild
  // failed/partial/blocked/done).
  const rawBadge =
    task.rawStatus && task.rawStatus !== task.status ? task.rawStatus : null;
  const claimedBy = task.claimedBy ?? null;
  const claimedByMe = !!claimedBy && claimedBy === myEmail;
  // task-80be320f06b3 — stalled badge: an in_progress row with no live worker.
  // Mirrors classify().stalled (attention.mjs) so the row badge, the "N need
  // you" count, and the Stalled filter all agree on exactly the same rows.
  const stalled = classify(task).stalled;
  // fm-lji6 (S2) — a deferred TypeBuild task (defer_until in the future) isn't
  // claimable by claim-next until then; show a snooze pill so it reads as
  // "asleep" rather than just idle. deferUntil is a full ISO timestamp.
  const deferredUntil =
    task.deferUntil && new Date(task.deferUntil).getTime() > Date.now()
      ? task.deferUntil
      : null;

  // fm-bq86 (S3) — parent child-progress chip ("2/5 ⮡"). Only on parent rows
  // that actually have children grouped beneath them.
  const isChild = depth === 1;
  // fm-8yky — the disclosure toggle appears only when there are children that
  // actually render in this section (terminal kids live in DONE). The N/M chip
  // below still uses childCount/doneChildCount (the full totals).
  const hasChildren =
    typeof visibleChildCount === 'number' && visibleChildCount > 0;
  const childProgress =
    hasChildren && typeof doneChildCount === 'number'
      ? `${doneChildCount}/${childCount}`
      : null;
  // fm-bq86 (S3) — dependency presentation: a passive "waits on N" pill for
  // TypeBuild rows whose deps aren't satisfied. Title resolution (if any) is
  // renderer-memory only (PHI-safe) and shows up in the tooltip.
  const blocking = task.blockedBy ?? [];
  const waitsOn =
    task.depsSatisfied === false && blocking.length > 0 ? blocking.length : 0;
  const waitsTooltip =
    waitsOn > 0
      ? blockedByTitles && blockedByTitles.length > 0
        ? `Waiting on: ${blockedByTitles.join(', ')}`
        : `Waiting on ${waitsOn} task${waitsOn === 1 ? '' : 's'}`
      : undefined;

  return (
    <div
      role="listitem"
      data-task-id={task.id}
      className={[
        'tasks__row',
        selected && 'tasks__row--selected',
        cursor && 'tasks__row--cursor',
        isClosed && 'tasks__row--muted',
        isChild && 'tasks__row--child',
      ]
        .filter(Boolean)
        .join(' ')}
      title={closedTooltip}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {isChild && (
        <span className="tasks__row-connector" aria-hidden="true">
          └
        </span>
      )}
      {/* fm-8yky — first grid cell is the disclosure column. Parent rows get a
          toggle (subtree collapses by default; expand to see children in
          context); every other row renders an empty cell of the same width so
          titles stay aligned. */}
      {hasChildren ? (
        <button
          type="button"
          className="tasks__row-disclosure"
          aria-expanded={!!expanded}
          aria-label={expanded ? 'Collapse children' : 'Expand children'}
          title={expanded ? 'Collapse children' : 'Expand children'}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand?.();
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
      ) : (
        <span className="tasks__row-disclosure-spacer" aria-hidden="true" />
      )}
      <label
        className="tasks__row-check"
        onClick={(e) => e.stopPropagation()}
        title={selected ? 'Unselect' : 'Select'}
      >
        <input type="checkbox" checked={selected} onChange={onCheckbox} />
      </label>

      <div className="tasks__row-main">
        <div className="tasks__row-title">
          {/* fm-mhtz — status is the colored dot alone; the source-native raw
              status (failed/partial/…) rides in its tooltip instead of a
              separate text badge that read differently from the dot. */}
          <TaskStatusDot
            status={task.status}
            rawStatus={rawBadge}
            health={stalled ? 'stalled' : null}
          />
          {task.pinned && (
            <span className="tasks__row-pin-mark" aria-label="Pinned" title="Pinned">
              ★
            </span>
          )}
          <span className="tasks__row-title-text">{task.title}</span>
          {childProgress && (
            <span
              className="tasks__child-progress"
              title={`${childProgress} children done`}
            >
              {childProgress} done
            </span>
          )}
        </div>
        <div className="tasks__row-sub">
          {/* task-80be320f06b3 — stalled badge: a stranded in_progress row with
              no active worker. Reads loud so it bubbles up by eye even before
              the Stalled filter is used. */}
          {stalled && (
            <span
              className="tasks__row-stalled"
              title="In progress but no active worker — looks stranded. Open it to reset."
            >
              ⚠ stalled
            </span>
          )}
          {!hideFolder && task.folder && (
            <span className="tasks__row-folder" title={task.folder}>
              {homeRel(task.folder)}
            </span>
          )}
          {claimedBy && (
            // fm-jw9m — icon-only claimed marker. The text "you" / email used to
            // tack a second token onto every claimed row; collapse it to a
            // single glyph (accent when it's mine) with the who in the tooltip.
            // task-b8306d2b85c2 — the tooltip now carries claim FRESHNESS (who +
            // relative age + near-expiry) when the row has a claim timestamp;
            // it gracefully degrades to bare ownership on list rows (the list
            // endpoint carries no timestamps), and tints near-expiry holds.
            <span
              className={[
                'tasks__row-claimed',
                claimedByMe && 'tasks__row-claimed--me',
                claimFreshness(task.claimedAt ?? null)?.expiresSoon &&
                  'tasks__row-claimed--expiring',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-label={claimSummary(claimedBy, claimedByMe, task.claimedAt ?? null)}
              title={claimSummary(claimedBy, claimedByMe, task.claimedAt ?? null)}
            >
              ◆
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
          {waitsOn > 0 && (
            <span className="tasks__waits-on" title={waitsTooltip}>
              ⛓ waits on {waitsOn}
            </span>
          )}
          {/* fm-8yky — the per-row run-state pill (⚡/◴ + "running/failed/…")
              duplicated what the primary action button already conveys
              (Run now / View run / Open session), giving every auto row two
              competing run signals. Dropped from the row; the detail panel
              keeps the full run state + history. */}
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
