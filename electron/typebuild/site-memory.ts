// Shared, ONLINE browser-automation memory (task-3c9b1146cee2).
//
// The browser agent accumulates durable, NON-PHI how-to about web pages —
// selectors, fast paths, gotchas, reusable code. This used to live in a
// per-machine JSON store (electron/browser/tools/memory.mjs). It now rides the
// SHARED online store so every machine + teammate sees the same learnings:
//
//   server-canonical  GET/POST/DELETE /chromeext/site-memory   (chromeext.py)
//   local cache       ~/.breezefile/memory/sites/<domain>.json (offline read)
//
// The CLI subprocess that the agent runs (`breeze-tools memory ...`) holds NO
// Firebase token, so — exactly like cli.mjs `fill-ref` → /app/task-data — it
// reaches the online store THROUGH Breeze main's localhost control API
// (electron/api-server.ts `/app/site-memory`), which proxies here with the real
// token via typebuildFetch. Main is the only process that talks to the server.
//
// PHI invariant (non-negotiable): site memory is a SHARED, NON-PHI surface —
// selectors / paths / how-to / code only, NEVER a typed-in value. The server
// PHI-guards every write (422 on PHI-shaped text); we never log a body.
//
// SCOPE MAPPING. The local store had two scopes: `site` (keyed by domain) and
// `task` (keyed by an opaque task id). Only `site` has a server home today:
//   - site → /chromeext/site-memory, keyed by the normalized registrable domain
//            (an exact fit).
//   - task → has NO fitting NON-PHI online store. The `lessons` store is a PHI
//            container (encrypted, audited, with a compile step) and
//            site-memory's domain key is normalized to the registrable domain,
//            which COLLAPSES every distinct task id into one bucket. So `task`
//            memory stays a LOCAL cache only until a NON-PHI per-task learnings
//            store exists (filed as a server task). The CLI keeps the local path
//            for `task` and routes `site` online.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { API_BASE, typebuildFetch } from './task-data';

/** Root of the local cache (mirrors memory.mjs memoryDir()). Override with
 *  $BREEZE_MEMORY_DIR (tests). Server is canonical; this is the offline read. */
function memoryDir(): string {
  return process.env.BREEZE_MEMORY_DIR || path.join(os.homedir(), '.breezefile', 'memory');
}

function siteCacheFile(domain: string): string {
  // The domain is already normalized server-side; sanitize for a safe filename.
  const safe = String(domain || '').replace(/[^a-z0-9._-]/gi, '_');
  return path.join(memoryDir(), 'sites', safe + '.json');
}

/** One shared site-memory note (the NON-PHI fields we consume). */
export interface SiteNote {
  id: string;
  domain: string;
  kind: string;
  body: string;
  url_pattern?: string | null;
  updated_at?: string | null;
}

function asNotes(value: unknown): SiteNote[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
    .map((n) => ({
      id: String(n.id ?? ''),
      domain: String(n.domain ?? ''),
      kind: String(n.kind ?? 'note'),
      body: String(n.body ?? ''),
      url_pattern: (n.url_pattern as string | null) ?? null,
      updated_at: (n.updated_at as string | null) ?? null,
    }));
}

/** Write the recalled notes to the local cache so a later OFFLINE recall still
 *  has something to inject. Best-effort: a cache write must never fail a recall.
 *  PHI-safe: site memory is NON-PHI by construction (server PHI-guards writes). */
function writeSiteCache(domain: string, notes: SiteNote[]): void {
  try {
    const f = siteCacheFile(domain);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ domain, notes }, null, 2) + '\n');
  } catch {
    /* cache is best-effort */
  }
}

/** Read the local cache for a domain (offline fallback). Returns [] on miss. */
function readSiteCache(domain: string): SiteNote[] {
  try {
    const data = JSON.parse(readFileSync(siteCacheFile(domain), 'utf8'));
    return asNotes(data.notes);
  } catch {
    return [];
  }
}

/** Recall the shared notes for a page (domain or full URL). Server-canonical;
 *  on a transport/HTTP failure (offline) we serve the local cache instead so a
 *  session start still gets whatever was last synced. The server normalizes the
 *  domain to its registrable form, so a full URL recalls the right bucket. */
export async function recallSiteMemory(
  domain: string,
  opts: { kind?: string; limit?: number } = {},
): Promise<{ domain: string; notes: SiteNote[]; offline: boolean }> {
  const params = new URLSearchParams({ domain });
  if (opts.kind) params.set('kind', opts.kind);
  if (opts.limit) params.set('limit', String(opts.limit));
  try {
    const res = await typebuildFetch(`${API_BASE}/chromeext/site-memory?${params}`);
    if (!res.ok) throw new Error(`site-memory recall failed (${res.status})`);
    const body = (await res.json().catch(() => ({}))) as { domain?: string; notes?: unknown };
    const norm = body.domain || domain;
    const notes = asNotes(body.notes);
    writeSiteCache(norm, notes);
    return { domain: norm, notes, offline: false };
  } catch {
    // Offline / server unreachable — serve the last-synced cache. We cache under
    // the server's normalized domain; the bare-domain read used at session start
    // matches that name in the common case.
    return { domain, notes: readSiteCache(domain), offline: true };
  }
}

/** Add a shared NON-PHI note. POSTs online (server PHI-guards: 422 on a value);
 *  on success we refresh the local cache for that domain. Throws on a non-2xx so
 *  the CLI surfaces the server's reason (e.g. the PHI rejection) to the agent —
 *  a learning we cannot share must NOT silently fall back to a local-only write.
 *  We never log the body. */
export async function addSiteMemory(
  domain: string,
  body: string,
  opts: { kind?: string; url_pattern?: string } = {},
): Promise<{ ok: boolean; id?: string; note?: SiteNote }> {
  const payload: Record<string, string> = { domain, body };
  if (opts.kind) payload.kind = opts.kind;
  if (opts.url_pattern) payload.url_pattern = opts.url_pattern;
  const res = await typebuildFetch(`${API_BASE}/chromeext/site-memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    id?: string;
    note?: unknown;
    error?: string;
  };
  if (!res.ok) {
    // Surface the server's reason WITHOUT echoing the body we sent.
    throw Object.assign(new Error(data.error || `site-memory add failed (${res.status})`), {
      status: res.status,
    });
  }
  const note = asNotes([data.note])[0];
  // Refresh the cache so an immediate offline recall sees the new note.
  void recallSiteMemory(domain).catch(() => {});
  return { ok: true, id: data.id, note };
}

/** Delete one shared note by id. Throws on a non-2xx (e.g. 404 not found). */
export async function deleteSiteMemory(noteId: string): Promise<{ ok: boolean }> {
  const res = await typebuildFetch(
    `${API_BASE}/chromeext/site-memory/${encodeURIComponent(noteId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(data.error || `site-memory delete failed (${res.status})`), {
      status: res.status,
    });
  }
  return { ok: true };
}
