// task-ac9f4a27be7d — tests for the PURE key-derivation core of the encrypted
// PHI DB. The db-key.ts module imports Electron safeStorage/app and the
// SQLCipher native driver, neither of which loads under `node --test`; so — like
// task-skeleton.test targeting the schema module — these target the pure,
// Electron-free derivation (db-key-derive.mjs), which owns the security formula
// the store relies on. The safeStorage wrapping, on-disk encryption, and
// sign-out wipe are exercised by the Electron-runtime verify script
// (scripts/verify-phi-encryption.mjs) + manual QA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  deriveDbKey,
  keyInfo,
  keyPragmaLiteral,
  principalTag,
} from '../electron/typebuild/db-key-derive.mjs';

const master = () => randomBytes(32);
const salt = () => randomBytes(32);

// ─── Determinism: the DB must reopen across restarts ────────────────────────

test('deriveDbKey is deterministic for the same (master, salt, principal)', () => {
  const m = master();
  const s = salt();
  const k1 = deriveDbKey(m, s, 'sub-abc');
  const k2 = deriveDbKey(m, s, 'sub-abc');
  assert.equal(k1.length, 32, 'key is 32 bytes (256-bit)');
  assert.ok(k1.equals(k2), 'same inputs derive the identical key');
});

// ─── Per-principal segregation: A can never derive B's key ──────────────────

test('a different principal derives a DIFFERENT key (same master+salt)', () => {
  const m = master();
  const s = salt();
  const kA = deriveDbKey(m, s, 'sub-AAAA');
  const kB = deriveDbKey(m, s, 'sub-BBBB');
  assert.ok(!kA.equals(kB), 'principal is bound into the key (account segregation)');
});

test('keyInfo namespaces the principal into the HKDF info', () => {
  assert.equal(keyInfo('sub-xyz'), 'typebuild-phi-db:sub-xyz');
  assert.notEqual(keyInfo('sub-a'), keyInfo('sub-b'));
});

// ─── Machine binding: a wrapped master copied off-machine is useless ────────

test('a different device salt derives a DIFFERENT key (machine binding)', () => {
  const m = master();
  const kHere = deriveDbKey(m, salt(), 'sub-abc');
  const kThere = deriveDbKey(m, salt(), 'sub-abc');
  assert.ok(!kHere.equals(kThere), 'device salt binds the key to the machine');
});

// ─── A different master (e.g. regenerated key) diverges ─────────────────────

test('a different master derives a DIFFERENT key (fresh key ⇒ fresh DB)', () => {
  const s = salt();
  const k1 = deriveDbKey(master(), s, 'sub-abc');
  const k2 = deriveDbKey(master(), s, 'sub-abc');
  assert.ok(!k1.equals(k2), 'a new random master yields a new key');
});

// ─── SQLCipher raw-key literal form ─────────────────────────────────────────

test('keyPragmaLiteral emits the SQLCipher raw-key form x\'<hex>\'', () => {
  const key = Buffer.from('00ff10', 'hex');
  assert.equal(keyPragmaLiteral(key), "x'00ff10'");
  const full = deriveDbKey(master(), salt(), 'sub-abc');
  const lit = keyPragmaLiteral(full);
  assert.match(lit, /^x'[0-9a-f]{64}'$/, '64 hex chars (32 bytes) wrapped in x\'\'');
});

// ─── Principal tag: fixed-length, deterministic, principal-distinguishing ────

test('principalTag is deterministic, fixed-length, and distinguishes principals', () => {
  assert.equal(principalTag('sub-abc'), principalTag('sub-abc'));
  assert.equal(principalTag('sub-abc').length, 24);
  assert.match(principalTag('sub-abc'), /^[0-9a-f]{24}$/);
  assert.notEqual(principalTag('sub-abc'), principalTag('sub-def'));
});
