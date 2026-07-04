// task-a4397184def4 (T5) — type surface for the pure pipelineRoster.mjs module
// (runtime is plain ESM so `node --test` imports it without a transpile step).
// See docs/task-templates-design.md for the roster contract this mirrors.

import type { TaskDef, TaskDefCondition } from './types';

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

export function rewriteTaskFieldsBlock(
  body: string | null | undefined,
  templateId: string,
  taskDefId: string,
  values: Record<string, string>,
): string;

export function runnableStepId(
  taskDefs: TaskDef[] | null | undefined,
  valuesByRef: Record<string, string | number>,
): string | null;
