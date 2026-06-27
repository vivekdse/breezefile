// Pure normalization for the site-keyed credential LIST response (no Electron,
// no auth) so it is unit-testable. Split out of site-credentials.ts; different
// basename avoids the sibling .mjs/.ts same-basename build gotcha.
//
// The server returns { credentials: [{ origin, username, updated_at }] } (NO
// passwords on the list path). This maps it to the client SavedCredential shape
// ({ origin, username, updatedAt }), dropping malformed rows and any row with no
// origin. NON-PHI metadata only — there is no password to handle here.

/**
 * @param {unknown} body  the parsed JSON body of GET /chromeext/credentials
 * @returns {{origin:string, username:string, updatedAt?:string}[]}
 */
export function normalizeCredentialList(body) {
  const raw =
    body && typeof body === 'object' && Array.isArray(body.credentials)
      ? body.credentials
      : [];
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const o = typeof c.origin === 'string' ? c.origin : '';
    const u = typeof c.username === 'string' ? c.username : '';
    if (!o) continue;
    const updatedAt =
      typeof c.updated_at === 'string'
        ? c.updated_at
        : typeof c.updatedAt === 'string'
          ? c.updatedAt
          : undefined;
    const row = { origin: o, username: u };
    if (updatedAt !== undefined) row.updatedAt = updatedAt;
    out.push(row);
  }
  return out;
}
