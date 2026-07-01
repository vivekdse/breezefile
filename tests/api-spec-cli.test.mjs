// Tests for wiring the api-spec recall/record helpers into the LIVE discovery
// flow (task-8ba139c23d18, Operator Speed):
//   - the new `breeze-tools api-spec record|recall` CLI verbs round-trip a
//     keys-only, domain-keyed spec through the shared site-memory store;
//   - `breeze-tools available <url>` AUTO-RECALLS the domain's specs and prefers
//     the API (prefer_api:true, api_specs populated) — no separate memory call;
//   - `promote-from` on an API-only (http-channel) solve AUTO-RECORDS the
//     api-spec alongside the emitted tool, and a value-bearing net-replay spec is
//     REFUSED (validateApiSpec gates every write path);
//   - recall surfaces a stored spec for a matching URL.
//
// These drive the runner as a SUBPROCESS (it calls process.exit) against the
// same localhost site-memory control stub tests/api-channel.test.mjs uses, so no
// live Electron/browser is needed. HOME/USERPROFILE (→ api.json), the memory
// cache dir, and the tools dir are all isolated per run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const cli = join(repoRoot, 'bin', 'breeze-tools.mjs');

// ── Isolated HOME (→ api.json), memory cache, and tools dir ───────────────────
const HOME = mkdtempSync(join(tmpdir(), 'bz-apispec-home-'));
const MEM = mkdtempSync(join(tmpdir(), 'bz-apispec-cache-'));
const TOOLS = mkdtempSync(join(tmpdir(), 'bz-apispec-tools-'));
const apiFile = join(HOME, '.breezefile', 'api.json');
mkdirSync(dirname(apiFile), { recursive: true });

// ── Stub Breeze main: the /app/site-memory control endpoint (GET + POST) ──────
const STORE = [];
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
test.after(() => { server.close(); rmSync(HOME, { recursive: true, force: true }); rmSync(MEM, { recursive: true, force: true }); rmSync(TOOLS, { recursive: true, force: true }); });

const execFileP = promisify(execFile);

// Drive the runner as a subprocess with the isolated env. MUST be non-blocking
// (execFile, not spawnSync): the site-memory stub runs in THIS process's event
// loop, so a blocking spawn would deadlock — the stub could never answer the
// subprocess's request. Returns { code, stdout, stderr, json }.
async function run(args) {
  const opts = {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      HOME,
      USERPROFILE: HOME,
      BREEZE_MEMORY_DIR: MEM,
      BREEZE_TOOLS_DIR: TOOLS,
    },
  };
  let stdout = '', stderr = '', code = 0;
  try {
    const r = await execFileP('node', [cli, ...args], opts);
    stdout = r.stdout; stderr = r.stderr;
  } catch (e) {
    // execFile rejects on a non-zero exit; the streams + code hang off the error.
    stdout = e.stdout ?? ''; stderr = e.stderr ?? ''; code = e.code ?? 1;
  }
  let json;
  try { json = JSON.parse(stdout); } catch { /* non-JSON stdout */ }
  return { code, stdout, stderr, json };
}

function writeJson(name, obj) {
  const p = join(mkdtempSync(join(tmpdir(), 'bz-apispec-in-')), name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

// ─── the new CLI verbs: record → recall round-trip ───────────────────────────
test('api-spec record writes a keys-only domain-keyed note; recall returns it', async () => {
  const rec = await run([
    'api-spec', 'record',
    '--url', 'https://payer.example.com/api/claims',
    '--method', 'POST',
    '--header', 'content-type', '--header', 'accept',
    '--param', 'member_id',
    '--auth', 'me.payer_token',
  ]);
  assert.equal(rec.code, 0, rec.stderr);
  assert.equal(rec.json.status, 'success');
  assert.equal(rec.json.domain, 'payer.example.com', 'note keyed by normalized domain');
  assert.equal(rec.json.path, '/api/claims', 'path stripped to the URL path');
  assert.equal(rec.json.mutating, true, 'POST is mutating');
  // The persisted note body is keys-only NON-PHI — no value-shaped token.
  const note = STORE.find((n) => n.kind === 'api-spec' && /member_id/.test(n.body));
  assert.ok(note, 'an api-spec note was persisted');
  assert.match(note.body, /^api-spec domain:payer\.example\.com/);
  assert.equal(note.domain, 'payer.example.com');
  assert.ok(!/@|Bearer|\d{3}-\d{2}-\d{4}/.test(note.body), 'no value-shaped token in the note');

  const rc = await run(['api-spec', 'recall', 'https://payer.example.com/claims']);
  assert.equal(rc.code, 0, rc.stderr);
  assert.equal(rc.json.domain, 'payer.example.com');
  assert.equal(rc.json.prefer_api, true);
  assert.equal(rc.json.count, 1);
  assert.equal(rc.json.api_specs[0].method, 'POST');
  assert.equal(rc.json.api_specs[0].auth, 'me.payer_token');
  assert.deepEqual(rc.json.api_specs[0].params, ['member_id']);
});

test('api-spec record REFUSES a value-shaped token (never persists a leak)', async () => {
  const before = STORE.length;
  const r = await run(['api-spec', 'record', '--url', 'https://x.com/a', '--auth', 'Bearer-abc123']);
  assert.equal(r.code, 1);
  assert.equal(r.json.status, 'error');
  assert.match(r.json.error, /me\.\*|value/i);
  assert.equal(STORE.length, before, 'nothing was written');
});

test('api-spec recall filters by method/path', async () => {
  // The stored spec is POST /api/claims — a GET filter yields nothing.
  const miss = await run(['api-spec', 'recall', 'payer.example.com', '--method', 'GET']);
  assert.equal(miss.json.count, 0);
  assert.equal(miss.json.prefer_api, false);
  const hit = await run(['api-spec', 'recall', 'payer.example.com', '--path', '/api/claims']);
  assert.equal(hit.json.count, 1);
});

// ─── available <url> AUTO-RECALLS + prefers the API ──────────────────────────
test('available <url> auto-recalls the domain api-spec and prefers it', async () => {
  const a = await run(['available', 'https://payer.example.com/claims']);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(a.json.prefer_api, true, 'a known spec means prefer_api:true');
  assert.ok(Array.isArray(a.json.api_specs) && a.json.api_specs.length >= 1);
  assert.equal(a.json.api_specs[0].domain, 'payer.example.com');
  assert.equal(a.json.api_specs[0].method, 'POST');
});

test('available <url> on an unknown domain has prefer_api:false, empty api_specs', async () => {
  const a = await run(['available', 'https://unknown.example.org/x']);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(a.json.prefer_api, false);
  assert.deepEqual(a.json.api_specs, []);
});

// ─── promote-from an http (API-only) solve AUTO-RECORDS the api-spec ─────────
test('promote-from an API-only solve auto-records the api-spec alongside the tool', async () => {
  const actions = writeJson('actions.json', [
    { verb: 'goto', url: 'https://api-site.example.com/orders' },
    { verb: 'net-replay', method: 'GET', url: 'https://api-site.example.com/api/orders', header_names: ['accept'], auth: 'me.api_token' },
  ]);
  const p = await run(['promote-from', 'api-site-orders', '--match', 'api-site.example.com', '--actions', actions]);
  assert.equal(p.code, 0, p.stderr);
  assert.equal(p.json.status, 'success');
  assert.equal(p.json.channel, 'http', 'API-only solve is an http-channel tool');
  assert.ok(Array.isArray(p.json.api_specs_recorded) && p.json.api_specs_recorded.length === 1);
  assert.equal(p.json.api_specs_recorded[0].domain, 'api-site.example.com');
  assert.equal(p.json.api_specs_recorded[0].path, '/api/orders');

  // The note is now recallable for the next task on that domain — keys-only.
  const rc = await run(['api-spec', 'recall', 'https://api-site.example.com/orders']);
  assert.equal(rc.json.count, 1);
  assert.equal(rc.json.api_specs[0].method, 'GET');
  assert.equal(rc.json.api_specs[0].auth, 'me.api_token');
  const note = STORE.find((n) => n.kind === 'api-spec' && /api-site\.example\.com/.test(n.body));
  assert.ok(!/@|Bearer-|\d{3}-\d{2}-\d{4}/.test(note.body), 'auto-recorded note is keys-only');
});

test('promote-from a BROWSER solve records NO api-spec (channel is browser)', async () => {
  const before = STORE.filter((n) => n.kind === 'api-spec').length;
  const actions = writeJson('browser.json', [
    { verb: 'goto', url: 'https://form-site.example.com/login' },
    { verb: 'fill', selector: '#user', ref: '{{username}}' },
    { verb: 'click', selector: 'button[type=submit]' },
  ]);
  const p = await run(['promote-from', 'form-site-login', '--match', 'form-site.example.com', '--actions', actions]);
  assert.equal(p.code, 0, p.stderr);
  assert.equal(p.json.channel, 'browser');
  assert.deepEqual(p.json.api_specs_recorded, [], 'a DOM solve records no api-spec');
  const after = STORE.filter((n) => n.kind === 'api-spec').length;
  assert.equal(after, before, 'no api-spec note written for a browser solve');
});

test('promote-from an http solve with a value-bearing net-replay is REFUSED (validateApiSpec gates)', async () => {
  const before = STORE.filter((n) => n.kind === 'api-spec').length;
  const actions = writeJson('leaky.json', [
    { verb: 'goto', url: 'https://leak-site.example.com/x' },
    // auth is a literal token, not a me.* ref — validateApiSpec must refuse it.
    { verb: 'net-replay', method: 'GET', url: 'https://leak-site.example.com/api/x', auth: 'Bearer-secret-123' },
  ]);
  const p = await run(['promote-from', 'leak-site-x', '--match', 'leak-site.example.com', '--actions', actions]);
  assert.equal(p.code, 1, 'a value-bearing api-spec must fail the command');
  assert.equal(p.json.status, 'error');
  assert.match(p.json.error, /REFUSED|value|me\.\*/i);
  const after = STORE.filter((n) => n.kind === 'api-spec').length;
  assert.equal(after, before, 'no leaked api-spec was persisted');
});
