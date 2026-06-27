// Selector-candidate scoring — the PURE core of "teach by recording".
//
// When a human performs a browser action while RECORDING, the page preload
// (record-preload.mjs) computes several candidate selectors for the acted-on
// element — text, aria-label, data-testid, an :nth-of-type fallback, a full CSS
// path, and (added in MAIN from the accessibility tree) role + accessible name.
// Each candidate also gets a `matchCount`: how many elements that selector
// matches on the page right now (1 == unique).
//
// This module ranks those candidates so Claude Code (or the recorder, as a
// default) can pick the MOST STABLE one to save as a shared skill. The ranking
// is a plain pure function of the candidate list — no DOM, no Electron — so it
// is unit-tested directly (tests/selectorCandidates.test.mjs).
//
// STABILITY MODEL (higher score = more stable / preferred):
//   - role+name and data-testid are the most durable: they survive restyling,
//     re-bundling, and most DOM reshuffles. Highest base weight.
//   - aria-label is durable (semantic) but slightly below testid.
//   - visible text is fairly durable but can be i18n'd / reworded.
//   - an :nth / structural CSS path is the LAST resort: it breaks the moment the
//     layout shifts. Lowest weight.
//   - UNIQUENESS dominates: a candidate that matches !=1 elements is ambiguous;
//     it is penalized hard (matchCount 0 means "stale"/not found → worst).
//
// NON-PHI: candidates carry SELECTORS and structure only, never field VALUES.
// The recorder stores a placeholder key for any typed value, never the value.

/** Base durability weight per candidate kind (higher = more stable). */
export const KIND_WEIGHT = {
  role: 100, // role + accessible name (from the a11y tree)
  testid: 95, // data-testid / data-test / data-qa
  arialabel: 80, // aria-label / aria-labelledby text
  text: 60, // visible text content
  id: 70, // a stable-looking #id (not auto-generated)
  css: 30, // structural CSS path
  nth: 20, // :nth-of-type positional fallback
};

/** Score ONE candidate. Pure. Returns a number; higher is more stable.
 *
 *  @param c.kind        one of KIND_WEIGHT's keys
 *  @param c.matchCount  how many elements the selector currently matches
 *                       (undefined == unknown → treated as non-unique)
 */
export function scoreCandidate(c) {
  if (!c || typeof c !== 'object') return -Infinity;
  const base = KIND_WEIGHT[c.kind] ?? 10;
  const n = c.matchCount;
  // Uniqueness multiplier dominates the ranking.
  let uniq;
  if (n === 1) uniq = 1; // unique → full credit
  else if (n === 0 || n == null) uniq = 0; // not found / unknown → no credit
  else uniq = 1 / (1 + (n - 1)); // ambiguous → decays as it matches more
  if (uniq === 0) return 0; // stale / not found / unknown → cleanly zero
  // A long, brittle CSS path is worse than a short one; gently penalize length.
  const lenPenalty = typeof c.selector === 'string' ? Math.min(c.selector.length / 400, 0.25) : 0;
  return base * uniq - base * lenPenalty;
}

/** Rank candidates most-stable-first. Returns a NEW array of
 *  { ...candidate, score }, stable-sorted (ties keep input order). Pure. */
export function rankCandidates(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  return list
    .map((c, i) => ({ ...c, score: scoreCandidate(c), _i: i }))
    .sort((a, b) => b.score - a.score || a._i - b._i)
    .map(({ _i, ...rest }) => rest);
}

/** The single best candidate, or null when there are none / none are usable
 *  (every candidate is ambiguous/stale). Pure. */
export function bestCandidate(candidates) {
  const ranked = rankCandidates(candidates);
  const top = ranked[0];
  if (!top || !(top.score > 0)) return null;
  return top;
}

/** CSS.escape, available in the page but NOT in a node test — provide a tiny
 *  spec-faithful-enough fallback so the SAME escaping logic can be unit-tested
 *  and reused by the preload. Escapes characters that are not valid unescaped
 *  in a CSS identifier. */
export function cssEscapeIdent(s) {
  const str = String(s == null ? '' : s);
  // Leading digit or '-digit' must be escaped numerically per CSS spec.
  return str.replace(/[^a-zA-Z0-9_ -￿-]/g, (ch) => '\\' + ch).replace(/^(-?)(\d)/, (_m, dash, d) => dash + '\\3' + d + ' ');
}
