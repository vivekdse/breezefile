// fm-btyv — inline verb-driven task composer.
//
// Replaces TaskDialog. Opens on `fm:openTask` (same payload shape as the
// old dialog so every existing call site keeps working).
//
// Shape: a slim floating bar near the top of the viewport — title input
// on the left, a row of detail pills on the right (folder · when ·
// executor · auto). The default flow is "type a title and hit Enter";
// users who want more reach for Tab to walk into the pills.
//
// Keys at the title level:
//   Enter        save with whatever pills hold (or sensible defaults)
//   Cmd-Enter    same — quick-save shortcut
//   Tab          focus next pill (folder → when → executor → auto)
//   Esc          cancel
//
// Keys inside an open pill picker:
//   ↑ / ↓        move highlight
//   Enter        select
//   Tab          accept current value, advance to next pill
//   Cmd          skip this pill (leave value untouched), advance
//   Esc          close the picker (back to title)

import { useEffect, useMemo, useRef, useState } from 'react';
import { useOverlayExit } from '../useOverlayExit';
import { basename } from '../actions';
import { createTask, parseDateInput, todayISO, updateTask } from '../tasks';
import { humanizeError } from '../errorMessages';
import {
  type RecurrenceForm,
  buildCronFromForm,
  defaultRecurrenceForm,
} from '../recurrence';
import type { Task, TaskCreate, TaskUpdate } from '../types';
import './TaskComposer.css';

export type TaskComposerRequest =
  | { mode: 'create'; defaultFolder: string }
  | { mode: 'edit'; task: Task };

type Props = TaskComposerRequest & { onClose: () => void };

type ExecutorId = 'manual' | 'claude';
type WhenId =
  | 'on-demand'
  | 'today'
  | 'tomorrow'
  | 'daily-9'
  | 'weekdays-9'
  | 'weekly-mon-9'
  | 'none';

type PillKey = 'folder' | 'when' | 'executor' | 'auto';

const PILL_ORDER: PillKey[] = ['folder', 'when', 'executor', 'auto'];

const EXECUTOR_OPTIONS: { id: ExecutorId; label: string }[] = [
  { id: 'manual', label: 'Manual (me)' },
  { id: 'claude', label: 'Claude Code' },
];

const WHEN_OPTIONS: {
  id: WhenId;
  label: string;
  hint?: string;
  recurrence?: RecurrenceForm;
  /** When this preset implies a single-shot due date instead of cron. */
  dueOffsetDays?: number | null;
  onDemand?: boolean;
}[] = [
  { id: 'none', label: 'No due date', hint: 'just a to-do' },
  { id: 'today', label: 'Due today', dueOffsetDays: 0 },
  { id: 'tomorrow', label: 'Due tomorrow', dueOffsetDays: 1 },
  {
    id: 'on-demand',
    label: 'On demand',
    hint: 'agent runs only from the picker',
    onDemand: true,
    recurrence: { ...defaultRecurrenceForm(), kind: 'once' },
  },
  {
    id: 'daily-9',
    label: 'Daily 9am',
    recurrence: { ...defaultRecurrenceForm(), kind: 'daily', time: '09:00' },
  },
  {
    id: 'weekdays-9',
    label: 'Weekdays 9am',
    recurrence: { ...defaultRecurrenceForm(), kind: 'weekdays', time: '09:00' },
  },
  {
    id: 'weekly-mon-9',
    label: 'Weekly Mon 9am',
    recurrence: {
      ...defaultRecurrenceForm(),
      kind: 'weekly',
      time: '09:00',
      days: [1],
    },
  },
];

function pickWhenIdFromTask(task: Task): WhenId {
  // Auto-mode tasks lean on cron / on-demand. Manual tasks lean on due_at.
  if (task.auto_mode) {
    if (!task.cron) return 'on-demand';
    if (task.cron === '0 9 * * *') return 'daily-9';
    if (task.cron === '0 9 * * 1-5') return 'weekdays-9';
    if (task.cron === '0 9 * * 1') return 'weekly-mon-9';
    return 'on-demand'; // unknown cron → fall back, user can re-pick
  }
  if (task.due_at) {
    const today = todayISO();
    if (task.due_at === today) return 'today';
    // Naively compare ISO strings for "tomorrow"
    const t = new Date(today + 'T00:00:00');
    t.setDate(t.getDate() + 1);
    const tom = t.toISOString().slice(0, 10);
    if (task.due_at === tom) return 'tomorrow';
  }
  return 'none';
}

export function TaskComposer(props: Props) {
  const { exit, state } = useOverlayExit(props.onClose);
  const initial: Task | null = props.mode === 'edit' ? props.task : null;

  const [title, setTitle] = useState(initial?.title ?? '');
  const [folder, setFolder] = useState(
    initial?.folder ?? (props.mode === 'create' ? props.defaultFolder : ''),
  );
  const [whenId, setWhenId] = useState<WhenId>(
    initial ? pickWhenIdFromTask(initial) : 'none',
  );
  const [executor, setExecutor] = useState<ExecutorId>(
    initial?.auto_mode ? 'claude' : 'manual',
  );
  const [autoEnabled, setAutoEnabled] = useState<boolean>(
    initial?.auto_mode ?? false,
  );
  const [openPill, setOpenPill] = useState<PillKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  // Keep auto consistent with executor: turning to manual disables auto;
  // turning to an agent leaves auto as the user set it (default off).
  useEffect(() => {
    if (executor === 'manual' && autoEnabled) setAutoEnabled(false);
  }, [executor, autoEnabled]);

  const folderLabel = folder ? basename(folder) || folder : 'any folder';
  const whenLabel = WHEN_OPTIONS.find((w) => w.id === whenId)?.label ?? 'No due date';
  const executorLabel = EXECUTOR_OPTIONS.find((x) => x.id === executor)?.label ?? 'Manual';
  const autoVisible = executor !== 'manual';

  function nextPill(from: PillKey | null): PillKey | null {
    const order = autoVisible ? PILL_ORDER : PILL_ORDER.filter((p) => p !== 'auto');
    if (from === null) return order[0];
    const i = order.indexOf(from);
    return i >= 0 && i < order.length - 1 ? order[i + 1] : null;
  }

  async function save() {
    if (busy) return;
    if (!title.trim()) {
      setError('Add a title.');
      titleRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const when = WHEN_OPTIONS.find((w) => w.id === whenId);
      const isAgent = executor === 'claude';
      const isAuto = isAgent && autoEnabled;

      let dueAt: string | null = initial?.due_at ?? null;
      let cron: string | null = null;
      let nextRunAt: number | null | undefined = undefined;

      if (when) {
        if (when.recurrence && isAuto) {
          cron = buildCronFromForm(when.recurrence);
        }
        if (when.onDemand && isAuto) {
          nextRunAt = null; // explicit "don't fire automatically"
        }
        if (when.dueOffsetDays != null) {
          const today = todayISO();
          if (when.dueOffsetDays === 0) {
            dueAt = today;
          } else {
            const d = new Date(today + 'T00:00:00');
            d.setDate(d.getDate() + when.dueOffsetDays);
            dueAt = d.toISOString().slice(0, 10);
          }
        } else if (when.id === 'none') {
          dueAt = null;
        }
      }

      // Validate any pre-existing dates we kept from the task.
      if (initial?.start_at) {
        const s = parseDateInput(initial.start_at);
        if (s === undefined) {
          setError(`Bad start date on this task: ${initial.start_at}`);
          setBusy(false);
          return;
        }
      }

      const basePayload = {
        title: title.trim(),
        folder: folder.trim(),
        notes: initial?.notes ?? null,
        ref_folder: initial?.ref_folder ?? null,
        start_at: initial?.start_at ?? (props.mode === 'create' ? todayISO() : null),
        due_at: dueAt,
        status: initial?.status ?? 'pending',
        pinned: initial?.pinned ?? false,
        auto_mode: isAuto,
        auto_agent: isAuto ? 'claude' : null,
        cron,
        auto_prompt: initial?.auto_prompt ?? null,
        ...(nextRunAt !== undefined ? { next_run_at: nextRunAt } : {}),
      };

      if (props.mode === 'create') {
        await createTask(basePayload as TaskCreate);
      } else {
        await updateTask(props.task.id, basePayload as TaskUpdate);
      }
      exit();
    } catch (e) {
      setError(humanizeError(e).message);
      setBusy(false);
    }
  }

  function onTitleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      exit();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      void save();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      setOpenPill(nextPill(null));
      return;
    }
  }

  function onPillKey(
    e: React.KeyboardEvent,
    current: PillKey,
    options: string[],
    selectedIndex: number,
    apply: (idx: number) => void,
  ) {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpenPill(null);
      titleRef.current?.focus();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter inside a pill commits the pill's currently-highlighted choice
      // and saves the task immediately. This lets keyboard users type
      // title → Tab → ↓ → Enter to ship without touching the mouse.
      void save();
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const n = nextPill(current);
      setOpenPill(n);
      return;
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const order = autoVisible
        ? PILL_ORDER
        : PILL_ORDER.filter((p) => p !== 'auto');
      const i = order.indexOf(current);
      if (i <= 0) {
        setOpenPill(null);
        titleRef.current?.focus();
      } else {
        setOpenPill(order[i - 1]);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      apply((selectedIndex + 1) % options.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      apply((selectedIndex - 1 + options.length) % options.length);
      return;
    }
    // Cmd-. (period) skips the current pill without changing it. Mac
    // convention for "cancel this small thing without bailing on the
    // whole flow." Advances to the next pill in order.
    if (e.key === '.' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const n = nextPill(current);
      setOpenPill(n);
      if (n === null) titleRef.current?.focus();
      return;
    }
  }

  return (
    <div className="overlay composer-overlay" data-state={state} onClick={exit}>
      <div
        className="composer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="composer-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="composer__row">
          <span className="composer__label" id="composer-title">
            {props.mode === 'edit' ? 'Edit task' : 'New task'}
          </span>
          <input
            ref={titleRef}
            className="composer__title"
            type="text"
            value={title}
            placeholder="What's this task?"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={onTitleKey}
            spellCheck={false}
            autoComplete="off"
          />
          <PillRow
            folderLabel={folderLabel}
            whenLabel={whenLabel}
            executorLabel={executorLabel}
            autoEnabled={autoEnabled}
            autoVisible={autoVisible}
            openPill={openPill}
            onOpen={(p) => setOpenPill(p === openPill ? null : p)}
          />
        </div>

        {openPill === 'folder' && (
          <FolderPicker
            value={folder}
            onChange={(v) => {
              setFolder(v);
              const n = nextPill('folder');
              setOpenPill(n);
            }}
            onSkip={() => setOpenPill(nextPill('folder'))}
            onKey={(e, opts, idx, apply) => onPillKey(e, 'folder', opts, idx, apply)}
            cwdSuggestion={
              props.mode === 'create' ? props.defaultFolder : undefined
            }
          />
        )}
        {openPill === 'when' && (
          <SimplePicker
            options={WHEN_OPTIONS.map((w) => ({
              id: w.id,
              label: w.label,
              hint: w.hint,
            }))}
            value={whenId}
            onPick={(id) => {
              setWhenId(id as WhenId);
              setOpenPill(nextPill('when'));
            }}
            onKey={(e, opts, idx, apply) => onPillKey(e, 'when', opts, idx, apply)}
          />
        )}
        {openPill === 'executor' && (
          <SimplePicker
            options={EXECUTOR_OPTIONS.map((x) => ({ id: x.id, label: x.label }))}
            value={executor}
            onPick={(id) => {
              setExecutor(id as ExecutorId);
              setOpenPill(nextPill('executor'));
            }}
            onKey={(e, opts, idx, apply) => onPillKey(e, 'executor', opts, idx, apply)}
          />
        )}
        {openPill === 'auto' && autoVisible && (
          <SimplePicker
            options={[
              { id: 'on', label: 'Auto: on', hint: 'agent runs on the schedule above' },
              { id: 'off', label: 'Auto: off', hint: 'agent runs only when you ask' },
            ]}
            value={autoEnabled ? 'on' : 'off'}
            onPick={(id) => {
              setAutoEnabled(id === 'on');
              setOpenPill(nextPill('auto'));
            }}
            onKey={(e, opts, idx, apply) => onPillKey(e, 'auto', opts, idx, apply)}
          />
        )}

        <div className="composer__hint">
          {error ? (
            <span className="composer__error">{error}</span>
          ) : (
            <>
              <kbd>↵</kbd> save · <kbd>⇥</kbd> details · <kbd>⌘.</kbd> skip · <kbd>esc</kbd> cancel
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Pill row ──────────────────────────────────────────────────────── */

function PillRow({
  folderLabel,
  whenLabel,
  executorLabel,
  autoEnabled,
  autoVisible,
  openPill,
  onOpen,
}: {
  folderLabel: string;
  whenLabel: string;
  executorLabel: string;
  autoEnabled: boolean;
  autoVisible: boolean;
  openPill: PillKey | null;
  onOpen: (p: PillKey) => void;
}) {
  return (
    <div className="composer__pills" role="group" aria-label="Task details">
      <Pill
        glyph="📁"
        label={folderLabel}
        active={openPill === 'folder'}
        onClick={() => onOpen('folder')}
      />
      <Pill
        glyph="⏰"
        label={whenLabel}
        active={openPill === 'when'}
        onClick={() => onOpen('when')}
      />
      <Pill
        glyph="🤖"
        label={executorLabel}
        active={openPill === 'executor'}
        onClick={() => onOpen('executor')}
      />
      {autoVisible && (
        <Pill
          glyph="⚡"
          label={autoEnabled ? 'Auto on' : 'Auto off'}
          active={openPill === 'auto'}
          onClick={() => onOpen('auto')}
        />
      )}
    </div>
  );
}

function Pill({
  glyph,
  label,
  active,
  onClick,
}: {
  glyph: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={'composer__pill' + (active ? ' composer__pill--active' : '')}
      onClick={onClick}
    >
      <span className="composer__pill-glyph" aria-hidden>{glyph}</span>
      <span className="composer__pill-label">{label}</span>
    </button>
  );
}

/* ── Pickers ───────────────────────────────────────────────────────── */

function SimplePicker({
  options,
  value,
  onPick,
  onKey,
}: {
  options: { id: string; label: string; hint?: string }[];
  value: string;
  onPick: (id: string) => void;
  onKey: (
    e: React.KeyboardEvent,
    opts: string[],
    selectedIndex: number,
    apply: (idx: number) => void,
  ) => void;
}) {
  const initialIdx = Math.max(0, options.findIndex((o) => o.id === value));
  const [idx, setIdx] = useState(initialIdx);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={0}
      className="composer__picker"
      role="listbox"
      onKeyDown={(e) =>
        onKey(
          e,
          options.map((o) => o.id),
          idx,
          (i) => setIdx(i),
        )
      }
    >
      {options.map((o, i) => (
        <button
          key={o.id}
          type="button"
          role="option"
          aria-selected={i === idx}
          className={
            'composer__option' + (i === idx ? ' composer__option--active' : '')
          }
          onMouseEnter={() => setIdx(i)}
          onClick={() => onPick(o.id)}
        >
          <span className="composer__option-label">{o.label}</span>
          {o.hint && <span className="composer__option-hint">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

function FolderPicker({
  value,
  onChange,
  onSkip,
  onKey,
  cwdSuggestion,
}: {
  value: string;
  onChange: (v: string) => void;
  onSkip: () => void;
  onKey: (
    e: React.KeyboardEvent,
    opts: string[],
    selectedIndex: number,
    apply: (idx: number) => void,
  ) => void;
  cwdSuggestion?: string;
}) {
  // Tiny picker: 'any folder' (empty), current cwd, plus a free-text input
  // for typing a path. v1 — type-ahead over open tabs / recents is fm-9mf
  // territory; keep it simple here.
  const [text, setText] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const presets = useMemo(() => {
    const out: { id: string; label: string; hint?: string; v: string }[] = [
      { id: 'any', label: 'Any folder', hint: 'runs from anywhere', v: '' },
    ];
    if (cwdSuggestion) {
      out.push({
        id: 'cwd',
        label: basename(cwdSuggestion) || cwdSuggestion,
        hint: cwdSuggestion,
        v: cwdSuggestion,
      });
    }
    return out;
  }, [cwdSuggestion]);
  return (
    <div className="composer__picker composer__picker--folder">
      <input
        ref={inputRef}
        className="composer__folder-input"
        type="text"
        placeholder="Type a folder path, or pick below"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onChange(text.trim());
            return;
          }
          if (e.key === 'Tab') {
            e.preventDefault();
            onChange(text.trim());
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onSkip();
            return;
          }
          // Otherwise let onKey handle arrows for the preset list below
          onKey(
            e,
            presets.map((p) => p.id),
            0,
            () => {},
          );
        }}
      />
      <div className="composer__folder-presets" role="listbox">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            className="composer__option"
            onClick={() => onChange(p.v)}
          >
            <span className="composer__option-label">{p.label}</span>
            {p.hint && <span className="composer__option-hint">{p.hint}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
