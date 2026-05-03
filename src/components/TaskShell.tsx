// fm-a9j — Task-mode shell. When a tab has kind === 'task', the main
// area swaps from "browse this folder" to "operate on this task." The
// task header takes over the chrome's top slot (no Pathbar, no
// FolderHeader), an action zone presents the high-intent verbs as
// physical buttons, and the bound folder is reduced to a single muted
// row at the bottom — visible enough to ground the work without
// competing with it. Browsing happens in folder tabs.

import { useEffect, useMemo, useState } from 'react';
import { makeTab, useStore } from '../store';
import { fm } from '../bridge';
import { basename } from '../actions';
import {
  dueTone,
  formatDueLabel,
  getTask,
  todayISO,
  updateTask,
} from '../tasks';
import { invokeLauncher } from '../launchers';
import { spawnTerminal } from '../terminalSpawn';
import type { Launcher } from '../bridge';
import type { Task } from '../types';
import { TaskRunIndicator, TaskStatusDot } from './TaskIndicators';
import './TaskShell.css';

const STATUS_LABEL: Record<Task['status'], string> = {
  pending: 'pending',
  in_progress: 'in progress',
  done: 'done',
  cancelled: 'cancelled',
};

export function TaskShell({ tabIndex }: { tabIndex: number }) {
  const { state, dispatch } = useStore();
  const tab = state.tabs[tabIndex];
  const taskId = tab?.taskId ?? null;

  // Resolve the task by id. We bypass useTasks's filter machinery — a
  // single-record fetch + the global tasks:changed broadcast is simpler
  // and avoids accidentally pulling all tasks into memory.
  const [task, setTask] = useState<Task | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) {
      setTask(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      getTask(taskId)
        .then((t) => { if (!cancelled) { setTask(t); setLoadError(null); } })
        .catch((e) => { if (!cancelled) setLoadError((e as Error).message); });
    };
    load();
    const unsub = fm.onTasksChanged(load);
    return () => { cancelled = true; unsub(); };
  }, [taskId]);

  const [launchers, setLaunchers] = useState<Launcher[]>([]);
  useEffect(() => {
    void fm.launchersList().then(setLaunchers).catch(() => setLaunchers([]));
  }, []);

  // fm-mph — variant picker. Must live above the !task early return so
  // the hook count stays stable across renders (React Rules of Hooks).
  const [pickerFor, setPickerFor] = useState<Launcher | null>(null);

  const folder = useMemo(() => task?.folder ?? tab?.trail[tab.trail.length - 1] ?? '', [task, tab]);

  // Task tab without a bound id (or task was deleted out from under it):
  // show a minimal recovery prompt rather than crashing the shell.
  if (!task) {
    return (
      <div className="taskshell taskshell--empty">
        <div className="taskshell__empty-msg">
          {loadError
            ? `Couldn't load task: ${loadError}`
            : taskId
              ? 'Task not found — it may have been deleted.'
              : 'No task bound to this tab.'}
        </div>
        <div className="taskshell__empty-actions">
          <button
            type="button"
            className="taskshell__btn"
            onClick={() => dispatch({ type: 'setTabTaskId', index: tabIndex, taskId: null })}
          >
            Convert to folder tab
          </button>
        </div>
      </div>
    );
  }

  const today = todayISO();
  const tone = dueTone(task.due_at, today);
  const isClosed = task.status === 'done' || task.status === 'cancelled';

  const onEdit = () => {
    window.dispatchEvent(
      new CustomEvent('fm:openTask', { detail: { mode: 'edit', task } }),
    );
  };
  const onMarkDone = async () => {
    try {
      await updateTask(task.id, { status: 'done' });
      // Detaching the tab keeps the user's working surface (terminal pane,
      // selection, etc.) but lets the shell drop back to folder mode now
      // that the task is closed. A surfaced status confirms the action.
      dispatch({ type: 'setTabTaskId', index: tabIndex, taskId: null });
      dispatch({ type: 'setStatus', msg: `marked done · ${task.title}` });
    } catch (e) {
      dispatch({ type: 'setStatus', msg: `mark done failed: ${(e as Error).message}` });
    }
  };
  const onOpenFolder = () => {
    // New folder tab keeps the task tab focused on operations — clicking
    // "Open folder" is a "take me there to browse" affordance, not an
    // in-place mode-switch.
    dispatch({ type: 'newTab', tab: makeTab(folder) });
  };
  const onOpenTerminal = async () => {
    if (tab.terminal) {
      dispatch({ type: 'setStatus', msg: 'terminal already open' });
      return;
    }
    try {
      const ptyId = await spawnTerminal({
        cwd: folder,
        sessionLabel: task?.title || basename(folder),
      });
      dispatch({ type: 'openTerminal', tabIndex, ptyId, cwd: folder });
      dispatch({ type: 'setStatus', msg: 'terminal opened' });
    } catch (e) {
      dispatch({ type: 'setStatus', msg: `terminal failed: ${(e as Error).message}` });
    }
  };
  const launch = async (l: Launcher, variantId?: string) => {
    setPickerFor(null);
    await invokeLauncher({
      launcher: l,
      variantId,
      task,
      cwd: folder,
      sessionLabel: task?.title || basename(folder),
      existingPty: tab.terminal ? { ptyId: tab.terminal.ptyId } : undefined,
      onStatus: (msg) => dispatch({ type: 'setStatus', msg }),
      onPtyOpened: ({ ptyId, label }) =>
        dispatch({ type: 'openTerminal', tabIndex, ptyId, cwd: folder, label }),
    });
  };

  const onLaunch = (l: Launcher) => {
    const variants = l.variants ?? [];
    if (variants.length === 0) {
      void launch(l);
      return;
    }
    setPickerFor(l);
  };

  return (
    <div className="taskshell" data-status={task.status}>
      <header className="taskshell__header">
        <div className="taskshell__title-row">
          <TaskStatusDot status={task.status} className="taskshell__status-dot" />
          <h1 className="taskshell__title" title={task.title}>{task.title}</h1>
          {task.auto_mode && (
            <TaskRunIndicator task={task} />
          )}
          <div className="taskshell__header-actions">
            <button
              type="button"
              className="taskshell__icon-btn"
              onClick={onEdit}
              title="Edit task"
              aria-label="Edit task"
            >
              ✎
            </button>
            {!isClosed && (
              <button
                type="button"
                className="taskshell__btn taskshell__btn--primary"
                onClick={onMarkDone}
                title="Mark this task done and detach it from the tab"
              >
                Mark done
              </button>
            )}
          </div>
        </div>
        <div className="taskshell__meta">
          <span className={`taskshell__status taskshell__status--${task.status}`}>
            {STATUS_LABEL[task.status]}
          </span>
          {task.due_at && (
            <span className={`taskshell__due taskshell__due--${tone}`}>
              due {formatDueLabel(task.due_at, today)}
            </span>
          )}
          {task.start_at && task.start_at > today && (
            <span className="taskshell__start">
              starts {formatDueLabel(task.start_at, today)}
            </span>
          )}
          {task.pinned && <span className="taskshell__pin">★ pinned</span>}
        </div>
        {task.notes && (
          <NotesBlock notes={task.notes} />
        )}
      </header>

      <section className="taskshell__actions" aria-label="Task actions">
        <button
          type="button"
          className="btn btn--card"
          onClick={onOpenTerminal}
          disabled={!!tab.terminal}
          title={tab.terminal ? 'Terminal already open in this tab' : `Open a shell at ${basename(folder) || '/'}`}
        >
          <span className="btn__icon">$_</span>
          <span className="btn__label">Open Terminal</span>
          <span className="btn__sub">{basename(folder) || '/'}</span>
        </button>
        {launchers.map((l) => (
          <div key={l.id} className="taskshell__action-wrap">
            <button
              type="button"
              className="btn btn--card btn--card-accent"
              onClick={() => onLaunch(l)}
              title={l.description ?? `Run ${l.command}`}
            >
              <span className="btn__icon">⚡</span>
              <span className="btn__label">{l.label}</span>
              <span className="btn__sub">
                {(l.variants?.length ?? 0) > 0
                  ? `${l.command} · ${l.variants!.length + 1} modes`
                  : l.command}
              </span>
            </button>
            {pickerFor?.id === l.id && (
              <VariantPicker
                launcher={l}
                onPick={(variantId) => void launch(l, variantId)}
                onClose={() => setPickerFor(null)}
              />
            )}
          </div>
        ))}
        {launchers.length === 0 && (
          <div className="taskshell__action-empty">
            No AI launchers configured. Open Settings to add Claude / Codex / Gemini.
          </div>
        )}
      </section>

      <footer className="taskshell__folder">
        <span className="taskshell__folder-icon" aria-hidden="true">⌘</span>
        <span className="taskshell__folder-label" title={folder}>
          {folder || '(no folder)'}
        </span>
        <button
          type="button"
          className="taskshell__folder-btn"
          onClick={onOpenFolder}
          title="Open this folder in a new tab"
        >
          Open folder
        </button>
      </footer>
    </div>
  );
}

function NotesBlock({ notes }: { notes: string }) {
  const [expanded, setExpanded] = useState(false);
  // Two-line clamp by default; click to expand. Even short notes get the
  // click affordance for consistency — preview-on-click is more
  // discoverable than "sometimes you can click, sometimes not."
  return (
    <div
      className={`taskshell__notes${expanded ? ' taskshell__notes--expanded' : ''}`}
      onClick={() => setExpanded((v) => !v)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setExpanded((v) => !v);
        }
      }}
      title={expanded ? 'Click to collapse' : 'Click to expand'}
    >
      {notes}
    </div>
  );
}

// fm-mph — variant picker popover. Anchored relative to the parent
// .taskshell__action-wrap. Real <button>s so Tab navigates and
// Enter/Space activates; Esc and outside-click dismiss.
function VariantPicker({
  launcher,
  onPick,
  onClose,
}: {
  launcher: Launcher;
  onPick: (variantId: string) => void;
  onClose: () => void;
}) {
  const ref = useState<HTMLDivElement | null>(null);
  const [el, setEl] = ref;

  // Autofocus the first option so Enter immediately picks Bare; Tab
  // walks the rest. Outside-click and Esc both close.
  useEffect(() => {
    const first = el?.querySelector<HTMLButtonElement>('button');
    first?.focus();
    function onDoc(e: MouseEvent) {
      if (!el) return;
      if (!el.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [el, onClose]);

  const variants = launcher.variants ?? [];

  return (
    <div ref={setEl} className="taskshell__variants" role="menu">
      <button
        type="button"
        className="btn btn--ghost btn--sm taskshell__variant"
        onClick={() => onPick('__bare__')}
        title={`${launcher.command} ${(launcher.args ?? []).join(' ')}`.trim()}
      >
        <span className="taskshell__variant-label">Bare</span>
        <span className="taskshell__variant-sub">no extra flags</span>
      </button>
      {variants.map((v) => (
        <button
          key={v.id}
          type="button"
          className="btn btn--ghost btn--sm taskshell__variant"
          onClick={() => onPick(v.id)}
          title={
            (v.description ?? '') +
            (v.args && v.args.length ? `  ·  ${v.args.join(' ')}` : '')
          }
        >
          <span className="taskshell__variant-label">{v.label}</span>
          <span className="taskshell__variant-sub">
            {v.description ?? (v.args ?? []).join(' ')}
          </span>
        </button>
      ))}
    </div>
  );
}
