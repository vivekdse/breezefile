// docs/connections-design.md §D.1 (kind:'rest' path) + §E — the declarative
// REST call interpreter. This is the ONLY place a Connection's CallSpec turns
// into an actual HTTP request; there is no code execution here, only a plain
// fetch built from inert data (method/path/{param} slots/query/headers/body)
// and a JSON-path output mapping applied to the response.
//
// CLIENT-DIRECT (load-bearing, per §A/§G): the request goes to the
// Connection's OWN `endpoint`, never to general.typebuild.com, and carries
// the BROKERED credential (electron/sources/typebuild.ts
// resolveConnectionCredential — memory-only, re-fetched every job), never the
// Firebase ID token. The response is returned to the caller in this
// process's memory only — it is never logged and never round-trips through
// the TypeBuild server. Uses the repo's existing fetchWithTimeout so a dead
// external API fails fast instead of hanging the agent's tool call.

import { fetchWithTimeout } from './http';
import type { CallSpec, CallOutputMapping, ConnectionCredentialResolved } from '../../src/types';

/** Minimal in-scope Connection shape the executor needs — just enough to
 *  build the request URL and know it's a 'rest' Connection. Callers (the
 *  control endpoint, §D.1) pass this from whatever in-scope-Connection list
 *  they resolved at job start; this module has no fetch/list logic of its
 *  own. */
export type ExecConnection = {
  id: string;
  endpoint: string;
  kind: 'rest' | 'mcp';
};

export type ConnectionCallResult =
  | { ok: true; status: number; data: Record<string, unknown> | Record<string, unknown>[] }
  | { ok: false; reason: string; status?: number };

// ─── tiny JSON-path subset (§E) ─────────────────────────────────────────
// Only what CallSpec actually needs: "$" root, ".key" member access,
// "[N]" numeric index, and "[*]" "every element" (only meaningful as the
// LAST segment, for rowsPath). No filters, no wildcseveral-deep, no
// function calls — deliberately inert, mirroring the "no code" constraint
// on the whole executor.

type PathSegment = { key: string } | { index: number } | { every: true };

function parsePath(path: string): PathSegment[] {
  const segs: PathSegment[] = [];
  // Strip a leading "$" and/or "$." root marker.
  let rest = path.trim();
  if (rest.startsWith('$')) rest = rest.slice(1);
  if (rest.startsWith('.')) rest = rest.slice(1);
  // Tokenize on '.' but keep bracket groups attached to the preceding token,
  // e.g. "results[*].id" -> ["results[*]", "id"].
  const tokens = rest.split('.').filter((t) => t.length > 0);
  for (const tok of tokens) {
    const m = /^([^[\]]*)((?:\[[^\]]*\])*)$/.exec(tok);
    if (!m) continue;
    const [, base, brackets] = m;
    if (base) segs.push({ key: base });
    if (brackets) {
      for (const b of brackets.matchAll(/\[([^\]]*)\]/g)) {
        const raw = b[1];
        if (raw === '*') segs.push({ every: true });
        else if (/^-?\d+$/.test(raw)) segs.push({ index: Number(raw) });
      }
    }
  }
  return segs;
}

/** Resolve a JSON-path against a value. `[*]` fans out: once encountered, the
 *  remaining path is applied to every element and the results are flattened
 *  into an array. Missing/mismatched shape resolves to `undefined` (or `[]`
 *  for a `[*]` fan-out with nothing to iterate), never throws — the caller
 *  (mapOutput) is what decides that's a drift signal. */
function resolveJsonPath(root: unknown, path: string): unknown {
  const segs = parsePath(path);
  const walk = (value: unknown, i: number): unknown => {
    if (i >= segs.length) return value;
    const seg = segs[i];
    if (value === null || value === undefined) return undefined;
    if ('key' in seg) {
      if (typeof value !== 'object' || Array.isArray(value)) return undefined;
      return walk((value as Record<string, unknown>)[seg.key], i + 1);
    }
    if ('index' in seg) {
      if (!Array.isArray(value)) return undefined;
      const idx = seg.index < 0 ? value.length + seg.index : seg.index;
      return walk(value[idx], i + 1);
    }
    // 'every' — fan out over an array, applying the rest of the path to each
    // element, and flatten.
    if (!Array.isArray(value)) return [];
    return value.map((el) => walk(el, i + 1));
  };
  return walk(root, 0);
}

/** Fill `{param}` slots in a template string from `values` (path params AND
 *  query/body substitution both use this — §E: "a literal or `{inputKey}`
 *  referencing a caller-supplied input"). Leaves an unresolved `{x}` in place
 *  rather than throwing — the HTTP call will then plainly fail against a
 *  literal "{x}" segment, which is a clearer signal than swallowing it. */
function fillTemplate(tpl: string, values: Record<string, string>): string {
  return tpl.replace(/\{([a-zA-Z0-9_.]+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole,
  );
}

function isInputRef(v: string): string | null {
  const m = /^\{([a-zA-Z0-9_.]+)\}$/.exec(v.trim());
  return m ? m[1] : null;
}

/** Apply the brokered credential to a plain fetch init, per its `kind` —
 *  §E/§D.1: api_key -> header, bearer -> Authorization: Bearer, basic ->
 *  Basic auth, oauth2 -> Authorization: Bearer accessToken. Never logs the
 *  credential value. mcp_token is not a REST-executor credential kind (MCP
 *  Connections never reach this module — §D.1 "no wrapping one as the
 *  other") — defensively ignored if it somehow arrives. */
function applyCredential(
  headers: Record<string, string>,
  cred: ConnectionCredentialResolved | null,
): void {
  if (!cred) return;
  switch (cred.kind) {
    case 'api_key':
      headers[cred.header && cred.header.trim() ? cred.header : 'X-Api-Key'] = cred.value;
      return;
    case 'bearer':
      headers.Authorization = `Bearer ${cred.value}`;
      return;
    case 'basic': {
      const raw = `${cred.username}:${cred.password}`;
      headers.Authorization = `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
      return;
    }
    case 'oauth2':
      headers.Authorization = `${cred.tokenType && cred.tokenType.trim() ? cred.tokenType : 'Bearer'} ${cred.accessToken}`;
      return;
    case 'mcp_token':
      // Not applicable to a REST call; no-op (defensive only — the caller
      // gates kind:'rest' before ever reaching here).
      return;
  }
}

function mapOutput(
  body: unknown,
  mapping: CallOutputMapping,
): { data: Record<string, unknown> | Record<string, unknown>[] } | { error: string } {
  if (mapping.shape === 'value') {
    const out: Record<string, unknown> = {};
    for (const [fieldKey, jsonPath] of Object.entries(mapping.fields)) {
      out[fieldKey] = resolveJsonPath(body, jsonPath);
    }
    return { data: out };
  }
  // shape === 'rows'
  const rows = resolveJsonPath(body, mapping.rowsPath);
  if (!Array.isArray(rows)) {
    return { error: `rowsPath "${mapping.rowsPath}" did not resolve to an array` };
  }
  const mapped = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [fieldKey, jsonPath] of Object.entries(mapping.fields)) {
      out[fieldKey] = resolveJsonPath(row, jsonPath);
    }
    const externalId = resolveJsonPath(row, mapping.ref.externalIdPath);
    out.ref = { entityType: mapping.ref.entityType, externalId };
    return out;
  });
  return { data: mapped };
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Execute a declarative CallSpec against a `kind:'rest'` Connection,
 * client-direct, with the brokered credential applied. `params` supplies the
 * `{inputKey}` substitution values referenced from `path`/`query`/`body`.
 * `cred` is the ALREADY-BROKERED, in-memory credential for this Connection
 * (never re-fetched here — brokering is the caller's job, once per job-start
 * per docs/connections-design.md §C). Never throws; every failure mode
 * (network, timeout, non-2xx, shape mismatch) returns a structured
 * `{ ok:false, reason }` so the caller can flag drift (§F) without a crash.
 */
export async function executeConnectionCall(
  connection: ExecConnection,
  spec: CallSpec,
  params: Record<string, string>,
  cred: ConnectionCredentialResolved | null,
): Promise<ConnectionCallResult> {
  if (connection.kind !== 'rest') {
    return { ok: false, reason: `connection ${connection.id} is not kind:'rest'` };
  }
  let base: URL;
  try {
    base = new URL(connection.endpoint);
  } catch {
    return { ok: false, reason: 'connection endpoint is not a valid URL' };
  }
  const filledPath = fillTemplate(spec.path, params);
  // Path params are whichever {key} names actually appear in `path`; every
  // OTHER declared query entry becomes a query-string param (§E).
  const pathKeys = new Set(
    Array.from(filledPath.matchAll(/\{([a-zA-Z0-9_.]+)\}/g)).map((m) => m[1]),
  );
  const url = new URL(filledPath.replace(/^\/?/, '/'), base);
  for (const [k, v] of Object.entries(spec.query ?? {})) {
    if (pathKeys.has(k)) continue;
    const ref = isInputRef(v);
    const resolved = ref !== null ? (params[ref] ?? '') : v;
    url.searchParams.set(k, resolved);
  }

  const headers: Record<string, string> = { Accept: 'application/json', ...(spec.headers ?? {}) };
  applyCredential(headers, cred);

  let body: string | undefined;
  if (spec.method === 'POST' && spec.body) {
    const filledBody: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(spec.body)) {
      if (typeof v === 'string') {
        const ref = isInputRef(v);
        filledBody[k] = ref !== null ? (params[ref] ?? '') : v;
      } else {
        filledBody[k] = v;
      }
    }
    body = JSON.stringify(filledBody);
    headers['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(
      url.toString(),
      { method: spec.method, headers, body },
      spec.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  } catch (err) {
    // Never include headers/body (credential) in the error surface.
    const msg = err instanceof Error ? err.message : 'request failed';
    return { ok: false, reason: msg };
  }
  if (!res.ok) {
    return { ok: false, reason: `upstream returned ${res.status}`, status: res.status };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: 'response was not valid JSON', status: res.status };
  }
  const mapped = mapOutput(json, spec.output);
  if ('error' in mapped) {
    return { ok: false, reason: mapped.error, status: res.status };
  }
  return { ok: true, status: res.status, data: mapped.data };
}
