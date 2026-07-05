// Site-keyed credential vault (task-d60860fb4d7f). CRUD against the LIVE
// per-user, site-keyed credential store on the TypeBuild server
// (app/routers/chromeext.py, verified deployed 2026-06-27):
//
//   GET    /chromeext/credentials/resolve?origin&username  -> { value } | 404
//   GET    /chromeext/credentials[?origin]                 -> { credentials: [...] }
//   PUT    /chromeext/credentials  { origin, username, password } -> { ok, origin, username }
//   DELETE /chromeext/credentials?origin&username          -> { ok } | 404
//
// This is the persist path the "Save password?" prompt (task-ad89064bf45f) hands
// an accepted capture to, and the read path the return-visit autofill
// (task-4b786c018d78) reads from.
//
// ─── SECURITY INVARIANT ──────────────────────────────────────────────────────
// The PASSWORD is encrypted at rest SERVER-side; the client keeps NO plaintext at
// rest. A password crosses the wire only on `save` (PUT) and `resolve` (the
// single value the user/agent explicitly asked for), and is NEVER cached,
// persisted, or logged in main — only origin+username may appear in errors. The
// server normalizes the origin, scopes to the signed-in principal (Firebase
// token), and audits origin+username, never the password.
//
// Distinct from user-vault.ts: that is the user's OWN identifiers (the "me"
// entity, class 2); THIS is arbitrary per-site web logins keyed by (origin,
// username). Both reuse the same authed `typebuildFetch` plumbing.

import { API_BASE, typebuildFetch } from './task-data';
// Pure list normalization lives in a sibling .mjs (no Electron) so it is
// unit-testable; different basename avoids the same-basename build gotcha.
import { normalizeCredentialList } from './credential-normalize.mjs';

const CRED_URL = `${API_BASE}/chromeext/credentials`;

// One saved login as the renderer lists it: NO password (the password crosses
// only on `resolveSiteCredential`). `updatedAt` orders the list.
export interface SavedCredential {
  origin: string;
  username: string;
  updatedAt?: string;
}

function reqString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw Object.assign(new Error(`${name} required`), { status: 400 });
  }
  return v;
}

/** List the user's saved logins (NO passwords). Optionally restrict to one
 *  origin (feeds the autofill picker). Origin/username only — never a value. */
export async function listSiteCredentials(origin?: string): Promise<SavedCredential[]> {
  const url =
    origin && origin.trim()
      ? `${CRED_URL}?origin=${encodeURIComponent(origin.trim())}`
      : CRED_URL;
  const res = await typebuildFetch(url);
  if (!res.ok) {
    throw Object.assign(new Error(`credentials list failed (${res.status})`), {
      status: 502,
    });
  }
  const body = (await res.json().catch(() => ({}))) as unknown;
  // Pure normalization (drops malformed rows; maps updated_at → updatedAt).
  return normalizeCredentialList(body);
}

/** Resolve ONE saved password for (origin, username). The value crosses only
 *  this hop and is NEVER cached or logged. A 404 (absent / empty / decrypt-fail
 *  all collapse server-side) surfaces as a value-free "no saved password" error
 *  so nothing about WHY leaks. Used by the return-visit autofill (T6) and any
 *  explicit reveal. */
export async function resolveSiteCredential(
  origin: string,
  username: string,
): Promise<string> {
  const o = reqString(origin, 'origin');
  const u = reqString(username, 'username');
  const url = `${CRED_URL}/resolve?origin=${encodeURIComponent(o)}&username=${encodeURIComponent(u)}`;
  const res = await typebuildFetch(url);
  if (res.status === 404) {
    throw Object.assign(new Error('no saved password for this login'), { status: 404 });
  }
  if (!res.ok) {
    // 500 = server refused to serve a decrypt-failed secret; never echo a value.
    throw Object.assign(new Error(`credential resolve failed (${res.status})`), {
      status: 502,
    });
  }
  const body = (await res.json().catch(() => ({}))) as { value?: unknown };
  if (typeof body.value !== 'string' || body.value === '') {
    // Treat empty like 404 — a blank fill that reports success is worse than a
    // clear error (mirrors the task-data resolver discipline).
    throw Object.assign(new Error('no saved password for this login'), { status: 404 });
  }
  return body.value;
}

/** task-e550e3a1f512 — compare a CAPTURED login against the saved vault entry,
 *  WITHOUT ever returning a stored password to the caller. The comparison
 *  happens here in main; the renderer only learns the verdict:
 *    'absent'  — no saved password for this {origin, username} (offer "Save")
 *    'match'   — the captured password equals the saved one (DON'T prompt)
 *    'differs' — a saved password exists but the captured one differs
 *                (offer "Update password?")
 *  This is what lets the save-password prompt stop re-nagging on every login
 *  with an unchanged password. Values are never logged. Any resolve error other
 *  than 404 (transport/500) degrades to 'absent' so a lookup failure falls back
 *  to the prior behaviour (prompt) rather than silently swallowing a real
 *  new/changed credential. */
export async function matchSiteCredential(
  origin: string,
  username: string,
  password: string,
): Promise<'absent' | 'match' | 'differs'> {
  const o = reqString(origin, 'origin');
  const u = typeof username === 'string' ? username : '';
  const p = typeof password === 'string' ? password : '';
  // An empty captured password can't meaningfully match; treat as absent so the
  // prompt path decides (it already guards blank saves).
  if (p === '') return 'absent';
  let saved: string;
  try {
    saved = await resolveSiteCredential(o, u);
  } catch (e) {
    const status = (e as { status?: number })?.status;
    if (status === 404) return 'absent';
    // Transport / decrypt-refused / other — don't claim a match we can't prove.
    return 'absent';
  }
  return saved === p ? 'match' : 'differs';
}

/** Save (create or replace) one login. The password is encrypted at rest
 *  server-side and is NEVER logged here. Returns the normalized {origin, username}
 *  the server stored (so the prompt/panel can refresh without echoing the value). */
export async function saveSiteCredential(input: {
  origin: string;
  username: string;
  password: string;
}): Promise<{ origin: string; username: string }> {
  const origin = reqString(input?.origin, 'origin');
  // The server permits a blank username (some logins are passwordless-username),
  // but requires a string; coerce.
  const username = typeof input?.username === 'string' ? input.username : '';
  const password = input?.password;
  if (typeof password !== 'string' || password === '') {
    throw Object.assign(new Error('password required'), { status: 400 });
  }
  const res = await typebuildFetch(CRED_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin, username, password }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: unknown;
    origin?: unknown;
    username?: unknown;
    error?: unknown;
  };
  if (!res.ok || body.ok === false) {
    const reason = typeof body.error === 'string' ? `: ${body.error}` : '';
    throw Object.assign(new Error(`could not save credential${reason}`), {
      status: res.status === 400 ? 400 : 502,
    });
  }
  return {
    origin: typeof body.origin === 'string' ? body.origin : origin,
    username: typeof body.username === 'string' ? body.username : username,
  };
}

/** Remove one saved login. Idempotent from the user's view — a 404 (already
 *  gone) is reported as a clean not-found, not a transport error. */
export async function deleteSiteCredential(origin: string, username: string): Promise<void> {
  const o = reqString(origin, 'origin');
  const u = reqString(username, 'username');
  const url = `${CRED_URL}?origin=${encodeURIComponent(o)}&username=${encodeURIComponent(u)}`;
  const res = await typebuildFetch(url, { method: 'DELETE' });
  if (res.ok) return;
  if (res.status === 404) {
    throw Object.assign(new Error('no saved password for this login'), { status: 404 });
  }
  throw Object.assign(new Error(`could not delete credential (${res.status})`), {
    status: 502,
  });
}
