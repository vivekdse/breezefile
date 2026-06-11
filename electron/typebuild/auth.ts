// TypeBuild Firebase auth (bead fm-b5at.2).
//
// Email/password sign-in against the SAME Firebase project the TypeBuild
// server verifies — project `vivekpersonal-1607716465302` (see the server's
// app/chromeext_firebase.py and app/mcp_auth.py, which sign in via the
// Identity Toolkit REST API using the project's public web API key). The REST
// path mirrors the server's `signInWithPassword` call; no Firebase SDK is
// needed in the main process.
//
// Token lifecycle:
//   - ID token (~1h TTL) lives in MAIN-PROCESS MEMORY ONLY. Never persisted,
//     never logged.
//   - Refresh token is persisted ENCRYPTED via Electron safeStorage to
//     `userData/typebuild-auth.bin`. On startup, if present, we refresh to
//     restore the session.
//   - getIdToken() auto-refreshes when expired or within ~5min of expiry, and
//     is single-flight so concurrent callers share one refresh round-trip.
//   - On refresh failure (token revoked / disabled account), we drop to the
//     signed-out state, wipe the encrypted file, and notify listeners.
//
// SECURITY: passwords and ID tokens are never written to disk or logged; only
// the refresh token touches disk, and only through safeStorage.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';

// Public web API key + auth domain for the Firebase project the TypeBuild
// server (general.typebuild.com) verifies against. These are the values the
// server reads from FIREBASE_WEB_API_KEY / FIREBASE_AUTH_DOMAIN; the web API
// key is designed to ship in clients (it only gates the unauthenticated
// Identity Toolkit surface — Firebase Auth rules, not this key, are the
// security boundary), so hardcoding it here is the normal pattern.
export const FIREBASE_API_KEY = 'AIzaSyCvfuXXWy81cFM7JU3XwbDx_auIunL-C3c';

const IDENTITY_TOOLKIT_URL =
  'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
const SECURE_TOKEN_URL = 'https://securetoken.googleapis.com/v1/token';

// Refresh proactively when the ID token is within this window of expiry so
// callers never get a token that 401s mid-flight.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export type AuthState = { signedIn: boolean; email?: string };

type Session = {
  idToken: string;
  refreshToken: string;
  email: string;
  // Absolute epoch ms at which the ID token expires.
  expiresAtMs: number;
};

let session: Session | null = null;
// Shared refresh promise so concurrent getIdToken() callers don't each fire a
// securetoken round-trip (single-flight).
let refreshInFlight: Promise<string> | null = null;

const listeners = new Set<(s: AuthState) => void>();

function authFilePath(): string {
  return path.join(app.getPath('userData'), 'typebuild-auth.bin');
}

function currentState(): AuthState {
  return session
    ? { signedIn: true, email: session.email }
    : { signedIn: false };
}

function notify(): void {
  const snapshot = currentState();
  for (const cb of listeners) {
    try {
      cb(snapshot);
    } catch (err) {
      // A listener throwing must not break the others or the auth flow.
      console.warn('[typebuild-auth] listener threw:', (err as Error).message);
    }
  }
}

// ─── Persistence (refresh token only, encrypted) ──────────────────────────

async function persistRefreshToken(refreshToken: string): Promise<void> {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      // No OS keychain backing — refuse to write plaintext. The session still
      // works in-memory for this run; it just won't survive a restart.
      console.warn(
        '[typebuild-auth] safeStorage unavailable; refresh token not persisted',
      );
      return;
    }
    const blob = safeStorage.encryptString(refreshToken);
    await fs.writeFile(authFilePath(), blob, { mode: 0o600 });
  } catch (err) {
    console.warn(
      '[typebuild-auth] failed to persist refresh token:',
      (err as Error).message,
    );
  }
}

async function loadRefreshToken(): Promise<string | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const blob = await fs.readFile(authFilePath());
    const token = safeStorage.decryptString(blob);
    return token || null;
  } catch {
    // Missing file or undecryptable blob — treat as no stored session.
    return null;
  }
}

async function clearRefreshToken(): Promise<void> {
  try {
    await fs.rm(authFilePath(), { force: true });
  } catch (err) {
    console.warn(
      '[typebuild-auth] failed to clear refresh token:',
      (err as Error).message,
    );
  }
}

// ─── REST helpers ──────────────────────────────────────────────────────────

/** Extract a Firebase error code without ever surfacing token material. */
function firebaseError(body: unknown, fallback: string): string {
  const message = (body as { error?: { message?: string } })?.error?.message;
  if (typeof message === 'string' && message) return message;
  return fallback;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Sign in with email + password. On success the ID token is held in memory and
 * the refresh token is persisted (encrypted). Throws an Error whose message is
 * the Firebase error code (e.g. INVALID_LOGIN_CREDENTIALS) on failure.
 */
export async function signIn(email: string, password: string): Promise<AuthState> {
  const res = await fetch(`${IDENTITY_TOOLKIT_URL}?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(firebaseError(data, `sign-in failed (${res.status})`));
  }

  const idToken = String(data.idToken ?? '');
  const refreshToken = String(data.refreshToken ?? '');
  const expiresInSec = Number(data.expiresIn ?? 3600);
  // Firebase echoes the canonical email; prefer it, fall back to the input.
  const resolvedEmail = String(data.email ?? email);
  if (!idToken || !refreshToken) {
    throw new Error('sign-in returned no tokens');
  }

  session = {
    idToken,
    refreshToken,
    email: resolvedEmail,
    expiresAtMs: Date.now() + expiresInSec * 1000,
  };
  await persistRefreshToken(refreshToken);
  notify();
  return currentState();
}

/**
 * Adopt an already-minted Firebase session — used by the browser sign-in flow
 * (browser-signin.ts), which reuses the TypeBuild server's OAuth flow + hosted
 * sign-in page and receives {idToken, refreshToken, email} (firebase_* fields)
 * from the /token response. Stores EXACTLY like signIn() does (memory ID token,
 * encrypted refresh token, listener notify), so everything downstream
 * (getIdToken auto-refresh, restoreSession, mint/chromeext) behaves identically
 * regardless of which provider minted the session — the refresh token is a
 * standard Firebase secure-token refresh token, refreshed via the SAME
 * securetoken.googleapis.com endpoint. Throws on missing tokens.
 */
export async function adoptSession(input: {
  idToken: string;
  refreshToken: string;
  email: string;
  expiresIn?: number;
}): Promise<AuthState> {
  const { idToken, refreshToken } = input;
  if (!idToken || !refreshToken) {
    throw new Error('sign-in returned no tokens');
  }
  const expiresInSec = Number(input.expiresIn || 3600);
  const resolvedEmail = input.email || emailFromIdToken(idToken) || '';

  session = {
    idToken,
    refreshToken,
    email: resolvedEmail,
    expiresAtMs: Date.now() + expiresInSec * 1000,
  };
  await persistRefreshToken(refreshToken);
  notify();
  return currentState();
}

/** Sign out: clears in-memory session and the encrypted refresh-token file. */
export async function signOut(): Promise<void> {
  session = null;
  refreshInFlight = null;
  await clearRefreshToken();
  notify();
}

/**
 * Exchange a refresh token for a fresh ID token via securetoken.googleapis.com.
 * Updates the in-memory session on success. On failure (revoked/disabled),
 * drops to signed-out and rethrows.
 */
async function doRefresh(refreshToken: string, email: string): Promise<string> {
  const res = await fetch(`${SECURE_TOKEN_URL}?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Refresh token revoked / account disabled — drop the session entirely.
    session = null;
    await clearRefreshToken();
    notify();
    throw new Error(firebaseError(data, `token refresh failed (${res.status})`));
  }

  // securetoken returns snake_case (id_token, refresh_token, expires_in).
  const idToken = String(data.id_token ?? '');
  // Firebase may rotate the refresh token; keep whichever it returns.
  const nextRefresh = String(data.refresh_token ?? refreshToken);
  const expiresInSec = Number(data.expires_in ?? 3600);
  if (!idToken) {
    session = null;
    await clearRefreshToken();
    notify();
    throw new Error('token refresh returned no id_token');
  }

  // securetoken doesn't echo the email; when the caller doesn't know it yet
  // (startup restore), backfill from the ID token's claims.
  const resolvedEmail = email || emailFromIdToken(idToken) || '';
  session = {
    idToken,
    refreshToken: nextRefresh,
    email: resolvedEmail,
    expiresAtMs: Date.now() + expiresInSec * 1000,
  };
  if (nextRefresh !== refreshToken) await persistRefreshToken(nextRefresh);
  return idToken;
}

/**
 * Return a valid ID token, refreshing if expired or within ~5min of expiry.
 * Single-flight: concurrent callers share one refresh. Throws if not signed in
 * or if refresh fails.
 */
export async function getIdToken(): Promise<string> {
  if (!session) throw new Error('not signed in');

  const fresh = Date.now() < session.expiresAtMs - REFRESH_SKEW_MS;
  if (fresh) return session.idToken;

  if (refreshInFlight) return refreshInFlight;

  const { refreshToken, email } = session;
  refreshInFlight = doRefresh(refreshToken, email).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export function getAuthState(): AuthState {
  return currentState();
}

/**
 * Subscribe to auth-state changes. Returns an unsubscribe function. The
 * callback is NOT invoked immediately — call getAuthState() for the current
 * value.
 */
export function onAuthStateChanged(cb: (s: AuthState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * On startup, restore a session from the persisted (encrypted) refresh token,
 * if any. Best-effort: failures leave us signed out and never throw. Notifies
 * listeners on success. Call once after app.whenReady().
 */
export async function restoreSession(): Promise<void> {
  if (session) return;
  const refreshToken = await loadRefreshToken();
  if (!refreshToken) return;
  try {
    // doRefresh sets the in-memory session and backfills the email from the
    // ID token's claims (securetoken doesn't echo it).
    await doRefresh(refreshToken, '');
    notify();
  } catch (err) {
    // Revoked / network error — doRefresh already cleared state on HTTP error.
    console.warn(
      '[typebuild-auth] session restore failed:',
      (err as Error).message,
    );
  }
}

/** Decode the email claim from a Firebase ID token (JWT) without verifying. */
function emailFromIdToken(idToken: string): string | null {
  try {
    const payload = idToken.split('.')[1];
    if (!payload) return null;
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const claims = JSON.parse(json) as { email?: string };
    return claims.email ?? null;
  } catch {
    return null;
  }
}
