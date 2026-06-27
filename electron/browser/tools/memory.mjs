// Site + task memory — durable, NON-PHI notes the browser agent accumulates.
//
// Two scopes:
//   site  — keyed by domain (e.g. thehindu.com): how a site is laid out, stable
//           selectors, gotchas, the fast path. Persists across tasks. SHARED
//           ONLINE (task-3c9b1146cee2): routed through Breeze main to the
//           /chromeext/site-memory store so every machine + teammate sees it;
//           the on-disk JSON is now an OFFLINE CACHE (server is canonical).
//   task  — keyed by an opaque task id (e.g. a TypeBuild task id): context and
//           progress notes for one task. STILL LOCAL — there is no fitting
//           NON-PHI per-task online store yet (lessons are a PHI container;
//           site-memory's domain key collapses task ids), so this stays on disk.
//
// Stored under ~/.breezefile/memory/{sites,tasks}/<key>.json (override with
// $BREEZE_MEMORY_DIR), each as { scope, key, entries: [{ text, at }] }. The
// directory listing IS the index — same self-describing model as the tool repo.
//
// ONLINE ROUTING (site scope). This .mjs runs as a CLI subprocess in the agent's
// session and holds NO Firebase token, so — exactly like cli.mjs `fill-ref` —
// it reaches the shared store THROUGH Breeze main's localhost control API
// (/app/site-memory). When main is unreachable (app not running / offline) the
// site path FALLS BACK to the same local JSON used as the cache. The sync
// getMemory/addMemory/deleteMemory/listMemory below are the LOCAL layer; the
// async *Online variants wrap them with the server round-trip.
//
// PHI INVARIANT: memory is a SHARED, NON-PHI surface — exactly like skills. It
// must never hold a patient value, a `data` value, credentials, or anything a
// fill-ref resolves. Store HOW-TO ("headlines are <a> under .story-card"), never
// WHAT ("the SSN is …"). The agent prompt enforces this; callers must too. The
// server PHI-guards every site-memory write (422) as a second line of defense.

import os from 'node:os';
import path from 'node:path';
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { readApi, API_FILE } from '../connect.mjs';

const SCOPES = { site: 'sites', task: 'tasks' };

/** Root of the memory store. Override with $BREEZE_MEMORY_DIR (tests use it). */
export function memoryDir() {
  return process.env.BREEZE_MEMORY_DIR || path.join(os.homedir(), '.breezefile', 'memory');
}

function isoNow() {
  try {
    return new Date().toISOString();
  } catch {
    return null;
  }
}

/** Normalize a site key: accept a full URL or a bare host, drop the scheme,
 *  path, and a leading `www.`, lowercase, and sanitize to a safe filename. */
export function siteKey(urlOrHost) {
  let h = String(urlOrHost || '').trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(h)) h = new URL(h).hostname;
  } catch {
    /* not a URL — treat as a host */
  }
  h = h.replace(/^www\./i, '').toLowerCase();
  return h.replace(/[^a-z0-9._-]/gi, '_');
}

/** Validate + normalize a (scope, key) pair to a safe filename stem. */
function safeKey(scope, key) {
  if (!SCOPES[scope]) throw new Error(`invalid memory scope: ${scope} (use site|task)`);
  const k =
    scope === 'site'
      ? siteKey(key)
      : String(key == null ? '' : key).trim().replace(/[^a-z0-9._-]/gi, '_');
  if (!k) throw new Error(`empty ${scope} key`);
  return k;
}

function fileFor(scope, key) {
  return path.join(memoryDir(), SCOPES[scope], safeKey(scope, key) + '.json');
}

/** Read a scope/key's notes. Returns { scope, key, entries: [] } (empty when
 *  none/unreadable). */
export function getMemory(scope, key) {
  const k = safeKey(scope, key);
  const f = fileFor(scope, key);
  if (!existsSync(f)) return { scope, key: k, entries: [] };
  try {
    const data = JSON.parse(readFileSync(f, 'utf8'));
    return { scope, key: k, entries: Array.isArray(data.entries) ? data.entries : [] };
  } catch {
    return { scope, key: k, entries: [] };
  }
}

/** Append one NON-PHI note. Returns { ok, scope, key, count }. Throws on a bad
 *  scope/key or empty text. */
export function addMemory(scope, key, text, { at } = {}) {
  const t = String(text == null ? '' : text).trim();
  if (!t) throw new Error('memory text is required');
  const cur = getMemory(scope, key);
  cur.entries.push({ text: t, at: at || isoNow() });
  const f = fileFor(scope, key);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(
    f,
    JSON.stringify({ scope: cur.scope, key: cur.key, entries: cur.entries }, null, 2) + '\n',
  );
  return { ok: true, scope: cur.scope, key: cur.key, count: cur.entries.length };
}

/** Delete one entry (by `index`) or the whole key (no index). Returns
 *  { ok, removed, count } or { ok:false, error }. */
export function deleteMemory(scope, key, { index } = {}) {
  const f = fileFor(scope, key);
  if (!existsSync(f)) return { ok: false, error: 'no memory for that key' };
  if (index === undefined || index === null || index === true) {
    rmSync(f, { force: true });
    return { ok: true, removed: 'all', key: safeKey(scope, key) };
  }
  const cur = getMemory(scope, key);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= cur.entries.length) {
    return { ok: false, error: `index out of range (0..${Math.max(0, cur.entries.length - 1)})` };
  }
  const [removed] = cur.entries.splice(i, 1);
  if (cur.entries.length === 0) rmSync(f, { force: true });
  else {
    writeFileSync(
      f,
      JSON.stringify({ scope, key: cur.key, entries: cur.entries }, null, 2) + '\n',
    );
  }
  return { ok: true, removed: removed?.text, count: cur.entries.length };
}

/** Index of every stored key + its note count, by scope. */
export function listMemory() {
  const result = { site: [], task: [] };
  for (const [scope, sub] of Object.entries(SCOPES)) {
    const d = path.join(memoryDir(), sub);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      if (!name.endsWith('.json')) continue;
      const key = name.slice(0, -5);
      result[scope].push({ key, count: getMemory(scope, key).entries.length });
    }
  }
  return result;
}

// ─── ONLINE layer (site scope, task-3c9b1146cee2) ────────────────────────────
// Reaches the shared store through Breeze main's localhost control API. The
// `task` scope has no online home yet, so the *Online variants delegate to the
// sync LOCAL functions for it and only round-trip the server for `site`.

/** Call Breeze main's /app/site-memory control endpoint. Returns the parsed JSON
 *  body, or throws { offline:true } when main isn't reachable so callers can fall
 *  back to the local cache. Never logs a note body. */
async function callMain(method, pathAndQuery, body) {
  const api = readApi();
  if (!api) {
    throw Object.assign(new Error(`Breeze not running (${API_FILE})`), { offline: true });
  }
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${api.port}${pathAndQuery}`, {
      method,
      headers: {
        authorization: `Bearer ${api.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw Object.assign(new Error(`site-memory request failed: ${e.message}`), {
      offline: true,
    });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Surface the server's reason (e.g. the PHI-guard 422) to the agent.
    throw new Error(data.error || `site-memory ${method} failed (${res.status})`);
  }
  return data;
}

/** Map a server site-memory note to the local entry shape so `get`/`list` look
 *  identical whether served online or from the cache. Carries the note `id` so a
 *  later delete can target it. */
function noteToEntry(n) {
  return { text: String(n?.body ?? ''), at: n?.updated_at ?? null, id: n?.id ?? null };
}

/** Mirror the recalled site entries into the local JSON cache so a LATER offline
 *  recall (or `memory list`) still has them. Best-effort; never fails a recall.
 *  Main writes the canonical cache too — this just covers the CLI-only path. */
function cacheSiteEntries(key, entries) {
  try {
    const f = fileFor('site', key);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(
      f,
      JSON.stringify({ scope: 'site', key: siteKey(key), entries }, null, 2) + '\n',
    );
  } catch {
    /* cache is best-effort */
  }
}

/** Read a scope/key's notes. `site` → online (with local-cache fallback when
 *  Breeze isn't running); `task` → local. Returns { scope, key, entries, online }. */
export async function getMemoryOnline(scope, key) {
  const k = safeKey(scope, key);
  if (scope !== 'site') return { ...getMemory(scope, key), online: false };
  try {
    const data = await callMain(
      'GET',
      `/app/site-memory?domain=${encodeURIComponent(siteKey(key))}`,
    );
    const entries = Array.isArray(data.notes) ? data.notes.map(noteToEntry) : [];
    cacheSiteEntries(key, entries);
    return { scope, key: data.domain || k, entries, online: !data.offline };
  } catch (e) {
    if (e.offline) return { ...getMemory(scope, key), online: false };
    throw e;
  }
}

/** Append one NON-PHI note. `site` → online POST (server PHI-guards); `task` →
 *  local. The optional `kind` rides the site write (default note). */
export async function addMemoryOnline(scope, key, text, { kind } = {}) {
  const t = String(text == null ? '' : text).trim();
  if (!t) throw new Error('memory text is required');
  if (scope !== 'site') return { ...addMemory(scope, key, t), online: false };
  const data = await callMain('POST', '/app/site-memory', {
    domain: siteKey(key),
    body: t,
    ...(kind ? { kind } : {}),
  });
  return { ok: true, scope, key: data.note?.domain || siteKey(key), id: data.id, online: true };
}

/** Delete a site note by `id` (the online store is id-addressed), or fall back
 *  to the local index-based delete for the `task` scope. For `site`, pass the
 *  note id via `{ id }` (read it from `memory get`). */
export async function deleteMemoryOnline(scope, key, { index, id } = {}) {
  if (scope !== 'site') return { ...deleteMemory(scope, key, { index }), online: false };
  if (!id) {
    return {
      ok: false,
      error: 'site memory is shared + id-addressed: pass --id <note-id> (from `memory get`)',
    };
  }
  const data = await callMain('DELETE', `/app/site-memory?id=${encodeURIComponent(id)}`);
  return { ok: !!data.ok, id, online: true };
}
