// task-749ecd0c34a4 — a small set of composable, low-level query PRIMITIVES
// over the user's work data (tasks/projects/outputs as plain JS record
// arrays), so arbitrary analytical questions ("group projects by repo",
// "count failed tasks per repo", "count tasks per assignee grouped by
// project") compose from primitives instead of being hardcoded one-off
// tools. Motivated by the in-app copilot being unable to answer
// "group projects by repo" because `repo` is DERIVED from
// `project.folders[0]` and there was no composable query layer to express
// that derivation + a join + a group-by in one place.
//
// Plain, dependency-free ESM (mirrors taskQuery.ts / rosterGroups.mjs /
// pipelineRoster.mjs / taskSchema.mjs) so `node --test` imports it directly,
// with no transpile step. The .d.mts sibling types it for TS consumers.
//
// SCOPE (this pass): the pure query-primitive CORE only. CopilotKit wiring
// (exposing these as agent-callable actions in src/copilot/actions.tsx) is a
// deliberate FOLLOW-UP, not built here.
//
// UNIFICATION NOTE (deliberately NOT done this pass): taskQuery.ts already
// has its own predicate/field-catalogue layer (BASE_FIELDS + fieldValue +
// the tagDsl.mjs parser) driving the New Home roster's free-text search box.
// That box's behavior/UI is under active, unrelated rework, so this module
// is built STANDALONE rather than risking a shared-code change that could
// perturb roster search. The two layers overlap in spirit (a field
// catalogue + a predicate evaluator over task rows) — a future pass could
// have taskQuery.ts's `fieldValue` delegate to (or be expressed as) a
// `where` primitive here, once the roster rework has landed and the
// surface is stable again. Filed as a follow-up rather than attempted here.
//
// PHI: this module is pure and takes whatever records the caller passes in;
// it never fetches, logs, or persists anything itself. Callers remain
// responsible for keeping PHI-bearing record fields in memory only.

/**
 * @typedef {Record<string, unknown>} Rec
 */

// ---------------------------------------------------------------------------
// source / from
// ---------------------------------------------------------------------------

/**
 * Identity "source" primitive — the engine is pure, so `from` just validates
 * and returns the array the caller passed in (tasks | projects | outputs |
 * any other record array). Exists so a query pipeline can start
 * `from(tasks)` uniformly rather than special-casing "no-op first step".
 * @param {Rec[] | null | undefined} records
 * @returns {Rec[]}
 */
export function from(records) {
  return Array.isArray(records) ? records : [];
}

// ---------------------------------------------------------------------------
// derived fields
// ---------------------------------------------------------------------------

/**
 * Last path segment of a filesystem path, independent of OS separator style
 * (handles both '/' and '\\' so a mixed-platform folders[] value still
 * derives sensibly). Trailing separators are trimmed first. Returns null for
 * an empty/root-only path.
 * @param {string} p
 * @returns {string | null}
 */
function basename(p) {
  if (typeof p !== 'string') return null;
  const trimmed = p.replace(/[\\/]+$/, '');
  if (!trimmed) return null;
  const parts = trimmed.split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last || null;
}

/**
 * Parent directory of a filesystem path (the "dirname" variant), same
 * separator handling as basename. Returns null when there is no parent
 * (root, or a bare filename with no separator).
 * @param {string} p
 * @returns {string | null}
 */
function dirname(p) {
  if (typeof p !== 'string') return null;
  const trimmed = p.replace(/[\\/]+$/, '');
  if (!trimmed) return null;
  const parts = trimmed.split(/[\\/]/);
  parts.pop();
  const rest = parts.join('/').replace(/[\\/]+$/, '');
  return rest || null;
}

/**
 * Derive `repo` (basename) and `repoDir` (dirname) from a project's
 * `folders[0]`. Handles 0 folders (both null) and multiple folders
 * (only the first is used — the project's primary folder) gracefully.
 * @param {{ folders?: string[] | null } | null | undefined} project
 * @returns {{ repo: string | null, repoDir: string | null }}
 */
export function deriveProjectRepo(project) {
  const folders = Array.isArray(project?.folders) ? project.folders : [];
  const first = folders.find((f) => typeof f === 'string' && f.trim());
  if (!first) return { repo: null, repoDir: null };
  return { repo: basename(first), repoDir: dirname(first) };
}

/**
 * Return a copy of a project record with derived fields (`repo`, `repoDir`)
 * attached alongside the original fields. Pure — does not mutate the input.
 * @param {Rec} project
 * @returns {Rec}
 */
export function withProjectDerived(project) {
  return { ...project, ...deriveProjectRepo(project) };
}

/**
 * Project an array of projects through `withProjectDerived`, e.g. as the
 * first step before grouping/filtering by `repo`.
 * @param {Rec[]} projects
 * @returns {Rec[]}
 */
export function withDerivedProjects(projects) {
  return from(projects).map(withProjectDerived);
}

// ---------------------------------------------------------------------------
// where / filter
// ---------------------------------------------------------------------------

/**
 * Filter records by a predicate. The predicate receives each record so it
 * can test ANY field, including derived ones a caller has already attached
 * (e.g. via withProjectDerived) — this primitive itself is field-agnostic.
 * @param {Rec[]} records
 * @param {(rec: Rec) => boolean} predicate
 * @returns {Rec[]}
 */
export function where(records, predicate) {
  const pred = typeof predicate === 'function' ? predicate : () => true;
  return from(records).filter((rec) => {
    try {
      return !!pred(rec);
    } catch {
      return false; // defensive: a malformed record must not crash the query
    }
  });
}

/** Alias for `where` — some callers read better with `filter`. */
export const filter = where;

/**
 * Convenience equality predicate builder: `whereEq(records, 'status', 'failed')`.
 * `undefined`/`null` on either side never match (avoids false positives on
 * absent fields).
 * @param {Rec[]} records
 * @param {string} field
 * @param {unknown} value
 * @returns {Rec[]}
 */
export function whereEq(records, field, value) {
  if (value === undefined || value === null) return [];
  return where(records, (rec) => rec?.[field] === value);
}

/**
 * Convenience "field is one of" predicate builder.
 * @param {Rec[]} records
 * @param {string} field
 * @param {unknown[]} values
 * @returns {Rec[]}
 */
export function whereIn(records, field, values) {
  const set = new Set(Array.isArray(values) ? values : []);
  return where(records, (rec) => set.has(rec?.[field]));
}

// ---------------------------------------------------------------------------
// select / project
// ---------------------------------------------------------------------------

/**
 * Project each record down to a subset of fields (by key list), or through an
 * arbitrary mapper function.
 * @param {Rec[]} records
 * @param {string[] | ((rec: Rec) => Rec)} shape
 * @returns {Rec[]}
 */
export function select(records, shape) {
  const list = from(records);
  if (typeof shape === 'function') return list.map(shape);
  const keys = Array.isArray(shape) ? shape : [];
  return list.map((rec) => {
    /** @type {Rec} */
    const out = {};
    for (const k of keys) out[k] = rec?.[k];
    return out;
  });
}

// ---------------------------------------------------------------------------
// sort / limit
// ---------------------------------------------------------------------------

/**
 * Sort records by a field (ascending by default) or a custom comparator.
 * Stable (does not mutate the input array).
 * @param {Rec[]} records
 * @param {string | ((a: Rec, b: Rec) => number)} by
 * @param {{ desc?: boolean }} [opts]
 * @returns {Rec[]}
 */
export function sort(records, by, opts) {
  const list = [...from(records)];
  const desc = !!opts?.desc;
  if (typeof by === 'function') {
    return list.sort(by);
  }
  const field = by;
  return list.sort((a, b) => {
    const av = a?.[field];
    const bv = b?.[field];
    let cmp;
    if (av == null && bv == null) cmp = 0;
    else if (av == null) cmp = -1;
    else if (bv == null) cmp = 1;
    else if (av < bv) cmp = -1;
    else if (av > bv) cmp = 1;
    else cmp = 0;
    return desc ? -cmp : cmp;
  });
}

/**
 * Take the first `n` records.
 * @param {Rec[]} records
 * @param {number} n
 * @returns {Rec[]}
 */
export function limit(records, n) {
  const count = Number.isFinite(n) && n >= 0 ? n : 0;
  return from(records).slice(0, count);
}

// ---------------------------------------------------------------------------
// group-by
// ---------------------------------------------------------------------------

/**
 * Group records by a field name or a key-derivation function. Group keys
 * `null`/`undefined` are normalized to the literal group key `null` (kept
 * distinct from the string `"null"`) so e.g. projects with no folder group
 * together under a single, explicit "no repo" bucket instead of silently
 * merging into some other group or throwing.
 * @param {Rec[]} records
 * @param {string | ((rec: Rec) => unknown)} by
 * @returns {{ key: unknown, items: Rec[] }[]}
 */
export function groupBy(records, by) {
  const keyFn = typeof by === 'function' ? by : (rec) => rec?.[by];
  /** @type {Map<unknown, Rec[]>} */
  const buckets = new Map();
  // Map can't distinguish -0/NaN edge cases we care about here, and using a
  // sentinel keeps null/undefined stable + distinguishable from a string.
  const NULL_KEY = Symbol('null-group-key');
  const order = [];
  for (const rec of from(records)) {
    let key = keyFn(rec);
    if (key === undefined || key === null) key = null;
    const mapKey = key === null ? NULL_KEY : key;
    if (!buckets.has(mapKey)) {
      buckets.set(mapKey, []);
      order.push(mapKey);
    }
    buckets.get(mapKey).push(rec);
  }
  return order.map((mapKey) => ({
    key: mapKey === NULL_KEY ? null : mapKey,
    items: buckets.get(mapKey),
  }));
}

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

/**
 * Aggregate one group's items (or a flat record array) down to a single
 * value, per aggregation kind:
 *   - count: number of items (field ignored)
 *   - sum / avg / min / max: numeric over `field` (non-numeric/missing skipped)
 *   - collect: array of `field` values (or whole records when field omitted)
 * @param {Rec[]} items
 * @param {'count'|'sum'|'avg'|'min'|'max'|'collect'} kind
 * @param {string} [field]
 * @returns {number | unknown[] | null}
 */
export function aggregate(items, kind, field) {
  const list = from(items);
  if (kind === 'count') return list.length;
  if (kind === 'collect') {
    return field ? list.map((rec) => rec?.[field]) : list.slice();
  }
  const nums = list
    .map((rec) => (field ? rec?.[field] : rec))
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (kind === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (kind === 'avg') return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  if (kind === 'min') return nums.length ? Math.min(...nums) : null;
  if (kind === 'max') return nums.length ? Math.max(...nums) : null;
  return null;
}

/**
 * Group + aggregate in one step — the common "count X per Y" / "sum X per Y"
 * shape. Returns one row per group with the group key + the aggregate value
 * under `as` (default: the aggregation kind's name).
 * @param {Rec[]} records
 * @param {string | ((rec: Rec) => unknown)} by
 * @param {'count'|'sum'|'avg'|'min'|'max'|'collect'} kind
 * @param {string} [field]
 * @param {string} [as]
 * @returns {{ key: unknown, value: number | unknown[] | null }[]}
 */
export function groupAggregate(records, by, kind, field, as) {
  const groups = groupBy(records, by);
  const label = as || kind;
  return groups.map((g) => ({
    key: g.key,
    [label]: aggregate(g.items, kind, field),
  }));
}

// ---------------------------------------------------------------------------
// lookup / join
// ---------------------------------------------------------------------------

/**
 * Build a Map from a records array keyed by a field (or key function), last
 * write wins on duplicate keys.
 * @param {Rec[]} records
 * @param {string | ((rec: Rec) => unknown)} by
 * @returns {Map<unknown, Rec>}
 */
export function indexBy(records, by) {
  const keyFn = typeof by === 'function' ? by : (rec) => rec?.[by];
  const map = new Map();
  for (const rec of from(records)) {
    map.set(keyFn(rec), rec);
  }
  return map;
}

/**
 * Attach a related project's fields (including its DERIVED `repo`/`repoDir`)
 * onto each task, keyed by `task.projectId === project.id`. Non-mutating;
 * writes the joined project under `task.project` and leaves the task's own
 * fields untouched. A task whose project isn't found (or has no projectId)
 * gets `project: null`.
 * @param {Rec[]} tasks
 * @param {Rec[]} projects
 * @param {{ taskKey?: string, projectKey?: string, as?: string }} [opts]
 * @returns {Rec[]}
 */
export function joinTaskProject(tasks, projects, opts) {
  const taskKey = opts?.taskKey || 'projectId';
  const projectKey = opts?.projectKey || 'id';
  const as = opts?.as || 'project';
  const derivedProjects = withDerivedProjects(projects);
  const byId = indexBy(derivedProjects, projectKey);
  return from(tasks).map((t) => {
    const pid = t?.[taskKey];
    const project = pid == null ? undefined : byId.get(pid);
    return { ...t, [as]: project ?? null };
  });
}

/**
 * Attach a task's parent task onto it (one hop), keyed by
 * `task.parentTaskId === parent.id`. Non-mutating; writes the parent under
 * `task.parent`. A task with no parentTaskId, or whose parent isn't in the
 * given array, gets `parent: null`.
 * @param {Rec[]} tasks
 * @param {Rec[]} allTasks  candidate pool to resolve parents from (often the
 *   same array as `tasks`, but may be a superset)
 * @param {{ parentKey?: string, idKey?: string, as?: string }} [opts]
 * @returns {Rec[]}
 */
export function joinTaskParent(tasks, allTasks, opts) {
  const parentKey = opts?.parentKey || 'parentTaskId';
  const idKey = opts?.idKey || 'id';
  const as = opts?.as || 'parent';
  const byId = indexBy(allTasks, idKey);
  return from(tasks).map((t) => {
    const pid = t?.[parentKey];
    const parent = pid == null ? undefined : byId.get(pid);
    return { ...t, [as]: parent ?? null };
  });
}

/**
 * Walk a task's parent chain to the root, following `parentTaskId` through
 * `allTasks`. Guards against cycles (defensive — well-formed data shouldn't
 * have any) by capping at `allTasks.length` hops.
 * @param {Rec} task
 * @param {Rec[]} allTasks
 * @param {{ parentKey?: string, idKey?: string }} [opts]
 * @returns {Rec[]} the chain from immediate parent to root (excludes `task` itself)
 */
export function taskParentChain(task, allTasks, opts) {
  const parentKey = opts?.parentKey || 'parentTaskId';
  const idKey = opts?.idKey || 'id';
  const byId = indexBy(allTasks, idKey);
  const chain = [];
  const seen = new Set();
  let cur = task;
  const maxHops = from(allTasks).length;
  for (let i = 0; i < maxHops; i++) {
    const pid = cur?.[parentKey];
    if (pid == null || seen.has(pid)) break;
    const parent = byId.get(pid);
    if (!parent) break;
    chain.push(parent);
    seen.add(pid);
    cur = parent;
  }
  return chain;
}
