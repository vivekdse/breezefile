// fm-nmt — Task creation/edit dialog.
//
// Opened via the `task` verb or the `T` keybind for quick-add. When opened
// for create the folder defaults to the active tab's cwd; for edit it is
// preloaded from the existing task. Cmd-Enter submits, Esc cancels.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useOverlayExit } from '../useOverlayExit';
import { createTask, shiftISO, todayISO, updateTask } from '../tasks';
import type { Task, TaskStatus } from '../types';
import {
  buildCronFromForm,
  parseCronToForm,
  describeCron,
  type RecurrenceKind,
} from '../recurrence';
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
  // Default start to today on create — most tasks are "active now". Edit
  // mode preserves whatever was stored (including null).
  const [startAt, setStartAt] = useState(
    initial?.start_at ?? (props.mode === 'create' ? todayISO() : ''),
  );
  const [dueAt, setDueAt] = useState(initial?.due_at ?? '');
  const [status, setStatus] = useState<TaskStatus>(initial?.status ?? 'pending');
  const [pinned, setPinned] = useState(initial?.pinned ?? false);

  // fm-zf3m — auto-execute fields. The form mirrors a structured
  // "recurrence kind + time + days" model and compiles to cron on submit.
  const [autoMode, setAutoMode] = useState(initial?.auto_mode ?? false);
  const [autoPrompt, setAutoPrompt] = useState(initial?.auto_prompt ?? '');
  const [recurrence, setRecurrence] = useState(parseCronToForm(initial?.cron ?? null));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recurrenceDescription = useMemo(() => describeCron(recurrence), [recurrence]);

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
    let cron: string | null;
    try {
      cron = autoMode ? buildCronFromForm(recurrence) : null;
    } catch (e) {
      setError((e as Error).message);
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
        auto_mode: autoMode,
        cron,
        auto_prompt: autoMode && autoPrompt.trim() ? autoPrompt.trim() : null,
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
          <div className="task-dialog__field task-dialog__field--half">
            <span className="task-dialog__label">Start date</span>
            <input
              type="date"
              className="task-dialog__input"
              value={startAt ?? ''}
              onChange={(e) => setStartAt(e.target.value)}
              max={dueAt || undefined}
            />
            <DateQuickChips value={startAt} onChange={setStartAt} />
          </div>
          <div className="task-dialog__field task-dialog__field--half">
            <span className="task-dialog__label">Due date</span>
            <input
              type="date"
              className="task-dialog__input"
              value={dueAt ?? ''}
              onChange={(e) => setDueAt(e.target.value)}
              min={startAt || undefined}
            />
            <DateQuickChips value={dueAt} onChange={setDueAt} includeWeekend />
          </div>
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

        <fieldset className="task-dialog__auto">
          <legend className="task-dialog__auto-legend">
            <label className="task-dialog__auto-toggle">
              <input
                type="checkbox"
                checked={autoMode}
                onChange={(e) => setAutoMode(e.target.checked)}
              />
              <span>Auto-execute with Claude</span>
            </label>
          </legend>

          {autoMode && (
            <>
              <div className="task-dialog__auto-row">
                <label className="task-dialog__field task-dialog__field--half">
                  <span className="task-dialog__label">Recurrence</span>
                  <select
                    className="task-dialog__input"
                    value={recurrence.kind}
                    onChange={(e) =>
                      setRecurrence({
                        ...recurrence,
                        kind: e.target.value as RecurrenceKind,
                      })
                    }
                  >
                    <option value="once">Run once on save</option>
                    <option value="daily">Daily</option>
                    <option value="weekdays">Weekdays (Mon–Fri)</option>
                    <option value="weekly">Weekly (pick days)</option>
                    <option value="custom">Custom cron</option>
                  </select>
                </label>

                {(recurrence.kind === 'daily' ||
                  recurrence.kind === 'weekdays' ||
                  recurrence.kind === 'weekly') && (
                  <label className="task-dialog__field task-dialog__field--half">
                    <span className="task-dialog__label">Time (local)</span>
                    <input
                      type="time"
                      className="task-dialog__input"
                      value={recurrence.time}
                      onChange={(e) =>
                        setRecurrence({ ...recurrence, time: e.target.value })
                      }
                    />
                  </label>
                )}
              </div>

              {recurrence.kind === 'weekly' && (
                <div
                  className="task-dialog__day-chips"
                  role="group"
                  aria-label="Days of week"
                >
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                    const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                    const active = recurrence.days.includes(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        className={[
                          'task-dialog__chip',
                          active ? 'task-dialog__chip--active' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onClick={() =>
                          setRecurrence({
                            ...recurrence,
                            days: active
                              ? recurrence.days.filter((x) => x !== d)
                              : [...recurrence.days, d],
                          })
                        }
                      >
                        {labels[d]}
                      </button>
                    );
                  })}
                </div>
              )}

              {recurrence.kind === 'custom' && (
                <label className="task-dialog__field">
                  <span className="task-dialog__label">
                    Cron expression (5 fields, local time)
                  </span>
                  <input
                    type="text"
                    className="task-dialog__input task-dialog__input--mono"
                    value={recurrence.cron}
                    onChange={(e) =>
                      setRecurrence({ ...recurrence, cron: e.target.value })
                    }
                    placeholder="e.g. 0 9 * * MON"
                    spellCheck={false}
                  />
                </label>
              )}

              <div className="task-dialog__auto-hint">{recurrenceDescription}</div>

              <label className="task-dialog__field">
                <span className="task-dialog__label">
                  Prompt override (optional)
                </span>
                <textarea
                  className="task-dialog__textarea"
                  value={autoPrompt ?? ''}
                  onChange={(e) => setAutoPrompt(e.target.value)}
                  placeholder="Defaults to the title + notes if empty."
                  rows={3}
                />
              </label>
            </>
          )}
        </fieldset>

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

/** Quick-date chips shown beneath a date input. Each chip is a real
 *  button so Tab reaches it and Space/Enter activates it — no mouse
 *  required. The compact set covers the 95% of common adjustments
 *  ("a couple of days", "next week"); the date picker handles the rest. */
function DateQuickChips({
  value,
  onChange,
  includeWeekend = false,
}: {
  value: string;
  onChange: (v: string) => void;
  includeWeekend?: boolean;
}) {
  const today = todayISO();
  const base = value || today;

  const chips: Array<{ label: string; value: string; title?: string }> = [
    { label: 'Today', value: today },
    { label: 'Tomorrow', value: shiftISO(today, 1) },
    { label: '+1w', value: shiftISO(base, 7), title: 'One week from current value' },
  ];
  if (includeWeekend) {
    // For due dates, "end of week" is more useful than another +Nd.
    const dow = new Date(today + 'T00:00:00').getDay(); // 0=Sun..6=Sat
    const daysToFri = (5 - dow + 7) % 7 || 7;
    chips.splice(2, 0, {
      label: 'Fri',
      value: shiftISO(today, daysToFri),
      title: 'This Friday',
    });
  }

  return (
    <div className="task-dialog__date-chips" role="group" aria-label="Quick dates">
      {chips.map((c) => (
        <button
          key={c.label}
          type="button"
          className={[
            'task-dialog__chip',
            value === c.value ? 'task-dialog__chip--active' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => onChange(c.value)}
          title={c.title ?? c.value}
        >
          {c.label}
        </button>
      ))}
      {value && (
        <button
          type="button"
          className="task-dialog__chip task-dialog__chip--clear"
          onClick={() => onChange('')}
          title="Clear date"
        >
          ×
        </button>
      )}
    </div>
  );
}
