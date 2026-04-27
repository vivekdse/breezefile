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
  buildContextPrompt,
  dueTone,
  formatDueLabel,
  getTask,
  todayISO,
  updateTask,
} from '../tasks';
import type { Launcher } from '../bridge';
import type { Task } from '../types';
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
      const ptyId = await fm.termSpawn({ cwd: folder });
      dispatch({ type: 'openTerminal', tabIndex, ptyId, cwd: folder });
      dispatch({ type: 'setStatus', msg: 'terminal opened' });
    } catch (e) {
      dispatch({ type: 'setStatus', msg: `terminal failed: ${(e as Error).message}` });
    }
  };
  const onLaunch = async (l: Launcher) => {
    const cmd = [l.command, ...(l.args ?? [])].join(' ') + '\r';
    // fm-adc — every launcher exposed via launchersList() is by design an
    // AI-CLI (Claude/Codex/Gemini/etc.); the bare-shell case is the
    // separate "Open Terminal" button above. Keep the id !== 'term' guard
    // anyway in case a future launcher catalog ever adds a non-AI entry.
    const isAiLauncher = l.id !== 'term';
    const contextText = isAiLauncher ? buildContextPrompt(task) : '';

    // Fire-and-forget sidecar write. The agent reads it on demand; if the
    // write fails the launch still proceeds with prompt-injection only.
    if (isAiLauncher) {
      void fm.tasksWriteActiveSidecar(task.id).catch(() => {/* logged in main */});
    }

    if (tab.terminal) {
      // Existing PTY: env is already set, so we can't inject BREEZE_TASK_ID
      // for this run — but we can still pre-type context after the command
      // line so the user sees + edits the prompt before submitting.
      fm.termWrite(tab.terminal.ptyId, cmd);
      if (isAiLauncher && contextText) {
        // 700ms gives the CLI time to print its banner / draw its input box.
        setTimeout(() => fm.termWrite(tab.terminal!.ptyId, contextText), 700);
      }
      dispatch({ type: 'setStatus', msg: `running ${l.label}` });
      return;
    }
    try {
      const env = isAiLauncher
        ? { BREEZE_TASK_ID: task.id, BREEZE_TASK_FOLDER: task.folder }
        : undefined;
      const ptyId = await fm.termSpawn({ cwd: folder, env });
      dispatch({ type: 'openTerminal', tabIndex, ptyId, cwd: folder, label: l.label });
      // Match the chip-prompt path's 220ms delay so the launcher line
      // doesn't land mid prompt-redraw on themed shells (starship/p10k).
      setTimeout(() => fm.termWrite(ptyId, cmd), 220);
      if (isAiLauncher && contextText) {
        // ~700ms after the launcher command for the CLI to spin up and
        // draw its input box. No trailing \r — the user reviews/edits
        // the pre-typed text and presses Enter themselves.
        setTimeout(() => fm.termWrite(ptyId, contextText), 700);
      }
      dispatch({ type: 'setStatus', msg: `opened terminal · ${l.label}` });
    } catch (e) {
      dispatch({ type: 'setStatus', msg: `${l.label} failed: ${(e as Error).message}` });
    }
  };

  return (
    <div className="taskshell" data-status={task.status}>
      <header className="taskshell__header">
        <div className="taskshell__title-row">
          <h1 className="taskshell__title" title={task.title}>{task.title}</h1>
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
          className="taskshell__action"
          onClick={onOpenTerminal}
          disabled={!!tab.terminal}
          title={tab.terminal ? 'Terminal already open in this tab' : `Open a shell at ${basename(folder) || '/'}`}
        >
          <span className="taskshell__action-icon">$_</span>
          <span className="taskshell__action-label">Open Terminal</span>
          <span className="taskshell__action-sub">{basename(folder) || '/'}</span>
        </button>
        {launchers.map((l) => (
          <button
            key={l.id}
            type="button"
            className="taskshell__action taskshell__action--launcher"
            onClick={() => onLaunch(l)}
            title={l.description ?? `Run ${l.command}`}
          >
            <span className="taskshell__action-icon">⚡</span>
            <span className="taskshell__action-label">{l.label}</span>
            <span className="taskshell__action-sub">{l.command}</span>
          </button>
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
