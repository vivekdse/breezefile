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
//
// HEADLESS (breezed) — fm-typebuild-repoint: the token lifecycle (sign-in,
// refresh, single-flight, skew, getIdToken, getAuthState) is Electron-free. The
// only Electron dependency is REFRESH-TOKEN PERSISTENCE, which is hidden behind
// an injectable `CredentialStore`. The default store lazily imports Electron's
// `safeStorage`/`app` (so merely importing this module headlessly never pulls a
// hard `electron` dependency at load time — the import happens on first
// persistence call, which the daemon never makes). The daemon installs a
// memory-only store via `initHeadlessAuth()` / `signInHeadless()`: credentials
// come from env (TYPEBUILD_EMAIL / TYPEBUILD_PASSWORD), the refresh token stays
// in memory only, and a restart re-signs-in from env.

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
  // The Firebase user id (`sub`/`user_id` JWT claim) — immutable per account,
  // opaque, NON-PHI. Used to namespace/segregate per-principal on-disk state
  // (e.g. the encrypted PHI DB). May be '' if the token omitted it.
  principal: string;
  // Absolute epoch ms at which the ID token expires.
  expiresAtMs: number;
};

let session: Session | null = null;
// Shared refresh promise so concurrent getIdToken() callers don't each fire a
// securetoken round-trip (single-flight).
let refreshInFlight: Promise<string> | null = null;

const listeners = new Set<(s: AuthState) => void>();

// ─── Credential store (injectable persistence seam) ───────────────────────
// The ONLY part of this module that needs Electron. The default impl persists
// the refresh token encrypted via safeStorage to userData (GUI behavior,
// unchanged). The headless impl is memory-only (no disk). Both are pure
// async string load/save/clear — the token lifecycle above doesn't care which.

export interface CredentialStore {
  /** Persist the refresh token (encrypted where the impl supports it). */
  save(refreshToken: string): Promise<void>;
  /** Load a previously-persisted refresh token, or null if none. */
  load(): Promise<string | null>;
  /** Drop any persisted refresh token. */
  clear(): Promise<void>;
}

// The Electron safeStorage-backed store. Electron is imported LAZILY (inside
// the methods) so that merely importing auth.ts under a headless runtime
// (breezed) never resolves `electron` at module load — only the GUI app, which
// actually calls these, pulls it in. Mirrors the original behavior exactly:
// refuse to write plaintext when no OS keychain is available; tolerate a
// missing/undecryptable file as "no stored session".
const electronSafeStorageStore: CredentialStore = {
  async save(refreshToken: string): Promise<void> {
    try {
      const { app, safeStorage } = await import('electron');
      const { promises: fs } = await import('node:fs');
      const path = await import('node:path');
      if (!safeStorage.isEncryptionAvailable()) {
        // No OS keychain backing — refuse to write plaintext. The session still
        // works in-memory for this run; it just won't survive a restart.
        console.warn(
          '[typebuild-auth] safeStorage unavailable; refresh token not persisted',
        );
        return;
      }
      const blob = safeStorage.encryptString(refreshToken);
      const file = path.join(app.getPath('userData'), 'typebuild-auth.bin');
      await fs.writeFile(file, blob, { mode: 0o600 });
    } catch (err) {
      console.warn(
        '[typebuild-auth] failed to persist refresh token:',
        (err as Error).message,
      );
    }
  },
  async load(): Promise<string | null> {
    try {
      const { app, safeStorage } = await import('electron');
      const { promises: fs } = await import('node:fs');
      const path = await import('node:path');
      if (!safeStorage.isEncryptionAvailable()) return null;
      const file = path.join(app.getPath('userData'), 'typebuild-auth.bin');
      const blob = await fs.readFile(file);
      const token = safeStorage.decryptString(blob);
      return token || null;
    } catch {
      return null;
    }
  },
  async clear(): Promise<void> {
    try {
      const { app } = await import('electron');
      const { promises: fs } = await import('node:fs');
      const path = await import('node:path');
      const file = path.join(app.getPath('userData'), 'typebuild-auth.bin');
      await fs.rm(file, { force: true });
    } catch (err) {
      console.warn(
        '[typebuild-auth] failed to clear refresh token:',
        (err as Error).message,
      );
    }
  },
};

// Memory-only store for headless breezed: the refresh token is held in module
// memory by the session itself, so persistence is a no-op. A daemon restart
// re-signs-in from the env credentials (signInHeadless), so there is nothing to
// load and nothing to write to a server box's disk in the clear.
const memoryOnlyStore: CredentialStore = {
  async save(): Promise<void> {},
  async load(): Promise<string | null> {
    return null;
  },
  async clear(): Promise<void> {},
};

// The active store. Defaults to the Electron-backed one so GUI behavior is
// identical; the daemon swaps in the memory-only store at startup.
let credentialStore: CredentialStore = electronSafeStorageStore;

/** Override the persistence backend (test seam + headless daemon). */
export function setCredentialStore(store: CredentialStore): void {
  credentialStore = store;
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

// ─── Persistence (refresh token only) ─────────────────────────────────────
// Thin delegators over the active CredentialStore so the token lifecycle below
// is unchanged and store-agnostic.

async function persistRefreshToken(refreshToken: string): Promise<void> {
  await credentialStore.save(refreshToken);
}

async function loadRefreshToken(): Promise<string | null> {
  return credentialStore.load();
}

async function clearRefreshToken(): Promise<void> {
  await credentialStore.clear();
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
    principal: principalFromIdToken(idToken),
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
    principal: principalFromIdToken(idToken),
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
    principal: principalFromIdToken(idToken),
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
 * The signed-in Firebase principal — the immutable `sub`/`user_id` JWT claim,
 * opaque and NON-PHI. Returns '' when signed out or when the token omitted the
 * claim (callers namespacing per-principal state should treat '' as "no stable
 * principal available" and fall back to email or refuse to persist). Never PHI.
 */
export function getPrincipal(): string {
  return session?.principal ?? '';
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

// ─── Headless (breezed) entry points ──────────────────────────────────────

/**
 * Establish a TypeBuild session WITHOUT Electron: installs the memory-only
 * credential store and signs in with email/password. After this resolves,
 * getIdToken() works exactly as in the GUI (in-memory refresh, single-flight,
 * skew). The refresh token is held in module memory only — never disk. A daemon
 * restart calls this again from the env credentials. Throws the Firebase error
 * code on failure (e.g. INVALID_LOGIN_CREDENTIALS), same as signIn().
 */
export async function signInHeadless(
  email: string,
  password: string,
): Promise<AuthState> {
  setCredentialStore(memoryOnlyStore);
  return signIn(email, password);
}

/**
 * Headless startup helper for the daemon: read TYPEBUILD_EMAIL /
 * TYPEBUILD_PASSWORD from the environment and sign in. Returns the resulting
 * AuthState on success, or null when the env credentials are absent (the daemon
 * then runs without the TypeBuild loop rather than crashing). Re-throws on a
 * genuine sign-in failure with creds present, so a misconfigured password is
 * loud rather than silently disabling the loop.
 */
export async function initHeadlessAuth(): Promise<AuthState | null> {
  const email = process.env.TYPEBUILD_EMAIL?.trim();
  const password = process.env.TYPEBUILD_PASSWORD;
  if (!email || !password) return null;
  return signInHeadless(email, password);
}

/** Decode selected claims from a Firebase ID token (JWT) without verifying.
 *  Verification is the server's job; here we only read NON-secret identity
 *  claims (email, sub/user_id) the client already trusts post-refresh. */
function decodeClaims(idToken: string): {
  email?: string;
  sub?: string;
  user_id?: string;
} | null {
  try {
    const payload = idToken.split('.')[1];
    if (!payload) return null;
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    return JSON.parse(json) as { email?: string; sub?: string; user_id?: string };
  } catch {
    return null;
  }
}

/** Decode the email claim from a Firebase ID token (JWT) without verifying. */
function emailFromIdToken(idToken: string): string | null {
  return decodeClaims(idToken)?.email ?? null;
}

/** Decode the immutable principal (Firebase `sub`, `user_id` fallback) from a
 *  Firebase ID token. Returns '' when absent. Opaque, NON-PHI. */
function principalFromIdToken(idToken: string): string {
  const claims = decodeClaims(idToken);
  return claims?.sub || claims?.user_id || '';
}
