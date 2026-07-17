// task-fe9e4c4cda44 — shared DDL + column allow-list for the ENCRYPTED PHI store
// (task-phi-store.ts). Split into a plain .mjs for the SAME reason as
// task-skeleton-schema.mjs: the store is TypeScript compiled against Electron's
// native ABI and cannot load under the plain `node --test` runtime, but the
// on-disk no-plaintext-PHI test (tests/task-phi-ondisk.test.mjs) needs the EXACT
// table DDL the store creates so it can build a byte-identical encrypted fixture
// and assert the ciphertext never leaks the synthetic title/body. Keeping the DDL
// here means the store and the test share ONE source of truth.
//
// SKELETON vs PHI — the two-store decision (task-fe9e4c4cda44):
//   We keep TWO stores rather than folding one into the other:
//     • task-skeleton.db  — PLAINTEXT, NON-PHI routing skeleton (order/filter/
//       counts/timestamps). The FAST PATH: cheap to open and query without a key.
//     • task-phi-*.db     — SQLCipher-ENCRYPTED PHI sibling, keyed by the SAME
//       opaque task id, holding ONLY human text (title/body) + sync-metadata.
//   Why not fold them together? Folding the routing skeleton INTO the encrypted
//   DB would force every ordering/filter/count query through SQLCipher decryption
//   on the hot cold-start path — defeating the whole point of a fast local read —
//   and would put NON-PHI routing data behind a key that may be unavailable (no
//   keychain → memory-only), which would then hide the routing skeleton too.
//   Keeping them split gives each store ONE unambiguous role (skeleton = routing
//   truth, always readable; PHI = human text, encrypted, best-effort) and is the
//   lowest-churn option since both stores already exist and are wired. The `id`
//   column is the join key; a PHI row is layered onto its skeleton row in memory.

// The exact, ordered column set of the encrypted task_phi table. `title`/`body`
// ARE PHI — that is the whole point of this store being encrypted. The remaining
// columns are NON-PHI sync-metadata (timestamps + small enums), carried on EVERY
// row so the read/reconcile pipeline can reason about staleness + provenance.
export const PHI_COLUMNS = [
  'id', // opaque task id (PK) — join key to the skeleton row
  'title', // PHI: decrypted task title (from the list pull)
  'body', // PHI: decrypted task body (from the getTask detail pull)
  // ─── sync-metadata (NON-PHI) — task-fe9e4c4cda44 ───────────────────────────
  'server_updated_at', // ISO 'updated_at' the server last reported for this row
  'local_updated_at', // epoch ms we last wrote this row locally
  'sync_state', // 'synced' | 'pending' | 'tombstone'
  'origin', // 'server' | 'local'
];

// Enumerated vocabularies for the sync-metadata columns. Exported so the store
// and any future consumer agree on the literals (no stringly-typed drift).
// NOTE: the READ path only ever writes origin='server'/sync_state='synced' —
// 'pending'/'local' exist for the optimistic-WRITE queue (task-a606864378cb,
// out of scope here) so the schema doesn't need a migration when that lands.
export const SYNC_STATES = ['synced', 'pending', 'tombstone'];
export const ORIGINS = ['server', 'local'];

// The CREATE TABLE DDL. Kept in lockstep with PHI_COLUMNS (the on-disk test
// asserts the parsed column set equals PHI_COLUMNS, so drift is caught).
export const PHI_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS task_phi (
    id                TEXT PRIMARY KEY,
    title             TEXT,
    body              TEXT,
    server_updated_at TEXT,
    local_updated_at  INTEGER,
    sync_state        TEXT NOT NULL DEFAULT 'synced',
    origin            TEXT NOT NULL DEFAULT 'server'
  );
`;

// ADDITIVE migration for a pre-existing Phase-1 task_phi (id/title/body only):
// each entry is a column that a legacy DB won't have. The store runs
// `ALTER TABLE task_phi ADD COLUMN <spec>` for any column absent from
// PRAGMA table_info, so an existing encrypted DB gains the sync-metadata columns
// on first open with no data migration and no rebuild.
export const PHI_MIGRATION_COLUMNS = [
  { name: 'server_updated_at', spec: 'server_updated_at TEXT' },
  { name: 'local_updated_at', spec: 'local_updated_at INTEGER' },
  { name: 'sync_state', spec: "sync_state TEXT NOT NULL DEFAULT 'synced'" },
  { name: 'origin', spec: "origin TEXT NOT NULL DEFAULT 'server'" },
];

// task-780730a010a2 — the task-data VALUE cache, same encrypted DB file as
// task_phi (same security tier: PHI/credential values, per-principal, wiped on
// sign-out). Two tables for the two data classes task-data.ts resolves:
//
//   task_data_cache  — CLASS 1 (per-task patient data-bag values), keyed by
//     (task_id, ref). Freshness is checked against the NON-PHI skeleton store's
//     `updated_at_iso` for that task (getSkeletonUpdatedAtIso) — a mismatch
//     means the task changed since we cached this value, so treat as a miss.
//   vault_data_cache — CLASS 2 (the user's own vault fields, "me.*"/"me@id.*"),
//     keyed by (ref, format). No task is involved, so there is no server
//     updated_at to compare against; instead the vault WRITE path
//     (user-vault.ts setUserSecret/deleteUserSecret) invalidates the ref
//     directly on every write, so a cache hit is always the value WE last
//     wrote or fetched — never a guess bounded by a TTL.
//
// Both tables hold plaintext-when-unencrypted VALUES, same as task_phi's
// title/body, so they ride the SAME SQLCipher connection/key/wipe lifecycle —
// no separate store, no separate key derivation.
export const DATA_CACHE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS task_data_cache (
    task_id           TEXT NOT NULL,
    ref               TEXT NOT NULL,
    value             TEXT NOT NULL,
    server_updated_at TEXT,
    local_updated_at  INTEGER NOT NULL,
    PRIMARY KEY (task_id, ref)
  );
`;

export const VAULT_CACHE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS vault_data_cache (
    ref              TEXT NOT NULL,
    format           TEXT NOT NULL DEFAULT '',
    value            TEXT NOT NULL,
    local_updated_at INTEGER NOT NULL,
    PRIMARY KEY (ref, format)
  );
`;

// Reuse the skeleton schema's PHI-column parser/guard shape here too, so the test
// can assert that the NON-PHI sync-metadata column NAMES don't accidentally
// carry a PHI-suggesting substring (title/body/notes are EXPECTED here — they're
// the encrypted payload — so this parser is only applied to the sync-meta names).
export function parsePhiColumnNames(createTableSql) {
  const open = createTableSql.indexOf('(');
  const close = createTableSql.lastIndexOf(')');
  if (open < 0 || close < 0) return [];
  const body = createTableSql.slice(open + 1, close);
  let depth = 0;
  let cur = '';
  const parts = [];
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  const TABLE_CONSTRAINTS = new Set(['PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'CONSTRAINT']);
  const cols = [];
  for (const part of parts) {
    const tok = part.trim().split(/\s+/)[0];
    if (!tok) continue;
    if (TABLE_CONSTRAINTS.has(tok.toUpperCase())) continue;
    cols.push(tok);
  }
  return cols;
}
