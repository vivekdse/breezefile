// Shared, ONLINE browser-automation memory (task-3c9b1146cee2; per-task scope
// added in task-f2639aa68585).
//
// The browser agent accumulates durable, NON-PHI how-to about web pages —
// selectors, fast paths, gotchas, reusable code — AND per-task learnings (the
// quirks of running one TypeBuild task / task type). This used to live in a
// per-machine JSON store (electron/browser/tools/memory.mjs). It now rides the
// SHARED online store so every machine + teammate sees the same learnings:
//
//   server-canonical  GET/POST/DELETE /chromeext/site-memory   (chromeext.py)
//   local cache       ~/.breezefile/memory/sites/<domain>.json (offline read)
//   local cache       ~/.breezefile/memory/tasks/<task_tag>.json (offline read)
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
// `task` (keyed by an opaque task id). BOTH now have a server home
// (task-f2639aa68585 — supersedes the earlier per-site-only task-3c9b1146cee2):
//   - site → /chromeext/site-memory, keyed by the normalized registrable domain
//            (an exact fit).
//   - task → /chromeext/site-memory, keyed by `task_tag` (a task id or task-type
//            tag). The server was extended 2026-06-27 to accept `task_tag` as a
//            FIRST-CLASS keying dimension alongside `domain` (POST + GET), so
//            per-task learnings are now SHARED ONLINE too — the gap that pinned
//            `task` memory to local-only is CLOSED. `task_tag` is NOT normalized
//            to a domain, so distinct task ids no longer collapse into one bucket.
// At least one of domain/task_tag/tag is required by the server (the keying
// dimension). The on-disk JSON remains an OFFLINE CACHE for both scopes.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stateDir } from '../core/profile.mjs';
import { API_BASE, typebuildFetch } from './task-data';

/** Root of the local cache (mirrors memory.mjs memoryDir()). Override with
 *  $BREEZE_MEMORY_DIR (tests). Server is canonical; this is the offline read. */
function memoryDir(): string {
  return process.env.BREEZE_MEMORY_DIR || path.join(stateDir(), 'memory');
}

/** Which keying dimension a cached bucket lives under. `site` buckets cache
 *  under sites/<domain>.json; `task` buckets under tasks/<task_tag>.json. */
type CacheScope = 'site' | 'task';

function cacheFileFor(scope: CacheScope, key: string): string {
  // The key is already normalized server-side; sanitize for a safe filename.
  const safe = String(key || '').replace(/[^a-z0-9._-]/gi, '_');
  return path.join(memoryDir(), scope === 'task' ? 'tasks' : 'sites', safe + '.json');
}

/** One shared site-memory note (the NON-PHI fields we consume). */
export interface SiteNote {
  id: string;
  domain: string;
  /** Per-task key when the note was keyed by task rather than domain. */
  task_tag?: string | null;
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
      task_tag: (n.task_tag as string | null) ?? null,
      kind: String(n.kind ?? 'note'),
      body: String(n.body ?? ''),
      url_pattern: (n.url_pattern as string | null) ?? null,
      updated_at: (n.updated_at as string | null) ?? null,
    }));
}

/** Write the recalled notes to the local cache so a later OFFLINE recall still
 *  has something to inject. Best-effort: a cache write must never fail a recall.
 *  PHI-safe: site memory is NON-PHI by construction (server PHI-guards writes). */
function writeCache(scope: CacheScope, key: string, notes: SiteNote[]): void {
  try {
    const f = cacheFileFor(scope, key);
    mkdirSync(path.dirname(f), { recursive: true });
    const meta = scope === 'task' ? { task_tag: key } : { domain: key };
    writeFileSync(f, JSON.stringify({ ...meta, notes }, null, 2) + '\n');
  } catch {
    /* cache is best-effort */
  }
}

function writeSiteCache(domain: string, notes: SiteNote[]): void {
  writeCache('site', domain, notes);
}

/** Read the local cache for a (scope, key) bucket (offline fallback). [] on miss. */
function readCache(scope: CacheScope, key: string): SiteNote[] {
  try {
    const data = JSON.parse(readFileSync(cacheFileFor(scope, key), 'utf8'));
    return asNotes(data.notes);
  } catch {
    return [];
  }
}

function readSiteCache(domain: string): SiteNote[] {
  return readCache('site', domain);
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

/** Recall the shared notes for a TASK (task-f2639aa68585). Same store + endpoint
 *  as recallSiteMemory, but keyed by `task_tag` (a task id or task-type tag)
 *  rather than a domain — the server does NOT normalize task_tag to a domain, so
 *  each task gets its own bucket. Offline → the tasks/<task_tag>.json cache. */
export async function recallTaskMemory(
  taskTag: string,
  opts: { kind?: string; limit?: number } = {},
): Promise<{ task_tag: string; notes: SiteNote[]; offline: boolean }> {
  const params = new URLSearchParams({ task_tag: taskTag });
  if (opts.kind) params.set('kind', opts.kind);
  if (opts.limit) params.set('limit', String(opts.limit));
  try {
    const res = await typebuildFetch(`${API_BASE}/chromeext/site-memory?${params}`);
    if (!res.ok) throw new Error(`task-memory recall failed (${res.status})`);
    const body = (await res.json().catch(() => ({}))) as { task_tag?: string; notes?: unknown };
    const tag = body.task_tag || taskTag;
    const notes = asNotes(body.notes);
    writeCache('task', tag, notes);
    return { task_tag: tag, notes, offline: false };
  } catch {
    return { task_tag: taskTag, notes: readCache('task', taskTag), offline: true };
  }
}

/** Add a shared NON-PHI per-TASK note (task-f2639aa68585), keyed by `task_tag`.
 *  Same store + PHI-guard as addSiteMemory; the server guards the task_tag text
 *  too. Throws on a non-2xx so the CLI surfaces the server's reason. */
export async function addTaskMemory(
  taskTag: string,
  body: string,
  opts: { kind?: string; url_pattern?: string } = {},
): Promise<{ ok: boolean; id?: string; note?: SiteNote }> {
  const payload: Record<string, string> = { task_tag: taskTag, body };
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
    throw Object.assign(new Error(data.error || `task-memory add failed (${res.status})`), {
      status: res.status,
    });
  }
  const note = asNotes([data.note])[0];
  void recallTaskMemory(taskTag).catch(() => {});
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
