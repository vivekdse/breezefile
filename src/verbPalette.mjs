// ────────────────────────────────────────────────────────────────────────────
// fm-m7q — pure verb-palette filtering + ranking.
//
// Factored out of the React surface so the Cmd-K command palette's scoring is
// unit-testable without mounting anything (see tests/verb-palette.test.mjs).
// The palette feeds in lightweight rows (id/label/aliases/category/description/
// available/keybinding) plus the typed query and an optional recency list of
// verb ids; rankPaletteVerbs returns the rows filtered to query matches and
// sorted best-first.
//
// Ranking, in order of weight:
//   • label starts-with the query                       (strongest)
//   • id starts-with the query
//   • an alias starts-with the query
//   • a word inside the label starts-with the query
//   • label / alias / description merely contains it     (weakest)
//   • availability: available verbs sort above unavailable ones
//   • recency: recently-run verbs get a decaying boost
// Empty query returns every row, recency-then-category-then-label ordered.
// ────────────────────────────────────────────────────────────────────────────

function scoreOne(v, q) {
  const label = v.label.toLowerCase();
  const aliases = (v.aliases ?? []).map((a) => a.toLowerCase());
  const desc = (v.description ?? '').toLowerCase();
  const id = v.id.toLowerCase();
  const haystack = `${label} ${aliases.join(' ')} ${desc} ${id}`;
  if (!haystack.includes(q)) return -1;

  let score = 0;
  if (label.startsWith(q)) score += 100;
  else if (id.startsWith(q)) score += 90;
  else if (aliases.some((a) => a.startsWith(q))) score += 80;
  else if (label.split(/[\s_\-./]+/).some((w) => w.startsWith(q))) score += 60;
  else if (label.includes(q)) score += 40;
  else if (aliases.some((a) => a.includes(q))) score += 30;
  else score += 10; // only in description / id substring

  // Shorter labels are likelier the intended target on an equal prefix.
  score -= Math.min(8, Math.floor(label.length / 12));
  return score;
}

/**
 * Filter + rank verbs for the command palette.
 *
 * @param {Array} verbs   the candidate rows
 * @param {string} query  the typed filter (trimmed/lowered internally)
 * @param {string[]} recency verb ids most-recently-run first; index 0 = most recent
 * @returns {Array}
 */
export function rankPaletteVerbs(verbs, query, recency = []) {
  const recencyRank = new Map();
  recency.forEach((id, i) => {
    if (!recencyRank.has(id)) recencyRank.set(id, i);
  });
  const recencyBoost = (id) => {
    const r = recencyRank.get(id);
    return r === undefined ? 0 : Math.max(0, 30 - r * 5);
  };

  const q = (query ?? '').trim().toLowerCase();

  if (!q) {
    // No query: keep every row. Order by availability, then recency, then
    // category, then label so the list is stable and grouped.
    return [...verbs].sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      const rb = recencyBoost(b.id) - recencyBoost(a.id);
      if (rb !== 0) return rb;
      const ca = a.category ?? '￿';
      const cb = b.category ?? '￿';
      if (ca !== cb) return ca.localeCompare(cb);
      return a.label.localeCompare(b.label);
    });
  }

  const scored = [];
  for (const v of verbs) {
    let score = scoreOne(v, q);
    if (score < 0) continue;
    if (!v.available) score -= 1000; // available verbs first, but keep them listed
    score += recencyBoost(v.id);
    scored.push({ v, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.v.label.localeCompare(b.v.label);
  });
  return scored.map((s) => s.v);
}
