// API-spec site-memory (task-9704c5bc1575, Operator Speed / execution-channel).
//
// GOAL: the agent should not RE-LEARN a site's API every time. When a novel solve
// turns out to be an intercepted API call (a `net-replay`, discovered via
// electron/browser/net.mjs), we persist a NON-PHI note recording HOW to call that
// endpoint — endpoint path, method, header/param KEY names, and the `me.*` auth
// ref — so the NEXT task on that domain recalls it and just `curl`s it instead of
// re-driving the browser to rediscover it.
//
// WHERE IT LIVES (no new store): it is a NON-PHI note on the EXISTING shared
// site/task memory (memory.mjs), `site` scope, keyed by DOMAIN (siteKey) — the
// same store, key, and cross-machine sync as every other site note. We tag the
// note `kind: 'api-spec'` so it is trivially separable from free-text how-to notes
// and from param-binding notes sharing the bucket.
//
// THE RECORD SHAPE — KEYS ONLY, NEVER A VALUE (the load-bearing PHI invariant):
//   an api-spec note body is exactly
//     "api-spec domain:<domain> method:<METHOD> path:<url-or-path> \
//        headers:<h1,h2,…> params:<p1,p2,…> auth:<me.key> mutating:<bool>"
//   e.g.
//     "api-spec domain:payer.example.com method:POST path:/api/claims
//        headers:content-type,accept params:member_id,claim_id
//        auth:me.payer_token mutating:true"
//   Every token is an IDENTIFIER — a hostname, an HTTP method, a URL PATH (no
//   query VALUES), header NAMES, param/data placeholder KEYS, and a `me.*` auth
//   ref. The RESOLVED value (a token, an SSN, a member number) NEVER appears — it
//   is never passed to recordApiSpec(), and validate/parse REJECT anything
//   value-shaped so a bug upstream can't smuggle PHI/creds into the shared store.
//   This mirrors param-bindings.mjs + memory.mjs: store HOW to call, never WHAT.
//
// The shared store's server PHI-guard is the second line of defense; this module
// is the first — it only ever emits/accepts the keys-only line above.

import { addMemoryOnline, getMemoryOnline, siteKey } from './memory.mjs';
import { isMutatingMethod, SAFE_METHODS } from '../net.mjs';
import { looksLikeLiteralValue } from './promote.mjs';

/** The memory `kind` that marks a note as a structured API spec. */
export const API_SPEC_KIND = 'api-spec';

/** An HTTP method token. */
const METHOD_RE = /^[A-Z]+$/;

/** A header name: RFC token chars (letters/digits and a few symbols), no spaces,
 *  no ':' or value. Deliberately strict so a "Header: value" pair can't sneak in. */
const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*$/;

/** A param / data PLACEHOLDER key — same strict dotted-identifier shape
 *  param-bindings.mjs uses. A real value (with '@', digits-only, whitespace) does
 *  NOT match, so a value can never be mistaken for a key and stored. */
const KEY_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/i;

/** A `me.*` auth ref (the user's own credential placeholder, resolved locally via
 *  the vault — electron/typebuild/user-vault.ts — never inlined). */
const ME_REF_RE = /^me\.[a-z0-9_.]+$/i;

/** Normalize a domain exactly as memory.mjs siteKey() does, so a spec recorded
 *  from a full URL and one recalled from a bare host land in the same bucket. */
export function specDomain(urlOrHost) {
  return siteKey(urlOrHost);
}

/** Reduce a URL (or already-a-path) to its PATH — drop scheme, host, and the
 *  QUERY STRING (query values are PHI/cred-suspect). Keeps a leading '/'. NON-PHI:
 *  the path shape only. */
export function pathOf(urlOrPath) {
  const s = String(urlOrPath || '').trim();
  if (!s) return '';
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return new URL(s).pathname || '/';
  } catch {
    /* not a URL — fall through */
  }
  // Strip any query/fragment defensively (never persist ?k=VALUE).
  return s.split(/[?#]/)[0];
}

/** Validate the parts of an API spec. Returns { ok, error?, spec? }. Enforces the
 *  KEYS-ONLY invariant: method is a bare token, headers are NAMES, params are
 *  PLACEHOLDER keys, auth (when present) is a `me.*` ref, and NO field is a
 *  value-shaped literal. This is the gate recordApiSpec() runs before writing. */
export function validateApiSpec({ domain, method, path, headers, params, auth, mutating }) {
  const d = specDomain(domain);
  if (!d) return { ok: false, error: 'api-spec needs a domain' };

  const m = String(method || 'GET').toUpperCase();
  if (!METHOD_RE.test(m)) return { ok: false, error: `invalid method: ${method}` };

  const p = pathOf(path);
  if (!p) return { ok: false, error: 'api-spec needs an endpoint path/url' };
  // A path is a URL path — it must not carry a value-shaped query (pathOf strips
  // it, but re-check the raw so a caller can't hand us "/x?ssn=123" expecting it
  // stored). Path segments themselves are structural, not values.

  const hdrs = Array.isArray(headers) ? headers : [];
  for (const h of hdrs) {
    if (!HEADER_NAME_RE.test(String(h || ''))) {
      return { ok: false, error: `header must be a NAME, not a "Name: value": ${h}` };
    }
  }

  const prms = Array.isArray(params) ? params : [];
  for (const k of prms) {
    if (!KEY_RE.test(String(k || ''))) {
      return { ok: false, error: `param must be a placeholder KEY (dotted identifier), not a value: ${k}` };
    }
  }

  let a = auth;
  if (a !== undefined && a !== null && a !== '') {
    a = String(a);
    if (!ME_REF_RE.test(a)) {
      return { ok: false, error: `auth must be a me.* credential ref, never a value: ${a}` };
    }
  } else {
    a = null;
  }

  // Belt-and-suspenders: the auth ref (the one field that carries a credential)
  // must never be a resolved secret. The specific checks above already constrain
  // headers (NAMES), params (placeholder KEYS), and the path (a URL path); this
  // reuses the promotion PHI guard on `auth` so the discipline is identical to
  // promote.mjs. A me.* ref is NOT value-shaped, so a real me.* passes; a leaked
  // token would be caught here even if ME_REF_RE were ever loosened.
  if (a && looksLikeLiteralValue(a) && !ME_REF_RE.test(a)) {
    return { ok: false, error: `api-spec auth looks like a value, not a me.* ref: ${a}` };
  }

  return {
    ok: true,
    spec: {
      domain: d,
      method: m,
      path: p,
      headers: hdrs,
      params: prms,
      auth: a,
      mutating: mutating === undefined ? isMutatingMethod(m) : !!mutating,
    },
  };
}

/** Render a validated spec to its canonical, keys-only note line. Throws if the
 *  spec doesn't validate, so a value can never be serialized by mistake. */
export function formatApiSpec(spec) {
  const v = validateApiSpec(spec);
  if (!v.ok) throw new Error(v.error);
  const s = v.spec;
  return (
    `${API_SPEC_KIND} domain:${s.domain} method:${s.method} path:${s.path}` +
    ` headers:${s.headers.join(',')} params:${s.params.join(',')}` +
    ` auth:${s.auth || ''} mutating:${s.mutating}`
  );
}

const LINE_RE = new RegExp(
  `^${API_SPEC_KIND}\\s+domain:(\\S+)\\s+method:(\\S+)\\s+path:(\\S+)` +
    `\\s+headers:(\\S*)\\s+params:(\\S*)\\s+auth:(\\S*)\\s+mutating:(true|false)\\s*$`,
);

/** Parse one note body back to a spec, or null when the body is not an api-spec
 *  line (so it harmlessly ignores the free-text / param-binding notes sharing the
 *  bucket). Re-validates the parsed parts — a malformed/spoofed line that smuggled
 *  a value into any slot is rejected (null), so recall never surfaces a non-key. */
export function parseApiSpec(body) {
  const m = LINE_RE.exec(String(body || '').trim());
  if (!m) return null;
  const [, domain, method, path, headers, params, auth, mutating] = m;
  const v = validateApiSpec({
    domain,
    method,
    path,
    headers: headers ? headers.split(',').filter(Boolean) : [],
    params: params ? params.split(',').filter(Boolean) : [],
    auth: auth || null,
    mutating: mutating === 'true',
  });
  return v.ok ? v.spec : null;
}

/** Extract every valid api-spec from a set of memory entries (the shape
 *  getMemoryOnline returns: { text, at, id }), optionally filtered to a method
 *  and/or path. De-dupes on (domain,method,path) keeping the LATEST entry, so a
 *  re-recorded spec wins. Carries the note `id` so a stale spec can be deleted.
 *  KEYS ONLY by construction. */
export function apiSpecsFromEntries(entries, { method, path } = {}) {
  const wantMethod = method ? String(method).toUpperCase() : null;
  const wantPath = path ? pathOf(path) : null;
  const byKey = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    const s = parseApiSpec(e?.text);
    if (!s) continue;
    if (wantMethod && s.method !== wantMethod) continue;
    if (wantPath && s.path !== wantPath) continue;
    byKey.set(`${s.domain} ${s.method} ${s.path}`, { ...s, id: e?.id ?? null, at: e?.at ?? null });
  }
  return [...byKey.values()];
}

/** Build an API spec from a NON-PHI captured request (electron/browser/net.mjs
 *  requestMeta output: { method, url, header_names, mutating }) plus the param
 *  placeholder KEYS the body carried and the `me.*` auth ref. Values NEVER enter
 *  here — headers are NAMES, params are KEYS, auth is a me.* ref. Returns the spec
 *  object (unvalidated; recordApiSpec validates before writing). */
export function apiSpecFromRequest(req = {}, { params, auth } = {}) {
  return {
    domain: req.url,
    method: req.method || 'GET',
    path: req.url,
    headers: Array.isArray(req.header_names) ? req.header_names : [],
    params: Array.isArray(params) ? params : [],
    auth: auth || null,
    mutating: req.mutating ?? isMutatingMethod(req.method),
  };
}

/** RECORD a discovered API spec to the domain-keyed `site` memory (NON-PHI,
 *  keys-only). Validates first (rejects any value-shaped token), then writes the
 *  canonical line via addMemoryOnline('site', domain, …, { kind:'api-spec' }).
 *  Returns the addMemoryOnline result, or throws on an invalid (value-bearing)
 *  spec so a leak can never be written. */
export async function recordApiSpec(spec) {
  const v = validateApiSpec(spec);
  if (!v.ok) throw new Error(`refusing to record api-spec: ${v.error}`);
  const line = formatApiSpec(v.spec);
  return addMemoryOnline('site', v.spec.domain, line, { kind: API_SPEC_KIND });
}

/** RECALL a domain's known API specs from `site` memory (online, with the local
 *  cache fallback memory.mjs provides). The agent/playbook calls this at the start
 *  of a task BEFORE falling back to the browser — if a spec exists, it `curl`s it.
 *  Returns { domain, specs:[…], online }. KEYS ONLY by construction. */
export async function recallApiSpecs(urlOrHost, { method, path } = {}) {
  const domain = specDomain(urlOrHost);
  const mem = await getMemoryOnline('site', domain);
  return {
    domain,
    specs: apiSpecsFromEntries(mem.entries, { method, path }),
    online: mem.online !== false,
  };
}

export { SAFE_METHODS };
