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
   *  human to supply it in the New Task modal). */
  agentFetchable: boolean;
  /** Choices when type === 'select'. */
  options?: string[];
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
