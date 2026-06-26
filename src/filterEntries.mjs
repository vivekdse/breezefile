// fm-mp1 / fm-xr0 — pure selector-over-entries helpers shared by the two
// smart-folder features:
//   - fm-mp1 filter-tabs: a tab bound to a selector lists the entries (walked
//     recursively across a scope by main) that MATCH the selector.
//   - fm-xr0 frozen tags: at save time we capture the SET OF PATHS that match a
//     selector right now into the tag's `snapshot`; later visualization reads
//     the snapshot instead of re-evaluating.
//
// Both reduce to "given a list of entry rows + a selector string, which rows
// match?". This module is that reduction, kept PURE (no fs / IPC / React) so it
// is unit-testable exactly like tagDsl.mjs / tagStore.mjs / dslTagResolve.mjs.
// The Electron host supplies the entries (via the fs:walkScope IPC) and the
// DSL-tag list (for resolving `tag:name` atoms); tests pass literals.
//
// Authored as plain ESM (with a co-located .d.mts) so `node --test tests/` can
// import it directly without a transpile step.

import { parse, evaluate } from './tagDsl.mjs';
import { makeResolveTag } from './dslTagResolve.mjs';

/**
 * Filter a list of entry rows by a tagDsl selector.
 *
 * @param {Array<object>} entries  rows the evaluator understands (Entry shape —
 *   path/name/ext/size/mtimeMs/kind/isHidden — or DSL field names; tagDsl
 *   normalizes both).
 * @param {string} selector  a tagDsl query string (parse() consumes it).
 * @param {{ tags?: Array, now?: number | (() => number) }} [opts]
 *   tags: the DSL-tag store list so `tag:name` atoms resolve; now: injectable
 *   clock for deterministic now/relative-date tests.
 * @returns {Array<object>} the subset of `entries` that match (input order).
 * @throws {ParseError} if the selector is unparseable (caller decides UX).
 */
export function filterEntries(entries, selector, opts = {}) {
  const ast = parse(selector); // throws on bad selector — surfaced to caller
  const resolveTag = makeResolveTag(opts.tags || [], { now: opts.now });
  const evalOpts = { resolveTag, now: opts.now };
  const out = [];
  for (const e of entries || []) {
    let hit = false;
    try {
      hit = evaluate(ast, e, evalOpts);
    } catch {
      // A row that throws mid-eval (shouldn't with a parsed ast) is skipped
      // rather than aborting the whole walk.
      hit = false;
    }
    if (hit) out.push(e);
  }
  return out;
}

/**
 * Compute a FROZEN snapshot: the set of matching PATHS for a selector over a
 * set of entries, captured "as of now". This is what fm-xr0 pins into a tag's
 * `snapshot` field at save time.
 *
 * Deduplicated, in input order. Rows without a `path` are skipped (a snapshot
 * is a set of paths, by definition).
 *
 * @param {Array<object>} entries  see filterEntries.
 * @param {string} selector  a tagDsl query string.
 * @param {{ tags?: Array, now?: number | (() => number) }} [opts]
 * @returns {string[]} matching paths (deduped).
 */
export function computeSnapshot(entries, selector, opts = {}) {
  const matched = filterEntries(entries, selector, opts);
  const seen = new Set();
  const paths = [];
  for (const e of matched) {
    const p = e && e.path != null ? String(e.path) : undefined;
    if (p == null || seen.has(p)) continue;
    seen.add(p);
    paths.push(p);
  }
  return paths;
}
