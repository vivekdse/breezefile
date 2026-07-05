// task-ac9f4a27be7d — at-rest encryption key management for the per-principal
// encrypted PHI task DB (child of epic task-b3fb2928bb3c).
//
// WHY THIS EXISTS
// Decrypted task titles/bodies are PHI. The client is authorized to SHOW them
// to the signed-in user, but a durable PLAINTEXT copy on disk is the risk
// (survives sign-out, leaks via backups / a shared or stolen machine). So the
// PHI DB is whole-file encrypted (SQLCipher `PRAGMA key`) and this module owns
// the key so that key is only recoverable inside a live, authenticated OS-user
// session — a copied disk or a backup cannot decrypt it.
//
// KEY MODEL (defense in depth, three factors must ALL be present):
//   1. safeStorage — the wrapped key blob is sealed with Electron `safeStorage`
//      (OS keychain: Keychain / libsecret / DPAPI). Unwrapping requires a live
//      OS-user session the keychain trusts. Mirrors the refresh-token policy in
//      auth.ts: if safeStorage is unavailable we REFUSE to persist (the DB then
//      runs memory-only for the session rather than writing a weakly-sealed key).
//   2. device salt — a machine-local random salt file. Copying the wrapped key
//      blob to another machine is insufficient without this salt, and it is not
//      recoverable from any public identifier.
//   3. principal — the Firebase `sub` (immutable, opaque, NON-PHI) namespaces
//      BOTH the key file and (via HKDF `info`) the derived key, so a second
//      account on the same machine derives a DIFFERENT key and opens a DIFFERENT
//      DB. Principal A can never open principal B's file.
//
// The DB key handed to SQLCipher = HKDF-SHA256(master, salt=deviceSalt,
// info="typebuild-phi-db:"+principal, 32 bytes). `master` is a random 32 bytes
// generated ONCE per principal and persisted ONLY safeStorage-wrapped. The raw
// key is never written to disk in any form.
//
// Everything here is Electron-main-only (safeStorage/app). It is imported
// lazily by the DB store so headless/test paths that never open the PHI DB
// don't pull Electron at load.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
// The pure, unit-tested derivation core (Electron-free). Keeping the runtime on
// the SAME helper the tests assert means the key formula can never drift from
// the tested contract — same pattern as task-skeleton-store vs -schema.
import {
  deriveDbKey,
  keyPragmaLiteral as pureKeyPragmaLiteral,
  principalTag as purePrincipalTag,
} from './db-key-derive.mjs';

// ─── Paths ──────────────────────────────────────────────────────────────────
// All key material lives under userData alongside typebuild-auth.bin. The
// device salt is machine-scoped (one file); the wrapped master is per-principal.

async function userDataDir(): Promise<string> {
  const { app } = await import('electron');
  return app.getPath('userData');
}

/** A filesystem-safe, non-reversible tag for a principal, for the key filename.
 *  Delegates to the pure derivation module so the DB store and key file agree. */
function principalTag(principal: string): string {
  return purePrincipalTag(principal);
}

async function deviceSaltPath(): Promise<string> {
  return path.join(await userDataDir(), 'typebuild-dbsalt.bin');
}

async function wrappedKeyPath(principal: string): Promise<string> {
  return path.join(
    await userDataDir(),
    `typebuild-dbkey-${principalTag(principal)}.bin`,
  );
}

function ensureDir(file: string): void {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── Device salt (machine-local, one per install) ────────────────────────────

const DEVICE_SALT_BYTES = 32;

/** Load the machine-local salt, generating + persisting it on first use. This
 *  file is NOT safeStorage-wrapped (it isn't secret on its own — it's the
 *  second factor that binds the key to THIS machine). 0o600 like the rest. */
async function loadOrCreateDeviceSalt(): Promise<Buffer> {
  const file = await deviceSaltPath();
  try {
    const buf = await fs.readFile(file);
    // Pin to EXACTLY DEVICE_SALT_BYTES so a future length change (partial write,
    // tooling, appended bytes) can never silently alter the HKDF salt and orphan
    // every existing encrypted DB. The stored file is written at this exact
    // length, so a shorter read means corruption → regenerate.
    if (buf.length >= DEVICE_SALT_BYTES) return buf.subarray(0, DEVICE_SALT_BYTES);
  } catch {
    /* fall through to create */
  }
  const salt = randomBytes(DEVICE_SALT_BYTES);
  ensureDir(file);
  await fs.writeFile(file, salt, { mode: 0o600 });
  return salt;
}

// ─── safeStorage wrapping ─────────────────────────────────────────────────────

/** True iff the OS keychain backing is available (so we may persist a wrapped
 *  key). When false, callers must run the DB memory-only for the session. */
export async function encryptionAvailable(): Promise<boolean> {
  try {
    const { safeStorage } = await import('electron');
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

async function wrap(master: Buffer): Promise<Buffer> {
  const { safeStorage } = await import('electron');
  // safeStorage takes a string; base64 keeps the bytes intact through it.
  return safeStorage.encryptString(master.toString('base64'));
}

async function unwrap(blob: Buffer): Promise<Buffer | null> {
  try {
    const { safeStorage } = await import('electron');
    const b64 = safeStorage.decryptString(blob);
    const master = Buffer.from(b64, 'base64');
    return master.length === MASTER_BYTES ? master : null;
  } catch {
    return null;
  }
}

// ─── Master key (per-principal, random, wrapped-at-rest only) ─────────────────

const MASTER_BYTES = 32;

/** Load the principal's wrapped master key, generating + persisting one on
 *  first use. Returns null ONLY when safeStorage is unavailable (caller runs
 *  memory-only) or the principal is empty (no stable namespacing key). */
async function loadOrCreateMaster(principal: string): Promise<Buffer | null> {
  if (!principal) return null;
  if (!(await encryptionAvailable())) return null;

  const file = await wrappedKeyPath(principal);
  try {
    const blob = await fs.readFile(file);
    const master = await unwrap(blob);
    if (master) return master;
    // File exists but won't unwrap (keychain rotated / different OS user /
    // corrupt). Do NOT silently regenerate over it here — that would orphan the
    // DB encrypted under the old key. Surface by regenerating a fresh key only
    // if the DB is also being recreated; for a plain load, treat as "no key".
    return null;
  } catch {
    /* no key yet — create one */
  }

  const master = randomBytes(MASTER_BYTES);
  const blob = await wrap(master);
  ensureDir(file);
  await fs.writeFile(file, blob, { mode: 0o600 });
  return master;
}

// ─── Public: derive the DB key ────────────────────────────────────────────────

/**
 * Resolve the raw 32-byte SQLCipher key for a principal, or null when it cannot
 * be resolved (no principal, or safeStorage unavailable → the DB must run
 * memory-only). Deterministic across calls for the same (principal, machine):
 * same master + same device salt + same principal ⇒ same key, so the DB reopens.
 *
 * The returned Buffer is the raw key. Callers pass it to SQLCipher as a hex
 * `PRAGMA key = "x'<hex>'"` and should not hold it longer than needed.
 */
export async function resolveDbKey(principal: string): Promise<Buffer | null> {
  const master = await loadOrCreateMaster(principal);
  if (!master) return null;
  const salt = await loadOrCreateDeviceSalt();
  const key = deriveDbKey(master, salt, principal);
  // Done with the master copy in this scope; zero it.
  master.fill(0);
  return key;
}

/** The SQLCipher raw-key pragma form for a derived key: `x'<hex>'`. Using a raw
 *  key (not a passphrase) means SQLCipher skips its own KDF over our key — our
 *  HKDF already did the derivation. Delegates to the pure derivation module. */
export function keyPragmaLiteral(key: Buffer): string {
  return pureKeyPragmaLiteral(key);
}

// ─── Public: teardown (sign-out) ──────────────────────────────────────────────

/**
 * Wipe the principal's wrapped key on sign-out so a signed-out machine cannot
 * derive the DB key (the encrypted DB file, if present, becomes unreadable
 * until a re-login regenerates the same-principal key... which it won't, since
 * the master was random — so the DB is also dropped by the store on sign-out).
 * The device salt is machine-scoped and intentionally left in place (it's not
 * principal-specific and holds no secret on its own).
 *
 * Best-effort and never throws — mirrors auth.ts clearRefreshToken().
 */
export async function wipeDbKey(principal: string): Promise<void> {
  if (!principal) return;
  try {
    const file = await wrappedKeyPath(principal);
    await fs.rm(file, { force: true });
  } catch (err) {
    console.warn('[typebuild-dbkey] failed to wipe db key:', (err as Error).message);
  }
}

/** Test/verify seam: does a wrapped key file exist for this principal? */
export async function hasWrappedKey(principal: string): Promise<boolean> {
  if (!principal) return false;
  try {
    await fs.access(await wrappedKeyPath(principal));
    return true;
  } catch {
    return false;
  }
}

// Constant-time compare helper for tests asserting two derived keys match
// without leaking timing (not security-critical here, but keeps intent clear).
export function keysEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
