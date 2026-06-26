// fm-mp1 / fm-xr0 — type surface for the pure filterEntries.mjs helpers.
//
// Shared selector-over-entries reduction used by filter-tabs (fm-mp1, "which
// walked entries match?") and frozen tags (fm-xr0, "which paths match right
// now?"). Pure: no fs / IPC / React.

import type { FileRow } from './tagDsl.d.mts';
import type { ResolverTag } from './dslTagResolve.d.mts';

export interface FilterEntriesOpts {
  /** DSL-tag store list so `tag:name` atoms resolve. */
  tags?: ResolverTag[];
  /** Injectable clock for deterministic now/relative-date tests. */
  now?: number | (() => number);
}

/** Filter entry rows by a tagDsl selector (throws ParseError on bad selector). */
export declare function filterEntries<T extends FileRow>(
  entries: T[],
  selector: string,
  opts?: FilterEntriesOpts,
): T[];

/** Compute a frozen snapshot: the deduped set of matching paths, as of now. */
export declare function computeSnapshot(
  entries: FileRow[],
  selector: string,
  opts?: FilterEntriesOpts,
): string[];
