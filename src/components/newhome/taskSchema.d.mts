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

/** v2 ```task-template block: the chain is fully self-describing on the
 *  parent task — `defs` are complete TaskDef objects, no project lookup. */
export type ParsedTaskTemplateV2 = { name: string; defs: TaskDef[] };
/** v1 (legacy, pre task-2fd63b922beb) ```task-template block: the chain
 *  definition lived on a project-level TemplateConfig, and the parent only
 *  carried the id list. Still parsed fail-soft, surfaced distinctly so
 *  callers can decide how (or whether) to resolve it. */
export type ParsedTaskTemplateLegacy = {
  name: null;
  defs: null;
  legacy: { templateId: string; taskDefIds: string[] };
};
export type ParsedTaskTemplate = ParsedTaskTemplateV2 | ParsedTaskTemplateLegacy;

/** `taskDefId` is non-null only when read from a LEGACY NESTED payload
 *  (`{taskDefId, fields}`); a FLAT (canonical) payload carries no def id of
 *  its own, so it comes back null — callers that know the owning task-def
 *  (e.g. pipelineRoster.mjs, from the child's own task-outputs block) should
 *  use that known id instead. */
export type ParsedResultFields = { taskDefId: string | null; fields: Record<string, string | number | boolean> };

// task-f26e7745eda6 — 'cancelled' + 'failed' are MERGED-IN from the child
// task's server status (see pipelineRoster.mergeChildStatus); the pure
// output-derived taskDefStatus never returns them itself.
export type TaskDefRenderStatus = 'done' | 'active' | 'pending' | 'skip';
export type MergedStepStatus = TaskDefRenderStatus | 'cancelled' | 'failed';
export type MetaStatus = 'done' | 'active' | 'pending';

export function fieldRef(taskDefId: string, key: string): string;

// task-f9a723379aa8 — field-key normalization (see taskSchema.mjs for the
// full contract). `effectiveFieldKey` is what the composer's save path and
// field-definition editor must BOTH use so a value's key always matches its
// field's key.
export function normalizeFieldKey(raw: unknown): string;
export function isValidFieldKey(raw: unknown): boolean;
export function effectiveFieldKey(field: Pick<TaskDefField, 'key' | 'label'> | null | undefined): string;

// task-fe8c822c3838 — lift input/output intent out of free-text task prose
// into candidate field DEFINITIONS (non-PHI) for the composer/copilot to
// OFFER as a one-tap "structure these fields?" suggestion. Never mutates the
// prose itself; empty/garbage input yields `{ inputs: [], outputs: [] }`.
// `type` is always 'text' (the only schema-valid type free prose can imply);
// `urlHint: true` is set when the label mentions a URL/link/website, for
// callers that want to tailor the input UI without an invalid field type.
export type InferredFieldDef = TaskDefField & { urlHint?: boolean };
export function inferFieldsFromProse(body: unknown): { inputs: InferredFieldDef[]; outputs: InferredFieldDef[] };

export function buildTaskFieldsBlock(
  templateId: string,
  taskDefId: string,
  values: Record<string, unknown>,
): string;
export function replaceTaskFieldsBlock(
  body: unknown,
  templateId: string,
  taskDefId: string,
  values: Record<string, unknown>,
): string;
export function buildTaskOutputsBlock(taskDef: TaskDef): string;
export function buildTaskTemplateBlock(name: string, defs: TaskDef[]): string;

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

// task-e112d60a3b7c — map a first-class Template (server /chromeext/templates)
// into the ordered value-question set the "New from Template" picker walks
// through: one entry per input `variable`, each carrying the flat `ref`
// (`<templateId>.<key>`) used to key its typed value. Pure + defensive
// (null/malformed template or a variable lacking a usable `key` is skipped).
export function templateFillEntries(
  template:
    | { id?: string; variables?: TaskDefField[] | null | undefined }
    | null
    | undefined,
): { taskDefId: string; field: TaskDefField; ref: string }[];

// task-2150d862a3d9 — "+ New from Template" candidate derivation. `task` is
// whatever the caller's list-row-shaped object is (must carry id/title/
// updated_at/notes?/dataKeys?/outputSchema?/projectId?); `detail` is the
// resolved DETAIL fetch (notes/dataKeys/outputSchema), preferred over the
// list row's own (usually absent) fields when present. Returns null when
// neither source defines any fields (a "plain" task with nothing to
// templatize).
export type TemplateEntry = {
  taskId: string;
  name: string;
  defs: TaskDef[];
  kind: 'chain' | 'single';
  projectId?: string;
  updatedAt: number;
};
export function deriveTemplateEntry(
  task: {
    id: string;
    title: string;
    updated_at?: number;
    notes?: string | null;
    dataKeys?: string[];
    outputSchema?: TaskDefField[];
    projectId?: string | null;
  },
  detail?: {
    notes?: string | null;
    dataKeys?: string[];
    outputSchema?: TaskDefField[];
  } | null,
): TemplateEntry | null;

// ── Field-definition sub-walk (task-342f3e151d99) ──────────────────────────
export type FieldDraftKind = 'inputs' | 'outputs';
export type FieldDraftStep = 'key' | 'label' | 'type' | 'options' | 'required';
export function fieldDraftSteps(
  kind: FieldDraftKind,
  fieldType: TaskDefField['type'],
): FieldDraftStep[];
export function nextFieldDraftStep(
  kind: FieldDraftKind,
  fieldType: TaskDefField['type'],
  step: FieldDraftStep,
): FieldDraftStep | null;
export function prevFieldDraftStep(
  kind: FieldDraftKind,
  fieldType: TaskDefField['type'],
  step: FieldDraftStep,
): FieldDraftStep | null;
