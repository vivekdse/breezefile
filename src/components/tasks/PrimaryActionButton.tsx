// fm-7909 — renders the ONE primary action for a task from the pure
// primaryActionFor descriptor. Shared by TaskRow and TaskDetailPanel so the
// row button and the mirrored detail button never drift. The 'none' case
// renders either a quiet note (e.g. "◆ claimed by X") or nothing.
//
// fm-8yky — the ROW variant is icon-only (glyph + tooltip/aria-label) to keep
// rows tight; the DETAIL variant keeps the full "glyph + label" text.

import type { PrimaryAction } from './primaryAction.mjs';

export function PrimaryActionButton({
  action,
  onInvoke,
  variant = 'row',
}: {
  action: PrimaryAction;
  /** kind tells the caller which handler to run. */
  onInvoke: (action: PrimaryAction) => void;
  variant?: 'row' | 'detail';
}) {
  const isRow = variant === 'row';
  const base = isRow
    ? 'tasks__row-btn tasks__row-btn--text tasks__primary--icononly'
    : 'tasks__btn';

  switch (action.kind) {
    case 'done-toggle':
      return (
        <button
          type="button"
          className={`${base} tasks__primary tasks__primary--done`}
          onClick={() => onInvoke(action)}
          title="Mark done"
          aria-label="Mark done"
        >
          {isRow ? '✓' : '✓ Mark done'}
        </button>
      );
    case 'reopen':
      return (
        <button
          type="button"
          className={`${base} tasks__primary tasks__primary--reopen`}
          onClick={() => onInvoke(action)}
          title="Reopen (back to pending)"
          aria-label="Reopen"
        >
          {isRow ? '↺' : '↺ Reopen'}
        </button>
      );
    // task-457dd1cc6c8b — a blocked TypeBuild task. One click runs the
    // composite reopen→claim→launch chain through the never-silent wrapper;
    // `action.reason` is the human sentence (never a raw server token).
    case 'retry':
      return (
        <button
          type="button"
          className={`${base} tasks__primary tasks__primary--reopen`}
          onClick={() => onInvoke(action)}
          title={action.reason}
          aria-label="Retry"
        >
          {isRow ? '↺' : '↺ Retry'}
        </button>
      );
    case 'start': {
      // task-reenter — a re-entry start (terminal task) reads "Open operator"
      // so the play button never looks like it will restart finished work.
      const label = action.reentry ? 'Open operator' : 'Start';
      return (
        <button
          type="button"
          className={`${base} tasks__primary tasks__primary--start`}
          onClick={() => action.enabled && onInvoke(action)}
          disabled={!action.enabled}
          title={action.tooltip}
          aria-label={label}
        >
          {isRow ? '▸' : `▸ ${label}`}
        </button>
      );
    }
    case 'open-session':
      return (
        <button
          type="button"
          className={`${base} tasks__primary tasks__primary--session`}
          onClick={() => onInvoke(action)}
          title="Focus the running session tab"
          aria-label="Open session"
        >
          {isRow ? '⧉' : '⧉ Open session'}
        </button>
      );
    case 'run-now':
      return (
        <button
          type="button"
          className={`${base} tasks__primary tasks__primary--run`}
          onClick={() => onInvoke(action)}
          title="Run this task now"
          aria-label="Run now"
        >
          {isRow ? '▸' : '▸ Run now'}
        </button>
      );
    case 'view-run':
      return (
        <button
          type="button"
          className={`${base} tasks__primary tasks__primary--run`}
          onClick={() => onInvoke(action)}
          title="A run is in flight — view its history"
          aria-label="View run"
        >
          {isRow ? '◷' : '◷ View run'}
        </button>
      );
    case 'none':
      if (action.note) {
        return (
          <span className="tasks__primary-note" title={action.note}>
            ◆ {action.note}
          </span>
        );
      }
      return null;
  }
}
