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
import { useAgentContext } from '@copilotkit/react-core/v2';
import { z } from 'zod';
import { useCopilotInfo } from '../copilot/useCopilotInfo';
import { immediateAction } from '../copilot/actionKit';
import { useOverlayExit } from '../useOverlayExit';
import { usePlatform } from '../platform';
import { fm } from '../bridge';
import {
  createTask,
  runTaskNow,
  shiftISO,
  taskSourceAction,
  todayISO,
  updateTask,
  useTaskSources,
  useTasks,
  useTypebuildAuth,
} from '../tasks';
import { humanizeError } from '../errorMessages';
import {
  type RecurrenceForm,
  buildCronFromForm,
  defaultRecurrenceForm,
} from '../recurrence';
import type { Agent, Project, Task, TaskCreate, TaskSourceInfo, TaskStatus, TaskUpdate } from '../types';
// task-896f3f7f5e75 — pure agent display helpers (launch-mode caption for the
// picker option hint). Shared with the detail panel + unit-tested in isolation.
import { agentOptionHint } from './tasks/agent.mjs';
// task-2fd63b922beb (R2) — Task Templates, corrected abstraction: the
// composer EXTENDS itself (same class, no new form/modal) with a
// "Task" vs "Chained task" choice. Choosing "Chained task" opens an inline
// chain-definition builder (add/remove/reorder steps; per-step inputs/
// outputs/neededWhen) plus a "start from an existing chained task" picker —
// there is no project-level template config anymore. See
// docs/task-templates-design.md.
import type { TaskDef, TaskDefCondition, TaskDefField } from './newhome/types';
import { instantiateTemplate } from './newhome/newHomePrefs';
import {
  aggregateInputs,
  effectiveFieldKey,
  fieldRef,
  parseTaskTemplateBlock,
} from './newhome/taskSchema.mjs';
import './TaskComposer.css';

export type TaskComposerRequest =
  // task-223d400ffc1a — `projectId` PRE-SELECTS a project when the composer is
  // opened from a project context (e.g. the Projects page's per-project "new
  // task"). It pins the TypeBuild target and the project field so the create
  // lands in that project; the user can still re-pick (or choose None). This is
  // the seam that retired the separate ProjectTaskProposal flow.
  | {
      mode: 'create';
      defaultFolder: string;
      projectId?: string;
      /** Prefill from a caller that already gathered title/notes elsewhere
       *  (e.g. the copilot create_task action) — seeds the fields, the human
       *  still reviews/edits/submits through this same form. */
      initialTitle?: string;
      initialNotes?: string;
      /** Open directly as a CHAINED task (the "+ New Chained Task" entry
       *  point) — pre-picks the Task/Chained-task question so the chain
       *  builder is the next step. Same form either way; the user can still
       *  flip back to a plain task on that question. */
      initialKind?: 'chain';
    }
  | { mode: 'edit'; task: Task };

// task-b30e546672db — `embedded` renders the composer INSIDE another surface
// (the task-detail dialog's "Task details" tab) rather than as a standalone
// pane. Embedded mode:
//   - does NOT register the global window keydown handler (the host dialog owns
//     keyboard: tab switching, Esc) so the two don't fight;
//   - does NOT fade/exit after a successful save — it stays mounted and shows a
//     transient "saved" flash, then fires `onSaved` so the host can refresh;
//   - hides its own "Edit task / New task" crumb (the dialog already frames it).
type Props = TaskComposerRequest & {
  onClose: () => void;
  embedded?: boolean;
  onSaved?: () => void;
};

// task-2fd63b922beb (R2) + correction — 'template' (the Task/Chained-task
// choice), 'chain' (the inline chain-definition builder, only when "Chained
// task" is picked), 'fields' (the PLAIN task's own optional input/output
// editor) and 'outputs' (read-only summary) extend the flow (create +
// TypeBuild only); `field:<taskDefId>.<key>` ids are synthesized per
// aggregated input field (see aggregateInputs). All are additive: the local
// target, or edit mode, never produce them — QUESTIONS is then byte-for-byte
// QUESTIONS_LOCAL/QUESTIONS_TYPEBUILD, unchanged.
//
// Corrected abstraction: input/output fields belong to the TASK, not the
// chain. A plain "Task" now gets an optional 'fields' step (+ its value
// questions + outputs summary); leaving it empty saves a task byte-identical
// to today (NON-REGRESSION). A "Chained task" is a THIN container — title +
// project + the chain + its input values + outputs summary — and DROPS the
// task-form questions (who/notes/start/when/priority/agent/status/pin).
type QuestionId =
  | 'title'
  | 'folder'
  | 'project'
  | 'template'
  | 'chain'
  // task-2fd63b922beb correction — the PLAIN task form's own optional
  // input/output fields (single def, id 'task'). No neededWhen (chain-only).
  | 'fields'
  | 'outputs'
  | 'who'
  | 'when'
  | 'status'
  | 'start'
  | 'priority'
  | 'agent'
  | 'pin'
  | 'notes'
  | `field:${string}`;
// Order is the keyboard ↓ flow. Name, folder, and notes come first — they
// are the only fields that actually matter for most tasks, and a task can
// be created the moment they're filled (everything below is optional and
// skippable). Start sits right before When so the two time questions read
// as a pair — "when can it start? / when is it due?".
// fm-m2s4 (S5) — `folder` is dropped and `priority` inserted for the TypeBuild
// target (folder anchoring doesn't apply there; priority does). The active
// question list is computed per-target via composerQuestions() so keyboard
// navigation, activeIdx, and the past/future render all stay consistent.
const QUESTIONS_LOCAL: QuestionId[] = [
  'title', 'folder', 'who', 'notes',
  'start', 'when',
  'status', 'pin',
];
// task-ab1d7955e23f — `project` sits right after the title for the TypeBuild
// target: a task's project is teaching context (it carries the project's
// folders + instructions), so it reads as part of "what is this", before who
// runs it. Folder-anchored creates auto-attach the owning project here; the
// user can still override or pick "None".
const QUESTIONS_TYPEBUILD: QuestionId[] = [
  'title', 'project', 'who', 'notes',
  'start', 'when', 'priority', 'agent',
  'status', 'pin',
];
function composerQuestions(target: string): QuestionId[] {
  return target === TYPEBUILD_SOURCE ? QUESTIONS_TYPEBUILD : QUESTIONS_LOCAL;
}

type ExecutorId = 'manual' | 'claude';

// fm-m2s4 (S5) — composer save target. 'local' is the Breeze store; a remote
// source id (e.g. 'typebuild') routes the create through that source.
const TYPEBUILD_SOURCE = 'typebuild';

// The TypeBuild source's create capabilities, used to synthesize a save-target
// entry from the AUTH state directly. We don't wait for the source-registry
// capability list to reach the renderer (a fresh sign-in can lag it) — if the
// user is signed in to TypeBuild, the source is registered in main, so the
// create will route fine; the picker should offer it immediately.
const TYPEBUILD_TARGET: TaskSourceInfo = {
  id: TYPEBUILD_SOURCE,
  label: 'TypeBuild',
  capabilities: {
    canSchedule: false,
    canClaim: true,
    canEdit: false,
    canDelete: true,
    canCreate: true,
    phiSensitive: true,
    hasFolder: false,
  },
};

// fm-m2s4 (S5) — TypeBuild priority. Compact 0–10 select; unset by default so a
// create that doesn't care leaves the server default untouched.
const PRIORITY_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

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
  // SPIKE (spike/playwright-cdp): in-app analog of Chrome — opens an embedded
  // Breeze browser tab and lets claude drive it via Playwright over CDP.
  { id: 'playwright', label: 'Playwright (in-app browser)', hint: 'open a Breeze browser tab and let claude drive it with Playwright (no Chrome extension)' },
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
  // Edited tasks read whatever's actually stored. task-b30e546672db — for a
  // TypeBuild task the "start" step is the server's defer date, so fall back to
  // `deferUntil` when there's no local `start_at`.
  if (!task) return 'today';
  const startVal = task.start_at ?? task.deferUntil ?? null;
  if (!startVal) return 'none';
  if (startVal === today) return 'today';
  const t = new Date(today + 'T00:00:00');
  t.setDate(t.getDate() + 1);
  if (startVal === t.toISOString().slice(0, 10)) return 'tomorrow';
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

// Due-date quick-picks shown as chips next to the When field (manual
// tasks). "1 week" = today+7. "Friday"/"Monday" = the COMING weekday using
// the same convention as parseDateInput: if today already is that weekday,
// jump to next week (delta 7) rather than picking today.
type DueQuickPick = { id: string; label: string; key: string; iso: (today: string) => string };
function nextWeekdayISO(today: string, targetDow: number): string {
  const todayDow = new Date(today + 'T00:00:00').getDay(); // 0=Sun..6=Sat
  const delta = ((targetDow - todayDow + 7) % 7) || 7;
  return shiftISO(today, delta);
}
const DUE_QUICK_PICKS: DueQuickPick[] = [
  { id: 'qp-week', label: '1 week', key: 'W', iso: (t) => shiftISO(t, 7) },
  { id: 'qp-fri', label: 'this Friday', key: 'F', iso: (t) => nextWeekdayISO(t, 5) },
  { id: 'qp-mon', label: 'Monday', key: 'M', iso: (t) => nextWeekdayISO(t, 1) },
];

// The current user's home dir, shortened to `~` in folder hints. Resolved from
// the platform (os.homedir() via the `fm.homedir()` bridge), NOT a hardcoded
// literal — a hardcoded path is wrong for every other user and on Linux, and
// violates the cross-platform rule (no OS paths outside electron/platform/).
// Cached at module scope and populated once (the bridge call is async); the
// component below also keeps it in state to re-render hints once it loads.
let cachedHome = '';
function rememberHome(home: string): string {
  cachedHome = home || '';
  return cachedHome;
}

function prettyFolder(p: string, home: string = cachedHome): string {
  if (!p) return 'Any folder';
  if (!home) return p;
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~/' + p.slice(home.length + 1);
  return p;
}

type ComposerOption = { value: string; label: string; hint?: string };

type FormBridgeFields = {
  mode: 'create' | 'edit';
  title: string;
  notes?: string;
  projectId?: string;
  projectName?: string;
  status: TaskStatus;
  priority?: string;
  agentId?: string;
  agentName?: string;
  folder?: string;
};
type FormBridgeOptions = {
  isTypebuild: boolean;
  projects: ComposerOption[];
  agents: ComposerOption[];
  statuses: ComposerOption[];
  priorities: ComposerOption[];
};
type FormBridgeSetters = {
  setTitle: (v: string) => void;
  setNotes: (v: string) => void;
  setProjectId: (v: string) => void;
  setStatus: (v: TaskStatus) => void;
  setPriority: (v: string) => void;
  setAgentId: (v: string) => void;
};

// Resolve what the model passed (an id, an exact name, or a partial name the
// user typed) against the full option list — the SAME latitude the form's
// "Other… → type to autocomplete" picker gives a human. Empty → clear.
type ResolveResult =
  | { kind: 'clear' }
  | { kind: 'ok'; value: string; label: string }
  | { kind: 'notfound' }
  | { kind: 'ambiguous'; matches: ComposerOption[] };
function resolveOption(list: ComposerOption[], raw: string): ResolveResult {
  const q = (raw ?? '').trim();
  if (!q) return { kind: 'clear' };
  const byId = list.find((o) => o.value === q);
  if (byId) return { kind: 'ok', value: byId.value, label: byId.label };
  const ql = q.toLowerCase();
  const byName = list.find((o) => o.label.toLowerCase() === ql);
  if (byName) return { kind: 'ok', value: byName.value, label: byName.label };
  const subs = list.filter((o) => o.label.toLowerCase().includes(ql));
  if (subs.length === 1) return { kind: 'ok', value: subs[0].value, label: subs[0].label };
  if (subs.length > 1) return { kind: 'ambiguous', matches: subs };
  return { kind: 'notfound' };
}

// task-24ea35660cd0 — exposes the form's LIVE field values AND its available
// options (projects, agents, statuses, priorities — by id AND name) to the
// copilot chat, and gives it actions to set every field plus submit/cancel
// the form. A separate component (not bare hook calls in TaskComposer)
// because useAgentContext/useFrontendTool throw without a <CopilotKit>
// ancestor — TaskComposer renders with or without copilot enabled, so this is
// only ever MOUNTED when it's known to be safe (see copilotEnabled below).
//
// STALE-CLOSURE NOTE: immediateAction (useFrontendTool) registers each tool's
// handler ONCE (its effect deps are name/available only), so a handler that
// closed over props directly would capture the FIRST render's values — e.g.
// an empty project list, since projects load async after the form opens. So
// every handler reads through `live` (a ref refreshed each render) instead of
// closing over props. useAgentContext, by contrast, re-registers whenever its
// value changes, so the chat's READ view stays fresh on props alone.
function FormCopilotBridge({
  fields,
  options,
  setters,
  submit,
  cancel,
}: {
  fields: FormBridgeFields;
  options: FormBridgeOptions;
  setters: FormBridgeSetters;
  submit: () => Promise<{ ok: boolean; taskId?: string; error?: string }>;
  cancel: () => void;
}) {
  // Always-latest snapshot the (register-once) action handlers read from.
  // Assigned during render so it reflects the current committed props.
  const live = useRef({ fields, options, setters, submit, cancel });
  live.current = { fields, options, setters, submit, cancel };

  useAgentContext({
    description:
      "The New Task form's current field values, live as the human edits them (create mode) or the task being edited (edit mode). projectName/agentName are resolved from the current projectId/agentId for readability.",
    value: fields,
  });
  useAgentContext({
    description:
      "The New Task form's available options for its pickers — every project/agent the human could assign (id + name), and the valid status/priority values. When setting a project/agent you may pass either the id or the name; it's resolved for you.",
    value: options,
  });

  immediateAction({
    name: 'set_task_form_title',
    description: "Set the New Task form's title field.",
    parameters: z.object({ title: z.string().describe('The new title.') }),
    perform: ({ title }) => {
      live.current.setters.setTitle(title ?? '');
      return `Set the title to "${title ?? ''}".`;
    },
  });

  immediateAction({
    name: 'set_task_form_notes',
    description: "Set the New Task form's notes field.",
    parameters: z.object({ notes: z.string().describe('The new notes text.') }),
    perform: ({ notes }) => {
      live.current.setters.setNotes(notes ?? '');
      return 'Updated the notes.';
    },
  });

  // These three are gated via `available` (not a conditional hook call)
  // because `options.isTypebuild` can change while the form stays open (the
  // human can switch the save-target picker) — conditionally CALLING a hook
  // would break React's hook-order invariant. `available` is read at render
  // and useFrontendTool re-registers when it flips.
  const tbAvailable = options.isTypebuild;

  immediateAction({
    name: 'set_task_form_project',
    description:
      "Set the New Task form's project. Pass the project's NAME (what the user said) or its id — it's resolved against the full project list the same way the form's type-to-search picker does. Pass \"\" to clear the project (None).",
    available: tbAvailable,
    parameters: z.object({
      project: z.string().describe('The project name (or id), or "" for None.'),
    }),
    perform: ({ project }) => {
      const { options: o, setters: s } = live.current;
      const r = resolveOption(o.projects, project ?? '');
      if (r.kind === 'clear') {
        s.setProjectId('');
        return 'Cleared the project (None).';
      }
      if (r.kind === 'notfound') {
        return `Failed: no project matches "${project}". Available: ${o.projects.map((p) => p.label).join(', ') || '(none loaded yet)'}.`;
      }
      if (r.kind === 'ambiguous') {
        return `"${project}" is ambiguous — matches ${r.matches.map((m) => m.label).join(', ')}. Please be more specific.`;
      }
      s.setProjectId(r.value);
      return `Set the project to "${r.label}".`;
    },
  });

  immediateAction({
    name: 'set_task_form_agent',
    description:
      "Set the New Task form's assigned agent. Pass the agent's NAME or id (resolved against the available agents). Pass \"\" to clear the assignment (None).",
    available: tbAvailable,
    parameters: z.object({
      agent: z.string().describe('The agent name (or id), or "" for None.'),
    }),
    perform: ({ agent }) => {
      const { options: o, setters: s } = live.current;
      const r = resolveOption(o.agents, agent ?? '');
      if (r.kind === 'clear') {
        s.setAgentId('');
        return 'Cleared the agent assignment (None).';
      }
      if (r.kind === 'notfound') {
        return `Failed: no agent matches "${agent}". Available: ${o.agents.filter((a) => a.value).map((a) => a.label).join(', ') || '(none)'}.`;
      }
      if (r.kind === 'ambiguous') {
        return `"${agent}" is ambiguous — matches ${r.matches.map((m) => m.label).join(', ')}. Please be more specific.`;
      }
      s.setAgentId(r.value);
      return `Set the agent to "${r.label}".`;
    },
  });

  immediateAction({
    name: 'set_task_form_priority',
    description: "Set the New Task form's priority (from the available-options context).",
    available: tbAvailable,
    parameters: z.object({ priority: z.string().describe('The priority value, or "" to unset.') }),
    perform: ({ priority }) => {
      const { options: o, setters: s } = live.current;
      const v = priority ?? '';
      if (!o.priorities.some((p) => p.value === v)) {
        return `Failed: "${v}" isn't a valid priority.`;
      }
      s.setPriority(v);
      return v ? `Set priority to ${v}.` : 'Unset the priority.';
    },
  });

  immediateAction({
    name: 'set_task_form_status',
    description: "Set the New Task form's status (from the available-options context).",
    parameters: z.object({
      status: z.string().describe('One of: pending, in_progress, done, cancelled.'),
    }),
    perform: ({ status }) => {
      const { options: o, setters: s } = live.current;
      if (!o.statuses.some((st) => st.value === status)) {
        return `Failed: "${status}" isn't a valid status.`;
      }
      s.setStatus(status as TaskStatus);
      return `Set status to "${status}".`;
    },
  });

  immediateAction({
    name: 'submit_task_form',
    description:
      fields.mode === 'edit'
        ? 'Save the currently-open task edit form — the same as clicking Save.'
        : 'Submit the currently-open New Task form — the same as clicking Create.',
    perform: async () => {
      const { submit: doSubmit, fields: f } = live.current;
      const result = await doSubmit();
      if (result.ok) {
        return f.mode === 'edit'
          ? 'Saved the task.'
          : `Created task "${f.title}"${result.taskId ? ` (id: ${result.taskId})` : ''}.`;
      }
      return `Failed: ${result.error ?? 'could not save — check the form for a validation error.'}`;
    },
  });

  immediateAction({
    name: 'cancel_task_form',
    description: 'Close the currently-open New Task / edit form WITHOUT saving.',
    perform: () => {
      live.current.cancel();
      return 'Closed the form without saving.';
    },
  });

  return null;
}

// task-04ea172532c0 — synthetic QuestionId for one aggregated task-def input
// field. `isFieldQuestion` narrows `active` back to that literal shape; both
// are pure (no component state) so they live at module scope.
function fieldQId(taskDefId: string, key: string): QuestionId {
  return `field:${fieldRef(taskDefId, key)}` as QuestionId;
}
function isFieldQuestion(q: QuestionId): q is `field:${string}` {
  return q.startsWith('field:');
}
// The option list for a select/bool field. bool renders as a 2-way Yes/No
// pick (same shape as PIN_OPTIONS); select uses the field's own `options`.
function fieldOptionList(field: TaskDefField): { value: string; label: string }[] {
  if (field.type === 'bool') return [
    { value: 'false', label: 'No' },
    { value: 'true', label: 'Yes' },
  ];
  return (field.options ?? []).map((o) => ({ value: o, label: o }));
}
function isFieldOptionType(field: TaskDefField): boolean {
  return field.type === 'select' || field.type === 'bool';
}

// task-2fd63b922beb correction (Part A.4) — the field-definition editor, ONE
// implementation shared by BOTH the chain builder's per-step input/output
// lists AND the plain Task form's single-def input/output lists. Field
// DEFINITIONS (key/label/type/options/required) are NON-PHI; these editors
// never touch field VALUES. `showRequired` = this is an OUTPUT list, whose
// `required` flag marks the field as the step's evidence.
function FieldRowEditor({
  field,
  showRequired,
  onUpdate,
  onRemove,
}: {
  field: TaskDefField;
  showRequired: boolean;
  onUpdate: (patch: Partial<TaskDefField>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="composer__chain-field-row">
      <input
        className="composer__chain-field-key"
        type="text"
        placeholder="key"
        value={field.key}
        onChange={(e) => onUpdate({ key: e.target.value })}
      />
      <input
        className="composer__chain-field-label"
        type="text"
        placeholder="label"
        value={field.label}
        onChange={(e) => onUpdate({ label: e.target.value })}
      />
      <select
        className="composer__chain-field-type"
        value={field.type}
        onChange={(e) => onUpdate({ type: e.target.value as TaskDefField['type'] })}
      >
        <option value="text">text</option>
        <option value="number">number</option>
        <option value="date">date</option>
        <option value="select">select</option>
        <option value="bool">bool</option>
      </select>
      {field.type === 'select' && (
        <input
          className="composer__chain-field-options"
          type="text"
          placeholder="options, comma-separated"
          value={(field.options ?? []).join(', ')}
          onChange={(e) =>
            onUpdate({
              options: e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      )}
      {showRequired && (
        <label className="composer__chain-field-required">
          <input
            type="checkbox"
            checked={!!field.required}
            onChange={(e) => onUpdate({ required: e.target.checked })}
          />
          evidence
        </label>
      )}
      <button
        type="button"
        className="composer__chain-icon-btn composer__chain-icon-btn--danger"
        title={showRequired ? 'Remove output' : 'Remove input'}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        ✕
      </button>
    </div>
  );
}

// A labeled add/remove list of field-definition rows (Inputs or Outputs).
function FieldListEditor({
  kind,
  fields,
  onAdd,
  onUpdate,
  onRemove,
}: {
  kind: 'inputs' | 'outputs';
  fields: TaskDefField[];
  onAdd: () => void;
  onUpdate: (fieldIdx: number, patch: Partial<TaskDefField>) => void;
  onRemove: (fieldIdx: number) => void;
}) {
  const showRequired = kind === 'outputs';
  return (
    <div className="composer__chain-fieldgroup">
      <div className="composer__chain-fieldgroup-head">
        <span>{kind === 'inputs' ? 'Inputs' : 'Outputs'}</span>
        <button
          type="button"
          className="composer__chain-add-btn"
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
        >
          + {kind === 'inputs' ? 'input' : 'output'}
        </button>
      </div>
      {fields.map((f, fi) => (
        <FieldRowEditor
          key={fi}
          field={f}
          showRequired={showRequired}
          onUpdate={(patch) => onUpdate(fi, patch)}
          onRemove={() => onRemove(fi)}
        />
      ))}
    </div>
  );
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
  // Gate FormCopilotBridge's mount on this (not a bare hook call) — copilot
  // may be disabled entirely, in which case there's no <CopilotKit> ancestor
  // and useCopilotReadable would throw.
  const copilotInfo = useCopilotInfo();
  const copilotEnabled = !!(copilotInfo?.enabled && copilotInfo.port);

  // Resolve the current user's home dir once (async via the bridge) so folder
  // hints shorten to `~` for the ACTUAL user on both macOS and Linux. Seeded
  // from the module cache so a second composer open is correct on first paint.
  const [home, setHome] = useState(cachedHome);
  useEffect(() => {
    fm.homedir().then((h) => setHome(rememberHome(h))).catch(() => {});
  }, []);

  // fm-m2s4 (S5) — save target. Editing an existing row stays pinned to that
  // row's source (you can't move a task between stores from the composer).
  const { sources } = useTaskSources();
  // TypeBuild availability is driven by the auth state, not the source list:
  // signed in ⇒ offer (and default to) TypeBuild; signed out ⇒ don't offer it.
  const { signedIn: tbSignedIn } = useTypebuildAuth();
  const localCreatables = useMemo(
    () => sources.filter((s) => s.capabilities.canCreate && s.id !== TYPEBUILD_SOURCE),
    [sources],
  );
  // The ordered list of save targets: local (+ any other non-TB creatables)
  // first, TypeBuild appended when signed in. Drives both the picker and the
  // valid-target check below.
  const targets = useMemo<TaskSourceInfo[]>(
    () => (tbSignedIn ? [...localCreatables, TYPEBUILD_TARGET] : localCreatables),
    [localCreatables, tbSignedIn],
  );

  const [target, setTarget] = useState<string>(
    props.mode === 'edit'
      ? props.task.source ?? TYPEBUILD_SOURCE
      : TYPEBUILD_SOURCE,
  );
  // Once the user explicitly picks a target we stop auto-defaulting it (so a
  // deliberate pick while signed in isn't yanked back to TypeBuild).
  const [targetTouched, setTargetTouched] = useState(props.mode === 'edit');
  // Auto-default to TypeBuild (the only built-in create target now) when
  // signed in; otherwise fall back to the first available creatable target,
  // if any. Re-runs as auth resolves (the hook starts false then flips true
  // on the async state read).
  useEffect(() => {
    if (props.mode === 'edit' || targetTouched) return;
    setTarget(
      tbSignedIn
        ? TYPEBUILD_SOURCE
        : localCreatables[0]?.id ?? TYPEBUILD_SOURCE,
    );
  }, [tbSignedIn, targetTouched, props.mode, localCreatables]);
  // A target that's no longer offered (e.g. TypeBuild after a sign-out) falls
  // back to the first available target so the composer stays coherent.
  useEffect(() => {
    if (props.mode === 'edit' || targets.length === 0) return;
    if (!targets.some((s) => s.id === target)) setTarget(targets[0].id);
  }, [targets, target, props.mode]);
  const isTypebuild = target === TYPEBUILD_SOURCE;
  // No valid save target (signed out + no other creatable source). The create
  // action is disabled with a "Sign in to TypeBuild" hint rather than firing a
  // create that has nowhere to land.
  const noTarget = props.mode === 'create' && targets.length === 0;

  // task-2fd63b922beb (R2) — QUESTIONS/activeIdx/active are declared further
  // down (after `attachedProject`), once the chain-related state they depend
  // on (hasChainOption, templateChoice, templateFieldEntries) exists. Nothing
  // between here and there reads them.
  const baseQuestions = useMemo(() => composerQuestions(target), [target]);

  const [title, setTitle] = useState(
    initial?.title ?? (props.mode === 'create' ? props.initialTitle : undefined) ?? '',
  );
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
  // Once the user explicitly picks "who runs this" we stop auto-defaulting it
  // (mirrors targetTouched). Edits start pinned to the saved value.
  const [executorTouched, setExecutorTouched] = useState(props.mode === 'edit');
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
  // fm-m2s4 (S5) — TypeBuild priority (0–10, unset = leave server default).
  // Only consumed when the target is TypeBuild; carried as a string so the
  // <select> "Unset" option is representable.
  const [priority, setPriority] = useState<string>(
    initial?.priority != null ? String(initial.priority) : '',
  );
  // task-896f3f7f5e75 — TypeBuild AGENT assignment (scalar; one agent per task).
  // `agents` is the signed-in user's agent registry (NON-PHI: names/tools/
  // launch_mode). `agentId` is the chosen agent ('' = None). Edits start pinned
  // to the task's own agent (from the resolved block OR the scalar id).
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState<string>(
    initial?.agent?.id ?? initial?.agentId ?? '',
  );
  // task-ab1d7955e23f — TypeBuild project association. `projects` is the
  // signed-in user's project list (non-PHI: names/folders/instructions are
  // teaching context, safe to display). `projectId` is the chosen container
  // ('' = None). Edits start pinned to the task's own project.
  // task-223d400ffc1a — a create opened FROM a project carries `projectId`,
  // which pre-selects it. Edits read the task's own project. Otherwise empty
  // (None) until the folder auto-attach (or the user) fills it.
  const preselectedProjectId =
    props.mode === 'create' ? props.projectId ?? '' : '';
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>(
    initial?.projectId ?? preselectedProjectId,
  );
  // Once the user explicitly picks a project we stop auto-attaching from the
  // folder (mirrors targetTouched/executorTouched). Edits start "touched" so
  // the saved value isn't overwritten by a folder resolve; a create with a
  // PRE-SELECTED project also starts "touched" so the folder resolve doesn't
  // clobber the project we were explicitly opened with.
  const [projectTouched, setProjectTouched] = useState(
    props.mode === 'edit' || preselectedProjectId !== '',
  );
  // True after the folder→project resolve has run for this folder, so the
  // attached chip can distinguish "auto-attached" from a manual pick.
  const [projectAutoAttached, setProjectAutoAttached] = useState(false);
  // task-7ef6be165783 — count ACTIVE (non-done, non-cancelled) tasks per
  // project so the picker can surface the busiest projects first. Same data
  // path the rest of the app uses (cached by useTasks); no extra round-trip.
  // Only meaningful for the TypeBuild target — the local source has no
  // projects — so the subscription is gated on that to stay cheap.
  const { tasks: activeTaskRows } = useTasks(
    isTypebuild ? { activeOnly: true } : {},
  );
  const activeCountByProject = useMemo(() => {
    const counts = new Map<string, number>();
    if (!isTypebuild) return counts;
    for (const t of activeTaskRows) {
      // "Active" = not terminal. Mirror attention.mjs's isTerminal notion
      // (done | cancelled); activeOnly already excludes them server-side,
      // this guards any status the filter leaves in (and the local source,
      // which ignores the filter).
      if (!t.projectId || t.status === 'done' || t.status === 'cancelled') continue;
      counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1);
    }
    return counts;
  }, [activeTaskRows, isTypebuild]);
  // Notes doubles as the agent prompt for Claude tasks (one field, not two).
  // If a legacy task only has auto_prompt set, surface it in notes so the
  // user can see and edit it; we'll save it back as notes (auto_prompt
  // always saves as null going forward).
  const [notes, setNotes] = useState<string>(
    initial?.notes && initial.notes.length > 0
      ? initial.notes
      : (initial?.auto_prompt ?? (props.mode === 'create' ? props.initialNotes : undefined) ?? ''),
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
    pickStartIdFromTask(initial, todayISO()) === 'pick-start'
      ? initial?.start_at ?? initial?.deferUntil ?? ''
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
        hint: prettyFolder(cwdSuggestion, home),
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
  }, [cwdSuggestion, home]);

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
  // Auto-default the executor by target: a TypeBuild task is run by the
  // default agent (Claude Code) via Start, so default "who" to Claude there;
  // local tasks default to Manual. Stops once the user picks explicitly.
  useEffect(() => {
    if (props.mode === 'edit' || executorTouched) return;
    const next: ExecutorId = isTypebuild ? 'claude' : 'manual';
    setExecutor(next);
    setWhoHighlight(Math.max(0, WHO_OPTIONS.findIndex((w) => w.id === next)));
  }, [isTypebuild, executorTouched, props.mode]);
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
  const [priorityHighlight, setPriorityHighlight] = useState(() => {
    // 0 = "Unset", then one entry per PRIORITY_VALUES element.
    const v = initial?.priority;
    return v != null ? PRIORITY_VALUES.indexOf(v) + 1 : 0;
  });
  const [agentHighlight, setAgentHighlight] = useState(0);
  const [pinHighlight, setPinHighlight] = useState(() => (pinned ? 1 : 0));

  // fm-m2s4 (S5) — priority is a flat option list ("Unset" + 0..10) so it
  // matches the other option questions' keyboard model. Index 0 is "Unset".
  const PRIORITY_OPTIONS = useMemo(
    () => [
      { value: '', label: 'Unset', hint: 'leave default' },
      ...PRIORITY_VALUES.map((n) => ({
        value: String(n),
        label: String(n),
        hint: n === 0 ? 'lowest' : n === 10 ? 'highest' : undefined,
      })),
    ],
    [],
  );

  // task-896f3f7f5e75 — the AGENT option list: "None" first (clears the
  // assignment), then one row per agent. Each option shows the agent's name +
  // its launch_mode caption as the hint (chrome/auto/resume/manual). Agents are
  // sorted by name (case-insensitive); group-OPTIONAL — an agent with no group
  // still lists (the group is not surfaced in the compact picker, only the
  // launch mode is). When no agents exist the list is just "None", so the
  // picker looks like today (NON-REGRESSION).
  const AGENT_OPTIONS = useMemo(() => {
    const sorted = [...agents].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
    const out: { value: string; label: string; hint?: string }[] = [
      { value: '', label: 'None', hint: 'no agent' },
    ];
    for (const a of sorted) {
      out.push({ value: a.id, label: a.name, hint: agentOptionHint(a) || undefined });
    }
    return out;
  }, [agents]);
  // Keep the agent highlight aligned with the chosen agent as the list loads /
  // the selection changes (mirrors the priority/status highlight alignment).
  useEffect(() => {
    const i = AGENT_OPTIONS.findIndex((o) => o.value === agentId);
    setAgentHighlight(i >= 0 ? i : 0);
  }, [AGENT_OPTIONS, agentId]);

  // task-201f5e3cde57 — the project a task started with (edit: its own project;
  // create: a pre-selected project). Used to pin it as option 1 + focused so
  // Enter confirms the current project immediately.
  const initialProjectId = initial?.projectId ?? preselectedProjectId;
  // task-201f5e3cde57 — sentinel value for the "Other…" entry that opens the
  // type-ahead over the full project list. Never a real project id.
  const PROJECT_OTHER = '__other__';

  // task-7ef6be165783 — projects ranked by MOST ACTIVE tasks (desc), then
  // alphabetically (case-insensitive). Drives both the short list's "top 3
  // others" and the type-ahead ranking.
  const rankedProjects = useMemo(() => {
    return [...projects].sort((a, b) => {
      const ca = activeCountByProject.get(a.id) ?? 0;
      const cb = activeCountByProject.get(b.id) ?? 0;
      if (cb !== ca) return cb - ca;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }, [projects, activeCountByProject]);

  const projectOpt = (p: Project) => ({
    value: p.id,
    label: p.name,
    hint: p.description ?? undefined,
  });

  // task-201f5e3cde57 — the SHORT project list shown by default:
  //   1. the task's CURRENT project (if any), focused so Enter confirms it,
  //   2. the top 3 OTHER projects (by active-task count),
  //   3. "None",
  //   4. "Other…" — opens a type-ahead over every project.
  // When there's no current project we just show the top 3 + None + Other.
  // "Current" tracks the LIVE selection (projectId), falling back to the
  // initial project — so whenever a project OUTSIDE the top 3 gets chosen
  // (a human via "Other…" search, or the copilot's set_task_form_project),
  // it surfaces here as the focused option instead of silently vanishing.
  const PROJECT_OPTIONS = useMemo(() => {
    const currentId = projectId || initialProjectId;
    const current = rankedProjects.find((p) => p.id === currentId) ?? null;
    const others = rankedProjects.filter((p) => p.id !== current?.id);
    const top3 = others.slice(0, 3);
    const out: { value: string; label: string; hint?: string }[] = [];
    if (current) out.push({ ...projectOpt(current), hint: current.description ?? 'current project' });
    for (const p of top3) out.push(projectOpt(p));
    out.push({ value: '', label: 'None', hint: 'no project' });
    // Only offer "Other…" when there are more projects than the short list shows.
    if (others.length > top3.length) {
      out.push({ value: PROJECT_OTHER, label: 'Other…', hint: 'search all projects' });
    }
    return out;
  }, [rankedProjects, initialProjectId, projectId]);

  // task-201f5e3cde57 — type-ahead over the full ranked list (revealed by
  // "Other…"). Filters by name, keeping the active-count ranking.
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const projectSearchRef = useRef<HTMLInputElement>(null);
  const projectSearchResults = useMemo(() => {
    const q = projectQuery.trim().toLowerCase();
    const matches = q
      ? rankedProjects.filter((p) => p.name.toLowerCase().includes(q))
      : rankedProjects;
    return matches.map(projectOpt);
  }, [rankedProjects, projectQuery]);
  const [projectSearchHighlight, setProjectSearchHighlight] = useState(0);

  const [projectHighlight, setProjectHighlight] = useState(0);
  // task-201f5e3cde57 — focus the CURRENT project (option 1) on open so Enter
  // confirms it; otherwise keep the highlight aligned with the chosen project as
  // the list loads / the selection changes (e.g. after a folder auto-attach).
  useEffect(() => {
    const i = PROJECT_OPTIONS.findIndex((o) => o.value === projectId);
    if (i >= 0) setProjectHighlight(i);
    else setProjectHighlight(0);
  }, [PROJECT_OPTIONS, projectId]);

  // Load the signed-in user's projects once TypeBuild is the target and the
  // user is signed in. Non-PHI, so it's safe to hold in renderer state.
  useEffect(() => {
    if (!isTypebuild || !tbSignedIn) return;
    let alive = true;
    fm.typebuild.projects
      .list()
      .then((list) => {
        if (alive) setProjects(list);
      })
      .catch(() => {
        /* projects stay empty → only the "None" option is offered */
      });
    return () => {
      alive = false;
    };
  }, [isTypebuild, tbSignedIn]);

  // task-896f3f7f5e75 — load the signed-in user's agent registry once TypeBuild
  // is the target. NON-PHI, safe to hold in renderer state. On any failure the
  // list stays empty → only the "None" option is offered (NON-REGRESSION).
  useEffect(() => {
    if (!isTypebuild || !tbSignedIn) return;
    let alive = true;
    fm.typebuild.agents
      .list()
      .then((list) => {
        if (alive) setAgents(list);
      })
      .catch(() => {
        /* agents stay empty → only the "None" option is offered */
      });
    return () => {
      alive = false;
    };
  }, [isTypebuild, tbSignedIn]);

  // Folder auto-attach: when the composer opens from a folder (create mode),
  // resolve that folder to its owning project and default-select it. Skipped
  // once the user has touched the picker (so a deliberate choice isn't yanked
  // back) and in edit mode (the saved project wins).
  useEffect(() => {
    if (props.mode !== 'create' || projectTouched || !isTypebuild || !tbSignedIn) return;
    const f = props.defaultFolder;
    if (!f) return;
    let alive = true;
    fm.typebuild.projects
      .resolve(f)
      .then((proj) => {
        if (!alive || !proj) return;
        // Guard against a late user pick racing the resolve.
        if (projectTouched) return;
        setProjectId(proj.id);
        setProjectAutoAttached(true);
        // Ensure the resolved project is present in the list even if the
        // list call hasn't landed yet, so the chip + option render.
        setProjects((prev) =>
          prev.some((p) => p.id === proj.id) ? prev : [...prev, proj],
        );
      })
      .catch(() => {
        /* no owning project → stays "None" */
      });
    return () => {
      alive = false;
    };
    // defaultFolder is stable for the composer's lifetime; intentionally not
    // re-resolving on every keystroke.
  }, [props.mode, projectTouched, isTypebuild, tbSignedIn]); // eslint-disable-line react-hooks/exhaustive-deps

  // The currently-attached project object (for the chip / summary).
  const attachedProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );

  // ── Chained tasks (task-2fd63b922beb, R2) ───────────────────────────────
  // A "chain" is an ordered TaskDef[] the human defines RIGHT HERE, in
  // memory — never read from a project pref (there is no stored template
  // object anywhere; see docs/task-templates-design.md). The choice ("Task"
  // vs "Chained task") and the inline builder are only offered for a fresh
  // TypeBuild create — editing an existing task is a single task, not a new
  // job, and the local target has no project/chain concept at all.
  const hasChainOption = props.mode === 'create' && isTypebuild;

  type TemplateChoiceId = 'blank' | 'chain';
  const [templateChoice, setTemplateChoice] = useState<TemplateChoiceId>(
    // "+ New Chained Task" opens with the chain flow pre-picked; the guard
    // effect below still falls back to 'blank' if the target can't chain.
    props.mode === 'create' && props.initialKind === 'chain' ? 'chain' : 'blank',
  );
  const [templateHighlight, setTemplateHighlight] = useState(0);
  // "Task" (today's flow) always first and always the default — picking it
  // is a NON-REGRESSION no-op.
  const TEMPLATE_OPTIONS = useMemo<{ id: TemplateChoiceId; label: string; hint?: string }[]>(
    () => [
      { id: 'blank', label: 'Task', hint: "today's flow — one task" },
      { id: 'chain', label: 'Chained task', hint: 'define a multi-step chain' },
    ],
    [],
  );
  useEffect(() => {
    const i = TEMPLATE_OPTIONS.findIndex((o) => o.id === templateChoice);
    setTemplateHighlight(i >= 0 ? i : 0);
  }, [TEMPLATE_OPTIONS, templateChoice]);
  // A target switch that drops the chain option falls back to "Task" so the
  // flow never strands on an option that's no longer offered.
  useEffect(() => {
    if (!hasChainOption && templateChoice !== 'blank') setTemplateChoice('blank');
  }, [hasChainOption, templateChoice]);

  // ── Chain builder state ──────────────────────────────────────────────────
  // `chainDefs` is the in-memory TaskDef[] the human is defining — held
  // purely in composer state until save(), when it's passed straight through
  // to instantiateTemplate as `defs`. Field/step DEFINITIONS (keys, labels,
  // types, conditions) are non-PHI; only the later input VALUES are PHI.
  const chainDefSeqRef = useRef(1);
  function blankChainDef(): TaskDef {
    chainDefSeqRef.current += 1;
    return { id: `step${chainDefSeqRef.current}`, name: '', inputs: [], outputs: [] };
  }
  const [chainDefs, setChainDefs] = useState<TaskDef[]>(() => [
    { id: 'step1', name: '', inputs: [], outputs: [] },
  ]);
  function addChainDef() {
    setChainDefs((prev) => [...prev, blankChainDef()]);
  }
  function removeChainDef(idx: number) {
    setChainDefs((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  }
  function moveChainDef(idx: number, dir: -1 | 1) {
    setChainDefs((prev) => {
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      const tmp = next[idx];
      next[idx] = next[j];
      next[j] = tmp;
      return next;
    });
  }
  function updateChainDef(idx: number, patch: Partial<TaskDef>) {
    setChainDefs((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  }
  function addChainField(defIdx: number, kind: 'inputs' | 'outputs') {
    setChainDefs((prev) =>
      prev.map((d, i) =>
        i === defIdx
          ? { ...d, [kind]: [...(d[kind] ?? []), { key: '', label: '', type: 'text' as const }] }
          : d,
      ),
    );
  }
  function removeChainField(defIdx: number, kind: 'inputs' | 'outputs', fieldIdx: number) {
    setChainDefs((prev) =>
      prev.map((d, i) =>
        i === defIdx ? { ...d, [kind]: (d[kind] ?? []).filter((_, fi) => fi !== fieldIdx) } : d,
      ),
    );
  }
  function updateChainField(
    defIdx: number,
    kind: 'inputs' | 'outputs',
    fieldIdx: number,
    patch: Partial<TaskDefField>,
  ) {
    setChainDefs((prev) =>
      prev.map((d, i) =>
        i === defIdx
          ? { ...d, [kind]: (d[kind] ?? []).map((f, fi) => (fi === fieldIdx ? { ...f, ...patch } : f)) }
          : d,
      ),
    );
  }
  function setChainNeededWhen(defIdx: number, cond: TaskDefCondition | null) {
    setChainDefs((prev) => prev.map((d, i) => (i === defIdx ? { ...d, neededWhen: cond } : d)));
  }
  // Candidate upstream OUTPUT refs a later step's `neededWhen` can gate on —
  // every output field from every step BEFORE `defIdx`. Carries the field
  // itself (task-f8ae99553691) so the condition-value input below can be
  // constrained by the referenced output's TYPE (bool → Yes/No, number →
  // numeric, select → its own options, text → free text).
  function upstreamOutputRefs(defIdx: number): { ref: string; label: string; field: TaskDefField }[] {
    const out: { ref: string; label: string; field: TaskDefField }[] = [];
    for (let i = 0; i < defIdx; i++) {
      const d = chainDefs[i];
      for (const f of d.outputs ?? []) {
        if (!f.key) continue;
        out.push({
          ref: fieldRef(d.id, f.key),
          label: `${d.name || `Step ${i + 1}`} · ${f.label || f.key}`,
          field: f,
        });
      }
    }
    return out;
  }
  // At least one task-def with a non-empty name is required to advance past
  // the chain builder.
  const chainDefsValid = chainDefs.some((d) => d.name.trim().length > 0);

  // ── Copy from an existing chained task ──────────────────────────────────
  // "Existing chained tasks" are prior TypeBuild tasks whose body carries a
  // v2 ```task-template block (parseTaskTemplateBlock) — there is no saved
  // template registry to browse, only past chained tasks (see the design
  // doc's "Copy from an existing chained task" section). Reuses the same
  // task-list access every other New Home surface uses (useTasks); no new
  // fetch mechanism. Selecting one pre-fills the chain's name (the composer's
  // title, if not already typed) + `defs` — VALUES are never copied.
  const { tasks: allTasksForChainCopy } = useTasks({ includeDone: true });
  const priorChains = useMemo(() => {
    if (!hasChainOption) return [];
    const out: { taskId: string; name: string; defs: TaskDef[]; updatedAt: number }[] = [];
    for (const t of allTasksForChainCopy) {
      if (t.source !== TYPEBUILD_SOURCE || t.parentTaskId) continue;
      const parsed = parseTaskTemplateBlock(t.notes ?? null);
      if (!parsed || parsed.defs === null) continue;
      out.push({ taskId: t.id, name: parsed.name, defs: parsed.defs, updatedAt: t.updated_at ?? 0 });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out.slice(0, 25);
  }, [allTasksForChainCopy, hasChainOption]);
  function copyChainFrom(entry: { name: string; defs: TaskDef[] }) {
    const cloned = entry.defs.map((d) => ({
      ...d,
      inputs: (d.inputs ?? []).map((f) => ({ ...f })),
      outputs: (d.outputs ?? []).map((f) => ({ ...f })),
      ...(d.neededWhen ? { neededWhen: { ...d.neededWhen } } : {}),
    }));
    setChainDefs(cloned.length > 0 ? cloned : [blankChainDef()]);
    if (!title.trim()) setTitle(entry.name);
  }

  // ── Plain-task fields (task-2fd63b922beb correction, Part A) ─────────────
  // The PLAIN task form owns its OWN optional input/output fields — a single
  // task-def with the literal id 'task'. No neededWhen here (that's chain-
  // only). Definitions (key/label/type/options/required) are NON-PHI; the
  // later typed VALUES ride templateValues (PHI, body-only, same as a chain).
  const [taskInputs, setTaskInputs] = useState<TaskDefField[]>([]);
  const [taskOutputs, setTaskOutputs] = useState<TaskDefField[]>([]);
  function taskFieldSetter(kind: 'inputs' | 'outputs') {
    return kind === 'inputs' ? setTaskInputs : setTaskOutputs;
  }
  function addTaskField(kind: 'inputs' | 'outputs') {
    taskFieldSetter(kind)((prev) => [...prev, { key: '', label: '', type: 'text' as const }]);
  }
  function removeTaskField(kind: 'inputs' | 'outputs', fieldIdx: number) {
    taskFieldSetter(kind)((prev) => prev.filter((_, i) => i !== fieldIdx));
  }
  function updateTaskField(kind: 'inputs' | 'outputs', fieldIdx: number, patch: Partial<TaskDefField>) {
    taskFieldSetter(kind)((prev) => prev.map((f, i) => (i === fieldIdx ? { ...f, ...patch } : f)));
  }
  // The single synthetic task-def the plain form's fields aggregate through —
  // reuses the exact same aggregateInputs / build*Block path as a chain.
  const taskFieldsDef = useMemo<TaskDef>(
    () => ({ id: 'task', name: title.trim() || 'Task', inputs: taskInputs, outputs: taskOutputs }),
    [title, taskInputs, taskOutputs],
  );

  // Whichever defs currently drive the aggregated field/outputs questions: the
  // chain when "Chained task" is picked, else the single plain-task def.
  const fieldsDefs = useMemo<TaskDef[]>(
    () => (templateChoice === 'chain' ? chainDefs : [taskFieldsDef]),
    [templateChoice, chainDefs, taskFieldsDef],
  );
  const definedOutputsCount = useMemo(
    () => fieldsDefs.reduce((n, d) => n + (d.outputs?.length ?? 0), 0),
    [fieldsDefs],
  );
  // A chained job is a THIN container flow (name + chain, no task-form
  // questions); a plain task keeps its full flow plus the optional fields step.
  const isMinimalChain = hasChainOption && templateChoice === 'chain';
  // The read-only outputs summary shows for any chain, or for a plain task that
  // actually defined outputs.
  const showOutputsStep = hasChainOption && (templateChoice === 'chain' || definedOutputsCount > 0);

  // Every driving def's input fields, in aggregate/definition order (def order,
  // then field order) — this is what dynamically extends the question flow.
  // Empty (no inputs, or not a TypeBuild create) → no field questions.
  const templateFieldEntries = useMemo(
    () => (hasChainOption ? aggregateInputs(fieldsDefs) : []),
    [hasChainOption, fieldsDefs],
  );
  const templateFieldQIds = useMemo(
    () => templateFieldEntries.map((e) => fieldQId(e.taskDef.id, e.field.key)),
    [templateFieldEntries],
  );
  function fieldEntryFor(q: QuestionId): { taskDef: TaskDef; field: TaskDefField } | null {
    if (!isFieldQuestion(q)) return null;
    const ref = q.slice('field:'.length);
    return templateFieldEntries.find((e) => fieldRef(e.taskDef.id, e.field.key) === ref) ?? null;
  }

  // Input VALUES, flat-keyed by fieldRef — PHI (a human's typed answer), held
  // only in memory and passed to instantiateTemplate on save; never logged.
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({});
  function setTemplateValue(ref: string, v: string) {
    setTemplateValues((prev) => ({ ...prev, [ref]: v }));
  }
  // Highlight index per select/bool field, keyed by fieldRef (mirrors the
  // single-question highlight states above, just keyed since there can be N).
  const [templateFieldHighlight, setTemplateFieldHighlight] = useState<Record<string, number>>({});
  // Focus targets for free-entry (text/number/date) field inputs, so the
  // active-field effect below can focus them the same way title/notes do.
  const fieldInputRefs = useRef(new Map<string, HTMLInputElement>());
  function setFieldInputRef(ref: string) {
    return (el: HTMLInputElement | null) => {
      if (el) fieldInputRefs.current.set(ref, el);
      else fieldInputRefs.current.delete(ref);
    };
  }

  // Dynamically extend the question flow: 'template' (the Task/Chained-task
  // choice) is always spliced in right after 'project'; choosing "Chained
  // task" additionally splices in 'chain' (the builder), its aggregated field
  // questions, and a read-only 'outputs' summary. The local target or edit
  // mode never add any of these — QUESTIONS is then `baseQuestions` unchanged
  // (byte-for-byte QUESTIONS_LOCAL/QUESTIONS_TYPEBUILD).
  const QUESTIONS = useMemo<QuestionId[]>(() => {
    if (!hasChainOption) return baseQuestions;
    const pIdx = baseQuestions.indexOf('project');
    const before = baseQuestions.slice(0, pIdx + 1); // title, project

    // task-2fd63b922beb correction (Part B) — a "Chained task" is a THIN
    // container: name (title) + project + the chain + its aggregated input
    // values + a read-only outputs summary. The task-form questions
    // (who/notes/start/when/priority/agent/status/pin) are DROPPED — the chain
    // is not a full task.
    if (templateChoice === 'chain') {
      return [...before, 'template', 'chain', ...templateFieldQIds, 'outputs'];
    }

    // task-2fd63b922beb correction (Part A) — a plain task keeps today's full
    // flow, with 'template' after project and an optional 'fields' step right
    // after 'notes' (the task's own inputs/outputs). Defined inputs splice in
    // one value question each; any outputs add the read-only summary step.
    const after = baseQuestions.slice(pIdx + 1);
    const withTemplate: QuestionId[] = [...before, 'template', ...after];
    const nIdx = withTemplate.indexOf('notes');
    const head = withTemplate.slice(0, nIdx + 1);
    const tail = withTemplate.slice(nIdx + 1);
    const extra: QuestionId[] = ['fields', ...templateFieldQIds];
    if (definedOutputsCount > 0) extra.push('outputs');
    return [...head, ...extra, ...tail];
  }, [baseQuestions, hasChainOption, templateChoice, templateFieldQIds, definedOutputsCount]);

  const [activeIdx, setActiveIdx] = useState(0);
  // Clamp the active index when the question list shrinks/grows on a target
  // switch (TypeBuild drops 'folder', adds 'priority') or a template pick
  // (adds/removes field + outputs questions), so we never index past the end
  // and strand the keyboard cursor.
  const active = QUESTIONS[Math.min(activeIdx, QUESTIONS.length - 1)];

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
  // task-2d96db620f6b / task-aa513e612954 — the wrapper of the CURRENTLY active
  // section. Each <section> assigns this ref while it's active, so we can scroll
  // it to the top of the composer's scroll container when it activates (instead
  // of letting its option list open below the fold) and anchor the focused-field
  // label to it.
  const activeSectionRef = useRef<HTMLElement>(null);
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
      // task-9ab05f87eda3 — embedded (the drawer's "Task details" tab edits an
      // EXISTING task) must not auto-select the title text on open: it read as
      // a visual glitch (title looks "highlighted") with no user action behind
      // it. Auto-select is only useful for the blank new-task wizard, where
      // there's nothing to select yet anyway (still harmless there), so gate
      // it on !embedded rather than dropping it for every mode.
      titleRef.current?.focus();
      if (!props.embedded) titleRef.current?.select();
    } else if (active === 'notes') {
      notesRef.current?.focus();
    } else if (isFieldQuestion(active) && !isFieldOptionType(fieldEntryFor(active)?.field ?? { key: '', label: '', type: 'text' })) {
      // task-04ea172532c0 — a free-entry (text/number/date) template field
      // focuses its own input, same as title/notes; select/bool fields fall
      // through to the generic section-focus branch below (they're option
      // questions, driven by digits/Enter, not typing).
      const entry = fieldEntryFor(active);
      if (entry) fieldInputRefs.current.get(fieldRef(entry.taskDef.id, entry.field.key))?.focus();
    } else {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        el.blur();
      }
      sectionRef.current?.focus();
    }
  }, [active]);

  // task-2d96db620f6b — when a section becomes active, bring it to the TOP of
  // the composer's scroll container so its options render in view rather than
  // opening below the fold and forcing a manual scroll-up. Runs after the focus
  // effect's layout settles (next frame) so the expanded body's height is known.
  useEffect(() => {
    const el = activeSectionRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(id);
  }, [active, phase]);

  function goBack() {
    if (activeIdx > 0) setActiveIdx(activeIdx - 1);
  }
  function goNext() {
    if (activeIdx < QUESTIONS.length - 1) setActiveIdx(activeIdx + 1);
  }

  // task-2fd63b922beb (R2) — the chain builder only advances once at least
  // one step has a non-empty name (chainDefsValid); otherwise it surfaces an
  // inline error and stays put, same convention as the date/cron validations
  // elsewhere in save().
  function tryAdvanceChain() {
    if (!chainDefsValid) {
      setError('Add at least one named step to the chain.');
      return;
    }
    setError(null);
    goNext();
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
    setExecutorTouched(true);
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
    // fm-m2s4 (S5) — in TypeBuild mode the question after When is Priority.
    if (isTypebuild) setPriorityHighlight(priorityHighlight);
    else setStatusHighlight(STATUS_OPTIONS.findIndex((s) => s.id === status));
    goNext();
  }

  function chooseDueQuickPick(qp: DueQuickPick) {
    // Quick-picks resolve to a concrete date and reuse the pick-date path
    // so save() emits a due_at. Set the highlight to the pick-date row so
    // the selection reads consistently, then advance.
    const iso = qp.iso(todayISO());
    setWhenId('pick-date');
    setPickedDate(iso);
    const pdIdx = visibleWhenOptions.findIndex((w) => w.id === 'pick-date');
    if (pdIdx >= 0) setWhenHighlight(pdIdx);
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

  // fm-m2s4 (S5) — TypeBuild priority pick. Index 0 is "Unset".
  function choosePriority(i: number) {
    const o = PRIORITY_OPTIONS[i];
    if (!o) return;
    setPriority(o.value);
    setPriorityHighlight(i);
    // task-896f3f7f5e75 — the question after Priority is Agent (TypeBuild).
    setAgentHighlight(Math.max(0, AGENT_OPTIONS.findIndex((opt) => opt.value === agentId)));
    goNext();
  }

  // task-896f3f7f5e75 — TypeBuild agent pick. Index 0 is "None" (clears the
  // assignment). Sets the agent and advances like the other option questions.
  function chooseAgent(i: number) {
    const o = AGENT_OPTIONS[i];
    if (!o) return;
    setAgentId(o.value);
    setAgentHighlight(i);
    setStatusHighlight(STATUS_OPTIONS.findIndex((s) => s.id === status));
    goNext();
  }

  // task-ab1d7955e23f / task-201f5e3cde57 — TypeBuild project pick from the
  // SHORT list. Picking "Other…" opens the type-ahead instead of advancing.
  function chooseProject(i: number) {
    const o = PROJECT_OPTIONS[i];
    if (!o) return;
    setProjectHighlight(i);
    if (o.value === PROJECT_OTHER) {
      setProjectSearchOpen(true);
      setProjectQuery('');
      setProjectSearchHighlight(0);
      setTimeout(() => projectSearchRef.current?.focus(), 0);
      return;
    }
    setProjectId(o.value);
    setProjectTouched(true);
    // A manual pick is no longer an auto-attach (clears the "auto" chip note).
    setProjectAutoAttached(false);
    setProjectSearchOpen(false);
    goNext();
  }

  // task-201f5e3cde57 — pick a project from the type-ahead results (the long
  // tail). Sets the project and advances like a normal pick.
  function chooseProjectFromSearch(i: number) {
    const o = projectSearchResults[i];
    if (!o) return;
    setProjectId(o.value);
    setProjectTouched(true);
    setProjectAutoAttached(false);
    setProjectSearchOpen(false);
    setProjectQuery('');
    // Realign the short-list highlight to the chosen project if it's shown.
    const si = PROJECT_OPTIONS.findIndex((opt) => opt.value === o.value);
    if (si >= 0) setProjectHighlight(si);
    goNext();
  }

  function choosePin(i: number) {
    const o = PIN_OPTIONS[i];
    if (!o) return;
    setPinned(o.id === 'yes');
    setPinHighlight(i);
    enterCommitPhase();
  }

  // task-2fd63b922beb (R2) — Task-kind pick. Choosing "Task" (the default)
  // leaves templateChoice untouched-equivalent (it already IS the default) —
  // non-regression; choosing "Chained task" dynamically inserts the chain
  // builder + its aggregated field + outputs questions right after this one
  // (see QUESTIONS).
  function chooseTemplate(i: number) {
    const o = TEMPLATE_OPTIONS[i];
    if (!o) return;
    setTemplateChoice(o.id);
    setTemplateHighlight(i);
    goNext();
  }
  // One aggregated select/bool INPUT field pick, keyed by fieldRef.
  function chooseFieldOption(ref: string, options: { value: string; label: string }[], i: number) {
    const o = options[i];
    if (!o) return;
    setTemplateValue(ref, o.value);
    setTemplateFieldHighlight((prev) => ({ ...prev, [ref]: i }));
    goNext();
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
    if (active === 'project') {
      // task-ab1d7955e23f — Project → Who.
      if (projectHighlight >= PROJECT_OPTIONS.length - 1) {
        setWhoHighlight(0);
        goNext();
      } else setProjectHighlight((i) => i + 1);
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
        // fm-m2s4 (S5) — When → Priority (TypeBuild) or → Status (local).
        if (isTypebuild) setPriorityHighlight(priorityHighlight);
        else setStatusHighlight(STATUS_OPTIONS.findIndex((s) => s.id === status));
        goNext();
      }
      return;
    }
    if (active === 'priority') {
      // task-896f3f7f5e75 — Priority → Agent (TypeBuild; the agent question
      // sits right after priority in QUESTIONS_TYPEBUILD).
      if (priorityHighlight >= PRIORITY_OPTIONS.length - 1) {
        setAgentHighlight(Math.max(0, AGENT_OPTIONS.findIndex((o) => o.value === agentId)));
        goNext();
      } else setPriorityHighlight((i) => i + 1);
      return;
    }
    if (active === 'agent') {
      // task-896f3f7f5e75 — Agent → Status.
      if (agentHighlight >= AGENT_OPTIONS.length - 1) {
        setStatusHighlight(STATUS_OPTIONS.findIndex((s) => s.id === status));
        goNext();
      } else setAgentHighlight((i) => i + 1);
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
    // task-2fd63b922beb (R2) — Task-kind pick + the chain builder + its
    // aggregated fields + read-only outputs summary. goNext() advances the
    // index regardless of which concrete question comes next, so these
    // compose transparently with the hardcoded 'project'/'who' transitions
    // above.
    if (active === 'template') {
      if (templateHighlight >= TEMPLATE_OPTIONS.length - 1) goNext();
      else setTemplateHighlight((i) => i + 1);
      return;
    }
    if (active === 'chain') {
      tryAdvanceChain();
      return;
    }
    // The plain-task fields step is optional — ↓ just advances.
    if (active === 'fields') {
      goNext();
      return;
    }
    if (active === 'outputs') {
      // In the minimal chain flow 'outputs' is the LAST question — ↓ off its
      // end hops to commit; in the plain flow more questions follow.
      if (QUESTIONS.indexOf('outputs') >= QUESTIONS.length - 1) enterCommitPhase();
      else goNext();
      return;
    }
    if (isFieldQuestion(active)) {
      const entry = fieldEntryFor(active);
      if (entry && isFieldOptionType(entry.field)) {
        const ref = fieldRef(entry.taskDef.id, entry.field.key);
        const opts = fieldOptionList(entry.field);
        const h = templateFieldHighlight[ref] ?? 0;
        if (h >= opts.length - 1) goNext();
        else setTemplateFieldHighlight((prev) => ({ ...prev, [ref]: h + 1 }));
      } else {
        goNext();
      }
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
    if (active === 'project') {
      // task-ab1d7955e23f — Project ↑ → back to Title.
      if (projectHighlight === 0) goBack();
      else setProjectHighlight((i) => i - 1);
      return;
    }
    if (active === 'who') {
      if (whoHighlight === 0) {
        // task-ab1d7955e23f — the question before Who is Project (TypeBuild)
        // or Folder (local).
        if (isTypebuild) setProjectHighlight(PROJECT_OPTIONS.length - 1);
        else setFolderHighlight(visibleFolderPresets.length - 1);
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
    if (active === 'priority') {
      // fm-m2s4 (S5) — Priority ↑ → back to When.
      if (priorityHighlight === 0) {
        setWhenHighlight(visibleWhenOptions.length - 1);
        goBack();
      } else setPriorityHighlight((i) => i - 1);
      return;
    }
    if (active === 'agent') {
      // task-896f3f7f5e75 — Agent ↑ → back to Priority.
      if (agentHighlight === 0) {
        setPriorityHighlight(priorityHighlight);
        goBack();
      } else setAgentHighlight((i) => i - 1);
      return;
    }
    if (active === 'status') {
      if (statusHighlight === 0) {
        // fm-m2s4 (S5) — Status ↑ → Agent (TypeBuild) or → When (local).
        // task-896f3f7f5e75 — the question before Status is Agent in TB mode.
        if (isTypebuild) setAgentHighlight(Math.max(0, AGENT_OPTIONS.findIndex((o) => o.value === agentId)));
        else setWhenHighlight(visibleWhenOptions.length - 1);
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
    // task-2fd63b922beb (R2) — mirrors the moveDown additions above.
    if (active === 'template') {
      if (templateHighlight === 0) goBack();
      else setTemplateHighlight((i) => i - 1);
      return;
    }
    if (active === 'chain') {
      goBack();
      return;
    }
    if (active === 'fields') {
      goBack();
      return;
    }
    if (active === 'outputs') {
      goBack();
      return;
    }
    if (isFieldQuestion(active)) {
      const entry = fieldEntryFor(active);
      if (entry && isFieldOptionType(entry.field)) {
        const ref = fieldRef(entry.taskDef.id, entry.field.key);
        const h = templateFieldHighlight[ref] ?? 0;
        if (h === 0) goBack();
        else setTemplateFieldHighlight((prev) => ({ ...prev, [ref]: h - 1 }));
      } else {
        goBack();
      }
      return;
    }
  }

  async function save(overrideWhenId?: string): Promise<{ ok: boolean; taskId?: string; error?: string }> {
    if (busy) return { ok: false, error: 'Already saving.' };
    if (noTarget) {
      const msg = 'Sign in to TypeBuild to create a task.';
      setError(msg);
      return { ok: false, error: msg };
    }
    if (!title.trim()) {
      const msg = 'Add a title.';
      setError(msg);
      setActiveIdx(0);
      setTimeout(() => titleRef.current?.focus(), 0);
      return { ok: false, error: msg };
    }
    // task-2fd63b922beb (R2) — a chained-task job doesn't consume
    // when/start/cron (a chain's per-task scheduling isn't modeled by the
    // composer's single When/Start pick), so it saves via a dedicated path
    // that skips those validations entirely and calls the instantiateTemplate
    // seam instead of a single createTask. The title question doubles as the
    // job's (meta parent's) title, per the design contract. A chain with no
    // named step can't be saved as a job — the builder itself blocks
    // advancing past it (chainDefsValid), but this is the last line of
    // defense if that's ever bypassed (e.g. ⌘↵ from an earlier question).
    if (props.mode === 'create' && hasChainOption && templateChoice === 'chain') {
      if (!chainDefsValid) {
        const msg = 'Add at least one named step to the chain.';
        setError(msg);
        setActiveIdx(QUESTIONS.indexOf('chain'));
        return { ok: false, error: msg };
      }
      return saveTemplateJob();
    }
    const effectiveWhenId = overrideWhenId ?? whenId;
    if (effectiveWhenId === 'pick-date' && !pickedDate) {
      const msg = 'Pick a date.';
      setError(msg);
      setActiveIdx(QUESTIONS.indexOf('when'));
      setTimeout(() => dateInputRef.current?.focus(), 0);
      return { ok: false, error: msg };
    }
    if (effectiveWhenId === 'custom-cron') {
      const trimmed = customCron.trim();
      if (!trimmed || trimmed.split(/\s+/).length !== 5) {
        const msg = 'Cron must have 5 space-separated fields.';
        setError(msg);
        setActiveIdx(QUESTIONS.indexOf('when'));
        setTimeout(() => cronInputRef.current?.focus(), 0);
        return { ok: false, error: msg };
      }
    }
    if (startId === 'pick-start' && !pickedStart) {
      // fm-m2s4 (S5) — the start step is "Defer until" in TypeBuild mode.
      const msg = isTypebuild ? 'Pick a defer date.' : 'Pick a start date.';
      setError(msg);
      setActiveIdx(QUESTIONS.indexOf('start'));
      setTimeout(() => startDateRef.current?.focus(), 0);
      return { ok: false, error: msg };
    }
    // task-f9a723379aa8 — a plain task's input field can have a typed VALUE
    // but no key that normalizes to the server's [a-z0-9._-]+ convention (e.g.
    // both key and label left as "News site url" — no letters/digits survive
    // a bad normalization). NEVER silently drop a filled value: block save
    // and send the user back to the offending field instead of creating a
    // task whose data bag is silently missing it.
    if (hasChainOption && templateChoice === 'blank') {
      for (const f of taskInputs) {
        const v = templateValues[fieldRef('task', f.key)] ?? '';
        if (v !== '' && !effectiveFieldKey(f)) {
          const msg = `"${f.label || f.key || 'this input'}" needs a valid key (letters, numbers, ., _, or - only) before it can be saved.`;
          setError(msg);
          setActiveIdx(QUESTIONS.indexOf(fieldQId('task', f.key)));
          return { ok: false, error: msg };
        }
      }
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
      // task-a7214605a998 (S6) — a PLAIN task that defines its own input/output
      // fields now writes them STRUCTURED (server S1 data map + S2
      // output_schema) instead of embedding ```task-fields/```task-outputs
      // fenced blocks in the body. This branch only ever runs for a TypeBuild
      // CREATE (hasChainOption implies mode==='create' && isTypebuild — see
      // hasChainOption's definition), so there is no local-source or edit-path
      // fallback to preserve here: reading OLD fenced-block tasks is still
      // handled everywhere else (taskSchema.mjs's parsers are unchanged) — this
      // is a write-side-only migration. PHI: input VALUES ride `dataForSave`
      // (the create payload's `data` map, encrypted at rest server-side, never
      // logged); `outputSchemaForSave` is NON-PHI field definitions only. No
      // fields defined → both stay empty → the created task is byte-identical
      // to a plain task today (NON-REGRESSION).
      const notesForSave = trimmedNotes;
      let outputSchemaForSave: TaskDefField[] | undefined;
      let dataForSave: Record<string, string> | undefined;
      if (hasChainOption && templateChoice === 'blank') {
        const inputVals: Record<string, string> = {};
        for (const f of taskInputs) {
          // task-f9a723379aa8 — key the VALUE by the same normalized key the
          // field is defined under (effectiveFieldKey: the typed key,
          // normalized, falling back to a normalized label). The pre-save
          // validation above already blocks any filled-but-unkeyable field,
          // so an empty effectiveFieldKey here only happens for an EMPTY
          // field (no key, no label, no value) — safe to skip.
          const key = effectiveFieldKey(f);
          if (!key) continue;
          const v = templateValues[fieldRef('task', f.key)] ?? '';
          if (v !== '') inputVals[key] = v;
        }
        if (Object.keys(inputVals).length > 0) {
          dataForSave = inputVals;
        }
        if (taskOutputs.length > 0) {
          // Output field keys ride output_schema verbatim (they're NON-PHI
          // config the agent's submit_task_result matches against, not data-
          // bag keys), but normalize them the same way so a malformed output
          // key can't silently mismatch what the agent submits either.
          outputSchemaForSave = taskOutputs.map((f) => ({
            ...f,
            key: effectiveFieldKey(f) || f.key,
          }));
        }
      }
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
      // fm-m2s4 (S5) — TypeBuild maps the composer's "start" pick onto the
      // server's defer_until (and labels it "Defer until"); folder anchoring
      // doesn't apply, so it sends an empty folder. The local path is left
      // byte-for-byte unchanged: it still writes start_at and folder.
      const parsedPriority =
        priority !== '' ? Number(priority) : undefined;

      const basePayload = {
        title: title.trim(),
        notes: notesForSave ? notesForSave : null,
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

      // fm-m2s4 (S5) — defer/priority are create-path fields (TaskCreate models
      // them; TaskUpdate does not — TypeBuild edits to those go through the S4
      // detail-panel PATCH, not the composer). So for the TypeBuild target we
      // attach them only on create; an edit just keeps the shared base + empty
      // folder.
      // task-ab1d7955e23f — the chosen project rides the create as `projectId`
      // (TaskCreate models it; the TypeBuild source maps it to `project_id`).
      // Only meaningful for the TypeBuild target; the local source ignores it.
      // '' (the "None" option) means "no project" → omit the key so a create
      // that doesn't care leaves the server default untouched.
      const payload =
        isTypebuild && props.mode === 'create'
          ? {
              ...basePayload,
              folder: '',
              // The chosen start date becomes defer_until for TypeBuild.
              deferUntil: resolvedStart,
              ...(parsedPriority !== undefined ? { priority: parsedPriority } : {}),
              ...(projectId ? { projectId } : {}),
              // task-896f3f7f5e75 — the chosen agent rides the create as
              // `agentId` (TaskCreate models it; the TypeBuild source maps it to
              // `agent_id`). '' (None) → omit the key so a create that doesn't
              // care leaves the server default (no agent). Non-PHI.
              ...(agentId ? { agentId } : {}),
              // task-a7214605a998 (S6) — structured output schema (NON-PHI) +
              // data map (PHI) built above, in place of the fenced blocks this
              // composer used to splice into `notes`. Omitted when the plain
              // task defines no fields, same as the fenced-block path before it
              // (NON-REGRESSION).
              ...(outputSchemaForSave ? { outputSchema: outputSchemaForSave } : {}),
              ...(dataForSave ? { data: dataForSave } : {}),
            }
          : isTypebuild
            ? { ...basePayload, folder: '' }
            : {
                ...basePayload,
                folder: folder.trim(),
                start_at: resolvedStart,
              };

      let savedId: string;
      if (props.mode === 'create') {
        // fm-m2s4 (S5) — route the create through the chosen source. The
        // target is a registered source id (e.g. 'typebuild', which encrypts
        // title/notes — by design); send it directly.
        const t = await createTask(payload as TaskCreate, target);
        savedId = t.id;
      } else if (isTypebuild) {
        // task-ab1d7955e23f / task-b30e546672db — TypeBuild edits don't go
        // through updateTask (canEdit is false / the source throws); the
        // management fields the server's PATCH /chromeext/<id> verb accepts ride
        // the 'patch' source action. Collect everything that CHANGED into one
        // patch ('' clears a clearable field) so the embedded "Task details"
        // editor persists its edits in a single round-trip.
        //
        // task-63b936d69127 — title + body/notes ARE editable now: the v2
        // management verb accepts `title` and `task` (re-encrypted at rest),
        // and the source's patch whitelist forwards them. PHI rides the request
        // body to be encrypted server-side (allowed — the invariant only forbids
        // LOCAL persistence of decrypted content, never the encrypting POST).
        const patch: Record<string, unknown> = {};
        // title — send only a real change. save() already guards a blank title,
        // so we never emit an empty title (which would clear it server-side).
        if (title.trim() !== (initial?.title ?? '')) {
          patch.title = title.trim();
        }
        // body/notes → the server's `task` field. '' clears it server-side.
        if ((trimmedNotes || '') !== (initial?.notes ?? '')) {
          patch.task = trimmedNotes;
        }
        if (projectId !== (initial?.projectId ?? '')) {
          patch.project_id = projectId;
        }
        // task-896f3f7f5e75 — agent assignment (scalar). '' clears it
        // server-side. The initial value comes from the resolved block's id or
        // the scalar agentId; only send a real change.
        if (agentId !== (initial?.agent?.id ?? initial?.agentId ?? '')) {
          patch.agent_id = agentId;
        }
        // status — the PATCH verb accepts it; only send a real change.
        if (status !== (initial?.status ?? 'pending')) {
          patch.status = status;
        }
        // priority — '' (Unset) leaves the server default; only send a change.
        if (parsedPriority !== undefined && parsedPriority !== (initial?.priority ?? undefined)) {
          patch.priority = parsedPriority;
        }
        // due_at — '' clears it server-side.
        if ((dueAt ?? '') !== (initial?.due_at ?? '')) {
          patch.due_at = dueAt ?? '';
        }
        // defer_until — the composer's "start" pick maps onto defer for TB.
        if ((resolvedStart ?? '') !== (initial?.deferUntil ?? '')) {
          patch.defer_until = resolvedStart ?? '';
        }
        if (Object.keys(patch).length > 0) {
          await taskSourceAction(target, props.task.id, 'patch', patch);
        }
        savedId = props.task.id;
      } else {
        const t = await updateTask(
          props.task.id,
          payload as TaskUpdate,
          target,
        );
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
      if (props.embedded) {
        // task-b30e546672db — stay mounted inside the dialog: flash "saved",
        // let the host refresh, then clear the flash so the form is editable
        // again (don't tear down the whole dialog on a field edit).
        props.onSaved?.();
        setBusy(false);
        setTimeout(() => setCreated(false), 1400);
      } else {
        setTimeout(() => exit(), 900);
      }
      return { ok: true, taskId: savedId };
    } catch (e) {
      const msg = humanizeError(e).message;
      setError(msg);
      setBusy(false);
      return { ok: false, error: msg };
    }
  }

  // task-04ea172532c0 — the createTask thunk instantiateTemplate calls once
  // per task (the meta parent, then each child). It reuses the composer's
  // EXISTING TypeBuild create path (the same `createTask(payload, target)`
  // call `save()` makes above) so a template job's tasks are indistinguishable
  // from any other TypeBuild create — same source, same shape — just with
  // parentTaskId/dependsOn threaded through.
  //
  // task-2fd63b922beb correction (Part B) — the chain is a THIN container, not
  // a full task. Its children carry ONLY structural fields (title/notes/project
  // + parent/depends linking); the composer's task-form picks
  // (status/priority/agent/pin) are NOT threaded onto them, so children get the
  // server's defaults. The scheduling (when/start/cron) questions aren't
  // consumed here either — the chained flow doesn't even ask them.
  async function createTaskForTemplateJob(input: {
    title: string;
    notes: string;
    projectId?: string;
    parentTaskId?: string;
    dependsOn?: string[];
  }): Promise<{ id: string }> {
    const payload: TaskCreate = {
      title: input.title,
      folder: '',
      notes: input.notes,
      auto_mode: false,
      auto_agent: null,
      auto_prompt: null,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.dependsOn ? { dependsOn: input.dependsOn } : {}),
    };
    const t = await createTask(payload, target);
    return { id: t.id };
  }

  // task-2fd63b922beb (R2) — save path for a chained-task job: one meta
  // parent + one child per task-def, via the instantiateTemplate seam (pinned
  // signature — see docs/task-templates-design.md). Never creates a single
  // plain task when a chain was chosen. `chainDefs` — the chain the human
  // just defined inline (or copied from a prior chained task and edited) —
  // is passed straight through; instantiateTemplate never reads it off a
  // project pref, there is no such pref anymore.
  async function saveTemplateJob(): Promise<{ ok: boolean; taskId?: string; error?: string }> {
    setBusy(true);
    setError(null);
    try {
      const result = await instantiateTemplate({
        name: title.trim(),
        projectId: projectId || undefined,
        defs: chainDefs,
        values: templateValues,
        createTask: createTaskForTemplateJob,
      });
      (window as unknown as { __fmFlashTaskId?: string; __fmFlashTs?: number }).__fmFlashTaskId = result.parentId;
      (window as unknown as { __fmFlashTaskId?: string; __fmFlashTs?: number }).__fmFlashTs = Date.now();
      window.dispatchEvent(
        new CustomEvent('fm:taskFlash', { detail: { taskId: result.parentId } }),
      );
      setCreated(true);
      if (props.embedded) {
        props.onSaved?.();
        setBusy(false);
        setTimeout(() => setCreated(false), 1400);
      } else {
        setTimeout(() => exit(), 900);
      }
      return { ok: true, taskId: result.parentId };
    } catch (e) {
      const msg = humanizeError(e).message;
      setError(msg);
      setBusy(false);
      return { ok: false, error: msg };
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
    if (active === 'project') {
      // task-201f5e3cde57 — the SHORT list (current + top-3 + None + Other) is
      // small, so digit shortcuts pick it cleanly; Enter picks the highlight
      // (the current project is focused on open, so Enter confirms it). The
      // type-ahead behind "Other…" is driven by the input's own handler.
      if (e.key === 'Enter') {
        e.preventDefault();
        chooseProject(projectHighlight);
        return;
      }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= PROJECT_OPTIONS.length) {
        e.preventDefault();
        chooseProject(n - 1);
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
      // Due quick-pick letter shortcuts (W / F / M) — manual tasks only.
      // Safe here because the When section has no text input focused (the
      // inText() guard above already returned for the date/cron inputs).
      if (executor === 'manual' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const qp = DUE_QUICK_PICKS.find(
          (q) => q.key.toLowerCase() === e.key.toLowerCase(),
        );
        if (qp) {
          e.preventDefault();
          chooseDueQuickPick(qp);
          return;
        }
      }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= visibleWhenOptions.length) {
        e.preventDefault();
        chooseWhen(n - 1);
        return;
      }
      return;
    }
    if (active === 'priority') {
      // fm-m2s4 (S5) — digits are ambiguous here (the labels are 0–10), so
      // priority is arrow + Enter only; ↑/↓ already moved the highlight above.
      if (e.key === 'Enter') {
        e.preventDefault();
        choosePriority(priorityHighlight);
        return;
      }
      return;
    }
    if (active === 'agent') {
      // task-896f3f7f5e75 — Enter picks the highlight; digits 1..N pick the
      // corresponding option (None is 1, then one per agent — unambiguous, so
      // digit shortcuts are safe here unlike priority's 0–10 labels).
      if (e.key === 'Enter') {
        e.preventDefault();
        chooseAgent(agentHighlight);
        return;
      }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= AGENT_OPTIONS.length) {
        e.preventDefault();
        chooseAgent(n - 1);
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
    // task-2fd63b922beb (R2) — Task-kind pick.
    if (active === 'template') {
      if (e.key === 'Enter') {
        e.preventDefault();
        chooseTemplate(templateHighlight);
        return;
      }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= TEMPLATE_OPTIONS.length) {
        e.preventDefault();
        chooseTemplate(n - 1);
        return;
      }
      return;
    }
    // The chain builder is a rich sub-form (buttons/inputs, not a
    // digit-select option list) — Enter reaching here means focus is on the
    // section wrapper itself (inText() already returned above for any
    // focused input/textarea inside it), so it just tries to advance.
    if (active === 'chain') {
      if (e.key === 'Enter') {
        e.preventDefault();
        tryAdvanceChain();
        return;
      }
      return;
    }
    // The plain-task fields step is a rich sub-form (like 'chain'); Enter on
    // the section wrapper just advances (inputs/outputs are optional).
    if (active === 'fields') {
      if (e.key === 'Enter') {
        e.preventDefault();
        goNext();
        return;
      }
      return;
    }
    // Outputs is a read-only summary — Enter advances (or commits when it's the
    // last question, i.e. the minimal chain flow).
    if (active === 'outputs') {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (QUESTIONS.indexOf('outputs') >= QUESTIONS.length - 1) enterCommitPhase();
        else goNext();
        return;
      }
      return;
    }
    // One aggregated task-def INPUT field. select/bool are option questions
    // (Enter/digits pick); text/number/date are handled by the field's own
    // <input onKeyDown> (mirrors 'folder'/'start'/'when''s date/cron inputs),
    // which the inText() guard above already returns for.
    if (isFieldQuestion(active)) {
      const entry = fieldEntryFor(active);
      if (entry && isFieldOptionType(entry.field)) {
        const ref = fieldRef(entry.taskDef.id, entry.field.key);
        const opts = fieldOptionList(entry.field);
        const h = templateFieldHighlight[ref] ?? 0;
        if (e.key === 'Enter') {
          e.preventDefault();
          chooseFieldOption(ref, opts, h);
          return;
        }
        const n = parseInt(e.key, 10);
        if (!Number.isNaN(n) && n >= 1 && n <= opts.length) {
          e.preventDefault();
          chooseFieldOption(ref, opts, n - 1);
          return;
        }
      }
      return;
    }
    // 'notes' has no option list; the textarea handles typing. Global
    // ↓ from outside the textarea moves to commit (handled in moveDown).
  };

  useEffect(() => {
    // task-b30e546672db — embedded in the detail dialog the HOST owns global
    // keyboard (Esc / tab switching); registering our window handler too would
    // make Esc-Esc cancel and digit keys collide. Pointer/Enter interaction on
    // the fields still works without it.
    if (props.embedded) return;
    function onKey(e: KeyboardEvent) { handlerRef.current?.(e); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.embedded]);

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
    return prettyFolder(folder, home);
  }
  function whoSummary(): string {
    return WHO_OPTIONS.find((w) => w.id === executor)?.label ?? 'Manual';
  }

  function statusSummary(): string {
    return STATUS_OPTIONS.find((s) => s.id === status)?.label ?? 'Pending';
  }
  function startSummary(): string {
    if (startId === 'pick-start') {
      const placeholder = isTypebuild ? 'Pick a defer date…' : 'Pick a start date…';
      return pickedStart ? formatDateNice(pickedStart) : placeholder;
    }
    // fm-m2s4 (S5) — "No start date" reads as "No defer" in TypeBuild mode.
    if (isTypebuild && startId === 'none') return 'No defer';
    return START_OPTIONS.find((s) => s.id === startId)?.label ?? 'No start date';
  }
  function prioritySummary(): string {
    return priority === '' ? 'Unset' : `Priority ${priority}`;
  }
  function agentSummary(): string {
    if (!agentId) return 'None';
    const a = agents.find((x) => x.id === agentId);
    return a?.name ?? 'Agent';
  }
  function projectSummary(): string {
    if (!projectId) return 'None';
    return attachedProject?.name ?? 'Project';
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
    if (q === 'project') return projectSummary();
    if (q === 'who') return whoSummary();
    if (q === 'when') return whenSummary();
    if (q === 'status') return statusSummary();
    if (q === 'start') return startSummary();
    if (q === 'priority') return prioritySummary();
    if (q === 'agent') return agentSummary();
    if (q === 'pin') return pinSummary();
    if (q === 'notes') return notesSummary();
    if (q === 'template') return templateSummary();
    if (q === 'chain') return chainSummary();
    if (q === 'fields') return fieldsSummary();
    if (q === 'outputs') return outputsSummary();
    if (isFieldQuestion(q)) return fieldAnswer(q);
    return '';
  }

  // task-2fd63b922beb (R2) — Task-kind/chain/field/outputs summaries.
  function templateSummary(): string {
    return TEMPLATE_OPTIONS.find((o) => o.id === templateChoice)?.label ?? 'Task';
  }
  function chainSummary(): string {
    const named = chainDefs.filter((d) => d.name.trim());
    if (named.length === 0) return 'No steps defined yet';
    return named.map((d) => d.name).join(' → ');
  }
  // task-2fd63b922beb correction (Part A) — the plain task's own field counts.
  function fieldsSummary(): string {
    const ni = taskInputs.filter((f) => f.key.trim()).length;
    const no = taskOutputs.filter((f) => f.key.trim()).length;
    if (ni === 0 && no === 0) return 'None';
    const parts: string[] = [];
    if (ni > 0) parts.push(`${ni} input${ni === 1 ? '' : 's'}`);
    if (no > 0) parts.push(`${no} output${no === 1 ? '' : 's'}`);
    return parts.join(', ');
  }
  function outputsSummary(): string {
    const total = definedOutputsCount;
    if (total === 0) return 'No outputs defined';
    const across =
      templateChoice === 'chain'
        ? ` across ${fieldsDefs.length} step${fieldsDefs.length === 1 ? '' : 's'}`
        : '';
    return `${total} output field${total === 1 ? '' : 's'}${across}`;
  }
  function fieldAnswer(q: QuestionId): string {
    const entry = fieldEntryFor(q);
    if (!entry) return '';
    const ref = fieldRef(entry.taskDef.id, entry.field.key);
    const v = templateValues[ref] ?? '';
    if (entry.field.type === 'bool') return v === 'true' ? 'Yes' : v === 'false' ? 'No' : '';
    return v;
  }

  // Short caption that prefixes the answer in collapsed/past sections —
  // a glance-able row like "start: today" / "end: tomorrow". Title is
  // intentionally label-less; it's the headline for the whole task.
  function labelFor(q: QuestionId): string | null {
    if (q === 'title') return null;
    if (q === 'folder') return 'folder';
    if (q === 'project') return 'project';
    if (q === 'who') return 'who';
    // fm-m2s4 (S5) — the start step is the defer date in TypeBuild mode.
    if (q === 'start') return isTypebuild ? 'defer' : 'start';
    if (q === 'when') return 'end';
    if (q === 'status') return 'status';
    if (q === 'priority') return 'priority';
    if (q === 'agent') return 'agent';
    if (q === 'pin') return 'pin';
    if (q === 'notes') return 'notes';
    if (q === 'template') return 'kind';
    if (q === 'chain') return 'chain';
    if (q === 'fields') return 'fields';
    if (q === 'outputs') return 'outputs';
    if (isFieldQuestion(q)) {
      const entry = fieldEntryFor(q);
      return entry ? `${entry.taskDef.name} · ${entry.field.label}` : null;
    }
    return null;
  }

  function promptFor(q: QuestionId): string {
    if (q === 'title') return "What's this task?";
    if (q === 'folder') return 'Which folder?';
    if (q === 'project') return 'Which project?';
    if (q === 'who') return 'Who runs this?';
    if (q === 'when') return executor === 'claude' ? 'When should it run?' : 'When is it due?';
    if (q === 'status') return "What's the status?";
    // fm-m2s4 (S5) — TypeBuild reframes "start" as "defer until".
    if (q === 'start') return isTypebuild ? 'Defer until?' : 'When can it start?';
    if (q === 'priority') return 'Priority?';
    if (q === 'agent') return 'Which agent?';
    if (q === 'pin') return 'Pin this task?';
    if (q === 'notes') {
      return executor === 'claude'
        ? "What should the agent do? (this becomes the prompt)"
        : 'Any notes?';
    }
    // task-2fd63b922beb (R2)
    if (q === 'template') return 'Task or chained task?';
    if (q === 'chain') return 'Define the chain';
    if (q === 'fields') return 'Inputs & outputs? (optional)';
    if (q === 'outputs') return 'What the agent will produce';
    if (isFieldQuestion(q)) {
      const entry = fieldEntryFor(q);
      return entry?.field.label ?? '';
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
  // task-2d96db620f6b / task-aa513e612954 — assign the shared active-section ref
  // to whichever section is currently active (so we can scroll it to top and the
  // label can anchor to it). Returns undefined for inactive sections.
  function sectionRefFor(id: QuestionId) {
    return isActiveSection(id) ? activeSectionRef : undefined;
  }
  // task-aa513e612954 — a clear, persistent label for the focused field, shown
  // top-left of its active body so the user always knows what they're editing.
  // Title is the headline (no label); the rest reuse labelFor's vocabulary,
  // surfaced as a readable field name.
  function fieldLabelFor(id: QuestionId): string | null {
    if (id === 'title') return null;
    if (id === 'who') return 'Who runs this';
    if (id === 'start') return isTypebuild ? 'Defer until' : 'Start date';
    if (id === 'when') return executor === 'claude' ? 'When it runs' : 'Due date';
    // task-04ea172532c0 — grouped/labeled by owning task-def, e.g. "Intake · Customer".
    if (isFieldQuestion(id)) return labelFor(id);
    const short = labelFor(id);
    return short ? short.charAt(0).toUpperCase() + short.slice(1) : null;
  }
  // The top-left field label element for an active section.
  function FieldLabel({ id }: { id: QuestionId }) {
    const text = fieldLabelFor(id);
    if (!text) return null;
    return <div className="composer__field-label">{text}</div>;
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

  // task-24ea35660cd0 — in CREATE mode, renderInert only shows a question's
  // ANSWER once activeIdx has stepped past it (see isPast above); a question
  // not yet reached always shows its generic prompt, no matter what the
  // underlying state is. So a copilot-driven field set is invisible until the
  // human manually walks the wizard there. Advance the pointer (never back it
  // up) whenever copilot sets a field, so the change is visible immediately —
  // the same effect confirming that field via keyboard would have. No-op in
  // edit mode's rendering (which always shows answers), but harmless there.
  function advanceTo(q: QuestionId) {
    setActiveIdx((i) => Math.max(i, QUESTIONS.indexOf(q) + 1));
  }

  return (
    <div
      className={'composer-pane' + (props.embedded ? ' composer-pane--embedded' : '')}
      data-state={state}
    >
      {copilotEnabled && (
        <FormCopilotBridge
          fields={{
            mode: props.mode,
            title,
            notes: notes || undefined,
            projectId: projectId || undefined,
            projectName: attachedProject?.name,
            status,
            priority: priority || undefined,
            agentId: agentId || undefined,
            agentName: agents.find((a) => a.id === agentId)?.name,
            folder: isTypebuild ? undefined : folder || undefined,
          }}
          options={{
            isTypebuild,
            projects: projects.map((p) => ({ value: p.id, label: p.name, hint: p.description ?? undefined })),
            agents: AGENT_OPTIONS,
            statuses: STATUS_OPTIONS.map((s) => ({ value: s.id, label: s.label, hint: s.hint })),
            priorities: PRIORITY_OPTIONS,
          }}
          setters={{
            setTitle: (v) => { setTitle(v); advanceTo('title'); },
            setNotes: (v) => { setNotes(v); advanceTo('notes'); },
            setProjectId: (v) => { setProjectId(v); setProjectTouched(true); advanceTo('project'); },
            setStatus: (v) => { setStatus(v); advanceTo('status'); },
            setPriority: (v) => { setPriority(v); advanceTo('priority'); },
            setAgentId: (v) => { setAgentId(v); advanceTo('agent'); },
          }}
          submit={save}
          cancel={() => void exit()}
        />
      )}
      <div
        className="composer"
        role="region"
        aria-label={props.embedded ? 'Task details' : undefined}
        aria-labelledby={props.embedded ? undefined : 'composer-title'}
        ref={sectionRef}
        tabIndex={-1}
      >
        <header className="composer__header">
          {!props.embedded && (
            <div className="composer__crumb" id="composer-title">
              {props.mode === 'edit' ? 'Edit task' : 'New task'}
            </div>
          )}
          {/* fm-m2s4 (S5) — save-target picker. Shown for a fresh create with
              more than one target (editing is pinned to the task's own source).
              TypeBuild is offered + defaulted when signed in (see `targets`);
              signed out, only local is creatable so the picker is hidden. */}
          {props.mode === 'create' && targets.length > 1 && (
            <div className="composer__target" role="group" aria-label="Save to">
              <span className="composer__target-label">Save to</span>
              {targets.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={
                    'composer__target-btn' +
                    (target === s.id ? ' composer__target-btn--active' : '')
                  }
                  aria-pressed={target === s.id}
                  onClick={() => {
                    if (target === s.id) return;
                    setTarget(s.id);
                    setTargetTouched(true);
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </header>

        <main className="composer__main">
          {/* Q1 — Title */}
          <section
            ref={sectionRefFor('title')}
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

          {/* Q2 — Folder. fm-m2s4 (S5) — hidden for the TypeBuild target:
              folder anchoring doesn't apply there (it's also absent from
              QUESTIONS_TYPEBUILD, so keyboard navigation skips it). */}
          {!isTypebuild && (
          <section
            ref={sectionRefFor('folder')}
            className={sectionClasses('folder')}
            onClick={() => setActiveIdx(QUESTIONS.indexOf('folder'))}
          >
            {isActiveSection('folder') ? (
              <div className="composer__q-active-body">
                <FieldLabel id="folder" />
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
          )}

          {/* Project — task-ab1d7955e23f. TypeBuild only. "None" + one option
              per project. Opening from a folder auto-attaches that folder's
              owning project (surfaced as a chip so it's visible, not magic);
              the user can override or pick None. Arrow + Enter to pick. */}
          {isTypebuild && (
            <section
              ref={sectionRefFor('project')}
              className={sectionClasses('project')}
              onClick={() => setActiveIdx(QUESTIONS.indexOf('project'))}
            >
              {isActiveSection('project') ? (
                <div className="composer__q-active-body">
                  <FieldLabel id="project" />
                  <div className="composer__q-prompt">{promptFor('project')}</div>
                  {attachedProject && (
                    <div className="composer__attached" role="status">
                      <span className="composer__attached-chip">
                        {attachedProject.name}
                      </span>
                      <span className="composer__attached-note">
                        {projectAutoAttached
                          ? `auto-attached from ${prettyFolder(props.mode === 'create' ? props.defaultFolder : '', home)}`
                          : 'attached'}
                      </span>
                    </div>
                  )}
                  {/* task-201f5e3cde57 — short list: current project (focused) +
                      top-3 others + None + "Other…". */}
                  <ul className="composer__options" role="listbox">
                    {PROJECT_OPTIONS.map((o, i) => (
                      <li key={o.value || 'none'}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={i === projectHighlight}
                          className={
                            'composer__option' +
                            (i === projectHighlight ? ' composer__option--active' : '') +
                            (o.value === PROJECT_OTHER ? ' composer__option--other' : '')
                          }
                          onMouseEnter={() => setProjectHighlight(i)}
                          onClick={(e) => {
                            e.stopPropagation();
                            chooseProject(i);
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
                  {/* task-201f5e3cde57 — "Other…" type-ahead over ALL projects,
                      ranked by active-task count. ↑/↓ move, Enter picks, Esc
                      closes back to the short list. */}
                  {projectSearchOpen && (
                    <div
                      className="composer__project-search"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        ref={projectSearchRef}
                        className="composer__path-input"
                        type="text"
                        placeholder="Search all projects…"
                        value={projectQuery}
                        onChange={(e) => {
                          setProjectQuery(e.target.value);
                          setProjectSearchHighlight(0);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            setProjectSearchHighlight((i) =>
                              Math.min(projectSearchResults.length - 1, i + 1),
                            );
                          } else if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            setProjectSearchHighlight((i) => Math.max(0, i - 1));
                          } else if (e.key === 'Enter') {
                            e.preventDefault();
                            e.stopPropagation();
                            chooseProjectFromSearch(projectSearchHighlight);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            e.stopPropagation();
                            setProjectSearchOpen(false);
                            setProjectQuery('');
                            sectionRef.current?.focus();
                          }
                        }}
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <ul className="composer__options composer__project-search-list" role="listbox">
                        {projectSearchResults.length === 0 ? (
                          <li className="composer__project-search-empty">No matching projects</li>
                        ) : (
                          projectSearchResults.map((o, i) => (
                            <li key={o.value}>
                              <button
                                type="button"
                                role="option"
                                aria-selected={i === projectSearchHighlight}
                                className={
                                  'composer__option' +
                                  (i === projectSearchHighlight ? ' composer__option--active' : '')
                                }
                                onMouseEnter={() => setProjectSearchHighlight(i)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  chooseProjectFromSearch(i);
                                }}
                              >
                                <span className="composer__option-key" aria-hidden="true" />
                                <span className="composer__option-label">{o.label}</span>
                                {o.hint && (
                                  <span className="composer__option-hint">{o.hint}</span>
                                )}
                              </button>
                            </li>
                          ))
                        )}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                renderInert('project')
              )}
            </section>
          )}

          {/* Task-kind pick — task-2fd63b922beb (R2). Only for a fresh
              TypeBuild create. "Task" is the default and reproduces today's
              flow exactly — NON-REGRESSION. */}
          {hasChainOption && (
            <section
              ref={sectionRefFor('template')}
              className={sectionClasses('template')}
              onClick={() => setActiveIdx(QUESTIONS.indexOf('template'))}
            >
              {isActiveSection('template') ? (
                <div className="composer__q-active-body">
                  <FieldLabel id="template" />
                  <div className="composer__q-prompt">{promptFor('template')}</div>
                  <ul className="composer__options" role="listbox">
                    {TEMPLATE_OPTIONS.map((o, i) => (
                      <li key={o.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={i === templateHighlight}
                          className={
                            'composer__option' +
                            (i === templateHighlight ? ' composer__option--active' : '')
                          }
                          onMouseEnter={() => setTemplateHighlight(i)}
                          onClick={(e) => {
                            e.stopPropagation();
                            chooseTemplate(i);
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
                renderInert('template')
              )}
            </section>
          )}

          {/* Chain builder — task-2fd63b922beb (R2). A structured sub-form
              (not the digit-select option pattern): add/remove/reorder
              steps, per-step name/notes/inputs/outputs/neededWhen, plus
              "start from an existing chained task". Only rendered once
              "Chained task" is chosen. */}
          {hasChainOption && templateChoice === 'chain' && (
            <section
              ref={sectionRefFor('chain')}
              className={sectionClasses('chain')}
              onClick={() => setActiveIdx(QUESTIONS.indexOf('chain'))}
            >
              {isActiveSection('chain') ? (
                <div className="composer__q-active-body">
                  <FieldLabel id="chain" />
                  <div className="composer__q-prompt">{promptFor('chain')}</div>
                  {priorChains.length > 0 && (
                    <div className="composer__chain-copyfrom">
                      <span className="composer__chain-copyfrom-label">Start from an existing chained task:</span>
                      <select
                        className="composer__chain-copyfrom-select"
                        defaultValue=""
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const idx = Number(e.target.value);
                          e.target.value = '';
                          const entry = priorChains[idx];
                          if (entry) copyChainFrom(entry);
                        }}
                      >
                        <option value="" disabled>
                          Copy from…
                        </option>
                        {priorChains.map((c, i) => (
                          <option key={c.taskId} value={i}>
                            {c.name} — {c.defs.length} step{c.defs.length === 1 ? '' : 's'}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <ul className="composer__chain-steps">
                    {chainDefs.map((def, defIdx) => (
                      <li key={def.id} className="composer__chain-step">
                        <div className="composer__chain-step-head">
                          <span className="composer__chain-step-num">{defIdx + 1}</span>
                          <input
                            className="composer__chain-step-name"
                            type="text"
                            placeholder="Step name"
                            value={def.name}
                            onChange={(e) => updateChainDef(defIdx, { name: e.target.value })}
                            spellCheck={false}
                          />
                          <div className="composer__chain-step-actions">
                            <button
                              type="button"
                              className="composer__chain-icon-btn"
                              title="Move up"
                              disabled={defIdx === 0}
                              onClick={(e) => {
                                e.stopPropagation();
                                moveChainDef(defIdx, -1);
                              }}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="composer__chain-icon-btn"
                              title="Move down"
                              disabled={defIdx === chainDefs.length - 1}
                              onClick={(e) => {
                                e.stopPropagation();
                                moveChainDef(defIdx, 1);
                              }}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="composer__chain-icon-btn composer__chain-icon-btn--danger"
                              title="Remove step"
                              disabled={chainDefs.length <= 1}
                              onClick={(e) => {
                                e.stopPropagation();
                                removeChainDef(defIdx);
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                        <textarea
                          className="composer__chain-step-notes"
                          placeholder="Notes for this step (agent prompt)…"
                          rows={2}
                          value={def.notes ?? ''}
                          onChange={(e) => updateChainDef(defIdx, { notes: e.target.value })}
                        />

                        {/* task-2fd63b922beb correction (Part A.4) — shared
                            field-list editors (same components the plain Task
                            form uses). */}
                        <FieldListEditor
                          kind="inputs"
                          fields={def.inputs ?? []}
                          onAdd={() => addChainField(defIdx, 'inputs')}
                          onUpdate={(fi, patch) => updateChainField(defIdx, 'inputs', fi, patch)}
                          onRemove={(fi) => removeChainField(defIdx, 'inputs', fi)}
                        />

                        <FieldListEditor
                          kind="outputs"
                          fields={def.outputs ?? []}
                          onAdd={() => addChainField(defIdx, 'outputs')}
                          onUpdate={(fi, patch) => updateChainField(defIdx, 'outputs', fi, patch)}
                          onRemove={(fi) => removeChainField(defIdx, 'outputs', fi)}
                        />

                        {defIdx > 0 && (
                          <div className="composer__chain-neededwhen">
                            <label className="composer__chain-neededwhen-toggle">
                              <input
                                type="checkbox"
                                checked={!!def.neededWhen}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    const first = upstreamOutputRefs(defIdx)[0];
                                    setChainNeededWhen(defIdx, {
                                      ref: first?.ref ?? '',
                                      op: '==',
                                      value: first?.field.type === 'bool' ? false : '',
                                    });
                                  } else {
                                    setChainNeededWhen(defIdx, null);
                                  }
                                }}
                              />
                              only needed when…
                            </label>
                            {def.neededWhen && (() => {
                              const candidates = upstreamOutputRefs(defIdx);
                              const refField = candidates.find((r) => r.ref === def.neededWhen!.ref)?.field;
                              return (
                                <div className="composer__chain-neededwhen-row">
                                  <select
                                    className="composer__chain-field-type"
                                    value={def.neededWhen.ref}
                                    onChange={(e) => {
                                      // task-f8ae99553691: switching the referenced
                                      // output resets `value` — a stale value typed
                                      // for a different field's type (e.g. a number
                                      // typed while pointed at a bool field) must not
                                      // silently carry over.
                                      const nextField = candidates.find((r) => r.ref === e.target.value)?.field;
                                      setChainNeededWhen(defIdx, {
                                        ...def.neededWhen!,
                                        ref: e.target.value,
                                        value: nextField?.type === 'bool' ? false : '',
                                      });
                                    }}
                                  >
                                    {candidates.map((r) => (
                                      <option key={r.ref} value={r.ref}>
                                        {r.label}
                                      </option>
                                    ))}
                                  </select>
                                  <select
                                    className="composer__chain-field-type"
                                    value={def.neededWhen.op}
                                    onChange={(e) =>
                                      setChainNeededWhen(defIdx, {
                                        ...def.neededWhen!,
                                        op: e.target.value as TaskDefCondition['op'],
                                      })
                                    }
                                  >
                                    <option value="==">==</option>
                                    <option value="!=">!=</option>
                                    <option value="<">&lt;</option>
                                    <option value=">">&gt;</option>
                                  </select>
                                  {/* task-f8ae99553691: the value input is
                                      constrained by the referenced output field's
                                      TYPE — bool renders as a Yes/No toggle STORED
                                      as a real boolean (never the string "Yes"),
                                      number as a numeric input, select as a
                                      dropdown of that field's own options, and
                                      free text otherwise. */}
                                  {refField?.type === 'bool' ? (
                                    <select
                                      className="composer__chain-field-type"
                                      value={def.neededWhen.value === true ? 'true' : 'false'}
                                      onChange={(e) =>
                                        setChainNeededWhen(defIdx, {
                                          ...def.neededWhen!,
                                          value: e.target.value === 'true',
                                        })
                                      }
                                    >
                                      <option value="true">Yes</option>
                                      <option value="false">No</option>
                                    </select>
                                  ) : refField?.type === 'select' ? (
                                    <select
                                      className="composer__chain-field-type"
                                      value={String(def.neededWhen.value ?? '')}
                                      onChange={(e) =>
                                        setChainNeededWhen(defIdx, { ...def.neededWhen!, value: e.target.value })
                                      }
                                    >
                                      <option value="" disabled>
                                        choose…
                                      </option>
                                      {(refField.options ?? []).map((o) => (
                                        <option key={o} value={o}>
                                          {o}
                                        </option>
                                      ))}
                                    </select>
                                  ) : refField?.type === 'number' ? (
                                    <input
                                      className="composer__chain-field-label"
                                      type="number"
                                      placeholder="value"
                                      value={String(def.neededWhen.value ?? '')}
                                      onChange={(e) =>
                                        setChainNeededWhen(defIdx, {
                                          ...def.neededWhen!,
                                          value: e.target.value === '' ? '' : Number(e.target.value),
                                        })
                                      }
                                    />
                                  ) : (
                                    <input
                                      className="composer__chain-field-label"
                                      type="text"
                                      placeholder="value"
                                      value={String(def.neededWhen.value ?? '')}
                                      onChange={(e) =>
                                        setChainNeededWhen(defIdx, { ...def.neededWhen!, value: e.target.value })
                                      }
                                    />
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="composer__chain-footer">
                    <button
                      type="button"
                      className="composer__chain-add-step-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        addChainDef();
                      }}
                    >
                      + add step
                    </button>
                    <button
                      type="button"
                      className="composer__chain-continue-btn"
                      disabled={!chainDefsValid}
                      onClick={(e) => {
                        e.stopPropagation();
                        tryAdvanceChain();
                      }}
                    >
                      Continue →
                    </button>
                  </div>
                </div>
              ) : (
                renderInert('chain')
              )}
            </section>
          )}

          {/* task-2fd63b922beb correction — the aggregated field-value
              questions and the read-only outputs summary now live AFTER 'notes'
              (see below), so a plain task's optional fields read in walk order.
              In the minimal chain flow the who/notes/etc questions between are
              simply not rendered, so those steps still follow the chain
              directly. */}

          {/* Q3 — Who. task-2fd63b922beb correction (Part B): dropped entirely
              from the minimal chained flow — a chain is a thin container, not a
              task, so it doesn't ask who/notes/when/etc. */}
          {!isMinimalChain && (
          <section
            ref={sectionRefFor('who')}
            className={sectionClasses('who')}
            onClick={() => setActiveIdx(QUESTIONS.indexOf('who'))}
          >
            {isActiveSection('who') ? (
              <div className="composer__q-active-body">
                <FieldLabel id="who" />
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
          )}

          {/* Notes — sits right after Who: what / where / who / notes are
              the fields that matter; scheduling lives below. Dropped from the
              minimal chained flow (each step carries its own notes). */}
          {!isMinimalChain && (
          <section
            ref={sectionRefFor('notes')}
            className={sectionClasses('notes')}
            onClick={() => {
              setActiveIdx(QUESTIONS.indexOf('notes'));
              setTimeout(() => notesRef.current?.focus(), 0);
            }}
          >
            {isActiveSection('notes') ? (
              <div className="composer__q-active-body">
                <FieldLabel id="notes" />
                <div className="composer__q-prompt">{promptFor('notes')}</div>
                <textarea
                  ref={notesRef}
                  className="composer__notes-input"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onKeyDown={(e) => {
                    // Plain Enter inserts a newline (default — leave it).
                    // ⌘/Ctrl+Enter inside notes advances to the next field
                    // (Start) rather than submitting; stop the event so the
                    // window-level handler doesn't fire save().
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      e.stopPropagation();
                      notesRef.current?.blur();
                      setStartHighlight(
                        START_OPTIONS.findIndex((s) => s.id === startId),
                      );
                      goNext();
                    }
                  }}
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
                    Sent to Claude as the task’s context — TypeBuild wraps the title, folder, and due date around what you write here.
                  </div>
                )}
              </div>
            ) : (
              renderInert('notes')
            )}
          </section>
          )}

          {/* Plain-task fields — task-2fd63b922beb correction (Part A). The
              TASK form owns its OWN optional input/output fields (single def,
              id 'task'); no neededWhen (chain-only). Same shared editors as the
              chain builder. Only for a plain (non-chained) TypeBuild create;
              empty = a no-op, byte-identical to today (NON-REGRESSION). */}
          {hasChainOption && templateChoice === 'blank' && (
            <section
              ref={sectionRefFor('fields')}
              className={sectionClasses('fields')}
              onClick={() => setActiveIdx(QUESTIONS.indexOf('fields'))}
            >
              {isActiveSection('fields') ? (
                <div className="composer__q-active-body">
                  <FieldLabel id="fields" />
                  <div className="composer__q-prompt">{promptFor('fields')}</div>
                  <div className="composer__task-fields">
                    <FieldListEditor
                      kind="inputs"
                      fields={taskInputs}
                      onAdd={() => addTaskField('inputs')}
                      onUpdate={(fi, patch) => updateTaskField('inputs', fi, patch)}
                      onRemove={(fi) => removeTaskField('inputs', fi)}
                    />
                    <FieldListEditor
                      kind="outputs"
                      fields={taskOutputs}
                      onAdd={() => addTaskField('outputs')}
                      onUpdate={(fi, patch) => updateTaskField('outputs', fi, patch)}
                      onRemove={(fi) => removeTaskField('outputs', fi)}
                    />
                    <div className="composer__chain-footer">
                      <span />
                      <button
                        type="button"
                        className="composer__chain-continue-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          goNext();
                        }}
                      >
                        Continue →
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                renderInert('fields')
              )}
            </section>
          )}

          {/* Aggregated field-VALUE questions — task-2fd63b922beb. One question
              per input field of whichever defs drive the flow (the chain's, or
              the plain task's single def), grouped/labeled by owning def
              ("Intake · Customer" / "Task · Customer"). text/number/date are
              free entry; select/bool are option questions. Empty when no inputs
              are defined. */}
          {hasChainOption && templateFieldEntries.map(({ taskDef, field }) => {
            const ref = fieldRef(taskDef.id, field.key);
            const qid = fieldQId(taskDef.id, field.key);
            const optionType = isFieldOptionType(field);
            const opts = optionType ? fieldOptionList(field) : [];
            const highlight = templateFieldHighlight[ref] ?? 0;
            const value = templateValues[ref] ?? '';
            return (
              <section
                key={qid}
                ref={sectionRefFor(qid)}
                className={sectionClasses(qid)}
                onClick={() => setActiveIdx(QUESTIONS.indexOf(qid))}
              >
                {isActiveSection(qid) ? (
                  <div className="composer__q-active-body">
                    <FieldLabel id={qid} />
                    <div className="composer__q-prompt">{promptFor(qid)}</div>
                    {optionType ? (
                      <ul className="composer__options" role="listbox">
                        {opts.map((o, i) => (
                          <li key={o.value}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={i === highlight}
                              className={
                                'composer__option' +
                                (i === highlight ? ' composer__option--active' : '')
                              }
                              onMouseEnter={() =>
                                setTemplateFieldHighlight((prev) => ({ ...prev, [ref]: i }))
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                chooseFieldOption(ref, opts, i);
                              }}
                            >
                              <kbd className="composer__option-key">{i + 1}</kbd>
                              <span className="composer__option-label">{o.label}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <input
                        ref={setFieldInputRef(ref)}
                        className="composer__path-input"
                        type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                        value={value}
                        onChange={(e) => setTemplateValue(ref, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                            e.preventDefault();
                            (e.target as HTMLInputElement).blur();
                            goNext();
                          }
                        }}
                        spellCheck={false}
                        autoComplete="off"
                      />
                    )}
                  </div>
                ) : (
                  renderInert(qid)
                )}
              </section>
            );
          })}

          {/* Outputs summary — task-2fd63b922beb. Read-only: per def, the output
              fields the agent will produce, `required` marked as evidence. Shows
              for any chain, or for a plain task that defined outputs. */}
          {showOutputsStep && (
            <section
              ref={sectionRefFor('outputs')}
              className={sectionClasses('outputs')}
              onClick={() => setActiveIdx(QUESTIONS.indexOf('outputs'))}
            >
              {isActiveSection('outputs') ? (
                <div className="composer__q-active-body">
                  <FieldLabel id="outputs" />
                  <div className="composer__q-prompt">{promptFor('outputs')}</div>
                  <ul className="composer__outputs-list">
                    {fieldsDefs.map((def) => (
                      <li key={def.id} className="composer__outputs-group">
                        <div className="composer__outputs-group-name">{def.name}</div>
                        {(def.outputs ?? []).length === 0 ? (
                          <div className="composer__outputs-empty">no outputs defined</div>
                        ) : (
                          <ul className="composer__outputs-fields">
                            {(def.outputs ?? []).map((f) => (
                              <li key={f.key}>
                                the agent will produce: {f.label}
                                {f.required && (
                                  <span className="composer__outputs-required"> — required (evidence)</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                renderInert('outputs')
              )}
            </section>
          )}

          {/* Start. Dropped from the minimal chained flow. */}
          {!isMinimalChain && (
          <section
            ref={sectionRefFor('start')}
            className={sectionClasses('start')}
            onClick={() => setActiveIdx(QUESTIONS.indexOf('start'))}
          >
            {isActiveSection('start') ? (
              <div className="composer__q-active-body">
                <FieldLabel id="start" />
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
          )}

          {/* When (due / schedule). Dropped from the minimal chained flow. */}
          {!isMinimalChain && (
          <section
            ref={sectionRefFor('when')}
            className={sectionClasses('when')}
            onClick={() => setActiveIdx(QUESTIONS.indexOf('when'))}
          >
            {isActiveSection('when') ? (
              <div className="composer__q-active-body">
                <FieldLabel id="when" />
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
                {executor === 'manual' && (
                  <div className="composer__quickpicks">
                    <span className="composer__quickpicks-label">quick due:</span>
                    {DUE_QUICK_PICKS.map((qp) => (
                      <button
                        key={qp.id}
                        type="button"
                        className="composer__quickpick"
                        title={`Due ${formatDateNice(qp.iso(todayISO()))}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          chooseDueQuickPick(qp);
                        }}
                      >
                        <kbd className="composer__option-key">{qp.key}</kbd>
                        <span className="composer__quickpick-label">{qp.label}</span>
                      </button>
                    ))}
                  </div>
                )}
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
          )}

          {/* Priority — fm-m2s4 (S5). TypeBuild only; a flat option list
              ("Unset" + 0–10). Sits between When and Status, mirroring the
              QUESTIONS_TYPEBUILD order. Arrow + Enter to pick (digits are
              ambiguous against the 0–10 labels). Dropped from the minimal
              chained flow (task-2fd63b922beb correction, Part B). */}
          {isTypebuild && !isMinimalChain && (
            <section
              ref={sectionRefFor('priority')}
              className={sectionClasses('priority')}
              onClick={() => setActiveIdx(QUESTIONS.indexOf('priority'))}
            >
              {isActiveSection('priority') ? (
                <div className="composer__q-active-body">
                  <FieldLabel id="priority" />
                  <div className="composer__q-prompt">{promptFor('priority')}</div>
                  <ul className="composer__options composer__options--wrap" role="listbox">
                    {PRIORITY_OPTIONS.map((o, i) => (
                      <li key={o.value || 'unset'}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={i === priorityHighlight}
                          className={
                            'composer__option composer__option--compact' +
                            (i === priorityHighlight ? ' composer__option--active' : '')
                          }
                          onMouseEnter={() => setPriorityHighlight(i)}
                          onClick={(e) => {
                            e.stopPropagation();
                            choosePriority(i);
                          }}
                        >
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
                renderInert('priority')
              )}
            </section>
          )}

          {/* Agent — task-896f3f7f5e75. TypeBuild only; a flat option list
              ("None" + one row per agent, each showing its launch_mode caption
              as the hint). Sits between Priority and Status, mirroring the
              QUESTIONS_TYPEBUILD order. Enter picks the highlight; digits 1..N
              pick (unambiguous names, unlike priority's 0–10). "None" clears the
              assignment; group-optional agents still list. Dropped from the
              minimal chained flow (task-2fd63b922beb correction, Part B). */}
          {isTypebuild && !isMinimalChain && (
            <section
              ref={sectionRefFor('agent')}
              className={sectionClasses('agent')}
              onClick={() => setActiveIdx(QUESTIONS.indexOf('agent'))}
            >
              {isActiveSection('agent') ? (
                <div className="composer__q-active-body">
                  <FieldLabel id="agent" />
                  <div className="composer__q-prompt">{promptFor('agent')}</div>
                  <ul className="composer__options composer__options--wrap" role="listbox">
                    {AGENT_OPTIONS.map((o, i) => (
                      <li key={o.value || 'none'}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={i === agentHighlight}
                          className={
                            'composer__option composer__option--compact' +
                            (i === agentHighlight ? ' composer__option--active' : '')
                          }
                          onMouseEnter={() => setAgentHighlight(i)}
                          onClick={(e) => {
                            e.stopPropagation();
                            chooseAgent(i);
                          }}
                        >
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
                renderInert('agent')
              )}
            </section>
          )}

          {/* Q5 — Status. Dropped from the minimal chained flow. */}
          {!isMinimalChain && (
          <section
            ref={sectionRefFor('status')}
            className={sectionClasses('status')}
            onClick={() => setActiveIdx(QUESTIONS.indexOf('status'))}
          >
            {isActiveSection('status') ? (
              <div className="composer__q-active-body">
                <FieldLabel id="status" />
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
          )}

          {/* Pin. Dropped from the minimal chained flow. */}
          {!isMinimalChain && (
          <section
            ref={sectionRefFor('pin')}
            className={sectionClasses('pin')}
            onClick={() => setActiveIdx(QUESTIONS.indexOf('pin'))}
          >
            {isActiveSection('pin') ? (
              <div className="composer__q-active-body">
                <FieldLabel id="pin" />
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
          )}

        </main>

        {/* fm-b5at.7 — agent flags. Only shown for Claude tasks; toggles
            map 1:1 to the task `flags` array. 'interactive' opens the run
            in a new tab with an embedded claude session instead of running
            headless. */}
        {executor === 'claude' && !created && !isMinimalChain && (
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
                disabled={busy || !title.trim() || noTarget}
                title={noTarget ? 'Sign in to TypeBuild to create a task' : undefined}
              >
                {busy
                  ? 'Saving…'
                  : noTarget
                    ? 'Sign in to TypeBuild'
                    : props.mode === 'edit'
                      ? 'Save changes'
                      : 'Create task'}
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
