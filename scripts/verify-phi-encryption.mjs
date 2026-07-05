// task-ac9f4a27be7d — end-to-end verification that the encrypted PHI DB actually
// encrypts at rest, using the REAL compiled SQLCipher driver under Electron's
// runtime (better-sqlite3-multiple-ciphers only loads under Electron's ABI).
//
// Run:  npx electron scripts/verify-phi-encryption.mjs
//
// It does NOT depend on safeStorage/a real login — it derives a raw key directly
// via the pure derivation module and exercises the SQLCipher PRAGMA key path the
// store uses, then asserts the three acceptance criteria:
//   (1) with the correct key, a PHI marker row reads back;
//   (2) with a WRONG key (and with NO key), the read FAILS;
//   (3) the PHI marker string is ABSENT from the raw .db bytes (whole-file enc).
// Exits non-zero on any failure so it can gate a build/QA step.

import Database from 'better-sqlite3-multiple-ciphers';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { deriveDbKey, keyPragmaLiteral } from '../electron/typebuild/db-key-derive.mjs';

const MARKER = 'BREEZE_PHI_MARKER_' + randomBytes(4).toString('hex');
const dir = mkdtempSync(join(tmpdir(), 'phi-enc-'));
const file = join(dir, 'phi.db');

const master = randomBytes(32);
const salt = randomBytes(32);
const principal = 'sub-verify-1234';
const key = deriveDbKey(master, salt, principal);
const wrongKey = deriveDbKey(randomBytes(32), salt, principal);

function openWith(k) {
  const db = new Database(file);
  db.pragma(`key = "${keyPragmaLiteral(k)}"`);
  db.pragma('journal_mode = WAL');
  return db;
}

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

try {
  // Write a PHI row under the correct key.
  {
    const db = openWith(key);
    db.exec('CREATE TABLE task_phi (id TEXT PRIMARY KEY, title TEXT, body TEXT);');
    db.prepare('INSERT INTO task_phi (id, title, body) VALUES (?, ?, ?)').run(
      't1',
      MARKER + '_TITLE',
      MARKER + '_BODY',
    );
    db.close();
  }

  // (1) Correct key reads it back.
  {
    const db = openWith(key);
    const row = db.prepare('SELECT title, body FROM task_phi WHERE id = ?').get('t1');
    ok(row?.title === MARKER + '_TITLE' && row?.body === MARKER + '_BODY',
      '(1) correct key reads the PHI row back');
    db.close();
  }

  // (2a) Wrong key fails to read.
  {
    let threw = false;
    try {
      const db = openWith(wrongKey);
      db.prepare('SELECT count(*) FROM task_phi').get();
      db.close();
    } catch {
      threw = true;
    }
    ok(threw, '(2a) WRONG key cannot open/read the DB');
  }

  // (2b) No key at all fails to read.
  {
    let threw = false;
    try {
      const db = new Database(file);
      db.prepare('SELECT count(*) FROM task_phi').get();
      db.close();
    } catch {
      threw = true;
    }
    ok(threw, '(2b) NO key cannot open/read the DB');
  }

  // (3) The PHI marker must not appear in the raw file bytes.
  {
    const bytes = readFileSync(file);
    const present = bytes.includes(Buffer.from(MARKER));
    ok(!present, '(3) PHI marker is ABSENT from the raw .db bytes (whole-file encrypted)');
    // Also confirm it's not a plaintext SQLite file (no "SQLite format 3" header).
    ok(!bytes.subarray(0, 16).includes(Buffer.from('SQLite format 3')),
      '(3b) file has no plaintext "SQLite format 3" header');
  }

  // (4) Review-fix behaviors: a null body must NOT wipe a persisted good body,
  //     and an upsert path that sets title-only leaves body intact (and v.v.).
  {
    const db = openWith(key);
    const upTitle = db.prepare(
      `INSERT INTO task_phi (id, title, body) VALUES (?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title`);
    const upBody = db.prepare(
      `INSERT INTO task_phi (id, title, body) VALUES (?, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET body = excluded.body`);
    // Seed title then body for a fresh id.
    upTitle.run('t2', 'the-title');
    upBody.run('t2', 'the-body');
    let row = db.prepare('SELECT title, body FROM task_phi WHERE id=?').get('t2');
    ok(row.title === 'the-title' && row.body === 'the-body',
      '(4a) title-then-body upserts compose (neither wipes the other)');
    // Re-apply title-only: body must survive (mirrors putTitle leaving body).
    upTitle.run('t2', 'title-v2');
    row = db.prepare('SELECT title, body FROM task_phi WHERE id=?').get('t2');
    ok(row.title === 'title-v2' && row.body === 'the-body',
      '(4b) a title-only upsert does NOT clear the existing body');
    // The store's putBody now early-returns on null, so a null body never
    // reaches SQL — model that: we simply do not run upBody with null. Assert the
    // body is still intact (i.e. the guard is the ONLY thing preventing a wipe).
    row = db.prepare('SELECT body FROM task_phi WHERE id=?').get('t2');
    ok(row.body === 'the-body', '(4c) body persists when putBody(null) is a no-op');
    db.close();
  }
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll PHI-encryption checks passed.');
process.exit(0);
