// fm-femh — Run-task modal launched from a folder tab's header.
//
// Lists tasks that are runnable in the active folder and lets the user
// pick one. Order:
//   1. Tasks anchored to this exact folder (most relevant first).
//   2. Tasks with no folder ("any folder") — runnable everywhere.
// Tasks anchored to other folders are hidden — they belong to those
// folders' sessions, not this one.
//
// Selection runs via tasks:runNowAt with the active folder as the
// override cwd, so a folder-agnostic task picks up the click-time
// folder rather than relying on its (possibly empty) anchor.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useOverlayExit } from '../useOverlayExit';
import { formatOpError } from '../errorMessages';
import { runTaskNowAt, useTasks } from '../tasks';
import { startTracking, stopTracking } from '../runProgress';
import type { Task } from '../types';
import './RunTaskModal.css';

type Props = { cwd: string; onClose: () => void };

export function RunTaskModal({ cwd, onClose }: Props) {
  const { exit, state } = useOverlayExit(onClose);
  // Pull active (non-done, non-cancelled) tasks. Filter applies
  // start_at <= today so future-dated tasks stay out of the picker.
  const { tasks, loading } = useTasks({ activeOnly: true });
  const [filter, setFilter] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matchTask = (t: Task) =>
      !q || t.title.toLowerCase().includes(q) || (t.notes ?? '').toLowerCase().includes(q);
    const here: Task[] = [];
    const any: Task[] = [];
    for (const t of tasks) {
      // Manual (human) tasks aren't runnable by an agent — they belong
      // to the user's todo list, not the Run-task picker.
      if (!t.auto_mode) continue;
      if (!matchTask(t)) continue;
      const f = (t.folder ?? '').trim();
      if (f === cwd) here.push(t);
      else if (!f) any.push(t);
      // else: anchored to a different folder — hide
    }
    return { here, any };
  }, [tasks, filter, cwd]);

  const flat = useMemo(() => [...grouped.here, ...grouped.any], [grouped]);

  useEffect(() => {
    if (highlight >= flat.length) setHighlight(0);
  }, [flat.length, highlight]);

  async function run(task: Task) {
    if (busy) return;
    setBusy(true);
    setError(null);
    // Register the run with the renderer-side progress tracker BEFORE
    // exiting so the banner shows up the moment the modal closes. The
    // backend's run-row creation will arrive seconds later via the
    // task-runs:changed event and link the runId for Cancel.
    const trackingId = startTracking(task.id, task.title, cwd);
    exit();
    try {
      await runTaskNowAt(task.id, cwd);
      window.dispatchEvent(
        new CustomEvent('fm:setStatus', {
          detail: { msg: `finished "${task.title}" in ${cwd}` },
        }),
      );
    } catch (e) {
      window.dispatchEvent(
        new CustomEvent('fm:setStatus', {
          detail: { msg: formatOpError('run', e) },
        }),
      );
    } finally {
      stopTracking(trackingId);
      // Refresh the folder so any files the agent created/modified
      // become visible without a manual reload.
      window.dispatchEvent(
        new CustomEvent('fm:reloadDir', { detail: { path: cwd } }),
      );
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      exit();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, flat.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const pick = flat[highlight];
      if (pick) void run(pick);
    }
  }

  return (
    <div
      className="overlay run-task-overlay"
      data-state={state}
      onClick={exit}
      onKeyDown={onKey}
    >
      <div
        className="overlay__box run-task"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-task-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="run-task__close"
          onClick={exit}
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>
        <div id="run-task-title" className="run-task__title">
          Run task
        </div>
        <div className="run-task__cwd" title={cwd}>
          in <span className="run-task__cwd-path">{cwd}</span>
        </div>

        <input
          ref={inputRef}
          type="text"
          className="run-task__filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tasks…"
          autoComplete="off"
          spellCheck={false}
        />

        {loading ? (
          <div className="run-task__empty">Loading…</div>
        ) : flat.length === 0 ? (
          <div className="run-task__empty run-task__empty--rich">
            <div className="run-task__empty-glyph" aria-hidden>·</div>
            <div className="run-task__empty-title">No tasks ready to run.</div>
            <div className="run-task__empty-hint">
              Create a task with an executor like Claude Code to run it from here.
            </div>
            <div className="run-task__empty-actions">
              <button
                type="button"
                className="btn btn--primary run-task__empty-cta"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(
                    new CustomEvent('fm:openTask', {
                      detail: { mode: 'create', defaultFolder: cwd },
                    }),
                  );
                }}
              >
                Create a task
              </button>
              <button
                type="button"
                className="btn btn--ghost run-task__empty-link"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(
                    new CustomEvent('fm:openHelp', {
                      detail: { slide: 'tasks-intro' },
                    }),
                  );
                }}
              >
                How tasks work
              </button>
            </div>
          </div>
        ) : (
          <ul className="run-task__list" role="listbox">
            {grouped.here.length > 0 && (
              <li className="run-task__group">Tasks for this folder</li>
            )}
            {grouped.here.map((t, i) => (
              <TaskRow
                key={t.id}
                task={t}
                active={i === highlight}
                onPick={() => void run(t)}
                onHover={() => setHighlight(i)}
                disabled={busy}
              />
            ))}
            {grouped.any.length > 0 && (
              <li className="run-task__group">General tasks (any folder)</li>
            )}
            {grouped.any.map((t, i) => {
              const idx = grouped.here.length + i;
              return (
                <TaskRow
                  key={t.id}
                  task={t}
                  active={idx === highlight}
                  onPick={() => void run(t)}
                  onHover={() => setHighlight(idx)}
                  disabled={busy}
                />
              );
            })}
          </ul>
        )}

        {error && <div className="run-task__error">{error}</div>}

        <div className="run-task__shortcuts" aria-hidden="true">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↩</kbd> run</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

function TaskRow({
  task,
  active,
  onPick,
  onHover,
  disabled,
}: {
  task: Task;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
  disabled: boolean;
}) {
  return (
    <li
      role="option"
      aria-selected={active}
      className={[
        'run-task__row',
        active ? 'run-task__row--active' : '',
        disabled ? 'run-task__row--disabled' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onMouseDown={(e) => {
        e.preventDefault();
        if (!disabled) onPick();
      }}
      onMouseEnter={onHover}
    >
      <span className="run-task__row-title">{task.title}</span>
      {task.notes && (
        <span className="run-task__row-notes" title={task.notes}>
          {task.notes.split('\n')[0]}
        </span>
      )}
      {task.auto_mode && <span className="run-task__row-tag">⚡ auto</span>}
    </li>
  );
}

export function openRunTaskModal(cwd: string) {
  window.dispatchEvent(new CustomEvent('fm:openRunTask', { detail: { cwd } }));
}
