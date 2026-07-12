// task-64815d2ed7b9 — a declarative QUERY-PLAN executor that turns a plan the
// copilot's model fills in ({source, join, where, groupBy, aggregate, sort,
// limit}) into a composition of the pure primitives in queryEngine.mjs, so the
// in-app copilot can answer NOVEL analytical questions ("group projects by
// repo", "which repo has the most failed tasks", "count tasks per assignee
// grouped by project") by COMPOSING primitives — no per-question hardcoded
// find_X tool. This is the CopilotKit-facing follow-up the queryEngine.mjs
// header deliberately deferred ("exposing these as agent-callable actions in
// src/copilot/actions.tsx is a deliberate FOLLOW-UP, not built here").
//
// It SUPERSEDES the query half of task-cba37063ce2f (the "let the copilot run
// data questions" thread): rather than a bespoke read per question, the model
// points ONE plan at a source and the plan validates + executes it here.
//
// Relationship to the existing DSL path (taskQuery.ts / query_roster /
// query_data): that path FILTERS rows via the no-eval tag DSL. It cannot
// group, aggregate, or join. This module is the complementary GROUP/AGGREGATE/
// JOIN layer, built on the same "compose small pure pieces, never eval"
// discipline — here the pieces are queryEngine.mjs primitives instead of the
// tagDsl AST. One engine per shape of question, no mirrored query language.
//
// Pure, dependency-free ESM (mirrors queryEngine.mjs) so `node --test` imports
// it directly with no transpile step; the .d.mts sibling types it for TS. The
// CALLER (src/copilot/actions.tsx) is responsible for handing this module only
// PHI-safe metadata records (ids, titles, status, assignee, counts — never
// decrypted task bodies / data-bag VALUES); this module is field-agnostic and
// only ever reads/returns whatever the caller passed in.
//
// DEFENSIVE CONTRACT: every entry point returns a typed result object
// ({ ok: true, ... } | { ok: false, error }) and NEVER throws on a malformed
// plan — a bad plan comes straight back to the model as an error string, it
// never bubbles into the copilot UI.

import {
  from,
  where,
  withDerivedProjects,
  joinTaskProject,
  joinTaskParent,
  groupBy as groupByPrim,
  groupAggregate,
  aggregate as aggregatePrim,
  sort as sortPrim,
  limit as limitPrim,
  select,
} from './queryEngine.mjs';

/** @typedef {Record<string, unknown>} Rec */

// ---------------------------------------------------------------------------
// field catalogues — what a plan may reference per source (defensive
// validation surface + the model's ground truth). METADATA only; no field
// here exposes a decrypted body or a data-bag value.
// ---------------------------------------------------------------------------

const TASK_BASE_FIELDS = [
  'id',
  'title',
  'status',
  'who',
  'projectId',
  'assignedTo',
  'parentTaskId',
  'templateId',
  'live',
  'repeatable',
  'dataKeyCount',
  'outputCount',
  'source',
];

// Extra flat fields the join step attaches (so groupBy/where/sort can name
// them directly, e.g. groupBy:'repo' after join:'project' — no dotted paths).
const PROJECT_JOIN_FIELDS = ['repo', 'repoDir', 'projectName'];
const PARENT_JOIN_FIELDS = ['parentTitle', 'parentStatus'];

const PROJECT_FIELDS = ['id', 'name', 'repo', 'repoDir', 'archived', 'folderCount'];

const SOURCES = ['tasks', 'projects'];
const JOINS = ['project', 'parent'];
const AGG_KINDS = ['count', 'sum', 'avg', 'min', 'max', 'collect'];
const OPS = ['=', '==', '!=', '>', '<', '>=', '<=', 'in', '~', 'contains', 'exists'];

/** Allowed fields for a plan, given its source + join. */
function allowedFields(source, join) {
  if (source === 'projects') return new Set(PROJECT_FIELDS);
  const set = new Set(TASK_BASE_FIELDS);
  if (join === 'project') for (const f of PROJECT_JOIN_FIELDS) set.add(f);
  if (join === 'parent') for (const f of PARENT_JOIN_FIELDS) set.add(f);
  return set;
}

// ---------------------------------------------------------------------------
// value access + predicate building
// ---------------------------------------------------------------------------

/** Read a (possibly dotted) path off a record without throwing. */
function getPath(rec, path) {
  if (typeof path !== 'string') return undefined;
  let cur = rec;
  for (const part of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Build a predicate for one `where` clause. Assumes the clause already passed
 *  validation. Comparisons against a null/undefined field never match (avoids
 *  false positives on absent metadata). */
function clausePredicate(clause) {
  const { field, op, value } = clause;
  return (rec) => {
    const v = getPath(rec, field);
    switch (op) {
      case '=':
      case '==':
        return v === value;
      case '!=':
        return v !== value;
      case '>':
        return v != null && v > value;
      case '<':
        return v != null && v < value;
      case '>=':
        return v != null && v >= value;
      case '<=':
        return v != null && v <= value;
      case 'in':
        return Array.isArray(value) && value.includes(v);
      case '~':
      case 'contains':
        return v != null && String(v).toLowerCase().includes(String(value).toLowerCase());
      case 'exists':
        return v != null && v !== '';
      default:
        return false;
    }
  };
}

// ---------------------------------------------------------------------------
// validation — returns an error string, or null when the plan is well-formed
// ---------------------------------------------------------------------------

function fieldList(set) {
  return [...set].join(', ');
}

/**
 * Validate a plan's SHAPE against the source's field catalogue. Pure, cheap,
 * never throws. Returns an error string (surfaced verbatim to the model) or
 * null when the plan is executable.
 * @param {unknown} plan
 * @returns {string | null}
 */
export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return 'plan must be an object';
  }
  const p = /** @type {Rec} */ (plan);
  const source = p.source;
  if (typeof source !== 'string' || !SOURCES.includes(source)) {
    return `source must be one of ${SOURCES.join(', ')}`;
  }
  const join = p.join;
  if (join != null) {
    if (source !== 'tasks') return 'join is only valid when source is "tasks"';
    if (typeof join !== 'string' || !JOINS.includes(join)) {
      return `join must be one of ${JOINS.join(', ')}`;
    }
  }
  const fields = allowedFields(source, typeof join === 'string' ? join : undefined);

  // where
  if (p.where != null) {
    if (!Array.isArray(p.where)) return 'where must be an array of {field, op, value} clauses';
    for (const clause of p.where) {
      if (!clause || typeof clause !== 'object') return 'each where clause must be an object';
      const c = /** @type {Rec} */ (clause);
      if (typeof c.field !== 'string' || !fields.has(c.field)) {
        return `where: unknown field "${String(c.field)}" — available: ${fieldList(fields)}`;
      }
      if (typeof c.op !== 'string' || !OPS.includes(c.op)) {
        return `where: unknown op "${String(c.op)}" — available: ${OPS.join(' ')}`;
      }
      if (c.op === 'in' && !Array.isArray(c.value)) {
        return 'where: op "in" requires an array value';
      }
    }
  }

  // groupBy (string or array of strings)
  if (p.groupBy != null) {
    const keys = Array.isArray(p.groupBy) ? p.groupBy : [p.groupBy];
    if (keys.length === 0) return 'groupBy must name at least one field';
    for (const k of keys) {
      if (typeof k !== 'string' || !fields.has(k)) {
        return `groupBy: unknown field "${String(k)}" — available: ${fieldList(fields)}`;
      }
    }
  }

  // aggregate
  if (p.aggregate != null) {
    if (typeof p.aggregate !== 'object' || Array.isArray(p.aggregate)) {
      return 'aggregate must be an object { kind, field?, as? }';
    }
    const a = /** @type {Rec} */ (p.aggregate);
    if (typeof a.kind !== 'string' || !AGG_KINDS.includes(a.kind)) {
      return `aggregate.kind must be one of ${AGG_KINDS.join(', ')}`;
    }
    const needsField = ['sum', 'avg', 'min', 'max'].includes(a.kind);
    if (needsField && (typeof a.field !== 'string' || !fields.has(a.field))) {
      return `aggregate: kind "${a.kind}" needs a numeric field — available: ${fieldList(fields)}`;
    }
    if (a.field != null && (typeof a.field !== 'string' || !fields.has(a.field))) {
      return `aggregate: unknown field "${String(a.field)}" — available: ${fieldList(fields)}`;
    }
  }

  // sort
  if (p.sort != null) {
    if (typeof p.sort !== 'object' || Array.isArray(p.sort)) {
      return 'sort must be an object { by, desc? }';
    }
    const s = /** @type {Rec} */ (p.sort);
    if (typeof s.by !== 'string') return 'sort.by must be a field name, "key", or "value"';
    // 'value' only meaningful with an aggregate; 'key' only with groupBy —
    // but we don't hard-fail those combos, they simply no-op below.
  }

  // limit
  if (p.limit != null && (typeof p.limit !== 'number' || !Number.isFinite(p.limit) || p.limit < 0)) {
    return 'limit must be a non-negative number';
  }

  return null;
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

/** groupBy key function for a string or array-of-strings groupBy. A composite
 *  (multi-field) group key is rendered as a stable "a / b" string so it sorts
 *  and prints cleanly; a single-field key keeps its raw value (so null groups
 *  stay the explicit null bucket queryEngine.groupBy produces). */
function groupKeyFn(groupBy) {
  const keys = Array.isArray(groupBy) ? groupBy : [groupBy];
  if (keys.length === 1) {
    const k = keys[0];
    return (rec) => getPath(rec, k);
  }
  return (rec) => keys.map((k) => String(getPath(rec, k) ?? 'none')).join(' / ');
}

/**
 * Execute a validated (or to-be-validated) plan against the caller's datasets.
 * Datasets are plain record arrays the caller already reduced to PHI-safe
 * metadata. Returns a typed result; never throws.
 *
 * Result shapes:
 *   - 'groups': { rows: [{ key, <label> }], groupBy, aggregate } — group + agg
 *       (a bare groupBy with no aggregate defaults to a count under "count")
 *   - 'scalar': { value } — an aggregate with no groupBy (whole-set rollup)
 *   - 'rows':   { rows } — filtered/sorted/limited records projected to the
 *       source's safe output fields
 *
 * @param {unknown} plan
 * @param {{ tasks?: Rec[], projects?: Rec[] }} data
 * @returns {{ ok: true, shape: 'groups'|'scalar'|'rows', rows?: Rec[], value?: unknown, groupBy?: string|string[], aggregate?: Rec, total: number } | { ok: false, error: string }}
 */
export function runQueryPlan(plan, data) {
  const err = validatePlan(plan);
  if (err) return { ok: false, error: err };
  const p = /** @type {Rec} */ (plan);
  const source = p.source;
  const join = typeof p.join === 'string' ? p.join : undefined;

  const tasks = from(data?.tasks);
  const projects = from(data?.projects);

  // 1. base record set + derivations/joins so downstream steps can name flat
  //    fields (repo, projectName, ...) directly.
  let records;
  if (source === 'projects') {
    records = withDerivedProjects(projects);
  } else {
    records = tasks;
    if (join === 'project') {
      records = joinTaskProject(records, projects).map((t) => ({
        ...t,
        repo: t.project ? t.project.repo ?? null : null,
        repoDir: t.project ? t.project.repoDir ?? null : null,
        projectName: t.project ? t.project.name ?? null : null,
      }));
    } else if (join === 'parent') {
      records = joinTaskParent(records, tasks).map((t) => ({
        ...t,
        parentTitle: t.parent ? t.parent.title ?? null : null,
        parentStatus: t.parent ? t.parent.status ?? null : null,
      }));
    }
  }

  // 2. where (all clauses AND-combined)
  if (Array.isArray(p.where) && p.where.length) {
    const preds = p.where.map(clausePredicate);
    records = where(records, (rec) => preds.every((pred) => pred(rec)));
  }

  const agg = p.aggregate && typeof p.aggregate === 'object' ? p.aggregate : null;

  // 3a. groupBy present → group [+ aggregate]; default to count.
  if (p.groupBy != null) {
    const keyFn = groupKeyFn(p.groupBy);
    const kind = agg ? agg.kind : 'count';
    const label = agg && typeof agg.as === 'string' && agg.as ? agg.as : kind;
    const field = agg && typeof agg.field === 'string' ? agg.field : undefined;
    let rows = groupAggregate(records, keyFn, kind, field, label);
    rows = applySortLimit(rows, p.sort, p.limit, label);
    return { ok: true, shape: 'groups', rows, groupBy: p.groupBy, aggregate: { kind, field, as: label }, total: rows.length };
  }

  // 3b. aggregate without groupBy → single scalar over the whole set.
  if (agg) {
    const field = typeof agg.field === 'string' ? agg.field : undefined;
    const value = aggregatePrim(records, agg.kind, field);
    return { ok: true, shape: 'scalar', value, aggregate: { kind: agg.kind, field }, total: 1 };
  }

  // 3c. neither → filtered rows, projected to the source's safe fields.
  const outFields = source === 'projects'
    ? PROJECT_FIELDS
    : [...TASK_BASE_FIELDS, ...(join === 'project' ? PROJECT_JOIN_FIELDS : []), ...(join === 'parent' ? PARENT_JOIN_FIELDS : [])];
  let rows = select(records, outFields);
  rows = applySortLimit(rows, p.sort, p.limit, null);
  return { ok: true, shape: 'rows', rows, total: rows.length };
}

/** Apply sort + limit to result rows. For grouped rows `by:'value'` sorts on
 *  the aggregate column, `by:'key'` on the group key; otherwise `by` is a
 *  plain field name. */
function applySortLimit(rows, sortSpec, lim, aggLabel) {
  let out = rows;
  if (sortSpec && typeof sortSpec === 'object' && typeof sortSpec.by === 'string') {
    let by = sortSpec.by;
    if (by === 'value' && aggLabel) by = aggLabel;
    out = sortPrim(out, by, { desc: !!sortSpec.desc });
  }
  if (typeof lim === 'number' && Number.isFinite(lim) && lim >= 0) {
    out = limitPrim(out, lim);
  }
  return out;
}

/**
 * Render a plan result as a compact, transcript-friendly string for the model.
 * Kept here (pure, tested) rather than in the action so the wire format is
 * covered by `node --test`. Row values are already PHI-safe metadata.
 * @param {ReturnType<typeof runQueryPlan>} result
 * @param {number} [max] max rows to print
 * @returns {string}
 */
export function formatPlanResult(result, max = 50) {
  if (!result || result.ok === false) {
    return `Failed: ${result?.error ?? 'invalid plan'}`;
  }
  if (result.shape === 'scalar') {
    const a = result.aggregate;
    const label = a?.field ? `${a.kind}(${a.field})` : a?.kind ?? 'value';
    return `${label} = ${formatValue(result.value)}`;
  }
  if (result.shape === 'groups') {
    const label = result.aggregate?.as ?? 'value';
    const rows = result.rows ?? [];
    if (!rows.length) return 'No groups (0 matching records).';
    const shown = rows.slice(0, max);
    const lines = shown.map((r) => `- ${keyLabel(r.key)}: ${formatValue(r[label])}`);
    const more = rows.length > shown.length ? `\n(+${rows.length - shown.length} more)` : '';
    return `${rows.length} group(s), grouped by ${labelOf(result.groupBy)}, ${label}:\n${lines.join('\n')}${more}`;
  }
  // rows
  const rows = result.rows ?? [];
  if (!rows.length) return 'No matching records.';
  const shown = rows.slice(0, max);
  const lines = shown.map((r) => `- ${JSON.stringify(compact(r))}`);
  const more = rows.length > shown.length ? `\n(+${rows.length - shown.length} more — add a limit or narrow the query)` : '';
  return `${rows.length} record(s):\n${lines.join('\n')}${more}`;
}

function labelOf(groupBy) {
  return Array.isArray(groupBy) ? groupBy.join(' / ') : String(groupBy);
}

function keyLabel(key) {
  if (key === null || key === undefined) return '(none)';
  return String(key);
}

function formatValue(v) {
  if (Array.isArray(v)) return `[${v.length} item(s)]`;
  if (v === null || v === undefined) return '(none)';
  return String(v);
}

/** Drop null/undefined fields so a row line stays terse. */
function compact(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

/** The field catalogues, exported so the copilot action can put the exact
 *  groupable/queryable field names into the tool description (single source of
 *  truth — no drift between what the model is told and what validatePlan
 *  accepts). */
export const QUERY_PLAN_FIELDS = {
  tasks: TASK_BASE_FIELDS,
  taskJoinProject: PROJECT_JOIN_FIELDS,
  taskJoinParent: PARENT_JOIN_FIELDS,
  projects: PROJECT_FIELDS,
  ops: OPS,
  aggregateKinds: AGG_KINDS,
  joins: JOINS,
  sources: SOURCES,
};
