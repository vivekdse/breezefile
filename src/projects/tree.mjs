// task-897a13d67632 — PURE project-tree model + roll-up over the Projects
// bridge (window.fm.typebuild.projects). Authored as plain ESM (with a
// co-located tree.d.mts for the TS app) so `node --test tests/` can import it
// directly on Node 20+ without a transpile step. No React, no IPC, no DOM —
// only Project / Task objects in, trees + stats out.
//
// NON-PHI: this module only ever touches Project fields (name/description/
// instructions/folders — teaching context) and Task ROUTING fields (id,
// projectId, parentTaskId, status, rawStatus). It NEVER reads a task title or
// body, so nothing PHI flows through here. Callers must keep it that way.
//
// "Project" and "Task" are the camelCase renderer shapes from ../types.

/** @typedef {import('../types').Project} Project */
/** @typedef {import('../types').Task} Task */
/** @typedef {import('./tree.d.mts').ProjectNode} ProjectNode */
/** @typedef {import('./tree.d.mts').TaskStats} TaskStats */

// ─── tree construction ──────────────────────────────────────────────────────

/**
 * Build a parent→child forest from a flat Project list. Arbitrary depth.
 *
 * Robustness rules (the server list can be partial — a child may reference a
 * parent the caller didn't fetch, or two projects can form a cycle through a
 * bad parentProjectId):
 *   - A project whose parentProjectId is null/missing OR points at a project
 *     NOT in the list becomes a ROOT (an orphan is surfaced, never dropped).
 *   - Cycles are broken: while walking parent links we stop if we revisit a
 *     node, so a self-parent or A→B→A loop degrades to roots rather than
 *     hanging. Every input project appears exactly once in the forest.
 *
 * Children at each level are sorted by name (locale-aware, case-insensitive)
 * for a stable, human-friendly order; ties fall back to id.
 *
 * @param {Project[]} projects
 * @returns {ProjectNode[]} root nodes (each with `.children`)
 */
export function buildProjectTree(projects) {
  const list = Array.isArray(projects) ? projects : [];
  const byId = new Map();
  for (const p of list) {
    if (p && typeof p.id === 'string') byId.set(p.id, p);
  }

  // Resolve each project's EFFECTIVE parent id: the declared parent only counts
  // when it exists in the set and the link doesn't close a cycle.
  /** @type {Map<string, string|null>} */
  const parentOf = new Map();
  for (const p of byId.values()) {
    parentOf.set(p.id, resolveParent(p, byId));
  }

  // Materialize nodes, then wire children.
  /** @type {Map<string, ProjectNode>} */
  const nodes = new Map();
  for (const p of byId.values()) {
    nodes.set(p.id, { project: p, children: [], depth: 0, parentId: parentOf.get(p.id) ?? null });
  }
  /** @type {ProjectNode[]} */
  const roots = [];
  for (const node of nodes.values()) {
    const pid = node.parentId;
    if (pid && nodes.has(pid)) {
      nodes.get(pid).children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort children + roots by name, and stamp depth via a walk.
  sortNodes(roots);
  for (const r of roots) stampDepth(r, 0);
  return roots;
}

/** Resolve a project's true parent id, or null when it's a root/orphan/cycle. */
function resolveParent(project, byId) {
  const declared = project.parentProjectId;
  if (!declared || !byId.has(declared) || declared === project.id) return null;
  // Walk up from the declared parent; if we ever reach `project.id` again the
  // link closes a cycle, so treat `project` as a root instead.
  let cur = byId.get(declared);
  const seen = new Set([project.id]);
  while (cur) {
    if (seen.has(cur.id)) return null; // cycle → root
    seen.add(cur.id);
    const next = cur.parentProjectId;
    if (!next || !byId.has(next) || next === cur.id) break;
    cur = byId.get(next);
  }
  return declared;
}

function sortNodes(nodes) {
  nodes.sort(cmpNode);
  for (const n of nodes) sortNodes(n.children);
}

function cmpNode(a, b) {
  const an = (a.project.name ?? '').toLowerCase();
  const bn = (b.project.name ?? '').toLowerCase();
  const c = an.localeCompare(bn);
  return c !== 0 ? c : a.project.id.localeCompare(b.project.id);
}

function stampDepth(node, depth) {
  node.depth = depth;
  for (const c of node.children) stampDepth(c, depth + 1);
}

// ─── lookup + path helpers ──────────────────────────────────────────────────

/**
 * Flatten a tree (or forest) into a Map<id, ProjectNode> for O(1) lookup.
 * @param {ProjectNode[]|ProjectNode} treeOrRoots
 * @returns {Map<string, ProjectNode>}
 */
export function indexTree(treeOrRoots) {
  const roots = Array.isArray(treeOrRoots) ? treeOrRoots : [treeOrRoots];
  const out = new Map();
  const walk = (n) => {
    out.set(n.project.id, n);
    for (const c of n.children) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

/**
 * The chain of projects from the root down to (and including) `projectId`,
 * general→specific. Returns [] when the id isn't in the forest.
 * @param {ProjectNode[]} roots
 * @param {string} projectId
 * @returns {Project[]} ancestors-first, ending with the target project
 */
export function ancestorChain(roots, projectId) {
  const index = indexTree(roots);
  const target = index.get(projectId);
  if (!target) return [];
  /** @type {Project[]} */
  const chain = [];
  let cur = target;
  const seen = new Set();
  while (cur && !seen.has(cur.project.id)) {
    seen.add(cur.project.id);
    chain.push(cur.project);
    cur = cur.parentId ? index.get(cur.parentId) : undefined;
  }
  chain.reverse();
  return chain;
}

/**
 * A human breadcrumb path, e.g. "Insurance Authorization › Aetna HMO".
 * @param {ProjectNode[]} roots
 * @param {string} projectId
 * @param {string} [sep] separator (default ' › ')
 * @returns {string} '' when the id isn't found
 */
export function breadcrumbPath(roots, projectId, sep = ' › ') {
  return ancestorChain(roots, projectId)
    .map((p) => p.name)
    .join(sep);
}

// ─── task-stat roll-up ──────────────────────────────────────────────────────

/** A fresh, zeroed stat bucket. */
function emptyStats() {
  return {
    total: 0,
    open: 0,
    inProgress: 0,
    done: 0,
    cancelled: 0,
    blocked: 0,
    needsYou: 0,
  };
}

/**
 * Classify one task into the roll-up buckets. Mirrors the source's status
 * mapping (rawStatus carries the truthful server state; status collapses
 * failed/blocked into 'pending'). "needsYou" = an actionable open/blocked row
 * that isn't currently claimed by an agent run — a coarse "this wants a human"
 * signal the L1 grid's one-bright-thing rule consumes.
 */
function tallyTask(stats, task) {
  stats.total += 1;
  const raw = (task.rawStatus ?? task.status ?? '').toLowerCase();
  const status = task.status;
  if (status === 'done') stats.done += 1;
  else if (status === 'cancelled') stats.cancelled += 1;
  else if (status === 'in_progress') stats.inProgress += 1;
  else stats.open += 1; // pending bucket (open/failed/blocked collapse here)

  if (raw === 'blocked' || raw === 'failed') stats.blocked += 1;

  // needsYou: open or blocked work nobody's actively running. in_progress and
  // terminal states never "need you". A blocked/failed row always does.
  const terminal = status === 'done' || status === 'cancelled';
  if (!terminal && status !== 'in_progress') {
    stats.needsYou += 1;
  } else if (raw === 'blocked' || raw === 'failed') {
    stats.needsYou += 1;
  }
}

function addStats(into, from) {
  into.total += from.total;
  into.open += from.open;
  into.inProgress += from.inProgress;
  into.done += from.done;
  into.cancelled += from.cancelled;
  into.blocked += from.blocked;
  into.needsYou += from.needsYou;
}

/**
 * Aggregate task stats per project, rolling CHILD project stats UP into their
 * ancestors. Each project's entry has:
 *   - `own`:   stats for tasks whose projectId === this project
 *   - `rolled`: own + every descendant's own (what an L1 card shows)
 *
 * Tasks reference a project via `task.projectId`; tasks with no projectId (or
 * one not in the forest) are ignored for roll-up (they belong to no project).
 *
 * @param {ProjectNode[]} roots
 * @param {Task[]} tasks
 * @returns {Map<string, { own: TaskStats, rolled: TaskStats }>}
 */
export function rollUpTaskStats(roots, tasks, terminalByProject) {
  const index = indexTree(roots);
  /** @type {Map<string, { own: TaskStats, rolled: TaskStats }>} */
  const stats = new Map();
  for (const id of index.keys()) {
    stats.set(id, { own: emptyStats(), rolled: emptyStats() });
  }

  // 1. Tally OWN stats from each task's projectId.
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const pid = t && t.projectId;
    if (!pid) continue;
    const entry = stats.get(pid);
    if (!entry) continue; // task points at a project not in this forest
    tallyTask(entry.own, t);
  }

  // task-3abb663aba25 — TERMINAL-count overlay. Home no longer materializes the
  // whole done/cancelled archive in the renderer (it fetches only the live
  // working set — includeDone:false). The terminal counts instead come from the
  // DB skeleton (all statuses, opaque routing only) as a per-project
  // { done, cancelled } map and are folded into `own` here so the rolled-up
  // badges stay exact as history grows, WITHOUT pulling every done task across
  // IPC. Absent (undefined) → behaves exactly as before (tasks carry terminals).
  if (terminalByProject) {
    const entries =
      terminalByProject instanceof Map
        ? terminalByProject.entries()
        : Object.entries(terminalByProject);
    for (const [pid, counts] of entries) {
      const entry = stats.get(pid);
      if (!entry || !counts) continue;
      const done = Number(counts.done) || 0;
      const cancelled = Number(counts.cancelled) || 0;
      entry.own.done += done;
      entry.own.cancelled += cancelled;
      entry.own.total += done + cancelled;
    }
  }

  // 2. Roll up: post-order so children are summed before parents. Seed each
  //    project's rolled with its own, then fold every child's rolled in.
  const rollNode = (node) => {
    const entry = stats.get(node.project.id);
    addStats(entry.rolled, entry.own);
    for (const child of node.children) {
      rollNode(child);
      addStats(entry.rolled, stats.get(child.project.id).rolled);
    }
  };
  for (const r of roots) rollNode(r);

  return stats;
}
