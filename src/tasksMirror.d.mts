// task-3abb663aba25 — type surface for the pure renderer diff-apply mirror merge
// (tasksMirror.mjs is plain ESM so `node --test` can exercise the exact merge).

/** Apply an add/update/remove diff to a mirror list, keyed by opaque `id`.
 *  Upserts replace in place (or append), removedIds drop; remove wins over
 *  upsert for the same id. Returns a NEW array (never mutates `mirror`). */
export function mergeTaskMirror<T extends { id: string }>(
  mirror: T[],
  upserts: T[],
  removedIds: Iterable<string>,
): T[];

/** Ids to remove after a peek: requested ids not returned (left the cache or no
 *  longer match this slice's filter), unioned with the diff's explicit removals. */
export function computeRemovedIds(
  requestedIds: Iterable<string>,
  returnedIds: Iterable<string>,
  removedIds: Iterable<string>,
): string[];
