// task-7bdb94445321 — ONE implementation of every New Home template mutation,
// shared by the inline Customize editor (TemplateEditor.tsx) AND the CopilotKit
// actions (src/copilot/*). The editor and the copilot must never hand-mirror
// each other: both call these pure functions, then persist via
// newHomePrefs.setTemplateConfig. (See the user's "unify, don't mirror" rule.)
//
// Every op is PURE: takes a config, returns a NEW config (never mutates). All
// addressing is by stable id/key (not array index) so a copilot action can
// target "the step named X" or "entry <id>" without knowing positions. Reorder
// is the one position-ish op — expressed as (id, dir) so callers still don't
// pass raw indices.
//
// NON-PHI: field keys/labels/types, step names, approval-rule text, chain names
// and title templates are all CONFIGURATION, not patient data (see the
// newHomePrefs header). Safe to build/return here and to surface to the LLM.

import type {
  TemplateConfigExt,
  ChainDef,
  ChainStepTemplate,
  RepeatableTaskDef,
} from './newHomePrefs';
import type { TemplateField, TaskDef, TaskDefField, TaskDefCondition } from './types';

let uidCounter = 0;
export function uid(prefix: string): string {
  uidCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${uidCounter}-${rand}`;
}

export function slugify(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'field'
  );
}

/** Move the element with the given id up (-1) or down (+1) by one slot. No-op
 *  at the ends or when the id isn't found. */
function moveById<T extends { id: string }>(arr: T[], id: string, dir: -1 | 1): T[] {
  const index = arr.findIndex((x) => x.id === id);
  if (index < 0) return arr;
  const target = index + dir;
  if (target < 0 || target >= arr.length) return arr;
  const next = arr.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

// ─── Fields ────────────────────────────────────────────────────────────────

export function addField(cfg: TemplateConfigExt, field: TemplateField): TemplateConfigExt {
  return { ...cfg, fields: [...cfg.fields, field] };
}

export function updateField(
  cfg: TemplateConfigExt,
  key: string,
  patch: Partial<TemplateField>,
): TemplateConfigExt {
  return {
    ...cfg,
    fields: cfg.fields.map((f) => (f.key === key ? { ...f, ...patch } : f)),
  };
}

/** Remove a field and drop it from the column list too (a column can't point
 *  at a field that no longer exists). */
export function removeField(cfg: TemplateConfigExt, key: string): TemplateConfigExt {
  return {
    ...cfg,
    fields: cfg.fields.filter((f) => f.key !== key),
    columns: cfg.columns.filter((c) => c !== key),
  };
}

// ─── Columns ─────────────────────────────────────────────────────────────────

export function setColumns(cfg: TemplateConfigExt, columns: string[]): TemplateConfigExt {
  return { ...cfg, columns };
}

export function toggleColumn(cfg: TemplateConfigExt, id: string, on: boolean): TemplateConfigExt {
  return {
    ...cfg,
    columns: on
      ? cfg.columns.includes(id)
        ? cfg.columns
        : [...cfg.columns, id]
      : cfg.columns.filter((c) => c !== id),
  };
}

export function moveColumn(cfg: TemplateConfigExt, index: number, dir: -1 | 1): TemplateConfigExt {
  const target = index + dir;
  if (target < 0 || target >= cfg.columns.length) return cfg;
  const columns = cfg.columns.slice();
  const [item] = columns.splice(index, 1);
  columns.splice(target, 0, item);
  return { ...cfg, columns };
}

// ─── Approval rules ──────────────────────────────────────────────────────────

export function addApprovalRule(cfg: TemplateConfigExt, description = ''): TemplateConfigExt {
  return { ...cfg, approvalRules: [...cfg.approvalRules, { id: uid('rule'), description }] };
}

export function updateApprovalRule(
  cfg: TemplateConfigExt,
  id: string,
  description: string,
): TemplateConfigExt {
  return {
    ...cfg,
    approvalRules: cfg.approvalRules.map((r) => (r.id === id ? { ...r, description } : r)),
  };
}

export function removeApprovalRule(cfg: TemplateConfigExt, id: string): TemplateConfigExt {
  return { ...cfg, approvalRules: cfg.approvalRules.filter((r) => r.id !== id) };
}

// ─── Steps ───────────────────────────────────────────────────────────────────

type Step = TemplateConfigExt['steps'][number];

export function addStep(cfg: TemplateConfigExt, patch: Partial<Step> = {}): TemplateConfigExt {
  const step: Step = {
    id: uid('step'),
    name: 'New step',
    description: '',
    humanGate: false,
    ...patch,
  };
  return { ...cfg, steps: [...cfg.steps, step] };
}

export function updateStep(
  cfg: TemplateConfigExt,
  id: string,
  patch: Partial<Step>,
): TemplateConfigExt {
  return {
    ...cfg,
    steps: cfg.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  };
}

export function removeStep(cfg: TemplateConfigExt, id: string): TemplateConfigExt {
  return { ...cfg, steps: cfg.steps.filter((s) => s.id !== id) };
}

export function moveStep(cfg: TemplateConfigExt, id: string, dir: -1 | 1): TemplateConfigExt {
  return { ...cfg, steps: moveById(cfg.steps, id, dir) };
}

// ─── Chains ──────────────────────────────────────────────────────────────────

function chainList(cfg: TemplateConfigExt): ChainDef[] {
  return cfg.chains ?? [];
}

/** Add a chain and return the new config plus the new chain's id (callers that
 *  select the freshly-added chain need it). */
export function addChain(cfg: TemplateConfigExt, name = 'New chain'): { cfg: TemplateConfigExt; chainId: string } {
  const chain: ChainDef = { id: uid('chain'), name, entries: [] };
  return { cfg: { ...cfg, chains: [...chainList(cfg), chain] }, chainId: chain.id };
}

export function removeChain(cfg: TemplateConfigExt, id: string): TemplateConfigExt {
  return { ...cfg, chains: chainList(cfg).filter((c) => c.id !== id) };
}

export function renameChain(cfg: TemplateConfigExt, id: string, name: string): TemplateConfigExt {
  return { ...cfg, chains: chainList(cfg).map((c) => (c.id === id ? { ...c, name } : c)) };
}

export function addChainEntry(
  cfg: TemplateConfigExt,
  chainId: string,
  patch: Partial<ChainStepTemplate> = {},
): TemplateConfigExt {
  const entry: ChainStepTemplate = {
    id: uid('entry'),
    titleTemplate: 'Step {{n}} of {{chain}}',
    ...patch,
  };
  return {
    ...cfg,
    chains: chainList(cfg).map((c) =>
      c.id === chainId ? { ...c, entries: [...c.entries, entry] } : c,
    ),
  };
}

export function updateChainEntry(
  cfg: TemplateConfigExt,
  chainId: string,
  entryId: string,
  patch: Partial<ChainStepTemplate>,
): TemplateConfigExt {
  return {
    ...cfg,
    chains: chainList(cfg).map((c) =>
      c.id === chainId
        ? { ...c, entries: c.entries.map((e) => (e.id === entryId ? { ...e, ...patch } : e)) }
        : c,
    ),
  };
}

export function removeChainEntry(
  cfg: TemplateConfigExt,
  chainId: string,
  entryId: string,
): TemplateConfigExt {
  return {
    ...cfg,
    chains: chainList(cfg).map((c) =>
      c.id === chainId ? { ...c, entries: c.entries.filter((e) => e.id !== entryId) } : c,
    ),
  };
}

export function moveChainEntry(
  cfg: TemplateConfigExt,
  chainId: string,
  entryId: string,
  dir: -1 | 1,
): TemplateConfigExt {
  return {
    ...cfg,
    chains: chainList(cfg).map((c) =>
      c.id === chainId ? { ...c, entries: moveById(c.entries, entryId, dir) } : c,
    ),
  };
}

// ─── Repeatable tasks ────────────────────────────────────────────────────────

/** RRULE-lite schedules the UI + copilot offer, mapped to their server
 *  recurrence code. '' = run-on-demand only (no auto-repeat). */
export const SCHEDULE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'On demand only' },
  { value: '1d', label: 'Daily' },
  { value: '1w', label: 'Weekly' },
  { value: '2w', label: 'Every 2 weeks' },
  { value: '1m', label: 'Monthly' },
];

/** Human-readable label for a stored recurrence code (falls back to the raw
 *  code for anything outside the preset list). */
export function scheduleLabel(recurrence: string | undefined): string {
  const found = SCHEDULE_OPTIONS.find((o) => o.value === (recurrence ?? ''));
  return found ? found.label : (recurrence as string);
}

function repeatableList(cfg: TemplateConfigExt): RepeatableTaskDef[] {
  return cfg.repeatables ?? [];
}

export function addRepeatable(
  cfg: TemplateConfigExt,
  patch: Partial<RepeatableTaskDef> = {},
): { cfg: TemplateConfigExt; id: string } {
  const def: RepeatableTaskDef = {
    id: uid('rep'),
    title: 'New repeatable task',
    notes: '',
    recurrence: '',
    ...patch,
  };
  return { cfg: { ...cfg, repeatables: [...repeatableList(cfg), def] }, id: def.id };
}

export function updateRepeatable(
  cfg: TemplateConfigExt,
  id: string,
  patch: Partial<RepeatableTaskDef>,
): TemplateConfigExt {
  return {
    ...cfg,
    repeatables: repeatableList(cfg).map((r) => (r.id === id ? { ...r, ...patch } : r)),
  };
}

export function removeRepeatable(cfg: TemplateConfigExt, id: string): TemplateConfigExt {
  return { ...cfg, repeatables: repeatableList(cfg).filter((r) => r.id !== id) };
}

export function moveRepeatable(cfg: TemplateConfigExt, id: string, dir: -1 | 1): TemplateConfigExt {
  return { ...cfg, repeatables: moveById(repeatableList(cfg), id, dir) };
}

// ─── Task defs (task-8b694714b13c, docs/task-templates-design.md) ──────────
//
// A template is an ordered TaskDef[]; each TaskDef owns its own `inputs` and
// `outputs` field lists (see types.ts). Same op style as everything above:
// pure, addressed by stable id/key, reorder via (id, dir).

function taskDefList(cfg: TemplateConfigExt): TaskDef[] {
  return cfg.taskDefs ?? [];
}

/** Add a task-def and return the new config plus its id (callers that select
 *  the freshly-added task-def need it, same pattern as addChain). */
export function addTaskDef(
  cfg: TemplateConfigExt,
  patch: Partial<Omit<TaskDef, 'inputs' | 'outputs'>> = {},
): { cfg: TemplateConfigExt; taskDefId: string } {
  const taskDef: TaskDef = {
    id: uid('taskdef'),
    name: 'New step',
    inputs: [],
    outputs: [],
    ...patch,
  };
  return { cfg: { ...cfg, taskDefs: [...taskDefList(cfg), taskDef] }, taskDefId: taskDef.id };
}

export function updateTaskDef(
  cfg: TemplateConfigExt,
  taskDefId: string,
  patch: Partial<Omit<TaskDef, 'id' | 'inputs' | 'outputs'>>,
): TemplateConfigExt {
  return {
    ...cfg,
    taskDefs: taskDefList(cfg).map((d) => (d.id === taskDefId ? { ...d, ...patch } : d)),
  };
}

export function removeTaskDef(cfg: TemplateConfigExt, taskDefId: string): TemplateConfigExt {
  return { ...cfg, taskDefs: taskDefList(cfg).filter((d) => d.id !== taskDefId) };
}

export function moveTaskDef(cfg: TemplateConfigExt, taskDefId: string, dir: -1 | 1): TemplateConfigExt {
  return { ...cfg, taskDefs: moveById(taskDefList(cfg), taskDefId, dir) };
}

/** Set (or clear, with `cond = null`) a task-def's `neededWhen` gate. */
export function setTaskDefNeededWhen(
  cfg: TemplateConfigExt,
  taskDefId: string,
  cond: TaskDefCondition | null,
): TemplateConfigExt {
  return {
    ...cfg,
    taskDefs: taskDefList(cfg).map((d) => (d.id === taskDefId ? { ...d, neededWhen: cond } : d)),
  };
}

type TaskDefFieldKind = 'inputs' | 'outputs';

function fieldListOf(taskDef: TaskDef, kind: TaskDefFieldKind): TaskDefField[] {
  return kind === 'inputs' ? taskDef.inputs : taskDef.outputs;
}

/** Add a field (input or output) to a task-def. The key is slugified from the
 *  label and de-duped against the existing list in that same kind (inputs and
 *  outputs are addressed independently, so the same key may appear once as an
 *  input and once as an output). Returns the new config plus the field's key. */
export function addTaskDefField(
  cfg: TemplateConfigExt,
  taskDefId: string,
  kind: TaskDefFieldKind,
  patch: Partial<TaskDefField> & { label: string },
): { cfg: TemplateConfigExt; key: string } {
  const taskDef = taskDefList(cfg).find((d) => d.id === taskDefId);
  const existing = taskDef ? fieldListOf(taskDef, kind).map((f) => f.key) : [];
  let key = slugify(patch.key ?? patch.label);
  let n = 2;
  while (existing.includes(key)) {
    key = `${slugify(patch.key ?? patch.label)}_${n}`;
    n += 1;
  }
  const field: TaskDefField = { key, label: patch.label, type: patch.type ?? 'text' };
  if (patch.options) field.options = patch.options;
  if (patch.required !== undefined) field.required = patch.required;
  return {
    cfg: {
      ...cfg,
      taskDefs: taskDefList(cfg).map((d) =>
        d.id === taskDefId ? { ...d, [kind]: [...fieldListOf(d, kind), field] } : d,
      ),
    },
    key,
  };
}

export function updateTaskDefField(
  cfg: TemplateConfigExt,
  taskDefId: string,
  kind: TaskDefFieldKind,
  key: string,
  patch: Partial<TaskDefField>,
): TemplateConfigExt {
  return {
    ...cfg,
    taskDefs: taskDefList(cfg).map((d) =>
      d.id === taskDefId
        ? { ...d, [kind]: fieldListOf(d, kind).map((f) => (f.key === key ? { ...f, ...patch } : f)) }
        : d,
    ),
  };
}

export function removeTaskDefField(
  cfg: TemplateConfigExt,
  taskDefId: string,
  kind: TaskDefFieldKind,
  key: string,
): TemplateConfigExt {
  return {
    ...cfg,
    taskDefs: taskDefList(cfg).map((d) =>
      d.id === taskDefId ? { ...d, [kind]: fieldListOf(d, kind).filter((f) => f.key !== key) } : d,
    ),
  };
}

/** Move a field within a task-def's input or output list by key (fields have
 *  no `id`, only `key`, so this can't reuse `moveById` directly). */
function moveByKey<T extends { key: string }>(arr: T[], key: string, dir: -1 | 1): T[] {
  const index = arr.findIndex((x) => x.key === key);
  if (index < 0) return arr;
  const target = index + dir;
  if (target < 0 || target >= arr.length) return arr;
  const next = arr.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

export function moveTaskDefField(
  cfg: TemplateConfigExt,
  taskDefId: string,
  kind: TaskDefFieldKind,
  key: string,
  dir: -1 | 1,
): TemplateConfigExt {
  return {
    ...cfg,
    taskDefs: taskDefList(cfg).map((d) =>
      d.id === taskDefId ? { ...d, [kind]: moveByKey(fieldListOf(d, kind), key, dir) } : d,
    ),
  };
}
