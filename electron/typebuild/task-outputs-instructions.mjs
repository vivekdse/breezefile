// Agent-facing instructions for a task's declared OUTPUT fields
// (docs/task-templates-design.md, workstream T7 / task-5170073890ed).
//
// THE GAP THIS CLOSES: a task-def's `outputs` (required outputs = the task's
// EVIDENCE, per the design doc) travel from the human/template side down onto
// a child task's body as a ```task-outputs fenced block — but until now
// NOTHING told the agent that block exists, what it means, or that it must
// call `submit_task_result` with `type: "fields"` before `submit_task`. This
// module is the missing half: given a task body, it renders a clearly
// delimited instruction section an agent-facing prompt can append.
//
// TWIN / SEAM TO CONSOLIDATE (unify, don't mirror): the renderer already owns
// a parser for the SAME block — `parseTaskOutputsBlock` in
// src/components/newhome/taskSchema.mjs. This file is Electron's `electron/`
// layer, which by convention does not import from `src/` (renderer) code, so
// `parseTaskOutputsBlock` below is a deliberate, minimal RE-IMPLEMENTATION —
// same block tag, same JSON shape, same defensive "malformed → absent" rule.
// If the two ever drift, that is a bug: this module and taskSchema.mjs must
// keep parsing ```task-outputs identically. A follow-up should hoist both
// into one shared module either side of the Electron/renderer boundary can
// import (e.g. promoted to a package both `electron/` and `src/` depend on).
//
// PHI: field DEFINITIONS (key/label/type/required) are NON-PHI configuration
// (docs/typebuild-data-field-contract.md) — safe to render into a system-
// prompt addendum and pass as a CLI arg, same discipline as
// operator-instructions.ts / task-context-bundle.ts. Field VALUES are never
// handled here; this module only ever emits the SCHEMA plus instructions.

const OUTPUT_FIELD_TYPES = ['text', 'number', 'date', 'select', 'bool'];

function isTaskDefFieldLike(v) {
  if (!v || typeof v !== 'object') return false;
  if (typeof v.key !== 'string' || !v.key) return false;
  if (typeof v.label !== 'string' || !v.label) return false;
  if (!OUTPUT_FIELD_TYPES.includes(v.type)) return false;
  if (v.options !== undefined && !Array.isArray(v.options)) return false;
  if (v.required !== undefined && typeof v.required !== 'boolean') return false;
  return true;
}

/** Parse the first ```task-outputs fenced block out of a task body. Returns
 *  `{taskDefId, fields}` (fields filtered to well-shaped entries) or null when
 *  the block is absent, not valid JSON, or missing a usable taskDefId. Never
 *  throws — a malformed block degrades to "absent" so a caller's fallback
 *  (no instructions appended) is exactly the no-block case. Mirrors
 *  `parseTaskOutputsBlock` in src/components/newhome/taskSchema.mjs — see the
 *  module header for why this is a separate implementation, not an import. */
export function parseTaskOutputsBlock(body) {
  if (typeof body !== 'string' || !body) return null;
  const match = /```task-outputs\r?\n([\s\S]*?)```/m.exec(body);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.taskDefId !== 'string' || !parsed.taskDefId) return null;
  const fields = Array.isArray(parsed.fields) ? parsed.fields.filter(isTaskDefFieldLike) : [];
  return { taskDefId: parsed.taskDefId, fields };
}

/** Render the agent-facing instruction section for a task body's
 *  ```task-outputs block, or '' when the body carries no valid block (so a
 *  caller can append unconditionally: `prompt + renderTaskOutputsInstructions(body)`
 *  is a no-op for every task that predates/lacks Task Templates —
 *  NON-REGRESSION by construction).
 *
 *  The section:
 *   - lists every declared output field (key, label, type, required flag),
 *   - states that REQUIRED fields are this task's EVIDENCE and the task is
 *     not complete without them,
 *   - instructs the agent to call `submit_task_result` with `type: "fields"`
 *     and a `{"taskDefId","fields"}` payload BEFORE `submit_task`,
 *   - warns that field VALUES may be PHI: the submit_task_result payload is
 *     the encrypted channel for them — never files/notes/logs. */
export function renderTaskOutputsInstructions(body) {
  const parsed = parseTaskOutputsBlock(body);
  if (!parsed || parsed.fields.length === 0) return '';
  const { taskDefId, fields } = parsed;

  const lines = [
    '# Required task outputs (evidence)',
    '',
    `This task declares output fields for task-def "${taskDefId}". You must` +
      ' produce them as part of completing this task:',
    '',
  ];
  for (const f of fields) {
    const flag = f.required ? 'REQUIRED — evidence' : 'optional';
    lines.push(`- \`${f.key}\` — "${f.label}" (type: ${f.type}) — ${flag}`);
  }
  lines.push(
    '',
    'REQUIRED fields are this task\'s EVIDENCE: the task is NOT complete until',
    'every required field above has been submitted. Before calling',
    '`submit_task`, call `submit_task_result` with `type: "fields"` and a',
    'payload shaped exactly like this (include every field you have a value',
    'for, required and optional):',
    '',
    '```json',
    JSON.stringify(
      {
        taskDefId,
        fields: Object.fromEntries(fields.map((f) => [f.key, '<value>'])),
      },
      null,
      2,
    ),
    '```',
    '',
    'The submit_task_result payload rides an ENCRYPTED channel — field values',
    'may be PHI. Never write field values to files, notes, or logs; pass them',
    'ONLY in the submit_task_result call.',
  );
  return lines.join('\n');
}
