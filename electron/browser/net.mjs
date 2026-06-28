// Network observation + request replay — the Playwright speed lever.
//
// Playwright's biggest edge over a click-by-click RPA driver: it can READ the
// page's own XHR/fetch traffic and REPLAY the underlying request directly, often
// skipping the rendered UI entirely. The fastest click is the one you never make:
//   - OBSERVE: watch the network while the page (or a tiny nudge) runs, and learn
//     which API call actually carries the data / does the work.
//   - REPLAY: re-issue that request through the page's OWN authenticated context
//     (page.request.*), so the agent grabs a JSON response or POSTs a payload
//     without driving the DOM.
//
// This module is the SHARED core used by both consumers:
//   - the raw driver CLI (electron/browser/cli.mjs) — `net-observe` / `net-replay`
//     verbs the full-agent path uses to DISCOVER the fast path, and
//   - a tool's step body (via ctx) — once discovered, the fast path is CAPTURED
//     into a step-structured tool so the next run skips the UI.
//
// It LAUNCHES NOTHING and opens no new CDP client: callers pass an already
// resolved Playwright `page` (from connect.mjs). One source of truth so the verb
// CLI and tools observe/replay identically.
//
// ─── PHI / safety invariants (load-bearing) ──────────────────────────────────
// Observation reports NON-PHI request METADATA by default: method, url, resource
// type, status, and content-type. Response/request BODIES are PHI-suspect (they
// can carry a patient record, a token, an SSN) so they are NEVER captured unless
// the caller explicitly opts in with { bodies: true } AND accepts that the
// payload lands only in THIS process — exactly like fill-ref's resolved value, it
// must never be written to a synced artifact, memory, or a tool's code.
//
// A REPLAY that mutates (POST/PUT/PATCH/DELETE — anything but GET/HEAD) is a
// SIDE EFFECT, identical to clicking a Submit button: it stays HUMAN-GATED. The
// replay helper REFUSES a mutating method unless { allowMutation: true } is
// passed (the runner/tool sets that only on an explicit, human-confirmed submit,
// and only inside a step marked sideEffect:true). A GET/HEAD replay is a safe
// read and needs no gate.

/** HTTP methods that only READ — safe to replay without a human gate. */
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Is a method a mutating (side-effecting) request? Everything not in SAFE_METHODS.
 *  Used by both the replay gate and the tool-scaffolder (a captured mutating
 *  request becomes a sideEffect:true step). */
export function isMutatingMethod(method) {
  return !SAFE_METHODS.has(String(method || 'GET').toUpperCase());
}

/** Should a request be reported as a page API call (vs a static asset)? We keep
 *  xhr/fetch (the data plane) and drop documents, images, fonts, stylesheets,
 *  media — the stuff that's never the "underlying request" a tool would replay. */
const API_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'websocket', 'eventsource']);
export function isApiRequest(resourceType) {
  return API_RESOURCE_TYPES.has(String(resourceType || ''));
}

/** Normalize a Playwright request into a NON-PHI metadata row. NEVER includes a
 *  body unless the caller already decided to (we only get url/method/headers
 *  here — header VALUES can be sensitive (cookies/auth), so we report only the
 *  header NAMES present, never their values). */
export function requestMeta(req) {
  let headerNames = [];
  try { headerNames = Object.keys(req.headers() || {}); } catch { /* ignore */ }
  return {
    method: req.method(),
    url: req.url(),
    resourceType: req.resourceType(),
    isNavigation: req.isNavigationRequest?.() ?? false,
    mutating: isMutatingMethod(req.method()),
    header_names: headerNames, // names only — values are PHI/cred-suspect
  };
}

/** Match a request URL against a substring filter (case-insensitive). An empty
 *  filter matches everything. Kept tiny + pure so it's unit-testable. */
export function urlMatches(url, filter) {
  if (!filter) return true;
  return String(url || '').toLowerCase().includes(String(filter).toLowerCase());
}

/**
 * OBSERVE the page's network for a window of time and return the API requests
 * (xhr/fetch) seen, as NON-PHI metadata rows. This is the DISCOVERY step: run it
 * while the page loads or while a tiny UI nudge happens, then read which request
 * actually carries the data — that request is the tool's fast path.
 *
 * @param page                 a resolved Playwright page (from connect.mjs)
 * @param opts.filter          url substring to keep (default: keep all)
 * @param opts.durationMs      how long to watch (default 4000)
 * @param opts.includeAssets   also report documents/images/etc (default false)
 * @param opts.maxRows         cap rows returned (default 200)
 * @param opts.captureStatus   await each response to add status + content-type
 *                             (default true). NON-PHI: status code + mime only.
 * @returns { count, requests: [ { ...requestMeta, status?, content_type? } ] }
 *
 * BODIES ARE NEVER CAPTURED HERE. To read a specific response body the agent
 * replays the discovered request with net-replay (which lands the body in-process
 * only). This keeps the always-on observe stream PHI-free.
 */
export async function observeNetwork(page, opts = {}) {
  const {
    filter = '',
    durationMs = 4000,
    includeAssets = false,
    maxRows = 200,
    captureStatus = true,
  } = opts;

  const rows = [];
  const pending = [];

  const onRequest = (req) => {
    try {
      if (!includeAssets && !isApiRequest(req.resourceType())) return;
      if (!urlMatches(req.url(), filter)) return;
      if (rows.length >= maxRows) return;
      const meta = requestMeta(req);
      rows.push(meta);
      if (captureStatus) {
        // Attach status/content-type when the response settles — METADATA only.
        pending.push(
          req
            .response()
            .then((res) => {
              if (!res) return;
              meta.status = res.status();
              const h = res.headers() || {};
              meta.content_type = h['content-type'] || null;
            })
            .catch(() => {}),
        );
      }
    } catch {
      /* a request can vanish mid-flight; skip it */
    }
  };

  page.on('request', onRequest);
  try {
    await page.waitForTimeout(durationMs);
  } finally {
    page.off('request', onRequest);
  }
  // Give in-flight responses a brief chance to resolve their status.
  if (pending.length) {
    await Promise.race([
      Promise.allSettled(pending),
      page.waitForTimeout(1500),
    ]).catch(() => {});
  }
  return { count: rows.length, requests: rows };
}

/**
 * REPLAY a request through the page's OWN authenticated context (page.request),
 * so the agent reads a JSON response (or POSTs a payload) WITHOUT driving the
 * DOM. This is the on-ramp to a tier-1 API tool: once a replay reliably returns
 * the data, capture it as the tool's fast path.
 *
 * SAFETY GATE (load-bearing): a MUTATING method (anything but GET/HEAD/OPTIONS)
 * is a side effect — the same category as clicking Submit. It is REFUSED unless
 * the caller passes { allowMutation: true }, which the runner/tool sets ONLY for
 * an explicit, human-confirmed submit inside a sideEffect:true step.
 *
 * @param page                a resolved Playwright page
 * @param spec.method         HTTP method (default GET)
 * @param spec.url            absolute or page-relative URL
 * @param spec.headers        extra request headers (caller's responsibility to
 *                            keep PHI/creds out — prefer the page's own session)
 * @param spec.data           request body (string or JSON-serializable). For a
 *                            mutating replay this is the payload; the caller must
 *                            have resolved any me-dot / data refs IN-PROCESS first.
 * @param opts.allowMutation  required to be true for a non-safe method
 * @param opts.maxBodyChars   cap on returned body text (default 200_000)
 * @returns { status, ok, content_type, body, json? }  — body lands IN THIS
 *          PROCESS ONLY (PHI-suspect; never write it to an artifact/memory).
 * @throws Error('replay refused: …') when a mutating method lacks allowMutation.
 */
export async function replayRequest(page, spec = {}, opts = {}) {
  const method = String(spec.method || 'GET').toUpperCase();
  const url = spec.url;
  if (!url) throw new Error('replay needs a url');
  if (isMutatingMethod(method) && !opts.allowMutation) {
    throw new Error(
      `replay refused: ${method} ${url} is a side-effecting (mutating) request — ` +
        'it must be human-gated. Pass allowMutation only from an explicit, ' +
        'confirmed submit inside a sideEffect:true step.',
    );
  }
  const maxBodyChars = opts.maxBodyChars ?? 200_000;
  const reqOpts = {};
  if (spec.headers && typeof spec.headers === 'object') reqOpts.headers = spec.headers;
  if (spec.data !== undefined) {
    reqOpts.data = typeof spec.data === 'string' ? spec.data : JSON.stringify(spec.data);
  }
  // page.request shares the page's cookies/auth — the request is made AS the
  // signed-in user, no re-auth, no DOM.
  const res = await page.request.fetch(url, { method, ...reqOpts });
  const headers = res.headers() || {};
  const content_type = headers['content-type'] || null;
  let body = '';
  try { body = await res.text(); } catch { body = ''; }
  if (body.length > maxBodyChars) body = body.slice(0, maxBodyChars) + '\n…[truncated]';
  let json;
  if (content_type && /\bjson\b/.test(content_type)) {
    try { json = JSON.parse(body); } catch { /* leave json undefined */ }
  }
  return { status: res.status(), ok: res.ok(), content_type, body, ...(json !== undefined ? { json } : {}) };
}
