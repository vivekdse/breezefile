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
// - A toggles the collapsible ADVANCED options section (task-f5a318566148);
//   its questions (priority, defer/start, agent, status, launch flags,
//   due/schedule, pin, working folder) are only walked into when expanded.
//   Launch flags are a multi-select option question — digits / Enter toggle a
//   flag on/off (they don't advance); ↓ off the last flag advances.
// - T toggles "Make this a template" (task-899af8b03aa6) — a MAIN-form yes/no
//   step whose declared input/output fields become the template's variables.
//   A template is auto-registered server-side on create-with-fields (no explicit
//   create API), so T is an intent+guarantee: ON requires ≥1 input on save; in
//   EDIT it reflects whether the task already backs a template.
// - Inputs and Outputs (a plain task's own optional fields) are two separate,
//   explained sections in the SAME walk (task-342f3e151d99 — see also
//   task-e085ebbdb23f for the shared field-VALUE renderer). i = add input,
//   o = add output (from THIS window handler, available anywhere in the
//   Inputs/Outputs region — no nested keydown handler, no stopPropagation).
//   Adding (or Enter-editing an existing row) opens a per-field SUB-WALK, one
//   question per step, in the SAME activeIdx cursor: key → label → type
//   (digits 1–5 pick text/number/date/select/bool) → options (select only) →
//   required (outputs only, yes/no). Enter accepts the current step and
//   advances (or commits the field, on the last step); ↑ steps back (or exits
//   the sub-walk on the first step); Esc cancels the in-progress field.
//   ⌘/Ctrl+⌫ on an existing row removes it.
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
// task-73f6304ffb94 — a template variable may bind a SavedQuery (`source`), so
// the New-from-Template fill walk offers the SAME live typeahead the task
// drawer does, instead of a bare text box. One widget, both surfaces.
import { SourceTypeahead } from './newhome/SourceTypeahead';
import type { ConnectionLookupRow, ConnectionRef, QueryRef } from '../copilot/savedQueries';
// task-8f27d842f14d — the Connection-form field-source snapshot: fan a picked
// row's bundle fields into `<fieldKey>.*` data-bag sibling keys (+
// provenance), and the delete-side helper that cleans up stale sibling keys
// on a re-pick/clear. Pure logic lives in fieldCatalog.mjs; see its comments
// for the exact key scheme.
import { connectionBundleKeys, snapshotConnectionRow } from './newhome/fieldCatalog.mjs';
import {
  type RecurrenceForm,
  buildCronFromForm,
  defaultRecurrenceForm,
} from '../recurrence';
import type { Agent, ChainDef, GroupMember, Project, Task, TaskCreate, TaskSourceInfo, TaskStatus, TaskUpdate } from '../types';
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
import type { TaskDef, TaskDefField } from './newhome/types';
// task-73f6304ffb94 — the source-aware key picker + source-binding badge, the
// ONE shared "+ input" affordance (also used by TemplateEditPanel).
// task-342f3e151d99 — FieldSourcePicker renders the INPUT source step: Custom
// first, top source fields, then a searchable browse-all drill-down. It
// lives here so both surfaces share ONE catalog fetch.
import { FieldSourcePicker, SourceBadge } from './newhome/FieldKeyPicker';
import { instantiateChain } from './newhome/newHomePrefs';
import {
  aggregateInputs,
  effectiveFieldKey,
  fieldRef,
  inferFieldsFromProse,
  fieldDraftSteps,
  nextFieldDraftStep,
  prevFieldDraftStep,
  templateFillEntries,
} from './newhome/taskSchema.mjs';
// task-e112d60a3b7c — the first-class Template type the "New from Template"
// picker lists (server-backed via fm.typebuild.templates.*).
import type { Template } from '../bridge';
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
      /** The active GROUP scope (opaque id) — the create lands in this group so
       *  a new task joins the currently-selected team. Set by New Home from its
       *  group picker; omitted when there's no group scope. Rides the create as
       *  `groupId` (TaskCreate → server `group_id`). */
      groupId?: string;
      /** Prefill from a caller that already gathered title/notes elsewhere
       *  (e.g. the copilot create_task action) — seeds the fields, the human
       *  still reviews/edits/submits through this same form. */
      initialTitle?: string;
      initialNotes?: string;
      /** task-fe8c822c3838 — copilot parity: when the copilot already
       *  parsed input/output intent out of the conversational prose (via
       *  inferFieldsFromProse, the SAME parser the composer's own
       *  "Structure these fields?" banner uses), pre-fill the plain task's
       *  field-definition step with them so the human doesn't have to
       *  re-type what they already said in chat. Still just a prefill — the
       *  human reviews/edits/removes through the normal fields step. */
      initialInputs?: TaskDefField[];
      initialOutputs?: TaskDefField[];
      /** Open directly as a CHAINED task (the "+ New Chained Task" entry
       *  point) — pre-picks the Task/Chained-task question so the chain
       *  builder is the next step. Same form either way; the user can still
       *  flip back to a plain task on that question.
       *
       *  task-257bb4870c6c — 'template' opens the "New from Template" entry
       *  point instead: a searchable picker over prior fielded tasks/chains,
       *  then ONLY their input VALUE questions (title prefilled, everything
       *  else inherited silently). See the templatePick* state below. */
      initialKind?: 'chain' | 'template';
      /** task-257bb4870c6c — copilot parity: pre-select a template by task id
       *  (skips step [1] SELECT TEMPLATE straight into title/values) when the
       *  caller already resolved which template to use (e.g. a fuzzy title
       *  match from a copilot utterance). Ignored unless initialKind is
       *  'template'. */
      templateTaskId?: string;
      /** task-e41ce7bf62fb — New Home roster's per-section "+ New run": the
       *  server doesn't emit template_id on tasks yet (see the edit-mode
       *  reflection above and rosterGroups.mjs), so the roster only knows the
       *  section's template NAME, not its first-class Template.id. Same
       *  identity signal listTemplates keys on elsewhere — matched against
       *  the loaded candidate list by exact name once it resolves. Ignored
       *  unless initialKind is 'template'; templateTaskId (an id match) wins
       *  if both are somehow set. */
      initialTemplateName?: string;
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
  | 'chain'
  // task-2fd63b922beb correction — the PLAIN task form's own optional
  // input/output fields (single def, id 'task'). No neededWhen (chain-only).
  | 'fields'
  | 'outputs'
  | 'who'
  | 'when'
  | 'status'
  // task-f5a318566148 — agent launch flags as a multi-select option question
  // (Claude tasks only), inside the ADVANCED block.
  | 'flags'
  | 'start'
  | 'priority'
  | 'agent'
  | 'pin'
  // task-899af8b03aa6 — the MAIN-form "Make this a template" yes/no step: the
  // declared input/output fields become the reusable template's variables.
  | 'template'
  | 'notes'
  | `field:${string}`
  // task-342f3e151d99 — the field-DEFINITION walk. `field-row:<kind>:<idx>`
  // reviews an already-defined input/output (Enter steps into its sub-walk);
  // 'field-draft' is the single slot for the field currently being added or
  // edited, one question per step (see FieldDraft below).
  | `field-row:${string}`
  | 'field-draft';
// Order is the keyboard ↓ flow. Name, folder, and notes come first — they
// are the only fields that actually matter for most tasks, and a task can
// be created the moment they're filled (everything below is optional and
// skippable). Start sits right before When so the two time questions read
// as a pair — "when can it start? / when is it due?".
// fm-m2s4 (S5) — `folder` is dropped and `priority` inserted for the TypeBuild
// target (folder anchoring doesn't apply there; priority does). The active
// question list is computed per-target via composerQuestions() so keyboard
// navigation, activeIdx, and the past/future render all stay consistent.
// task-f5a318566148 — the composer form is split into an always-visible MAIN
// walk and a collapsible ADVANCED block (collapsed by default) that is only
// walked into when expanded. MAIN holds the questions that matter for most
// tasks (what is it, who runs it, its fields, its body); everything else —
// priority, defer/start, agent, status, launch flags, due/schedule, pin and
// (local) working folder — lives under ADVANCED. composerQuestions() returns
// the two ordered lists per target; QUESTIONS concatenates them when Advanced
// is expanded (see the mainQuestions/advancedQuestions/QUESTIONS memos).
// task-ab1d7955e23f — `project` sits right after the title for the TypeBuild
// target: a task's project is teaching context (it carries the project's
// folders + instructions), so it reads as part of "what is this", before who
// runs it.
type ComposerQuestionSplit = { main: QuestionId[]; advanced: QuestionId[] };
const QUESTIONS_LOCAL: ComposerQuestionSplit = {
  main: ['title', 'who', 'notes'],
  advanced: ['start', 'status', 'flags', 'when', 'pin', 'folder'],
};
const QUESTIONS_TYPEBUILD: ComposerQuestionSplit = {
  main: ['title', 'project', 'who', 'notes'],
  advanced: ['priority', 'start', 'agent', 'status', 'flags', 'when', 'pin'],
};
function composerQuestions(target: string): ComposerQuestionSplit {
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

// task-fd1be6f6b22d — "Who runs this?" is now the UNION of {every human in the
// signed-in user's TypeBuild groups} + {Claude Code}, replacing the old binary
// Manual | Claude Code. A 'human' pick makes a MANUAL task assigned to them
// (executor 'manual', assigned_to = email); 'claude' is the existing auto path
// (executor 'claude'); 'manual' is a fallback (no members / non-TypeBuild
// target) that preserves today's unassigned-manual behavior.
type WhoOption =
  | { kind: 'human'; email: string; label: string; hint?: string }
  | { kind: 'claude'; label: string; hint?: string }
  | { kind: 'manual'; label: string; hint?: string };
const WHO_CLAUDE: WhoOption = { kind: 'claude', label: 'Claude Code', hint: 'an AI agent does it' };
const WHO_MANUAL_FALLBACK: WhoOption = { kind: 'manual', label: 'Manual', hint: 'you do it' };

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

// task-899af8b03aa6 — the "Make this a template" yes/no options (same shape as
// PIN_OPTIONS). "Yes" declares the task's input/output fields as reusable
// template variables; the server auto-registers the template on create-with-
// fields, so this is intent (+ a ≥1-input guarantee on save), not a create call.
const TEMPLATE_OPTIONS: { id: 'no' | 'yes'; label: string; hint?: string }[] = [
  { id: 'no', label: 'Just this task', hint: 'a one-off, not reusable' },
  { id: 'yes', label: 'Make this a template', hint: 'reuse it via New from Template' },
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

// task-342f3e151d99 — synthetic QuestionIds for the field-DEFINITION walk
// (distinct from the field-VALUE walk above). `field-row:<kind>:<idx>` reviews
// one already-defined field; parseFieldRowQId reads it back. Both pure.
function fieldRowQId(kind: FieldKind, idx: number): QuestionId {
  return `field-row:${kind}:${idx}` as QuestionId;
}
function isFieldRowQuestion(q: QuestionId): q is `field-row:${string}` {
  return q.startsWith('field-row:');
}
function parseFieldRowQId(q: QuestionId): { kind: FieldKind; idx: number } | null {
  if (!isFieldRowQuestion(q)) return null;
  const rest = q.slice('field-row:'.length);
  const sep = rest.indexOf(':');
  if (sep < 0) return null;
  const kind = rest.slice(0, sep);
  const idx = parseInt(rest.slice(sep + 1), 10);
  if ((kind !== 'inputs' && kind !== 'outputs') || Number.isNaN(idx)) return null;
  return { kind, idx };
}

// task-342f3e151d99 — the field currently being ADDED or EDITED. `editIdx`
// is null for a brand-new field (committed by APPENDING to the list) or the
// row index being edited (committed by REPLACING it in place). `field` is the
// in-progress draft; `step` is the current sub-walk question. The draft is
// held entirely in memory and only written into taskInputs/taskOutputs on
// commit — so Escape mid-walk (task-342f3e151d99's "cancel removes the
// half-built row") is just discarding this state; nothing was ever inserted.
type FieldDraftStepId = 'source' | 'key' | 'label' | 'type' | 'options' | 'required';
type FieldDraft = {
  kind: FieldKind;
  editIdx: number | null;
  field: TaskDefField;
  step: FieldDraftStepId;
};

// task-330b2e31e9d3 — the field-definition types, in the order digit shortcuts
// 1–5 pick them (mirrors how the value option-lists are digit-picked). Kept at
// module scope so both the row editor and the keyboard handler agree.
type FieldKind = 'inputs' | 'outputs';
const FIELD_TYPE_OPTIONS: TaskDefField['type'][] = [
  'text', 'number', 'date', 'select', 'bool',
];

// task-342f3e151d99 — one already-DEFINED field, reviewed as a single line in
// the main question walk (replaces the old grid row). It carries no option
// list of its own — Enter here means "step into this field's sub-walk to
// edit it", not "pick option N" (see the composer header's keyboard grammar
// table). `showRequired` = this is an OUTPUT row, whose `required` flag marks
// the field as the step's evidence.
function FieldRowSummary({
  field,
  showRequired,
  active,
  onRemove,
  onClearSource,
}: {
  field: TaskDefField;
  showRequired: boolean;
  active: boolean;
  onRemove: () => void;
  onClearSource: () => void;
}) {
  const typeLabel =
    field.type === 'select' && (field.options ?? []).length > 0
      ? `select (${(field.options ?? []).join(', ')})`
      : field.type;
  return (
    <div className={'composer__field-row' + (active ? ' composer__field-row--active' : '')}>
      {/* task-73f6304ffb94 — an INPUT field bound to a SavedQuery shows a badge
          with the query name + an ✕ to unbind. */}
      {field.source && <SourceBadge source={field.source} onClear={onClearSource} />}
      <span className="composer__field-row-key">{field.key || '(no key)'}</span>
      <span className="composer__field-row-label">{field.label || '—'}</span>
      <span className="composer__field-row-type">{typeLabel}</span>
      {showRequired && field.required && (
        <span className="composer__field-row-required">evidence</span>
      )}
      {active && <span className="composer__field-row-hint">↵ edit</span>}
      <button
        type="button"
        className="composer__chain-icon-btn composer__chain-icon-btn--danger"
        title={showRequired ? 'Remove output (⌘/Ctrl+⌫)' : 'Remove input (⌘/Ctrl+⌫)'}
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
  const questionSplit = useMemo(() => composerQuestions(target), [target]);

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
  // task-fd1be6f6b22d — the HUMAN assignee (email/principal) when "Who runs
  // this?" picks a group member; '' = unassigned / Claude Code. Edits prefill
  // from the task's assigned_to; a Claude pick clears it. Rides the create as
  // TaskCreate.assignedTo and the TypeBuild edit as the `assigned_to` patch.
  const [assignedTo, setAssignedTo] = useState<string>(initial?.assignedTo ?? '');
  // The signed-in user's TypeBuild group members (self + everyone in their
  // groups). Loaded like `agents`; empty until loaded / on failure → the picker
  // falls back to plain Manual/Claude (NON-REGRESSION).
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  // Once the user explicitly picks "who runs this" we stop auto-defaulting it
  // (mirrors targetTouched). Edits start pinned to the saved value.
  const [executorTouched, setExecutorTouched] = useState(props.mode === 'edit');

  // task-fd1be6f6b22d — the "Who runs this?" option list: one row per group
  // member human (label = display name or email) then Claude Code. Only the
  // TypeBuild target lists members (assignment is a TypeBuild concept); the
  // local target — or a member list that hasn't loaded / failed — falls back to
  // the plain Manual + Claude Code pair so today's local behavior is unchanged.
  const whoOptions = useMemo<WhoOption[]>(() => {
    if (isTypebuild && groupMembers.length > 0) {
      const humans: WhoOption[] = groupMembers.map((m) => {
        const label = m.displayName?.trim() || m.principal;
        return {
          kind: 'human',
          email: m.principal,
          label,
          hint: label !== m.principal ? m.principal : 'assign to them',
        };
      });
      return [...humans, WHO_CLAUDE];
    }
    return [WHO_MANUAL_FALLBACK, WHO_CLAUDE];
  }, [isTypebuild, groupMembers]);
  // The index of the option matching the current selection (executor +
  // assignee), used to sync the keyboard highlight on entry and prefill on edit.
  function whoSelectionIndex(): number {
    if (executor === 'claude') {
      const i = whoOptions.findIndex((o) => o.kind === 'claude');
      return i >= 0 ? i : 0;
    }
    if (assignedTo) {
      const i = whoOptions.findIndex((o) => o.kind === 'human' && o.email === assignedTo);
      if (i >= 0) return i;
    }
    const i = whoOptions.findIndex((o) => o.kind !== 'claude');
    return i >= 0 ? i : 0;
  }
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

  // task-0d63c7b0ebdb — CREATE & FILL NOW escape hatch. Creation DEFINES input
  // fields but never asks for their VALUES (values belong to the from-template
  // flow and the drawer's Inputs editor). As a convenience, after a plain
  // create that DEFINED >=1 input field the success flash offers "Press F to
  // fill inputs now"; F enters a values-only walk over just those fields and
  // writes them through the SAME data-bag path the drawer uses
  // (fm.typebuild.taskData.patch) — never a new write path. `createdTaskId` is
  // the just-created task the fill writes onto; `fillMode` gates the walk.
  const [fillMode, setFillMode] = useState(false);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);

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
  // task-fd1be6f6b22d — highlight is synced to the current selection whenever
  // the 'who' question activates (see the [active] effect), so a plain 0 init is
  // fine here; whoOptions may not even be built yet at first render.
  const [whoHighlight, setWhoHighlight] = useState(0);
  // Auto-default the executor by target: a TypeBuild task is run by the
  // default agent (Claude Code) via Start, so default "who" to Claude there;
  // local tasks default to Manual. Stops once the user picks explicitly. The
  // highlight follows on entry via the [active] sync effect (whoSelectionIndex).
  useEffect(() => {
    if (props.mode === 'edit' || executorTouched) return;
    setExecutor(isTypebuild ? 'claude' : 'manual');
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
  // task-899af8b03aa6 — "Make this a template" intent. A template is a first-
  // class server object AUTO-registered when a task is created with input/output
  // field definitions (there is NO explicit create-template API — see
  // fm.typebuild.templates.*). So this is an intent+guarantee, not a create
  // call: ON requires ≥1 named input on save so the created task actually
  // registers as reusable. In EDIT mode it REFLECTS whether the task already
  // backs a template (set by the name-match effect below). Default OFF.
  const [makeTemplate, setMakeTemplate] = useState(false);
  const [templateHighlight, setTemplateHighlight] = useState(0);
  // task-f5a318566148 — the collapsible ADVANCED options section (collapsed by
  // default) and the multi-select cursor for the launch-flags question.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [flagsHighlight, setFlagsHighlight] = useState(0);

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

  // task-fd1be6f6b22d — load the signed-in user's group members once TypeBuild
  // is the target. NON-PHI (email/principal + display name). On any failure the
  // list stays empty → "Who runs this?" degrades to the plain Manual/Claude
  // fallback (NON-REGRESSION).
  useEffect(() => {
    if (!isTypebuild || !tbSignedIn) return;
    let alive = true;
    fm.typebuild.groups
      .members()
      .then((list) => {
        if (alive) setGroupMembers(list);
      })
      .catch(() => {
        /* members stay empty → Manual/Claude fallback */
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
  // task-15a948e6e1bf — the in-composer "Task vs Chained task" chooser is gone;
  // chaining now has a dedicated entry button (initialKind === 'chain'). A plain
  // create leaves templateChoice at 'blank'; the chain button pre-sets 'chain'.
  // A target switch that drops the chain option falls back to "Task" so the
  // flow never strands on an option that's no longer offered.
  useEffect(() => {
    if (!hasChainOption && templateChoice !== 'blank') setTemplateChoice('blank');
  }, [hasChainOption, templateChoice]);

  // ── Chain builder state ──────────────────────────────────────────────────
  // task-a7214605a998 (final model) — a CHAIN IS A HIGHER-ORDER TEMPLATE:
  // nothing but an ORDERED LIST OF SAVED TEMPLATES. `chainTemplates` is that
  // ordered list — refs to templates the user already saved (via "Make this a
  // template" on a task), held in composer state until save(), when
  // instantiateChain turns it into a thin parent container + one instantiated
  // child task per template. NON-PHI: template id/name + field COUNTS only —
  // NO field defs / instructions are authored here (the templates own those).
  type ChainTemplateRow = {
    templateId: string;
    name: string;
    variables: number;
    outputs: number;
  };
  const [chainTemplates, setChainTemplates] = useState<ChainTemplateRow[]>([]);
  function addChainTemplate(t: Template) {
    setChainTemplates((prev) => [
      ...prev,
      {
        templateId: t.id,
        name: t.name,
        variables: (t.variables ?? []).length,
        outputs: (t.outputSchema ?? []).length,
      },
    ]);
  }
  function removeChainTemplate(idx: number) {
    setChainTemplates((prev) => prev.filter((_, i) => i !== idx));
  }
  function moveChainTemplate(idx: number, dir: -1 | 1) {
    setChainTemplates((prev) => {
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      const tmp = next[idx];
      next[idx] = next[j];
      next[j] = tmp;
      return next;
    });
  }
  // At least one template is required to advance/save the chain.
  const chainTemplatesValid = chainTemplates.length > 0;

  // The chain builder's inline template PICKER (typeahead over the user's saved
  // templates — the SAME `templates` list the from-template picker uses). Open
  // via "+ Add template", filter by name, ↑/↓ to highlight, Enter to append,
  // Esc to close.
  const [chainPickerOpen, setChainPickerOpen] = useState(false);
  const [chainPickerQuery, setChainPickerQuery] = useState('');
  const [chainPickerHighlight, setChainPickerHighlight] = useState(0);

  // ── task-e112d60a3b7c — "New from Template" (first-class, server-backed) ────
  // A template is a FIRST-CLASS server object (GET /chromeext/templates): the
  // server auto-registers/dedupes a template whenever a task is created with
  // input field definitions / output_schema, so the picker just LISTS them. The
  // list is NON-PHI (names + `variables` field defs; the prompt body `notes` is
  // NOT included). task-a7214605a998 — the CHAIN builder now reuses this SAME
  // template list + source: a chain is an ordered list of these saved templates
  // (see the chain-template picker below), so there is no separate
  // copy-from-existing-chained-task flow anymore.
  const isFromTemplateMode = props.mode === 'create' && props.initialKind === 'template';

  // The server-backed template list, fetched EXACTLY ONCE on entering
  // from-template mode (re-fetched only when the project context changes). NON-
  // PHI (names + field defs) so it's fine to cache in memory. `templatesLoading`
  // drives the picker's loading state; `templatesError` surfaces a fetch failure.
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  // task-41e5fc25ed2b (picker slice) — server-side ChainDefs are MERGED into the
  // from-template picker alongside single templates. Fetched (NON-PHI) only in
  // from-template mode; the chain BUILDER does not read this. A fetch miss
  // degrades to [] (the picker just shows single templates) — never blocks it.
  const [chains, setChains] = useState<ChainDef[]>([]);
  const templateListProjectId = projectId || initialProjectId || '';
  // task-a7214605a998 — the CHAIN builder is a picker over these SAME saved
  // templates, so load the list whenever the from-template picker OR the chain
  // builder is active (not just from-template mode).
  const needsTemplateList =
    isFromTemplateMode || (hasChainOption && templateChoice === 'chain');
  useEffect(() => {
    if (!needsTemplateList) return;
    let cancelled = false;
    setTemplatesLoading(true);
    setTemplatesError(null);
    void (async () => {
      try {
        const rows = await fm.typebuild.templates.list(templateListProjectId || undefined);
        if (cancelled) return;
        setTemplates(Array.isArray(rows) ? rows : []);
      } catch (e) {
        if (cancelled) return;
        setTemplates([]);
        setTemplatesError(humanizeError(e).message);
      } finally {
        if (!cancelled) setTemplatesLoading(false);
      }
    })();
    // task-41e5fc25ed2b — MERGE server ChainDefs into the picker. Only in
    // from-template mode (the chain builder doesn't list chains). A chain fetch
    // failure is NON-fatal: leave `chains` empty so single templates still show
    // (never surface it as templatesError — that would hide the working list).
    if (isFromTemplateMode) {
      void (async () => {
        try {
          const rows = await fm.typebuild.chains.list(templateListProjectId || undefined);
          if (cancelled) return;
          setChains(Array.isArray(rows) ? rows : []);
        } catch {
          if (cancelled) return;
          setChains([]);
        }
      })();
    }
    return () => {
      cancelled = true;
    };
    // Fetch once per entry + project switch — NOT per keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsTemplateList, templateListProjectId]);

  // Picker step: 'pick' (searchable list), 'title' (prefilled, Enter to
  // accept), 'values' (one question per input variable), then Ctrl+Enter
  // creates. `templateEditDetails` is the "edit details" escape hatch — flips
  // into the full flow (same composer, same class) with the chosen template's
  // variables/outputSchema pre-loaded as taskInputs/taskOutputs so everything
  // (project/notes/schema/agent/flags/priority) becomes editable instead of
  // silently inherited.
  type TemplatePickPhase = 'pick' | 'title' | 'values';
  const [templatePickPhase, setTemplatePickPhase] = useState<TemplatePickPhase>('pick');
  const [templatePickQuery, setTemplatePickQuery] = useState('');
  const [templatePickHighlight, setTemplatePickHighlight] = useState(0);
  const [templateEntry, setTemplateEntry] = useState<Template | null>(null);
  const [templateEditDetails, setTemplateEditDetails] = useState(false);

  // task-41e5fc25ed2b — one picker entry: either a single Template or a ChainDef.
  type PickCandidate =
    | { kind: 'single'; id: string; name: string; template: Template }
    | { kind: 'chain'; id: string; name: string; chain: ChainDef };

  // task-41e5fc25ed2b — the picker's candidate list is single templates AND
  // server ChainDefs, merged into one discriminated shape (kind:'single' carries
  // a Template; kind:'chain' carries a ChainDef). `id`/`name` are lifted to the
  // top so the render + typeahead treat both kinds uniformly. Chains sort first
  // (they're the "run a whole workflow" option). Selecting a chain instantiates
  // immediately (no per-run variables); a single walks the title/values flow.
  const templateCandidates = useMemo<PickCandidate[]>(() => {
    const chainCands: PickCandidate[] = chains.map((c) => ({
      kind: 'chain',
      id: c.id,
      name: c.name,
      chain: c,
    }));
    const singleCands: PickCandidate[] = templates.map((t) => ({
      kind: 'single',
      id: t.id,
      name: t.name,
      template: t,
    }));
    return [...chainCands, ...singleCands];
  }, [templates, chains]);

  // Typeahead filter on the candidate NAME (same substring-match pattern the
  // composer's other pickers use). Runs over the already-fetched merged list —
  // no per-keystroke network. Filters both kinds identically.
  const filteredTemplateCandidates = useMemo(() => {
    const q = templatePickQuery.trim().toLowerCase();
    if (!q) return templateCandidates;
    return templateCandidates.filter((c) => c.name.toLowerCase().includes(q));
  }, [templateCandidates, templatePickQuery]);

  // copilot parity / row-shortcut: a pre-selected template id (props.templateTaskId)
  // skips straight past the picker into the title step. task-e41ce7bf62fb —
  // the New Home roster's "+ New run" only knows the section's template NAME
  // (no template_id from the server yet), so it sets initialTemplateName
  // instead; matched by exact name (case-insensitive) against the same
  // candidate list, same skip-the-picker effect. Runs once templateCandidates
  // resolves (async fetch) since neither preselect fires until then.
  useEffect(() => {
    if (!isFromTemplateMode) return;
    if (templateEntry) return;
    const preselectId = props.mode === 'create' ? props.templateTaskId : undefined;
    if (preselectId) {
      const found = templateCandidates.find((c) => c.id === preselectId);
      if (found) {
        chooseTemplateEntry(found);
        return;
      }
    }
    const preselectName = props.mode === 'create' ? props.initialTemplateName : undefined;
    if (!preselectName) return;
    const q = preselectName.trim().toLowerCase();
    if (!q) return;
    const found = templateCandidates.find((c) => c.name.trim().toLowerCase() === q);
    if (found) chooseTemplateEntry(found);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFromTemplateMode, templateCandidates, templateEntry]);

  function chooseTemplateEntry(cand: PickCandidate) {
    // task-41e5fc25ed2b — a ChainDef has NO per-instantiation variables, so
    // picking one instantiates IMMEDIATELY (empty step_inputs) rather than
    // walking the title/values flow; the single-template path is unchanged.
    if (cand.kind === 'chain') {
      void saveFromChain(cand.chain);
      return;
    }
    const entry = cand.template;
    setTemplateEntry(entry);
    setTitle(entry.name);
    setTemplateFillActiveIdx(0);
    // task-e112d60a3b7c — a template with NO input variables (e.g. an
    // output-only "Get top 5 headlines") is a pure one-click instantiate:
    // picking it creates the task immediately, with no title/values step and
    // no "no input fields" message to park on. We pass the entry + name
    // EXPLICITLY because setTemplateEntry/setTitle above haven't flushed to
    // state yet in this tick. Only templates WITH variables walk the
    // title → values flow.
    if (templateFillEntries(entry).length === 0) {
      void saveFromTemplate(entry, entry.name);
      return;
    }
    // task-2aabe526f8c6 — a template is a task with HOLES: instantiating it
    // means filling the holes and starting, NOT renaming the work. "Schedule
    // surgery" stays "Schedule surgery" for John, Jane and Anita. The title is
    // already prefilled from the template name above and the old 'title' phase
    // only re-checked it was non-empty, so it was a mandatory keystroke that
    // asked the user to redo the one decision the template already made. Go
    // straight to the values. (Renaming stays available via "Edit details…".)
    setTemplatePickPhase('values');
  }

  // The picked template's input-VALUE questions — one per `variable`, in
  // declaration order. Pure/testable derivation (templateFillEntries) so the
  // picker walk + a unit test share one contract. Each carries the flat `ref`
  // used to key its typed value.
  const templateEntryFieldEntries = useMemo(
    () => (templateEntry ? templateFillEntries(templateEntry) : []),
    [templateEntry],
  );
  const [templateFillValues, setTemplateFillValues] = useState<Record<string, string>>({});
  const [templateFillHighlight, setTemplateFillHighlight] = useState<Record<string, number>>({});
  const [templateFillActiveIdx, setTemplateFillActiveIdx] = useState(0);
  const templateFillActiveRef =
    templateEntryFieldEntries[Math.min(templateFillActiveIdx, templateEntryFieldEntries.length - 1)];
  // Re-entry guard for the single instantiate call: the title <input>'s own
  // onKeyDown AND the window keydown handler can both fire acceptTemplateTitle →
  // saveFromTemplate for one Enter press (and a zero-input template instantiates
  // straight from the title). A synchronous `busy` state flip is too slow to
  // stop the second call in the same tick, so a ref gate prevents a double
  // create. Reset on error so the human can retry.
  const instantiatingRef = useRef(false);

  function acceptTemplateTitle() {
    if (!title.trim()) return;
    // task-e112d60a3b7c — a template with NO input variables (e.g. an
    // output-only "Get top 5 headlines") is a one-click instantiate: skip the
    // (empty) values step entirely and create straight from the title, rather
    // than parking on a "no inputs" dead-end. The server accepts an empty
    // values map and just creates the task with no data bag.
    if (templateEntryFieldEntries.length === 0) {
      void saveFromTemplate();
      return;
    }
    setTemplateFillActiveIdx(0);
    setTemplatePickPhase('values');
  }

  // "edit details" escape hatch: load the template's variables/outputSchema
  // into the SAME state the plain (single-task) full flow reads (taskInputs/
  // taskOutputs) and drop into the ordinary create walk so every question
  // (project/notes/output schema/agent/flags/priority) becomes editable instead
  // of silently inherited. (Templates from this picker are always single fielded
  // templates — chained templates use the separate chain-copy flow above.)
  function editTemplateDetails() {
    if (!templateEntry) return;
    setTemplateEditDetails(true);
    setTaskInputs((templateEntry.variables ?? []).map((f) => ({ ...f })));
    setTaskOutputs((templateEntry.outputSchema ?? []).map((f) => ({ ...f })));
    setTemplateChoice('blank');
    if (templateEntry.projectId) {
      setProjectId(templateEntry.projectId);
      setProjectTouched(true);
    }
  }
  function setTemplateFillValue(ref: string, v: string) {
    setTemplateFillValues((prev) => ({ ...prev, [ref]: v }));
  }

  // Ctrl+Enter (or the final field's Enter) instantiates the template: POST
  // /chromeext/templates/{id}/instantiate with the collected `values` (keyed by
  // each variable's effective server key). This is the ONLY task-creation call
  // in this path — the SERVER creates the task (data bag from values,
  // output_schema copied, project/agent/flags inherited); the client never
  // fabricates it locally. `values` MAY be PHI — carried only in transient state
  // and the encrypted request body, never logged. On success: flash + refresh
  // roster (same mechanism as the plain create-success path), then exit.
  async function saveFromTemplate(
    entryArg?: Template,
    titleArg?: string,
  ): Promise<{ ok: boolean; taskId?: string; error?: string }> {
    // entryArg/titleArg let a zero-input pick instantiate in the same tick,
    // before setTemplateEntry/setTitle flush to state; the walk-driven calls
    // pass nothing and read state as before.
    const entry = entryArg ?? templateEntry;
    const useTitle = (titleArg ?? title).trim();
    if (!entry) return { ok: false, error: 'Pick a template first.' };
    if (!useTitle) {
      setTemplatePickPhase('title');
      return { ok: false, error: 'Add a title.' };
    }
    if (instantiatingRef.current) return { ok: false, error: 'Already creating…' };
    instantiatingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      // Collect the typed values keyed by each variable's server key
      // (effectiveFieldKey, same normalization save() uses so a value never
      // silently drops). The ref used in state is `<templateId>.<field.key>`.
      const values: Record<string, string> = {};
      for (const f of entry.variables ?? []) {
        const key = effectiveFieldKey(f);
        if (!key) continue;
        values[key] = templateFillValues[fieldRef(entry.id, f.key)] ?? '';
        if (f.source && 'connectionId' in f.source) {
          // task-8f27d842f14d — Connection form: sweep every `<f.key>.*`
          // sibling the onSelectSource handler fanned onto templateFillValues
          // (ref/connection_id/connection_version/picked_at + bundle fields)
          // onto the instantiate call's `values`, keyed by the EFFECTIVE
          // server key (mirrors the plain value above, not f.key raw).
          const prefix = fieldRef(entry.id, `${f.key}.`);
          for (const [ref, v] of Object.entries(templateFillValues)) {
            if (!ref.startsWith(prefix)) continue;
            const suffix = ref.slice(fieldRef(entry.id, f.key).length + 1);
            values[`${key}.${suffix}`] = v;
          }
        } else {
          // task-73f6304ffb94 — a source-backed pick also carries its opaque
          // record ref on a sibling `<key>.ref` key, so the instantiated
          // task's data bag points at the REAL record, not just the
          // typed-looking label.
          const refVal = templateFillValues[fieldRef(entry.id, `${f.key}.ref`)];
          if (refVal) values[`${key}.ref`] = refVal;
        }
      }
      const result = await fm.typebuild.templates.instantiate(
        entry.id,
        values,
        useTitle,
        entry.projectId || undefined,
      );
      // Full-record persistence (QA 2026-07-12): the live instantiate endpoint
      // only accepts DECLARED variable keys — every `<key>.*` sibling (record
      // ref + the picked row's full bundle: dob/address/insurance/…) gets
      // stripped by the unknown_keys retry in the source layer, so the created
      // task carried only the label. The data PATCH endpoint has no such gate,
      // so re-apply the siblings onto the fresh task. Best-effort + async: the
      // task exists either way, and once the server accepts dotted subkeys on
      // instantiate (task-124de5943d99) this writes the same values it already
      // stored. PHI stays in memory → encrypted request body only.
      const siblingValues: Record<string, string> = {};
      const declaredKeys: string[] = [];
      for (const [k, v] of Object.entries(values)) {
        if (k.includes('.')) siblingValues[k] = v;
        else declaredKeys.push(k);
      }
      if (Object.keys(siblingValues).length > 0) {
        void fm.typebuild.taskData.patch(result.id, siblingValues, [], declaredKeys).catch(() => {
          // Non-fatal: the task was created; the drawer's Inputs editor can
          // re-attach the record by re-picking if this enrichment ever fails.
        });
      }
      (window as unknown as { __fmFlashTaskId?: string; __fmFlashTs?: number }).__fmFlashTaskId = result.id;
      (window as unknown as { __fmFlashTaskId?: string; __fmFlashTs?: number }).__fmFlashTs = Date.now();
      window.dispatchEvent(new CustomEvent('fm:taskFlash', { detail: { taskId: result.id } }));
      setCreated(true);
      props.onSaved?.();
      setTimeout(() => exit(), 900);
      return { ok: true, taskId: result.id };
    } catch (e) {
      const msg = humanizeError(e).message;
      setError(msg);
      setBusy(false);
      instantiatingRef.current = false;
      return { ok: false, error: msg };
    }
  }

  // task-41e5fc25ed2b — instantiate a picked ChainDef. POST
  // /chromeext/chains/{id}/instantiate with EMPTY step_inputs (the picker slice
  // supplies no per-step values): the SERVER atomically creates a parent
  // container + one child task per step and runs its advance loop. Mirrors
  // saveFromTemplate's success path exactly (flash the PARENT task id + refresh
  // roster + exit) and reuses the same instantiatingRef double-create guard.
  async function saveFromChain(chain: ChainDef): Promise<void> {
    if (instantiatingRef.current) return;
    instantiatingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await fm.typebuild.chains.instantiate(chain.id);
      const flashId = result.parentTaskId;
      (window as unknown as { __fmFlashTaskId?: string; __fmFlashTs?: number }).__fmFlashTaskId = flashId;
      (window as unknown as { __fmFlashTaskId?: string; __fmFlashTs?: number }).__fmFlashTs = Date.now();
      window.dispatchEvent(new CustomEvent('fm:taskFlash', { detail: { taskId: flashId } }));
      setCreated(true);
      props.onSaved?.();
      setTimeout(() => exit(), 900);
    } catch (e) {
      const msg = humanizeError(e).message;
      setError(msg);
      setBusy(false);
      instantiatingRef.current = false;
    }
  }

  // ── Plain-task fields (task-2fd63b922beb correction, Part A) ─────────────
  // The PLAIN task form owns its OWN optional input/output fields — a single
  // task-def with the literal id 'task'. No neededWhen here (that's chain-
  // only). Definitions (key/label/type/options/required) are NON-PHI; the
  // later typed VALUES ride templateValues (PHI, body-only, same as a chain).
  const [taskInputs, setTaskInputs] = useState<TaskDefField[]>(
    (props.mode === 'create' && props.initialInputs) || [],
  );
  const [taskOutputs, setTaskOutputs] = useState<TaskDefField[]>(
    (props.mode === 'create' && props.initialOutputs) || [],
  );
  function taskFieldSetter(kind: FieldKind) {
    return kind === 'inputs' ? setTaskInputs : setTaskOutputs;
  }
  function removeTaskField(kind: FieldKind, fieldIdx: number) {
    taskFieldSetter(kind)((prev) => prev.filter((_, i) => i !== fieldIdx));
  }
  // task-73f6304ffb94 — drop a field's SavedQuery binding (key/label/type kept).
  function clearTaskFieldSource(kind: FieldKind, fieldIdx: number) {
    taskFieldSetter(kind)((prev) =>
      prev.map((f, i) => {
        if (i !== fieldIdx) return f;
        const { source: _drop, ...rest } = f;
        return rest;
      }),
    );
  }
  // The single synthetic task-def the plain form's fields aggregate through —
  // reuses the exact same aggregateInputs / build*Block path as a chain.
  const taskFieldsDef = useMemo<TaskDef>(
    () => ({ id: 'task', name: title.trim() || 'Task', inputs: taskInputs, outputs: taskOutputs }),
    [title, taskInputs, taskOutputs],
  );

  // ── Field-definition sub-walk (task-342f3e151d99) ───────────────────────
  // Adding an input/output is `i`/`o` (from the MAIN window handler — see the
  // keydown handler below), then a per-field Typeform sub-walk, ONE question
  // per step, living in the SAME activeIdx walk as the rest of the form (no
  // nested cursor, no stopPropagation). `fieldDraft` is the field currently
  // being added or edited; it's held ONLY in memory and written into
  // taskInputs/taskOutputs at commitFieldDraft — so Escape mid-walk is just
  // discarding this state (nothing was ever inserted to "remove").
  const [fieldDraft, setFieldDraft] = useState<FieldDraft | null>(null);
  // Where to land activeIdx once QUESTIONS has re-derived after a commit/
  // cancel (taskInputs/taskOutputs changing is what grows/shrinks the field
  // rows in QUESTIONS — see mainQuestions below) — mirrors the pendingFocus
  // ref pattern the old grid editor used for its own row-focus bookkeeping.
  const pendingFieldFocusRef = useRef<QuestionId | null>(null);

  // task-342f3e151d99 — the INPUT "source" step is rendered by the shared
  // FieldSourcePicker (Custom first, then top source fields, then "Browse all…"
  // → pick source → pick field, all searchable). It owns its own keys while
  // focused, so the sub-walk keeps no highlight state for that step.
  const [fieldDraftHighlight, setFieldDraftHighlight] = useState(0);

  function startFieldDraft(kind: FieldKind) {
    if (fieldDraft) return; // one draft at a time
    setFieldDraftHighlight(0);
    if (kind === 'inputs') {
      setFieldDraft({ kind, editIdx: null, field: { key: '', label: '', type: 'text' }, step: 'source' });
    } else {
      setFieldDraft({ kind, editIdx: null, field: { key: '', label: '', type: 'text' }, step: 'key' });
    }
    pendingFieldFocusRef.current = 'field-draft';
  }
  function startEditFieldRow(kind: FieldKind, idx: number) {
    if (fieldDraft) return;
    const field = (kind === 'inputs' ? taskInputs : taskOutputs)[idx];
    if (!field) return;
    setFieldDraftHighlight(0);
    setFieldDraft({ kind, editIdx: idx, field: { ...field }, step: 'key' });
    pendingFieldFocusRef.current = 'field-draft';
  }
  function updateFieldDraft(patch: Partial<TaskDefField>) {
    setFieldDraft((d) => (d ? { ...d, field: { ...d.field, ...patch } } : d));
  }
  // task-342f3e151d99 — commit a SPECIFIC draft snapshot (not necessarily the
  // latest `fieldDraft` state, which React hasn't applied yet mid-handler) —
  // chooseFieldDraftRequired needs this so its just-picked value is what
  // actually gets written, not whatever `fieldDraft` still reads at call time.
  function commitFieldDraftWith(d: FieldDraft) {
    const cleaned: TaskDefField = { ...d.field, key: d.field.key.trim(), label: d.field.label.trim() };
    const idx = d.editIdx ?? (d.kind === 'inputs' ? taskInputs.length : taskOutputs.length);
    if (d.editIdx === null) {
      taskFieldSetter(d.kind)((prev) => [...prev, cleaned]);
    } else {
      taskFieldSetter(d.kind)((prev) => prev.map((f, i) => (i === d.editIdx ? cleaned : f)));
    }
    pendingFieldFocusRef.current = fieldRowQId(d.kind, idx);
    setFieldDraft(null);
  }
  function commitFieldDraft() {
    if (fieldDraft) commitFieldDraftWith(fieldDraft);
  }
  // Digits 1–5 pick a TYPE on the 'type' step (mirrors every other
  // digit-picked option question), then advance. Changing type can grow/
  // shrink the remaining steps (e.g. picking 'select' adds an 'options'
  // step) — computed from the JUST-PICKED type directly (not the stale
  // `fieldDraft` closure, which React hasn't applied this pick to yet) so a
  // select→advance in the same keystroke lands on 'options', not skips it.
  function chooseFieldDraftType(i: number) {
    if (!fieldDraft) return;
    const t = FIELD_TYPE_OPTIONS[i];
    if (!t) return;
    const field: TaskDefField = { ...fieldDraft.field, type: t, ...(t !== 'select' ? { options: undefined } : {}) };
    const next = nextFieldDraftStep(fieldDraft.kind, t, 'type');
    setFieldDraftHighlight(0);
    if (next) setFieldDraft({ ...fieldDraft, field, step: next });
    else commitFieldDraftWith({ ...fieldDraft, field });
  }
  const FIELD_REQUIRED_OPTIONS: { value: boolean; label: string }[] = [
    { value: false, label: 'No' },
    { value: true, label: 'Yes — evidence' },
  ];
  // How many options the CURRENT step's list has — 0 for the free-text steps
  // (key/label/options), so moveDown/moveUp can tell "move the highlight" from
  // "advance/retreat the sub-walk" the same way every other option question
  // does (mirrors whoOptions.length/START_OPTIONS.length/etc. elsewhere).
  function fieldDraftOptionCount(): number {
    if (!fieldDraft) return 0;
    if (fieldDraft.step === 'source') return 0; // FieldSourcePicker owns its own highlight
    if (fieldDraft.step === 'type') return FIELD_TYPE_OPTIONS.length;
    if (fieldDraft.step === 'required') return FIELD_REQUIRED_OPTIONS.length;
    return 0;
  }
  // 'required' is always the LAST sub-walk step (see fieldDraftSteps), so
  // picking it commits immediately — same stale-closure care as the type step.
  function chooseFieldDraftRequired(i: number) {
    if (!fieldDraft) return;
    const opt = FIELD_REQUIRED_OPTIONS[i];
    if (!opt) return;
    setFieldDraftHighlight(0);
    commitFieldDraftWith({ ...fieldDraft, field: { ...fieldDraft.field, required: opt.value } });
  }
  // Enter/↓ on the current step: commit the step's value and move on, or
  // (on the last step) commit the WHOLE field into the list — same "advance
  // off the last question" convention as fieldAdvance/goNext elsewhere. Only
  // used by the free-text steps (key/label/options); type/required commit
  // themselves (see above) since they need the just-picked value.
  function advanceFieldDraft() {
    if (!fieldDraft) return;
    if (fieldDraft.step === 'source') return; // FieldSourcePicker advances via onPick/onCustom
    const next = nextFieldDraftStep(fieldDraft.kind, fieldDraft.field.type, fieldDraft.step);
    setFieldDraftHighlight(0);
    if (next) setFieldDraft((d) => (d ? { ...d, step: next } : d));
    else commitFieldDraft();
  }
  // ↑ on the current step: step back, or (on the first step) exit the
  // sub-walk — cancelling a NEW field (nothing was ever inserted) or
  // discarding in-progress edits to an EXISTING one (the original row is
  // untouched, since edits only land on commit).
  function retreatFieldDraft() {
    if (!fieldDraft) return;
    setFieldDraftHighlight(0);
    if (fieldDraft.step === 'source') { cancelFieldDraft(); return; }
    if (fieldDraft.step === 'key') {
      if (fieldDraft.editIdx === null && fieldDraft.kind === 'inputs') {
        setFieldDraft((d) => (d ? { ...d, step: 'source' } : d));
      } else {
        cancelFieldDraft();
      }
      return;
    }
    const prev = prevFieldDraftStep(fieldDraft.kind, fieldDraft.field.type, fieldDraft.step);
    if (prev) setFieldDraft((d) => (d ? { ...d, step: prev } : d));
  }
  // task-342f3e151d99 — Escape mid-walk "removes the half-built row": since a
  // draft is only ever WRITTEN into the real list at commitFieldDraft, there
  // is never actually a half-built row in taskInputs/taskOutputs to remove —
  // cancelling is just discarding this in-memory draft.
  function cancelFieldDraft() {
    const d = fieldDraft;
    if (!d) return;
    pendingFieldFocusRef.current =
      d.editIdx !== null ? fieldRowQId(d.kind, d.editIdx) : d.kind === 'inputs' ? 'fields' : 'outputs';
    setFieldDraft(null);
  }
  // task-342f3e151d99 — the pendingFieldFocusRef → activeIdx effect lives
  // further down (after QUESTIONS is derived, since it depends on it).

  // task-fe8c822c3838 — a user typing "Input: X / Output: Y" as PROSE in
  // notes gets NO structured fields today (data_keys:[]/output_schema:[]),
  // so an agent working the task has nothing to read and no output
  // contract — it stalls (task-22fdf07763ee). Lift that prose into a
  // one-tap, NON-DESTRUCTIVE suggestion: never rewrites notes, only offers
  // to also populate the plain task's own input/output field definitions
  // (taskInputs/taskOutputs above) from what was parsed. Only offered for a
  // fresh TypeBuild plain-task create with no fields defined yet — an edit,
  // a chain, or a task that already has fields never sees it (nothing to
  // usefully suggest, or the human already structured it deliberately).
  const proseSuggestion = useMemo(
    () => inferFieldsFromProse(notes),
    [notes],
  );
  const showProseSuggestion =
    hasChainOption &&
    templateChoice === 'blank' &&
    taskInputs.length === 0 &&
    taskOutputs.length === 0 &&
    (proseSuggestion.inputs.length > 0 || proseSuggestion.outputs.length > 0);
  const [dismissedProseSuggestionFor, setDismissedProseSuggestionFor] = useState<string | null>(null);
  const proseSuggestionVisible = showProseSuggestion && dismissedProseSuggestionFor !== notes;
  function acceptProseSuggestion() {
    if (proseSuggestion.inputs.length > 0) {
      setTaskInputs((prev) => [...prev, ...proseSuggestion.inputs]);
    }
    if (proseSuggestion.outputs.length > 0) {
      setTaskOutputs((prev) => [...prev, ...proseSuggestion.outputs]);
    }
    setDismissedProseSuggestionFor(notes);
  }
  function dismissProseSuggestion() {
    setDismissedProseSuggestionFor(notes);
  }

  // Whichever defs currently drive the aggregated field/outputs questions: the
  // chain when "Chained task" is picked, else the single plain-task def.
  const fieldsDefs = useMemo<TaskDef[]>(
    // task-a7214605a998 — a chain no longer authors inline fields (its steps are
    // saved templates that own their own fields), so the chain path drives NO
    // aggregated field/outputs questions. Only the plain-task def does.
    () => (templateChoice === 'chain' ? [] : [taskFieldsDef]),
    [templateChoice, taskFieldsDef],
  );
  const definedOutputsCount = useMemo(
    () => fieldsDefs.reduce((n, d) => n + (d.outputs?.length ?? 0), 0),
    [fieldsDefs],
  );
  // A chained job is a THIN container flow (name + chain, no task-form
  // questions); a plain task keeps its full flow plus the optional fields step.
  const isMinimalChain = hasChainOption && templateChoice === 'chain';
  // task-342f3e151d99 — Inputs & Outputs are two ALWAYS-present sections for a
  // plain (non-chained) TypeBuild create — even with zero fields defined yet,
  // so `i`/`o` have somewhere to add the first one. A chain's outputs live in
  // its templates, so the chain flow still has no outputs step.
  const showFieldsSteps = hasChainOption && templateChoice === 'blank';

  // task-899af8b03aa6 — the "Make this a template" step shows for the TypeBuild
  // target only (templates are a TypeBuild concept): on a PLAIN create (not a
  // chain, not the New-from-Template picker) where the fields it describes live,
  // and on any EDIT (as a reflection of existing template state). Never on a
  // chained job (its own thin container) or a local/other source.
  const templateStepAvailable =
    isTypebuild &&
    !isFromTemplateMode &&
    !isMinimalChain &&
    (props.mode === 'edit' || templateChoice === 'blank');

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

  // task-f5a318566148 — the always-visible MAIN walk. For a fresh TypeBuild
  // create the plain-task 'fields' step (+ optional read-only 'outputs' summary)
  // splices in right after 'who', BEFORE the body/notes; a chained create
  // instead replaces the tail with the chain builder + outputs (a thin
  // container — no who/notes/advanced). Edit and local creates get the base
  // main list unchanged.
  const mainQuestions = useMemo<QuestionId[]>(() => {
    const main = questionSplit.main;
    if (!hasChainOption) {
      // Create-local or EDIT (any source). task-899af8b03aa6 — a TypeBuild EDIT
      // surfaces the "Make this a template" reflection step (pre-checked when
      // the task already backs a template) right before 'notes'; local/other
      // edits are unchanged.
      if (templateStepAvailable) {
        const nIdx = main.indexOf('notes');
        const at = nIdx >= 0 ? nIdx : main.length;
        return [...main.slice(0, at), 'template', ...main.slice(at)];
      }
      return main;
    }
    // task-2fd63b922beb / task-a7214605a998 — a "Chained task" is a THIN
    // container: name (title) + project + the chain (an ordered list of saved
    // templates). The task-form questions (who/notes/advanced) are DROPPED, and
    // there's no outputs step (a chain's outputs live in its templates).
    if (templateChoice === 'chain') {
      const pIdx = main.indexOf('project');
      return [...main.slice(0, pIdx + 1), 'chain'];
    }
    // task-2fd63b922beb correction (Part A) — a plain task's OWN optional
    // input/output fields. task-342f3e151d99 — INPUTS and OUTPUTS are now two
    // SEPARATE, always-present sections (not one combined "fields" step gated
    // on whether outputs exist) — each with its own explainer, its own `i`/`o`
    // add shortcut, and one walkable question per already-defined field
    // (field-row) plus the in-progress add/edit slot (field-draft) when one is
    // open. task-899af8b03aa6 — "Make this a template" follows the fields it
    // describes (those inputs/outputs become the template's variables), before
    // body/notes.
    const wIdx = main.indexOf('who');
    const extra: QuestionId[] = [
      'fields',
      ...taskInputs.map((_, i) => fieldRowQId('inputs', i)),
      ...(fieldDraft && fieldDraft.kind === 'inputs' ? (['field-draft'] as QuestionId[]) : []),
      'outputs',
      ...taskOutputs.map((_, i) => fieldRowQId('outputs', i)),
      ...(fieldDraft && fieldDraft.kind === 'outputs' ? (['field-draft'] as QuestionId[]) : []),
    ];
    if (templateStepAvailable) extra.push('template');
    return [...main.slice(0, wIdx + 1), ...extra, ...main.slice(wIdx + 1)];
  }, [questionSplit, hasChainOption, templateChoice, taskInputs, taskOutputs, fieldDraft, templateStepAvailable]);

  // task-f5a318566148 — the ADVANCED block, only walked into when the section
  // is expanded. 'flags' is relevant only to Claude tasks (hidden when manual).
  // A chained create has no advanced block (it's a thin container).
  const advancedQuestions = useMemo<QuestionId[]>(() => {
    if (isMinimalChain) return [];
    return questionSplit.advanced.filter((q) => q !== 'flags' || executor === 'claude');
  }, [questionSplit, isMinimalChain, executor]);

  const QUESTIONS = useMemo<QuestionId[]>(() => {
    // task-0d63c7b0ebdb — the escape hatch's values-only walk: after a plain
    // create, the flow is JUST the defined inputs' value questions, keyed onto
    // the already-created task (see saveFillValues).
    if (fillMode) return templateFieldQIds;
    // When collapsed, ↓ past the last MAIN question / Enter goes straight to
    // commit — the hidden advanced questions are NOT part of the walk.
    return advancedOpen ? [...mainQuestions, ...advancedQuestions] : mainQuestions;
  }, [fillMode, templateFieldQIds, advancedOpen, mainQuestions, advancedQuestions]);

  // task-f5a318566148 — the collapsed header reads "Advanced options (N set)"
  // where N counts the advanced fields the user has actually configured away
  // from their NEUTRAL default: priority set, a real future deferral, agent
  // chosen, status ≠ pending, each ON launch flag, a real due-date/schedule,
  // pinned, and (local only) a working folder changed from its default.
  // N===0 → just "Advanced options". Recomputed live as fields change.
  //
  // Neutral defaults must NOT count, or a pristine new task reads "2 set":
  //  - defer/start: a fresh create defaults to 'today' and an existing task
  //    with no defer reads 'none' — both mean "available now", so only a
  //    deferral into the FUTURE ('tomorrow'/'pick-start') counts.
  //  - when: an agent task's default is 'on-demand' (runs when picked, no
  //    schedule) and a manual task's is 'none' (no due) — neither is a real
  //    schedule, so both are neutral.
  const initialFolder = initial?.folder ?? (props.mode === 'create' ? props.defaultFolder : '');
  const advancedSetCount = useMemo(() => {
    let n = 0;
    if (isTypebuild && priority !== '') n += 1;
    if (startId === 'tomorrow' || startId === 'pick-start') n += 1;
    if (isTypebuild && agentId !== '') n += 1;
    if (status !== 'pending') n += 1;
    if (executor === 'claude') n += FLAG_OPTIONS.filter((o) => flags.has(o.id)).length;
    if (whenId !== 'none' && whenId !== 'on-demand') n += 1;
    if (pinned) n += 1;
    if (!isTypebuild && folder.trim() !== '' && folder !== initialFolder) n += 1;
    return n;
  }, [isTypebuild, priority, startId, agentId, status, executor, flags, whenId, pinned, folder, initialFolder]);

  const [activeIdx, setActiveIdx] = useState(0);
  // Clamp the active index when the question list shrinks/grows on a target
  // switch (TypeBuild drops 'folder', adds 'priority') or a template pick
  // (adds/removes field + outputs questions), so we never index past the end
  // and strand the keyboard cursor.
  const active = QUESTIONS[Math.min(activeIdx, QUESTIONS.length - 1)];

  // task-342f3e151d99 — land activeIdx on whatever pendingFieldFocusRef asked
  // for (set by startFieldDraft/commitFieldDraft/cancelFieldDraft above), once
  // QUESTIONS has re-derived to include that target id. taskInputs/taskOutputs
  // changing is what grows/shrinks the field-row/field-draft entries in
  // mainQuestions, so this has to run AFTER QUESTIONS, not inline with the
  // setState calls that triggered it.
  useEffect(() => {
    const target = pendingFieldFocusRef.current;
    if (!target) return;
    const idx = QUESTIONS.indexOf(target);
    if (idx >= 0) {
      pendingFieldFocusRef.current = null;
      setActiveIdx(idx);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [QUESTIONS]);

  // task-f5a318566148 — when a question becomes active, sync its option-list
  // highlight to the currently-chosen value so Enter picks the current
  // selection. With the MAIN/ADVANCED split (and optional fields/outputs/flags)
  // a question's neighbors are now dynamic, so the walk no longer hard-codes
  // each transition's next-highlight — this single effect keeps them correct.
  // Free-entry / textarea questions have no highlight; the field-value
  // questions manage their own; 'flags' is multi-select (cursor resets to top).
  useEffect(() => {
    switch (active) {
      case 'who': setWhoHighlight(whoSelectionIndex()); break;
      case 'project': setProjectHighlight(Math.max(0, PROJECT_OPTIONS.findIndex((o) => o.value === projectId))); break;
      case 'folder': setFolderHighlight(Math.max(0, visibleFolderPresets.findIndex((p) => p.v === folder))); break;
      case 'start': setStartHighlight(Math.max(0, START_OPTIONS.findIndex((s) => s.id === startId))); break;
      case 'when': setWhenHighlight(Math.max(0, visibleWhenOptions.findIndex((w) => w.id === whenId))); break;
      case 'priority': setPriorityHighlight(Math.max(0, PRIORITY_OPTIONS.findIndex((o) => o.value === priority))); break;
      case 'agent': setAgentHighlight(Math.max(0, AGENT_OPTIONS.findIndex((o) => o.value === agentId))); break;
      case 'status': setStatusHighlight(Math.max(0, STATUS_OPTIONS.findIndex((s) => s.id === status))); break;
      case 'pin': setPinHighlight(pinned ? 1 : 0); break;
      case 'template': setTemplateHighlight(makeTemplate ? 1 : 0); break;
      case 'flags': setFlagsHighlight(0); break;
      default: break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

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

  // task-899af8b03aa6 — EDIT reflection: a task "is a template" when a first-
  // class template with the same name exists. The server does not emit an
  // isTemplate flag / template_id yet (see task-source.ts), so name (+ project)
  // is the only available signal — the same identity listTemplates keys on.
  // Fetch ONCE on mount for the TypeBuild edit target and pre-check the toggle.
  // NON-PHI (template names + field defs only); best-effort, silent on failure.
  useEffect(() => {
    if (props.mode !== 'edit' || !isTypebuild) return;
    const name = (initial?.title ?? '').trim();
    if (!name) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await fm.typebuild.templates.list(initial?.projectId || undefined);
        if (cancelled) return;
        if (rows.some((t) => t.name.trim() === name)) {
          setMakeTemplate(true);
          setTemplateHighlight(1);
        }
      } catch {
        /* best-effort reflection — leave the toggle at its default */
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  // task-342f3e151d99 — the field-draft sub-walk's single text input (key/
  // label/options steps); one ref suffices since only one draft is ever open.
  const fieldDraftInputRef = useRef<HTMLInputElement | null>(null);

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
    } else if (
      active === 'field-draft' &&
      fieldDraft &&
      (fieldDraft.step === 'key' || fieldDraft.step === 'label' || fieldDraft.step === 'options')
    ) {
      // task-342f3e151d99 — the key/label/options sub-walk steps are free
      // text, same as title/notes: focus the input immediately.
      fieldDraftInputRef.current?.focus();
      fieldDraftInputRef.current?.select();
    } else if (active === 'field-draft' && fieldDraft?.step === 'source') {
      // task-342f3e151d99 — the SOURCE step is owned by FieldSourcePicker, which
      // focuses its own listbox root and handles arrows/digits/Enter/typing. The
      // generic branch below would focus the SECTION instead, stealing that
      // focus — the picker's handler then never fires, and the window walk has
      // already yielded for this step, so the keyboard went dead. Leave it be.
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
    // task-342f3e151d99 — `active` stays 'field-draft' for EVERY step of the
    // sub-walk, so keying only on it left the key/label/options inputs
    // unfocused after a step change (source -> key, key -> label). Keystrokes
    // then fell through to the window handler, where a bare 't' toggled "Make
    // this a template" mid-typing. Re-run on the step too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, fieldDraft?.step]);

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
  // task-f5a318566148 — advancing off the LAST question hops to the commit
  // footer. With the collapsible ADVANCED block the "last question" is dynamic
  // (the body/notes when collapsed; pin/folder when expanded), so every ↓/↵
  // that walks forward funnels through here.
  function goNext() {
    if (activeIdx >= QUESTIONS.length - 1) enterCommitPhase();
    else setActiveIdx(activeIdx + 1);
  }
  // task-f5a318566148 — expand/collapse the ADVANCED options section (the 'A'
  // shortcut / header click). Collapsing clamps the cursor back into the main
  // walk so it never strands on a now-hidden advanced question.
  function toggleAdvanced() {
    setAdvancedOpen((open) => {
      const next = !open;
      if (!next) setActiveIdx((i) => Math.min(i, mainQuestions.length - 1));
      return next;
    });
  }
  // task-0d63c7b0ebdb — advancing off the LAST question hops to the commit
  // footer. Used by the field-value questions (only ever present in the escape
  // hatch's fill walk, where the last field's ↵/↓ should reach "Save inputs").
  function fieldAdvance() {
    if (activeIdx >= QUESTIONS.length - 1) enterCommitPhase();
    else goNext();
  }

  // task-2fd63b922beb (R2) — the chain builder only advances once at least
  // one step has a non-empty name (chainDefsValid); otherwise it surfaces an
  // inline error and stays put, same convention as the date/cron validations
  // elsewhere in save().
  function tryAdvanceChain() {
    if (!chainTemplatesValid) {
      setError('Add at least one template to the chain.');
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

  // task-fd1be6f6b22d — a 'human' pick assigns a MANUAL task to that person
  // (executor 'manual', assignedTo = email); 'claude' is the existing auto path
  // (executor 'claude', assignee cleared); 'manual' is the unassigned fallback.
  function chooseWho(i: number) {
    const o = whoOptions[i];
    if (!o) return;
    if (o.kind === 'claude') {
      setExecutor('claude');
      setAssignedTo('');
    } else if (o.kind === 'human') {
      setExecutor('manual');
      setAssignedTo(o.email);
    } else {
      setExecutor('manual');
      setAssignedTo('');
    }
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
    // task-f5a318566148 — pin is no longer always the last question (the local
    // advanced block ends with 'folder'), so advance rather than commit.
    goNext();
  }

  // task-899af8b03aa6 — the "Make this a template" yes/no pick (mirrors
  // choosePin). Advances rather than commits (it sits before 'notes').
  function chooseTemplate(i: number) {
    const o = TEMPLATE_OPTIONS[i];
    if (!o) return;
    setMakeTemplate(o.id === 'yes');
    setTemplateHighlight(i);
    goNext();
  }
  // task-f5a318566148 — one launch flag toggled (multi-select). Unlike the
  // single-select pickers this does NOT advance — it flips the flag on/off and
  // stays put, mirroring a checkbox list; ↓ off the last flag advances.
  function chooseFlag(i: number) {
    const o = FLAG_OPTIONS[i];
    if (!o) return;
    setFlagsHighlight(i);
    toggleFlag(o.id);
  }

  // One aggregated select/bool INPUT field pick, keyed by fieldRef.
  function chooseFieldOption(ref: string, options: { value: string; label: string }[], i: number) {
    const o = options[i];
    if (!o) return;
    setTemplateValue(ref, o.value);
    setTemplateFieldHighlight((prev) => ({ ...prev, [ref]: i }));
    fieldAdvance();
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
  // task-0d63c7b0ebdb — enter the escape hatch's values-only walk for the
  // just-created plain task. QUESTIONS becomes the defined inputs' value
  // questions; saveFillValues writes them via the drawer's data-bag path.
  function enterFillMode() {
    setFillMode(true);
    setCreated(false);
    setError(null);
    setPhase('editing');
    setActiveIdx(0);
  }

  // task-f5a318566148 — ↓ flow. Each option question moves its own highlight
  // and, off the last option, advances (goNext hops to commit at the end of the
  // list). The neighbor's highlight is synced by the [active] effect, so the
  // walk is order-agnostic — it works for the MAIN walk, the appended ADVANCED
  // block, and the thin chain container alike.
  function moveDown() {
    if (active === 'title') {
      if (title.trim()) goNext();
      return;
    }
    if (active === 'folder') {
      if (folderHighlight >= visibleFolderPresets.length - 1) goNext();
      else setFolderHighlight((i) => i + 1);
      return;
    }
    if (active === 'project') {
      if (projectHighlight >= PROJECT_OPTIONS.length - 1) goNext();
      else setProjectHighlight((i) => i + 1);
      return;
    }
    if (active === 'who') {
      if (whoHighlight >= whoOptions.length - 1) goNext();
      else setWhoHighlight((i) => i + 1);
      return;
    }
    // Notes is a textarea (no option list) — ↓ outside it advances.
    if (active === 'notes') {
      goNext();
      return;
    }
    if (active === 'start') {
      if (startHighlight >= START_OPTIONS.length - 1) goNext();
      else setStartHighlight((i) => i + 1);
      return;
    }
    if (active === 'when') {
      if (whenHighlight >= visibleWhenOptions.length - 1) goNext();
      else setWhenHighlight((i) => i + 1);
      return;
    }
    if (active === 'priority') {
      if (priorityHighlight >= PRIORITY_OPTIONS.length - 1) goNext();
      else setPriorityHighlight((i) => i + 1);
      return;
    }
    if (active === 'agent') {
      if (agentHighlight >= AGENT_OPTIONS.length - 1) goNext();
      else setAgentHighlight((i) => i + 1);
      return;
    }
    if (active === 'status') {
      if (statusHighlight >= STATUS_OPTIONS.length - 1) goNext();
      else setStatusHighlight((i) => i + 1);
      return;
    }
    // task-f5a318566148 — launch flags (multi-select). ↓ moves the cursor;
    // off the last flag it advances (toggling is Enter/digits, not ↓).
    if (active === 'flags') {
      if (flagsHighlight >= FLAG_OPTIONS.length - 1) goNext();
      else setFlagsHighlight((i) => i + 1);
      return;
    }
    if (active === 'pin') {
      if (pinHighlight >= PIN_OPTIONS.length - 1) goNext();
      else setPinHighlight((i) => i + 1);
      return;
    }
    // task-899af8b03aa6 — the "Make this a template" yes/no step (mirrors pin).
    if (active === 'template') {
      if (templateHighlight >= TEMPLATE_OPTIONS.length - 1) goNext();
      else setTemplateHighlight((i) => i + 1);
      return;
    }
    // task-2fd63b922beb (R2) — the chain builder + its read-only outputs
    // summary. goNext() advances (or commits at the end) transparently.
    if (active === 'chain') {
      tryAdvanceChain();
      return;
    }
    // task-342f3e151d99 — the Inputs/Outputs section headers are optional —
    // ↓ just advances (into the first field-row, if any, else the next
    // question — QUESTIONS already has them spliced in between).
    if (active === 'fields' || active === 'outputs') {
      goNext();
      return;
    }
    // A field-row is a plain review item, no option list of its own —
    // ↓ walks to the next row / the draft slot / the next real question.
    if (isFieldRowQuestion(active)) {
      goNext();
      return;
    }
    // task-342f3e151d99 — the field-draft sub-walk. Option steps (source/
    // type/required) move the highlight like every other option question,
    // only advancing off the LAST option (Enter/digit picks + advances
    // explicitly — see the keydown handler); free-text steps (key/label/
    // options) advance straight through, same as 'notes'.
    if (active === 'field-draft' && fieldDraft) {
      const n = fieldDraftOptionCount();
      if (n === 0) {
        advanceFieldDraft();
      } else if (fieldDraftHighlight >= n - 1) {
        if (fieldDraft.step !== 'source') advanceFieldDraft(); // source: must pick explicitly
      } else {
        setFieldDraftHighlight((h) => h + 1);
      }
      return;
    }
    if (isFieldQuestion(active)) {
      const entry = fieldEntryFor(active);
      if (entry && isFieldOptionType(entry.field)) {
        const ref = fieldRef(entry.taskDef.id, entry.field.key);
        const opts = fieldOptionList(entry.field);
        const h = templateFieldHighlight[ref] ?? 0;
        if (h >= opts.length - 1) fieldAdvance();
        else setTemplateFieldHighlight((prev) => ({ ...prev, [ref]: h + 1 }));
      } else {
        fieldAdvance();
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
      if (projectHighlight === 0) goBack();
      else setProjectHighlight((i) => i - 1);
      return;
    }
    if (active === 'who') {
      if (whoHighlight === 0) goBack();
      else setWhoHighlight((i) => i - 1);
      return;
    }
    if (active === 'start') {
      if (startHighlight === 0) goBack();
      else setStartHighlight((i) => i - 1);
      return;
    }
    if (active === 'when') {
      if (whenHighlight === 0) goBack();
      else setWhenHighlight((i) => i - 1);
      return;
    }
    if (active === 'priority') {
      if (priorityHighlight === 0) goBack();
      else setPriorityHighlight((i) => i - 1);
      return;
    }
    if (active === 'agent') {
      if (agentHighlight === 0) goBack();
      else setAgentHighlight((i) => i - 1);
      return;
    }
    if (active === 'status') {
      if (statusHighlight === 0) goBack();
      else setStatusHighlight((i) => i - 1);
      return;
    }
    if (active === 'flags') {
      if (flagsHighlight === 0) goBack();
      else setFlagsHighlight((i) => i - 1);
      return;
    }
    if (active === 'pin') {
      if (pinHighlight === 0) goBack();
      else setPinHighlight((i) => i - 1);
      return;
    }
    // task-899af8b03aa6 — the "Make this a template" yes/no step (mirrors pin).
    if (active === 'template') {
      if (templateHighlight === 0) goBack();
      else setTemplateHighlight((i) => i - 1);
      return;
    }
    // Notes is a textarea (no option list) — ↑ walks straight back.
    if (active === 'notes') {
      goBack();
      return;
    }
    // task-2fd63b922beb (R2) — mirrors the moveDown additions above.
    if (active === 'chain') {
      goBack();
      return;
    }
    if (active === 'fields' || active === 'outputs') {
      goBack();
      return;
    }
    if (isFieldRowQuestion(active)) {
      goBack();
      return;
    }
    if (active === 'field-draft' && fieldDraft) {
      const n = fieldDraftOptionCount();
      if (n === 0 || fieldDraftHighlight === 0) {
        retreatFieldDraft();
      } else {
        setFieldDraftHighlight((h) => h - 1);
      }
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
    // task-2fd63b922beb / task-a7214605a998 — a chained-task job doesn't consume
    // when/start/cron, so it saves via a dedicated path (saveTemplateJob) that
    // skips those validations and calls the instantiateChain seam instead of a
    // single createTask. The title question doubles as the job's (parent
    // container's) title. A chain with no template can't be saved — the builder
    // blocks advancing past it (chainTemplatesValid), but this is the last line
    // of defense if that's ever bypassed (e.g. ⌘↵ from an earlier question).
    if (props.mode === 'create' && hasChainOption && templateChoice === 'chain') {
      if (!chainTemplatesValid) {
        const msg = 'Add at least one template to the chain.';
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
    // task-899af8b03aa6 — "Make this a template" is ON: the server auto-registers
    // a template only from a task that actually carries input-field definitions
    // (they become its variables), and there is NO explicit create-template API
    // to force it. So a template with zero inputs is meaningless — block the save
    // and send the user back to the fields step to add at least one variable (or
    // turn the toggle off). Only meaningful on a plain TypeBuild create (the only
    // path that writes structured fields); an EDIT can't re-register, so skip it.
    if (props.mode === 'create' && hasChainOption && templateChoice === 'blank' && makeTemplate) {
      const namedInputs = taskInputs.filter((f) => effectiveFieldKey(f));
      if (namedInputs.length === 0) {
        const msg = 'A template needs at least one input field (its variable). Add one on the Inputs & outputs step, or turn off "Make this a template".';
        setError(msg);
        setActiveIdx(QUESTIONS.indexOf('fields'));
        return { ok: false, error: msg };
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
      let variablesForSave: TaskDefField[] | undefined;
      let dataForSave: Record<string, string> | undefined;
      if (hasChainOption && templateChoice === 'blank') {
        // task-0d63c7b0ebdb — creation DEFINES the input fields but never asks
        // for their VALUES here. So we write each defined input KEY with an
        // EMPTY-STRING value: that carries the definition names onto the task's
        // `data`/`data_keys` (non-PHI keys, empty values) so the from-template
        // flow, the drawer's Inputs editor, and the "Press F to fill inputs
        // now" escape hatch (saveFillValues) have keys to populate later. Keys
        // are author-specified in the field-def sub-walk's `key` step
        // (task-342f3e151d99) — no label→key derivation step exists in this
        // composer, so we transport them verbatim, dropping only unnamed rows.
        const inputKeys: Record<string, string> = {};
        for (const f of taskInputs) {
          // task-f9a723379aa8 + task-0d63c7b0ebdb merged: normalize the key
          // exactly the way the values fix does (effectiveFieldKey: typed key
          // normalized, label fallback — so 'News site url' becomes a usable
          // key instead of silently dropping) — but write an EMPTY value:
          // creation DEFINES fields, never fills them.
          const key = effectiveFieldKey(f);
          if (!key) continue;
          inputKeys[key] = '';
        }
        if (Object.keys(inputKeys).length > 0) {
          dataForSave = inputKeys;
        }
        // task-73f6304ffb94 follow-up — the input DEFINITIONS (key/label/type/
        // options/required + the key-picker's `source` binding) ride the create
        // as `variables`. The server's auto-register hook only registers a
        // Template when the payload carries `variables` or `output_schema` —
        // input keys alone (the empty data-bag entries above) register NOTHING,
        // which silently dropped every input-only "make this a template" save.
        // NON-PHI: field definitions only, never values.
        const inputDefs = taskInputs
          .map((f) => ({ ...f, key: effectiveFieldKey(f) }))
          .filter((f) => !!f.key);
        if (inputDefs.length > 0) {
          variablesForSave = inputDefs;
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
              // task-464e739dc9fa — the group is NOT sent: it lives on the
              // project now. The server derives the task's group from the
              // resolved (explicit or per-user default) project and 422s a
              // client-sent group_id. props.groupId remains a VIEW scope only
              // (member picker, list filtering).
              // task-896f3f7f5e75 — the chosen agent rides the create as
              // `agentId` (TaskCreate models it; the TypeBuild source maps it to
              // `agent_id`). '' (None) → omit the key so a create that doesn't
              // care leaves the server default (no agent). Non-PHI.
              ...(agentId ? { agentId } : {}),
              // task-fd1be6f6b22d — a human "Who runs this?" pick assigns the
              // manual task to that member (server `assigned_to`). '' (Claude
              // Code / unassigned) omits the key so the server default holds.
              ...(assignedTo ? { assignedTo } : {}),
              // task-a7214605a998 (S6) — structured output schema (NON-PHI) +
              // data map (PHI) built above, in place of the fenced blocks this
              // composer used to splice into `notes`. Omitted when the plain
              // task defines no fields, same as the fenced-block path before it
              // (NON-REGRESSION).
              ...(outputSchemaForSave ? { outputSchema: outputSchemaForSave } : {}),
              ...(variablesForSave ? { variables: variablesForSave } : {}),
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
        // task-fd1be6f6b22d — human assignee (server `assigned_to`). '' clears
        // it (Claude Code / unassigned); only send a real change. The patch
        // whitelist in the TypeBuild source already accepts assigned_to.
        if (assignedTo !== (initial?.assignedTo ?? '')) {
          patch.assigned_to = assignedTo;
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
      // task-0d63c7b0ebdb — a plain create that DEFINED input fields (but,
      // by design, collected no values) can offer the "fill inputs now" escape
      // hatch: hold the success flash open (no auto-exit) so the human can
      // press F to fill the values onto this task now, or Esc to finish.
      const canFillNow =
        props.mode === 'create' &&
        hasChainOption &&
        templateChoice === 'blank' &&
        taskInputs.some((f) => f.key.trim().length > 0);
      if (props.embedded) {
        // task-b30e546672db — stay mounted inside the dialog: flash "saved",
        // let the host refresh, then clear the flash so the form is editable
        // again (don't tear down the whole dialog on a field edit).
        props.onSaved?.();
        setBusy(false);
        setTimeout(() => setCreated(false), 1400);
      } else if (canFillNow) {
        setCreatedTaskId(savedId);
        setBusy(false);
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

  // task-a7214605a998 — the three thunks instantiateChain wires to real bridge
  // calls. A chain = an ordered list of SAVED TEMPLATES, so creating it is:
  //   createParent           → fm.tasksCreate (a thin { title, projectId } job)
  //   instantiateChainTemplate → fm.typebuild.templates.instantiate (POST
  //                            /chromeext/templates/{id}/instantiate — one real
  //                            task inheriting the template's fields)
  //   linkChainTask          → sourceAction('patch') → PATCH parent_task_id +
  //                            depends_on (the instantiate endpoint accepts
  //                            NEITHER, so linkage is a second pass; the source's
  //                            patch whitelist now forwards both).
  // The chain is a TypeBuild feature, so children/link go through the TypeBuild
  // source (children inherit their template's project/agent/flags; the parent
  // carries the chain name + project).
  async function createChainParent(input: {
    title: string;
    projectId?: string;
  }): Promise<{ id: string }> {
    const payload: TaskCreate = {
      title: input.title,
      folder: '',
      notes: '',
      auto_mode: false,
      auto_agent: null,
      auto_prompt: null,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    };
    const t = await createTask(payload, target);
    return { id: t.id };
  }
  async function instantiateChainTemplate(
    templateId: string,
  ): Promise<{ id: string }> {
    // Empty values — creation defines the child's fields (inherited from the
    // template) but never collects their values here; they're filled later via
    // the drawer/roster inline edit.
    const r = await fm.typebuild.templates.instantiate(templateId, {});
    return { id: r.id };
  }
  async function linkChainTask(
    taskId: string,
    patch: { parentTaskId: string; dependsOn?: string[] },
  ): Promise<void> {
    const body: Record<string, unknown> = { parent_task_id: patch.parentTaskId };
    if (patch.dependsOn && patch.dependsOn.length > 0) {
      body.depends_on = patch.dependsOn;
    }
    await taskSourceAction(target, taskId, 'patch', body);
  }

  // task-a7214605a998 — save path for a chained-task job: a thin parent
  // container + one child per SAVED TEMPLATE (instantiated in order, linked
  // parent + predecessor), via the instantiateChain seam. Never creates a
  // single plain task when a chain was chosen. `chainTemplates` — the ordered
  // list of templates the human picked — is passed straight through.
  async function saveTemplateJob(): Promise<{ ok: boolean; taskId?: string; error?: string }> {
    setBusy(true);
    setError(null);
    try {
      const result = await instantiateChain({
        name: title.trim(),
        projectId: projectId || undefined,
        templates: chainTemplates.map((t) => ({
          templateId: t.templateId,
          name: t.name,
        })),
        createParent: createChainParent,
        instantiateTemplate: (templateId) => instantiateChainTemplate(templateId),
        linkTask: linkChainTask,
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

  // task-0d63c7b0ebdb — save path for the "fill inputs now" escape hatch: write
  // the values the human just entered in the fill walk onto the ALREADY-CREATED
  // plain task, through the EXACT data-bag path the drawer's Inputs editor uses
  // (fm.typebuild.taskData.patch → resolve-merge-replace in main) — not a new
  // write path. The defined input KEYS were seeded (empty) at create time, so
  // we upsert every defined key with its current value ('' left as-is) and pass
  // them all as the known sibling keys so the merge preserves the full bag. PHI:
  // the values ride the encrypted patch, never logged.
  async function saveFillValues(): Promise<{ ok: boolean; taskId?: string; error?: string }> {
    if (busy) return { ok: false, error: 'Already saving.' };
    if (!createdTaskId) return { ok: false, error: 'No task to fill.' };
    setBusy(true);
    setError(null);
    try {
      const upsert: Record<string, string> = {};
      const keys: string[] = [];
      for (const f of taskInputs) {
        const key = f.key.trim();
        if (!key) continue;
        keys.push(key);
        upsert[key] = templateValues[fieldRef('task', key)] ?? '';
        if (f.source && 'connectionId' in f.source) {
          // task-8f27d842f14d — Connection form: the onSelectSource handler
          // already fanned the picked row's bundle into `<key>.*` sibling
          // entries on templateValues (ref/connection_id/connection_version/
          // picked_at + every bundled field) — sweep every `<key>.` prefixed
          // entry so it rides the SAME patch call, not a second write.
          const prefix = fieldRef('task', `${key}.`);
          for (const [ref, v] of Object.entries(templateValues)) {
            if (!ref.startsWith(prefix)) continue;
            const suffix = ref.slice(fieldRef('task', key).length + 1); // "<key>." dropped
            keys.push(`${key}.${suffix}`);
            upsert[`${key}.${suffix}`] = v;
          }
        } else {
          // task-73f6304ffb94 / task-e085ebbdb23f — a source-backed field's
          // pick also carries the opaque record ref on a sibling `<key>.ref`
          // entry (see FieldValueEditor's onSelectSource); this was
          // previously dropped here, so the filled task pointed only at the
          // typed-looking LABEL, never the real record (part of the reported
          // "wrong type" fill bug — saveFromTemplate already did this
          // correctly).
          const refVal = templateValues[fieldRef('task', `${key}.ref`)];
          if (refVal) {
            keys.push(`${key}.ref`);
            upsert[`${key}.ref`] = refVal;
          }
        }
      }
      const res = await fm.typebuild.taskData.patch(createdTaskId, upsert, [], keys);
      if (!res.ok) {
        const msg = res.error || 'Could not save the inputs.';
        setError(msg);
        setBusy(false);
        return { ok: false, error: msg };
      }
      setCreated(true);
      setTimeout(() => exit(), 900);
      return { ok: true, taskId: createdTaskId };
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

    // task-257bb4870c6c — "New from Template" is a SEPARATE, self-contained
    // keyboard walk (picker → title → values → Ctrl+Enter creates) — it never
    // touches the main QUESTIONS/active machinery above, unless the human hit
    // "edit details" (templateEditDetails), which falls through into the
    // ordinary flow below so the rest of this handler applies as normal.
    if (isFromTemplateMode && !templateEditDetails) {
      if (e.key === 'Escape') { e.preventDefault(); tryCancel(); return; }
      if (templatePickPhase === 'pick') {
        if (inText()) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setTemplatePickHighlight((h) => Math.min(h + 1, Math.max(0, filteredTemplateCandidates.length - 1)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setTemplatePickHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const entry = filteredTemplateCandidates[templatePickHighlight];
            if (entry) chooseTemplateEntry(entry);
          }
        }
        return;
      }
      if (templatePickPhase === 'title') {
        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          acceptTemplateTitle();
        } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          void saveFromTemplate();
        }
        return;
      }
      // 'values'
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void saveFromTemplate();
        return;
      }
      if (inText()) return;
      const activeEntry = templateFillActiveRef;
      if (!activeEntry) return;
      const ref = activeEntry.ref;
      const optionType = isFieldOptionType(activeEntry.field);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (optionType) {
          const opts = fieldOptionList(activeEntry.field);
          const h = templateFillHighlight[ref] ?? 0;
          if (h >= opts.length - 1) {
            setTemplateFillActiveIdx((i) => Math.min(i + 1, templateEntryFieldEntries.length - 1));
          } else {
            setTemplateFillHighlight((prev) => ({ ...prev, [ref]: h + 1 }));
          }
        } else {
          setTemplateFillActiveIdx((i) => Math.min(i + 1, templateEntryFieldEntries.length - 1));
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setTemplateFillActiveIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (optionType) {
          const opts = fieldOptionList(activeEntry.field);
          const h = templateFillHighlight[ref] ?? 0;
          setTemplateFillValue(ref, opts[h]?.value ?? '');
        }
        if (templateFillActiveIdx >= templateEntryFieldEntries.length - 1) {
          void saveFromTemplate();
        } else {
          setTemplateFillActiveIdx((i) => i + 1);
        }
      }
      return;
    }

    // task-0d63c7b0ebdb — while the success flash is offering the escape hatch
    // (a plain create that defined inputs, not yet filling), F enters the
    // values-only fill walk and Esc finishes; swallow everything else so a
    // stray key doesn't fall through into the (now stale) question flow.
    if (created && createdTaskId && !fillMode) {
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); enterFillMode(); return; }
      if (e.key === 'Escape') { e.preventDefault(); exit(); return; }
      return;
    }

    // task-0d63c7b0ebdb — in the fill walk the accelerator/commit save the
    // input VALUES onto the created task (saveFillValues), not create a task.
    const submitNow = () => void (fillMode ? saveFillValues() : save());

    // task-342f3e151d99 — Escape while a field is being added/edited cancels
    // JUST that draft (never inserted, or edits discarded — see
    // cancelFieldDraft), not the whole composer. Must run before the
    // composer-wide Escape-Escape-cancels handling below.
    if (fieldDraft && e.key === 'Escape') { e.preventDefault(); cancelFieldDraft(); return; }

    if (e.key === 'Escape') { e.preventDefault(); tryCancel(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submitNow();
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
        submitNow();
        return;
      }
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        submitNow();
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
    // task-342f3e151d99 — belt and braces: the key/label/options steps are TEXT
    // entry. inText() already returns when their input holds focus, but if focus
    // is ever lost (a step change, a re-render) the bare-letter shortcuts below
    // must NOT fire — typing "test" into an output key once toggled "Make this a
    // template" on the 't'. A text step never binds a bare letter.
    if (
      active === 'field-draft' &&
      fieldDraft &&
      (fieldDraft.step === 'key' || fieldDraft.step === 'label' || fieldDraft.step === 'options')
    ) {
      if (e.key === 'Escape') { e.preventDefault(); cancelFieldDraft(); return; }
      if (e.key === 'Enter') { e.preventDefault(); advanceFieldDraft(); return; }
      return;
    }

    if (e.key === 'ArrowDown') { e.preventDefault(); moveDown(); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveUp();   return; }

    // task-f5a318566148 — 'A' expands/collapses the ADVANCED options section.
    // Safe as a bare letter here: title/text inputs already returned via the
    // guards above, and no option question binds a letter shortcut (the When
    // quick-picks are W/F/M). Mirrors the commit-phase C/E letter convention.
    if ((e.key === 'a' || e.key === 'A') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      toggleAdvanced();
      return;
    }

    // task-899af8b03aa6 — 'T' toggles "Make this a template" and jumps to the
    // step. Same bare-letter safety as 'A' (text inputs already returned via the
    // guards above; no option question binds T — the When quick-picks are W/F/M).
    // Only when the step exists (TypeBuild, not chain / from-template picker).
    if (
      (e.key === 't' || e.key === 'T') &&
      !e.metaKey && !e.ctrlKey && !e.altKey &&
      templateStepAvailable
    ) {
      e.preventDefault();
      setMakeTemplate((v) => !v);
      const ti = QUESTIONS.indexOf('template');
      if (ti >= 0) setActiveIdx(ti);
      return;
    }

    // task-342f3e151d99 — `i` adds an input, `o` adds an output, from THIS
    // (the MAIN) window handler — not a nested one — anywhere in the
    // Inputs/Outputs region (the header, an existing row being reviewed, or
    // while a draft's OPTION steps — source/type/required — are active; text
    // steps already returned above via inText()). Mirrors A/T's bare-letter
    // safety: text inputs are already handled, no option question binds i/o.
    if (
      !e.metaKey && !e.ctrlKey && !e.altKey &&
      (active === 'fields' || active === 'outputs' || isFieldRowQuestion(active) || active === 'field-draft')
    ) {
      if (e.key === 'i' || e.key === 'I') { e.preventDefault(); startFieldDraft('inputs'); return; }
      if (e.key === 'o' || e.key === 'O') { e.preventDefault(); startFieldDraft('outputs'); return; }
    }

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
      if (!Number.isNaN(n) && n >= 1 && n <= whoOptions.length) {
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
    // task-899af8b03aa6 — "Make this a template" yes/no (mirrors pin).
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
    // task-f5a318566148 — launch flags (multi-select). Enter toggles the
    // highlighted flag; digits 1..N toggle by index. Neither advances (↓ off
    // the last flag advances) — the multi-select analog of the option pickers.
    if (active === 'flags') {
      if (e.key === 'Enter') {
        e.preventDefault();
        chooseFlag(flagsHighlight);
        return;
      }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= FLAG_OPTIONS.length) {
        e.preventDefault();
        chooseFlag(n - 1);
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
    // task-342f3e151d99 — the Inputs/Outputs section headers are just an
    // explainer + the `i`/`o` shortcut (handled above); Enter advances into
    // the first field-row (if any) or the next real question, same as ↓.
    if (active === 'fields' || active === 'outputs') {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (QUESTIONS.indexOf(active) >= QUESTIONS.length - 1) enterCommitPhase();
        else goNext();
        return;
      }
      return;
    }
    // task-342f3e151d99 — a field-row REVIEWS an already-defined field; Enter
    // steps into its sub-walk to edit it (⌘/Ctrl+⌫ removes it outright — same
    // accelerator the old grid used). No option list, no digit picking here —
    // that's the field-draft's job below.
    if (isFieldRowQuestion(active)) {
      const row = parseFieldRowQId(active);
      if (row) {
        if (e.key === 'Enter') {
          e.preventDefault();
          startEditFieldRow(row.kind, row.idx);
          return;
        }
        if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace') {
          e.preventDefault();
          removeTaskField(row.kind, row.idx);
          return;
        }
      }
      return;
    }
    // task-342f3e151d99 — the field-DEFINITION sub-walk. The 'source' step
    // (inputs only, new fields only) and 'type'/'required' steps are OPTION
    // questions (digits/Enter pick, same grammar as everywhere else); 'key'/
    // 'label'/'options' are free text, handled by field-draft's own <input
    // onKeyDown> below (the inText() guard above already returned for them).
    if (active === 'field-draft' && fieldDraft) {
      if (fieldDraft.step === 'source') {
        // The focused FieldSourcePicker owns this step's keys (arrows/digits/
        // Enter/Escape/type-to-search). Yield rather than double-handle — its
        // React onKeyDown preventDefaults but still bubbles to this window
        // listener. Its onCancel() is what cancels the draft on Escape.
        return;
      }
      if (fieldDraft.step === 'type') {
        // chooseFieldDraftType both sets the type AND advances (same
        // "choose picks + advances" convention as chooseWho/chooseFolderPreset
        // etc. elsewhere) — it has to, since the NEXT step depends on the type
        // just picked (see its own comment on the stale-closure hazard).
        if (e.key === 'Enter') {
          e.preventDefault();
          chooseFieldDraftType(fieldDraftHighlight);
          return;
        }
        const n = parseInt(e.key, 10);
        if (!Number.isNaN(n) && n >= 1 && n <= FIELD_TYPE_OPTIONS.length) {
          e.preventDefault();
          chooseFieldDraftType(n - 1);
          return;
        }
        return;
      }
      if (fieldDraft.step === 'required') {
        if (e.key === 'Enter') {
          e.preventDefault();
          chooseFieldDraftRequired(fieldDraftHighlight);
          return;
        }
        const n = parseInt(e.key, 10);
        if (!Number.isNaN(n) && n >= 1 && n <= FIELD_REQUIRED_OPTIONS.length) {
          e.preventDefault();
          chooseFieldDraftRequired(n - 1);
          return;
        }
        return;
      }
      // 'key' / 'label' / 'options' — free text, own <input onKeyDown> below.
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
    if (executor === 'claude') return WHO_CLAUDE.label;
    // task-fd1be6f6b22d — show the assignee even if they're not in the loaded
    // member list (e.g. editing a task whose assignee left the group).
    if (assignedTo) {
      const opt = whoOptions.find((o) => o.kind === 'human' && o.email === assignedTo);
      return opt?.label ?? assignedTo;
    }
    return whoOptions[whoSelectionIndex()]?.label ?? 'Manual';
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
  // task-899af8b03aa6 — collapsed answer for the "Make this a template" step.
  function templateSummary(): string {
    return makeTemplate ? 'Template' : 'Just this task';
  }
  // task-f5a318566148 — the ON launch flags, by label, or "None".
  function flagsSummary(): string {
    const on = FLAG_OPTIONS.filter((o) => flags.has(o.id)).map((o) => o.label);
    return on.length ? on.join(', ') : 'None';
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
    if (q === 'template') return templateSummary();
    if (q === 'flags') return flagsSummary();
    if (q === 'notes') return notesSummary();
    if (q === 'chain') return chainSummary();
    if (q === 'fields') return fieldsSummary();
    if (q === 'outputs') return outputsSummary();
    if (isFieldQuestion(q)) return fieldAnswer(q);
    if (isFieldRowQuestion(q)) return fieldRowAnswer(q);
    return '';
  }
  // task-342f3e151d99 — one field-row's inert summary: "key (type)".
  function fieldRowAnswer(q: QuestionId): string {
    const row = parseFieldRowQId(q);
    if (!row) return '';
    const field = (row.kind === 'inputs' ? taskInputs : taskOutputs)[row.idx];
    if (!field) return '';
    return `${field.key || field.label || '(unnamed)'} (${field.type})`;
  }

  // task-2fd63b922beb / task-a7214605a998 — chain/field/outputs summaries. The
  // chain summary reads the ordered template names.
  function chainSummary(): string {
    if (chainTemplates.length === 0) return 'No templates added yet';
    return chainTemplates.map((t) => t.name).join(' → ');
  }
  // task-342f3e151d99 — Inputs and Outputs are now separate sections, each
  // summarized by its own count (was one combined "N inputs, N outputs").
  function fieldsSummary(): string {
    const ni = taskInputs.filter((f) => f.key.trim()).length;
    if (ni === 0) return 'None yet — press i to add one';
    return `${ni} input${ni === 1 ? '' : 's'}`;
  }
  function outputsSummary(): string {
    const total = definedOutputsCount;
    if (total === 0) return 'None yet — press o to add one';
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
    if (q === 'template') return 'template';
    if (q === 'flags') return 'flags';
    if (q === 'notes') return 'notes';
    if (q === 'chain') return 'chain';
    if (q === 'fields') return 'inputs';
    if (q === 'outputs') return 'outputs';
    if (isFieldQuestion(q)) {
      const entry = fieldEntryFor(q);
      return entry ? `${entry.taskDef.name} · ${entry.field.label}` : null;
    }
    if (isFieldRowQuestion(q)) {
      const row = parseFieldRowQId(q);
      return row ? (row.kind === 'inputs' ? 'input' : 'output') : null;
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
    if (q === 'template') return 'Make this a template?';
    if (q === 'flags') return 'Launch flags?';
    if (q === 'notes') {
      return executor === 'claude'
        ? "What should the agent do? (this becomes the prompt)"
        : 'Any notes?';
    }
    // task-2fd63b922beb / task-a7214605a998 — a chain is an ordered list of
    // saved templates.
    if (q === 'chain') return 'Add templates to the chain, in order';
    // task-342f3e151d99 — INPUTS and OUTPUTS are now two separate, explained
    // sections (task-342f3e151d99's "field-def walk").
    if (q === 'fields') {
      return 'Inputs — placeholders this task needs each time it runs (e.g. patient, date). You name them now; you fill them when you run the task.';
    }
    if (q === 'outputs') {
      return 'Outputs — what the agent must return as evidence when it finishes (e.g. confirmation number).';
    }
    if (isFieldQuestion(q)) {
      const entry = fieldEntryFor(q);
      return entry?.field.label ?? '';
    }
    if (isFieldRowQuestion(q)) return 'Reviewing a field — press ↵ to edit it.';
    if (q === 'field-draft' && fieldDraft) return fieldDraftPrompt(fieldDraft);
    return '';
  }
  // task-342f3e151d99 — the sub-walk's per-step question text.
  function fieldDraftPrompt(d: FieldDraft): string {
    const noun = d.kind === 'inputs' ? 'input' : 'output';
    switch (d.step) {
      case 'source': return `Where does this ${noun}'s value come from?`;
      case 'key': return `What's the key for this ${noun}? (used in the task data)`;
      case 'label': return `What should we call it?`;
      case 'type': return 'What type is it?';
      case 'options': return 'Options, comma-separated';
      case 'required': return 'Is this required as evidence?';
      default: return '';
    }
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
    // task-342f3e151d99 — the sub-walk's step label, e.g. "Input · key".
    if (id === 'field-draft' && fieldDraft) return `${fieldDraft.kind === 'inputs' ? 'Input' : 'Output'} · ${fieldDraft.step}`;
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

  // task-0d63c7b0ebdb — one input field's VALUE question. Rendered only in the
  // escape hatch's fill walk (creation never asks these). Uses the SAME
  // FieldValueEditor (task-e085ebbdb23f) the New-from-Template 'values' phase
  // uses below — this is the fix for the reported bug where a source-bound
  // field rendered as a bare text box here (no `source` branch existed) instead
  // of the SourceTypeahead the template-fill phase always had.
  function renderFieldQuestion(taskDef: TaskDef, field: TaskDefField) {
    const ref = fieldRef(taskDef.id, field.key);
    const qid = fieldQId(taskDef.id, field.key);
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
            <FieldValueEditor
              field={field}
              value={value}
              highlight={highlight}
              inputRef={setFieldInputRef(ref)}
              onSelectOption={(opts, i) => chooseFieldOption(ref, opts, i)}
              onHighlightOption={(i) => setTemplateFieldHighlight((prev) => ({ ...prev, [ref]: i }))}
              onChangeText={(v) => setTemplateValue(ref, v)}
              onSubmitText={() => fieldAdvance()}
              onSelectSource={(label, qref, row) => {
                setTemplateValue(ref, label);
                if (row && field.source && 'connectionId' in field.source) {
                  // task-8f27d842f14d — Connection form: fan the WHOLE picked
                  // row's bundle into `<fieldKey>.*` sibling keys (+
                  // provenance), same taskData.patch upsert saveFillValues
                  // reads back below. Clear any stale sibling from a PRIOR
                  // pick first so a changed bundle/row shape never leaves an
                  // orphan (connectionBundleKeys covers both this pick and any
                  // earlier one via prefix, not just today's field names).
                  const stale = connectionBundleKeys(field.key, Object.keys(templateValues).map((k) => k.slice(taskDef.id.length + 1)));
                  for (const k of stale) setTemplateValue(fieldRef(taskDef.id, k), '');
                  const { upsert } = snapshotConnectionRow(field.key, field.source, row);
                  for (const [k, v] of Object.entries(upsert)) setTemplateValue(fieldRef(taskDef.id, k), v);
                } else {
                  // task-73f6304ffb94 — SavedQuery form: the opaque record ref
                  // rides a sibling `<key>.ref` key, same convention
                  // saveFromTemplate/the values phase use, so saveFillValues
                  // (fixed alongside this) can thread it into the data-bag
                  // patch instead of dropping it.
                  setTemplateValue(fieldRef(taskDef.id, `${field.key}.ref`), JSON.stringify(qref));
                }
                fieldAdvance();
              }}
            />
          </div>
        ) : (
          renderInert(qid)
        )}
      </section>
    );
  }

  // task-e085ebbdb23f — the ONE field-VALUE renderer shared by the fill-mode
  // walk (renderFieldQuestion above) and the New-from-Template 'values' phase
  // below, killing the near-verbatim duplication between them (option list /
  // SourceTypeahead / typed input, each with its own digit-key rendering).
  // State stays separate (templateValues/templateFillValues, different highlight
  // maps, different advance semantics) — only the RENDERING + option/typeahead
  // behavior is consolidated, via callbacks.
  function FieldValueEditor({
    field,
    value,
    highlight,
    autoFocus,
    inputRef,
    onSelectOption,
    onHighlightOption,
    onChangeText,
    onSubmitText,
    onSelectSource,
  }: {
    field: TaskDefField;
    value: string;
    highlight: number;
    autoFocus?: boolean;
    inputRef?: (el: HTMLInputElement | null) => void;
    onSelectOption: (opts: { value: string; label: string }[], i: number) => void;
    onHighlightOption: (i: number) => void;
    onChangeText: (v: string) => void;
    onSubmitText: () => void;
    // task-8f27d842f14d — `row` carries the WHOLE picked row (ref + every
    // declared field) for a Connection-bound field, so callers can snapshot
    // its bundle into `<fieldKey>.*` sibling keys; undefined for the
    // SavedQuery form (only `ref` is durable there, unchanged behavior).
    onSelectSource: (label: string, ref: QueryRef | ConnectionRef, row?: ConnectionLookupRow) => void;
  }) {
    const optionType = isFieldOptionType(field);
    if (optionType) {
      const opts = fieldOptionList(field);
      return (
        <ul className="composer__options" role="listbox">
          {opts.map((o, i) => (
            <li key={o.value}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlight}
                className={'composer__option' + (i === highlight ? ' composer__option--active' : '')}
                onMouseEnter={() => onHighlightOption(i)}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectOption(opts, i);
                }}
              >
                <kbd className="composer__option-key">{i + 1}</kbd>
                <span className="composer__option-label">{o.label}</span>
              </button>
            </li>
          ))}
        </ul>
      );
    }
    if (field.source) {
      // task-73f6304ffb94 — search the bound SavedQuery live; picking a row
      // records the display label as the value AND the opaque ref on a
      // sibling `<key>.ref` entry (the caller's onSelectSource threads it).
      return <SourceTypeahead field={field} display={value || undefined} onSelect={onSelectSource} />;
    }
    return (
      <input
        ref={inputRef}
        className="composer__path-input"
        type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChangeText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
            onSubmitText();
          }
        }}
        spellCheck={false}
        autoComplete="off"
      />
    );
  }

  // task-342f3e151d99 — one already-defined field, walkable in the main
  // activeIdx cursor via its `field-row:<kind>:<idx>` QuestionId. Enter steps
  // into its sub-walk (startEditFieldRow, wired in the keydown handler); this
  // component only renders — FieldRowSummary is the presentational shell.
  function renderFieldRow({
    kind,
    idx,
    field,
    onRemove,
    onClearSource,
  }: {
    kind: FieldKind;
    idx: number;
    field: TaskDefField;
    onRemove: () => void;
    onClearSource: () => void;
  }) {
    const qid = fieldRowQId(kind, idx);
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
            <FieldRowSummary
              field={field}
              showRequired={kind === 'outputs'}
              active
              onRemove={onRemove}
              onClearSource={onClearSource}
            />
          </div>
        ) : (
          renderInert(qid)
        )}
      </section>
    );
  }

  // task-342f3e151d99 — the field-definition sub-walk's single slot. One
  // question per internal step (source/key/label/type/options/required — see
  // fieldDraftSteps in taskSchema.mjs); step transitions are driven by the
  // keydown handler + advanceFieldDraft/retreatFieldDraft/pickSourceStepOption/
  // chooseFieldDraftType/chooseFieldDraftRequired above. Renders only while a
  // draft is open — the caller guards on `fieldDraft`.
  // task-342f3e151d99 — the sub-walk's full step list INCLUDING the 'source'
  // step (which only a NEW input has; taskSchema.fieldDraftSteps models the
  // shared key/label/type/[options]/[required] tail that also runs on edit).
  function draftStepList(d: FieldDraft): FieldDraftStepId[] {
    const head: FieldDraftStepId[] = d.kind === 'inputs' && d.editIdx === null ? ['source'] : [];
    return [...head, ...(fieldDraftSteps(d.kind, d.field.type) as FieldDraftStepId[])];
  }
  // task-342f3e151d99 — the sub-walk's step chips: a short name and, once
  // answered, the value the user gave. Kept next to the render so the two stay
  // in step (pun intended) with fieldDraftSteps.
  function fieldDraftStepLabel(s: FieldDraftStepId): string {
    switch (s) {
      case 'source': return 'source';
      case 'key': return 'key';
      case 'label': return 'label';
      case 'type': return 'type';
      case 'options': return 'options';
      case 'required': return 'evidence';
      default: return s;
    }
  }
  function fieldDraftStepAnswer(d: FieldDraft, s: FieldDraftStepId): string {
    switch (s) {
      case 'source': return d.field.source ? 'API field' : 'custom';
      case 'key': return d.field.key;
      case 'label': return d.field.label;
      case 'type': return d.field.type;
      case 'options': return (d.field.options ?? []).join(', ');
      case 'required': return d.field.required ? 'required' : 'optional';
      default: return '';
    }
  }

  // task-342f3e151d99 — these are render FUNCTIONS, not nested components.
  // Declaring a component inside the parent gives it a NEW identity on every
  // render, so React unmounts and remounts its subtree — the draft's <input>
  // lost focus after each keystroke, and the stray letters fell through to the
  // window handler (typing "test" into an output key hit the bare-'t' shortcut
  // and toggled "Make this a template"). Calling them keeps one stable tree.
  // task-342f3e151d99 — the live control for whichever step is current.
  // Split out of the section render so each draft ROW can host it.
  function renderFieldDraftControl(d: FieldDraft) {
    return (
      <>
          {d.step === 'source' && (
            // task-342f3e151d99 — the real picker: Custom is always option 1,
            // then the top source-backed fields, then "Browse all…" (pick a
            // source → pick its field) once the list outgrows a flat menu or
            // more than one source exists. Typing searches across every source,
            // exactly like the project question's "top few, search for the
            // rest". It owns the keys WHILE FOCUSED — the window walk yields
            // for this step (see the `step === 'source'` early-return), so
            // there is still only one live handler at a time.
            <FieldSourcePicker
              existingKeys={taskInputs.map((f) => f.key).filter(Boolean)}
              autoFocus
              onPick={(built) =>
                setFieldDraft((prev) => (prev ? { ...prev, field: built, step: 'key' } : prev))
              }
              onCustom={() =>
                setFieldDraft((prev) =>
                  prev ? { ...prev, field: { key: '', label: '', type: 'text' }, step: 'key' } : prev,
                )
              }
              onCancel={() => cancelFieldDraft()}
            />
          )}
          {(d.step === 'key' || d.step === 'label') && (
            <input
              ref={fieldDraftInputRef}
              className="composer__path-input"
              type="text"
              placeholder={d.step === 'key' ? 'key' : 'label'}
              value={d.step === 'key' ? d.field.key : d.field.label}
              onChange={(e) =>
                updateFieldDraft(d.step === 'key' ? { key: e.target.value } : { label: e.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  advanceFieldDraft();
                }
              }}
              spellCheck={false}
              autoComplete="off"
            />
          )}
          {d.step === 'type' && (
            <ul className="composer__options" role="listbox">
              {FIELD_TYPE_OPTIONS.map((t, i) => (
                <li key={t}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === fieldDraftHighlight}
                    className={
                      'composer__option' + (i === fieldDraftHighlight ? ' composer__option--active' : '')
                    }
                    onMouseEnter={() => setFieldDraftHighlight(i)}
                    onClick={(e) => {
                      e.stopPropagation();
                      chooseFieldDraftType(i);
                    }}
                  >
                    <kbd className="composer__option-key">{i + 1}</kbd>
                    <span className="composer__option-label">{t}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {d.step === 'options' && (
            <input
              ref={fieldDraftInputRef}
              className="composer__path-input"
              type="text"
              placeholder="options, comma-separated"
              value={(d.field.options ?? []).join(', ')}
              onChange={(e) =>
                updateFieldDraft({
                  options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  advanceFieldDraft();
                }
              }}
              spellCheck={false}
              autoComplete="off"
            />
          )}
          {d.step === 'required' && (
            <ul className="composer__options" role="listbox">
              {FIELD_REQUIRED_OPTIONS.map((o, i) => (
                <li key={String(o.value)}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === fieldDraftHighlight}
                    className={
                      'composer__option' + (i === fieldDraftHighlight ? ' composer__option--active' : '')
                    }
                    onMouseEnter={() => setFieldDraftHighlight(i)}
                    onClick={(e) => {
                      e.stopPropagation();
                      chooseFieldDraftRequired(i);
                    }}
                  >
                    <kbd className="composer__option-key">{i + 1}</kbd>
                    <span className="composer__option-label">{o.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="composer__field-editors-hint" aria-hidden="true">
            ↵ next · ↑ back · esc cancel
          </div>
      </>
    );
  }

  function renderFieldDraft() {
    if (!fieldDraft) return null;
    const d = fieldDraft;
    return (
      <section
        ref={sectionRefFor('field-draft')}
        className={sectionClasses('field-draft') + ' composer__q--fields'}
        onClick={() => setActiveIdx(QUESTIONS.indexOf('field-draft'))}
      >
        <div className="composer__q-active-body">
          <FieldLabel id="field-draft" />
          {/* task-342f3e151d99 — the sub-walk EXPANDS into one visible row per
              question, not a single prompt swapping in place. The user must see
              how many questions define a field, what they already answered, and
              what is still coming. Answered rows show their value and are
              clickable to go back; the current row carries the live control;
              upcoming rows show their question, dimmed. Same shape as the main
              walk's answered/active/future questions. */}
          <ol className="composer__draft-steps">
            {draftStepList(d).map((s) => {
              const steps = draftStepList(d);
              const curIdx = steps.indexOf(d.step);
              const stepIdx = steps.indexOf(s);
              const done = stepIdx < curIdx;
              const isCur = s === d.step;
              return (
                <li
                  key={s}
                  className={
                    'composer__draft-row' +
                    (isCur ? ' composer__draft-row--active' : '') +
                    (done ? ' composer__draft-row--done' : ' composer__draft-row--future')
                  }
                  onClick={(e) => {
                    if (!done) return;
                    e.stopPropagation();
                    setFieldDraftHighlight(0);
                    setFieldDraft((prev) => (prev ? { ...prev, step: s } : prev));
                  }}
                >
                  <span className="composer__draft-row-label">{fieldDraftStepLabel(s)}</span>
                  {isCur ? (
                    <div className="composer__draft-row-body">
                      <div className="composer__q-prompt">{fieldDraftPrompt(d)}</div>
                      {renderFieldDraftControl(d)}
                    </div>
                  ) : done ? (
                    <span className="composer__draft-row-answer">
                      {fieldDraftStepAnswer(d, s) || '—'}
                    </span>
                  ) : (
                    <span className="composer__draft-row-todo">
                      {fieldDraftPrompt({ ...d, step: s })}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </section>
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
    // task-f5a318566148 — a copilot-set advanced field (status/priority/agent)
    // expands the ADVANCED section so the walk can reach it; index off the full
    // list so the pointer lands correctly on the same render.
    const full = advancedOpen ? QUESTIONS : [...mainQuestions, ...advancedQuestions];
    if (advancedQuestions.includes(q)) setAdvancedOpen(true);
    setActiveIdx((i) => Math.max(i, full.indexOf(q) + 1));
  }

  // task-257bb4870c6c — "New from Template" renders as its own minimal
  // surface: SELECT TEMPLATE → TITLE → per-step VALUES → Ctrl+Enter creates.
  // Project/notes/output schema/agent/flags/priority are inherited SILENTLY
  // from the picked template — never asked here — unless "edit details" was
  // pressed (templateEditDetails), in which case we fall through to the
  // ordinary composer render below (same component, full flow, template's
  // defs pre-loaded as chainDefs/taskInputs/taskOutputs by editTemplateDetails).
  if (isFromTemplateMode && !templateEditDetails) {
    return (
      <div
        className={'composer-pane' + (props.embedded ? ' composer-pane--embedded' : '')}
        data-state={state}
      >
        <div className="composer" role="region" aria-label="New from template" ref={sectionRef} tabIndex={-1}>
          <header className="composer__header">
            <div className="composer__crumb" id="composer-title">New from template</div>
          </header>
          <main className="composer__main">
            {templatePickPhase === 'pick' && (
              <div className="composer__q-active-body">
                <div className="composer__q-prompt">Pick a template</div>
                <input
                  className="composer__path-input"
                  type="text"
                  placeholder="Search templates by title…"
                  value={templatePickQuery}
                  autoFocus
                  onChange={(e) => {
                    setTemplatePickQuery(e.target.value);
                    setTemplatePickHighlight(0);
                  }}
                  spellCheck={false}
                  autoComplete="off"
                />
                {templatesLoading ? (
                  <div className="composer__q-prompt" style={{ marginTop: 12 }}>
                    Loading templates…
                  </div>
                ) : templatesError ? (
                  <div className="composer__error" role="alert" style={{ marginTop: 12 }}>
                    {templatesError}
                  </div>
                ) : templateCandidates.length === 0 ? (
                  <div className="composer__q-prompt" style={{ marginTop: 12 }}>
                    No templates yet — create a task with input fields and it's saved as a
                    template automatically.
                  </div>
                ) : (
                  <ul className="composer__options" role="listbox">
                    {filteredTemplateCandidates.map((c, i) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={i === templatePickHighlight}
                          className={
                            'composer__option' +
                            (i === templatePickHighlight ? ' composer__option--active' : '')
                          }
                          onMouseEnter={() => setTemplatePickHighlight(i)}
                          onClick={(e) => {
                            e.stopPropagation();
                            chooseTemplateEntry(c);
                          }}
                        >
                          <span className="composer__option-label">
                            {c.name}
                            {/* task-41e5fc25ed2b — mark ChainDef rows so a
                                multi-step workflow reads distinctly from a single
                                template. */}
                            {c.kind === 'chain' && (
                              <span className="composer__badge composer__badge--chain">Chain</span>
                            )}
                          </span>
                          <span className="composer__option-hint">
                            {c.kind === 'chain'
                              ? c.chain.steps.length === 1
                                ? '1 step'
                                : `${c.chain.steps.length} steps`
                              : c.template.variables.length === 1
                                ? '1 field'
                                : `${c.template.variables.length} fields`}
                          </span>
                        </button>
                      </li>
                    ))}
                    {filteredTemplateCandidates.length === 0 && (
                      <li className="composer__q-prompt">No templates match "{templatePickQuery}".</li>
                    )}
                  </ul>
                )}
              </div>
            )}
            {templatePickPhase !== 'pick' && templateEntry && (
              <>
                <section className={sectionClasses('title')} onClick={() => setTemplatePickPhase('title')}>
                  {templatePickPhase === 'title' ? (
                    <div className="composer__q-active-body">
                      <div className="composer__q-prompt">Title</div>
                      <div className="composer__title-row">
                        <input
                          ref={titleRef}
                          className="composer__title-input"
                          type="text"
                          value={title}
                          autoFocus
                          onChange={(e) => setTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                              e.preventDefault();
                              acceptTemplateTitle();
                            }
                          }}
                          spellCheck={false}
                          autoComplete="off"
                        />
                        <span
                          className={'composer__title-enter' + (title.trim() ? ' composer__title-enter--ready' : '')}
                          aria-hidden="true"
                        >
                          ↵
                        </span>
                      </div>
                      {templateEntryFieldEntries.length === 0 && (
                        <div className="composer__q-prompt" style={{ marginTop: 8, opacity: 0.7 }}>
                          This template has no inputs — it'll be created ready to run.
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="composer__q-inert">
                      <div className="composer__q-answer">{title}</div>
                    </div>
                  )}
                </section>
                {templatePickPhase === 'values' &&
                  (templateEntryFieldEntries.length === 0 ? (
                    <div className="composer__q-prompt">
                      This template has no input fields — press {submitKbd} to create.
                    </div>
                  ) : (
                    templateEntryFieldEntries.map(({ field, ref }, i) => {
                      const highlight = templateFillHighlight[ref] ?? 0;
                      const value = templateFillValues[ref] ?? '';
                      const isActive = i === templateFillActiveIdx;
                      const advance = () =>
                        setTemplateFillActiveIdx((n) => Math.min(n + 1, templateEntryFieldEntries.length - 1));
                      return (
                        <section
                          key={ref}
                          className={
                            'composer__q' + (isActive ? ' composer__q--active' : ' composer__q--inert')
                          }
                          onClick={() => setTemplateFillActiveIdx(i)}
                        >
                          {isActive ? (
                            <div className="composer__q-active-body">
                              <div className="composer__q-prompt">
                                {field.label || field.key}
                              </div>
                              {/* task-e085ebbdb23f — the SAME field-VALUE renderer
                                  the fill-mode walk uses (renderFieldQuestion),
                                  so a source-bound variable gets the SAME
                                  SourceTypeahead here as everywhere else. */}
                              <FieldValueEditor
                                field={field}
                                value={value}
                                highlight={highlight}
                                autoFocus
                                onSelectOption={(opts, oi) => {
                                  setTemplateFillValue(ref, opts[oi]?.value ?? '');
                                  advance();
                                }}
                                onHighlightOption={(oi) =>
                                  setTemplateFillHighlight((prev) => ({ ...prev, [ref]: oi }))
                                }
                                onChangeText={(v) => setTemplateFillValue(ref, v)}
                                onSubmitText={() => {
                                  if (i >= templateEntryFieldEntries.length - 1) void saveFromTemplate();
                                  else advance();
                                }}
                                onSelectSource={(label, qref, row) => {
                                  setTemplateFillValue(ref, label);
                                  if (templateEntry) {
                                    if (row && field.source && 'connectionId' in field.source) {
                                      // task-8f27d842f14d — Connection form:
                                      // fan the bundle into `<fieldKey>.*`
                                      // sibling keys (+ provenance); clear any
                                      // stale sibling from a prior pick first.
                                      const stale = connectionBundleKeys(
                                        field.key,
                                        Object.keys(templateFillValues).map((k) =>
                                          k.slice(templateEntry.id.length + 1),
                                        ),
                                      );
                                      for (const k of stale) {
                                        setTemplateFillValue(fieldRef(templateEntry.id, k), '');
                                      }
                                      const { upsert } = snapshotConnectionRow(field.key, field.source, row);
                                      for (const [k, v] of Object.entries(upsert)) {
                                        setTemplateFillValue(fieldRef(templateEntry.id, k), v);
                                      }
                                    } else {
                                      setTemplateFillValue(
                                        fieldRef(templateEntry.id, `${field.key}.ref`),
                                        JSON.stringify(qref),
                                      );
                                    }
                                  }
                                  advance();
                                }}
                              />
                            </div>
                          ) : (
                            <div className="composer__q-inert">
                              <div className="composer__q-answer">
                                {value || <span className="composer__q-prompt">{field.label || field.key}</span>}
                              </div>
                            </div>
                          )}
                        </section>
                      );
                    })
                  ))}
                {templatePickPhase === 'values' && !templateEditDetails && (
                  <button type="button" className="composer__cancel-btn" onClick={editTemplateDetails}>
                    Edit details…
                  </button>
                )}
              </>
            )}
          </main>
          <footer
            className={'composer__footer' + (templatePickPhase === 'values' ? ' composer__footer--active' : '')}
          >
            {created ? (
              <div className="composer__flash" role="status">✓ Task created</div>
            ) : (
              <>
                {error && <div className="composer__error" role="alert">{error}</div>}
                <button type="button" className="composer__cancel-btn" onClick={() => exit()}>
                  Cancel
                  <span className="composer__btn-kbd">esc</span>
                </button>
                {templatePickPhase !== 'pick' && (
                  <button
                    ref={createBtnRef}
                    type="button"
                    className="composer__create-btn composer__create-btn--ready"
                    onClick={() => void saveFromTemplate()}
                    disabled={busy || !templateEntry}
                  >
                    {busy ? 'Creating…' : 'Create task'}
                    <span className="composer__btn-kbd">{submitKbd}</span>
                  </button>
                )}
              </>
            )}
          </footer>
        </div>
      </div>
    );
  }

  // task-0d63c7b0ebdb — the "fill inputs now" escape hatch renders as its own
  // focused surface (not the full create wizard): a values-only walk over the
  // just-created task's defined inputs, reusing the SAME field-question render,
  // keyboard flow, and commit footer. Saving writes the values via the drawer's
  // data-bag path (saveFillValues). The window keydown handler + [active] focus
  // effect run regardless of which JSX we return, so navigation just works.
  if (fillMode) {
    return (
      <div
        className={'composer-pane' + (props.embedded ? ' composer-pane--embedded' : '')}
        data-state={state}
      >
        <div
          className="composer"
          role="region"
          aria-label="Fill inputs"
          ref={sectionRef}
          tabIndex={-1}
        >
          <header className="composer__header">
            <div className="composer__crumb" id="composer-title">Fill inputs</div>
          </header>
          <main className="composer__main">
            <div className="composer__fill-intro">
              Enter the values for the inputs you just defined, or press{' '}
              <kbd>{submitKbd}</kbd> to save at any time.
            </div>
            {templateFieldEntries.map(({ taskDef, field }) =>
              renderFieldQuestion(taskDef, field),
            )}
          </main>
          <footer
            className={
              'composer__footer' +
              (phase === 'commit' && !created ? ' composer__footer--active' : '')
            }
          >
            {created ? (
              <div className="composer__flash" role="status">✓ Inputs saved</div>
            ) : (
              <>
                {error && (
                  <div className="composer__error" role="alert">{error}</div>
                )}
                <button
                  type="button"
                  className="composer__cancel-btn"
                  onClick={() => exit()}
                  title="Finish without filling"
                >
                  Skip
                  <span className="composer__btn-kbd">
                    {phase === 'commit' ? 'E' : 'esc'}
                  </span>
                </button>
                <button
                  ref={createBtnRef}
                  type="button"
                  className={
                    'composer__create-btn' +
                    (phase === 'commit' ? ' composer__create-btn--ready' : '')
                  }
                  onClick={() => void saveFillValues()}
                  disabled={busy}
                >
                  {busy ? 'Saving…' : 'Save inputs'}
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
                  {/* task-a7214605a998 — a chain is an ORDERED LIST OF SAVED
                      TEMPLATES. This builder is a template PICKER + ordering,
                      with ZERO field/instruction editing (the templates own
                      their fields). Empty registry → prompt to create templates
                      first. */}
                  {templatesError ? (
                    <div className="composer__chain-empty">
                      Couldn’t load templates: {templatesError}
                    </div>
                  ) : templatesLoading && templates.length === 0 ? (
                    <div className="composer__chain-empty">Loading templates…</div>
                  ) : templates.length === 0 ? (
                    <div className="composer__chain-empty">
                      No saved templates yet. Create templates first (via “Make this
                      a template” on a task), then chain them here.
                    </div>
                  ) : (
                    <>
                      <ul className="composer__chain-steps">
                        {chainTemplates.length === 0 && (
                          <li className="composer__chain-empty">
                            No templates added yet — add one below.
                          </li>
                        )}
                        {chainTemplates.map((row, idx) => (
                          <li
                            key={`${row.templateId}:${idx}`}
                            className="composer__chain-step"
                          >
                            <div className="composer__chain-step-head">
                              <span className="composer__chain-step-num">{idx + 1}</span>
                              <span className="composer__chain-step-name">
                                {row.name}
                                <span className="composer__option-hint">
                                  {row.variables} input{row.variables === 1 ? '' : 's'}
                                  {' · '}
                                  {row.outputs} output{row.outputs === 1 ? '' : 's'}
                                </span>
                              </span>
                              <div className="composer__chain-step-actions">
                                <button
                                  type="button"
                                  className="composer__chain-icon-btn"
                                  title="Move up"
                                  disabled={idx === 0}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    moveChainTemplate(idx, -1);
                                  }}
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  className="composer__chain-icon-btn"
                                  title="Move down"
                                  disabled={idx === chainTemplates.length - 1}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    moveChainTemplate(idx, 1);
                                  }}
                                >
                                  ↓
                                </button>
                                <button
                                  type="button"
                                  className="composer__chain-icon-btn composer__chain-icon-btn--danger"
                                  title="Remove template"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeChainTemplate(idx);
                                  }}
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                      {chainPickerOpen ? (
                        (() => {
                          const q = chainPickerQuery.trim().toLowerCase();
                          const matches = templates.filter(
                            (t) => !q || t.name.toLowerCase().includes(q),
                          );
                          const hi = Math.min(chainPickerHighlight, Math.max(matches.length - 1, 0));
                          return (
                            <div className="composer__chain-picker" onClick={(e) => e.stopPropagation()}>
                              <input
                                className="composer__chain-step-name"
                                type="text"
                                autoFocus
                                placeholder="Search templates…"
                                value={chainPickerQuery}
                                spellCheck={false}
                                onChange={(e) => {
                                  setChainPickerQuery(e.target.value);
                                  setChainPickerHighlight(0);
                                }}
                                onKeyDown={(e) => {
                                  e.stopPropagation();
                                  if (e.key === 'Escape') {
                                    setChainPickerOpen(false);
                                    setChainPickerQuery('');
                                  } else if (e.key === 'ArrowDown') {
                                    e.preventDefault();
                                    setChainPickerHighlight((h) =>
                                      Math.min(h + 1, Math.max(matches.length - 1, 0)),
                                    );
                                  } else if (e.key === 'ArrowUp') {
                                    e.preventDefault();
                                    setChainPickerHighlight((h) => Math.max(h - 1, 0));
                                  } else if (e.key === 'Enter') {
                                    e.preventDefault();
                                    const t = matches[hi];
                                    if (t) {
                                      addChainTemplate(t);
                                      setChainPickerQuery('');
                                      setChainPickerHighlight(0);
                                    }
                                  }
                                }}
                              />
                              <ul className="composer__options" role="listbox">
                                {matches.length === 0 ? (
                                  <li className="composer__chain-empty">No matching templates.</li>
                                ) : (
                                  matches.map((t, i) => (
                                    <li key={t.id}>
                                      <button
                                        type="button"
                                        role="option"
                                        aria-selected={i === hi}
                                        className={
                                          'composer__option' +
                                          (i === hi ? ' composer__option--active' : '')
                                        }
                                        onMouseEnter={() => setChainPickerHighlight(i)}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          addChainTemplate(t);
                                          setChainPickerQuery('');
                                          setChainPickerHighlight(0);
                                        }}
                                      >
                                        <span className="composer__option-label">{t.name}</span>
                                        <span className="composer__option-hint">
                                          {(t.variables ?? []).length} input
                                          {(t.variables ?? []).length === 1 ? '' : 's'}
                                          {' · '}
                                          {(t.outputSchema ?? []).length} output
                                          {(t.outputSchema ?? []).length === 1 ? '' : 's'}
                                        </span>
                                      </button>
                                    </li>
                                  ))
                                )}
                              </ul>
                              <button
                                type="button"
                                className="composer__chain-icon-btn"
                                title="Close picker"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setChainPickerOpen(false);
                                  setChainPickerQuery('');
                                }}
                              >
                                Done
                              </button>
                            </div>
                          );
                        })()
                      ) : null}
                    </>
                  )}
                  <div className="composer__chain-footer">
                    <button
                      type="button"
                      className="composer__chain-add-step-btn"
                      disabled={templates.length === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        setChainPickerQuery('');
                        setChainPickerHighlight(0);
                        setChainPickerOpen((o) => !o);
                      }}
                    >
                      + add template
                    </button>
                    <button
                      type="button"
                      className="composer__chain-continue-btn"
                      disabled={!chainTemplatesValid}
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
                  {whoOptions.map((o, i) => (
                    <li key={o.kind === 'human' ? `human:${o.email}` : o.kind}>
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

          {/* task-342f3e151d99 — INPUTS. A separate, explained section (was a
              combined "Inputs & outputs?" grid step) — `i` (or the "+ input"
              button) opens the field-def sub-walk (FieldValueEditor's
              definition-time sibling, see FieldDraftQuestion below); already-
              defined inputs review as field-rows, walkable in the SAME
              activeIdx cursor as the rest of the form (task-342f3e151d99). */}
          {showFieldsSteps && (
            <section
              ref={sectionRefFor('fields')}
              className={sectionClasses('fields') + ' composer__q--fields'}
              onClick={() => setActiveIdx(QUESTIONS.indexOf('fields'))}
            >
              {isActiveSection('fields') ? (
                <div className="composer__q-active-body">
                  <FieldLabel id="fields" />
                  <div className="composer__q-prompt">{promptFor('fields')}</div>
                  {/* task-342f3e151d99 (visual grammar unification) — "+ input"
                      renders as an option ROW, exactly like who/template/type:
                      a boxed key-chip on the left (the letter it's bound to,
                      same idiom as the digit chips), the affordance as the
                      label, and the rest of the keyboard grammar as a trailing
                      hint — same position who's rows put "assign to them".
                      This row is ALWAYS present (never disappears once a field
                      is added) so there is always a visible way to add another. */}
                  <ul className="composer__options" role="listbox">
                    <li>
                      <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        className="composer__option composer__option--add"
                        title="Add input (i)"
                        onClick={(e) => {
                          e.stopPropagation();
                          startFieldDraft('inputs');
                        }}
                      >
                        <kbd className="composer__option-key">i</kbd>
                        <span className="composer__option-label">+ input</span>
                        <span className="composer__option-hint">
                          {taskInputs.length > 0 ? '↑ ↓ review a field · ↵ next question' : '↵ next question'}
                        </span>
                      </button>
                    </li>
                  </ul>
                </div>
              ) : (
                renderInert('fields')
              )}
            </section>
          )}
          {showFieldsSteps &&
            taskInputs.map((field, idx) => (
              renderFieldRow({
                kind: 'inputs',
                idx,
                field,
                onRemove: () => removeTaskField('inputs', idx),
                onClearSource: () => clearTaskFieldSource('inputs', idx),
              })
            ))}
          {showFieldsSteps && fieldDraft?.kind === 'inputs' && renderFieldDraft()}

          {/* task-342f3e151d99 — OUTPUTS. Same shape as Inputs above, `o` adds. */}
          {showFieldsSteps && (
            <section
              ref={sectionRefFor('outputs')}
              className={sectionClasses('outputs') + ' composer__q--fields'}
              onClick={() => setActiveIdx(QUESTIONS.indexOf('outputs'))}
            >
              {isActiveSection('outputs') ? (
                <div className="composer__q-active-body">
                  <FieldLabel id="outputs" />
                  <div className="composer__q-prompt">{promptFor('outputs')}</div>
                  <ul className="composer__options" role="listbox">
                    <li>
                      <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        className="composer__option composer__option--add"
                        title="Add output (o)"
                        onClick={(e) => {
                          e.stopPropagation();
                          startFieldDraft('outputs');
                        }}
                      >
                        <kbd className="composer__option-key">o</kbd>
                        <span className="composer__option-label">+ output</span>
                        <span className="composer__option-hint">
                          {taskOutputs.length > 0 ? '↑ ↓ review a field · ↵ next question' : '↵ next question'}
                        </span>
                      </button>
                    </li>
                  </ul>
                </div>
              ) : (
                renderInert('outputs')
              )}
            </section>
          )}
          {showFieldsSteps &&
            taskOutputs.map((field, idx) => (
              renderFieldRow({
                kind: 'outputs',
                idx,
                field,
                onRemove: () => removeTaskField('outputs', idx),
                onClearSource: () => clearTaskFieldSource('outputs', idx),
              })
            ))}
          {showFieldsSteps && fieldDraft?.kind === 'outputs' && renderFieldDraft()}

          {/* task-899af8b03aa6 — "Make this a template". A yes/no step (mirrors
              Pin) plus inline explanatory copy: the declared input/output fields
              become the template's variables, reused later via New from Template.
              Shown for the TypeBuild target (plain create or any edit); in edit
              it reflects whether the task already backs a template. */}
          {templateStepAvailable && (
            <section
              ref={sectionRefFor('template')}
              className={sectionClasses('template')}
              onClick={() => setActiveIdx(QUESTIONS.indexOf('template'))}
            >
              {isActiveSection('template') ? (
                <div className="composer__q-active-body">
                  <FieldLabel id="template" />
                  <div className="composer__q-prompt">{promptFor('template')}</div>
                  <p className="composer__template-explainer">
                    A <strong>template</strong> is a reusable task definition — this
                    task's title plus its declared{' '}
                    <strong>input &amp; output fields, which become variables</strong>.
                    Later you pick <em>New from Template</em> and only fill the
                    values; everything else is prefilled. Turning this on makes sure
                    the task has at least one input field to fill.
                  </p>
                  {props.mode === 'edit' && makeTemplate && (
                    <p className="composer__template-note">
                      This task already backs a template. Its fields are edited on
                      the task; instances are created via New from Template.
                    </p>
                  )}
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
                  <p className="composer__template-hint">
                    Press <kbd>T</kbd> anywhere to toggle.
                  </p>
                </div>
              ) : (
                renderInert('template')
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
                {proseSuggestionVisible && (
                  <div className="composer__prose-suggestion" onClick={(e) => e.stopPropagation()}>
                    <div className="composer__prose-suggestion-text">
                      Structure these fields?{' '}
                      {proseSuggestion.inputs.length > 0 && (
                        <span>
                          Input{proseSuggestion.inputs.length > 1 ? 's' : ''}:{' '}
                          {proseSuggestion.inputs.map((f) => f.label).join(', ')}
                        </span>
                      )}
                      {proseSuggestion.inputs.length > 0 && proseSuggestion.outputs.length > 0 ? ' — ' : ''}
                      {proseSuggestion.outputs.length > 0 && (
                        <span>
                          Output{proseSuggestion.outputs.length > 1 ? 's' : ''}:{' '}
                          {proseSuggestion.outputs.map((f) => f.label).join(', ')}
                        </span>
                      )}
                    </div>
                    <div className="composer__prose-suggestion-actions">
                      <button
                        type="button"
                        className="composer__prose-suggestion-accept"
                        onClick={(e) => {
                          e.stopPropagation();
                          acceptProseSuggestion();
                        }}
                      >
                        Structure these fields
                      </button>
                      <button
                        type="button"
                        className="composer__prose-suggestion-dismiss"
                        onClick={(e) => {
                          e.stopPropagation();
                          dismissProseSuggestion();
                        }}
                      >
                        Keep as text
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              renderInert('notes')
            )}
          </section>
          )}

          {/* task-f5a318566148 — ADVANCED OPTIONS: a collapsible section,
              COLLAPSED by default. The header reads "Advanced options (N set)"
              when collapsed (N = advanced fields left non-default); 'A' or a
              click on the header toggles it. Contains priority, defer/start,
              agent, status, launch flags, due/schedule, pin and (local) the
              working folder. When collapsed these questions are NOT part of the
              walk (see the QUESTIONS memo), so ↓/Enter off the last main
              question goes straight to commit. */}
          {!isMinimalChain && (
          <div className="composer__advanced">
            <button
              type="button"
              className={
                'composer__advanced-toggle' +
                (advancedOpen ? ' composer__advanced-toggle--open' : '')
              }
              aria-expanded={advancedOpen}
              onClick={() => toggleAdvanced()}
            >
              <span className="composer__advanced-caret" aria-hidden="true">
                {advancedOpen ? '▾' : '▸'}
              </span>
              <span className="composer__advanced-title">
                Advanced options
                {!advancedOpen && advancedSetCount > 0
                  ? ` (${advancedSetCount} set)`
                  : ''}
              </span>
              <kbd className="composer__advanced-kbd">A</kbd>
            </button>
            {advancedOpen && (
            <div className="composer__advanced-body">
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

          {/* task-f5a318566148 — launch flags as a MULTI-SELECT option
              question (Claude tasks only — hidden when manual). Digits / Enter
              toggle a flag on/off; ↓ off the last flag advances. The [active]
              effect + walk treat it like the other option lists. */}
          {executor === 'claude' && (
          <section
            ref={sectionRefFor('flags')}
            className={sectionClasses('flags')}
            onClick={() => setActiveIdx(QUESTIONS.indexOf('flags'))}
          >
            {isActiveSection('flags') ? (
              <div className="composer__q-active-body">
                <FieldLabel id="flags" />
                <div className="composer__q-prompt">{promptFor('flags')}</div>
                <ul
                  className="composer__options"
                  role="listbox"
                  aria-multiselectable="true"
                >
                  {FLAG_OPTIONS.map((o, i) => {
                    const on = flags.has(o.id);
                    return (
                      <li key={o.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={on}
                          className={
                            'composer__option composer__flag-option' +
                            (i === flagsHighlight ? ' composer__option--active' : '') +
                            (on ? ' composer__flag-option--on' : '')
                          }
                          onMouseEnter={() => setFlagsHighlight(i)}
                          onClick={(e) => {
                            e.stopPropagation();
                            chooseFlag(i);
                          }}
                        >
                          <kbd className="composer__option-key">{i + 1}</kbd>
                          <span className="composer__flag-check" aria-hidden="true">
                            {on ? '☑' : '☐'}
                          </span>
                          <span className="composer__option-label">{o.label}</span>
                          {o.hint && (
                            <span className="composer__option-hint">{o.hint}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              renderInert('flags')
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
                            goNext();
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
            </div>
            )}
          </div>
          )}

        </main>

        <footer
          className={
            'composer__footer' +
            (phase === 'commit' && !created ? ' composer__footer--active' : '')
          }
        >
          {created ? (
            <div className="composer__flash" role="status">
              ✓ Task {props.mode === 'edit' ? 'saved' : 'created'}
              {/* task-0d63c7b0ebdb — offer to fill the just-defined inputs' values
                  now (writes via the drawer's data-bag path); Esc finishes. */}
              {createdTaskId && !fillMode && (
                <span className="composer__flash-hint">
                  {' — '}
                  <button
                    type="button"
                    className="composer__flash-fill"
                    onClick={() => enterFillMode()}
                  >
                    Press <kbd>F</kbd> to fill inputs now
                  </button>
                  <span className="composer__flash-dim"> · Esc to finish</span>
                </span>
              )}
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
