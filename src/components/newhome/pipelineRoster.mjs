// task-a4397184def4 (T5) — pure helpers for the New Home PIPELINE roster
// (docs/task-templates-design.md "Roster" UX invariants). Plain `.mjs` (mirrors
// taskSchema.mjs) so it runs under `node --test` with no transpile step; the
// .d.mts sibling types it for TS consumers (RosterTable.tsx / useChainedRoster).
//
// This module owns the three pure, testable algorithms the pipeline table needs
// but that don't belong in taskSchema.mjs (which is the shared block/parse/status
// layer, owned by T1):
//   - partitionJobs:  fold a flat roster into JOB rows (meta parents) + their
//                     children, so children never get their own top-level row.
//   - pipelineColumns: flatten a template's task-defs into the ordered grouped
//                     column model (per-def group → its input then output cols).
//   - buildJobValuesByRef / rewriteTaskFieldsBlock: merge a job's children into
//                     one `valuesByRef` map, and rewrite ONE child's task-fields
//                     block in place (preserving surrounding human notes) for the
//                     inline-edit round-trip.
//
// It REUSES taskSchema.mjs for every block parse/build/ref op — it does not
// reimplement any of them (fieldRef, parseTaskFieldsBlock, buildTaskFieldsBlock,
// resultFields).
//
// PHI rule (docs/typebuild-data-field-contract.md): field VALUES (input values,
// result values, rewritten bodies) are potentially PHI — this module shapes them
// in memory only, never logs or persists them; callers keep the same discipline.

import {
  fieldRef,
  parseTaskFieldsBlock,
  parseTaskOutputsBlock,
  resultFields,
  buildTaskFieldsBlock,
} from './taskSchema.mjs';

/**
 * Fold a flat roster into jobs + children. A row is a CHILD when it carries a
 * truthy `parentTaskId`; every other row is TOP-LEVEL. A top-level row is a JOB
 * when at least one child points at it. Returns plain objects (arrays/records)
 * so it's trivially testable and JSON-shaped.
 *
 * @param {{id: string, parentTaskId?: string|null}[]} rows
 * @returns {{ topLevelIds: string[], jobIds: string[], childrenByParent: Record<string, string[]> }}
 */
export function partitionJobs(rows) {
  const childrenByParent = {};
  const topLevelIds = [];
  for (const r of rows ?? []) {
    if (!r || typeof r.id !== 'string') continue;
    const parent = r.parentTaskId;
    if (parent) {
      (childrenByParent[parent] ??= []).push(r.id);
    } else {
      topLevelIds.push(r.id);
    }
  }
  // A job is a top-level row that actually has children. (A top-level row with
  // no children — e.g. a standalone non-templated task — stays a plain row.)
  const jobIds = topLevelIds.filter((id) => (childrenByParent[id]?.length ?? 0) > 0);
  return { topLevelIds, jobIds, childrenByParent };
}

/**
 * Flatten a template's task-defs into the ordered grouped column model the
 * pipeline header renders: one GROUP per task-def (in chain order), each group
 * carrying its INPUT columns (io:'in', editable) then its OUTPUT columns
 * (io:'out', read-only). `neededWhen` rides along so the renderer can hatch a
 * whole skipped group as n/a.
 *
 * @param {import('./types').TaskDef[]} taskDefs
 * @returns {{ taskDefId: string, name: string, neededWhen: (import('./types').TaskDefCondition|null), columns: { taskDefId: string, key: string, label: string, type: string, io: ('in'|'out'), required: boolean, options?: string[] }[] }[]}
 */
export function pipelineColumns(taskDefs) {
  const groups = [];
  for (const def of taskDefs ?? []) {
    if (!def || typeof def.id !== 'string') continue;
    const columns = [];
    for (const f of def.inputs ?? []) {
      columns.push({
        taskDefId: def.id,
        key: f.key,
        label: f.label,
        type: f.type,
        io: 'in',
        required: !!f.required,
        options: f.options,
      });
    }
    for (const f of def.outputs ?? []) {
      columns.push({
        taskDefId: def.id,
        key: f.key,
        label: f.label,
        type: f.type,
        io: 'out',
        required: !!f.required,
        options: f.options,
      });
    }
    groups.push({
      taskDefId: def.id,
      name: def.name ?? def.id,
      neededWhen: def.neededWhen ?? null,
      columns,
    });
  }
  return groups;
}

/** Coerce a parsed value into the primitive shape `valuesByRef` holds (string |
 *  number). Booleans stringify (matching TaskDetailDialog's pipeline merge);
 *  everything else is dropped. */
function coerceValue(v) {
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'boolean') return String(v);
  return undefined;
}

/**
 * Merge one job's children into a single `valuesByRef` map (keyed by
 * `fieldRef`) plus a `taskDefId → childId` index. Each child contributes its
 * parsed task-fields INPUT values and, once worked, its `{type:'fields'}`
 * result OUTPUT values. Children whose body/result haven't been fetched yet
 * (notes/result null) simply contribute nothing — the caller degrades those
 * cells to a loading em-dash.
 *
 * task-2638eeedd9ef: a result's `taskDefId` is only known when the child was
 * given a LEGACY NESTED result (`{taskDefId, fields}`). The canonical FLAT
 * result (`{key:value}`, no def id) carries none, so this falls back — in
 * order — to (1) the input block's def id already parsed off the SAME child,
 * then (2) the child's own ```task-outputs block def id, so a flat result
 * still lands on the right column group.
 *
 * @param {{ id: string, notes?: string|null, result?: unknown }[]} children
 * @returns {{ valuesByRef: Record<string, string|number>, childIdByDefId: Record<string, string> }}
 */
export function buildJobValuesByRef(children) {
  const valuesByRef = {};
  const childIdByDefId = {};
  for (const c of children ?? []) {
    if (!c || typeof c.id !== 'string') continue;
    const fields = parseTaskFieldsBlock(c.notes ?? null);
    let defIdForChild = null;
    if (fields) {
      defIdForChild = fields.taskDefId;
      childIdByDefId[fields.taskDefId] = c.id;
      for (const [k, v] of Object.entries(fields.values)) {
        const cv = coerceValue(v);
        if (cv !== undefined) valuesByRef[fieldRef(fields.taskDefId, k)] = cv;
      }
    }
    const rf = resultFields(c.result ?? null);
    if (rf) {
      // Prefer the result's own def id (legacy nested); else the input
      // block's def id already parsed above; else the child's task-outputs
      // block def id (the FLAT-result case — no def id rides the result).
      const outputs = defIdForChild ? null : parseTaskOutputsBlock(c.notes ?? null);
      const rDefId = rf.taskDefId ?? defIdForChild ?? outputs?.taskDefId ?? null;
      if (rDefId) {
        // A result can arrive before/without the input block being re-fetched;
        // still index the child by its result's task-def id if not already.
        if (!(rDefId in childIdByDefId)) childIdByDefId[rDefId] = c.id;
        for (const [k, v] of Object.entries(rf.fields)) {
          const cv = coerceValue(v);
          if (cv !== undefined) valuesByRef[fieldRef(rDefId, k)] = cv;
        }
      }
    }
  }
  return { valuesByRef, childIdByDefId };
}

// Matches the WHOLE ```task-fields fenced block (fences included), non-greedy so
// it never swallows a following ```task-outputs block. Mirrors the fence shape
// taskSchema.mjs's parseFencedJsonBlock reads.
const TASK_FIELDS_BLOCK_RE = /```task-fields\r?\n[\s\S]*?```/;

/**
 * Rewrite (or append) a child task's ```task-fields block with a fresh values
 * map, PRESERVING every other part of the body (the human/agent notes above it
 * and the ```task-outputs block below it). This is the inline-edit round-trip:
 * parse → mutate one value → rebuild the block → splice it back.
 *
 * @param {string|null|undefined} body   the child's current decrypted body/notes
 * @param {string} templateId
 * @param {string} taskDefId
 * @param {Record<string, string>} values  the FULL new input values for this def
 * @returns {string} the new body
 */
export function rewriteTaskFieldsBlock(body, templateId, taskDefId, values) {
  const block = buildTaskFieldsBlock(templateId, taskDefId, values ?? {});
  const src = typeof body === 'string' ? body : '';
  if (TASK_FIELDS_BLOCK_RE.test(src)) {
    return src.replace(TASK_FIELDS_BLOCK_RE, block);
  }
  // No existing block (defensive — a template child should always have one):
  // append it after the existing notes, blank-line separated.
  return src.trim() ? `${src.trim()}\n\n${block}` : block;
}
