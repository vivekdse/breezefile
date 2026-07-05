// task-ac9f4a27be7d — type surface for the pure, Electron-free key-derivation
// core (runtime is plain ESM so `node --test` can import it without a transpile).

/** The HKDF `info` binding for a principal (namespaces the key per account). */
export function keyInfo(principal: string): string;

/** Derive the raw 32-byte SQLCipher key from (master, deviceSalt, principal). */
export function deriveDbKey(master: Buffer, salt: Buffer, principal: string): Buffer;

/** SQLCipher raw-key pragma literal for a derived key: `x'<hex>'`. */
export function keyPragmaLiteral(key: Buffer): string;

/** Fixed-length (24 hex chars), deterministic filesystem tag for a principal. */
export function principalTag(principal: string): string;
