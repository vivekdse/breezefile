// Cooperative-boundary PII/data injection (docs/pii-data-injection-design.md).
//
// A TypeBuild task may carry an encrypted-at-rest `data` field: a flat JSON bag
// of value-by-key, e.g. { "patient.first": "…", "patient.ssn": "…" }. The agent
// only ever sees the KEYS (as placeholders); the VALUES are resolved here, in
// MAIN, and handed one-at-a-time to the browser helper over the localhost
// control API (electron/api-server.ts → electron/browser/cli.mjs `fill-ref`).
// The agent's MCP context never receives them.
//
// PHI invariant (typebuild.ts): decrypted values are MEMORY-ONLY and transient.
// We deliberately do NOT cache them — each resolve is a fresh fetch so a value
// never lingers in main's heap beyond the request that needs it, and is never
// persisted or logged.
//
// THREAT MODEL (load-bearing): this is a cooperative boundary, NOT a sandbox.
// The agent can still read the page / screenshot / eval the filled field, so it
// can recover values if it tries. PII tasks therefore require TRUSTED agents.
//
// THREE DATA CLASSES (see task_manager_api-8y0): a form value is one of
//   1. PATIENT/customer PHI — encrypted per task, lives in the task `data` bag,
//      resolved by (taskId, ref). Arbitrary keys, e.g. "patient.ssn".
//   2. The USER's OWN credentials/identifiers — NPI, practice Tax ID, portal
//      login IDs. Per-user, reusable across that user's tasks, NOT patient PHI,
//      NOT shared cross-user. Addressed by a reserved "me." ref prefix
//      (e.g. "me.npi") and resolved against a per-user vault, independent of any
//      task. (This file's class-2 path.)
//   3. Shared NON-PHI how-to — navigation prose in skills. Never a value.
// The agent surface is identical for classes 1 and 2: it fills a KEY via
// fill-ref/type-ref and never sees the value. Only THIS resolver routes by the
// ref's prefix to the right server source.
//
// Server contract (TypeBuild dependency — not built in this repo):
//
//   CLASS 1 (per-task PHI):
//     GET /chromeext/<id>/data?ref=<key>   → { value: string }
//       200 with the single decrypted value for <key>; 404 when the task isn't
//       visible / has no data / the key is unknown.
//
//   CLASS 2 (per-user credential vault) — the ENTITY RESOLVER:
//     GET /chromeext/entities/resolve?field=<name>&entity=<id|me>&format=<fmt>
//       `entity` defaults to `me` (the user's self-entity) — we omit it for the
//       `me.*` case; `field` is required. The server maps field aliases via a
//       canonical registry (npi, tax_id/ein, login_id, practice_name, …) and
//       hard-refuses secret fields, so we pass the BARE field name and let the
//       server canonicalize. Firebase-authed, scope-checked, value crosses only
//       this hop and is never logged. Response shapes (exact):
//         { "resolved": true,  "field": "<canonical>", "value": "<string>" }
//         { "resolved": false, "reason": "not_found",  "available": [<names>] }
//         { "resolved": false, "reason": "ambiguous",  "candidates": [<names>] }
//         { "resolved": false, "reason": "ambiguous_secret" }   (NO names)
//     (Supporting, not needed here: GET /chromeext/entities (list, names only),
//      GET /chromeext/entities/me (self field names), GET /chromeext/entities/{id}.)
//
// Requesting one ref/field at a time keeps a single value (not the whole bag /
// entity) crossing the wire into main on each fill.
//
// me.* → resolve mapping (the ref-to-request decision): strip the "me." prefix;
// the remainder is the `field` (entity defaults to `me`). e.g. "me.npi" →
// ?field=npi. Multi-segment refs (the old "me.npi.<location>" idea) are NOT
// flat dotted keys in the shipped model — disambiguation is by separate ENTITIES
// (entity=<id>). For now we pass the whole remainder through as the field name
// verbatim and let the server's resolver/canonicalizer decide; client-side
// location routing (multi-entity selection) is a deliberate follow-up punt.

import { getIdToken } from './auth';

export const API_BASE = 'https://general.typebuild.com';

/** Authed fetch with the same 401-refresh-and-retry-once discipline used by
 *  every TypeBuild call: getIdToken refreshes proactively, but a token can be
 *  revoked mid-session, so we retry once with a fresh token before failing.
 *  Shared by the fill-time resolver here and the vault CRUD in user-vault.ts. */
export async function typebuildFetch(reqUrl: string, init?: RequestInit): Promise<Response> {
  const doFetch = async (): Promise<Response> => {
    const token = await getIdToken();
    return fetch(reqUrl, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  };
  let res = await doFetch();
  if (res.status === 401) {
    res = await doFetch();
    if (res.status === 401) {
      throw Object.assign(new Error('typebuild: signed out (401)'), { status: 401 });
    }
  }
  return res;
}

// Reserved prefix for class-2 (the user's own credentials/identifiers). A ref
// like "me.npi" resolves against the per-user vault, not the task `data` bag.
const USER_REF_PREFIX = 'me.';

/** True when `ref` addresses the signed-in user's own credential vault (class 2)
 *  rather than the current task's PHI bag (class 1). */
export function isUserDataRef(ref: string): boolean {
  return ref.startsWith(USER_REF_PREFIX);
}

/** Resolve one placeholder ref to its decrypted string value, routing by class:
 *  a "me." ref hits the per-user credential vault (class 2); any other ref hits
 *  the given task's `data` bag (class 1). `taskId` is required for class-1 refs
 *  and ignored for class-2.
 *
 *  Throws on an unknown ref / not-visible task or user / transport failure — the
 *  caller (api-server) maps the throw to a non-200 so the helper surfaces a
 *  clear error to the agent WITHOUT ever carrying the value into its context.
 *  Never logs the value. */
export async function resolveTaskDataRef(taskId: string, ref: string): Promise<string> {
  if (!ref) throw new Error('ref required');

  if (isUserDataRef(ref)) {
    // Class 2 — the user's own vault, via the entity resolver. Scoped to the
    // signed-in user by the Firebase token; no task involved, so taskId is
    // intentionally unused. This path has its OWN parse (a richer resolved/
    // not-resolved response than class 1's plain {value}), so it does not reuse
    // fetchDataValue.
    return resolveUserField(ref);
  }

  // Class 1 — patient PHI on this task.
  if (!taskId) throw new Error('taskId required');
  return fetchDataValue(
    `${API_BASE}/chromeext/${encodeURIComponent(taskId)}/data?ref=${encodeURIComponent(ref)}`,
    ref,
  );
}

/** One-value-per-call fetch shared by both data classes. Holds the auth/404/
 *  empty-value discipline so class 1 and class 2 behave identically. Never
 *  caches (PHI/credentials are transient, memory-only) and never logs the
 *  value — only the opaque ref key may appear in errors. */
async function fetchDataValue(reqUrl: string, ref: string): Promise<string> {
  const res = await typebuildFetch(reqUrl);
  if (res.status === 404) {
    // Don't echo the ref's value (there is none) — just the opaque key.
    throw Object.assign(new Error(`no data for ref "${ref}"`), { status: 404 });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`task-data fetch failed (${res.status})`), {
      status: 502,
    });
  }
  const body = (await res.json().catch(() => ({}))) as { value?: unknown };
  if (typeof body.value !== 'string') {
    throw Object.assign(new Error(`data ref "${ref}" is not a string value`), {
      status: 502,
    });
  }
  // An empty value would silently fill a field with nothing and report success
  // — treat it as "no data" so the agent gets an actionable error rather than a
  // blank-but-"filled" form. (Pinned in the contract: empty is not a fill.)
  if (body.value === '') {
    throw Object.assign(new Error(`no data for ref "${ref}" (empty)`), { status: 404 });
  }
  return body.value;
}

// The entity-resolver's not-resolved payload. Only NON-secret field names ever
// appear here (available/candidates); ambiguous_secret discloses nothing.
type ResolveResponse =
  | { resolved: true; field?: string; value?: unknown }
  | { resolved: false; reason?: string; available?: unknown; candidates?: unknown };

/** Names-careful join: keep error text terse and bounded, and never echo a
 *  value (these branches have no value anyway). Returns '' when there are none. */
function joinNames(names: unknown): string {
  if (!Array.isArray(names)) return '';
  const safe = names.filter((n): n is string => typeof n === 'string');
  if (safe.length === 0) return '';
  const shown = safe.slice(0, 12);
  const suffix = safe.length > shown.length ? ', …' : '';
  return shown.join(', ') + suffix;
}

/** Resolve a class-2 "me.*" ref against the per-user entity resolver. Strips the
 *  "me." prefix to the `field`; entity defaults to `me` (omitted). The server
 *  canonicalizes aliases and refuses secret fields, so we pass the bare field.
 *
 *  On `resolved:true` returns the string value (NEVER logged — same memory-only
 *  discipline as class 1). On `resolved:false` throws a value-free, name-careful
 *  error the fill path surfaces to the agent:
 *    not_found        → "field not found" (may list the user's non-secret fields)
 *    ambiguous        → "ambiguous — disambiguate" (may list candidate fields)
 *    ambiguous_secret → generic "ambiguous / refused" — discloses NOTHING.
 *  Never caches; one value per call. */
async function resolveUserField(ref: string): Promise<string> {
  // Strip the reserved "me." prefix → the field. Multi-segment remainders pass
  // through verbatim (see header: location routing is a server/follow-up concern).
  const field = ref.slice(USER_REF_PREFIX.length);
  if (!field) throw new Error(`ref "${ref}" has no field after "me."`);

  // entity defaults to `me`, so we omit it. format is left to the server default.
  const reqUrl = `${API_BASE}/chromeext/entities/resolve?field=${encodeURIComponent(field)}`;
  const res = await typebuildFetch(reqUrl);
  if (!res.ok) {
    throw Object.assign(new Error(`resolve failed for ref "${ref}" (${res.status})`), {
      status: 502,
    });
  }
  const body = (await res.json().catch(() => ({}))) as ResolveResponse;

  if (body.resolved === true) {
    if (typeof body.value !== 'string') {
      throw Object.assign(new Error(`ref "${ref}" resolved without a string value`), {
        status: 502,
      });
    }
    // Treat empty as "no data" — a blank fill that reports success is worse than
    // a clear error (mirrors class 1).
    if (body.value === '') {
      throw Object.assign(new Error(`no data for ref "${ref}" (empty)`), { status: 404 });
    }
    return body.value;
  }

  // resolved:false — value-free, name-careful errors by reason. We name only
  // NON-secret field names (available/candidates) the server chose to disclose.
  const reason = body.resolved === false ? body.reason : undefined;
  if (reason === 'ambiguous_secret') {
    // Discloses NOTHING — no field names, no value.
    throw Object.assign(
      new Error(`ref "${ref}" is ambiguous and refused (no details disclosed)`),
      { status: 409 },
    );
  }
  if (reason === 'ambiguous') {
    const candidates = body.resolved === false ? joinNames(body.candidates) : '';
    throw Object.assign(
      new Error(
        `ref "${ref}" is ambiguous — disambiguate` +
          (candidates ? ` (candidates: ${candidates})` : ''),
      ),
      { status: 409 },
    );
  }
  // not_found (and any unknown reason) — terse, may list the user's fields.
  const available = body.resolved === false ? joinNames(body.available) : '';
  throw Object.assign(
    new Error(
      `no field for ref "${ref}"` + (available ? ` (available: ${available})` : ''),
    ),
    { status: 404 },
  );
}
