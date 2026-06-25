// User credential vault — CRUD for CLASS 2 data (the user's OWN identifiers:
// NPI, practice Tax ID, portal login IDs). Server/API side is task_manager_api-8y0.
//
// This is the MANAGEMENT path (the :secrets panel): list keys, set/replace a
// value, reveal one value on demand, delete. The FILL-TIME path (an agent
// filling a "me.*" placeholder into a form) lives in task-data.ts via
// resolveTaskDataRef — both hit the same per-user vault, one value per call.
//
// Source of truth is the SERVER (encrypted at rest, per-user, Firebase-authed).
// The client deliberately keeps NO plaintext at rest: listing returns key names
// only; a value crosses the wire only when the user explicitly reveals it or an
// agent fills it, and is never cached, persisted, or logged in main.
//
// PHI note: these are the user's own provider identifiers, NOT patient PHI —
// but they are still secrets. Never log a value; only key names may appear in
// errors/telemetry.
//
// Server contract (TypeBuild dependency — confirm against task_manager_api-8y0):
//   GET    /chromeext/me/data            → { keys: string[] }   (NAMES only, no values)
//   GET    /chromeext/me/data?ref=<key>  → { value: string }    (one value; reveal/fill)
//   PUT    /chromeext/me/data            { ref, value } → { ok: true }   (create/replace)
//   DELETE /chromeext/me/data?ref=<key>  → { ok: true }
// All scoped to the signed-in user by the Firebase token.

import { API_BASE, isUserDataRef, resolveTaskDataRef, typebuildFetch } from './task-data';

const VAULT_URL = `${API_BASE}/chromeext/me/data`;

// All vault keys are "me.*" placeholders; the panel collects a short key from
// the user (e.g. "npi") and we namespace it. Keep keys NON-PHI and opaque.
const USER_REF_PREFIX = 'me.';

/** Normalize a user-entered key to a canonical "me.*" ref. Accepts either
 *  "npi" or "me.npi"; rejects empty / whitespace / obviously unsafe keys. */
export function toUserRef(rawKey: string): string {
  const k = rawKey.trim();
  if (!k) throw Object.assign(new Error('key required'), { status: 400 });
  const ref = isUserDataRef(k) ? k : `${USER_REF_PREFIX}${k}`;
  // Keys ride into a URL and a JSON bag; keep them to a safe dotted-identifier
  // shape so a stray "/" or "?" can't reshape the request.
  if (!/^me\.[A-Za-z0-9._-]+$/.test(ref)) {
    throw Object.assign(new Error('key must be letters/digits/._- (e.g. "npi" or "npi.burlingame")'), {
      status: 400,
    });
  }
  return ref;
}

/** List the user's vault KEYS only (never values). Drives the :secrets panel's
 *  masked list. */
export async function listUserSecrets(): Promise<string[]> {
  const res = await typebuildFetch(VAULT_URL);
  if (res.status === 404) return []; // no vault yet → empty, not an error
  if (!res.ok) {
    throw Object.assign(new Error(`vault list failed (${res.status})`), { status: 502 });
  }
  const body = (await res.json().catch(() => ({}))) as { keys?: unknown };
  if (!Array.isArray(body.keys) || !body.keys.every((k) => typeof k === 'string')) {
    throw Object.assign(new Error('vault list returned no keys'), { status: 502 });
  }
  return (body.keys as string[]).slice().sort();
}

/** Reveal ONE value on explicit user action (the eye toggle). Reuses the
 *  fill-time resolver so reveal and fill share identical 404/empty handling and
 *  the same one-value-per-call discipline. Never cached, never logged. */
export async function revealUserSecret(ref: string): Promise<string> {
  const canonical = toUserRef(ref);
  // resolveTaskDataRef routes "me.*" to the vault; taskId is unused for class 2.
  return resolveTaskDataRef('', canonical);
}

/** Create or replace one secret. Returns the canonical ref that was written so
 *  the panel can refresh its list without echoing the value. */
export async function setUserSecret(rawKey: string, value: string): Promise<string> {
  const ref = toUserRef(rawKey);
  if (typeof value !== 'string' || value === '') {
    throw Object.assign(new Error('value required'), { status: 400 });
  }
  const res = await typebuildFetch(VAULT_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref, value }),
  });
  if (!res.ok) {
    // Never include `value` in the error.
    throw Object.assign(new Error(`could not save "${ref}" (${res.status})`), { status: 502 });
  }
  return ref;
}

/** Delete one secret. Idempotent: a 404 (already gone) is treated as success. */
export async function deleteUserSecret(rawKey: string): Promise<void> {
  const ref = toUserRef(rawKey);
  const res = await typebuildFetch(`${VAULT_URL}?ref=${encodeURIComponent(ref)}`, {
    method: 'DELETE',
  });
  if (res.status === 404) return;
  if (!res.ok) {
    throw Object.assign(new Error(`could not delete "${ref}" (${res.status})`), { status: 502 });
  }
}
