// Scheduling access-token mint (task-3ea20f1dd70e).
//
// scheduling.typebuild.com is a PURE resource server: it verifies the bearer's
// `aud`/`scope` and mints nothing itself. Its gates require
//   aud == https://scheduling.typebuild.com/mcp
// so the client must obtain an access token AUDIENCED for scheduling. The
// existing mint in mcp-token.ts targets general.typebuild.com and sends NO
// audience/resource param (body is `{ device_name }` only), so its token is
// scoped to TypeBuild's own MCP surface and scheduling rejects it. See
// docs/scheduling-auth.md §4 for the full gap analysis.
//
// This module closes that gap: it exchanges Breeze's Firebase ID token at the
// CENTRAL authorization server (auth.typebuild.com — NOT general.typebuild.com)
// for a scheduling-audienced access token, using an RFC 8707 `resource`
// indicator to request that audience.
//
// CONTRACT (probed 2026-07-12, unauthenticated — see docs/scheduling-auth.md §4):
//   POST https://auth.typebuild.com/mcp-token
//   Authorization: Bearer <Firebase ID token>
//   Content-Type: application/json
//   body: { resource: "https://scheduling.typebuild.com/mcp" }   (RFC 8707)
//   200 → { access_token, token_type, expires_in }   (expires_in in seconds)
// Errors mirror general.typebuild.com/mcp-token (verified identical shape):
//   401 invalid_request — no/malformed bearer ("Send the Firebase ID token…")
//   401 invalid_token   — Firebase token rejected ("Sign in again.")
//   403 access_denied   — account lacks the scheduling:* permission the
//                         `resource` implies / is disabled
// The AS `.well-known/oauth-authorization-server` is live (issuer
// https://auth.typebuild.com/); the endpoint answers 401 to an unauthenticated
// POST, i.e. it is mounted and validates the Firebase bearer BEFORE the body,
// so an unauthenticated probe can confirm reachability but not that a valid
// token yields an `aud`-stamped access token — that needs a live session
// (see the file footer + the report for this task).
//
// SECURITY/PHI: the minted access token is a secret. It is held in MEMORY ONLY
// (the cache below), NEVER persisted to disk, logged, or handed to the renderer.
// We log only terse, token-free status. This mirrors mcp-token.ts's discipline.

import { getIdToken, signOut } from './auth';
import { fetchWithTimeout } from './http';

// The central authorization server that mints scoped access tokens. NOT
// general.typebuild.com — that endpoint is TypeBuild-MCP-scoped by design and
// ignores the audience the resource server checks (docs/scheduling-auth.md §4).
const MINT_URL = 'https://auth.typebuild.com/mcp-token';

// The scheduling resource server's audience. scheduling.typebuild.com's gates
// enforce `aud == this`; we pass it as the RFC 8707 `resource` indicator so the
// AS stamps the access token's `aud` claim accordingly. Kept as a named const
// so the one canonical audience string lives in exactly one place.
export const SCHEDULING_RESOURCE = 'https://scheduling.typebuild.com/mcp';

// Re-mint when the cached token is within this window of expiry. A scheduling
// call must never start with a token that expires mid-flight; 60s of slack
// covers request latency plus modest clock skew. (mcp-token.ts uses no cache —
// it mints just-in-time per spawn — but scheduling calls can fan out, so a
// short-lived per-resource cache avoids a mint round-trip on every call while
// keeping the "seconds-fresh, never stale" guarantee.)
const EXPIRY_SKEW_MS = 60 * 1000;

/** A minted scheduling access token. `expiresIn` is SECONDS REMAINING at the
 *  moment of return (recomputed when served from cache, so it never reports the
 *  stale original TTL). The token is secret — keep it out of logs, disk, and the
 *  renderer. */
export type SchedulingToken = {
  accessToken: string;
  /** The `token_type` the AS returned (normally "Bearer"). */
  tokenType: string;
  /** Seconds until the token expires, as of return time. */
  expiresIn: number;
};

/** Typed mint failure, code-mirroring mcp-token.ts so a caller can branch on a
 *  machine code rather than parse prose. `message` is a terse, token-free
 *  fallback. */
export type SchedulingTokenErrorCode =
  | 'signed-out'
  | 'unreachable'
  | 'access-denied';

// IPC strips custom Error properties — only `.message` survives the main →
// renderer hop — so, exactly as mcp-token.ts does, we ENCODE the typed code into
// the message with a stable, machine-parsable prefix the renderer can regex out.
// The human part follows the prefix for logs / power users.
const MINT_ERR_PREFIX = 'typebuild-scheduling-mint';

export class SchedulingTokenError extends Error {
  readonly code: SchedulingTokenErrorCode;
  constructor(code: SchedulingTokenErrorCode, detail: string) {
    super(`[${MINT_ERR_PREFIX}:${code}] ${detail}`);
    this.name = 'SchedulingTokenError';
    this.code = code;
  }
}

// In-memory, per-resource cache. Held in module memory ONLY — never persisted
// (the token is a secret and, per docs/scheduling-auth.md §6, an AS access token
// has no client-side refresh path: you re-EXCHANGE the Firebase ID token, you do
// not refresh the opaque access token). Keyed by resource so a future second
// audience gets its own slot without cross-contamination.
type CacheEntry = { accessToken: string; tokenType: string; expiresAtMs: number };
const cache = new Map<string, CacheEntry>();

/**
 * Mint (or reuse a cached) scheduling-audienced access token. Gets a current
 * Firebase ID token (auto-refreshing via auth.ts), exchanges it at the AS with
 * an RFC 8707 `resource` indicator, and returns the token + its type + seconds
 * to expiry. A cached token is reused until it is within {@link EXPIRY_SKEW_MS}
 * of expiry, at which point it is re-minted. Throws a typed
 * {@link SchedulingTokenError} on any failure, mirroring mcp-token.ts:
 *
 *   - Firebase getIdToken() throws ('not signed in' / refresh failed) → 'signed-out'
 *   - 401 (invalid_request / invalid_token)                           → 'signed-out'
 *       (invalid_token means the Firebase token was rejected, so we also force
 *        the auth state to signed-out — Settings then shows the sign-in form)
 *   - 403 access_denied                                               → 'access-denied'
 *   - network error / 5xx / contract violation                        → 'unreachable'
 *
 * @param resource The RFC 8707 resource indicator / audience to mint for.
 *   Defaults to {@link SCHEDULING_RESOURCE}; parameterized so the cache and the
 *   AS request stay in lockstep on the same string.
 */
export async function mintSchedulingToken(
  resource: string = SCHEDULING_RESOURCE,
): Promise<SchedulingToken> {
  // 0. Serve from cache when the token is comfortably fresh. `expiresIn` is
  //    recomputed from the absolute expiry so a cached hit never reports the
  //    stale original TTL.
  const cached = cache.get(resource);
  if (cached && Date.now() < cached.expiresAtMs - EXPIRY_SKEW_MS) {
    return {
      accessToken: cached.accessToken,
      tokenType: cached.tokenType,
      expiresIn: Math.round((cached.expiresAtMs - Date.now()) / 1000),
    };
  }

  // 1. Fresh Firebase ID token. getIdToken auto-refreshes and, on refresh
  //    failure (revoked / disabled), already drops to signed-out. Any throw
  //    here means we have no valid identity → signed-out.
  let idToken: string;
  try {
    idToken = await getIdToken();
  } catch {
    throw new SchedulingTokenError('signed-out', 'Firebase sign-in required');
  }

  // 2. Exchange it. A network/transport failure (DNS, offline, TLS, or the
  //    fail-fast timeout in http.ts) throws from fetch → unreachable.
  let res: Response;
  try {
    res = await fetchWithTimeout(MINT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      // RFC 8707 resource indicator: asks the AS to audience the token for the
      // scheduling resource server. No `device_name` here — that field is the
      // general.typebuild.com endpoint's audit label; the AS keys off `resource`.
      body: JSON.stringify({ resource }),
    });
  } catch {
    throw new SchedulingTokenError('unreachable', 'Could not reach the mint endpoint');
  }

  if (!res.ok) {
    // Parse the structured error (token-free). Branch on HTTP status + the
    // RFC 6749 `error` code; never on token material.
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    const code = typeof err.error === 'string' ? err.error : '';

    if (res.status === 401) {
      // invalid_request (no bearer — shouldn't happen, we always send one) or
      // invalid_token (Firebase token rejected). Either way the only recovery
      // is a fresh sign-in. For invalid_token, also flip auth to signed-out so
      // the Settings panel surfaces the sign-in form.
      if (code === 'invalid_token') {
        try {
          await signOut();
        } catch {
          // signOut is best-effort; the typed error below still drives the UI.
        }
      }
      throw new SchedulingTokenError('signed-out', 'Firebase token rejected');
    }
    if (res.status === 403) {
      // access_denied — the account lacks the scheduling:* permission the
      // `resource` implies, or is disabled. Not user-recoverable; needs an admin.
      throw new SchedulingTokenError('access-denied', 'Access denied');
    }
    // 5xx and anything else → treat as a reachability/server problem.
    throw new SchedulingTokenError('unreachable', `Mint failed (${res.status})`);
  }

  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
  };
  const accessToken = String(data.access_token ?? '');
  if (!accessToken) {
    // A 200 with no token is a server contract violation — surface as
    // unreachable rather than handing a caller a blank bearer.
    throw new SchedulingTokenError('unreachable', 'Mint returned no token');
  }
  // Default to "Bearer" if the AS omits token_type — that's how scheduling's
  // gate reads the Authorization header regardless.
  const tokenType = String(data.token_type || 'Bearer');
  const expiresInSec = Number(data.expires_in ?? 0);
  // Fall back to ~8h if the server omits expires_in, matching mcp-token.ts so the
  // expiry clock always has a horizon to work with.
  const ttlMs = expiresInSec > 0 ? expiresInSec * 1000 : 8 * 60 * 60 * 1000;
  const expiresAtMs = Date.now() + ttlMs;

  // Cache in memory only (never disk) so fanned-out scheduling calls reuse one
  // mint until the token nears expiry.
  cache.set(resource, { accessToken, tokenType, expiresAtMs });

  return { accessToken, tokenType, expiresIn: Math.round(ttlMs / 1000) };
}

/** Drop any cached scheduling token(s). Call on sign-out so a subsequent
 *  sign-in as a different principal never reuses the prior account's token.
 *  In-memory only — there is nothing on disk to clear. */
export function clearSchedulingTokenCache(): void {
  cache.clear();
}
