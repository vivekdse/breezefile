// fm-nmt — Task creation/edit dialog.
//
// Opened via the `task` verb or the `T` keybind for quick-add. When opened
// for create the folder defaults to the active tab's cwd; for edit it is
// preloaded from the existing task. Cmd-Enter submits, Esc cancels.
//
// Keyboard-first inputs (fm-hbvg/26a7/k8gg/oxkg/h1xl/oyam):
//   - Date inputs accept ISO + shorthand (today/tom/+3d/fri/eow/eom).
//   - Folder inputs offer a type-ahead list of open-tab cwds + recent task
//     folders. Up/Down navigate, Enter or 1-9 commits.
//   - Recurrence is a single chip row (Once / Daily 9am / Weekdays 9am /
//     Weekly Mon 9am / Custom) with the existing fine-tune controls
//     revealed under it.
//   - In-dialog hotkeys: Cmd-A toggles auto-execute, Cmd-P toggles pinned,
//     Cmd-T/D/S/F/N jump focus to Title/Due/Start/Folder/Notes.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useOverlayExit } from '../useOverlayExit';
import {
  createTask,
  parseDateInput,
  shiftISO,
  todayISO,
  updateTask,
  useTasks,
} from '../tasks';
import { useStore } from '../store';
import type { Task, TaskStatus } from '../types';
import {
  buildCronFromForm,
  parseCronToForm,
  describeCron,
  defaultRecurrenceForm,
  type RecurrenceForm,
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

type Preset = { id: string; label: string; form: RecurrenceForm };

const RECURRENCE_PRESETS: Preset[] = [
  { id: 'once', label: 'Once', form: { ...defaultRecurrenceForm(), kind: 'once' } },
  { id: 'daily', label: 'Daily 9am', form: { ...defaultRecurrenceForm(), kind: 'daily', time: '09:00' } },
  { id: 'weekdays', label: 'Weekdays 9am', form: { ...defaultRecurrenceForm(), kind: 'weekdays', time: '09:00' } },
  { id: 'weekly-mon', label: 'Weekly Mon 9am', form: { ...defaultRecurrenceForm(), kind: 'weekly', time: '09:00', days: [1] } },
  { id: 'custom', label: 'Custom…', form: { ...defaultRecurrenceForm(), kind: 'custom' } },
];

function presetIdFor(f: RecurrenceForm): string {
  if (f.kind === 'once') return 'once';
  if (f.kind === 'daily' && f.time === '09:00') return 'daily';
  if (f.kind === 'weekdays' && f.time === '09:00') return 'weekdays';
  if (
    f.kind === 'weekly' &&
    f.time === '09:00' &&
    f.days.length === 1 &&
    f.days[0] === 1
  ) {
    return 'weekly-mon';
  }
  return 'custom';
}

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
  const activePresetId = useMemo(() => presetIdFor(recurrence), [recurrence]);
  const showCustomFineTune = activePresetId === 'custom' || recurrence.kind === 'weekly';

  const titleRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const startRef = useRef<HTMLInputElement>(null);
  const dueRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  // Folder suggestions: derive from open folder tabs + every distinct
  // folder mentioned by an existing task. Most-recent-first.
  const store = useStore();
  const { tasks } = useTasks({});
  const folderSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ path: string; label: string }> = [];
    const add = (p: string | null | undefined, label: string) => {
      if (!p) return;
      if (seen.has(p)) return;
      seen.add(p);
      out.push({ path: p, label });
    };
    for (const tab of store.state.tabs) {
      if (tab.kind === 'folder' && tab.trail.length) {
        const cwd = tab.trail[tab.trail.length - 1];
        add(cwd, 'open tab');
      }
    }
    // Tasks ordered by updated/created desc by the server already.
    for (const t of tasks) {
      add(t.folder, 'recent');
      if (t.ref_folder) add(t.ref_folder, 'recent');
    }
    return out;
  }, [store.state.tabs, tasks]);

  async function submit() {
    if (busy) return;
    if (!title.trim()) {
      setError('Title is required');
      titleRef.current?.focus();
      return;
    }
    if (!folder.trim()) {
      setError('Folder is required');
      folderRef.current?.focus();
      return;
    }
    const startISO = parseDateInput(startAt);
    if (startISO === undefined) {
      setError(`Couldn't parse start date: "${startAt}"`);
      startRef.current?.focus();
      return;
    }
    const dueISO = parseDateInput(dueAt);
    if (dueISO === undefined) {
      setError(`Couldn't parse due date: "${dueAt}"`);
      dueRef.current?.focus();
      return;
    }
    if (startISO && dueISO && dueISO < startISO) {
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
        start_at: startISO,
        due_at: dueISO,
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

  function focusField(which: 'title' | 'notes' | 'folder' | 'start' | 'due') {
    const map = {
      title: titleRef,
      notes: notesRef,
      folder: folderRef,
      start: startRef,
      due: dueRef,
    } as const;
    const el = map[which].current;
    if (el) {
      el.focus();
      if (el instanceof HTMLInputElement) el.select();
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
      return;
    }
    // Field-jump and toggle hotkeys. Use Cmd/Ctrl + Alt so we don't fight
    // browser/OS bindings or the user's typing inside text fields.
    if ((e.metaKey || e.ctrlKey) && e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 't') { e.preventDefault(); focusField('title'); return; }
      if (k === 'n') { e.preventDefault(); focusField('notes'); return; }
      if (k === 'f') { e.preventDefault(); focusField('folder'); return; }
      if (k === 's') { e.preventDefault(); focusField('start'); return; }
      if (k === 'd') { e.preventDefault(); focusField('due'); return; }
      if (k === 'a') { e.preventDefault(); setAutoMode((v) => !v); return; }
      if (k === 'p') { e.preventDefault(); setPinned((v) => !v); return; }
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
            ref={notesRef}
            className="task-dialog__textarea"
            value={notes ?? ''}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional context, links, files…"
            rows={3}
          />
        </label>

        <FolderField
          label="Folder"
          value={folder}
          onChange={setFolder}
          inputRef={folderRef}
          suggestions={folderSuggestions}
        />

        <FolderField
          label="Reference folder (optional)"
          value={refFolder}
          onChange={setRefFolder}
          suggestions={folderSuggestions}
        />

        <div className="task-dialog__row">
          <DateField
            label="Start date"
            value={startAt}
            onChange={setStartAt}
            inputRef={startRef}
          />
          <DateField
            label="Due date"
            value={dueAt}
            onChange={setDueAt}
            inputRef={dueRef}
            includeWeekend
          />
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
              <PresetChips
                presets={RECURRENCE_PRESETS}
                activeId={activePresetId}
                onPick={(p) => setRecurrence(p.form)}
              />

              {showCustomFineTune && (
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
              )}

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

        <div className="task-dialog__shortcuts" aria-hidden="true">
          <span><kbd>⌘↩</kbd> save</span>
          <span><kbd>esc</kbd> close</span>
          <span><kbd>⌘⌥A</kbd> auto</span>
          <span><kbd>⌘⌥P</kbd> pin</span>
          <span><kbd>⌘⌥T/N/F/S/D</kbd> jump</span>
        </div>

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

/** Date input that accepts ISO + shorthand (today, tom, +3d, fri, eow…).
 *  Shows a resolved-ISO caption when the input isn't already an ISO date,
 *  and a chip row beneath for the most common one-click adjustments. */
function DateField({
  label,
  value,
  onChange,
  inputRef,
  includeWeekend,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  includeWeekend?: boolean;
}) {
  const parsed = parseDateInput(value);
  const isExactIso = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  const caption =
    parsed === undefined
      ? `couldn't parse "${value}"`
      : parsed && !isExactIso
        ? `→ ${parsed} (${dowLabel(parsed)})`
        : '';
  return (
    <div className="task-dialog__field task-dialog__field--half">
      <span className="task-dialog__label">{label}</span>
      <input
        ref={inputRef}
        type="text"
        className="task-dialog__input task-dialog__input--mono"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder="YYYY-MM-DD or tom, +3d, fri"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={parsed === undefined ? 'true' : undefined}
      />
      <DateQuickChips value={parsed ?? ''} onChange={onChange} includeWeekend={includeWeekend} />
      {caption && (
        <span
          className={[
            'task-dialog__date-caption',
            parsed === undefined ? 'task-dialog__date-caption--error' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {caption}
        </span>
      )}
    </div>
  );
}

function dowLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(y, m - 1, d).getDay()];
}

/** Folder input + type-ahead suggestion list. The list is filtered by
 *  substring against the input value; arrow keys navigate, Enter or 1-9
 *  commits. Suggestions stay hidden when the value already exactly
 *  matches one (no point showing it back to the user). */
function FolderField({
  label,
  value,
  onChange,
  inputRef,
  suggestions,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  suggestions: Array<{ path: string; label: string }>;
}) {
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const filtered = useMemo(() => {
    const v = value.trim().toLowerCase();
    const list = suggestions.filter((s) => s.path !== value);
    if (!v) return list.slice(0, 6);
    return list.filter((s) => s.path.toLowerCase().includes(v)).slice(0, 6);
  }, [suggestions, value]);

  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(0);
  }, [filtered.length, highlight]);

  const showList = focused && filtered.length > 0;

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showList) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      // Cmd/Ctrl+Enter is reserved for submit — only swallow plain Enter
      // when the user is actively navigating the suggestion list.
      const pick = filtered[highlight];
      if (pick) {
        e.preventDefault();
        onChange(pick.path);
      }
    } else if (e.key >= '1' && e.key <= '9' && (e.altKey || e.metaKey || e.ctrlKey)) {
      const idx = Number(e.key) - 1;
      if (filtered[idx]) {
        e.preventDefault();
        onChange(filtered[idx].path);
      }
    }
  }

  return (
    <div className="task-dialog__field task-dialog__folder-field">
      <span className="task-dialog__label">{label}</span>
      <input
        ref={inputRef}
        type="text"
        className="task-dialog__input task-dialog__input--mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        // Delay so a click on a suggestion still fires before we hide it.
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        onKeyDown={onInputKey}
        placeholder="/absolute/path"
        spellCheck={false}
        autoComplete="off"
      />
      {showList && (
        <ul className="task-dialog__suggestions" role="listbox">
          {filtered.map((s, i) => (
            <li
              key={s.path}
              role="option"
              aria-selected={i === highlight}
              className={[
                'task-dialog__suggestion',
                i === highlight ? 'task-dialog__suggestion--active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(s.path);
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              <span className="task-dialog__suggestion__num">{i + 1}</span>
              <span className="task-dialog__suggestion__path">{s.path}</span>
              <span className="task-dialog__suggestion__src">{s.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Single-row preset selector for recurrence — covers the common cases
 *  with one click/keystroke instead of three (kind + time + days). */
function PresetChips({
  presets,
  activeId,
  onPick,
}: {
  presets: Preset[];
  activeId: string;
  onPick: (p: Preset) => void;
}) {
  return (
    <div className="task-dialog__preset-chips" role="group" aria-label="Recurrence presets">
      {presets.map((p) => (
        <button
          key={p.id}
          type="button"
          className={[
            'task-dialog__chip',
            p.id === activeId ? 'task-dialog__chip--active' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => onPick(p)}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
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
