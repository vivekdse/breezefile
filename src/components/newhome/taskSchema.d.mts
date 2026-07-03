// task-8b694714b13c — type surface for the pure taskSchema.mjs module
// (runtime is plain ESM so the node test runner imports it without a
// transpile step). See docs/task-templates-design.md for the normative
// contract this mirrors.

import type { TaskDef, TaskDefField, TaskDefCondition } from './types';

/** Flat map of `fieldRef` → value, merging parsed input values and result
 *  fields across a job's children. Values are potentially PHI — shape only,
 *  never persist/log. */
export type ValuesByRef = Record<string, string | number | boolean>;

export type ParsedTaskFields = { templateId: string; taskDefId: string; values: Record<string, unknown> };
export type ParsedTaskOutputs = { taskDefId: string; fields: TaskDefField[] };
export type ParsedTaskTemplate = { templateId: string; taskDefIds: string[] };
export type ParsedResultFields = { taskDefId: string; fields: Record<string, string | number | boolean> };

export type TaskDefRenderStatus = 'done' | 'active' | 'pending' | 'skip';
export type MetaStatus = 'done' | 'active' | 'pending';

export function fieldRef(taskDefId: string, key: string): string;

export function buildTaskFieldsBlock(
  templateId: string,
  taskDefId: string,
  values: Record<string, unknown>,
): string;
export function buildTaskOutputsBlock(taskDef: TaskDef): string;
export function buildTaskTemplateBlock(templateId: string, taskDefs: TaskDef[]): string;

export function parseTaskFieldsBlock(body: unknown): ParsedTaskFields | null;
export function parseTaskOutputsBlock(body: unknown): ParsedTaskOutputs | null;
export function parseTaskTemplateBlock(body: unknown): ParsedTaskTemplate | null;

export function resultFields(result: unknown): ParsedResultFields | null;

export function evalCondition(
  cond: TaskDefCondition | null | undefined,
  valuesByRef: ValuesByRef | null | undefined,
): boolean;

export function taskDefStatus(
  taskDef: TaskDef,
  valuesByRef: ValuesByRef | null | undefined,
): TaskDefRenderStatus;

export function metaStatus(
  taskDefs: TaskDef[] | null | undefined,
  valuesByRef: ValuesByRef | null | undefined,
): MetaStatus;

export function aggregateInputs(
  taskDefs: TaskDef[] | null | undefined,
): { taskDef: TaskDef; field: TaskDefField }[];
