// task-a4397184def4 (T5) — type surface for the pure pipelineRoster.mjs module
// (runtime is plain ESM so `node --test` imports it without a transpile step).
// See docs/task-templates-design.md for the roster contract this mirrors.

import type { TaskDef, TaskDefField, TaskDefCondition } from './types';
import type { TaskDefRenderStatus, MergedStepStatus } from './taskSchema';

/** Minimal shape of a child task for status-merge (a raw Task satisfies it). */
export type ChildStatusLike = { status?: string; rawStatus?: string };

export type PartitionedJobs = {
  /** Ids of rows with no parent (jobs + standalone tasks). */
  topLevelIds: string[];
  /** Top-level rows that have at least one child (the actual JOB rows). */
  jobIds: string[];
  /** parentId → child ids. */
  childrenByParent: Record<string, string[]>;
};

export type PipelineColumn = {
  taskDefId: string;
  key: string;
  label: string;
  type: string;
  io: 'in' | 'out';
  required: boolean;
  options?: string[];
};

export type PipelineGroup = {
  taskDefId: string;
  name: string;
  neededWhen: TaskDefCondition | null;
  columns: PipelineColumn[];
};

export type JobValues = {
  valuesByRef: Record<string, string | number>;
  childIdByDefId: Record<string, string>;
};

export function partitionJobs(
  rows: { id: string; parentTaskId?: string | null }[],
): PartitionedJobs;

export function pipelineColumns(taskDefs: TaskDef[] | null | undefined): PipelineGroup[];

export function buildJobValuesByRef(
  children: { id: string; notes?: string | null; result?: unknown }[],
): JobValues;

/** task-ce4b4c8ca955 — resolve a single (non-chained) task's own output
 *  fields (server output_schema, else legacy ```task-outputs body block) +
 *  result into a one-def job-values shape, or null when neither field source
 *  yields any fields. */
export function resolveFieldedJob(job: {
  id: string;
  name: string;
  outputSchema?: TaskDefField[] | null;
  notes?: string | null;
  result?: unknown;
}): { name: string; defs: TaskDef[]; valuesByRef: Record<string, string | number>; childIdByDefId: Record<string, string> } | null;

/** Fielded resolution payload (childless single-task output fields). */
export type FieldedResolution = {
  name: string;
  defs: TaskDef[];
  valuesByRef: Record<string, string | number>;
  childIdByDefId: Record<string, string>;
};

/** Pure four-way classification of a top-level candidate row. Decision order:
 *  loading → chained → (has children ⇒ plain container) → fielded → plain.
 *  A row with children is NEVER 'fielded' — that is the chain-grouping
 *  regression guard (see pipelineRoster.mjs). */
export function classifyJob(input: {
  hasDetail: boolean;
  parsedDefs: TaskDef[] | null | undefined;
  childCount: number;
  fielded: FieldedResolution | null;
}):
  | { status: 'loading' }
  | { status: 'plain' }
  | { status: 'chained' }
  | ({ status: 'fielded' } & FieldedResolution);

export function rewriteTaskFieldsBlock(
  body: string | null | undefined,
  templateId: string,
  taskDefId: string,
  values: Record<string, string>,
): string;

export function runnableStepId(
  taskDefs: TaskDef[] | null | undefined,
  valuesByRef: Record<string, string | number>,
  childByDefId?: Record<string, ChildStatusLike | null | undefined>,
): string | null;

export function nextAutoContinueChildId(
  taskDefs: TaskDef[] | null | undefined,
  valuesByRef: Record<string, string | number>,
  childIdByDefId: Record<string, string> | null | undefined,
  childByDefId?: Record<string, ChildStatusLike | null | undefined>,
): string | null;

export function chainStartTarget(
  taskDefs: TaskDef[] | null | undefined,
  valuesByRef: Record<string, string | number>,
  childIdByDefId: Record<string, string> | null | undefined,
  childByDefId?: Record<string, ChildStatusLike | null | undefined>,
):
  | { childId: string; stepId: string; stepName: string }
  | { childId: null; reason: string };

export function stepDisplayStatus(
  baseStatus: TaskDefRenderStatus,
  childInProgress: boolean,
): TaskDefRenderStatus;

/** task-f26e7745eda6 — child server-status → chip override, or null. */
export function childStatusOverride(
  child: ChildStatusLike | null | undefined,
): 'cancelled' | 'failed' | 'active' | null;

/** task-f26e7745eda6 — project a raw Task down to { status, rawStatus }. */
export function toChildStatus(
  task: ChildStatusLike | null | undefined,
): ChildStatusLike | null;

/** task-f26e7745eda6 — build a def-id → child-status map from [defId, ref]
 *  entries + a resolver from ref → raw Task. */
export function childStatusMap<Ref>(
  entries: Iterable<[string, Ref]>,
  resolve: (ref: Ref) => ChildStatusLike | null | undefined,
): Record<string, ChildStatusLike>;

/** task-f26e7745eda6 — merge the child task's server status onto the pure
 *  output-derived base status (adds 'cancelled' + 'failed'). */
export function mergeChildStatus(
  baseStatus: TaskDefRenderStatus,
  child: ChildStatusLike | null | undefined,
): MergedStepStatus;
