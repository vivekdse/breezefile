// task-317c7fe41f90 — type surface for the pure dslTagResolve.mjs bridge.
//
// Builds the `resolveTag` callback the tagDsl evaluator (src/tagDsl.mjs) injects
// for `tag:name` atoms, backed by the DSL-tag store records (src/tagStore.mjs).
// Recursion is cycle-guarded (a back-reference resolves to false with a warn).

import type { FileRow } from './tagDsl.d.mts';

/** The subset of a stored Tag this resolver needs. Mirrors tagStore Tag. */
export interface ResolverTag {
  name: string;
  selector: string;
  mode?: 'live' | 'frozen';
  snapshot?: string[];
}

export interface MakeResolveTagOpts {
  /** Injectable clock forwarded to the evaluator for now/relative dates. */
  now?: number | (() => number);
}

/** Build a synchronous resolveTag over a fixed list of DSL-store tags. Live
 *  tags re-evaluate their selector recursively; frozen tags test snapshot
 *  membership by path. Cycles and unknown names resolve to false (with a warn). */
export declare function makeResolveTag(
  tags: ResolverTag[],
  opts?: MakeResolveTagOpts,
): (name: string, row: FileRow) => boolean;
