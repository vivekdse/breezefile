// fm-3vl — type surface for the pure selectionStats.mjs aggregate helper that
// backs the destructive bulk-verb confirmation.

export interface Aggregate {
  count: number;
  totalSize: number;
  oldestMtimeMs: number | null;
}

/** Aggregate count, total size (bytes) and oldest mtime over file rows.
 *  Accepts the renderer Entry shape ({ size, mtimeMs }) or the DSL row shape
 *  ({ size, mtime }); missing/non-numeric fields are skipped. */
export declare function aggregateStats(
  rows: Array<{ size?: number; mtimeMs?: number; mtime?: number }> | null | undefined,
): Aggregate;

/** Binary-unit byte formatting (1024-based), matching src/sort.ts formatSize. */
export declare function formatBytes(bytes: number): string;

/** 4-digit year of the oldest mtime, or null when there is none. */
export declare function oldestYear(oldestMtimeMs: number | null): number | null;

/** One-line summary, e.g. "247 files, 14.2 GB, oldest 2019". Clauses with no
 *  data are omitted. */
export declare function summarizeStats(stats: Aggregate, noun?: string): string;
