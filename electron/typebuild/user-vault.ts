// User credential vault — CRUD for CLASS 2 data (the user's OWN identifiers:
// NPI, practice Tax ID, portal login IDs). Server/API side is the shipped
// TypeBuild ENTITY API (general.typebuild.com).
//
// This is the MANAGEMENT path (the :secrets panel): list keys, set/replace a
// value, reveal one value on demand, delete. The FILL-TIME path (an agent
// filling a "me.*" placeholder into a form) lives in task-data.ts via
// resolveTaskDataRef — both hit the same per-user self-entity ("me"), one value
// per call.
//
// Source of truth is the SERVER (encrypted at rest, per-user, Firebase-authed).
// The client deliberately keeps NO plaintext at rest: listing returns field
// NAMES only; a value crosses the wire only when the user explicitly reveals it
// or an agent fills it, and is never cached, persisted, or logged in main.
//
// PHI note: these are the user's own provider identifiers, NOT patient PHI —
// but they are still secrets. Never log a value; only key names may appear in
// errors/telemetry.
//
// SERVER CONTRACT (the SHIPPED entity API — app/routers/chromeext.py +
// app/utils/chromeext_entities.py). There is NO /chromeext/me/data route; that
// was never deployed. All management ops go through the self-entity ("me"):
//
//   GET  /chromeext/entities/me
//     → { id, is_self: true, fields: [names], secret_fields: [names] }
//     NAMES only, never values. The "me" entity is created lazily, so an empty
//     result (no fields yet) is NORMAL, not a 404.
//
//   PUT  /chromeext/entities/{entityid}/fields   body { field, value }
//     → { ok: true, id, field }.  Create/replace one field. The {entityid} comes
//     from GET /chromeext/entities/me (`id`); there is no "me" shortcut for this
//     PUT. The server VALIDATES some fields (npi → Luhn, ssn/ein → 9 digits) and
//     signals failure as HTTP 400 and/or a body of { ok:false, reason } — we
//     handle both. It canonicalizes the field name on write.
//     DELETE (clear) a field = PUT with an EMPTY value; there is NO per-field
//     DELETE route. LIVE-VERIFIED CAVEAT: empty clears NON-validated fields, but
//     VALIDATED fields (npi/ssn/ein) REFUSE empty ({ ok:false,
//     reason:"invalid_value" }) — so those can only be replaced, not cleared,
//     via this API. deleteUserSecret surfaces that as an actionable error.
//     (DELETE /chromeext/entities/{id} nukes the WHOLE entity — NOT used here.)
//
//   GET  /chromeext/entities/resolve?entity=me&field=<name>   (reveal/fill)
//     → { resolved: true, field, value } / not-resolved envelope. NEVER returns
//     secret fields (ssn/dob/bank_account) — the server refuses them. Reveal
//     reuses task-data.ts's resolver (resolveTaskDataRef), so secret fields
//     surface a clean "refused" error here, and the panel disables their reveal.
//
// Field names on the wire are the BARE canonical field (e.g. "npi"), NOT
// "me.npi". The panel collects a short key from the user ("npi") and we
// namespace it to "me.npi" for UX/consistency with the fill path; we strip the
// "me." prefix before talking to the entity API (mirrors task-data.ts's
// resolveUserField). All scoped to the signed-in user by the Firebase token.

import { API_BASE, isUserDataRef, resolveTaskDataRef, typebuildFetch } from './task-data';

const ME_URL = `${API_BASE}/chromeext/entities/me`;

// All vault keys are "me.*" placeholders; the panel collects a short key from
// the user (e.g. "npi") and we namespace it. Keep keys NON-PHI and opaque.
const USER_REF_PREFIX = 'me.';

// One vault entry as the panel consumes it: the "me."-prefixed key (matching
// the existing panel/reveal UX) plus whether the field is a server-side SECRET
// (write-only — saveable but the resolver refuses to reveal it).
export interface VaultEntry {
  key: string;
  secret: boolean;
}

// The self-entity (names only — never values).
interface MeEntity {
  id?: unknown;
  is_self?: unknown;
  fields?: unknown;
  secret_fields?: unknown;
}

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

/** The bare canonical field name for the entity API (strips the "me." prefix).
 *  Mirrors task-data.ts's resolveUserField. */
function toEntityField(ref: string): string {
  const field = ref.slice(USER_REF_PREFIX.length);
  if (!field) throw Object.assign(new Error(`ref "${ref}" has no field after "me."`), { status: 400 });
  return field;
}

function asNameArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((n): n is string => typeof n === 'string');
}

/** Fetch the user's self-entity (names only, never values). The "me" entity is
 *  created lazily server-side, so an empty fields/secret_fields shape is normal.
 *  Returns the entity `id` (needed for the fields PUT) plus the two name lists. */
async function fetchMeEntity(): Promise<{ id: string; fields: string[]; secretFields: string[] }> {
  const res = await typebuildFetch(ME_URL);
  if (!res.ok) {
    throw Object.assign(new Error(`vault read failed (${res.status})`), { status: 502 });
  }
  const body = (await res.json().catch(() => ({}))) as MeEntity;
  const id = typeof body.id === 'string' ? body.id : String(body.id ?? '');
  if (!id) {
    throw Object.assign(new Error('vault read returned no entity id'), { status: 502 });
  }
  return {
    id,
    fields: asNameArray(body.fields),
    secretFields: asNameArray(body.secret_fields),
  };
}

/** List the user's vault entries (names only, never values). Returns BOTH
 *  non-secret and secret fields, each tagged with `secret` so the panel can
 *  disable the reveal toggle for write-only fields. Keys are "me."-prefixed to
 *  match the existing panel/reveal UX. */
export async function listUserSecrets(): Promise<VaultEntry[]> {
  const { fields, secretFields } = await fetchMeEntity();
  const secretSet = new Set(secretFields);
  // Union of both lists (a field could in principle appear in either); de-dupe
  // by bare name, tag secrets. Present as "me.<field>" for the panel.
  const seen = new Set<string>();
  const entries: VaultEntry[] = [];
  for (const name of [...fields, ...secretFields]) {
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push({ key: `${USER_REF_PREFIX}${name}`, secret: secretSet.has(name) });
  }
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

/** Reveal ONE value on explicit user action (the eye toggle). Reuses the
 *  fill-time resolver so reveal and fill share identical handling and the same
 *  one-value-per-call discipline. The server refuses SECRET fields (the panel
 *  disables their toggle, but if reached the resolver throws a value-free
 *  "refused" error). Never cached, never logged. */
export async function revealUserSecret(ref: string, format?: string): Promise<string> {
  const canonical = toUserRef(ref);
  // resolveTaskDataRef routes "me.*" to the entity resolver; taskId unused for
  // class 2. `format` (bare|dashed) is an optional shape hint; omitted = server
  // default. The value is never cached or logged on this path.
  return resolveTaskDataRef('', canonical, format);
}

/** Create or replace one secret via PUT /chromeext/entities/{id}/fields. Looks
 *  up the self-entity id first (no "me" shortcut for this PUT), then writes the
 *  BARE canonical field. Surfaces a clean server validation error (e.g. bad NPI)
 *  WITHOUT echoing the value. Returns the canonical "me.*" ref written so the
 *  panel can refresh without echoing the value. */
export async function setUserSecret(rawKey: string, value: string): Promise<string> {
  const ref = toUserRef(rawKey);
  if (typeof value !== 'string' || value === '') {
    throw Object.assign(new Error('value required'), { status: 400 });
  }
  const field = toEntityField(ref);
  const { id } = await fetchMeEntity();
  const result = await putField(id, field, value, ref);
  if (!result.ok) {
    // Validation failure (e.g. bad NPI Luhn / non-9-digit SSN/EIN). Surface the
    // server's reason — never the value.
    const reason = result.reason ? `: ${result.reason}` : '';
    throw Object.assign(new Error(`invalid value for "${ref}"${reason}`), { status: 400 });
  }
  return ref;
}

/** Delete one secret by clearing it. The entity API has NO per-field DELETE —
 *  clearing is a PUT with an empty value.
 *
 *  LIVE-VERIFIED CAVEAT: an empty value is accepted (and clears the field) for
 *  NON-validated fields, but the server's per-field validators REJECT empty for
 *  VALIDATED fields (npi → Luhn, ssn/ein → 9 digits) with { ok:false,
 *  reason:"invalid_value" }. There is no other field-level clear, and we will
 *  NOT nuke the whole entity to drop one field. So for a validated field we
 *  surface a clear, actionable error rather than silently failing.
 *
 *  Idempotent for non-validated fields: clearing an already-absent field is a
 *  no-op success. */
export async function deleteUserSecret(rawKey: string): Promise<void> {
  const ref = toUserRef(rawKey);
  const field = toEntityField(ref);
  const { id } = await fetchMeEntity();
  const result = await putField(id, field, '', ref);
  if (result.ok) return;
  // The only expected failure here is a validated field refusing an empty value.
  // Translate the generic validation reason into a delete-specific message so
  // the user understands WHY (and what to do): replace the value instead.
  if (result.reason === 'invalid_value') {
    throw Object.assign(
      new Error(
        `"${ref}" can't be cleared (it's a validated field) — replace its value instead of deleting`,
      ),
      { status: 409 },
    );
  }
  throw Object.assign(new Error(`could not delete "${ref}"`), { status: 502 });
}

type PutResult = { ok: true } | { ok: false; reason?: string };

/** PUT one field value to the self-entity. The server signals validation failure
 *  TWO ways (live-verified): an HTTP 400, and/or a 200 body of
 *  { ok:false, reason } — we handle both. Returns a structured result so callers
 *  (set vs delete) can phrase the right error. NEVER includes the value in any
 *  message. */
async function putField(
  entityId: string,
  field: string,
  value: string,
  ref: string,
): Promise<PutResult> {
  const url = `${API_BASE}/chromeext/entities/${encodeURIComponent(entityId)}/fields`;
  const res = await typebuildFetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field, value }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: unknown; reason?: unknown };
  const reason = typeof body.reason === 'string' ? body.reason : undefined;
  // Success: HTTP ok AND no body-level ok:false.
  if (res.ok && body.ok !== false) return { ok: true };
  // Validation failure — surface ONLY the reason (never the value). HTTP 400 or
  // a 200 {ok:false} both land here.
  if (res.status === 400 || body.ok === false) {
    return { ok: false, reason };
  }
  // Transport / unexpected status.
  throw Object.assign(new Error(`could not save "${ref}" (${res.status})`), { status: 502 });
}
