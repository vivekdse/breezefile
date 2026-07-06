// task-c82d8e0f4eae — pure partition of a project-SUBTREE roster into the
// selected project's OWN tasks plus one navigable SECTION per direct child
// subproject. Plain `.mjs` (mirrors rosterGroups.mjs / pipelineRoster.mjs) so
// it runs under `node --test` with no transpile; the `.d.mts` sibling types it
// for RosterTable.tsx / NewHomePage.tsx.
//
// WHY: a parent project with no direct tasks — but task-bearing subprojects —
// used to render nothing, because the roster scoped on `projectId ===` a single
// id. useNewHomeData now aggregates the whole subtree (descendantProjectIds);
// this module then folds each DIRECT child subproject's subtree into a single
// rollup section so the user can drill parent → subproject → tasks. A section is
// the SAME building block a template group is (name + per-bucket status counts +
// a count + drill-in) — no new parallel surface.
//
// DELIBERATELY value-free: reads only id / projectId / coarse status. Task
// TITLES and field values (PHI) never flow through here.

import { indexTree } from '../../projects/tree.mjs';
import { statusBucket, STATUS_BUCKETS } from './rosterGroups.mjs';

/** A fresh { done, progress, queued, needs, failed } zeroed count bag. */
function emptyCounts() {
  /** @type {Record<string, number>} */
  const c = {};
  for (const b of STATUS_BUCKETS) c[b] = 0;
  return c;
}

/**
 * Partition `tasks` (a roster already covering the selected project's whole
 * subtree) into:
 *   - `ownTaskIds`: tasks belonging DIRECTLY to the selected project — or, for
 *     the "All projects" root case (selectedProjectId null/undefined), tasks
 *     with no project (or a project outside the forest — orphans).
 *   - `sections`: one per DIRECT child subproject that has ≥1 task ANYWHERE in
 *     its subtree, each carrying that subtree's task ids + a per-bucket status
 *     rollup + the total count. Ordered by the tree's own (name-sorted) child
 *     order. Empty subprojects are omitted (no navigational dead-ends).
 *
 * "All projects" is the degenerate root case: every top-level project becomes a
 * section, so the whole forest is reachable by drilling.
 *
 * @param {{ id: string, projectId?: string|null, status?: string }[]} tasks
 * @param {import('../../projects/tree.d.mts').ProjectNode[]} roots  buildProjectTree(projects)
 * @param {string|null|undefined} selectedProjectId  null/undefined = All projects
 * @returns {{ ownTaskIds: string[], sections: import('./subprojectSections.d.mts').SubprojectSection[] }}
 */
export function buildSubprojectSections(tasks, roots, selectedProjectId) {
  const list = Array.isArray(tasks) ? tasks : [];
  const nodes = Array.isArray(roots) ? roots : [];
  const index = indexTree(nodes);

  // The direct children whose subtrees become sections, and the id of the
  // selected scope itself (null for the virtual "All projects" root).
  let directChildren;
  let selfId;
  if (selectedProjectId && index.has(selectedProjectId)) {
    directChildren = index.get(selectedProjectId).children;
    selfId = selectedProjectId;
  } else if (selectedProjectId) {
    // Selected id not in the forest (loading / stale / foreign) — no known
    // children; every scoped task falls to `own`.
    directChildren = [];
    selfId = selectedProjectId;
  } else {
    directChildren = nodes; // All projects → each top-level project is a section
    selfId = null;
  }

  // Map every project id in a direct child's subtree → that child's id, so a
  // task nested arbitrarily deep still lands in the right top-level section.
  /** @type {Map<string, string>} */
  const sectionIdByProject = new Map();
  /** @type {{ id: string, name: string }[]} */
  const childOrder = [];
  for (const child of directChildren) {
    const subtree = indexTree(child);
    childOrder.push({ id: child.project.id, name: child.project.name ?? child.project.id });
    for (const pid of subtree.keys()) sectionIdByProject.set(pid, child.project.id);
  }

  /** @type {string[]} */
  const ownTaskIds = [];
  /** @type {Map<string, { taskIds: string[], statusCounts: Record<string, number> }>} */
  const acc = new Map();
  for (const t of list) {
    if (!t || typeof t.id !== 'string') continue;
    const pid = t.projectId ?? null;
    const sectionId = pid ? sectionIdByProject.get(pid) : undefined;
    if (sectionId && sectionId !== selfId) {
      let entry = acc.get(sectionId);
      if (!entry) {
        entry = { taskIds: [], statusCounts: emptyCounts() };
        acc.set(sectionId, entry);
      }
      entry.taskIds.push(t.id);
      entry.statusCounts[statusBucket(t.status)] += 1;
    } else {
      // pid === selfId, or no/foreign project → belongs to the selected scope.
      ownTaskIds.push(t.id);
    }
  }

  const sections = [];
  for (const { id, name } of childOrder) {
    const entry = acc.get(id);
    if (!entry || entry.taskIds.length === 0) continue; // omit empty subprojects
    sections.push({
      id,
      name,
      taskIds: entry.taskIds,
      statusCounts: entry.statusCounts,
      taskCount: entry.taskIds.length,
    });
  }
  return { ownTaskIds, sections };
}
