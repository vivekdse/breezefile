// Short-lived bearer tokens for `remote-attach` terminal sessions.
//
// Minted in-process by the term:spawn handler (electron/ipc.ts) when it
// opens a remote-attach shell, accepted by the api-server's authorized()
// alongside the primary token, and revoked when the pty exits. The token
// only ever travels down the reverse-ssh tunnel as an env var — it is
// never written to disk and never leaves the local machine + that tunnel.

import crypto from 'node:crypto';

export type SessionToken = {
  sid: string;
  token: string;
  expiresAt: number;
  label?: string;
};

const sessionTokens = new Map<string, SessionToken>();

export function mintSessionToken(label: string | undefined, ttlSec: number): SessionToken {
  const sid = crypto.randomUUID();
  const entry: SessionToken = {
    sid,
    token: crypto.randomBytes(24).toString('base64url'),
    expiresAt: Date.now() + ttlSec * 1000,
    ...(label ? { label } : {}),
  };
  sessionTokens.set(sid, entry);
  return entry;
}

export function revokeSessionToken(sid: string): void {
  sessionTokens.delete(sid);
}

export function clearSessionTokens(): void {
  sessionTokens.clear();
}

function sweep(now = Date.now()): void {
  for (const [sid, e] of sessionTokens) {
    if (e.expiresAt <= now) sessionTokens.delete(sid);
  }
}

/** True if `supplied` matches a live (non-expired) session token.
 *  Constant-time per candidate; the map is expected to hold at most a
 *  handful of entries. */
export function matchesSessionToken(supplied: string): boolean {
  sweep();
  for (const e of sessionTokens.values()) {
    if (
      supplied.length === e.token.length &&
      crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(e.token))
    ) {
      return true;
    }
  }
  return false;
}
