// Pre-assembled task-context bundle for INTERACTIVE session start
// (task-bd35fc4330c0 — USER-REPORTED 2026-07-04).
//
// THE PROBLEM: an interactive session today launches with only
// `Run /typebuild:typebuild-work and claim task <id>` — the opaque id. The
// agent's first several tool calls are then spent FIGURING OUT the task
// (get_task to read the body, resolving input values one at a time, re-reading
// the output schema) before it does any real work. The HEADLESS path
// (electron/agents/execute.ts buildPrompt) already avoids this: it hands the
// agent the full body up front. This module is the interactive-path analog.
//
// THE FIX: assemble ONE pre-fetched bundle — title, full body, input field
// keys AND resolved values, output schema + evidence instruction, project
// effective instructions, attached skills, and the task id for submit calls —
// and deliver it as the agent's FIRST message. The agent's first tool call
// should then be task WORK (e.g. a `goto`), not `get_task`.
//
// PHI DISCIPLINE (load-bearing, do not weaken):
//   - The body and resolved input VALUES are PHI. They must NEVER ride argv
//     (visible to any local user via `ps`/`/proc/<pid>/cmdline`) and must
//     NEVER be written to disk (no cache file, unlike the NON-PHI
//     task-context-bundle.ts / operator-instructions.ts siblings).
//   - This module therefore does NOT use --append-system-prompt or any CLI
//     flag for the bundle. The caller (electron/agents/interactive.ts) writes
//     the assembled text directly into the pty's stdin as the first line
//     AFTER spawn — the same channel a human would type into the embedded
//     terminal. That text is process memory only: it crosses main → the pty's
//     stdin fd, never a file, never a subprocess argument list.
//   - The existing --append-system-prompt addenda (operator instructions,
//     the NON-PHI sites/memories bundle from task-context-bundle.ts) are
//     UNCHANGED and stay on that channel — this bundle is a SEPARATE, PHI-
//     capable channel layered on top, not a replacement.
//
// FRESHNESS: input values are resolved by the CALLER at launch time (the
// claim-holder has data-read rights) via resolveTaskDataRef — see
// buildTaskWorkBundle's `resolveValue` parameter. This module itself does no
// fetching; it is a PURE function of (detail, resolved values) → bundle, which
// keeps it trivially unit-testable without a network/Electron dependency.

/** The minimal shape this module needs out of a TypeBuild task detail. A
 *  subset of SourcedTask (electron/core/task-source.ts) / DetailRow
 *  (electron/sources/typebuild.ts) — kept narrow and structural so tests don't
 *  need to construct a full SourcedTask. */
export interface TaskWorkBundleInput {
  id: string;
  title: string;
  /** Decrypted body (PHI). */
  body: string | null | undefined;
  dataKeys?: string[];
  outputSchema?: {
    key: string;
    label: string;
    type: 'text' | 'number' | 'date' | 'select' | 'bool';
    options?: string[];
    required?: boolean;
  }[];
  /** Project's cascading effective instructions (NON-PHI). */
  projectInstructions?: string | null;
  /** Attached skills (NON-PHI navigation how-to). Loose/defensive: the wire
   *  shape (DetailRow.skills) is untyped server-side; we accept whatever
   *  string-bearing shape shows up and degrade gracefully otherwise. */
  skills?: unknown;
  /** True when the task is already claimed by us (fm-v0rc pre-claimed Start):
   *  the bundle tells the agent not to re-claim. */
  preclaimed?: boolean;
}

/** One resolved input: the key plus its decrypted value (PHI). */
export interface ResolvedInput {
  key: string;
  value: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Best-effort extraction of a human-readable title + body from one attached
 *  skill entry. The server's `skills` shape isn't pinned down on the wire
 *  (DetailRow.skills is `unknown`, never previously read) — accept the
 *  reasonable variants (`name`/`title`, `body`/`content`/`steps`) and skip an
 *  entry that offers neither rather than rendering "undefined". NON-PHI:
 *  skills are shared navigation how-to, never patient data. */
function renderSkillEntry(entry: unknown): string | null {
  if (isNonEmptyString(entry)) return entry.trim();
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const name = isNonEmptyString(e.name)
    ? e.name
    : isNonEmptyString(e.title)
      ? e.title
      : null;
  const content = isNonEmptyString(e.body)
    ? e.body
    : isNonEmptyString(e.content)
      ? e.content
      : isNonEmptyString(e.steps)
        ? e.steps
        : null;
  if (!name && !content) return null;
  if (name && content) return `## ${name}\n\n${content.trim()}`;
  return (name ?? content ?? '').trim();
}

function renderSkillsSection(skills: unknown): string {
  if (!Array.isArray(skills) || skills.length === 0) return '';
  const rendered = skills.map(renderSkillEntry).filter(isNonEmptyString);
  if (rendered.length === 0) return '';
  return ['# Attached skills (how-to)', '', ...rendered].join('\n');
}

/** Render the output-schema + evidence-instruction section. Mirrors the
 *  wording of task-outputs-instructions.mjs's renderTaskOutputsInstructions
 *  (kept consistent so a headless and an interactive agent see the identical
 *  submit_task_result contract) but sources the schema from the task's
 *  first-class `output_schema` field (task-ce4b4c8ca955) rather than a
 *  ```task-outputs body block, since that's what get_task/the detail
 *  endpoint returns for an interactively-launched TypeBuild task. */
function renderOutputSchemaSection(
  fields: TaskWorkBundleInput['outputSchema'],
): string {
  if (!Array.isArray(fields) || fields.length === 0) return '';
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
    "REQUIRED fields are this task's EVIDENCE: the task is NOT complete until",
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

/** Render the resolved-inputs section: every known `data` key alongside its
 *  value resolved AT LAUNCH TIME (freshness — see module header). A key that
 *  failed to resolve (404/network/etc — see callers' resolveValue) is listed
 *  with a value-free note rather than silently dropped, so the agent knows to
 *  ask/investigate instead of assuming the field doesn't matter.
 *
 *  PHI: this is the section that carries actual VALUES. It must only ever
 *  reach the agent via the stdin-injection channel — see module header. */
function renderInputsSection(
  keys: string[] | undefined,
  resolved: ResolvedInput[],
): string {
  if (!Array.isArray(keys) || keys.length === 0) return '';
  const byKey = new Map(resolved.map((r) => [r.key, r.value]));
  const lines = ['# Task inputs (resolved values)', ''];
  for (const key of keys) {
    const value = byKey.get(key);
    lines.push(value !== undefined ? `  - ${key}: ${value}` : `  - ${key}: (unresolved — no value returned)`);
  }
  return lines.join('\n');
}

/** Assemble the ONE pre-fetched, PHI-bearing first message for an interactive
 *  session. Pure function: given a task detail + its resolved input values,
 *  returns the exact text to write into the pty's stdin as the agent's first
 *  turn. Never touches argv, disk, or any --append-system-prompt string — the
 *  caller is responsible for injecting the RETURNED text over stdin only.
 *
 *  Contains, in order:
 *   1. A short framing line (task id, for submit_task/submit_task_result
 *      calls, and the preclaimed/claim instruction).
 *   2. Title + full body (PHI).
 *   3. Resolved inputs (PHI values).
 *   4. Output schema + evidence instruction (NON-PHI definitions).
 *   5. Project effective instructions (NON-PHI).
 *   6. Attached skills (NON-PHI navigation how-to). */
export function buildTaskWorkBundle(
  task: TaskWorkBundleInput,
  resolvedInputs: ResolvedInput[] = [],
): string {
  const parts: string[] = [];

  parts.push(
    task.preclaimed
      ? `Task ${task.id} is already claimed by me. Do not call claim_task/claim_next_task` +
          ' again — everything needed to work it is below. Use submit_task /' +
          ` submit_task_result with task id ${task.id} when done.`
      : `Task ${task.id} — everything needed to work it is below (you do not need` +
          ` get_task). Claim it (claim_task) before you start, then use submit_task /` +
          ` submit_task_result with task id ${task.id} when done.`,
  );

  parts.push('');
  parts.push(`# ${task.title}`);
  const body = (task.body ?? '').trim();
  if (body) {
    parts.push('');
    parts.push(body);
  }

  const inputsSection = renderInputsSection(task.dataKeys, resolvedInputs);
  if (inputsSection) {
    parts.push('');
    parts.push(inputsSection);
  }

  const outputsSection = renderOutputSchemaSection(task.outputSchema);
  if (outputsSection) {
    parts.push('');
    parts.push(outputsSection);
  }

  const instructions = (task.projectInstructions ?? '').trim();
  if (instructions) {
    parts.push('');
    parts.push('# Project instructions');
    parts.push('');
    parts.push(instructions);
  }

  const skillsSection = renderSkillsSection(task.skills);
  if (skillsSection) {
    parts.push('');
    parts.push(skillsSection);
  }

  return parts.join('\n');
}
