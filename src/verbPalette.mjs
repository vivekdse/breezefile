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
// task-f8bb12b2bae3 — VERB PARITY with the file manager. The Home/Projects
// quick-switcher feeds these same rows. Previously the matcher treated the
// whole query as ONE contiguous substring (`haystack.includes(q)`), so a
// multi-word query whose words land in DIFFERENT fields — "max window",
// "toggle maximize", "settings keybinds" — failed to match here even though
// the file manager's ChipPrompt picker (which TOKENIZES and requires every
// token to hit) found them. That divergence was the "no matches" bug. We now
// tokenize on whitespace exactly like ChipPrompt's `matches` scorer: EVERY
// token must appear somewhere in the haystack, and the score is driven by how
// the FIRST token lands (so single-token behavior is unchanged), with a
// contiguity bonus when the tokens appear adjacent in the label/aliases.
//
// Ranking, in order of weight (driven by the first token):
//   • label starts-with the token                       (strongest)
//   • id starts-with the token
//   • an alias starts-with the token
//   • a word inside the label starts-with the token
//   • label / alias / description merely contains it     (weakest)
//   • + each extra token found in the label
//   • + contiguity bonus when the tokens are adjacent
//   • availability: available verbs sort above unavailable ones
//   • recency: recently-run verbs get a decaying boost
// Empty query returns every row, recency-then-category-then-label ordered.
// ────────────────────────────────────────────────────────────────────────────

function scoreOne(v, tokens) {
  const label = v.label.toLowerCase();
  const aliases = (v.aliases ?? []).map((a) => a.toLowerCase());
  const desc = (v.description ?? '').toLowerCase();
  const id = v.id.toLowerCase();
  const haystack = `${label} ${aliases.join(' ')} ${desc} ${id}`;

  // Multi-token: require EVERY token to appear somewhere in the haystack
  // (substring, any order) — mirrors ChipPrompt's verb-picker matcher so a
  // query like "max window" or "settings keybinds" resolves on Home exactly
  // as it does in the file manager.
  if (!tokens.every((t) => haystack.includes(t))) return -1;

  // Score by how the FIRST token lands. This keeps single-token ranking
  // identical to the previous behavior.
  const first = tokens[0];
  let score = 0;
  if (label.startsWith(first)) score += 100;
  else if (id.startsWith(first)) score += 90;
  else if (aliases.some((a) => a.startsWith(first))) score += 80;
  else if (label.split(/[\s_\-./]+/).some((w) => w.startsWith(first))) score += 60;
  else if (label.includes(first)) score += 40;
  else if (aliases.some((a) => a.includes(first))) score += 30;
  else score += 10; // only in description / id substring

  // Each extra token that hits the LABEL (not just an alias/description) nudges
  // the verb up — a verb whose name carries more of the query reads as the
  // better target.
  for (let i = 1; i < tokens.length; i++) {
    if (label.includes(tokens[i])) score += 5;
  }

  // Contiguity bonus: tokens appearing adjacent (separated only by space /
  // `-` / `_` / `.`) in the label OR an alias rank above the same tokens
  // scattered across unrelated words — same intuition as ChipPrompt's scorer.
  if (tokens.length >= 2) {
    const contiguous = tokens.join('[\\s\\-_.]+');
    try {
      const re = new RegExp(contiguous);
      if (re.test(label) || aliases.some((a) => re.test(a))) score += 60;
    } catch {
      // bad regex tokens — skip the bonus
    }
  }

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
  const tokens = q.split(/\s+/).filter((t) => t.length > 0);

  if (tokens.length === 0) {
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
    let score = scoreOne(v, tokens);
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
