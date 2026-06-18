// Site + task memory — durable, NON-PHI notes the browser agent accumulates.
//
// Two scopes:
//   site  — keyed by domain (e.g. thehindu.com): how a site is laid out, stable
//           selectors, gotchas, the fast path. Persists across tasks.
//   task  — keyed by an opaque task id (e.g. a TypeBuild task id): context and
//           progress notes for one task.
//
// Stored under ~/.breezefile/memory/{sites,tasks}/<key>.json (override with
// $BREEZE_MEMORY_DIR), each as { scope, key, entries: [{ text, at }] }. The
// directory listing IS the index — same self-describing model as the tool repo.
//
// PHI INVARIANT: memory is a SHARED, NON-PHI surface — exactly like skills. It
// must never hold a patient value, a `data` value, credentials, or anything a
// fill-ref resolves. Store HOW-TO ("headlines are <a> under .story-card"), never
// WHAT ("the SSN is …"). The agent prompt enforces this; callers must too.

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
