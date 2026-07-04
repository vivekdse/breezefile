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
  taskDefStatus,
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

/**
 * task-f26e7745eda6 — map a CHILD TASK's server status to the chip-status
 * OVERRIDE it forces on its step, or null when the child's status carries no
 * override and the pure output-derived status should stand.
 *
 * The shared root cause of tasks f26e7745eda6 + 48cd46a0e2da: step status was
 * derived PURELY from output-value presence + neededWhen — it never consulted
 * the child TASK's actual server status. So a server-CANCELLED child rendered
 * as "queued" and got picked as the next runnable step (silent no-op on Start).
 *
 * Status vocabulary (electron/sources/typebuild.ts mapStatus/rawStatusOf):
 *   rawStatus ∈ open | in_progress | done | partial | cancelled | failed | blocked
 *   status    ∈ pending | in_progress | done | cancelled
 *
 * Overrides (highest-signal server states only; everything else → null so the
 * output-derived status wins):
 *   - cancelled            → 'cancelled'  (grey, EXCLUDED from runnable, ≠ n/a)
 *   - failed | blocked     → 'failed'     (retry affordance)
 *   - in_progress          → 'active'     (running — see stepDisplayStatus)
 *
 * @param {{ status?: string, rawStatus?: string } | null | undefined} child
 * @returns {('cancelled'|'failed'|'active'|null)}
 */
export function childStatusOverride(child) {
  if (!child) return null;
  const raw = child.rawStatus;
  const norm = child.status;
  if (raw === 'cancelled' || norm === 'cancelled') return 'cancelled';
  if (raw === 'failed' || raw === 'blocked') return 'failed';
  if (raw === 'in_progress' || norm === 'in_progress') return 'active';
  return null;
}

/**
 * task-f26e7745eda6 (reviewer Angle-D) — project a raw Task down to the minimal
 * { status, rawStatus } the status-merge needs, in ONE place so the four
 * surfaces that build a def-id→child-status map (roster subtable, roster
 * chain-start, both detail rollups) can't drift as the merge inputs grow.
 * Accepts any object with optional status/rawStatus (a raw Task, or a
 * NewHomeTask's `.raw`); returns null for a missing child.
 *
 * @param {{ status?: string, rawStatus?: string } | null | undefined} task
 * @returns {{ status?: string, rawStatus?: string } | null}
 */
export function toChildStatus(task) {
  if (!task) return null;
  return { status: task.status, rawStatus: task.rawStatus };
}

/**
 * task-f26e7745eda6 (reviewer Angle-D) — build a def-id → child-status map from
 * an ITERABLE of [defId, childRef] entries (pass `Object.entries(record)` for a
 * plain object, or `map.entries()` for a Map). `resolve` turns each childRef
 * into its raw Task (an id-lookup, or identity when the entry already holds the
 * task). Centralizes the projection the four surfaces did by hand.
 *
 * @param {Iterable<[string, any]>} entries
 * @param {(childRef: any) => ({ status?: string, rawStatus?: string } | null | undefined)} resolve
 * @returns {Record<string, { status?: string, rawStatus?: string }>}
 */
export function childStatusMap(entries, resolve) {
  const map = {};
  for (const [defId, childRef] of entries ?? []) {
    const status = toChildStatus(resolve(childRef));
    if (status) map[defId] = status;
  }
  return map;
}

/**
 * task-f26e7745eda6 — the merged step status shown on every chip/rollup:
 * layer the child TASK's server status on top of the pure output-derived
 * status. This SUPERSEDES stepDisplayStatus (kept as a thin wrapper for
 * existing callers): it additionally surfaces 'cancelled' and 'failed'.
 *
 * Precedence:
 *   - a genuinely 'done' step stays done (a late-arriving cancelled/failed row
 *     never un-completes finished work), EXCEPT the child is authoritative for
 *     'cancelled' only when the step isn't already done.
 *   - a 'skip' step (neededWhen unmet — "n/a") stays skip and is visually
 *     distinct from 'cancelled'.
 *   - otherwise the child's server override (cancelled/failed/active) wins over
 *     the output-derived base; with no override, the base stands.
 *
 * @param {ReturnType<typeof taskDefStatus>} baseStatus
 * @param {{ status?: string, rawStatus?: string } | null | undefined} child
 * @returns {('done'|'active'|'pending'|'skip'|'cancelled'|'failed')}
 */
export function mergeChildStatus(baseStatus, child) {
  if (baseStatus === 'skip') return 'skip';
  const override = childStatusOverride(child);
  if (baseStatus === 'done') {
    // Finished work stays done; only an explicit server cancellation of a
    // not-yet-fully-submitted step matters, and a done step by definition has
    // its outputs, so we keep 'done'.
    return 'done';
  }
  return override ?? baseStatus;
}

/**
 * task-4045bcee23cb (U3a) — the single "which step is runnable next" rule,
 * shared by the parent-row "▶ Start chain" action, the subtable group-header
 * chips, and the detail Pipeline rollup so all three surfaces always agree.
 *
 * "Runnable" = the FIRST task-def, in chain (dependency) order, that is not
 * `skip` (its `neededWhen` gate is unmet), not `done`, and — task-f26e7745eda6
 * — not CANCELLED (a server-cancelled child is a dead end: selecting it made
 * Start-chain silently no-op). Pass `childByDefId` (def id → child task with
 * `.status`/`.rawStatus`) so the walk consults LIVE child status; omit it for
 * the legacy output-only behavior (still used where child status isn't handy).
 *
 * Returns null when every def is done/skipped/cancelled (nothing left to run)
 * or `taskDefs` is empty.
 *
 * @param {import('./types').TaskDef[]} taskDefs
 * @param {Record<string, string|number>} valuesByRef
 * @param {Record<string, { status?: string, rawStatus?: string }>} [childByDefId]
 * @returns {string|null} the runnable task-def's id, or null
 */
export function runnableStepId(taskDefs, valuesByRef, childByDefId) {
  for (const def of taskDefs ?? []) {
    if (!def || typeof def.id !== 'string') continue;
    const merged = mergeChildStatus(
      taskDefStatus(def, valuesByRef),
      childByDefId ? childByDefId[def.id] : null,
    );
    // Skip a step that's done, conditionally-skipped, or CANCELLED. A 'failed'
    // step is NOT skipped — it's the runnable one (retry lands on it).
    if (merged === 'skip' || merged === 'done' || merged === 'cancelled') continue;
    return def.id;
  }
  return null;
}

/**
 * task-6a14190fb2f7 — chain continuation. Given the SAME inputs
 * runnableStepId already resolves the next step from, plus the job's
 * def-id → child-id index, resolve the CHILD TASK ID auto-continue should
 * start next — or null when there's nothing to start (every def done/skipped/
 * cancelled, or the runnable def has no child yet — e.g. its detail hasn't
 * loaded).
 *
 * This is deliberately just runnableStepId + one lookup — never a second
 * "what's next" rule. task-f26e7745eda6 — pass `childByDefId` so a CANCELLED
 * child is skipped here too (auto-continue must never try to start it).
 * Eligibility (is that child actually startable right now — not already
 * claimed/in_progress/done) is still NOT this function's job; callers must
 * run the child through primaryActionFor before starting it.
 *
 * @param {import('./types').TaskDef[]} taskDefs
 * @param {Record<string, string|number>} valuesByRef
 * @param {Record<string, string>} childIdByDefId
 * @param {Record<string, { status?: string, rawStatus?: string }>} [childByDefId]
 * @returns {string|null} the next child task id to start, or null
 */
export function nextAutoContinueChildId(taskDefs, valuesByRef, childIdByDefId, childByDefId) {
  const stepId = runnableStepId(taskDefs, valuesByRef, childByDefId);
  if (!stepId) return null;
  return (childIdByDefId ?? {})[stepId] ?? null;
}

/**
 * task-48cd46a0e2da — resolve the parent "▶ Start chain" target AND, when
 * there's nothing to start, an EXPLICIT REASON so the click is never silent.
 * This is `runnableStepId` + the child-id lookup, but instead of collapsing
 * "nothing runnable" and "runnable but no child" into a bare null, it reports
 * WHY, so the shared start wrapper can surface "no runnable step: all steps are
 * done/cancelled" rather than a dead click (the round-8 regression).
 *
 * @param {import('./types').TaskDef[]} taskDefs
 * @param {Record<string, string|number>} valuesByRef
 * @param {Record<string, string>} childIdByDefId
 * @param {Record<string, { status?: string, rawStatus?: string }>} [childByDefId]
 * @returns {{ childId: string, stepId: string, stepName: string }
 *          | { childId: null, reason: string }}
 */
export function chainStartTarget(taskDefs, valuesByRef, childIdByDefId, childByDefId) {
  const stepId = runnableStepId(taskDefs, valuesByRef, childByDefId);
  if (!stepId) {
    // Distinguish "everything finished" from "everything cancelled/blocked-out"
    // so the surfaced reason is meaningful.
    const anyCancelled = (taskDefs ?? []).some(
      (d) => d && childStatusOverride(childByDefId?.[d.id]) === 'cancelled',
    );
    return {
      childId: null,
      reason: anyCancelled
        ? 'no runnable step — remaining steps are cancelled (reopen one to continue)'
        : 'no runnable step — the chain is complete',
    };
  }
  const childId = (childIdByDefId ?? {})[stepId] ?? null;
  const def = (taskDefs ?? []).find((d) => d && d.id === stepId);
  const stepName = (def && def.name) || stepId;
  if (!childId) {
    return { childId: null, reason: `step "${stepName}" has no task yet — still loading` };
  }
  return { childId, stepId, stepName };
}

/**
 * task-c141c7765aa4 (chip staleness, 3rd sighting) — thin wrapper kept for
 * back-compat: layer only the child's live RUN state (in_progress → 'active')
 * on the output-derived base. New callers should prefer mergeChildStatus,
 * which also surfaces cancelled/failed. A 'done'/'skip' base is never
 * downgraded.
 *
 * @param {ReturnType<typeof taskDefStatus>} baseStatus
 * @param {boolean} childInProgress  isInProgress(child) from primaryAction.mjs
 * @returns {ReturnType<typeof taskDefStatus>}
 */
export function stepDisplayStatus(baseStatus, childInProgress) {
  if (baseStatus === 'done' || baseStatus === 'skip') return baseStatus;
  return childInProgress ? 'active' : baseStatus;
}
