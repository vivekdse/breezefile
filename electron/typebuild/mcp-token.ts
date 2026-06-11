// TypeBuild MCP token mint (fm-b5at.9).
//
// Exchanges Breeze's Firebase ID token for a short-lived MCP JWT that an
// embedded claude session injects as a static Authorization header, so the
// session starts ALREADY authenticated — no /mcp OAuth popup, no MCP install.
//
// This is the RFC 8693-style token exchange against the deployed endpoint
//   POST https://general.typebuild.com/mcp-token
//   Authorization: Bearer <Firebase ID token>
//   body (optional): { device_name }
//   200 → { access_token, token_type, expires_in }   (expires_in in seconds)
// Errors are structured JSON:
//   401 invalid_request — no/malformed bearer
//   401 invalid_token   — Firebase token rejected (re-run sign-in)
//   403 access_denied   — account disabled / revoked
//
// WHY mint-at-launch (not at sign-in): the MCP token is short-lived and is the
// session's only auth — with a static header there is NO in-session OAuth
// fallback (a rejected header = a dead MCP server reported opaquely on first
// tool use). Minting just-in-time means the token is seconds old at spawn, so
// "session starts with expired auth" is structurally impossible, and the mint
// call doubles as a reachability + identity preflight that GATES the spawn.
//
// SECURITY/PHI: the minted token is NEVER logged, persisted, or returned to the
// renderer. It is handed to exactly one caller (the source) which puts it in
// the PTY env and nowhere else. We log only terse, token-free status.

import { hostname } from 'node:os';
import { getIdToken, signOut } from './auth';

const MINT_URL = 'https://general.typebuild.com/mcp-token';
// A stable, content-free device label. Server stores this for audit; it is not
// PHI and carries no token material. Including the hostname lets the audit log
// distinguish which of the user's devices minted each session token.
const DEVICE_NAME = `breezefile (${hostname()})`;

/** A minted MCP token plus its absolute expiry. The token is secret — keep it
 *  out of logs, disk, and the renderer. */
export type MintedMcpToken = {
  accessToken: string;
  /** Epoch ms at which the token expires (derived from expires_in). */
  expiresAt: number;
};

/** Typed mint failure. The renderer maps `code` to one of the three in-app
 *  messages; `message` is a terse, token-free fallback. */
export type MintErrorCode = 'signed-out' | 'unreachable' | 'access-denied';

// IPC strips custom Error properties — only `.message` survives the main →
// renderer hop. So we ENCODE the typed code into the message with a stable,
// machine-parsable prefix the renderer regexes out (see TasksPage). The human
// part follows the prefix for logs / power users.
const MINT_ERR_PREFIX = 'typebuild-mint';

export class McpTokenError extends Error {
  readonly code: MintErrorCode;
  constructor(code: MintErrorCode, detail: string) {
    super(`[${MINT_ERR_PREFIX}:${code}] ${detail}`);
    this.name = 'McpTokenError';
    this.code = code;
  }
}

/**
 * Mint a fresh MCP token for an embedded session. Gets a current Firebase ID
 * token (auto-refreshing via auth.ts), exchanges it, and returns the token +
 * absolute expiry. Throws a typed {@link McpTokenError} on any failure:
 *
 *   - Firebase getIdToken() throws ('not signed in' / refresh failed) → 'signed-out'
 *   - 401 (invalid_request / invalid_token)                           → 'signed-out'
 *       (a 401 invalid_token means the Firebase token was rejected, so we also
 *        force the auth state to signed-out — the Settings panel then shows
 *        sign-in, matching the bead's "Please sign in again" requirement)
 *   - network error / 5xx                                              → 'unreachable'
 *   - 403 access_denied                                               → 'access-denied'
 */
export async function mintMcpToken(): Promise<MintedMcpToken> {
  // 1. Fresh Firebase ID token. getIdToken auto-refreshes and, on refresh
  //    failure (revoked / disabled), already drops to signed-out. Any throw
  //    here means we have no valid identity → signed-out.
  let idToken: string;
  try {
    idToken = await getIdToken();
  } catch {
    throw new McpTokenError('signed-out', 'Firebase sign-in required');
  }

  // 2. Exchange it. A network/transport failure (DNS, offline, TLS) throws from
  //    fetch → unreachable.
  let res: Response;
  try {
    res = await fetch(MINT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ device_name: DEVICE_NAME }),
    });
  } catch {
    throw new McpTokenError('unreachable', 'Could not reach the mint endpoint');
  }

  if (!res.ok) {
    // Parse the structured error (token-free). We branch on HTTP status +
    // the RFC 8693 `error` code; never on token material.
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
      throw new McpTokenError('signed-out', 'Firebase token rejected');
    }
    if (res.status === 403) {
      // access_denied — account disabled / revoked. Not recoverable by the
      // user; they need an admin.
      throw new McpTokenError('access-denied', 'Access denied');
    }
    // 5xx and anything else → treat as a reachability/server problem.
    throw new McpTokenError('unreachable', `Mint failed (${res.status})`);
  }

  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
  };
  const accessToken = String(data.access_token ?? '');
  if (!accessToken) {
    // A 200 with no token is a server contract violation — surface as
    // unreachable rather than spawning with a blank header.
    throw new McpTokenError('unreachable', 'Mint returned no token');
  }
  const expiresInSec = Number(data.expires_in ?? 0);
  // Fall back to ~8h if the server omits expires_in, so the expiry clock
  // (fm-b5at.10) always has a horizon to work with.
  const ttlMs = expiresInSec > 0 ? expiresInSec * 1000 : 8 * 60 * 60 * 1000;

  return { accessToken, expiresAt: Date.now() + ttlMs };
}
