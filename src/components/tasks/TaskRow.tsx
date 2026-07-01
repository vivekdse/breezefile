// fm-7909 — one row, one primary action.
// task-attention-stats — rebuilt as a proper file-manager-style TABLE: every
// icon/stat is its own fixed-width grid COLUMN (assignee on the left next to
// the checkbox; status/attn/pin/claim/attempts/due/waits/updated/run on the
// right), and .tasks__row's grid-template-columns is the SAME fixed list for
// every row AND the header (TaskRowHeader below) — no auto-sized tracks, no
// nested inner grid — so columns can't drift or overlap row to row.
// Pin/edit/open-tab/status-cycle stay in the kebab. Row click moves the
// cursor (selection); Enter / double-click opens edit (manual) or focuses the
// detail panel (agent — edit is unsupported there).

import type { PrimaryAction } from './primaryAction.mjs';
import { PrimaryActionButton } from './PrimaryActionButton';
import { homeRel, shortDate } from './helpers';
import { claimSummary, claimFreshness } from './lifecycle.mjs';
import { classify } from '../../projects/attention.mjs';
import {
  TaskStatusDot,
  TaskAttentionBadge,
  TaskAskBadge,
  TaskRunIndicator,
  relTime,
} from '../TaskIndicators';
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
  // Folded into the status dot's health ring (below) rather than its own
  // column — it's a qualifier on status, not an independent stat.
  const stalled = classify(task).stalled;
  // task-91d13f9d5469 — the pending-question TEXT for the subtitle swap. Only a
  // NON-terminal question counts (a done/cancelled task's stale question is
  // moot — mirrors classify().asked). PHI: rendered from React state only,
  // never logged/persisted. Truncated for the single-line subtitle.
  const pendingQuestionRaw = !isClosed ? (task.pending_question?.text ?? '') : '';
  const pendingQuestionText = pendingQuestionRaw
    ? pendingQuestionRaw.length > 160
      ? `${pendingQuestionRaw.slice(0, 157)}…`
      : pendingQuestionRaw
    : '';
  // fm-lji6 (S2) — a deferred TypeBuild task (defer_until in the future) isn't
  // claimable by claim-next until then; folded into the Due column below as a
  // snooze icon (still non-claimable info, just not its own column).
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
  // fm-bq86 (S3) — dependency presentation: a passive "waits on N" column for
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

  // File-manager-style stat columns — mirroring size/modified/owner. Only
  // render a value when the field is meaningful; an unattempted/unassigned/
  // unclaimed task shows an empty (but present, same-width) cell.
  const attemptsLabel =
    typeof task.attempts === 'number' && task.attempts > 0
      ? typeof task.maxAttempts === 'number' && task.maxAttempts > 0
        ? `${task.attempts}/${task.maxAttempts}`
        : `${task.attempts}`
      : null;
  const attemptsExhausted =
    typeof task.attempts === 'number' &&
    typeof task.maxAttempts === 'number' &&
    task.maxAttempts > 0 &&
    task.attempts >= task.maxAttempts;

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
      {/* first grid cell is the disclosure column. Parent rows get a toggle
          (subtree collapses by default; expand to see children in context);
          every other row renders an empty cell of the same width so titles
          stay aligned. */}
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

      {/* task-attention-stats — Owner (assignee) is the ONE stat column that
          sits on the LEFT, beside the checkbox, rather than with the other
          stat columns on the right. */}
      <span
        className="tasks__col tasks__col--assignee"
        title={task.assignedTo ? `Assigned to ${task.assignedTo}` : undefined}
        aria-label={task.assignedTo ? `Assigned to ${task.assignedTo}` : undefined}
      >
        {task.assignedTo ? '⊙' : ''}
      </span>

      <div className="tasks__row-main">
        <div className="tasks__row-title">
          <span className="tasks__row-title-text">{task.title}</span>
          {/* task-attention-stats — the primary action sits right next to the
              title (not its own column) — it's the one thing on the row a
              user actively clicks, so it belongs beside what it acts on. */}
          <div className="tasks__row-primary" onClick={(e) => e.stopPropagation()}>
            <PrimaryActionButton action={primary} onInvoke={onPrimary} variant="row" />
          </div>
          {childProgress && (
            <span
              className="tasks__child-progress"
              title={`${childProgress} children done`}
            >
              {childProgress} done
            </span>
          )}
        </div>
        {/* task-91d13f9d5469 — subtitle swap: when a NON-terminal task has a
            pending question, show the question TEXT (truncated) under the title
            in place of the folder line, so the user can read what's being asked
            without opening the row. This renders PHI (the question text) in the
            list — in-memory only, same rule as the title. Falls back to the
            folder subtitle when there is no pending question. */}
        {pendingQuestionText ? (
          <div className="tasks__row-sub">
            <span
              className="tasks__row-question"
              title={pendingQuestionText}
              aria-label={`Waiting on your answer: ${pendingQuestionText}`}
            >
              <span className="tasks__row-question-glyph" aria-hidden="true">
                ⁇
              </span>
              {pendingQuestionText}
            </span>
          </div>
        ) : (
          !hideFolder &&
          task.folder && (
            <div className="tasks__row-sub">
              <span className="tasks__row-folder" title={task.folder}>
                {homeRel(task.folder)}
              </span>
            </div>
          )
        )}
      </div>

      {/* task-attention-stats — every OTHER icon/stat is its own fixed-width
          column on the right, in the SAME order as TaskRowHeader below, so a
          column of icons reads as one line per row (no inline text pills). */}
      <span
        className="tasks__col tasks__col--status"
        onClick={(e) => e.stopPropagation()}
      >
        <TaskStatusDot
          status={task.status}
          rawStatus={rawBadge}
          health={stalled ? 'stalled' : null}
        />
      </span>
      <span className="tasks__col tasks__col--attn">
        <TaskAttentionBadge task={task} />
      </span>
      {/* task-91d13f9d5469 — the ASK (?) column: shows when a task carries a
          pending question (ask_user). Fixed-width like every other stat column
          so the header + rows stay column-aligned; renders empty (same width)
          when there is no question, so a question-less row is unchanged. */}
      <span className="tasks__col tasks__col--ask">
        <TaskAskBadge task={task} />
      </span>
      <span className="tasks__col tasks__col--pin">
        {task.pinned && (
          <span aria-label="Pinned" title="Pinned">
            ★
          </span>
        )}
      </span>
      <span className="tasks__col tasks__col--claim">
        {claimedBy && (
          // fm-jw9m — icon-only claimed marker. task-b8306d2b85c2 — the
          // tooltip carries claim FRESHNESS (who + relative age + near-expiry)
          // when the row has a claim timestamp.
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
      </span>
      <span
        className={[
          'tasks__col',
          'tasks__col--attempts',
          attemptsExhausted && 'tasks__col--attempts-exhausted',
        ]
          .filter(Boolean)
          .join(' ')}
        title={
          attemptsLabel
            ? `${attemptsLabel} attempts${attemptsExhausted ? ' — exhausted' : ''}`
            : undefined
        }
      >
        {attemptsLabel ?? ''}
      </span>
      <span
        className={[
          'tasks__col',
          'tasks__col--due',
          overdue && !deferredUntil && 'tasks__col--due-overdue',
          deferredUntil && 'tasks__col--due-deferred',
        ]
          .filter(Boolean)
          .join(' ')}
        title={
          deferredUntil
            ? `Deferred — not claimable until ${new Date(deferredUntil).toLocaleString()}`
            : task.due_at
              ? `Due ${shortDate(task.due_at, today)}${overdue ? ' — overdue' : ''}`
              : undefined
        }
      >
        {deferredUntil ? '⏾' : task.due_at ? shortDate(task.due_at, today) : ''}
      </span>
      <span
        className="tasks__col tasks__col--waits"
        title={waitsTooltip}
      >
        {waitsOn > 0 ? `⛓${waitsOn}` : ''}
      </span>
      <span
        className="tasks__col tasks__col--updated"
        title={
          task.updated_at > 0
            ? `Last updated ${new Date(task.updated_at).toLocaleString()}`
            : undefined
        }
      >
        {task.updated_at > 0 ? relTime(task.updated_at).replace(/ ago$/, '') : ''}
      </span>
      <span
        className="tasks__col tasks__col--run"
        onClick={(e) => e.stopPropagation()}
      >
        {schedule && (
          <span
            className="tasks__row-schedule-dot"
            title={`Scheduled (local cron): ${schedule.cron} · next ${new Date(
              schedule.nextRunAt,
            ).toLocaleString()}`}
            aria-label="Scheduled"
          >
            ⏰
          </span>
        )}
        {task.auto_mode ? (
          <TaskRunIndicator task={task} showPill={false} />
        ) : (
          runCount > 0 && (
            <button
              type="button"
              className="tasks__runs-pill"
              onClick={(e) => {
                e.stopPropagation();
                onOpenRuns();
              }}
              title={`${runCount} past run${runCount === 1 ? '' : 's'} — click to open history`}
            >
              {runCount}
            </button>
          )
        )}
      </span>

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

/** task-attention-stats — column header for a TaskRow list. Uses the EXACT
 *  same .tasks__row grid (fixed widths, same order) so labels land directly
 *  above their cells with no separate alignment logic to drift out of sync.
 *  Render once above a list of TaskRows; skip it when the list is empty. */
export function TaskRowHeader() {
  return (
    <div className="tasks__row tasks__row-header" role="row" aria-hidden="true">
      <span className="tasks__row-disclosure-spacer" />
      <span />
      <span className="tasks__col tasks__row-header-label">Owner</span>
      <span className="tasks__row-header-label tasks__row-header-label--task">Task</span>
      <span className="tasks__col tasks__row-header-label">Status</span>
      <span className="tasks__col tasks__row-header-label">Attn</span>
      {/* task-91d13f9d5469 — Ask column header (the ? glyph column). */}
      <span className="tasks__col tasks__row-header-label">Ask</span>
      <span className="tasks__col tasks__row-header-label">Pin</span>
      <span className="tasks__col tasks__row-header-label">Claim</span>
      <span className="tasks__col tasks__row-header-label">Attempts</span>
      <span className="tasks__col tasks__row-header-label">Due</span>
      <span className="tasks__col tasks__row-header-label">Waits</span>
      <span className="tasks__col tasks__row-header-label">Updated</span>
      <span className="tasks__col tasks__row-header-label">Run</span>
      <span />
    </div>
  );
}
