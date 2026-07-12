// AuthKit connector client (task-7ef58b54d90f).
//
// A SERVICE-GENERIC client for the live authkit connector API at
// auth.typebuild.com. AuthKit brokers the user's third-party connections
// (github, slack, google, …) behind ONE uniform surface under /connectors,
// keyed by `toolkit` name. So this module is deliberately ONE parameterized
// function per verb — never one-per-service: adding a new toolkit is a caller
// passing a different string, not new code here.
//
// API (probed 2026-07-12, unauthenticated — every path answered
//   401 {"detail":"Unauthorized: Firebase Bearer token required."}
// confirming the whole surface is mounted and gates the Firebase bearer BEFORE
// the body, so an unauthenticated probe proves reachability + the auth contract
// but not the success shapes, which need a live session):
//   GET    /connectors                    → the user's connections (NO tokens)
//   POST   /connectors/{toolkit}/connect  → { connection_id, redirect_url, status }
//   GET    /connectors/{toolkit}/status   → connection row (NO tokens)
//   GET    /connectors/{toolkit}/token    → { access_token, refresh_token, expires_in, … }
//   DELETE /connectors/{toolkit}          → disconnect
//
// AUTH: Authorization: Bearer <Firebase ID token> on ALL calls (reused from
// auth.ts's getIdToken(), auto-refreshing + single-flight, exactly like
// mcp-token.ts and scheduling-token.ts). The /token endpoint is an ADDITIONAL
// server-to-server gate: it also requires X-Authkit-Service-Token: <secret>,
// a shared service secret that must NEVER reach the renderer or disk. We read
// it from AUTHKIT_SERVICE_TOKEN (env only — this repo has no main-process
// settings/secret store; every other main-process secret, e.g. auth.ts's
// TYPEBUILD_PASSWORD, is env-sourced too).
//
// SECURITY/PHI: third-party access/refresh tokens AND the service secret are
// secrets. They are held in MEMORY ONLY (the per-toolkit cache below), NEVER
// persisted to disk, logged, or returned to the renderer (this module is
// main-process only by design — see the task: raw third-party tokens must not
// cross the IPC boundary). We log nothing token-bearing. This mirrors
// scheduling-token.ts's discipline.

import { getIdToken, signOut } from './auth';
import { fetchWithTimeout } from './http';

// The AuthKit authorization server. Overridable via env so a test can point at
// a local/staging authkit without touching code. Default is the live host.
const BASE_URL = (process.env.AUTHKIT_BASE_URL || 'https://auth.typebuild.com').replace(/\/+$/, '');

// Re-fetch a cached token when it is within this window of expiry, so a caller
// never starts a server-to-server call with a token that expires mid-flight.
// 60s of slack covers request latency plus modest clock skew — same rationale
// as scheduling-token.ts.
const EXPIRY_SKEW_MS = 60 * 1000;

/** A connection row as returned by list/status/connect (NO token material).
 *  Kept intentionally open (`[key: string]: unknown`) — AuthKit owns the row
 *  shape and it varies by toolkit; callers read the fields they need and this
 *  module never persists it. */
export type ConnectionRow = {
  toolkit?: string;
  connection_id?: string;
  status?: string;
  [key: string]: unknown;
};

/** The result of starting a connection. The caller decides whether/how to open
 *  `redirectUrl` (we deliberately do NOT open it — the main process shouldn't
 *  assume a window/shell policy). */
export type StartedConnection = {
  connectionId: string;
  redirectUrl: string;
  status: string;
};

/** A third-party access token payload from GET .../token. This is SECRET —
 *  keep it out of logs, disk, and the renderer. `expiresIn` is SECONDS
 *  REMAINING as of return (recomputed on a cache hit so it never reports the
 *  stale original TTL). Extra fields AuthKit returns ride `[key: string]`. */
export type ConnectorTokenPayload = {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until the token expires, as of return time. */
  expiresIn: number;
  /** Any additional non-secret metadata AuthKit includes (scope, token_type…). */
  extra: Record<string, unknown>;
};

/** Typed failure codes, mirroring SchedulingTokenError's machine-code style so a
 *  caller branches on a code rather than parsing prose.
 *   - 'signed-out'            : no/rejected Firebase bearer → re-run sign-in
 *   - 'service-token-unset'   : AUTHKIT_SERVICE_TOKEN missing (config gap)
 *   - 'service-token-invalid' : bearer fine but the service secret was rejected
 *   - 'not-found'             : 404 — unknown toolkit / no such connection
 *   - 'not-connected'         : 409 — the user hasn't connected this toolkit
 *                               (caller should startConnection())
 *   - 'server-disabled'       : 503 — AuthKit's shared token is unset server-side
 *   - 'unreachable'           : network/transport/5xx/contract violation */
export type ConnectorErrorCode =
  | 'signed-out'
  | 'service-token-unset'
  | 'service-token-invalid'
  | 'not-found'
  | 'not-connected'
  | 'server-disabled'
  | 'unreachable';

// IPC strips custom Error properties — only `.message` survives a main →
// renderer hop — so, exactly as scheduling-token.ts does, we ENCODE the typed
// code into the message with a stable, machine-parsable prefix. This module is
// main-process only, but keeping the discipline means the error is still
// legible if a caller ever forwards `.message` onward.
const ERR_PREFIX = 'typebuild-connector';

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  constructor(code: ConnectorErrorCode, detail: string) {
    super(`[${ERR_PREFIX}:${code}] ${detail}`);
    this.name = 'ConnectorError';
    this.code = code;
  }
}

// In-memory, per-toolkit token cache. Held in module memory ONLY — never
// persisted (the token is a third-party secret). Keyed by toolkit so each
// service gets its own slot without cross-contamination.
type TokenCacheEntry = {
  accessToken: string;
  refreshToken?: string;
  extra: Record<string, unknown>;
  expiresAtMs: number;
};
const tokenCache = new Map<string, TokenCacheEntry>();

/**
 * Shared authenticated request against the connector API. Attaches the Firebase
 * bearer on EVERY call; merges any extra headers (only the /token call adds the
 * service-token header). Returns the parsed Response for the caller to branch
 * on; throws a typed {@link ConnectorError} only for the transport-level cases
 * common to all verbs (missing identity, unreachable). HTTP-status mapping is
 * left to each verb because the *meaning* of a status differs (a 404 on /token
 * vs on DELETE), which is exactly why this stays a thin helper.
 */
async function connectorFetch(
  path: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; extraHeaders?: Record<string, string> },
): Promise<Response> {
  // Fresh Firebase ID token. getIdToken auto-refreshes and, on refresh failure
  // (revoked/disabled), already drops to signed-out. Any throw here means we
  // have no valid identity → signed-out.
  let idToken: string;
  try {
    idToken = await getIdToken();
  } catch {
    throw new ConnectorError('signed-out', 'Firebase sign-in required');
  }

  try {
    return await fetchWithTimeout(`${BASE_URL}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${idToken}`,
        ...(init.extraHeaders ?? {}),
      },
    });
  } catch {
    // Network/transport failure (DNS, offline, TLS, or the fail-fast timeout in
    // http.ts) → unreachable.
    throw new ConnectorError('unreachable', 'Could not reach the connector API');
  }
}

/** Read a Response body as JSON, tolerating an empty/non-JSON body. */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * Map a non-ok Response to a typed {@link ConnectorError}. `onToken` selects the
 * 401 meaning: a 401 on a token-gated call may be the Firebase bearer OR the
 * service secret. We distinguish via the response body when possible (AuthKit's
 * detail mentions the service/shared token), else fall back to signed-out for a
 * bare token gate. Always parses the (token-free) body first.
 */
async function throwForStatus(res: Response, opts: { onToken?: boolean } = {}): Promise<never> {
  const body = await readJson(res);
  const detail = typeof body.detail === 'string' ? body.detail.toLowerCase() : '';

  if (res.status === 401) {
    // On the /token call a 401 can mean the SERVICE secret was rejected even
    // though the Firebase bearer was fine — distinguish via the body wording.
    if (opts.onToken && (detail.includes('service') || detail.includes('authkit'))) {
      throw new ConnectorError('service-token-invalid', 'Service token rejected');
    }
    // Otherwise the Firebase bearer was rejected: the only recovery is a fresh
    // sign-in, so also flip auth to signed-out (best-effort) so Settings shows
    // the sign-in form — mirroring scheduling-token.ts.
    try {
      await signOut();
    } catch {
      // Best-effort; the typed error below still drives the UI.
    }
    throw new ConnectorError('signed-out', 'Firebase token rejected');
  }
  if (res.status === 404) throw new ConnectorError('not-found', 'No such toolkit or connection');
  if (res.status === 409) throw new ConnectorError('not-connected', 'Toolkit not connected');
  if (res.status === 503) throw new ConnectorError('server-disabled', 'Connector service disabled');
  // 5xx and anything else → treat as a reachability/server problem.
  throw new ConnectorError('unreachable', `Connector call failed (${res.status})`);
}

/**
 * List the user's connected services. GET /connectors — returns connection rows
 * with NO token material. Throws a typed {@link ConnectorError} on failure.
 */
export async function listConnections(): Promise<ConnectionRow[]> {
  const res = await connectorFetch('/connectors', { method: 'GET' });
  if (!res.ok) await throwForStatus(res);
  const body = await res.json().catch(() => null);
  // AuthKit may return a bare array or wrap it under `connections`; accept both
  // and default to [] rather than handing back a non-array.
  if (Array.isArray(body)) return body as ConnectionRow[];
  const wrapped = (body as { connections?: unknown } | null)?.connections;
  return Array.isArray(wrapped) ? (wrapped as ConnectionRow[]) : [];
}

/**
 * Start (or re-start) a connection for `toolkit`. POST
 * /connectors/{toolkit}/connect → { connection_id, redirect_url, status }.
 * We DO NOT open `redirectUrl` — the caller decides how to surface it (window,
 * shell.openExternal, deep-link, …). Throws a typed {@link ConnectorError}.
 */
export async function startConnection(toolkit: string): Promise<StartedConnection> {
  const res = await connectorFetch(`/connectors/${encodeURIComponent(toolkit)}/connect`, {
    method: 'POST',
  });
  if (!res.ok) await throwForStatus(res);
  const body = await readJson(res);
  return {
    connectionId: String(body.connection_id ?? ''),
    redirectUrl: String(body.redirect_url ?? ''),
    status: String(body.status ?? ''),
  };
}

/**
 * Disconnect `toolkit`. DELETE /connectors/{toolkit}. Also evicts any cached
 * token for that toolkit so a subsequent connectorToken() can't serve a stale
 * secret for a now-severed connection. Throws a typed {@link ConnectorError}.
 */
export async function disconnect(toolkit: string): Promise<void> {
  const res = await connectorFetch(`/connectors/${encodeURIComponent(toolkit)}`, {
    method: 'DELETE',
  });
  // Evict regardless of outcome intent, but only after a successful call decide;
  // do it up front so even a 404 ("already gone") leaves no cached token behind.
  tokenCache.delete(toolkit);
  if (!res.ok) await throwForStatus(res);
}

/**
 * Fetch (or reuse a cached) third-party access token for `toolkit`. GET
 * /connectors/{toolkit}/token — the SERVER-TO-SERVER gate: in addition to the
 * Firebase bearer it requires X-Authkit-Service-Token: <AUTHKIT_SERVICE_TOKEN>.
 *
 * Returns the token payload with `expiresIn` in SECONDS remaining. A cached
 * token is reused until within {@link EXPIRY_SKEW_MS} of expiry, then re-fetched.
 * The payload is SECRET — keep it out of logs, disk, and the renderer.
 *
 * Throws a typed {@link ConnectorError}:
 *   - AUTHKIT_SERVICE_TOKEN unset            → 'service-token-unset'
 *   - Firebase getIdToken() throws / 401 bearer → 'signed-out'
 *   - 401 with a service-token body          → 'service-token-invalid'
 *   - 404                                    → 'not-found'
 *   - 409                                    → 'not-connected' (call startConnection)
 *   - 503                                    → 'server-disabled'
 *   - network / 5xx / contract violation     → 'unreachable'
 */
export async function connectorToken(toolkit: string): Promise<ConnectorTokenPayload> {
  // 0. Serve from cache when comfortably fresh. `expiresIn` is recomputed from
  //    the absolute expiry so a cache hit never reports the stale original TTL.
  const cached = tokenCache.get(toolkit);
  if (cached && Date.now() < cached.expiresAtMs - EXPIRY_SKEW_MS) {
    return {
      accessToken: cached.accessToken,
      refreshToken: cached.refreshToken,
      expiresIn: Math.round((cached.expiresAtMs - Date.now()) / 1000),
      extra: cached.extra,
    };
  }

  // 1. The service secret is REQUIRED for this endpoint. A missing secret is a
  //    config gap, not a transport failure — surface it as its own typed code
  //    (no network call, nothing to log) so the caller can tell "you forgot to
  //    set the secret" apart from "the server rejected it".
  const serviceToken = process.env.AUTHKIT_SERVICE_TOKEN?.trim();
  if (!serviceToken) {
    throw new ConnectorError('service-token-unset', 'AUTHKIT_SERVICE_TOKEN is not set');
  }

  const res = await connectorFetch(`/connectors/${encodeURIComponent(toolkit)}/token`, {
    method: 'GET',
    // The service secret rides ONLY this call — never on list/connect/status/
    // disconnect — and never touches a log line.
    extraHeaders: { 'X-Authkit-Service-Token': serviceToken },
  });
  if (!res.ok) await throwForStatus(res, { onToken: true });

  const body = await readJson(res);
  const accessToken = String(body.access_token ?? '');
  if (!accessToken) {
    // A 200 with no token is a server contract violation — surface as
    // unreachable rather than handing a caller a blank token.
    throw new ConnectorError('unreachable', 'Token response had no access_token');
  }
  const refreshToken =
    typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : undefined;
  const expiresInSec = Number(body.expires_in ?? 0);
  // Fall back to ~1h if AuthKit omits expires_in, so the expiry clock always has
  // a horizon (third-party OAuth access tokens are typically ~1h).
  const ttlMs = expiresInSec > 0 ? expiresInSec * 1000 : 60 * 60 * 1000;
  const expiresAtMs = Date.now() + ttlMs;

  // Everything that isn't the two secrets is non-secret metadata (scope,
  // token_type, …); keep it for callers without ever singling out token fields.
  const extra: Record<string, unknown> = { ...body };
  delete extra.access_token;
  delete extra.refresh_token;

  // Cache in memory only (never disk), keyed by toolkit.
  tokenCache.set(toolkit, { accessToken, refreshToken, extra, expiresAtMs });

  return { accessToken, refreshToken, expiresIn: Math.round(ttlMs / 1000), extra };
}

/** Drop any cached connector token(s). Call on sign-out so a subsequent sign-in
 *  as a different principal never reuses the prior account's third-party tokens.
 *  In-memory only — there is nothing on disk to clear. */
export function clearConnectorTokenCache(): void {
  tokenCache.clear();
}
