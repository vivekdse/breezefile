// Tests for the execution-channel work (task-9704c5bc1575, Operator Speed):
//   - `channel` is a NON-PHI label on the tool schema, defaulting to 'browser'
//     when tool.json omits it (every existing tool unchanged), validated, and
//     surfaced in the step-plan summary;
//   - promotion emits an `http`-channel tool when the solve was an intercepted
//     API call (all value-bearing actions are net-replay), and 'browser' when a
//     real DOM verb did the work;
//   - an emitted http tool round-trips through the registry (normalizes to a
//     resumable steps[] whose net-replay steps carry ctx.replay + sideEffect on
//     mutating methods, and NO literal value);
//   - the api-spec site-memory note is KEYS-ONLY, domain-keyed, and recall
//     returns it; a value-shaped token is rejected.
//
// The site-memory round-trip reuses the localhost-control stub pattern from
// tests/site-memory-online.test.mjs (no live Electron/browser).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

// Isolate HOME (→ api.json) + memory cache BEFORE importing memory-backed modules.
const HOME = mkdtempSync(join(tmpdir(), 'bz-apichan-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BREEZE_MEMORY_DIR = mkdtempSync(join(tmpdir(), 'bz-apichan-cache-'));
const apiFile = join(HOME, '.breezefile', 'api.json');
mkdirSync(dirname(apiFile), { recursive: true });

// ── Stub Breeze main: just the /app/site-memory control endpoint ─────────────
const STORE = [];
let lastPost = null;
function startStub() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.headers.authorization !== 'Bearer test-token') { res.writeHead(401).end('{}'); return; }
    if (url.pathname === '/app/site-memory' && req.method === 'GET') {
      const domain = url.searchParams.get('domain') || '';
      const notes = STORE.filter((n) => n.domain === domain);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ domain, notes, offline: false }));
      return;
    }
    if (url.pathname === '/app/site-memory' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        lastPost = body;
        const note = {
          id: 'site-' + STORE.length,
          domain: body.domain || null,
          kind: body.kind || 'note',
          body: body.body,
          updated_at: '2026-07-01T00:00:00Z',
        };
        STORE.push(note);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: note.id, note }));
      });
      return;
    }
    res.writeHead(404).end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
const server = await startStub();
writeFileSync(apiFile, JSON.stringify({ port: server.address().port, token: 'test-token', pid: process.pid }));
test.after(() => server.close());

const {
  scaffoldTool,
  channelForActions,
  looksLikeLiteralValue,
} = await import(join(repoRoot, 'electron', 'browser', 'tools', 'promote.mjs'));
const {
  toolChannel,
  CHANNELS,
  validateTool,
  normalizeSteps,
  stepPlanSummary,
} = await import(join(repoRoot, 'electron', 'browser', 'tools', 'registry.mjs'));
const apiSpec = await import(join(repoRoot, 'electron', 'browser', 'tools', 'api-spec.mjs'));

// An API-only solve: the operative work is an intercepted request (net-replay),
// wrapped only by inert scaffolding (goto). No DOM verb.
const API_ACTIONS = [
  { verb: 'goto', url: 'https://payer.example.com/claims' },
  { verb: 'net-replay', method: 'POST', url: 'https://payer.example.com/api/claims' },
];
// A browser solve: a real DOM verb (fill/click) does the work.
const BROWSER_ACTIONS = [
  { verb: 'goto', url: 'https://payer.example.com/login' },
  { verb: 'fill', selector: '#user', ref: '{{username}}' },
  { verb: 'click', selector: 'button[type=submit]' },
];

// ─── channel label: default + validation + surfacing ─────────────────────────
test('toolChannel defaults to browser when tool.json omits channel', () => {
  assert.equal(toolChannel({}), 'browser');
  assert.equal(toolChannel({ channel: 'http' }), 'http');
  assert.equal(toolChannel({ channel: 'HTTP' }), 'http');
  assert.equal(toolChannel({ channel: 'nonsense' }), 'browser'); // unknown → default
  assert.deepEqual(CHANNELS, ['browser', 'http']);
});

test('validateTool accepts a valid channel and rejects a bad one', () => {
  assert.equal(validateTool({ id: 'x', name: 'X', description: 'd', match: ['a'], channel: 'http' }).ok, true);
  const bad = validateTool({ id: 'x', name: 'X', description: 'd', match: ['a'], channel: 'grpc' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /invalid channel/);
});

test('stepPlanSummary surfaces the channel label (default browser)', () => {
  const s = stepPlanSummary({ steps: [{ name: 'a', sideEffect: false }] }, null);
  assert.equal(s.channel, 'browser');
  const h = stepPlanSummary({ channel: 'http', steps: [{ name: 'a', sideEffect: true }] }, null);
  assert.equal(h.channel, 'http');
});

// ─── channelForActions + promotion emits an http tool ────────────────────────
test('channelForActions: API-only solve → http, DOM verb → browser', () => {
  assert.equal(channelForActions(API_ACTIONS), 'http');
  assert.equal(channelForActions(BROWSER_ACTIONS), 'browser');
  assert.equal(channelForActions([{ verb: 'goto', url: 'x' }]), 'browser'); // no replay
  // a net-replay mixed with a click is still browser (the click did work)
  assert.equal(
    channelForActions([{ verb: 'net-replay', method: 'GET', url: 'x' }, { verb: 'click', selector: 'b' }]),
    'browser',
  );
});

test('scaffoldTool sets channel:http for an API-only solve, browser otherwise', () => {
  const api = scaffoldTool({ id: 'payer-claim', match: ['payer.example.com'], actions: API_ACTIONS });
  assert.equal(api.meta.channel, 'http');
  assert.equal(toolChannel(api.meta), 'http');
  const br = scaffoldTool({ id: 'payer-login', match: ['payer.example.com'], actions: BROWSER_ACTIONS });
  assert.equal(br.meta.channel, undefined, 'browser is the default — no channel field emitted');
  assert.equal(toolChannel(br.meta), 'browser');
});

// ─── an http tool round-trips through the registry + carries no literal ───────
test('an emitted http tool normalizes to resumable steps; mutating replay is gated; NO literal value', async () => {
  const { meta, script } = scaffoldTool({ id: 'payer-claim', match: ['payer.example.com'], actions: API_ACTIONS });
  assert.equal(validateTool(meta).ok, true);
  // Write + import the emitted source: proves it is valid JS with a real steps[].
  const dir = mkdtempSync(join(tmpdir(), 'http-emit-'));
  try {
    const file = join(dir, 'tool.mjs');
    writeFileSync(file, script);
    const mod = await import(pathToFileURL(file).href);
    const n = normalizeSteps(mod);
    assert.equal(n.ok, true, n.errors.join('; '));
    // the mutating POST replay is a sideEffect:true step (human-gated, never re-fired)
    const replayStep = meta.steps.find((s) => s.name.startsWith('net-replay'));
    assert.equal(replayStep.sideEffect, true);
    // the emitted source calls ctx.replay (the API channel) and inlines NO literal
    assert.match(script, /ctx\.replay\(/);
    assert.ok(!/123-45-6789|hunter2/.test(script), 'no literal secret in emitted code');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffoldTool still refuses a captured fill carrying a literal value (PHI leak)', () => {
  assert.throws(
    () => scaffoldTool({ id: 'leaky', match: ['x'], actions: [{ verb: 'fill', selector: '#s', value: '123-45-6789' }] }),
    /literal value|placeholder/i,
  );
});

// ─── api-spec note: keys-only, domain-keyed, recall ──────────────────────────
test('validateApiSpec accepts a keys-only spec and rejects value-shaped tokens', () => {
  const good = apiSpec.validateApiSpec({
    domain: 'https://payer.example.com/claims',
    method: 'POST',
    path: 'https://payer.example.com/api/claims',
    headers: ['content-type', 'accept'],
    params: ['member_id', 'claim.id'],
    auth: 'me.payer_token',
  });
  assert.equal(good.ok, true);
  assert.equal(good.spec.domain, 'payer.example.com');
  assert.equal(good.spec.path, '/api/claims', 'path stripped to the URL path (no host/query)');
  assert.equal(good.spec.mutating, true, 'POST is mutating');

  // a param that is a real value (an email) is rejected
  assert.equal(
    apiSpec.validateApiSpec({ domain: 'x.com', method: 'GET', path: '/a', params: ['a@b.com'] }).ok,
    false,
  );
  // an auth that is a literal token (not me.*) is rejected
  assert.equal(
    apiSpec.validateApiSpec({ domain: 'x.com', method: 'GET', path: '/a', auth: 'Bearer-abc123' }).ok,
    false,
  );
  // a header that is a "Name: value" pair is rejected
  assert.equal(
    apiSpec.validateApiSpec({ domain: 'x.com', method: 'GET', path: '/a', headers: ['authorization: xyz'] }).ok,
    false,
  );
});

test('formatApiSpec round-trips through parseApiSpec (keys only)', () => {
  const spec = {
    domain: 'payer.example.com', method: 'POST', path: '/api/claims',
    headers: ['content-type'], params: ['member_id'], auth: 'me.payer_token', mutating: true,
  };
  const line = apiSpec.formatApiSpec(spec);
  assert.ok(line.startsWith('api-spec domain:payer.example.com'));
  const parsed = apiSpec.parseApiSpec(line);
  assert.equal(parsed.method, 'POST');
  assert.equal(parsed.path, '/api/claims');
  assert.deepEqual(parsed.params, ['member_id']);
  assert.equal(parsed.auth, 'me.payer_token');
  assert.equal(parsed.mutating, true);
  // a non-api-spec note is ignored
  assert.equal(apiSpec.parseApiSpec('h1 is a.story'), null);
});

test('apiSpecFromRequest builds a spec from NON-PHI requestMeta (header NAMES only)', () => {
  const spec = apiSpec.apiSpecFromRequest(
    { method: 'POST', url: 'https://payer.example.com/api/claims', header_names: ['content-type', 'accept'], mutating: true },
    { params: ['member_id'], auth: 'me.payer_token' },
  );
  const v = apiSpec.validateApiSpec(spec);
  assert.equal(v.ok, true);
  assert.equal(v.spec.path, '/api/claims');
});

test('recordApiSpec writes a domain-keyed api-spec note; recallApiSpecs returns it', async () => {
  const r = await apiSpec.recordApiSpec({
    domain: 'https://payer.example.com/claims',
    method: 'POST', path: 'https://payer.example.com/api/claims',
    headers: ['content-type'], params: ['member_id'], auth: 'me.payer_token',
  });
  assert.equal(r.ok, true);
  assert.equal(lastPost.domain, 'payer.example.com', 'note keyed by normalized domain');
  assert.equal(lastPost.kind, 'api-spec');
  assert.match(lastPost.body, /^api-spec domain:payer\.example\.com/);
  assert.ok(!/123|@|Bearer/.test(lastPost.body), 'no value-shaped token in the note');

  const recalled = await apiSpec.recallApiSpecs('payer.example.com');
  assert.equal(recalled.domain, 'payer.example.com');
  assert.equal(recalled.specs.length, 1);
  assert.equal(recalled.specs[0].method, 'POST');
  assert.equal(recalled.specs[0].auth, 'me.payer_token');
});

test('recordApiSpec REFUSES a value-bearing spec (never writes a leak)', async () => {
  await assert.rejects(
    () => apiSpec.recordApiSpec({ domain: 'x.com', method: 'GET', path: '/a', params: ['555-12-3456'] }),
    /refusing to record|value/i,
  );
});
