import type { Entry, SortKey } from './types';

export function sortEntries(
  entries: Entry[],
  key: SortKey,
  reverse: boolean,
  showHidden: boolean,
): Entry[] {
  const list = entries.filter((e) => showHidden || !e.isHidden);
  list.sort((a, b) => {
    // Directories always first
    if (a.kind === 'dir' && b.kind !== 'dir') return -1;
    if (b.kind === 'dir' && a.kind !== 'dir') return 1;
    let cmp = 0;
    switch (key) {
      case 'name':
        cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        break;
      case 'size':
        cmp = a.size - b.size;
        break;
      case 'mtime':
        cmp = a.mtimeMs - b.mtimeMs;
        break;
      case 'ctime':
        cmp = a.ctimeMs - b.ctimeMs;
        break;
      case 'ext':
        cmp = (a.ext ?? '').localeCompare(b.ext ?? '');
        if (cmp === 0) cmp = a.name.localeCompare(b.name);
        break;
      case 'type': {
        const order = { dir: 0, link: 1, exec: 2, file: 3 } as const;
        cmp = order[a.kind] - order[b.kind];
        if (cmp === 0) cmp = a.name.localeCompare(b.name);
        break;
      }
    }
    return reverse ? -cmp : cmp;
  });
  return list;
}

// Filter + rank entries by how well their name matches the query. Tiers
// (highest first) — case-sensitive prefix, case-insensitive prefix, word-start
// match, then plain contiguous substring. Tiebreaker is shorter name (a closer
// "real" match), then existing alphabetical order. Anything that doesn't
// contain the query as a contiguous substring is dropped.
export function applyFilter(entries: Entry[], filter: string): Entry[] {
  if (!filter) return entries;
  const q = filter.trim();
  if (!q) return entries;
  const ql = q.toLowerCase();

  type Scored = { e: Entry; tier: number; len: number };
  const scored: Scored[] = [];
  for (const e of entries) {
    const name = e.name;
    const nl = name.toLowerCase();
    if (!nl.includes(ql)) continue;
    let tier: number;
    if (name.startsWith(q)) tier = 0;
    else if (nl.startsWith(ql)) tier = 1;
    else if (matchesWordStart(nl, ql)) tier = 2;
    else tier = 3;
    scored.push({ e, tier, len: name.length });
  }
  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.len !== b.len) return a.len - b.len;
    return a.e.name.localeCompare(b.e.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  return scored.map((s) => s.e);
}

// True if `q` starts a word in `name` — boundaries are start-of-string or any
// non-alphanumeric char. Matches "NDA - ZoomInfo" for "nda" but not "Sunday".
function matchesWordStart(name: string, q: string): boolean {
  let i = 0;
  while (true) {
    const idx = name.indexOf(q, i);
    if (idx < 0) return false;
    if (idx === 0) return true;
    const prev = name.charCodeAt(idx - 1);
    const isWordChar =
      (prev >= 48 && prev <= 57) || // 0-9
      (prev >= 65 && prev <= 90) || // A-Z
      (prev >= 97 && prev <= 122);  // a-z
    if (!isWordChar) return true;
    i = idx + 1;
  }
}

// Compute the [start, end) span of the matched substring in a name, given the
// same query that applyFilter accepted. Used by FileRow to highlight which
// chars caused the match. Returns null if no match (caller should treat as
// no-highlight). Prefers the earliest case-insensitive substring occurrence —
// matches the substring that decided inclusion, not necessarily the highest
// tier (good enough for visual feedback; ranking is already settled).
export function matchSpan(name: string, filter: string): [number, number] | null {
  if (!filter) return null;
  const q = filter.trim();
  if (!q) return null;
  const idx = name.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return null;
  return [idx, idx + q.length];
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  let n = bytes;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatMtime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const mon = d.toLocaleString(undefined, { month: 'short' });
  const day = d.getDate().toString().padStart(2, '0');
  if (sameYear) {
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${mon} ${day} ${hh}:${mm}`;
  }
  return `${mon} ${day}  ${d.getFullYear()}`;
}
