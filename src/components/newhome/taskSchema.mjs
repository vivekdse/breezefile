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

// task-4a8d2c98f667 — the drawer's Inputs section EDIT path for a LEGACY task
// (one that carries its input values inline via ```task-fields, rather than
// the server-side `data` bag). Rewrites the block IN PLACE (same
// templateId/taskDefId, new `values`) so the rest of the body is untouched;
// if the body has no ```task-fields block yet, appends a freshly-built one.
// Pure string surgery — the caller is responsible for sending the resulting
// body to the server (task PATCH `task` field) and never persisting it
// locally (PHI, same discipline as the body itself).
export function replaceTaskFieldsBlock(body, templateId, taskDefId, values) {
  const src = typeof body === 'string' ? body : '';
  const block = buildTaskFieldsBlock(templateId, taskDefId, values);
  const re = /```task-fields\r?\n[\s\S]*?```/m;
  if (re.test(src)) return src.replace(re, block);
  return src ? `${src}\n\n${block}` : block;
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

// ── task-template (meta parent body: the SELF-DESCRIBING chain, v2) ──────
//
// task-2fd63b922beb — corrected abstraction: the chain definition rides the
// CHAINED TASK ITSELF, not a project-level TemplateConfig. The parent's
// ```task-template block carries full TaskDef objects (id/name/notes/inputs/
// outputs/neededWhen) so any surface can reconstruct the whole chain from the
// tasks alone, with no project config lookup. v1 bodies (`{templateId,
// taskDefIds}`, pre-correction) are still parsed — fail-soft, never thrown
// away — but surface as a distinct `legacy` shape the caller must handle
// explicitly rather than silently degrading into a v2-shaped value.

function isTaskDefConditionLike(v) {
  if (!v || typeof v !== 'object') return false;
  if (typeof v.ref !== 'string') return false;
  if (!['==', '!=', '<', '>'].includes(v.op)) return false;
  if (typeof v.value !== 'string' && typeof v.value !== 'number') return false;
  return true;
}

/** Defensive shaping for one TaskDef pulled out of a v2 ```task-template
 *  block: drop malformed fields/conditions rather than rejecting the whole
 *  def, same fail-soft convention as parseTaskOutputsBlock. Returns null when
 *  the def itself is unusable (no id/name). */
function sanitizeTaskDefForParse(v) {
  if (!v || typeof v !== 'object') return null;
  if (typeof v.id !== 'string' || typeof v.name !== 'string') return null;
  const inputs = Array.isArray(v.inputs) ? v.inputs.filter(isTaskDefFieldLike) : [];
  const outputs = Array.isArray(v.outputs) ? v.outputs.filter(isTaskDefFieldLike) : [];
  const out = { id: v.id, name: v.name, inputs, outputs };
  if (typeof v.notes === 'string') out.notes = v.notes;
  if (v.neededWhen === null) out.neededWhen = null;
  else if (v.neededWhen !== undefined && isTaskDefConditionLike(v.neededWhen)) out.neededWhen = v.neededWhen;
  return out;
}

/** Build the ```task-template block a job's meta parent carries: the
 *  chain's name plus every task-def IN FULL (v2). `defs` are serialized as
 *  given (trusted in-memory TaskDef[] from the composer) — parse-time
 *  defensive shaping lives in parseTaskTemplateBlock/sanitizeTaskDefForParse,
 *  since that's the untrusted boundary (a task body any client can edit). */
export function buildTaskTemplateBlock(name, defs) {
  return fenceBlock('task-template', {
    v: 2,
    name,
    defs: (defs ?? []).map((d) => {
      const out = { id: d.id, name: d.name, inputs: d.inputs ?? [], outputs: d.outputs ?? [] };
      if (d.notes !== undefined) out.notes = d.notes;
      if (d.neededWhen !== undefined) out.neededWhen = d.neededWhen;
      return out;
    }),
  });
}

/** Parse a ```task-template block.
 *   - v2 (`{v:2, name, defs}`): returns `{name, defs}` — `defs` sanitized
 *     (malformed defs/fields dropped, never throws).
 *   - v1 legacy (`{templateId, taskDefIds}`, pre task-2fd63b922beb): returns
 *     `{name: null, defs: null, legacy: {templateId, taskDefIds}}` so callers
 *     can detect and handle the old project-hung-template shape explicitly.
 *   - Absent/malformed: null. */
export function parseTaskTemplateBlock(body) {
  const parsed = parseFencedJsonBlock(body, 'task-template');
  if (!parsed) return null;

  if (parsed.v === 2) {
    if (typeof parsed.name !== 'string') return null;
    const defs = Array.isArray(parsed.defs)
      ? parsed.defs.map(sanitizeTaskDefForParse).filter(Boolean)
      : [];
    return { name: parsed.name, defs };
  }

  // v1 legacy — fail-soft: still parse, but surface distinctly.
  if (typeof parsed.templateId !== 'string') return null;
  const taskDefIds = Array.isArray(parsed.taskDefIds)
    ? parsed.taskDefIds.filter((id) => typeof id === 'string')
    : null;
  if (!taskDefIds) return null;
  return { name: null, defs: null, legacy: { templateId: parsed.templateId, taskDefIds } };
}

// ── Result contract (agent → client, submit_task_result type:"fields") ───
//
// task-2638eeedd9ef — the server (task-d66c71c0ca38) adopted FLAT as canonical:
// `submit_task_result(type="fields", payload={<key>: <value>, ...})` — a flat
// Record<string, value>, no taskDefId wrapper. This client now READS both:
//   - FLAT `{key: value}` (canonical) — taskDefId is inferred by the caller
//     (this function returns null for it since a bare flat payload carries no
//     def id of its own; see `resultFieldsForDef` below for the def-aware
//     reader pipelineRoster.mjs uses).
//   - LEGACY NESTED `{taskDefId, fields:{key: value}}` — still read correctly
//     so existing results (e.g. task-7d65e61fb581, stored nested) still render.

/** Does `payload` look like the LEGACY NESTED shape (`{taskDefId, fields:{...}}`)? */
function isLegacyNestedFieldsPayload(payload) {
  return (
    !!payload &&
    typeof payload === 'object' &&
    typeof payload.taskDefId === 'string' &&
    !!payload.fields &&
    typeof payload.fields === 'object' &&
    !Array.isArray(payload.fields)
  );
}

function coerceFieldValue(v) {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : undefined;
}

/** Extract `{taskDefId, fields}` from a task's structured `{type:'fields'}`
 *  result, accepting BOTH shapes:
 *   - LEGACY NESTED `{taskDefId, fields:{key:value}}` — `taskDefId` comes from
 *     the payload itself.
 *   - FLAT `{key:value}` (canonical) — there is no def id to read here, so
 *     `taskDefId` is null; callers that know the owning task-def (e.g.
 *     pipelineRoster.mjs, which has the child's own task-outputs block) should
 *     use that known id instead of relying on this field for flat payloads.
 *  Returns null when the result isn't a well-shaped fields result (wrong
 *  type, non-object payload, or a payload with zero usable entries).
 *  `fields` is a flat Record<string, string|number|boolean> of OUTPUT VALUES —
 *  PHI, shape only, never persist/log. */
export function resultFields(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.type !== 'fields') return null;
  const payload = result.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  if (isLegacyNestedFieldsPayload(payload)) {
    const fields = {};
    for (const [k, v] of Object.entries(payload.fields)) {
      const cv = coerceFieldValue(v);
      if (cv !== undefined) fields[k] = cv;
    }
    return { taskDefId: payload.taskDefId, fields };
  }

  // FLAT (canonical): every own-enumerable key is an output field.
  const fields = {};
  for (const [k, v] of Object.entries(payload)) {
    const cv = coerceFieldValue(v);
    if (cv !== undefined) fields[k] = cv;
  }
  if (Object.keys(fields).length === 0) return null;
  return { taskDefId: null, fields };
}

// ── Condition evaluation ──────────────────────────────────────────────────

// task-f8ae99553691 — words a boolean-ish condition value can take, mapped to
// the canonical boolean they mean. Case-insensitive; matched after trimming.
const BOOL_ISH_TRUE = new Set(['true', 'yes']);
const BOOL_ISH_FALSE = new Set(['false', 'no']);

/** True when `v` is a boolean, or a string that spells one of `true`/`false`/
 *  `yes`/`no` (any case). Used to decide whether an `==`/`!=` comparison
 *  should go through boolean normalization instead of raw stringification. */
function isBoolIsh(v) {
  if (typeof v === 'boolean') return true;
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  return BOOL_ISH_TRUE.has(s) || BOOL_ISH_FALSE.has(s);
}

/** Normalize a boolean-ish value (real boolean, or 'true'/'false'/'yes'/'no'
 *  in any case) to a real boolean. Assumes `isBoolIsh(v)` is already true. */
function toBoolIsh(v) {
  if (typeof v === 'boolean') return v;
  return BOOL_ISH_TRUE.has(v.trim().toLowerCase());
}

/** Evaluate a TaskDef's `neededWhen` condition against the job's merged
 *  values (`valuesByRef`, keyed by `fieldRef`). An unknown/undefined upstream
 *  value always evaluates to false (conservative: a step whose gate can't yet
 *  be evaluated is NOT treated as needed until the upstream value arrives).
 *
 *  task-f8ae99553691: for `==`/`!=`, when EITHER side is boolean-ish (a real
 *  boolean, or one of the strings true/false/yes/no, case-insensitive), both
 *  sides are normalized to real booleans before comparing — so a bool output
 *  `true` matches a chain-builder condition value typed as `'Yes'` (and
 *  `false` matches `'No'`), symmetric regardless of which side is the literal
 *  boolean. Plain string/number equality (neither side boolean-ish, e.g.
 *  `'Yes' === 'Yes'`, `3 === 3`) is unaffected. */
export function evalCondition(cond, valuesByRef) {
  if (!cond) return true;
  const actual = valuesByRef ? valuesByRef[cond.ref] : undefined;
  if (actual === undefined || actual === null) return false;
  switch (cond.op) {
    case '==':
    case '!=': {
      let eq;
      if (isBoolIsh(actual) && isBoolIsh(cond.value)) {
        eq = toBoolIsh(actual) === toBoolIsh(cond.value);
      } else {
        eq = String(actual) === String(cond.value);
      }
      return cond.op === '==' ? eq : !eq;
    }
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
