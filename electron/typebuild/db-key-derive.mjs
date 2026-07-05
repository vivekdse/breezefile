// task-ac9f4a27be7d — the PURE, Electron-free core of the encrypted-PHI-DB key
// derivation, split out so it can be unit-tested under plain `node --test` (the
// db-key.ts module itself imports Electron safeStorage/app and cannot load in
// that runtime, exactly like task-skeleton-store vs task-skeleton-schema).
//
// The DB key = HKDF-SHA256(master, salt=deviceSalt, info="typebuild-phi-db:"+
// principal, 32 bytes). This module owns that formula and the security
// properties the tests assert:
//   - DETERMINISTIC: same (master, salt, principal) ⇒ same key (so the DB
//     reopens across restarts).
//   - PRINCIPAL-SEGREGATED: different principal ⇒ different key (account A can
//     never derive account B's key, even with the same master+salt).
//   - MACHINE-BOUND: different device salt ⇒ different key (a wrapped master
//     copied to another machine, without that machine's salt, derives a
//     different — useless — key).

import { createHash, hkdfSync } from 'node:crypto';

/** The HKDF `info` binding for a principal. Namespaces the derived key to the
 *  account so the same master+salt yields distinct keys per principal. */
export function keyInfo(principal) {
  return `typebuild-phi-db:${principal}`;
}

/** Derive the raw 32-byte SQLCipher key from the three factors. `master` and
 *  `salt` are Buffers; `principal` is the opaque Firebase sub. Returns a Buffer. */
export function deriveDbKey(master, salt, principal) {
  const derived = hkdfSync('sha256', master, salt, keyInfo(principal), 32);
  return Buffer.from(derived);
}

/** The SQLCipher raw-key pragma literal for a derived key: `x'<hex>'`. Raw key
 *  form so SQLCipher skips its own KDF (our HKDF already derived it). */
export function keyPragmaLiteral(key) {
  return `x'${key.toString('hex')}'`;
}

/** The filesystem tag for a principal (fixed-length, non-reversible), used to
 *  namespace BOTH the wrapped-key file and the encrypted DB file so they line
 *  up. Not a security boundary on its own — the principal is already opaque. */
export function principalTag(principal) {
  return createHash('sha256').update(principal).digest('hex').slice(0, 24);
}
