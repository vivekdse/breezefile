// task-fe9e4c4cda44 — PHI-at-rest guarantee for the ENCRYPTED task_phi store.
//
// The store persists task TITLE + BODY (PHI). This test asserts the hard
// invariant: with SQLCipher applied, a task's title/body NEVER appear as
// readable plaintext in the on-disk DB file (nor its WAL/shm siblings), while
// the SAME driver WITHOUT a key leaves them readable (proving the byte-scan is
// sound — it's not a false pass on some encoding quirk).
//
// The test uses the SAME DDL the store creates (PHI_TABLE_SQL from the shared
// schema module) and the SAME raw-key pragma form (`key = "x'<hex>'"`), so the
// fixture is byte-compatible with production.
//
// HARNESS NOTE: better-sqlite3-multiple-ciphers is a NATIVE module compiled
// against Electron's ABI (postinstall rebuilds it for the app). Under the plain
// `node --test` runtime the ABI won't match, so the driver can't load. When that
// happens we SKIP loudly rather than fail — the assertion is only meaningful when
// the driver is present (e.g. run under Electron's node, or after a node rebuild).
// The synthetic strings below are NOT PHI (guardrail: never put real PHI in
// fixtures).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PHI_TABLE_SQL, PHI_COLUMNS, parsePhiColumnNames } from '../electron/sources/task-phi-schema.mjs';

const require = createRequire(import.meta.url);

// Synthetic, obviously-non-PHI markers unlikely to collide with SQLCipher's own
// bytes. If either substring survives into the ciphertext, encryption failed.
const SECRET_TITLE = 'ZZ_SYNTH_TITLE_' + randomBytes(6).toString('hex').toUpperCase();
const SECRET_BODY = 'ZZ_SYNTH_BODY_' + randomBytes(6).toString('hex').toUpperCase();

// Try to load the SQLCipher driver; null when the native ABI doesn't match the
// current runtime (the usual case under `node --test`).
function loadCipher() {
  try {
    const Database = require('better-sqlite3-multiple-ciphers');
    // The native .node binding may load lazily at construction, so PROBE it here
    // (an in-memory db) to surface an ABI mismatch as a catchable error → skip.
    const probe = new Database(':memory:');
    probe.close();
    return Database;
  } catch {
    return null;
  }
}

// Scan a DB file + its WAL/shm siblings for a substring in the raw bytes. We read
// as latin1 so every byte maps 1:1 to a char (no UTF-8 loss) — a robust
// substring search over the raw file. Returns true if `needle` appears anywhere.
function fileContains(basePath, needle) {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = basePath + suffix;
    if (!existsSync(p)) continue;
    const bytes = readFileSync(p).toString('latin1');
    if (bytes.includes(needle)) return true;
  }
  return false;
}

// The schema DDL must declare exactly the documented columns (drift tripwire —
// this half of the test always runs, driver or not).
test('task_phi DDL declares exactly the documented columns', () => {
  const parsed = parsePhiColumnNames(PHI_TABLE_SQL);
  assert.deepEqual(
    [...parsed].sort(),
    [...PHI_COLUMNS].sort(),
    'CREATE TABLE task_phi columns must equal PHI_COLUMNS',
  );
});

test('encrypted task_phi never leaks title/body as on-disk plaintext', (t) => {
  const Database = loadCipher();
  if (!Database) {
    t.skip(
      'better-sqlite3-multiple-ciphers not loadable under this runtime (ABI mismatch) — run under Electron node to exercise the byte-scan',
    );
    return;
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), 'phi-ondisk-'));
  const encPath = path.join(dir, 'enc.db');
  const plainPath = path.join(dir, 'plain.db');
  // A raw 32-byte key in the same `x'<hex>'` form the store uses.
  const keyHex = randomBytes(32).toString('hex');

  try {
    // ── encrypted DB (with key) ──────────────────────────────────────────────
    const enc = new Database(encPath);
    enc.pragma(`key = "x'${keyHex}'"`);
    enc.pragma('journal_mode = WAL');
    enc.exec(PHI_TABLE_SQL);
    enc
      .prepare(
        'INSERT INTO task_phi (id, title, body, sync_state, origin) VALUES (?, ?, ?, ?, ?)',
      )
      .run('task-synthetic', SECRET_TITLE, SECRET_BODY, 'synced', 'server');
    // Flush WAL into the main file so the scan covers the persisted pages too.
    enc.pragma('wal_checkpoint(TRUNCATE)');
    enc.close();

    // ── control: SAME driver, NO key (plaintext) ─────────────────────────────
    const plain = new Database(plainPath);
    plain.pragma('journal_mode = WAL');
    plain.exec(PHI_TABLE_SQL);
    plain
      .prepare('INSERT INTO task_phi (id, title, body) VALUES (?, ?, ?)')
      .run('task-synthetic', SECRET_TITLE, SECRET_BODY);
    plain.pragma('wal_checkpoint(TRUNCATE)');
    plain.close();

    // The plaintext control MUST leak (proves the byte-scan actually detects the
    // strings), the encrypted DB MUST NOT.
    assert.equal(
      fileContains(plainPath, SECRET_TITLE),
      true,
      'sanity: plaintext control DB should contain the title (scan is sound)',
    );
    assert.equal(
      fileContains(encPath, SECRET_TITLE),
      false,
      'encrypted DB file must NOT contain the plaintext title',
    );
    assert.equal(
      fileContains(encPath, SECRET_BODY),
      false,
      'encrypted DB file must NOT contain the plaintext body',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
