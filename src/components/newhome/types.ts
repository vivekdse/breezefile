// task-b9cdad64ab9c — New Home: shared view-model + config contracts for the
// agent-work-monitor surface (ApprovalBar → HeroStats → filters → RosterTable
// → TaskDetailDialog → NewTaskModal → TemplateEditor). These types are the
// FINAL prop contract other stubs are built against — changing a shape here
// ripples through every consumer, so keep additions additive/optional where
// possible.
//
// PHI note: `title`, `lastAction`, and `customValues` VALUES may originate
// from task text and must never be persisted to disk/logs — render in memory
// only, per docs/typebuild-data-field-contract.md. `customValues` KEYS are
// placeholder field ids (non-PHI); only the VALUES a user/agent fills in can
// carry PHI.

import type { Task } from '../../types';
import type { PendingQuestion } from '../tasks/taskAnswer.d.mts';

// Re-exported so downstream New Home files import one thing from one place.
export type { PendingQuestion };

/** Coarse status bucket New Home renders/filters on. Derived from the
 *  underlying Task in useNewHomeData — see that file for the derivation
 *  rules (marked TODO where the mapping is approximate today). */
export type NewHomeStatus = 'done' | 'progress' | 'queued' | 'needs' | 'failed';

/** New Home's view-model for one task row. `raw` carries the full
 *  underlying Task so a stub needing a field not yet promoted to the
 *  view-model can still reach it without a contract change. */
export type NewHomeTask = {
  id: string;
  title: string;
  status: NewHomeStatus;
  projectId: string | null;
  /** Compact age of the most recent activity ("10m", "2h", "5d"), from
   *  lastActionAt. '—' when no timestamp is derivable. */
  lastAction: string;
  /** Epoch ms of the most recent activity, or null when unknown. */
  lastActionAt: number | null;
  /** Short human-readable description of the most recent activity (agent
   *  step, human reply, ...). Best-effort — derived from whatever the
   *  underlying source exposes (messages/notes/audit), never guaranteed.
   *  Rendered as the Last Action tooltip. */
  lastActionDetail: string;
  /** Who acted last / who the ball is with. 'both' covers a task with
   *  interleaved agent+human activity where a single owner isn't clear. */
  who: 'agent' | 'human' | 'both';
  /** Set when the task is blocked on a human answer (drives the Approval
   *  bar + the "needs" bucket). */
  pendingQuestion: PendingQuestion | null;
  /** Per-template custom field values, keyed by TemplateField.key. Values
   *  are placeholder-injected strings and may carry PHI — render as-is,
   *  never log/persist. */
  customValues: Record<string, string>;
  /** Optional short risk/flag annotation (e.g. "3rd retry", "low confidence").
   *  Free text, best-effort — absent when nothing stands out. */
  risk?: string;
  /** task-6c62e6f0905e — "an agent is actively working on this task right
   *  now", trustworthy both locally and remotely. Derived in useNewHomeData
   *  from the SAME liveness signal of record the rest of the app already uses
   *  — claim freshness (src/projects/attention.mjs classify/isStalledRow) —
   *  OR-ed with a locally-open session for this task id (useRunningSessions),
   *  never a separate ad-hoc heuristic. True only for the 'progress' bucket
   *  (a stalled in_progress row already routes to 'needs', not 'progress').
   *  Optional/additive so existing consumers of NewHomeTask are unaffected. */
  live?: boolean;
  /** The full underlying task, for stubs that need a field not yet
   *  promoted into the view-model above. */
  raw: Task;
};

/** One custom field a project's task template can declare. */
export type TemplateField = {
  key: string;
  label: string;
  type: 'text' | 'date' | 'select' | 'number';
  required: boolean;
  /** True when an agent can look this value up itself (vs. requiring the
   *  human to supply it in the New Task modal). Kept for back-compat; a field
   *  with `source` set (below) SUPERSEDES this — it becomes a live typeahead. */
  agentFetchable: boolean;
  /** Choices when type === 'select'. */
  options?: string[];
  /** task-e713f307c422 — data-source-backed field. When set, the New Task
   *  modal renders this field as a live TYPEAHEAD driven by a SavedQuery
   *  (docs/saved-queries-design.md, "Consumers → Form selectors") instead of a
   *  plain value/question: as the user types, the client calls
   *  `POST /chromeext/queries/{savedQueryId}/execute` and shows the returned
   *  rows. Selecting a row stores its opaque resource `ref` (threaded onto the
   *  created task's `data` as placeholder keys — NON-PHI) plus a display
   *  snapshot for the form preview. Supersedes `agentFetchable` when present.
   *  `entityType` is the declared resource type (outputSchema.ref) carried for
   *  display/validation; the authoritative ref comes from each executed row. */
  source?: { savedQueryId: string; version?: number; entityType?: string };
};

/** Per-project New Home configuration: which custom fields exist, which of
 *  them show as roster columns, and the project's approval/step vocabulary. */
export type TemplateConfig = {
  fields: TemplateField[];
  /** Field keys (or built-in column ids) shown as RosterTable columns, in
   *  order. */
  columns: string[];
  approvalRules: { id: string; description: string }[];
  steps: { id: string; name: string; description: string; humanGate: boolean }[];
  /** task-8b694714b13c / docs/task-templates-design.md — a template is a
   *  domain-neutral chain of TaskDefs; the template itself holds no fields of
   *  its own (forms/columns are built by aggregating every task-def's fields,
   *  see taskSchema.mjs `aggregateInputs`). Optional/additive: a template
   *  without `taskDefs` behaves exactly as today (chains/steps/repeatables),
   *  and existing consumers that only know `TemplateConfig` keep compiling. */
  taskDefs?: TaskDef[];
};

/** task-8b694714b13c — one input or output field on a TaskDef. Definitions
 *  (key/label/type/options/required) are NON-PHI configuration; the VALUE a
 *  human/agent later fills in for a given task is the PHI, and it never rides
 *  on this type — see the transport-block contract in taskSchema.mjs. */
export type TaskDefField = {
  key: string; // [a-z0-9._-]+, unique within the task-def
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'bool';
  options?: string[]; // select only
  required?: boolean; // OUTPUT fields: required === evidence
};

/** task-8b694714b13c — a conditional gate on a downstream TaskDef, keyed off
 *  an UPSTREAM task-def's output. `ref` is a `fieldRef` string
 *  ("<taskDefId>.<outputKey>", see taskSchema.mjs). */
export type TaskDefCondition = {
  ref: string; // "<taskDefId>.<outputKey>" of an UPSTREAM task-def
  op: '==' | '!=' | '<' | '>';
  value: string | number;
};

/** task-8b694714b13c — the smallest primitive in a template: one step that
 *  owns its own input fields (human provides at creation) and output fields
 *  (agent produces; `required` outputs are the step's evidence). See
 *  docs/task-templates-design.md for the full contract (vocabulary, transport
 *  blocks, status derivation). */
export type TaskDef = {
  id: string; // slug, unique within the template
  name: string;
  notes?: string; // base agent prompt for this step
  inputs: TaskDefField[];
  outputs: TaskDefField[];
  neededWhen?: TaskDefCondition | null; // absent/null = always needed
};

/** One entry in a task's evidence/activity trail (TaskDetailDialog). */
export type EvidenceEntry = {
  ts: string;
  /** PHI: activity text may reference task content — memory-only. */
  msg: string;
  kind: 'ok' | 'flag' | 'pause' | 'progress';
  who: 'agent' | 'human';
};

/** A finished task's rollup for the OutcomesPanel. */
export type OutcomeSummary = {
  taskId: string;
  title: string;
  status: NewHomeStatus;
  /** PHI: free-text outcome summary — memory-only. */
  summary: string;
};
