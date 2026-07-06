// task-<local-first-speed> — pure ordering + recency-cutoff + pagination for the
// New Home roster. Plain ESM (mirrors rosterGroups.mjs / queryEngine.mjs) so it
// runs under `node --test` with no transpile; the .d.mts sibling types it.
//
// This module is DELIBERATELY value-free about PHI: it orders/limits rows using
// only NON-PHI signals already on the view-model (status, lastActionAt epoch,
// priority, id). It never reads task title/body text. Nothing here logs or
// persists.
//
// WHY: the roster loads every task — including done/cancelled ones finished a
// month ago — and shows them in whatever order the source handed back. This
// (a) sorts by most-recent-activity, (b) hides stale terminal tasks behind a
// recency cutoff so Home shows what's live, and (c) paginates so the first
// paint is a bounded slice, not the whole inventory.

/**
 * @typedef {Object} RosterRow
 * @property {string} id
 * @property {string} status        one of the five NewHome buckets
 * @property {number|null} [lastActionAt]  epoch ms of newest activity
 * @property {number} [priority]
 * @property {Object} [raw]          full task (only raw.priority read, optional)
 */

// Terminal buckets subject to the recency cutoff. 'failed' stays visible
// regardless of age — a failure needs a human even if it's old; only cleanly
// finished work (done) ages out. 'needs'/'progress'/'queued' are live by
// definition and never cut.
const AGING_STATUSES = new Set(['done']);

/** Read a row's newest-activity epoch ms, or 0 when unknown (sorts last). */
export function recencyOf(row) {
  const v = row && typeof row.lastActionAt === 'number' ? row.lastActionAt : null;
  return v == null ? 0 : v;
}

/** Read a row's priority (higher = more important); default 0. */
function priorityOf(row) {
  if (row && typeof row.priority === 'number') return row.priority;
  const p = row && row.raw && typeof row.raw.priority === 'number' ? row.raw.priority : 0;
  return p;
}

/**
 * Sort rows for the roster: most-recent activity first, then higher priority,
 * then id for stability. Pure — returns a new array, does not mutate.
 * @param {RosterRow[]} rows
 * @returns {RosterRow[]}
 */
export function sortByRecency(rows) {
  const list = Array.isArray(rows) ? [...rows] : [];
  return list.sort((a, b) => {
    const ra = recencyOf(a);
    const rb = recencyOf(b);
    if (rb !== ra) return rb - ra; // newer first
    const pa = priorityOf(a);
    const pb = priorityOf(b);
    if (pb !== pa) return pb - pa; // higher priority first
    const ia = a && typeof a.id === 'string' ? a.id : '';
    const ib = b && typeof b.id === 'string' ? b.id : '';
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

/**
 * Split rows into { hot, cold }: `cold` is terminal (done) work whose newest
 * activity is OLDER than `now - hotDays*day`; `hot` is everything else (all live
 * work + recently-finished). Rows with no timestamp are treated as hot (we can't
 * prove they're stale, so never hide them). Pure.
 *
 * @param {RosterRow[]} rows
 * @param {{ now: number, hotDays: number }} opts
 * @returns {{ hot: RosterRow[], cold: RosterRow[] }}
 */
export function partitionByRecency(rows, opts) {
  const list = Array.isArray(rows) ? rows : [];
  const now = opts && typeof opts.now === 'number' ? opts.now : 0;
  const hotDays = opts && typeof opts.hotDays === 'number' ? opts.hotDays : 7;
  const cutoff = now - hotDays * 86_400_000;
  const hot = [];
  const cold = [];
  for (const r of list) {
    const aging = r && AGING_STATUSES.has(r.status);
    const ts = recencyOf(r);
    // Aging status AND a known timestamp older than the cutoff → cold.
    if (aging && ts > 0 && ts < cutoff) cold.push(r);
    else hot.push(r);
  }
  return { hot, cold };
}

/**
 * Group-aware pagination. Takes the SORTED rows plus a function that returns a
 * row's group KEY (or null for an ungrouped row), and returns the first `limit`
 * UNITS — where a unit is one ungrouped row OR one whole group (all its rows
 * stay together, so a template/chain group never splits across the page
 * boundary). A group's position is where its FIRST row sorts.
 *
 * Returns { page, shown, total, hasMore }: `page` is the row slice to render,
 * `shown`/`total` are UNIT counts (for a "showing N of M" label), `hasMore`
 * says whether a "load more" is warranted.
 *
 * @param {RosterRow[]} rows           already sorted
 * @param {(row: RosterRow) => (string|null)} groupKeyOf
 * @param {{ limit: number }} opts
 * @returns {{ page: RosterRow[], shown: number, total: number, hasMore: boolean }}
 */
export function paginateGroupAware(rows, groupKeyOf, opts) {
  const list = Array.isArray(rows) ? rows : [];
  const limit = opts && typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : list.length;

  // Count total UNITS (distinct group keys + ungrouped rows) for the label.
  const seenGroups = new Set();
  let totalUnits = 0;
  for (const r of list) {
    const k = groupKeyOf ? groupKeyOf(r) : null;
    if (k == null) {
      totalUnits += 1;
    } else if (!seenGroups.has(k)) {
      seenGroups.add(k);
      totalUnits += 1;
    }
  }

  if (limit >= totalUnits) {
    return { page: list, shown: totalUnits, total: totalUnits, hasMore: false };
  }

  // Walk in sorted order, admitting whole units until we hit the limit. Once a
  // group is admitted, ALL its rows are kept (even ones appearing later in the
  // sort) so the group renders intact.
  const admittedGroups = new Set();
  const page = [];
  let units = 0;
  for (const r of list) {
    const k = groupKeyOf ? groupKeyOf(r) : null;
    if (k == null) {
      if (units >= limit) continue; // ungrouped row past the limit → drop
      page.push(r);
      units += 1;
    } else if (admittedGroups.has(k)) {
      page.push(r); // already-admitted group's later row → keep with its group
    } else {
      if (units >= limit) continue; // new group past the limit → drop
      admittedGroups.add(k);
      page.push(r);
      units += 1;
    }
  }
  return { page, shown: units, total: totalUnits, hasMore: units < totalUnits };
}
