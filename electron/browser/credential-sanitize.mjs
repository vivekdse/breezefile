// Pure validation for a captured login credential (no Electron, no DOM) so it is
// unit-testable without a live WebContents. Split out of credential-capture.ts
// (the page-injection + console wiring need Electron). Different basename from
// the .ts on purpose — avoids the sibling .mjs/.ts same-basename build gotcha.
//
// SECURITY: this function handles a plaintext password in memory only. It NEVER
// logs it; it only decides whether a pulled object is a usable credential.

/**
 * Validate + normalize a pulled credential object. Returns
 * { origin, username, password } or null for anything we will not surface
 * (no origin, a "null" origin string, or no password).
 * @param {unknown} raw
 * @returns {{origin:string, username:string, password:string}|null}
 */
export function sanitizeCapturedCredential(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const origin = typeof r.origin === 'string' ? r.origin : '';
  const username = typeof r.username === 'string' ? r.username : '';
  const password = typeof r.password === 'string' ? r.password : '';
  // A capture is only meaningful with a real origin and a non-empty password.
  if (!origin || origin === 'null' || !password) return null;
  return { origin, username, password };
}
