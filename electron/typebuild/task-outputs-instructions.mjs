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
// task-1425579c1194 — CONSOLIDATED (unify, don't mirror): parsing the
// ```task-outputs block used to be reimplemented here because `electron/`
// doesn't normally import `src/` (renderer) code. That convention already has
// exceptions for plain, Electron-free `.mjs` helpers (e.g.
// electron/tag-store.ts imports src/tagStore.mjs, electron/sources/typebuild.ts
// imports src/components/tasks/startOutcome.mjs) — same shape here:
// `parseTaskOutputsBlock` is re-exported from the renderer's
// src/components/newhome/taskSchema.mjs, the ONE place that owns every
// task-body fenced-block parser, instead of being duplicated.
//
// PHI: field DEFINITIONS (key/label/type/required) are NON-PHI configuration
// (docs/typebuild-data-field-contract.md) — safe to render into a system-
// prompt addendum and pass as a CLI arg, same discipline as
// operator-instructions.ts / task-context-bundle.ts. Field VALUES are never
// handled here; this module only ever emits the SCHEMA plus instructions.

import { parseTaskOutputsBlock } from '../../src/components/newhome/taskSchema.mjs';

export { parseTaskOutputsBlock };

/** Render the agent-facing instruction section for a task body's
 *  ```task-outputs block, or '' when the body carries no valid block (so a
 *  caller can append unconditionally: `prompt + renderTaskOutputsInstructions(body)`
 *  is a no-op for every task that predates/lacks Task Templates —
 *  NON-REGRESSION by construction).
 *
 *  task-2638eeedd9ef — FLAT is now canonical, matching the server's own
 *  agent-facing wording EXACTLY (task_manager_api mcp_server.py
 *  `_output_schema_instruction` / the S3 operator instructions): a headless
 *  agent obeying this instruction and an interactive agent obeying the
 *  server's must submit the identical shape, or a schema'd task can never
 *  satisfy the `missing_required_outputs` gate. The section:
 *   - lists every declared output field (key, label, type, required flag),
 *   - states that REQUIRED fields are this task's EVIDENCE and the task is
 *     not complete without them,
 *   - instructs the agent to call `submit_task_result` with `type: "fields"`
 *     and a FLAT `{key: value, ...}` payload BEFORE `submit_task`,
 *   - warns that field VALUES may be PHI: the submit_task_result payload is
 *     the encrypted channel for them — never files/notes/logs. */
export function renderTaskOutputsInstructions(body) {
  const parsed = parseTaskOutputsBlock(body);
  if (!parsed || parsed.fields.length === 0) return '';
  const { fields } = parsed;

  const lines = [
    '# Required task outputs (evidence)',
    '',
    'This task must produce OUTPUT fields. Before submit_task, call',
    'submit_task_result(type="fields", payload={<key>: <value>, ...})',
    'supplying at least every REQUIRED field below (the server rejects a',
    "'done' submit until they are all present):",
    '',
  ];
  for (const f of fields) {
    const flag = f.required ? 'REQUIRED — evidence' : 'optional';
    lines.push(`  - ${f.key}: ${f.label} [${f.type}] (${flag})`);
  }
  lines.push(
    '',
    'REQUIRED fields are this task\'s EVIDENCE: the task is NOT complete until',
    'every required field above has been submitted. The payload is FLAT — one',
    'key per field, no wrapper — shaped exactly like this (include every field',
    'you have a value for, required and optional):',
    '',
    '```json',
    JSON.stringify(Object.fromEntries(fields.map((f) => [f.key, '<value>'])), null, 2),
    '```',
    '',
    'The submit_task_result payload rides an ENCRYPTED channel — field values',
    'may be PHI. Never write field values to files, notes, or logs; pass them',
    'ONLY in the submit_task_result call.',
  );
  return lines.join('\n');
}
