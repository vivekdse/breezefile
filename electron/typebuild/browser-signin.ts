// TypeBuild browser sign-in — reuse the server's OAuth 2.1 flow + hosted
// sign-in page (bead fm-b5at.11, revised 2026-06-11).
//
// We do NOT implement Google OAuth against accounts.google.com. Instead we
// drive the SAME OAuth 2.1 surface Claude Code uses on the TypeBuild server
// (general.typebuild.com): /register (Dynamic Client Registration), /authorize
// (→ the hosted /mcp-login page, which offers "Sign in with Google" AND
// email/password), and /token (PKCE). The user signs in on the familiar
// TypeBuild page rendered in a small in-app window (NOT the system browser —
// login is required to use the app, so it has to happen inside it); we
// capture the authorization code on a one-shot loopback listener and
// exchange it.
//
//   1. Register (once, cached) a public client via DCR: grant_types
//      [authorization_code, refresh_token], token_endpoint_auth_method none,
//      redirect_uris = the loopback. The server requires those exact grant
//      types and rejects unknown scopes, so we register/authorize with NO
//      scope (verified against the live server).
//   2. Start a single-use http server on 127.0.0.1:<random ephemeral port>,
//      path /callback. 5-minute timeout; first hit wins, then it closes.
//   3. openLoginWindow → /authorize with PKCE (S256) + a `state` nonce and
//      redirect_uri = http://127.0.0.1:<port>/callback, shown in a small
//      modal BrowserWindow. 302 → /mcp-login. Closing the window manually
//      cancels the flow.
//   4. The window redirects back to the loopback with ?code=…; we verify
//      `state` and POST /token (authorization_code + code_verifier +
//      redirect_uri + client_id; no secret — public client).
//   5. The /token response — for the Breezefile client, once the pending
//      server change ships — ALSO carries firebase_id_token,
//      firebase_refresh_token, email. We hand those to auth.adoptSession(), the
//      SAME lifecycle the email/password path uses (memory ID token,
//      safeStorage refresh token; mint/chromeext downstream all unchanged).
//      Until the server change deploys those fields are absent — we detect that
//      and surface a typed {code:'server-pending'} so the UI tells the user to
//      use email & password for now.
//
// SECURITY: the authorization code, PKCE verifier, and any token material are
// SINGLE-USE and never logged or written to disk. The only persisted secret is
// the Firebase refresh token, via auth.ts's existing safeStorage path. The
// registered client_id is NOT a secret (DCR is open) and is cached in plain
// userData JSON to avoid re-registering every sign-in. The listener binds
// 127.0.0.1 ONLY (loopback), never 0.0.0.0.

import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { app, BrowserWindow } from 'electron';

import { adoptSession, type AuthState } from './auth';

// Base URL of the TypeBuild OAuth 2.1 authorization server (issuer + endpoints
// confirmed via /.well-known/oauth-authorization-server).
const SERVER_BASE = 'https://general.typebuild.com';
const REGISTER_URL = `${SERVER_BASE}/register`;
const AUTHORIZE_URL = `${SERVER_BASE}/authorize`;
const TOKEN_URL = `${SERVER_BASE}/token`;

// How long we wait for the user to complete the browser round-trip before
// giving up and tearing the listener down.
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

export type BrowserAuthErrorCode =
  | 'cancelled' // user closed the browser / timed out / aborted
  | 'unreachable' // network failure reaching the TypeBuild server / loopback bind failed
  | 'rejected' // the server refused registration / authorization / the code
  | 'server-pending'; // sign-in worked but the server didn't return firebase_* yet

export class BrowserAuthError extends Error {
  code: BrowserAuthErrorCode;
  constructor(code: BrowserAuthErrorCode, message: string) {
    super(message);
    this.name = 'BrowserAuthError';
    this.code = code;
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

// ─── Cached DCR client_id (NOT a secret) ───────────────────────────────────
//
// Open DCR means a fresh client_id grants nothing — only a successful sign-in
// does — so caching the registered id in plain userData JSON is fine and saves
// a /register round-trip on every sign-in. If the cached id is ever rejected
// by the server we transparently re-register.

function clientCachePath(): string {
  return path.join(app.getPath('userData'), 'typebuild-oauth-client.json');
}

async function loadCachedClientId(): Promise<string | null> {
  try {
    const raw = await fs.readFile(clientCachePath(), 'utf8');
    const data = JSON.parse(raw) as { client_id?: string };
    return data.client_id || null;
  } catch {
    return null;
  }
}

async function saveCachedClientId(clientId: string): Promise<void> {
  try {
    await fs.writeFile(
      clientCachePath(),
      JSON.stringify({ client_id: clientId }),
      { mode: 0o600 },
    );
  } catch {
    // Non-fatal: we just re-register next time.
  }
}

/**
 * Register a public OAuth client for the given loopback redirect via DCR, or
 * return the cached client_id if one exists (re-registering transparently if
 * it's rejected later, in the /authorize step). The server requires grant_types
 * to be exactly [authorization_code, refresh_token] and token_endpoint_auth_method
 * `none`; it rejects unknown scopes, so we register with no scope.
 */
async function registerClient(redirectUri: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(REGISTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // User-facing on the server's consent page — say what the person is
        // actually connecting (the TypeBuild client), not the repo slug.
        client_name: 'TypeBuild',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
  } catch {
    throw new BrowserAuthError('unreachable', "Couldn't reach TypeBuild.");
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new BrowserAuthError(
      'rejected',
      serverErr(data, `client registration failed (${res.status})`),
    );
  }
  const clientId = String(data.client_id ?? '');
  if (!clientId) {
    throw new BrowserAuthError('rejected', 'Server returned no client_id.');
  }
  await saveCachedClientId(clientId);
  return clientId;
}

// ─── In-flight flow control ────────────────────────────────────────────────
//
// Only one browser flow may run at a time. A second start aborts the prior one
// (its listener closes and its promise rejects with `cancelled`), so the UI's
// "Cancel" can just call cancelBrowserSignIn().

let activeFlow: { abort: () => void } | null = null;

/** Abort an in-flight browser flow, if any (idempotent). The pending
 * signInViaBrowser() promise rejects with {code:'cancelled'}. */
export function cancelBrowserSignIn(): void {
  activeFlow?.abort();
}

// The small modal window that shows the hosted TypeBuild sign-in page. Kept
// separate from the heavyweight operator/automation window (electron/browser/) —
// this is just a plain browser view with no split-pane chrome, record, or
// credential-capture machinery attached.
let loginWin: BrowserWindow | null = null;

function closeLoginWindow(): void {
  if (loginWin && !loginWin.isDestroyed()) loginWin.close();
  loginWin = null;
}

/** Show the hosted sign-in page (authUrl) in a small in-app window instead of
 * the system browser. Resolves once the window is showing; the caller's
 * loopback listener (already bound) catches the redirect regardless of which
 * window navigated there. If the user closes the window before completing
 * sign-in, `onClosed` fires so the flow can be cancelled. */
function openLoginWindow(authUrl: string, onClosed: () => void): void {
  closeLoginWindow();
  const win = new BrowserWindow({
    width: 480,
    height: 640,
    title: 'Sign in to TypeBuild',
    autoHideMenuBar: true,
    parent: BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()),
    modal: true,
    webPreferences: {
      // No preload — this is a plain hosted web page, not app chrome.
      sandbox: true,
      contextIsolation: true,
    },
  });
  loginWin = win;
  win.on('closed', () => {
    if (loginWin === win) loginWin = null;
    onClosed();
  });
  void win.loadURL(authUrl);
}

/** Minimal, asset-free HTML shown in the user's browser after the redirect. */
function resultPage(ok: boolean): string {
  const title = ok ? "You're signed in" : 'Sign-in failed';
  const body = ok
    ? "You're signed in — you can return to Breezefile and close this tab."
    : 'Something went wrong. Return to Breezefile and try again.';
  const accent = ok ? '#2e7d32' : '#c62828';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Breezefile</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:#0f1115;color:#e6e6e6}
  .card{max-width:420px;padding:32px 36px;border-radius:12px;background:#181b21;
    box-shadow:0 8px 30px rgba(0,0,0,.4);text-align:center}
  h1{margin:0 0 8px;font-size:20px;color:${accent}}
  p{margin:0;color:#aeb4bd}
</style></head><body>
<div class="card"><h1>${title}</h1><p>${body}</p></div>
</body></html>`;
}

/**
 * Run the full browser sign-in flow against the TypeBuild server and feed the
 * result into the existing Firebase auth lifecycle. Resolves to the new
 * AuthState; rejects with a BrowserAuthError carrying a typed `.code`.
 *
 * Codes: 'cancelled' (timeout / user closed / aborted), 'unreachable' (network
 * / loopback bind), 'rejected' (server refused), 'server-pending' (sign-in
 * succeeded but the server hasn't shipped the firebase_* handoff yet → use
 * email/password for now).
 */
export function signInViaBrowser(): Promise<AuthState> {
  // Starting a new flow supersedes any in-flight one.
  cancelBrowserSignIn();

  // PKCE + CSRF nonce. The verifier and code are single-use and never logged.
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(
    crypto.createHash('sha256').update(codeVerifier).digest(),
  );
  const state = base64url(crypto.randomBytes(16));

  return new Promise<AuthState>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const server = http.createServer();

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // close() stops accepting; the active socket for the in-flight request
      // finishes first. Safe to call repeatedly.
      try {
        server.close();
      } catch {
        // already closing
      }
      closeLoginWindow();
      if (activeFlow && activeFlow.abort === abort) activeFlow = null;
    };

    const fail = (err: BrowserAuthError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const succeed = (st: AuthState) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(st);
    };

    const abort = () => {
      fail(new BrowserAuthError('cancelled', 'Sign-in was cancelled.'));
    };
    activeFlow = { abort };

    server.on('error', () => {
      // Couldn't bind the loopback listener — treat as unreachable so the UI
      // shows a retryable message rather than a silent hang.
      fail(
        new BrowserAuthError(
          'unreachable',
          'Could not start the local sign-in listener.',
        ),
      );
    });

    server.on('request', (req, res) => {
      // Ignore anything that isn't our single callback path (e.g. favicon).
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      const replyAndThen = (ok: boolean, then: () => void) => {
        res.statusCode = ok ? 200 : 400;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(resultPage(ok), then);
      };

      if (error) {
        // The user denied consent, or the server rejected the request.
        replyAndThen(false, () =>
          fail(
            new BrowserAuthError(
              error === 'access_denied' ? 'cancelled' : 'rejected',
              `Sign-in ${error}.`,
            ),
          ),
        );
        return;
      }

      if (!code || returnedState !== state) {
        // Missing code or a state mismatch (possible CSRF) — refuse.
        replyAndThen(false, () =>
          fail(
            new BrowserAuthError('rejected', 'Sign-in response was invalid.'),
          ),
        );
        return;
      }

      // We have a valid code. Show the success page immediately, then do the
      // token exchange. (The browser tab doesn't need to wait on the server.)
      const redirectUri = redirectUriFor(server);
      replyAndThen(true, () => {
        completeExchange(code, codeVerifier, redirectUri)
          .then(succeed)
          .catch((err: unknown) => {
            fail(
              err instanceof BrowserAuthError
                ? err
                : new BrowserAuthError(
                    'rejected',
                    'Could not complete sign-in.',
                  ),
            );
          });
      });
    });

    // Bind to loopback only, OS-assigned ephemeral port. Once bound we know the
    // redirect URI, so we register the client (cached) and open the browser.
    server.listen(0, '127.0.0.1', () => {
      const redirectUri = redirectUriFor(server);

      timer = setTimeout(() => {
        fail(new BrowserAuthError('cancelled', 'Sign-in timed out.'));
      }, FLOW_TIMEOUT_MS);
      // Don't keep the event loop alive on this timer alone.
      if (typeof timer.unref === 'function') timer.unref();

      void (async () => {
        let clientId = await loadCachedClientId();
        try {
          if (!clientId) clientId = await registerClient(redirectUri);
        } catch (err) {
          fail(
            err instanceof BrowserAuthError
              ? err
              : new BrowserAuthError(
                  'unreachable',
                  'Could not register with TypeBuild.',
                ),
          );
          return;
        }
        if (settled) return; // aborted while registering

        const authUrl = new URL(AUTHORIZE_URL);
        // NOTE: no `scope` — the server rejects scopes the client wasn't
        // registered with (verified live), and the MCP flow uses none.
        authUrl.search = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          state,
        }).toString();

        try {
          openLoginWindow(authUrl.toString(), () => {
            // The user closed the sign-in window before completing the flow.
            abort();
          });
        } catch {
          fail(
            new BrowserAuthError(
              'unreachable',
              'Could not open the sign-in window.',
            ),
          );
        }
      })();
    });
  });
}

/** The loopback redirect URI for the bound server. */
function redirectUriFor(server: http.Server): string {
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}/callback`;
}

/**
 * Exchange the authorization code at /token, then adopt the Firebase session
 * the server hands back. Throws BrowserAuthError on any failure.
 *
 * If the cached client_id is rejected (e.g. the server forgot it), re-register
 * once and retry transparently. If the exchange succeeds but the response is
 * missing the firebase_* desktop-handoff fields (server change not yet
 * deployed), throw {code:'server-pending'} so the UI falls back to
 * email/password.
 */
async function completeExchange(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<AuthState> {
  const clientId = (await loadCachedClientId()) ?? '';

  const post = async (cid: string): Promise<Response> => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: cid,
      code_verifier: codeVerifier,
    });
    return fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  };

  let tokenRes: Response;
  try {
    tokenRes = await post(clientId);
  } catch {
    throw new BrowserAuthError('unreachable', "Couldn't reach TypeBuild.");
  }

  const tokenData = (await tokenRes.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!tokenRes.ok) {
    throw new BrowserAuthError(
      'rejected',
      serverErr(tokenData, `token exchange failed (${tokenRes.status})`),
    );
  }

  // The server returns the MCP JWT regardless. For the Breezefile desktop
  // handoff (pending server change) it ALSO carries the Firebase tokens. If
  // they're absent the server hasn't shipped the change yet.
  const idToken = String(tokenData.firebase_id_token ?? '');
  const refreshToken = String(tokenData.firebase_refresh_token ?? '');
  const email = String(tokenData.email ?? '');
  if (!idToken || !refreshToken) {
    throw new BrowserAuthError(
      'server-pending',
      'TypeBuild server update pending — use email & password for now.',
    );
  }

  // Hand off to the shared lifecycle (memory + safeStorage + listeners). The
  // refresh token is a standard Firebase secure-token refresh token, so
  // restoreSession()/getIdToken() refresh it via securetoken.googleapis.com
  // exactly like an email/password session.
  return adoptSession({ idToken, refreshToken, email });
}

/** Extract a terse error code from an OAuth/JSON error body (never tokens). */
function serverErr(body: unknown, fallback: string): string {
  const b = body as {
    error?: string | { message?: string };
    error_description?: string;
  };
  if (b?.error_description) return String(b.error_description);
  if (typeof b?.error === 'object' && b.error?.message) return b.error.message;
  if (typeof b?.error === 'string') return b.error;
  return fallback;
}
