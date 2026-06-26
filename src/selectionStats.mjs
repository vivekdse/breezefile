// fm-3vl — pure aggregate-stats helper for the bulk-verb confirmation.
//
// The destructive bulk verbs (trash / move / rename) show an AGGREGATE
// confirmation ("Will trash 247 files, 14.2 GB, oldest 2019") instead of just
// listing file names. This module computes that aggregate from a list of
// file rows (the renderer's Entry shape: { size, mtimeMs, ... }) and formats
// the human-readable pieces.
//
// PURE: no React, no fs, no IPC — authored as plain ESM so `node --test
// tests/` imports it directly (same pattern as tagDsl.mjs / dslTagResolve.mjs)
// and the React layer can import it too.

/**
 * Aggregate count, total size (bytes) and oldest modification time over a set
 * of file rows. Missing/non-numeric size or mtime fields are skipped rather
 * than poisoning the totals (a row with no size contributes 0; a row with no
 * mtime doesn't move `oldestMtimeMs`).
 *
 * @param {Array<{ size?: number, mtimeMs?: number, mtime?: number }>} rows
 * @returns {{ count: number, totalSize: number, oldestMtimeMs: number | null }}
 */
export function aggregateStats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let totalSize = 0;
  let oldestMtimeMs = null;
  for (const r of list) {
    if (!r) continue;
    const size = Number(r.size);
    if (Number.isFinite(size) && size > 0) totalSize += size;
    // Accept both the renderer Entry shape (mtimeMs) and the DSL row shape
    // (mtime) so either kind of row can be passed in.
    const m = Number(r.mtimeMs != null ? r.mtimeMs : r.mtime);
    if (Number.isFinite(m) && m > 0) {
      if (oldestMtimeMs == null || m < oldestMtimeMs) oldestMtimeMs = m;
    }
  }
  return { count: list.length, totalSize, oldestMtimeMs };
}

/** Format a byte count as a binary-unit string (1024-based), matching the
 *  file-manager convention used elsewhere (src/sort.ts formatSize). */
export function formatBytes(bytes) {
  const n0 = Number(bytes);
  if (!Number.isFinite(n0) || n0 <= 0) return '0 B';
  if (n0 < 1024) return `${Math.round(n0)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  let n = n0;
  do {
    n /= 1024;
    i += 1;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

/** The 4-digit year of the oldest mtime, or null when there is none. */
export function oldestYear(oldestMtimeMs) {
  if (oldestMtimeMs == null || !Number.isFinite(Number(oldestMtimeMs))) return null;
  return new Date(Number(oldestMtimeMs)).getFullYear();
}

/**
 * One-line human summary of an aggregate, e.g.
 *   "247 files, 14.2 GB, oldest 2019"
 * `noun` lets the caller pluralize ("file"/"item"). Pieces with no data are
 * omitted (no size → drop the size clause; no mtime → drop the year clause).
 *
 * @param {{ count: number, totalSize: number, oldestMtimeMs: number | null }} stats
 * @param {string} [noun='file']
 */
export function summarizeStats(stats, noun = 'file') {
  const count = stats?.count ?? 0;
  const parts = [`${count} ${noun}${count === 1 ? '' : 's'}`];
  if (stats?.totalSize > 0) parts.push(formatBytes(stats.totalSize));
  const yr = oldestYear(stats?.oldestMtimeMs);
  if (yr != null) parts.push(`oldest ${yr}`);
  return parts.join(', ');
}
