// task-8b694714b13c — pure helper module for Task Templates
// (docs/task-templates-design.md). Plain `.mjs` (mirrors
// src/components/tasks/taskResult.mjs) so it runs under `node --test` with no
// transpile step; the .d.mts sibling gives TS consumers types.
//
// A template is a domain-neutral chain of TaskDefs (see types.ts). Each
// TaskDef owns input fields (human-supplied at creation) and output fields
// (agent-produced; `required` outputs are the step's evidence). This module
// is the ONE place that:
//   - builds/parses the fenced transport blocks a task body carries values in
//     (```task-fields / ```task-outputs / ```task-template — see the design
//     doc's "Transport blocks" section for the exact JSON shapes),
//   - reads the agent's `{type:'fields'}` submit_task_result payload,
//   - evaluates a TaskDef's `neededWhen` condition,
//   - derives per-task-def and job-level status,
//   - aggregates a template's input fields into form/table order.
//
// PHI rule (docs/typebuild-data-field-contract.md): TaskDef/TaskDefField/
// TaskDefCondition *definitions* (keys, labels, types, conditions) are
// NON-PHI configuration and may live in prefs/templates/docs. Field *values*
// (what a human types or an agent produces) are potentially PHI and ride ONLY
// in task bodies / result payloads — this module shapes those values in
// memory (parses/aggregates/evaluates them) but never logs or persists them;
// callers must keep the same discipline.
//
// Fail-SOFT parsing throughout, same convention as taskResult.mjs: a
// malformed/missing block or payload returns null (never throws), so a task
// with no structured template data — or a corrupted one — degrades to
// whatever the caller's non-templated fallback is. No caller here should ever
// need a try/catch around these functions.

/** Build a `fieldRef` — the flat key used everywhere values are merged across
 *  a job's children (`valuesByRef` below). */
export function fieldRef(taskDefId, key) {
  return `${taskDefId}.${key}`;
}

// ── Fenced-block find/parse plumbing ─────────────────────────────────────

/** Find the first ```<tag> ... ``` fenced block in `body` and JSON.parse its
 *  contents. Returns null on: no body, no matching fence, or invalid JSON —
 *  never throws. */
function parseFencedJsonBlock(body, tag) {
  if (typeof body !== 'string' || !body) return null;
  const re = new RegExp('```' + tag + '\\r?\\n([\\s\\S]*?)```', 'm');
  const match = re.exec(body);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function fenceBlock(tag, obj) {
  return ['```' + tag, JSON.stringify(obj), '```'].join('\n');
}

// ── task-fields (child task body: input VALUES for one task-def) ─────────

/** Build the ```task-fields block a created child task carries its input
 *  VALUES in (PHI — lives only in the task body). */
export function buildTaskFieldsBlock(templateId, taskDefId, values) {
  return fenceBlock('task-fields', { templateId, taskDefId, values: values ?? {} });
}

/** Parse a ```task-fields block out of a task body. Returns
 *  `{templateId, taskDefId, values}` or null when absent/malformed. */
export function parseTaskFieldsBlock(body) {
  const parsed = parseFencedJsonBlock(body, 'task-fields');
  if (!parsed) return null;
  if (typeof parsed.templateId !== 'string' || typeof parsed.taskDefId !== 'string') return null;
  const values =
    parsed.values && typeof parsed.values === 'object' && !Array.isArray(parsed.values)
      ? parsed.values
      : {};
  return { templateId: parsed.templateId, taskDefId: parsed.taskDefId, values };
}

// ── task-outputs (child task body: the OUTPUT field DEFINITIONS, non-PHI) ─

function isTaskDefFieldLike(v) {
  if (!v || typeof v !== 'object') return false;
  const f = v;
  if (typeof f.key !== 'string' || typeof f.label !== 'string') return false;
  if (!['text', 'number', 'date', 'select', 'bool'].includes(f.type)) return false;
  if (f.options !== undefined && !Array.isArray(f.options)) return false;
  if (f.required !== undefined && typeof f.required !== 'boolean') return false;
  return true;
}

/** Build the ```task-outputs block declaring one task-def's output field
 *  DEFINITIONS (non-PHI — safe alongside the PHI-bearing task-fields block in
 *  the same body). */
export function buildTaskOutputsBlock(taskDef) {
  return fenceBlock('task-outputs', {
    taskDefId: taskDef.id,
    fields: taskDef.outputs ?? [],
  });
}

/** Parse a ```task-outputs block. Returns `{taskDefId, fields}` (fields
 *  filtered to well-shaped entries) or null when absent/malformed. */
export function parseTaskOutputsBlock(body) {
  const parsed = parseFencedJsonBlock(body, 'task-outputs');
  if (!parsed) return null;
  if (typeof parsed.taskDefId !== 'string') return null;
  const fields = Array.isArray(parsed.fields) ? parsed.fields.filter(isTaskDefFieldLike) : [];
  return { taskDefId: parsed.taskDefId, fields };
}

// ── task-template (meta parent body: the ordered task-def id list) ───────

/** Build the ```task-template block a job's meta parent carries. */
export function buildTaskTemplateBlock(templateId, taskDefs) {
  return fenceBlock('task-template', {
    templateId,
    taskDefIds: (taskDefs ?? []).map((d) => d.id),
  });
}

/** Parse a ```task-template block. Returns `{templateId, taskDefIds}` or null
 *  when absent/malformed. */
export function parseTaskTemplateBlock(body) {
  const parsed = parseFencedJsonBlock(body, 'task-template');
  if (!parsed) return null;
  if (typeof parsed.templateId !== 'string') return null;
  const taskDefIds = Array.isArray(parsed.taskDefIds)
    ? parsed.taskDefIds.filter((id) => typeof id === 'string')
    : null;
  if (!taskDefIds) return null;
  return { templateId: parsed.templateId, taskDefIds };
}

// ── Result contract (agent → client, submit_task_result type:"fields") ───

/** Extract `{taskDefId, fields}` from a task's structured result
 *  (`{type:'fields', payload:{taskDefId, fields}}`), or null when the result
 *  isn't a well-shaped fields result. `fields` is a flat
 *  Record<string, string|number|boolean> of OUTPUT VALUES — PHI, shape only,
 *  never persist/log. */
export function resultFields(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.type !== 'fields') return null;
  const payload = result.payload;
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.taskDefId !== 'string') return null;
  const fieldsIn = payload.fields;
  if (!fieldsIn || typeof fieldsIn !== 'object' || Array.isArray(fieldsIn)) return null;
  const fields = {};
  for (const [k, v] of Object.entries(fieldsIn)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') fields[k] = v;
  }
  return { taskDefId: payload.taskDefId, fields };
}

// ── Condition evaluation ──────────────────────────────────────────────────

/** Evaluate a TaskDef's `neededWhen` condition against the job's merged
 *  values (`valuesByRef`, keyed by `fieldRef`). An unknown/undefined upstream
 *  value always evaluates to false (conservative: a step whose gate can't yet
 *  be evaluated is NOT treated as needed until the upstream value arrives). */
export function evalCondition(cond, valuesByRef) {
  if (!cond) return true;
  const actual = valuesByRef ? valuesByRef[cond.ref] : undefined;
  if (actual === undefined || actual === null) return false;
  switch (cond.op) {
    case '==':
      return String(actual) === String(cond.value);
    case '!=':
      return String(actual) !== String(cond.value);
    case '<':
      return Number(actual) < Number(cond.value);
    case '>':
      return Number(actual) > Number(cond.value);
    default:
      return false;
  }
}

// ── Status derivation ──────────────────────────────────────────────────────

/** One task-def's status:
 *   - 'skip'    — `neededWhen` is set and unmet.
 *   - 'done'    — no required outputs: any output value present → done.
 *                 Else: every required output has a value.
 *   - 'active'  — some (but not all) required outputs have a value.
 *   - 'pending' — zero required outputs have a value. */
export function taskDefStatus(taskDef, valuesByRef) {
  if (taskDef.neededWhen && !evalCondition(taskDef.neededWhen, valuesByRef)) return 'skip';

  const required = (taskDef.outputs ?? []).filter((f) => f.required);
  const hasValue = (key) => {
    const v = valuesByRef ? valuesByRef[fieldRef(taskDef.id, key)] : undefined;
    return v !== undefined && v !== null && v !== '';
  };

  if (required.length === 0) {
    const anyOutput = (taskDef.outputs ?? []).some((f) => hasValue(f.key));
    return anyOutput ? 'done' : 'pending';
  }

  const filled = required.filter((f) => hasValue(f.key)).length;
  if (filled === 0) return 'pending';
  if (filled === required.length) return 'done';
  return 'active';
}

/** Job-level rollup over every non-skipped task-def:
 *   - 'done'    — all non-skip defs are done.
 *   - 'active'  — at least one non-skip def is done or active (but not all
 *                 done).
 *   - 'pending' — otherwise (nothing started, or every def is skipped). */
export function metaStatus(taskDefs, valuesByRef) {
  const statuses = (taskDefs ?? [])
    .map((d) => taskDefStatus(d, valuesByRef))
    .filter((s) => s !== 'skip');
  if (statuses.length === 0) return 'pending';
  if (statuses.every((s) => s === 'done')) return 'done';
  if (statuses.some((s) => s === 'done' || s === 'active')) return 'active';
  return 'pending';
}

// ── Aggregation ─────────────────────────────────────────────────────────

/** Flatten every task-def's input fields into one ordered list — the form/
 *  table order the design doc specifies: task-def order, then field order
 *  within each task-def. Skipped/conditional task-defs are NOT filtered here
 *  (this is definition-time aggregation, not a per-job render) — callers that
 *  need to hide skipped rows do so with taskDefStatus. */
export function aggregateInputs(taskDefs) {
  const out = [];
  for (const taskDef of taskDefs ?? []) {
    for (const field of taskDef.inputs ?? []) {
      out.push({ taskDef, field });
    }
  }
  return out;
}
