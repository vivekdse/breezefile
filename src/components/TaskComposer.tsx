// fm-btyv — full-width task composer.
//
// Visual model:
// - PAST answers render as large standalone text (just the answer; no
//   question, no label).
// - The ACTIVE question shows in a wide soft-shaded band: prompt +
//   options or input.
// - FUTURE questions render as large dim prompts (just the question).
//
// Keyboard:
// - ↑ / ↓ moves the active highlight; at the ends it walks into the
//   neighboring question (option questions only).
// - Digit keys (1-N) pick the corresponding option and advance.
// - Enter on the active option = pick + advance (or save on the last Q).
// - ⌘↵ saves at any time. Esc Esc cancels.
//
// The window keydown handler is registered ONCE via a ref that always
// points at the freshest closure — without that, the brief render gap
// between state change and effect re-registration drops the first
// keystroke after a section transition (which read like "manual digit
// doesn't advance").

import { useEffect, useMemo, useRef, useState } from 'react';
import { useOverlayExit } from '../useOverlayExit';
import { usePlatform } from '../platform';
import { fm } from '../bridge';
import { createTask, runTaskNow, todayISO, updateTask } from '../tasks';
import { humanizeError } from '../errorMessages';
import {
  type RecurrenceForm,
  buildCronFromForm,
  defaultRecurrenceForm,
} from '../recurrence';
import type { Task, TaskCreate, TaskStatus, TaskUpdate } from '../types';
import './TaskComposer.css';

export type TaskComposerRequest =
  | { mode: 'create'; defaultFolder: string }
  | { mode: 'edit'; task: Task };

type Props = TaskComposerRequest & { onClose: () => void };

type QuestionId =
  | 'title'
  | 'folder'
  | 'who'
  | 'when'
  | 'status'
  | 'start'
  | 'pin'
  | 'notes';
// Order is the keyboard ↓ flow. Name, folder, and notes come first — they
// are the only fields that actually matter for most tasks, and a task can
// be created the moment they're filled (everything below is optional and
// skippable). Start sits right before When so the two time questions read
// as a pair — "when can it start? / when is it due?".
const QUESTIONS: QuestionId[] = [
  'title', 'folder', 'who', 'notes',
  'start', 'when',
  'status', 'pin',
];

type ExecutorId = 'manual' | 'claude';

type WhenOption = {
  id: string;
  label: string;
  hint?: string;
  recurrence?: RecurrenceForm;
  dueOffsetDays?: number;
  onDemand?: boolean;
  agentOnly?: boolean;
  manualOnly?: boolean;
  pickDate?: boolean;
  runOnSave?: boolean;
  customCron?: boolean;
};

const WHEN_OPTIONS: WhenOption[] = [
  { id: 'none', label: 'No due date', hint: 'just a to-do', manualOnly: true },
  { id: 'today', label: 'Today', dueOffsetDays: 0, manualOnly: true },
  { id: 'tomorrow', label: 'Tomorrow', dueOffsetDays: 1, manualOnly: true },
  {
    id: 'on-demand',
    label: 'On demand',
    hint: 'agent runs when you pick it',
    onDemand: true,
    agentOnly: true,
    recurrence: { ...defaultRecurrenceForm(), kind: 'once' },
  },
  {
    id: 'daily-9',
    label: 'Daily 9am',
    agentOnly: true,
    recurrence: { ...defaultRecurrenceForm(), kind: 'daily', time: '09:00' },
  },
  {
    id: 'weekly-mon-9',
    label: 'Weekly Mon 9am',
    agentOnly: true,
    recurrence: {
      ...defaultRecurrenceForm(),
      kind: 'weekly',
      time: '09:00',
      days: [1],
    },
  },
  { id: 'pick-date', label: 'Pick a date…', hint: 'choose a calendar day', pickDate: true },
  {
    id: 'on-save',
    label: 'Run on save',
    hint: 'fires the agent immediately',
    agentOnly: true,
    runOnSave: true,
    recurrence: { ...defaultRecurrenceForm(), kind: 'once' },
  },
  {
    id: 'custom-cron',
    label: 'Custom cron…',
    hint: '5-field expression',
    agentOnly: true,
    customCron: true,
  },
];

const WHO_OPTIONS: { id: ExecutorId; label: string; hint?: string }[] = [
  { id: 'manual', label: 'Manual', hint: 'you do it' },
  { id: 'claude', label: 'Claude Code', hint: 'an AI agent does it' },
];

// fm-b5at.7 — agent flags vocabulary (mirrors electron/agents/flags.ts).
const FLAG_OPTIONS: { id: string; label: string; hint: string }[] = [
  { id: 'interactive', label: 'Interactive', hint: 'open the run in a new tab with an embedded claude session you converse with' },
  { id: 'chrome', label: 'Chrome', hint: 'let claude drive a Chrome browser session (--chrome)' },
  { id: 'auto', label: 'Auto-accept', hint: 'permissive permission mode for unattended edits (still human-gated)' },
];

const STATUS_OPTIONS: { id: TaskStatus; label: string; hint?: string }[] = [
  { id: 'pending', label: 'Pending', hint: 'not started yet' },
  { id: 'in_progress', label: 'In progress', hint: 'actively working' },
  { id: 'done', label: 'Done', hint: 'finished' },
  { id: 'cancelled', label: 'Cancelled', hint: 'no longer needed' },
];

type StartOption = {
  id: string;
  label: string;
  hint?: string;
  offsetDays?: number;
  pickDate?: boolean;
  none?: boolean;
};
const START_OPTIONS: StartOption[] = [
  { id: 'none', label: 'No start date', hint: 'available immediately', none: true },
  { id: 'today', label: 'Today', offsetDays: 0 },
  { id: 'tomorrow', label: 'Tomorrow', offsetDays: 1 },
  { id: 'pick-start', label: 'Pick a date…', hint: 'choose a calendar day', pickDate: true },
];

const PIN_OPTIONS: { id: 'no' | 'yes'; label: string; hint?: string }[] = [
  { id: 'no', label: 'Not pinned', hint: 'sits in normal order' },
  { id: 'yes', label: 'Pin', hint: 'floats to the top of every list' },
];

function pickStartIdFromTask(task: Task | null, today: string): string {
  // For a brand-new task we default to "today" — most users start now.
  // Edited tasks read whatever's actually stored.
  if (!task) return 'today';
  if (!task.start_at) return 'none';
  if (task.start_at === today) return 'today';
  const t = new Date(today + 'T00:00:00');
  t.setDate(t.getDate() + 1);
  if (task.start_at === t.toISOString().slice(0, 10)) return 'tomorrow';
  return 'pick-start';
}

function pickWhenIdFromTask(task: Task): string {
  if (task.auto_mode) {
    if (!task.cron) return 'on-demand';
    if (task.cron === '0 9 * * *') return 'daily-9';
    if (task.cron === '0 9 * * 1') return 'weekly-mon-9';
    return 'custom-cron';
  }
  if (task.due_at) {
    const today = todayISO();
    if (task.due_at === today) return 'today';
    const t = new Date(today + 'T00:00:00');
    t.setDate(t.getDate() + 1);
    if (task.due_at === t.toISOString().slice(0, 10)) return 'tomorrow';
    return 'pick-date';
  }
  return 'none';
}

function prettyFolder(p: string): string {
  if (!p) return 'Any folder';
  const home = '/Users/vivek.srinivasan';
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~/' + p.slice(home.length + 1);
  return p;
}

function formatDateNice(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function TaskComposer(props: Props) {
  const { exit, state } = useOverlayExit(props.onClose);
  const { caps } = usePlatform();
  // Submit accelerator is Cmd+Enter on macOS, Ctrl+Enter elsewhere — the
  // handler already accepts both; this is just the label so Linux users
  // don't see a ⌘ they don't have.
  const submitKbd = caps.id === 'mac' ? '⌘↵' : 'Ctrl+↵';
  const initial: Task | null = props.mode === 'edit' ? props.task : null;

  const [activeIdx, setActiveIdx] = useState(0);
  const active = QUESTIONS[activeIdx];

  const [title, setTitle] = useState(initial?.title ?? '');
  const [folder, setFolder] = useState(
    initial?.folder ?? (props.mode === 'create' ? props.defaultFolder : ''),
  );
  const [whenId, setWhenId] = useState<string>(
    initial ? pickWhenIdFromTask(initial) : 'none',
  );
  const [pickedDate, setPickedDate] = useState<string>(
    initial?.due_at && pickWhenIdFromTask(initial) === 'pick-date'
      ? initial.due_at
      : '',
  );
  const [customCron, setCustomCron] = useState<string>(
    initial && pickWhenIdFromTask(initial) === 'custom-cron' ? initial.cron ?? '' : '',
  );
  const [executor, setExecutor] = useState<ExecutorId>(
    initial?.auto_mode ? 'claude' : 'manual',
  );
  // fm-b5at.7 — agent flags (chrome/auto/interactive). Only meaningful for
  // Claude tasks; a Set keyed by flag name, persisted as the flags array.
  const [flags, setFlags] = useState<Set<string>>(
    () => new Set(initial?.flags ?? []),
  );
  const toggleFlag = (f: string) =>
    setFlags((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  const [status, setStatus] = useState<TaskStatus>(initial?.status ?? 'pending');
  const [pinned, setPinned] = useState<boolean>(initial?.pinned ?? false);
  // Notes doubles as the agent prompt for Claude tasks (one field, not two).
  // If a legacy task only has auto_prompt set, surface it in notes so the
  // user can see and edit it; we'll save it back as notes (auto_prompt
  // always saves as null going forward).
  const [notes, setNotes] = useState<string>(
    initial?.notes && initial.notes.length > 0
      ? initial.notes
      : initial?.auto_prompt ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [escArmed, setEscArmed] = useState(false);
  const [created, setCreated] = useState(false);
  // 'editing' = walking through the questions; 'commit' = focus has
  // moved to Create/Cancel and the band has hopped onto the footer.
  const [phase, setPhase] = useState<'editing' | 'commit'>('editing');

  const [startId, setStartId] = useState<string>(
    pickStartIdFromTask(initial, todayISO()),
  );
  const [pickedStart, setPickedStart] = useState<string>(
    initial?.start_at && pickStartIdFromTask(initial, todayISO()) === 'pick-start'
      ? initial.start_at
      : '',
  );

  const cwdSuggestion =
    props.mode === 'create' ? props.defaultFolder : initial?.folder ?? '';

  type FolderPreset = {
    id: string;
    label: string;
    hint?: string;
    v: string;
    pick?: boolean;
    agentDisallow?: boolean; // hidden when Claude is the executor
  };
  const folderPresets = useMemo<FolderPreset[]>(() => {
    const out: FolderPreset[] = [];
    if (cwdSuggestion) {
      out.push({
        id: 'this',
        label: 'This folder',
        hint: prettyFolder(cwdSuggestion),
        v: cwdSuggestion,
      });
    }
    out.push({
      id: 'any',
      label: 'Any folder',
      hint: 'task can run from anywhere',
      v: '',
      agentDisallow: true,
    });
    out.push({
      id: 'pick',
      label: 'Select folder…',
      hint: 'choose from disk',
      v: '',
      pick: true,
    });
    return out;
  }, [cwdSuggestion]);

  // Claude scheduled tasks need a real folder (backend rule). Hide the
  // "Any folder" preset whenever the agent is the executor so the user
  // can't pick something the save will reject.
  const visibleFolderPresets = useMemo(() => {
    if (executor === 'claude') return folderPresets.filter((p) => !p.agentDisallow);
    return folderPresets;
  }, [folderPresets, executor]);

  const visibleWhenOptions = useMemo(() => {
    return WHEN_OPTIONS.filter((w) => {
      if (executor === 'claude' && w.manualOnly) return false;
      if (executor === 'manual' && w.agentOnly) return false;
      return true;
    });
  }, [executor]);

  const [whenHighlight, setWhenHighlight] = useState(() =>
    Math.max(0, visibleWhenOptions.findIndex((w) => w.id === whenId)),
  );
  const [whoHighlight, setWhoHighlight] = useState(() =>
    Math.max(0, WHO_OPTIONS.findIndex((w) => w.id === executor)),
  );
  const [folderHighlight, setFolderHighlight] = useState(() => {
    const i = visibleFolderPresets.findIndex((p) => p.v === folder);
    return i >= 0 ? i : 0;
  });
  const [statusHighlight, setStatusHighlight] = useState(() =>
    Math.max(0, STATUS_OPTIONS.findIndex((s) => s.id === status)),
  );
  const [startHighlight, setStartHighlight] = useState(() =>
    Math.max(0, START_OPTIONS.findIndex((s) => s.id === startId)),
  );
  const [pinHighlight, setPinHighlight] = useState(() => (pinned ? 1 : 0));

  // If executor changes and the current When pick is hidden, reset.
  useEffect(() => {
    if (!visibleWhenOptions.some((w) => w.id === whenId)) {
      const def = visibleWhenOptions[0]?.id ?? 'none';
      setWhenId(def);
      setWhenHighlight(0);
    }
  }, [visibleWhenOptions, whenId]);

  // If user picked Claude while folder was "Any folder", repair it to
  // the cwd so they don't end up in an unrunnable state.
  useEffect(() => {
    if (executor === 'claude' && folder === '' && cwdSuggestion) {
      setFolder(cwdSuggestion);
      setFolderHighlight(0);
    }
  }, [executor, cwdSuggestion]); // eslint-disable-line react-hooks/exhaustive-deps

  const titleRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const cronInputRef = useRef<HTMLInputElement>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const createBtnRef = useRef<HTMLButtonElement>(null);
  const startDateRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  // Stand down the global keyboard handler while composer is open.
  useEffect(() => {
    document.body.dataset.composerOpen = 'true';
    return () => { delete document.body.dataset.composerOpen; };
  }, []);

  // Focus per active question. Title focuses the title input; Notes
  // focuses the textarea (so the user can type immediately); option
  // questions focus the section div so digit keys aren't eaten by an
  // input.
  useEffect(() => {
    if (active === 'title') {
      titleRef.current?.focus();
      titleRef.current?.select();
    } else if (active === 'notes') {
      notesRef.current?.focus();
    } else {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        el.blur();
      }
      sectionRef.current?.focus();
    }
  }, [active]);

  function goBack() {
    if (activeIdx > 0) setActiveIdx(activeIdx - 1);
  }
  function goNext() {
    if (activeIdx < QUESTIONS.length - 1) setActiveIdx(activeIdx + 1);
  }

  async function pickFolderFromDisk() {
    try {
      const picked = await fm.pickFolder(cwdSuggestion || undefined);
      if (picked) {
        setFolder(picked);
        goNext();
      }
    } catch {
      /* noop */
    }
  }

  function chooseFolderPreset(i: number) {
    const p = visibleFolderPresets[i];
    if (!p) return;
    setFolderHighlight(i);
    if (p.pick) {
      void pickFolderFromDisk();
      return;
    }
    setFolder(p.v);
    goNext();
  }

  function chooseWho(i: number) {
    const o = WHO_OPTIONS[i];
    if (!o) return;
    setExecutor(o.id);
    setWhoHighlight(i);
    setStartHighlight(START_OPTIONS.findIndex((s) => s.id === startId));
    goNext();
  }

  function chooseStart(i: number) {
    const opt = START_OPTIONS[i];
    if (!opt) return;
    setStartId(opt.id);
    setStartHighlight(i);
    if (opt.pickDate) {
      setTimeout(() => startDateRef.current?.focus(), 0);
      return;
    }
    setWhenHighlight(visibleWhenOptions.findIndex((w) => w.id === whenId));
    goNext();
  }

  function chooseWhen(i: number) {
    const opt = visibleWhenOptions[i];
    if (!opt) return;
    setWhenId(opt.id);
    setWhenHighlight(i);
    if (opt.pickDate) {
      setTimeout(() => dateInputRef.current?.focus(), 0);
      return;
    }
    if (opt.customCron) {
      setTimeout(() => cronInputRef.current?.focus(), 0);
      return;
    }
    setStatusHighlight(STATUS_OPTIONS.findIndex((s) => s.id === status));
    goNext();
  }

  function chooseStatus(i: number) {
    const o = STATUS_OPTIONS[i];
    if (!o) return;
    setStatus(o.id);
    setStatusHighlight(i);
    setPinHighlight(pinned ? 1 : 0);
    goNext();
  }

  function choosePin(i: number) {
    const o = PIN_OPTIONS[i];
    if (!o) return;
    setPinned(o.id === 'yes');
    setPinHighlight(i);
    enterCommitPhase();
  }

  function enterCommitPhase() {
    setPhase('commit');
    setTimeout(() => createBtnRef.current?.focus(), 0);
  }
  function backToEditing() {
    // Return to the last question (Pin); the [active] effect restores
    // focus to its section.
    setPhase('editing');
    setActiveIdx(QUESTIONS.length - 1);
  }

  // ↓ flow: title → folder → who → notes → start → when → status → pin → commit
  function moveDown() {
    if (active === 'title') {
      if (title.trim()) goNext();
      return;
    }
    if (active === 'folder') {
      if (folderHighlight >= visibleFolderPresets.length - 1) {
        setWhoHighlight(0);
        goNext();
      } else setFolderHighlight((i) => i + 1);
      return;
    }
    if (active === 'who') {
      // Who → Notes (Notes has no option list; it's a textarea).
      if (whoHighlight >= WHO_OPTIONS.length - 1) goNext();
      else setWhoHighlight((i) => i + 1);
      return;
    }
    if (active === 'notes') {
      // Notes → Start. ↓ outside the textarea advances to scheduling.
      setStartHighlight(START_OPTIONS.findIndex((s) => s.id === startId));
      goNext();
      return;
    }
    if (active === 'start') {
      if (startHighlight >= START_OPTIONS.length - 1) {
        setWhenHighlight(visibleWhenOptions.findIndex((w) => w.id === whenId));
        goNext();
      } else setStartHighlight((i) => i + 1);
      return;
    }
    if (active === 'when') {
      if (whenHighlight < visibleWhenOptions.length - 1) {
        setWhenHighlight((i) => i + 1);
      } else {
        setStatusHighlight(STATUS_OPTIONS.findIndex((s) => s.id === status));
        goNext();
      }
      return;
    }
    if (active === 'status') {
      if (statusHighlight >= STATUS_OPTIONS.length - 1) {
        setPinHighlight(pinned ? 1 : 0);
        goNext();
      } else setStatusHighlight((i) => i + 1);
      return;
    }
    if (active === 'pin') {
      // Pin is the last question — ↓ off the end goes to commit.
      if (pinHighlight >= PIN_OPTIONS.length - 1) enterCommitPhase();
      else setPinHighlight((i) => i + 1);
      return;
    }
  }
  function moveUp() {
    if (active === 'title') return;
    if (active === 'folder') {
      if (folderHighlight === 0) goBack();
      else setFolderHighlight((i) => i - 1);
      return;
    }
    if (active === 'who') {
      if (whoHighlight === 0) {
        setFolderHighlight(visibleFolderPresets.length - 1);
        goBack();
      } else setWhoHighlight((i) => i - 1);
      return;
    }
    if (active === 'start') {
      // Start ↑ → back into Notes (the textarea regains focus via the
      // [active] effect).
      if (startHighlight === 0) goBack();
      else setStartHighlight((i) => i - 1);
      return;
    }
    if (active === 'when') {
      if (whenHighlight === 0) {
        setStartHighlight(START_OPTIONS.length - 1);
        goBack();
      } else setWhenHighlight((i) => i - 1);
      return;
    }
    if (active === 'status') {
      if (statusHighlight === 0) {
        setWhenHighlight(visibleWhenOptions.length - 1);
        goBack();
      } else setStatusHighlight((i) => i - 1);
      return;
    }
    if (active === 'pin') {
      if (pinHighlight === 0) {
        setStatusHighlight(STATUS_OPTIONS.length - 1);
        goBack();
      } else setPinHighlight((i) => i - 1);
      return;
    }
    if (active === 'notes') {
      // Notes ↑ → back to Who.
      setWhoHighlight(WHO_OPTIONS.length - 1);
      goBack();
      return;
    }
  }

  async function save(overrideWhenId?: string) {
    if (busy) return;
    if (!title.trim()) {
      setError('Add a title.');
      setActiveIdx(0);
      setTimeout(() => titleRef.current?.focus(), 0);
      return;
    }
    const effectiveWhenId = overrideWhenId ?? whenId;
    if (effectiveWhenId === 'pick-date' && !pickedDate) {
      setError('Pick a date.');
      setActiveIdx(QUESTIONS.indexOf('when'));
      setTimeout(() => dateInputRef.current?.focus(), 0);
      return;
    }
    if (effectiveWhenId === 'custom-cron') {
      const trimmed = customCron.trim();
      if (!trimmed || trimmed.split(/\s+/).length !== 5) {
        setError('Cron must have 5 space-separated fields.');
        setActiveIdx(QUESTIONS.indexOf('when'));
        setTimeout(() => cronInputRef.current?.focus(), 0);
        return;
      }
    }
    if (startId === 'pick-start' && !pickedStart) {
      setError('Pick a start date.');
      setActiveIdx(QUESTIONS.indexOf('start'));
      setTimeout(() => startDateRef.current?.focus(), 0);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const when = WHEN_OPTIONS.find((w) => w.id === effectiveWhenId);
      const isAgent = executor === 'claude';

      let dueAt: string | null = initial?.due_at ?? null;
      let cron: string | null = null;
      let nextRunAt: number | null | undefined = undefined;
      let autoMode = false;

      if (when) {
        if (when.pickDate) {
          dueAt = pickedDate || null;
          if (isAgent && pickedDate) {
            autoMode = true;
            const d = new Date(pickedDate + 'T09:00:00');
            nextRunAt = d.getTime();
          }
        } else if (when.dueOffsetDays != null) {
          const today = todayISO();
          const d = new Date(today + 'T00:00:00');
          d.setDate(d.getDate() + when.dueOffsetDays);
          dueAt = d.toISOString().slice(0, 10);
        } else if (when.id === 'none') {
          dueAt = null;
        }
        if (isAgent && when.recurrence) {
          cron = buildCronFromForm(when.recurrence);
          autoMode = true;
        }
        if (isAgent && when.onDemand) {
          autoMode = true;
          nextRunAt = null;
        }
        if (isAgent && when.customCron) {
          cron = customCron.trim();
          autoMode = true;
        }
        if (isAgent && when.runOnSave) {
          autoMode = true;
          cron = null;
          nextRunAt = null;
        }
      }

      const trimmedNotes = notes.trim();
      const startOpt = START_OPTIONS.find((s) => s.id === startId);
      let resolvedStart: string | null = null;
      if (startOpt) {
        if (startOpt.pickDate) resolvedStart = pickedStart || null;
        else if (startOpt.offsetDays != null) {
          const today = todayISO();
          const d = new Date(today + 'T00:00:00');
          d.setDate(d.getDate() + startOpt.offsetDays);
          resolvedStart = d.toISOString().slice(0, 10);
        } else if (startOpt.none) resolvedStart = null;
      }
      const payload = {
        title: title.trim(),
        folder: folder.trim(),
        notes: trimmedNotes ? trimmedNotes : null,
        start_at: resolvedStart,
        due_at: dueAt,
        status,
        pinned,
        auto_mode: autoMode,
        auto_agent: autoMode ? 'claude' : null,
        cron,
        // Notes is the prompt for Claude tasks via the default template;
        // we no longer expose a separate override field.
        auto_prompt: null,
        // fm-b5at.7 — agent flags only apply to Claude tasks; a manual task
        // saves an empty list so a downgraded task doesn't carry stale flags.
        flags: isAgent ? [...flags] : [],
        ...(nextRunAt !== undefined ? { next_run_at: nextRunAt } : {}),
      };

      let savedId: string;
      if (props.mode === 'create') {
        const t = await createTask(payload as TaskCreate);
        savedId = t.id;
      } else {
        const t = await updateTask(props.task.id, payload as TaskUpdate);
        savedId = t.id;
      }
      if (isAgent && when?.runOnSave) {
        try { await runTaskNow(savedId); } catch { /* surfaced via runs list */ }
      }
      // Tell the sidebar to glow the row that just appeared. We also
      // stash the id on the window so a TaskRow that mounts AFTER the
      // event fires (the typical case — the row is added by the next
      // render tick) can pick it up on mount.
      (window as unknown as { __fmFlashTaskId?: string; __fmFlashTs?: number }).__fmFlashTaskId = savedId;
      (window as unknown as { __fmFlashTaskId?: string; __fmFlashTs?: number }).__fmFlashTs = Date.now();
      window.dispatchEvent(
        new CustomEvent('fm:taskFlash', { detail: { taskId: savedId } }),
      );
      setCreated(true);
      setTimeout(() => exit(), 900);
    } catch (e) {
      setError(humanizeError(e).message);
      setBusy(false);
    }
  }

  // Stable keydown listener that delegates to a ref-stored handler so
  // we never run a stale closure from before the latest state change.
  const handlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  handlerRef.current = (e: KeyboardEvent) => {
    function inText(): boolean {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA';
    }
    function tryCancel() {
      if (escArmed) { exit(); return; }
      setEscArmed(true);
      setTimeout(() => setEscArmed(false), 1500);
    }

    if (e.key === 'Escape') { e.preventDefault(); tryCancel(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
      return;
    }

    // Commit phase: focus is on Create/Cancel. Mirror the option-row
    // pattern with single-letter shortcuts (C / E) and let ↑ walk back
    // into the question flow.
    if (phase === 'commit') {
      if (inText()) return;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        backToEditing();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        void save();
        return;
      }
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        void save();
        return;
      }
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        exit();
        return;
      }
      return;
    }

    if (active === 'title') return;
    if (inText()) return;

    if (e.key === 'ArrowDown') { e.preventDefault(); moveDown(); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveUp();   return; }

    if (active === 'folder') {
      if (e.key === 'Enter') {
        e.preventDefault();
        chooseFolderPreset(folderHighlight);
        return;
      }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= visibleFolderPresets.length) {
        e.preventDefault();
        chooseFolderPreset(n - 1);
        return;
      }
      return;
    }
    if (active === 'who') {
      if (e.key === 'Enter') {
        e.preventDefault();
        chooseWho(whoHighlight);
        return;
      }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= WHO_OPTIONS.length) {
        e.preventDefault();
        chooseWho(n - 1);
        return;
      }
      return;
    }
    if (active === 'when') {
      if (e.key === 'Enter') {
        e.preventDefault();
        chooseWhen(whenHighlight);
        return;
      }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= visibleWhenOptions.length) {
        e.preventDefault();
        chooseWhen(n - 1);
        return;
      }
      return;
    }
    if (active === 'status') {
      if (e.key === 'Enter') {
        e.preventDefault();
        chooseStatus(statusHighlight);
        return;
      }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= STATUS_OPTIONS.length) {
        e.preventDefault();
        chooseStatus(n - 1);
        return;
      }
      return;
    }
    if (active === 'start') {
      if (e.key === 'Enter') {
        e.preventDefault();
        chooseStart(startHighlight);
        return;
      }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= START_OPTIONS.length) {
        e.preventDefault();
        chooseStart(n - 1);
        return;
      }
      return;
    }
    if (active === 'pin') {
      if (e.key === 'Enter') {
        e.preventDefault();
        choosePin(pinHighlight);
        return;
      }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= PIN_OPTIONS.length) {
        e.preventDefault();
        choosePin(n - 1);
        return;
      }
      return;
    }
    // 'notes' has no option list; the textarea handles typing. Global
    // ↓ from outside the textarea moves to commit (handled in moveDown).
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) { handlerRef.current?.(e); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Render helpers ───────────────────────────────────────────────────

  function whenSummary(): string {
    if (whenId === 'pick-date') {
      return pickedDate ? formatDateNice(pickedDate) : 'Pick a date…';
    }
    if (whenId === 'custom-cron') {
      return customCron.trim() ? `Cron: ${customCron.trim()}` : 'Custom cron…';
    }
    return WHEN_OPTIONS.find((w) => w.id === whenId)?.label ?? 'No due date';
  }
  function folderSummary(): string {
    if (!folder) return 'Any folder';
    return prettyFolder(folder);
  }
  function whoSummary(): string {
    return WHO_OPTIONS.find((w) => w.id === executor)?.label ?? 'Manual';
  }

  function statusSummary(): string {
    return STATUS_OPTIONS.find((s) => s.id === status)?.label ?? 'Pending';
  }
  function startSummary(): string {
    if (startId === 'pick-start') {
      return pickedStart ? formatDateNice(pickedStart) : 'Pick a start date…';
    }
    return START_OPTIONS.find((s) => s.id === startId)?.label ?? 'No start date';
  }
  function pinSummary(): string {
    return pinned ? 'Pinned' : 'Not pinned';
  }
  function notesSummary(): string {
    const t = notes.trim();
    if (!t) return executor === 'claude' ? 'No prompt yet' : 'No notes';
    const oneLine = t.replace(/\s+/g, ' ');
    return oneLine.length > 80 ? oneLine.slice(0, 77) + '…' : oneLine;
  }

  function answerFor(q: QuestionId): string {
    if (q === 'title') return title.trim();
    if (q === 'folder') return folderSummary();
    if (q === 'who') return whoSummary();
    if (q === 'when') return whenSummary();
    if (q === 'status') return statusSummary();
    if (q === 'start') return startSummary();
    if (q === 'pin') return pinSummary();
    if (q === 'notes') return notesSummary();
    return '';
  }

  // Short caption that prefixes the answer in collapsed/past sections —
  // a glance-able row like "start: today" / "end: tomorrow". Title is
  // intentionally label-less; it's the headline for the whole task.
  function labelFor(q: QuestionId): string | null {
    if (q === 'title') return null;
    if (q === 'folder') return 'folder';
    if (q === 'who') return 'who';
    if (q === 'start') return 'start';
    if (q === 'when') return 'end';
    if (q === 'status') return 'status';
    if (q === 'pin') return 'pin';
    if (q === 'notes') return 'notes';
    return null;
  }

  function promptFor(q: QuestionId): string {
    if (q === 'title') return "What's this task?";
    if (q === 'folder') return 'Which folder?';
    if (q === 'who') return 'Who runs this?';
    if (q === 'when') return executor === 'claude' ? 'When should it run?' : 'When is it due?';
    if (q === 'status') return "What's the status?";
    if (q === 'start') return 'When can it start?';
    if (q === 'pin') return 'Pin this task?';
    if (q === 'notes') {
      return executor === 'claude'
        ? "What should the agent do? (this becomes the prompt)"
        : 'Any notes?';
    }
    return '';
  }

  function sectionClasses(id: QuestionId): string {
    const idx = QUESTIONS.indexOf(id);
    const isActive = phase === 'editing' && active === id;
    const isPast = phase === 'commit' || idx < activeIdx;
    const isFuture = phase === 'editing' && idx > activeIdx;
    return (
      'composer__q' +
      (isActive ? ' composer__q--active' : '') +
      (isPast ? ' composer__q--past' : '') +
      (isFuture ? ' composer__q--future' : '')
    );
  }
  function isActiveSection(id: QuestionId): boolean {
    return phase === 'editing' && active === id;
  }

  function renderInert(q: QuestionId) {
    // In edit mode every collapsed section should show the task's
    // current value — the user is here to inspect/change it, not to
    // re-walk a guided flow. In create mode keep the original behavior
    // (past = answer, future = prompt) so the flow feels stepwise.
    const isPast = QUESTIONS.indexOf(q) < activeIdx;
    const showAnswer = props.mode === 'edit' || isPast;
    if (!showAnswer) {
      return <div className="composer__inert">{promptFor(q)}</div>;
    }
    const ans = answerFor(q) || promptFor(q);
    const label = labelFor(q);
    return (
      <div className="composer__inert">
        {label && <span className="composer__inert-label">{label}</span>}
        <span className="composer__inert-ans">{ans}</span>
      </div>
    );
  }

  return (
    <div className="composer-pane" data-state={state}>
      <div
        className="composer"
        role="region"
        aria-labelledby="composer-title"
        ref={sectionRef}
        tabIndex={-1}
      >
        <header className="composer__header">
          <div className="composer__crumb" id="composer-title">
            {props.mode === 'edit' ? 'Edit task' : 'New task'}
          </div>
        </header>

        <main className="composer__main">
          {/* Q1 — Title */}
          <section
            className={sectionClasses('title')}
            onClick={() => setActiveIdx(0)}
          >
            {isActiveSection('title') ? (
              <div className="composer__q-active-body">
                <div className="composer__title-row">
                  <input
                    ref={titleRef}
                    className="composer__title-input"
                    type="text"
                    placeholder="What's this task?"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (title.trim()) {
                          titleRef.current?.blur();
                          goNext();
                        }
                      }
                    }}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <span
                    className={
                      'composer__title-enter' +
                      (title.trim() ? ' composer__title-enter--ready' : '')
                    }
                    aria-hidden="true"
                  >
                    ↵
                  </span>
                </div>
              </div>
            ) : (
              renderInert('title')
            )}
          </section>

          {/* Q2 — Folder */}
          <section
            className={sectionClasses('folder')}
            onClick={() => setActiveIdx(QUESTIONS.indexOf('folder'))}
          >
            {isActiveSection('folder') ? (
              <div className="composer__q-active-body">
                <div className="composer__q-prompt">{promptFor('folder')}</div>
                <ul className="composer__options" role="listbox">
                  {visibleFolderPresets.map((p, i) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === folderHighlight}
                        className={
                          'composer__option' +
                          (i === folderHighlight ? ' composer__option--active' : '')
                        }
                        onMouseEnter={() => setFolderHighlight(i)}
                        onClick={(e) => {
                          e.stopPropagation();
                          chooseFolderPreset(i);
                        }}
                      >
                        <kbd className="composer__option-key">{i + 1}</kbd>
                        <span className="composer__option-label">{p.label}</span>
                        {p.hint && (
                          <span className="composer__option-hint">{p.hint}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="composer__or">or type a path</div>
                <input
                  ref={folderInputRef}
                  className="composer__path-input"
                  type="text"
                  placeholder="/Users/you/projects/…"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                      e.preventDefault();
                      goNext();
                    }
                  }}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            ) : (
              renderInert('folder')
            )}
          </section>

          {/* Q3 — Who */}
          <section
            className={sectionClasses('who')}
            onClick={() => setActiveIdx(QUESTIONS.indexOf('who'))}
          >
            {isActiveSection('who') ? (
              <div className="composer__q-active-body">
                <div className="composer__q-prompt">{promptFor('who')}</div>
                <ul className="composer__options" role="listbox">
                  {WHO_OPTIONS.map((o, i) => (
                    <li key={o.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === whoHighlight}
                        className={
                          'composer__option' +
                          (i === whoHighlight ? ' composer__option--active' : '')
                        }
                        onMouseEnter={() => setWhoHighlight(i)}
                        onClick={(e) => {
                          e.stopPropagation();
                          chooseWho(i);
                        }}
                      >
                        <kbd className="composer__option-key">{i + 1}</kbd>
                        <span className="composer__option-label">{o.label}</span>
                        {o.hint && (
                          <span className="composer__option-hint">{o.hint}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              renderInert('who')
            )}
          </section>

          {/* Notes — sits right after Who: what / where / who / notes are
              the fields that matter; scheduling lives below. */}
          <section
            className={sectionClasses('notes')}
            onClick={() => {
              setActiveIdx(QUESTIONS.indexOf('notes'));
              setTimeout(() => notesRef.current?.focus(), 0);
            }}
          >
            {isActiveSection('notes') ? (
              <div className="composer__q-active-body">
                <div className="composer__q-prompt">{promptFor('notes')}</div>
                <textarea
                  ref={notesRef}
                  className="composer__notes-input"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={
                    executor === 'claude'
                      ? 'Describe the work for the agent. This text becomes its prompt.'
                      : 'Anything you want to remember about this task.'
                  }
                  rows={4}
                  spellCheck
                />
                {executor === 'claude' && (
                  <div className="composer__notes-help">
                    Sent to Claude as the task’s context — Breeze wraps the title, folder, and due date around what you write here.
                  </div>
                )}
              </div>
            ) : (
              renderInert('notes')
            )}
          </section>

          {/* Start */}
          <section
            className={sectionClasses('start')}
            onClick={() => setActiveIdx(QUESTIONS.indexOf('start'))}
          >
            {isActiveSection('start') ? (
              <div className="composer__q-active-body">
                <div className="composer__q-prompt">{promptFor('start')}</div>
                <ul className="composer__options" role="listbox">
                  {START_OPTIONS.map((o, i) => (
                    <li key={o.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === startHighlight}
                        className={
                          'composer__option' +
                          (i === startHighlight ? ' composer__option--active' : '')
                        }
                        onMouseEnter={() => setStartHighlight(i)}
                        onClick={(e) => {
                          e.stopPropagation();
                          chooseStart(i);
                        }}
                      >
                        <kbd className="composer__option-key">{i + 1}</kbd>
                        <span className="composer__option-label">{o.label}</span>
                        {o.hint && (
                          <span className="composer__option-hint">{o.hint}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
                {startId === 'pick-start' && (
                  <div className="composer__date-row">
                    <input
                      ref={startDateRef}
                      type="date"
                      className="composer__date-input"
                      value={pickedStart}
                      onChange={(e) => setPickedStart(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                          e.preventDefault();
                          if (pickedStart) {
                            (e.target as HTMLInputElement).blur();
                            goNext();
                          }
                        }
                      }}
                    />
                    <span className="composer__date-hint">
                      {pickedStart ? formatDateNice(pickedStart) : 'choose a day'}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              renderInert('start')
            )}
          </section>

          {/* When (due / schedule) */}
          <section
            className={sectionClasses('when')}
            onClick={() => setActiveIdx(QUESTIONS.indexOf('when'))}
          >
            {isActiveSection('when') ? (
              <div className="composer__q-active-body">
                <div className="composer__q-prompt">{promptFor('when')}</div>
                <ul className="composer__options" role="listbox">
                  {visibleWhenOptions.map((w, i) => (
                    <li key={w.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === whenHighlight}
                        className={
                          'composer__option' +
                          (i === whenHighlight ? ' composer__option--active' : '')
                        }
                        onMouseEnter={() => setWhenHighlight(i)}
                        onClick={(e) => {
                          e.stopPropagation();
                          chooseWhen(i);
                        }}
                      >
                        <kbd className="composer__option-key">{i + 1}</kbd>
                        <span className="composer__option-label">{w.label}</span>
                        {w.hint && (
                          <span className="composer__option-hint">{w.hint}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
                {whenId === 'pick-date' && (
                  <div className="composer__date-row">
                    <input
                      ref={dateInputRef}
                      type="date"
                      className="composer__date-input"
                      value={pickedDate}
                      onChange={(e) => setPickedDate(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                          e.preventDefault();
                          if (pickedDate) void save();
                        }
                      }}
                    />
                    <span className="composer__date-hint">
                      {pickedDate ? formatDateNice(pickedDate) : 'choose a day'}
                    </span>
                  </div>
                )}
                {whenId === 'custom-cron' && (
                  <div className="composer__date-row">
                    <input
                      ref={cronInputRef}
                      type="text"
                      className="composer__path-input"
                      placeholder="m h dom mon dow  e.g. 0 9 * * 1-5"
                      value={customCron}
                      onChange={(e) => setCustomCron(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                          e.preventDefault();
                          if (customCron.trim().split(/\s+/).length === 5) {
                            cronInputRef.current?.blur();
                            enterCommitPhase();
                          }
                        }
                      }}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </div>
                )}
              </div>
            ) : (
              renderInert('when')
            )}
          </section>

          {/* Q5 — Status */}
          <section
            className={sectionClasses('status')}
            onClick={() => setActiveIdx(QUESTIONS.indexOf('status'))}
          >
            {isActiveSection('status') ? (
              <div className="composer__q-active-body">
                <div className="composer__q-prompt">{promptFor('status')}</div>
                <ul className="composer__options" role="listbox">
                  {STATUS_OPTIONS.map((o, i) => (
                    <li key={o.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === statusHighlight}
                        className={
                          'composer__option' +
                          (i === statusHighlight ? ' composer__option--active' : '')
                        }
                        onMouseEnter={() => setStatusHighlight(i)}
                        onClick={(e) => {
                          e.stopPropagation();
                          chooseStatus(i);
                        }}
                      >
                        <kbd className="composer__option-key">{i + 1}</kbd>
                        <span className="composer__option-label">{o.label}</span>
                        {o.hint && (
                          <span className="composer__option-hint">{o.hint}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              renderInert('status')
            )}
          </section>

          {/* Pin */}
          <section
            className={sectionClasses('pin')}
            onClick={() => setActiveIdx(QUESTIONS.indexOf('pin'))}
          >
            {isActiveSection('pin') ? (
              <div className="composer__q-active-body">
                <div className="composer__q-prompt">{promptFor('pin')}</div>
                <ul className="composer__options" role="listbox">
                  {PIN_OPTIONS.map((o, i) => (
                    <li key={o.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === pinHighlight}
                        className={
                          'composer__option' +
                          (i === pinHighlight ? ' composer__option--active' : '')
                        }
                        onMouseEnter={() => setPinHighlight(i)}
                        onClick={(e) => {
                          e.stopPropagation();
                          choosePin(i);
                        }}
                      >
                        <kbd className="composer__option-key">{i + 1}</kbd>
                        <span className="composer__option-label">{o.label}</span>
                        {o.hint && (
                          <span className="composer__option-hint">{o.hint}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              renderInert('pin')
            )}
          </section>

        </main>

        {/* fm-b5at.7 — agent flags. Only shown for Claude tasks; toggles
            map 1:1 to the task `flags` array. 'interactive' opens the run
            in a new tab with an embedded claude session instead of running
            headless. */}
        {executor === 'claude' && !created && (
          <div className="composer__flags" role="group" aria-label="Agent flags">
            {FLAG_OPTIONS.map((o) => (
              <label key={o.id} className="composer__flag" title={o.hint}>
                <input
                  type="checkbox"
                  checked={flags.has(o.id)}
                  onChange={() => toggleFlag(o.id)}
                />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        )}

        <footer
          className={
            'composer__footer' +
            (phase === 'commit' && !created ? ' composer__footer--active' : '')
          }
        >
          {created ? (
            <div className="composer__flash" role="status">
              ✓ Task {props.mode === 'edit' ? 'saved' : 'created'}
            </div>
          ) : (
            <>
              {error && (
                <div className="composer__error" role="alert">{error}</div>
              )}
              <button
                type="button"
                className={
                  'composer__cancel-btn' +
                  (escArmed ? ' composer__cancel-btn--armed' : '')
                }
                onClick={() => {
                  if (phase === 'commit') { exit(); return; }
                  if (escArmed) exit();
                  else {
                    setEscArmed(true);
                    setTimeout(() => setEscArmed(false), 1500);
                  }
                }}
                title={phase === 'commit' ? 'Cancel (E)' : 'Cancel (esc esc)'}
              >
                {escArmed ? 'Press again to cancel' : 'Cancel'}
                <span className="composer__btn-kbd">
                  {phase === 'commit' ? 'E' : 'esc esc'}
                </span>
              </button>
              <button
                ref={createBtnRef}
                type="button"
                className={
                  'composer__create-btn' +
                  (phase === 'commit' ? ' composer__create-btn--ready' : '')
                }
                onClick={() => void save()}
                disabled={busy || !title.trim()}
              >
                {busy ? 'Saving…' : props.mode === 'edit' ? 'Save changes' : 'Create task'}
                <span className="composer__btn-kbd">
                  {phase === 'commit' ? 'C' : submitKbd}
                </span>
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
