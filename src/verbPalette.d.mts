// fm-m7q — type surface for the pure verbPalette.mjs ranking helper that backs
// the Cmd-K command palette.

export type PaletteVerb = {
  id: string;
  label: string;
  aliases?: string[];
  category?: string;
  description?: string;
  available: boolean;
  keybinding?: string;
};

/**
 * Filter + rank verbs for the command palette. Returns the rows whose
 * label/alias/description/id matches `query`, best-first; an empty query
 * returns every row ordered by availability, recency, category, then label.
 *
 * @param recency verb ids most-recently-run first (index 0 = most recent).
 */
export declare function rankPaletteVerbs(
  verbs: PaletteVerb[],
  query: string,
  recency?: string[],
): PaletteVerb[];
