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
// Server contract (TypeBuild dependency — not built in this repo):
//   GET /chromeext/<id>/data?ref=<key>   → { value: string }
//     200 with the single decrypted value for <key>.
//     404 when the task isn't visible / has no data / the key is unknown.
// Requesting one ref at a time keeps a single value (not the whole bag)
// crossing the wire into main on each fill.

import { getIdToken } from './auth';

const API_BASE = 'https://general.typebuild.com';

/** Resolve one placeholder ref (a `data` key) to its decrypted string value.
 *  Throws on an unknown ref / not-visible task / transport failure — the
 *  caller (api-server) maps the throw to a non-200 so the helper surfaces a
 *  clear error to the agent WITHOUT ever carrying the value into its context.
 *  Never logs the value. */
export async function resolveTaskDataRef(taskId: string, ref: string): Promise<string> {
  if (!taskId) throw new Error('taskId required');
  if (!ref) throw new Error('ref required');

  // Mirror TypeBuildTaskSource.request()'s 401 handling: getIdToken refreshes
  // proactively, but a token can be revoked mid-session — retry once with a
  // fresh token before giving up, so a transient auth blip doesn't fail an
  // otherwise-fillable field.
  const doFetch = async (): Promise<Response> => {
    const token = await getIdToken();
    return fetch(
      `${API_BASE}/chromeext/${encodeURIComponent(taskId)}/data?ref=${encodeURIComponent(ref)}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    );
  };

  let res = await doFetch();
  if (res.status === 401) {
    res = await doFetch();
    if (res.status === 401) {
      throw Object.assign(new Error('typebuild: signed out (401)'), { status: 401 });
    }
  }
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
