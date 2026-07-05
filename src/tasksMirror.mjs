// task-3abb663aba25 — PURE mirror-merge for the renderer's diff-apply path.
//
// useTasks holds a local MIRROR of its slice of the task list. On a
// `tasks:changed` broadcast carrying a PHI-free diff ({ added, changed, removed }
// — opaque ids only), the renderer fetches ONLY the affected rows from the
// main-process cache (fm.tasksPeek — no network, no full-list re-serialization)
// and folds them into the mirror with this function, instead of re-pulling and
// re-serializing the WHOLE list over IPC on every change.
//
// Extracted as plain ESM (like src/projects/*.mjs) so `node --test` can exercise
// the EXACT merge the hook runs at runtime.
//
// Semantics (keyed by opaque `id`):
//   - a row in `upserts` replaces the mirror row with the same id IN PLACE
//     (stable order), or is appended if genuinely new;
//   - a row whose id is in `removedIds` is dropped;
//   - remove wins over upsert for the same id (a row that both changed AND fell
//     out of this slice's filter is removed, not re-added).
// No PHI logic here — it only shuffles opaque row objects by id.

/**
 * @template {{ id: string }} T
 * @param {T[]} mirror       current mirror list
 * @param {T[]} upserts      rows to insert/replace (already filtered to this slice)
 * @param {Iterable<string>} removedIds ids to drop
 * @returns {T[]} a NEW array (never mutates `mirror`)
 */
export function mergeTaskMirror(mirror, upserts, removedIds) {
  const removed = new Set(removedIds || []);
  const upsertById = new Map();
  for (const t of upserts || []) if (t && t.id) upsertById.set(t.id, t);

  const out = [];
  const placed = new Set();
  for (const t of Array.isArray(mirror) ? mirror : []) {
    if (!t || removed.has(t.id)) continue;
    const up = upsertById.get(t.id);
    out.push(up || t);
    placed.add(t.id);
  }
  // Append genuinely-new upserts (not already replaced in place, not removed).
  for (const t of upserts || []) {
    if (!t || !t.id) continue;
    if (placed.has(t.id) || removed.has(t.id)) continue;
    out.push(t);
    placed.add(t.id);
  }
  return out;
}

/**
 * Compute the set of ids to REMOVE from the mirror after a peek. The peek was
 * asked for `requestedIds` (the diff's added ∪ changed) and returned only the
 * rows that still match this slice's filter (`returnedIds`). Any requested id
 * NOT returned either vanished from the source cache or no longer matches the
 * filter → it must leave this slice. Union that with the diff's explicit
 * `removedIds`.
 *
 * @param {Iterable<string>} requestedIds
 * @param {Iterable<string>} returnedIds
 * @param {Iterable<string>} removedIds
 * @returns {string[]}
 */
export function computeRemovedIds(requestedIds, returnedIds, removedIds) {
  const returned = new Set(returnedIds || []);
  const out = new Set(removedIds || []);
  for (const id of requestedIds || []) if (!returned.has(id)) out.add(id);
  return [...out];
}
