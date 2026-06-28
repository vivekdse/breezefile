// Unit tests for the network observe/replay helpers (Operator Speed — the API
// shortcut). Pure functions + a fake page; no browser, no app, CI-safe. Pins:
//   - request metadata is NON-PHI (names only, never header values/bodies),
//   - the mutating-method REPLAY gate (a side effect stays human-gated),
//   - the API-vs-asset filter and url filter.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SAFE_METHODS,
  isMutatingMethod,
  isApiRequest,
  requestMeta,
  urlMatches,
  observeNetwork,
  replayRequest,
} from '../electron/browser/net.mjs';

// ─── method classification ───────────────────────────────────────────────────
test('GET/HEAD/OPTIONS are safe; POST/PUT/PATCH/DELETE mutate', () => {
  for (const m of SAFE_METHODS) assert.equal(isMutatingMethod(m), false);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) assert.equal(isMutatingMethod(m), true);
  // default (missing) method is GET → safe
  assert.equal(isMutatingMethod(undefined), false);
});

test('isApiRequest keeps xhr/fetch, drops static assets', () => {
  assert.equal(isApiRequest('xhr'), true);
  assert.equal(isApiRequest('fetch'), true);
  assert.equal(isApiRequest('document'), false);
  assert.equal(isApiRequest('image'), false);
  assert.equal(isApiRequest(''), false);
});

test('urlMatches is a case-insensitive substring; empty filter matches all', () => {
  assert.equal(urlMatches('https://host/api/Orders', 'orders'), true);
  assert.equal(urlMatches('https://host/api/orders', 'invoices'), false);
  assert.equal(urlMatches('https://host/x', ''), true);
});

// ─── requestMeta: NON-PHI shape ──────────────────────────────────────────────
function fakeRequest({ method = 'GET', url = 'https://h/x', resourceType = 'fetch', headers = {} } = {}) {
  return {
    method: () => method,
    url: () => url,
    resourceType: () => resourceType,
    isNavigationRequest: () => false,
    headers: () => headers,
  };
}

test('requestMeta reports header NAMES only, never values (NON-PHI)', () => {
  const m = requestMeta(
    fakeRequest({
      method: 'POST',
      url: 'https://h/api/submit',
      headers: { authorization: 'Bearer SECRET', cookie: 'session=abc', 'content-type': 'application/json' },
    }),
  );
  assert.equal(m.method, 'POST');
  assert.equal(m.mutating, true);
  assert.deepEqual(m.header_names.sort(), ['authorization', 'content-type', 'cookie']);
  // No value of any header leaks into the metadata.
  const serialized = JSON.stringify(m);
  assert.equal(/SECRET|session=abc/.test(serialized), false);
});

// ─── observeNetwork: filters + NON-PHI rows ──────────────────────────────────
// A tiny fake page that lets us fire request events synchronously and returns
// fast from waitForTimeout (no real timers).
function fakePage() {
  const handlers = {};
  return {
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    off(ev, fn) { handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn); },
    async waitForTimeout() { /* immediate */ },
    _fire(ev, ...args) { (handlers[ev] || []).forEach((fn) => fn(...args)); },
  };
}

test('observeNetwork keeps only API requests matching the filter; no bodies', async () => {
  const page = fakePage();
  const p = observeNetwork(page, { filter: '/api/', durationMs: 0, captureStatus: false });
  // Fire a mix: an API call we want, an asset, and a non-matching API call.
  page._fire('request', fakeRequest({ url: 'https://h/api/orders', resourceType: 'xhr' }));
  page._fire('request', fakeRequest({ url: 'https://h/logo.png', resourceType: 'image' }));
  page._fire('request', fakeRequest({ url: 'https://h/other', resourceType: 'fetch' }));
  page._fire('request', fakeRequest({ method: 'POST', url: 'https://h/api/submit', resourceType: 'fetch' }));
  const result = await p;
  assert.equal(result.count, 2);
  assert.deepEqual(result.requests.map((r) => r.url).sort(), [
    'https://h/api/orders',
    'https://h/api/submit',
  ]);
  // Each row is metadata only — no `body` field anywhere.
  for (const r of result.requests) assert.equal('body' in r, false);
});

// ─── replayRequest: the human-gated mutating gate ────────────────────────────
function fakeReplayPage(captured) {
  return {
    request: {
      async fetch(url, opts) {
        captured.url = url;
        captured.opts = opts;
        return {
          status: () => 200,
          ok: () => true,
          headers: () => ({ 'content-type': 'application/json' }),
          async text() { return JSON.stringify({ ok: true }); },
        };
      },
    },
  };
}

test('replayRequest allows a GET read and parses JSON', async () => {
  const captured = {};
  const page = fakeReplayPage(captured);
  const r = await replayRequest(page, { method: 'GET', url: 'https://h/api/orders' });
  assert.equal(r.status, 200);
  assert.equal(r.ok, true);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(captured.opts.method, 'GET');
});

test('replayRequest REFUSES a mutating method without allowMutation (human-gated)', async () => {
  const page = fakeReplayPage({});
  await assert.rejects(
    () => replayRequest(page, { method: 'POST', url: 'https://h/api/submit', data: { a: 1 } }),
    /replay refused.*side-effecting|mutating/i,
  );
});

test('replayRequest allows a mutating method WITH explicit allowMutation', async () => {
  const captured = {};
  const page = fakeReplayPage(captured);
  const r = await replayRequest(
    page,
    { method: 'POST', url: 'https://h/api/submit', data: { a: 1 } },
    { allowMutation: true },
  );
  assert.equal(r.status, 200);
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.data, JSON.stringify({ a: 1 }));
});

test('replayRequest needs a url', async () => {
  const page = fakeReplayPage({});
  await assert.rejects(() => replayRequest(page, { method: 'GET' }), /needs a url/);
});
