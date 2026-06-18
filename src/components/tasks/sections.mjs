// fm-7909 — PURE partition + sort for the owner-organized Tasks page.
//
// Authored as plain ESM (with a co-located sections.d.ts for the TS app) so
// `node --test tests/` can import it directly on Node 20 without a transpile
// step. No React, no IPC, no DOM — only Task objects in, grouped lists out.
//
// Three sections, by OWNER not status:
//   FOR YOU   = manual local tasks you act on by hand (open states)
//   FOR AGENTS= TypeBuild tasks + local auto-mode tasks (open states)
//   DONE      = terminal states from either kind, capped + collapsed
//
// "source" is undefined for legacy local rows, 'local' for tagged local rows,
// '<host>' for a remote breezed machine, 'typebuild' for TypeBuild.

/** @typedef {import('../../types').Task} Task */

/** A local (or untagged) source id. */
function isLocalSource(source) {
  return !source || source === 'local';
}

/** Terminal: hidden from the active sections, lives in DONE.
 *  Covers the local enum (done/cancelled) AND TypeBuild's rawStatus
 *  terminal states (done | partial | cancelled — fm-alfz/S1: cancelled is a
 *  real server terminal status now, mapped to local 'cancelled'). */
export function isDone(task) {
  if (task.status === 'done' || task.status === 'cancelled') return true;
  const raw = task.rawStatus;
  if (raw === 'done' || raw === 'partial' || raw === 'cancelled') return true;
  return false;
}

/** FOR YOU: a manual local task in an open state. */
function isForYou(task) {
  if (!isLocalSource(task.source)) return false;
  if (task.auto_mode) return false;
  if (isDone(task)) return false;
  return task.status === 'pending' || task.status === 'in_progress';
}

/** FOR AGENTS: a TypeBuild task, or a local auto-mode task, in an open state. */
function isForAgents(task) {
  if (isDone(task)) return false;
  if (task.source === 'typebuild') return true;
  if (isLocalSource(task.source) && task.auto_mode) return true;
  return false;
}

function cmpISO(a, b) {
  if (a === b) return 0;
  if (!a) return 1; // nulls last
  if (!b) return -1;
  return a < b ? -1 : 1;
}

// FOR YOU sort: pinned first, then due asc (nulls last), then created desc.
function sortForYou(a, b) {
  const pa = a.pinned ? 0 : 1;
  const pb = b.pinned ? 0 : 1;
  if (pa !== pb) return pa - pb;
  const c = cmpISO(a.due_at ?? null, b.due_at ?? null);
  if (c !== 0) return c;
  return (b.created_at ?? 0) - (a.created_at ?? 0);
}

// FOR AGENTS sort: a running session first, then claimed-by-me, then by
// rawStatus order (open, failed, blocked, others), then priority (lower
// number = higher priority; nulls last), then created desc as a tiebreaker.
// fm-alfz (S1) — cancelled is terminal (it lands in DONE, never FOR AGENTS),
// but include it in the order for completeness so any stray cancelled row
// sinks below the actionable states rather than ranking at the front.
const RAW_ORDER = ['open', 'failed', 'blocked', 'cancelled'];
function rawRank(task) {
  // Prefer the source-native rawStatus; fall back to a coarse mapping from
  // the local enum so local auto tasks sort sanely in this section too.
  const raw =
    task.rawStatus ?? (task.status === 'in_progress' ? 'open' : 'open');
  const i = RAW_ORDER.indexOf(raw);
  return i < 0 ? RAW_ORDER.length : i;
}
function makeSortForAgents(opts) {
  const myEmail = opts && opts.myEmail ? opts.myEmail : null;
  const runningIds = (opts && opts.runningTaskIds) || new Set();
  return function sortForAgents(a, b) {
    const ra = runningIds.has(a.id) ? 0 : 1;
    const rb = runningIds.has(b.id) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    const ma = myEmail && a.claimedBy === myEmail ? 0 : 1;
    const mb = myEmail && b.claimedBy === myEmail ? 0 : 1;
    if (ma !== mb) return ma - mb;
    const sa = rawRank(a);
    const sb = rawRank(b);
    if (sa !== sb) return sa - sb;
    const prioA = typeof a.priority === 'number' ? a.priority : Infinity;
    const prioB = typeof b.priority === 'number' ? b.priority : Infinity;
    if (prioA !== prioB) return prioA - prioB;
    return (b.created_at ?? 0) - (a.created_at ?? 0);
  };
}

// DONE sort: most-recently completed first; rows with no completed_at sink.
function sortDone(a, b) {
  const ca = a.completed_at ?? 0;
  const cb = b.completed_at ?? 0;
  if (ca !== cb) return cb - ca;
  return (b.created_at ?? 0) - (a.created_at ?? 0);
}

/** Cap on the collapsed DONE section so a long history doesn't bloat the DOM. */
export const DONE_CAP = 50;

// fm-bq86 (S3) — group child rows (task.parentTaskId set) under their parent
// when the parent is ALSO present in the section. Returns an ordered list of
// annotated rows that preserves the top-level FOR AGENTS sort; children sort by
// the same comparator among their siblings and render indented (depth 1)
// directly beneath their parent. Orphans — children whose parent isn't visible
// in this section (parent done/cancelled/hidden/not present) — render as
// ordinary top-level rows in their natural sort position.
//
// A "container" parent with any non-terminal (open) child loses Start: the
// server won't hand out the container until its children resolve. We surface
// that via `hasOpenChildren` so the page can pass it into primaryActionFor.
/**
 * @param {Task[]} sortedAgents — already sorted by the FOR AGENTS comparator.
 * @param {Task[]} allTasks — the FULL unpartitioned list. Progress counts must
 *   come from here: terminal children leave the section (they live in DONE), so
 *   counting only in-section children would pin every chip at 0/N and shrink N
 *   as children complete.
 * @returns {Array<{ task: Task, depth: 0|1, childCount?: number, doneChildCount?: number, hasOpenChildren?: boolean }>}
 */
function groupAgents(sortedAgents, sortCmp, allTasks) {
  const presentIds = new Set(sortedAgents.map((t) => t.id));
  // Bucket VISIBLE children by their (visible) parent id — these render
  // indented. Progress counts come from allChildrenByParent below.
  const childrenByParent = new Map();
  for (const t of sortedAgents) {
    const pid = t.parentTaskId;
    if (pid && presentIds.has(pid)) {
      const bucket = childrenByParent.get(pid);
      if (bucket) bucket.push(t);
      else childrenByParent.set(pid, [t]);
    }
  }
  // ALL children (any status, any section) by parent id, for the progress
  // chip and the readiness flag.
  const allChildrenByParent = new Map();
  for (const t of allTasks) {
    const pid = t.parentTaskId;
    if (pid) {
      const bucket = allChildrenByParent.get(pid);
      if (bucket) bucket.push(t);
      else allChildrenByParent.set(pid, [t]);
    }
  }
  const rows = [];
  for (const t of sortedAgents) {
    // A child whose parent is visible is emitted under that parent, not here.
    if (t.parentTaskId && presentIds.has(t.parentTaskId)) continue;
    const allKids = allChildrenByParent.get(t.id);
    if (allKids && allKids.length > 0) {
      const visible = (childrenByParent.get(t.id) ?? []).slice().sort(sortCmp);
      const doneChildCount = allKids.filter((c) => isDone(c)).length;
      const hasOpenChildren = doneChildCount < allKids.length;
      rows.push({
        task: t,
        depth: 0,
        childCount: allKids.length,
        doneChildCount,
        // fm-8yky — how many children actually render under this parent in this
        // section (the rest are terminal / live in DONE). The page keys the
        // collapse toggle off this so a parent whose kids are all done doesn't
        // show a disclosure that expands to nothing.
        visibleChildCount: visible.length,
        hasOpenChildren,
      });
      for (const c of visible) rows.push({ task: c, depth: 1 });
    } else {
      rows.push({ task: t, depth: 0 });
    }
  }
  return rows;
}

/**
 * Resolve a list of blocked-by task ids to their titles using the in-memory
 * task list (renderer memory only — fine for PHI). Ids with no match in the
 * list cache are dropped (detail-only deps may not be in the visible list).
 * @param {string[]|undefined|null} ids
 * @param {Task[]} tasks
 * @returns {string[]} resolved titles, in the order of `ids`
 */
export function resolveBlockedBy(ids, tasks) {
  if (!ids || ids.length === 0) return [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (t && t.title) out.push(t.title);
  }
  return out;
}

/**
 * Partition + sort tasks into the three owner sections.
 * @param {Task[]} tasks
 * @param {{ myEmail?: string|null, runningTaskIds?: Set<string> }} [opts]
 * @returns {{
 *   forYou: Task[],
 *   forAgents: Task[],
 *   forAgentsRows: Array<{ task: Task, depth: 0|1, childCount?: number, doneChildCount?: number, hasOpenChildren?: boolean }>,
 *   done: Task[],
 *   doneTotal: number,
 * }}
 */
export function partitionTasks(tasks, opts) {
  const forYou = [];
  const forAgents = [];
  const done = [];
  for (const t of tasks) {
    if (isDone(t)) done.push(t);
    else if (isForAgents(t)) forAgents.push(t);
    else if (isForYou(t)) forYou.push(t);
    // Anything else (e.g. a remote-but-not-typebuild manual task in an open
    // state) falls through to FOR YOU only when local; otherwise it's a
    // remote manual task → treat as FOR AGENTS-ish is wrong, so we keep it
    // in FOR YOU for visibility. Currently the only sources are local +
    // typebuild, so this branch is unreachable in practice.
    else forYou.push(t);
  }
  forYou.sort(sortForYou);
  const sortCmp = makeSortForAgents(opts);
  forAgents.sort(sortCmp);
  // fm-bq86 (S3) — annotated parent/child rows for indented rendering. The
  // flat `forAgents` is rebuilt from the grouped order so keyboard nav /
  // selection scope (flatOrder in the page) matches what the user sees.
  const forAgentsRows = groupAgents(forAgents, sortCmp, tasks);
  const groupedFlat = forAgentsRows.map((r) => r.task);
  const doneTotal = done.length;
  done.sort(sortDone);
  return {
    forYou,
    forAgents: groupedFlat,
    forAgentsRows,
    done: done.slice(0, DONE_CAP),
    doneTotal,
  };
}
