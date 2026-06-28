// task-ff707aea93d8 — address-bar autocomplete backend.
//
// Main-side owner of the embedded-browser's visited-URL history + the
// suggestion ranking used by the shared address bar (src/components/
// BrowserSurface.tsx, which drives BOTH the in-app tab and the operator pane).
//
// PHI: this store holds ONLY plain http(s) URLs the user actually navigated to
// (origin + path) plus a visit count + last-visit timestamp. Never task text,
// never form values, never credentials. It lives next to tags.json /
// openwith.json under app.getPath('userData') (browser-history.json) and is
// loaded once, written back debounced. Suggestions are computed in-process and
// returned over `browser:suggest`; nothing PHI is logged or persisted.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { app } from 'electron';

export type SuggestKind = 'history' | 'bookmark' | 'known';

export type Suggestion = {
  /** The full URL we'd navigate to (always absolute, http(s)). */
  url: string;
  /** Host (no scheme/path) — used for the inline ghost completion. */
  host: string;
  /** Page title if we have one (history only). */
  title?: string;
  kind: SuggestKind;
};

type HistoryEntry = {
  url: string;
  title: string;
  visits: number;
  /** Last-visit epoch ms — recency boosts ranking. */
  last: number;
};

// A small seed of common destinations so the bar is useful on a fresh profile
// (before any history accrues). Plain public hosts only — NON-PHI.
const KNOWN_HOSTS: string[] = [
  'google.com',
  'mail.google.com',
  'calendar.google.com',
  'drive.google.com',
  'docs.google.com',
  'github.com',
  'youtube.com',
  'maps.google.com',
  'wikipedia.org',
  'amazon.com',
  'chatgpt.com',
  'claude.ai',
  'linkedin.com',
  'stackoverflow.com',
  'reddit.com',
];

let cache: Map<string, HistoryEntry> | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function historyFile(): string {
  return path.join(app.getPath('userData'), 'browser-history.json');
}

async function load(): Promise<Map<string, HistoryEntry>> {
  if (cache) return cache;
  const map = new Map<string, HistoryEntry>();
  try {
    const raw = await fs.readFile(historyFile(), 'utf8');
    const arr = JSON.parse(raw) as HistoryEntry[];
    if (Array.isArray(arr)) {
      for (const e of arr) {
        if (e && typeof e.url === 'string') {
          map.set(e.url, {
            url: e.url,
            title: typeof e.title === 'string' ? e.title : '',
            visits: typeof e.visits === 'number' ? e.visits : 1,
            last: typeof e.last === 'number' ? e.last : 0,
          });
        }
      }
    }
  } catch {
    /* missing / corrupt → start empty */
  }
  cache = map;
  return map;
}

function scheduleWrite(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void flush();
  }, 1500);
}

async function flush(): Promise<void> {
  if (!cache) return;
  // Cap the store so it can't grow without bound — keep the most-recent 2000.
  const all = [...cache.values()].sort((a, b) => b.last - a.last).slice(0, 2000);
  cache = new Map(all.map((e) => [e.url, e]));
  try {
    await fs.writeFile(historyFile(), JSON.stringify(all), 'utf8');
  } catch {
    /* best-effort; history is non-critical */
  }
}

/** Strip a trailing fragment + normalize so the same page collapses to one
 *  entry. Returns null for anything that isn't a real http(s) page. */
function normalize(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  u.hash = '';
  return u.toString();
}

/** Record a navigation. Called from views.ts on did-navigate. Best-effort and
 *  NON-PHI (plain URL + page title only). */
export async function recordVisit(rawUrl: string, title: string): Promise<void> {
  const url = normalize(rawUrl);
  if (!url) return;
  const map = await load();
  const existing = map.get(url);
  if (existing) {
    existing.visits += 1;
    existing.last = Date.now();
    if (title) existing.title = title;
  } else {
    map.set(url, { url, title: title || '', visits: 1, last: Date.now() });
  }
  scheduleWrite();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Rank suggestions for a typed query. Strategy:
 *  - prefix host matches rank above substring matches (anywhere in url/title);
 *  - within a tier, more visits + more recent wins;
 *  - history beats the static known-hosts seed (real usage > guess);
 *  - empty query → the most-visited recent history (a "top sites" list).
 * Returns at most `limit` deduped-by-url suggestions.
 */
export async function suggest(query: string, limit = 8): Promise<Suggestion[]> {
  const map = await load();
  const q = query.trim().toLowerCase();
  // Strip a leading scheme from the query so "https://git" prefix-matches "git".
  const qBare = q.replace(/^[a-z]+:\/\//, '');

  type Scored = { s: Suggestion; score: number };
  const out: Scored[] = [];
  const seen = new Set<string>();

  const now = Date.now();
  const recencyBoost = (last: number): number => {
    const ageDays = (now - last) / 86_400_000;
    if (ageDays < 1) return 40;
    if (ageDays < 7) return 25;
    if (ageDays < 30) return 12;
    return 0;
  };

  // History entries.
  for (const e of map.values()) {
    const host = hostOf(e.url);
    const hayUrl = e.url.toLowerCase();
    const hayTitle = (e.title || '').toLowerCase();
    let score = -1;
    if (!qBare) {
      // Top-sites mode.
      score = Math.min(e.visits, 20) * 3 + recencyBoost(e.last);
    } else if (host.startsWith(qBare)) {
      score = 1000 + Math.min(e.visits, 20) * 4 + recencyBoost(e.last);
    } else if (hayUrl.replace(/^https?:\/\/(www\.)?/, '').startsWith(qBare)) {
      score = 800 + Math.min(e.visits, 20) * 4 + recencyBoost(e.last);
    } else if (hayUrl.includes(qBare) || hayTitle.includes(qBare)) {
      score = 400 + Math.min(e.visits, 20) * 2 + recencyBoost(e.last);
    }
    if (score < 0) continue;
    if (seen.has(e.url)) continue;
    seen.add(e.url);
    out.push({
      s: { url: e.url, host, title: e.title || undefined, kind: 'history' },
      score,
    });
  }

  // Known-host seed — only when a query is present (don't seed the empty/top
  // list with guesses) and only as a fallback below real history.
  if (qBare) {
    for (const host of KNOWN_HOSTS) {
      const url = 'https://' + host + '/';
      if (seen.has(url)) continue;
      let score = -1;
      if (host.startsWith(qBare)) score = 200;
      else if (host.includes(qBare)) score = 100;
      if (score < 0) continue;
      seen.add(url);
      out.push({ s: { url, host, kind: 'known' }, score });
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit).map((x) => x.s);
}

/** Test/maintenance hook — clear the in-memory cache so the next read reloads. */
export function _resetHistoryCache(): void {
  cache = null;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}
