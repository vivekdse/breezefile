// task-317c7fe41f90 — the resolveTag BRIDGE deferred by tagDsl.mjs:13-21 and
// tagStore.mjs:18-21.
//
// The DSL evaluator (src/tagDsl.mjs) treats a `tag:name` atom as an injectable
// membership test: it calls `opts.resolveTag(name, fileRow)` and never decides
// itself what a tag name means. This module supplies that resolver against the
// DSL-tag STORE (src/tagStore.mjs records: { name, selector, mode, snapshot? }).
//
// A tag resolves to a membership predicate two ways:
//   - mode 'live'   → parse(tag.selector) and evaluate it recursively against
//                     the row (so `tag:foo` where foo's selector is `ext = pdf`
//                     means "this row matches foo's selector").
//   - mode 'frozen' → membership is the pinned `snapshot` set of paths; the row
//                     matches iff row.path is in the snapshot.
//
// A selector may itself contain `tag:other` atoms, so resolution is RECURSIVE.
// That admits CYCLES (tag A's selector references B, B's references A). We guard
// with an in-flight name set: re-entering a tag already on the stack is treated
// as NO-MATCH (false) with a single console.warn, so a cycle degrades to false
// instead of overflowing the stack. Unknown tag names also resolve to false
// (with a warn) — a dangling reference shouldn't throw mid-evaluation.
//
// PURE: no fs, no IPC, no React. The caller passes the tag list in (the Electron
// host fetches it from the store over IPC; tests pass a literal array). This
// keeps the resolver unit-testable exactly like tagDsl/tagStore.

import { parse, evaluate } from './tagDsl.mjs';

/**
 * Build a synchronous resolveTag function over a fixed list of DSL-store tags.
 *
 * @param {Array<{ name: string, selector: string, mode?: 'live'|'frozen', snapshot?: string[] }>} tags
 * @param {{ now?: number | (() => number) }} [opts]
 * @returns {(name: string, row: object) => boolean}
 */
export function makeResolveTag(tags, opts = {}) {
  const byName = new Map();
  for (const t of tags || []) {
    // First definition wins for a duplicate name (matches store.getByName,
    // which returns the first match).
    if (t && typeof t.name === 'string' && !byName.has(t.name)) byName.set(t.name, t);
  }

  // Memoize parsed ASTs so a tag referenced many times only parses once.
  const astCache = new Map();
  function astFor(tag) {
    if (astCache.has(tag.name)) return astCache.get(tag.name);
    let ast = null;
    try {
      ast = parse(tag.selector);
    } catch (err) {
      console.warn(
        `dslTagResolve: tag '${tag.name}' has an invalid selector and will not match: ${
          err && err.message ? err.message : err
        }`,
      );
      ast = null;
    }
    astCache.set(tag.name, ast);
    return ast;
  }

  // The active resolution stack — names currently being resolved for THIS row.
  // Shared across the recursive resolveTag closure so a cycle is detectable.
  const inFlight = new Set();
  const warnedCycle = new Set();
  const warnedMissing = new Set();

  function resolveTag(name, row) {
    const tag = byName.get(name);
    if (!tag) {
      if (!warnedMissing.has(name)) {
        warnedMissing.add(name);
        console.warn(`dslTagResolve: tag:${name} references an unknown tag — treating as no-match`);
      }
      return false;
    }

    if (inFlight.has(name)) {
      if (!warnedCycle.has(name)) {
        warnedCycle.add(name);
        console.warn(
          `dslTagResolve: cycle detected resolving tag:${name} — treating the back-reference as no-match`,
        );
      }
      return false;
    }

    // Frozen tags pin a snapshot of paths; membership is set lookup.
    if (tag.mode === 'frozen') {
      const snap = Array.isArray(tag.snapshot) ? tag.snapshot : [];
      const p = row && row.path != null ? String(row.path) : undefined;
      return p != null && snap.includes(p);
    }

    // Live tags re-evaluate their selector recursively. Push the name so a
    // self/mutual reference encountered while evaluating is caught above.
    const ast = astFor(tag);
    if (!ast) return false; // unparseable selector → no-match (already warned)
    inFlight.add(name);
    try {
      return !!evaluate(ast, row, { now: opts.now, resolveTag });
    } finally {
      inFlight.delete(name);
    }
  }

  return resolveTag;
}
