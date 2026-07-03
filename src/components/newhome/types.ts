// task-b9cdad64ab9c — New Home: shared view-model + config contracts for the
// agent-work-monitor surface (HeroStats → filters → RosterTable →
// TaskDetailDialog). These types are the FINAL prop contract other stubs are
// built against — changing a shape here ripples through every consumer, so
// keep additions additive/optional where possible.
//
// task-b1fa5098da3e (R3) — a project no longer carries stored customization
// (TemplateConfig/TemplateField, the per-project fields/columns/approval
// rules/steps that used to live in newHomePrefs.ts). A chain is now fully
// self-describing on its own parent task's v2 `task-template` block (see
// TaskDef below + docs/task-templates-design.md); "project" is just a
// category + a derived view over chained/plain tasks that carry that
// projectId.
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
  /** Placeholder-keyed custom field values (data-bag-backed), if any. Values
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
