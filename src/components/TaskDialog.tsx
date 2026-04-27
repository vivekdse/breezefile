// fm-nmt — Task creation/edit dialog.
//
// Opened via the `task` verb or the `T` keybind for quick-add. When opened
// for create the folder defaults to the active tab's cwd; for edit it is
// preloaded from the existing task. Cmd-Enter submits, Esc cancels.

import { useEffect, useRef, useState } from 'react';
import { useOverlayExit } from '../useOverlayExit';
import { createTask, todayISO, updateTask } from '../tasks';
import type { Task, TaskStatus } from '../types';
import './TaskDialog.css';

export type TaskDialogRequest =
  | { mode: 'create'; defaultFolder: string }
  | { mode: 'edit'; task: Task };

type Props = TaskDialogRequest & { onClose: () => void };

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function TaskDialog(props: Props) {
  const { exit, state } = useOverlayExit(props.onClose);

  const initial: Task | null = props.mode === 'edit' ? props.task : null;
  const [title, setTitle] = useState(initial?.title ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [folder, setFolder] = useState(
    initial?.folder ?? (props.mode === 'create' ? props.defaultFolder : ''),
  );
  const [refFolder, setRefFolder] = useState(initial?.ref_folder ?? '');
  const [startAt, setStartAt] = useState(initial?.start_at ?? '');
  const [dueAt, setDueAt] = useState(initial?.due_at ?? '');
  const [status, setStatus] = useState<TaskStatus>(initial?.status ?? 'pending');
  const [pinned, setPinned] = useState(initial?.pinned ?? false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  async function submit() {
    if (busy) return;
    if (!title.trim()) {
      setError('Title is required');
      titleRef.current?.focus();
      return;
    }
    if (!folder.trim()) {
      setError('Folder is required');
      return;
    }
    if (startAt && dueAt && dueAt < startAt) {
      setError('Due date must be on or after start date');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        title: title.trim(),
        notes: notes.trim() || null,
        folder: folder.trim(),
        ref_folder: refFolder.trim() || null,
        start_at: startAt || null,
        due_at: dueAt || null,
        status,
        pinned,
      };
      if (props.mode === 'create') {
        await createTask(payload);
      } else {
        await updateTask(props.task.id, payload);
      }
      exit();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      exit();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div
      className="overlay task-dialog-overlay"
      data-state={state}
      onClick={exit}
      onKeyDown={onKey}
    >
      <div
        className="overlay__box task-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="task-dialog__close"
          onClick={exit}
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>
        <div id="task-dialog-title" className="task-dialog__title">
          {props.mode === 'create' ? 'New task' : 'Edit task'}
        </div>

        <label className="task-dialog__field">
          <span className="task-dialog__label">Title</span>
          <input
            ref={titleRef}
            type="text"
            className="task-dialog__input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs to be done?"
            autoComplete="off"
          />
        </label>

        <label className="task-dialog__field">
          <span className="task-dialog__label">Notes</span>
          <textarea
            className="task-dialog__textarea"
            value={notes ?? ''}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional context, links, files…"
            rows={3}
          />
        </label>

        <label className="task-dialog__field">
          <span className="task-dialog__label">Folder</span>
          <input
            type="text"
            className="task-dialog__input task-dialog__input--mono"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="/absolute/path"
            spellCheck={false}
          />
        </label>

        <label className="task-dialog__field">
          <span className="task-dialog__label">Reference folder (optional)</span>
          <input
            type="text"
            className="task-dialog__input task-dialog__input--mono"
            value={refFolder ?? ''}
            onChange={(e) => setRefFolder(e.target.value)}
            placeholder="/absolute/path"
            spellCheck={false}
          />
        </label>

        <div className="task-dialog__row">
          <label className="task-dialog__field task-dialog__field--half">
            <span className="task-dialog__label">Start date</span>
            <input
              type="date"
              className="task-dialog__input"
              value={startAt ?? ''}
              onChange={(e) => setStartAt(e.target.value)}
              max={dueAt || undefined}
            />
          </label>
          <label className="task-dialog__field task-dialog__field--half">
            <span className="task-dialog__label">Due date</span>
            <input
              type="date"
              className="task-dialog__input"
              value={dueAt ?? ''}
              onChange={(e) => setDueAt(e.target.value)}
              min={startAt || undefined}
            />
          </label>
        </div>

        <div className="task-dialog__row">
          <label className="task-dialog__field task-dialog__field--half">
            <span className="task-dialog__label">Status</span>
            <select
              className="task-dialog__input"
              value={status}
              onChange={(e) => setStatus(e.target.value as TaskStatus)}
            >
              {(Object.keys(STATUS_LABELS) as TaskStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="task-dialog__checkbox">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
            />
            <span>Pinned</span>
          </label>
        </div>

        {error && <div className="task-dialog__error">{error}</div>}

        <div className="task-dialog__actions">
          <button
            type="button"
            className="task-dialog__btn task-dialog__btn--cancel"
            onClick={exit}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="task-dialog__btn task-dialog__btn--primary"
            onClick={() => void submit()}
            disabled={busy || !title.trim() || !folder.trim()}
          >
            {props.mode === 'create' ? 'Create' : 'Save'}
            <kbd className="task-dialog__btn__kbd">⌘↩</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

/** Convenience for the quick-add keybind: open the dialog with default folder. */
export function openTaskDialogEvent(req: TaskDialogRequest) {
  window.dispatchEvent(new CustomEvent('fm:openTask', { detail: req }));
}

void todayISO; // re-exported elsewhere; keep import live for future use
