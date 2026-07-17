// task-ac9f4a27be7d — ENCRYPTED, per-principal store for the PHI layer of the
// TypeBuild task cache (child of epic task-b3fb2928bb3c). The companion to the
// PHI-FREE task-skeleton-store: the skeleton persists routing metadata in the
// clear (it's NON-PHI and drives order/filter/counts); THIS store persists the
// PHI-tier payload — task `title`/`body`/`notes`, PLUS (task-780730a010a2) the
// resolved CLASS-1 (per-task data-bag) and CLASS-2 (user vault field) values
// task-data.ts's fill-time resolver reads through — in a whole-file-encrypted
// SQLCipher DB so Home shows real titles instantly on cold start WITHOUT a
// durable plaintext PHI copy on disk.
//
// SECURITY MODEL (see db-key.ts for the full rationale):
//   - The DB file is encrypted via SQLCipher `PRAGMA key` with a raw 32-byte key
//     derived (HKDF) from a per-principal safeStorage-wrapped master + a
//     machine-local salt. The key is only resolvable inside a live, authenticated
//     OS-user session; a copied file or backup is undecryptable.
//   - The DB is NAMESPACED per principal (filename carries the principal tag AND
//     the key is principal-bound), so principal A never opens principal B's DB.
//   - On sign-out the store drops its rows AND the wrapped key is wiped
//     (db-key.wipeDbKey), and since the master was random, the file can never be
//     decrypted again — a defense-in-depth belt on top of the row wipe.
//   - If safeStorage is unavailable (no OS keychain) we refuse to open an
//     encrypted file and run MEMORY-ONLY for the session, mirroring the
//     refresh-token policy in auth.ts. Home then falls back to the skeleton's
//     opaque-id placeholders until the first network pull layers titles in memory.
//
// This module is Electron-main-only (via db-key). It is imported lazily by the
// source so non-GUI paths that never open the PHI DB don't pull it in.

import path from 'node:path';
import { stateDir } from '../core/profile.mjs';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
// The SQLCipher-backed, drop-in fork of better-sqlite3 (same synchronous API,
// adds PRAGMA key). ONLY this store uses it; the three NON-PHI DBs stay on stock
// better-sqlite3. Isolated to this one import so the encrypted-driver dependency
// has a single site.
import Database from 'better-sqlite3-multiple-ciphers';
import { resolveDbKey, keyPragmaLiteral, encryptionAvailable } from '../typebuild/db-key';
import { principalTag } from '../typebuild/db-key-derive.mjs';
// task-fe9e4c4cda44 — the shared DDL + column allow-list (also imported by the
// on-disk no-plaintext-PHI test so store + test build byte-identical tables).
// The SKELETON-vs-PHI two-store decision is documented in that module's header.
import {
  PHI_TABLE_SQL,
  PHI_MIGRATION_COLUMNS,
  DATA_CACHE_TABLE_SQL,
  VAULT_CACHE_TABLE_SQL,
} from './task-phi-schema.mjs';

// The PHI projection we persist: id + the two PHI fields, PLUS the NON-PHI
// sync-metadata (task-fe9e4c4cda44) carried on every row. `title` comes from the
// list pull; `body` is the decrypted detail (mapped into SourcedTask.notes).
// `serverUpdatedAt` is the server's ISO updated_at; `localUpdatedAt` is when we
// last wrote locally; `syncState`/`origin` mark provenance (read path always
// writes 'synced'/'server' — 'pending'/'local' belong to the out-of-scope
// optimistic-write queue, task-a606864378cb).
export type PhiRow = {
  id: string;
  title: string | null;
  body: string | null;
  serverUpdatedAt?: string | null;
  localUpdatedAt?: number | null;
  syncState?: string;
  origin?: string;
};

// A single principal's open encrypted DB. We hold at most one open DB at a time
// (the signed-in principal's). Switching principals closes the old one.
type OpenDb = {
  principal: string;
  db: InstanceType<typeof Database>;
};

let current: OpenDb | null = null;
// When encryption is unavailable we degrade to an in-memory map for the session
// so titles at least persist across a re-render (never across a restart, and
// never to disk). Keyed by id.
//
// INVARIANT (review fix): this is ALWAYS a Map once any open() attempt has been
// made — even the encrypted path leaves it non-null-until-success so a write
// that races an in-flight open() lands in memory instead of being silently
// dropped, then gets flushed into the DB when open() succeeds. It is only reset
// to null on sign-out (clearPhi). See ensureFallback().
let memoryFallback: Map<string, PhiRow> | null = null;
// In-flight open() promise, so concurrent openForPrincipal calls for the same
// principal share ONE open (no double-Database / leaked handle). Cleared when
// the open resolves.
let openInFlight: Promise<InstanceType<typeof Database> | null> | null = null;

function dbDir(): string {
  return stateDir();
}

function dbPath(principal: string): string {
  return path.join(dbDir(), `typebuild-phi-${principalTag(principal)}.db`);
}

function ensureDir(): void {
  const dir = dbDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Ensure the memory fallback map exists so a put*() that runs while open() is
 *  still resolving lands SOMEWHERE (memory) instead of no-op'ing into the void.
 *  On a successful encrypted open, any rows collected here are flushed to the DB
 *  and the map is dropped. */
function ensureFallback(): Map<string, PhiRow> {
  memoryFallback = memoryFallback ?? new Map();
  return memoryFallback;
}

/** Remove the encrypted DB file (and WAL/shm siblings) for a principal. Used
 *  both on sign-out and to reap an orphaned file we can no longer decrypt. */
function removeDbFile(principal: string): void {
  const p = dbPath(principal);
  try {
    rmSync(p, { force: true });
    rmSync(p + '-wal', { force: true });
    rmSync(p + '-shm', { force: true });
  } catch {
    /* ignore */
  }
}

const SCHEMA_SQL = PHI_TABLE_SQL;

// task-fe9e4c4cda44 — additive migration for a pre-existing Phase-1 task_phi
// (id/title/body only). Add any sync-metadata column the live table is missing;
// a fresh DB already has them from PHI_TABLE_SQL, so this is a no-op there. Runs
// inside the open() try/catch so a migration hiccup degrades to memory-only
// rather than crashing sign-in.
function migratePhi(db: InstanceType<typeof Database>): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(task_phi)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  for (const col of PHI_MIGRATION_COLUMNS) {
    if (!existing.has(col.name)) {
      db.exec(`ALTER TABLE task_phi ADD COLUMN ${col.spec}`);
    }
  }
}

// ─── Open / key ──────────────────────────────────────────────────────────────

/**
 * Open (or reuse) the encrypted PHI DB for `principal`. Returns null when the
 * store must run memory-only (no principal, or safeStorage unavailable, or the
 * key can't be resolved). Idempotent for the same principal; switching principals
 * closes the previous DB first so two accounts never share a handle.
 *
 * This is async because key resolution touches safeStorage/userData. Callers
 * that need a sync handle should have awaited a prior open() at sign-in.
 */
async function open(principal: string): Promise<InstanceType<typeof Database> | null> {
  if (!principal) return null;
  if (current && current.principal === principal) return current.db;
  // Concurrent open() for the same principal share ONE open, so we never
  // construct two Database handles for the same file (leak / Windows EBUSY).
  if (openInFlight) return openInFlight;
  openInFlight = doOpen(principal).finally(() => {
    openInFlight = null;
  });
  return openInFlight;
}

async function doOpen(
  principal: string,
): Promise<InstanceType<typeof Database> | null> {
  // Different principal currently open — tear it down first.
  if (current && current.principal !== principal) closeCurrent();

  // Make the fallback exist NOW (before any await) so a put*() that races this
  // open lands in memory instead of being dropped; on success we flush it below.
  ensureFallback();

  if (!(await encryptionAvailable())) {
    // No OS keychain — memory-only for the session (already ensured above).
    return null;
  }

  const key = await resolveDbKey(principal);
  if (!key) {
    // Wrapped key won't resolve (keychain rotated / different OS user). The
    // existing encrypted file (if any) is now undecryptable and orphaned — reap
    // it so dead ciphertext doesn't accumulate across keychain rotations. Then
    // run memory-only for the session.
    removeDbFile(principal);
    return null;
  }

  ensureDir();
  const db = new Database(dbPath(principal));
  try {
    // Raw-key form: SQLCipher uses our HKDF-derived bytes directly (no second
    // KDF). MUST be the first statement on the connection, before any read.
    db.pragma(`key = "${keyPragmaLiteral(key)}"`);
    db.pragma('journal_mode = WAL');
    // Touch the DB to force the key to be validated NOW (a wrong key throws
    // "file is not a database" here rather than at first query).
    db.exec(SCHEMA_SQL);
    // task-780730a010a2 — the task-data value cache tables. CREATE IF NOT
    // EXISTS, so an existing encrypted DB gains them on first open with no
    // migration step (they're new tables, not new columns on task_phi).
    db.exec(DATA_CACHE_TABLE_SQL);
    db.exec(VAULT_CACHE_TABLE_SQL);
    // task-fe9e4c4cda44 — bring a legacy (id/title/body-only) table up to the
    // current sync-metadata schema before the first read/write.
    migratePhi(db);
    db.prepare('SELECT count(*) FROM task_phi').get();
  } catch (e) {
    // Wrong key / corrupt / opened plaintext-by-mistake. Close and degrade to
    // memory-only rather than crash sign-in. PHI-free log.
    console.warn('[typebuild-phi] encrypted DB open failed:', (e as Error).message);
    try {
      db.close();
    } catch {
      /* ignore */
    }
    return null;
  } finally {
    // Zero our copy of the key material promptly.
    key.fill(0);
  }

  current = { principal, db };
  // Flush any rows collected in the fallback while open() was resolving (the
  // race window) into the encrypted DB, then drop the fallback.
  const pending = memoryFallback;
  memoryFallback = null;
  if (pending && pending.size > 0) {
    try {
      const stmt = db.prepare(PHI_UPSERT_SQL);
      const txn = db.transaction((rows: PhiRow[]) => {
        for (const r of rows) stmt.run(upsertParams(r));
      });
      txn([...pending.values()]);
    } catch (e) {
      console.warn('[typebuild-phi] fallback flush failed:', (e as Error).message);
    }
  }
  return db;
}

// task-fe9e4c4cda44 — ONE upsert used by every writer + the fallback flush, so
// the title/body COALESCE-preserve semantics and the sync-metadata stamping can
// never drift between paths. title/body are COALESCE'd (a title-only write never
// wipes a stored body and vice-versa); the sync-metadata is refreshed on EVERY
// write (server_updated_at keeps its last-known value when the writer doesn't
// carry one; local_updated_at/sync_state/origin always take the incoming value).
const PHI_UPSERT_SQL = `
  INSERT INTO task_phi (id, title, body, server_updated_at, local_updated_at, sync_state, origin)
  VALUES (@id, @title, @body, @server_updated_at, @local_updated_at, @sync_state, @origin)
  ON CONFLICT(id) DO UPDATE SET
    title = COALESCE(excluded.title, task_phi.title),
    body  = COALESCE(excluded.body,  task_phi.body),
    server_updated_at = COALESCE(excluded.server_updated_at, task_phi.server_updated_at),
    local_updated_at  = excluded.local_updated_at,
    sync_state = excluded.sync_state,
    origin = excluded.origin
`;

function upsertParams(r: PhiRow): Record<string, unknown> {
  return {
    id: r.id,
    title: r.title ?? null,
    body: r.body ?? null,
    server_updated_at: r.serverUpdatedAt ?? null,
    local_updated_at: r.localUpdatedAt ?? Date.now(),
    sync_state: r.syncState ?? 'synced',
    origin: r.origin ?? 'server',
  };
}

// Columns loadPhi/getPhi read back (round-trips the sync-metadata too).
const PHI_SELECT_COLS =
  'id, title, body, server_updated_at AS serverUpdatedAt, local_updated_at AS localUpdatedAt, sync_state AS syncState, origin';

function closeCurrent(): void {
  if (!current) return;
  try {
    current.db.close();
  } catch {
    /* ignore */
  }
  current = null;
}

// ─── Public API — mirrors the skeleton store's shape ──────────────────────────

/** Open the encrypted PHI DB for the signed-in principal. Call once at sign-in
 *  (after auth restore) so subsequent reads/writes have a live handle. Safe to
 *  call repeatedly. */
export async function openForPrincipal(principal: string): Promise<void> {
  await open(principal);
}

/** Load all persisted PHI rows for cold-start hydration. Returns [] when
 *  memory-only or not yet opened. The caller layers title/body onto the
 *  skeleton-hydrated cache rows. */
export function loadPhi(): PhiRow[] {
  if (current) {
    const rows = current.db
      .prepare(`SELECT ${PHI_SELECT_COLS} FROM task_phi`)
      .all() as PhiRow[];
    return rows;
  }
  if (memoryFallback) return [...memoryFallback.values()];
  return [];
}

/** Look up one row's PHI (title/body + sync-metadata), or null. */
export function getPhi(id: string): PhiRow | null {
  if (current) {
    return (
      (current.db
        .prepare(`SELECT ${PHI_SELECT_COLS} FROM task_phi WHERE id = ?`)
        .get(id) as PhiRow | undefined) ?? null
    );
  }
  if (memoryFallback) return memoryFallback.get(id) ?? null;
  return null;
}

/** Upsert a task's title (from a list pull). Leaves body untouched. No-ops for
 *  a null/empty title so we never overwrite a known title with a placeholder.
 *  When the DB isn't open yet, writes to the fallback map so a write that races
 *  open() is NOT lost (open() flushes the fallback into the DB on success). */
export function putTitle(
  id: string,
  title: string | null,
  serverUpdatedAt?: string | null,
): void {
  if (title == null) return;
  const row: PhiRow = {
    id,
    title,
    body: null,
    serverUpdatedAt: serverUpdatedAt ?? null,
    localUpdatedAt: Date.now(),
    syncState: 'synced',
    origin: 'server',
  };
  if (current) {
    current.db.prepare(PHI_UPSERT_SQL).run(upsertParams(row));
    return;
  }
  const fb = ensureFallback();
  const prev = fb.get(id);
  // Preserve any body collected in the fallback while carrying the fresh meta.
  fb.set(id, { ...row, body: prev?.body ?? null });
}

/** Upsert many titles in one transaction (a full list pull). Each row may carry
 *  the server's ISO `serverUpdatedAt` (non-PHI) so the persisted sync-metadata
 *  reflects the server's last-touch time. */
export function putTitles(
  rows: Array<{ id: string; title: string | null; serverUpdatedAt?: string | null }>,
): void {
  if (current) {
    const stmt = current.db.prepare(PHI_UPSERT_SQL);
    const now = Date.now();
    const txn = current.db.transaction(
      (rs: Array<{ id: string; title: string | null; serverUpdatedAt?: string | null }>) => {
        for (const r of rs) {
          if (r.title == null) continue;
          stmt.run(
            upsertParams({
              id: r.id,
              title: r.title,
              body: null,
              serverUpdatedAt: r.serverUpdatedAt ?? null,
              localUpdatedAt: now,
              syncState: 'synced',
              origin: 'server',
            }),
          );
        }
      },
    );
    txn(rows);
    return;
  }
  for (const r of rows) putTitle(r.id, r.title, r.serverUpdatedAt);
}

/** Upsert a task's body (from a getTask detail pull). Leaves title untouched.
 *  No-ops for a null body so a note-less detail fetch never WIPES a previously
 *  persisted good body (a getTask on a task whose detail carries no notes would
 *  otherwise overwrite the stored body with NULL). */
export function putBody(
  id: string,
  body: string | null,
  serverUpdatedAt?: string | null,
): void {
  if (body == null) return;
  const row: PhiRow = {
    id,
    title: null,
    body,
    serverUpdatedAt: serverUpdatedAt ?? null,
    localUpdatedAt: Date.now(),
    syncState: 'synced',
    origin: 'server',
  };
  if (current) {
    current.db.prepare(PHI_UPSERT_SQL).run(upsertParams(row));
    return;
  }
  const fb = ensureFallback();
  const prev = fb.get(id);
  fb.set(id, { ...row, title: prev?.title ?? null });
}

/** Remove PHI rows no longer present in the FULL live set — used ONLY on the
 *  full-reconcile path, where `liveIds` is the complete server inventory. NEVER
 *  call this on the delta path: there `this.cache` may not contain every
 *  persisted id (early hydration, delta-preserved rows), so intersecting with it
 *  would delete still-valid PHI. Deletes converge here (full pull) and via
 *  pruneIds (explicit tombstones) on the delta path. */
export function pruneTo(liveIds: Set<string>): void {
  if (current) {
    const ids = (
      current.db.prepare('SELECT id FROM task_phi').all() as { id: string }[]
    ).map((r) => r.id);
    const del = current.db.prepare('DELETE FROM task_phi WHERE id = ?');
    const delCache = current.db.prepare('DELETE FROM task_data_cache WHERE task_id = ?');
    const txn = current.db.transaction(() => {
      for (const id of ids) {
        if (liveIds.has(id)) continue;
        del.run(id);
        delCache.run(id);
      }
    });
    txn();
    return;
  }
  if (memoryFallback) {
    for (const id of [...memoryFallback.keys()]) if (!liveIds.has(id)) memoryFallback.delete(id);
  }
}

/** Remove PHI for an EXPLICIT id list — the delta path's tombstones. Only these
 *  ids are dropped (never an intersection with the whole cache), so a task
 *  present on disk but absent from the current in-memory cache keeps its PHI
 *  until a full reconcile legitimately removes it. Mirrors the skeleton store's
 *  delta semantics (explicit tombstones only; the periodic full pull converges). */
export function pruneIds(ids: string[]): void {
  if (ids.length === 0) return;
  if (current) {
    const del = current.db.prepare('DELETE FROM task_phi WHERE id = ?');
    const delCache = current.db.prepare('DELETE FROM task_data_cache WHERE task_id = ?');
    const txn = current.db.transaction(() => {
      for (const id of ids) {
        del.run(id);
        delCache.run(id);
      }
    });
    txn();
    return;
  }
  if (memoryFallback) for (const id of ids) memoryFallback.delete(id);
}

/**
 * Sign-out teardown: empty the rows, close the DB, and DELETE the encrypted file
 * so no PHI ciphertext lingers. Pass the signed-out `principal` so the file is
 * reaped EVEN when the store ran memory-only this session (no `current`) but a
 * prior session left an encrypted file on disk. The wrapped key is wiped
 * separately by the caller (db-key.wipeDbKey) — belt and suspenders: even a file
 * that survives (if unlink races) is undecryptable once the key is gone.
 */
export function clearPhi(principal?: string): void {
  if (current) {
    const p = current.principal;
    try {
      current.db.exec('DELETE FROM task_phi;');
    } catch {
      /* ignore */
    }
    closeCurrent();
    removeDbFile(p);
  } else if (principal) {
    // Memory-only / never-opened this session: still reap any on-disk file left
    // by a prior session so ciphertext doesn't accumulate across sign-outs.
    removeDbFile(principal);
  }
  memoryFallback = null;
}

// ─── task-data value cache (task-780730a010a2) ────────────────────────────
//
// CLASS 1 (per-task data-bag values) + CLASS 2 (the user's own vault fields).
// Both ride the SAME encrypted connection as title/body above, so they're
// encrypted-at-rest, per-principal, and wiped by clearPhi() on sign-out —
// no new key material, no new lifecycle.
//
// PERF-ONLY, never correctness-load-bearing: when the encrypted DB isn't open
// (no keychain — memory-only mode), these simply behave as an always-miss
// cache. Callers (task-data.ts) already have a working network-fetch fallback
// for every ref, so skipping the cache here just forgoes the speedup rather
// than breaking anything. Unlike title/body there is no memoryFallback map for
// these — the value would otherwise sit decrypted in JS heap for the rest of
// the session, and this cache exists to avoid a REPEATED round-trip, not a
// single one, so an always-miss degrade is an acceptable trade.

/** CLASS 1: read a cached data-bag value, honoring the freshness contract —
 *  the caller passes the task's CURRENT skeleton `updated_at` (ISO, NON-PHI);
 *  a cached row whose stored `server_updated_at` doesn't match is stale (the
 *  task changed since we cached this ref) and is treated as a miss. Returns
 *  null on any miss (not cached, DB not open, or stale). */
export function getCachedDataValue(
  taskId: string,
  ref: string,
  currentUpdatedAtIso: string | null,
): string | null {
  if (!current) return null;
  const row = current.db
    .prepare(
      'SELECT value, server_updated_at AS serverUpdatedAt FROM task_data_cache WHERE task_id = ? AND ref = ?',
    )
    .get(taskId, ref) as { value: string; serverUpdatedAt: string | null } | undefined;
  if (!row) return null;
  // No freshness signal on either side (server predates updated_at, or we never
  // recorded one) — trust the cached value rather than never caching at all.
  if (currentUpdatedAtIso != null && row.serverUpdatedAt != null) {
    if (row.serverUpdatedAt !== currentUpdatedAtIso) return null;
  }
  return row.value;
}

/** CLASS 1: write-through a resolved data-bag value. `serverUpdatedAtIso` is
 *  the task's skeleton `updated_at` AT RESOLVE TIME, stamped alongside the
 *  value so a later read can detect the task having moved on. No-ops when the
 *  encrypted DB isn't open (memory-only mode — see header note). */
export function putCachedDataValue(
  taskId: string,
  ref: string,
  value: string,
  serverUpdatedAtIso: string | null,
): void {
  if (!current) return;
  current.db
    .prepare(
      `INSERT INTO task_data_cache (task_id, ref, value, server_updated_at, local_updated_at)
       VALUES (@task_id, @ref, @value, @server_updated_at, @local_updated_at)
       ON CONFLICT(task_id, ref) DO UPDATE SET
         value = excluded.value,
         server_updated_at = excluded.server_updated_at,
         local_updated_at = excluded.local_updated_at`,
    )
    .run({
      task_id: taskId,
      ref,
      value,
      server_updated_at: serverUpdatedAtIso,
      local_updated_at: Date.now(),
    });
}

/** CLASS 2: read a cached vault field value (`format` is the bare|dashed hint,
 *  '' when omitted — same key shape the resolver already uses). Returns null
 *  on any miss. No staleness check here: correctness comes from
 *  invalidateCachedVaultValue being called on every write (see below), not
 *  from a time-based guess. */
export function getCachedVaultValue(ref: string, format: string | undefined): string | null {
  if (!current) return null;
  const row = current.db
    .prepare('SELECT value FROM vault_data_cache WHERE ref = ? AND format = ?')
    .get(ref, format ?? '') as { value: string } | undefined;
  return row?.value ?? null;
}

/** CLASS 2: write-through a resolved vault field value. */
export function putCachedVaultValue(ref: string, format: string | undefined, value: string): void {
  if (!current) return;
  current.db
    .prepare(
      `INSERT INTO vault_data_cache (ref, format, value, local_updated_at)
       VALUES (@ref, @format, @value, @local_updated_at)
       ON CONFLICT(ref, format) DO UPDATE SET
         value = excluded.value,
         local_updated_at = excluded.local_updated_at`,
    )
    .run({ ref, format: format ?? '', value, local_updated_at: Date.now() });
}

/** CLASS 2: drop every cached format-variant for one vault ref. Called by
 *  user-vault.ts on setUserSecret/deleteUserSecret so a write is immediately
 *  reflected — a stale credential silently filled into a form is worse than a
 *  cache miss, so writes always win over the cache rather than racing a TTL. */
export function invalidateCachedVaultValue(ref: string): void {
  if (!current) return;
  current.db.prepare('DELETE FROM vault_data_cache WHERE ref = ?').run(ref);
}

// For tests / explicit cleanup.
export function _closeForTests(): void {
  closeCurrent();
  memoryFallback = null;
}
