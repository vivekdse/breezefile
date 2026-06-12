// fm-7909 — renders the ONE primary action for a task from the pure
// primaryActionFor descriptor. Shared by TaskRow and TaskDetailPanel so the
// row button and the mirrored detail button never drift. The 'none' case
// renders either a quiet note (e.g. "◆ claimed by X") or nothing.

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
  const base =
    variant === 'detail' ? 'tasks__btn' : 'tasks__row-btn tasks__row-btn--text';

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
          {variant === 'detail' ? '✓ Mark done' : '✓ Done'}
        </button>
      );
    case 'reopen':
      return (
        <button
          type="button"
          className={`${base} tasks__primary tasks__primary--reopen`}
          onClick={() => onInvoke(action)}
          title="Reopen (back to pending)"
        >
          ↺ Reopen
        </button>
      );
    case 'start':
      return (
        <button
          type="button"
          className={`${base} tasks__primary tasks__primary--start`}
          onClick={() => action.enabled && onInvoke(action)}
          disabled={!action.enabled}
          title={action.tooltip}
        >
          ▸ Start
        </button>
      );
    case 'open-session':
      return (
        <button
          type="button"
          className={`${base} tasks__primary tasks__primary--session`}
          onClick={() => onInvoke(action)}
          title="Focus the running session tab"
        >
          ⧉ Open session
        </button>
      );
    case 'run-now':
      return (
        <button
          type="button"
          className={`${base} tasks__primary tasks__primary--run`}
          onClick={() => onInvoke(action)}
          title="Run this task now"
        >
          ▸ Run now
        </button>
      );
    case 'view-run':
      return (
        <button
          type="button"
          className={`${base} tasks__primary tasks__primary--run`}
          onClick={() => onInvoke(action)}
          title="A run is in flight — view its history"
        >
          ◷ View run
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
