// Runtime tests for the SHARED-ONLINE site-memory routing (task-3c9b1146cee2).
//
// The memory.mjs *Online helpers reach the shared store THROUGH Breeze main's
// localhost control API (/app/site-memory). Like tests/task-data.test.mjs, we
// run WITHOUT a live Electron app or browser by standing up a tiny stub that
// imitates that control endpoint, and we point readApi() at a temp api.json by
// overriding $HOME. We assert the routing contract:
//   - `site` scope round-trips the stub (online:true), maps notes→entries;
//   - `site` add POSTs the note + kind;
//   - `task` scope stays LOCAL (never touches the stub), online:false;
//   - when main is unreachable, `site` get falls back to the local cache offline.
//
// NON-PHI: site memory is selectors/how-to only. We assert no note BODY is ever
// surfaced as anything but the note text the caller stored (the PHI-guard itself
// lives server-side and is out of scope for this client unit test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

// Isolate HOME (→ api.json) and the memory cache dir before importing memory.mjs.
const HOME = mkdtempSync(join(tmpdir(), 'bz-mem-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME; // win parity, harmless on posix
process.env.BREEZE_MEMORY_DIR = mkdtempSync(join(tmpdir(), 'bz-mem-cache-'));
const apiFile = join(HOME, '.breezefile', 'api.json');
mkdirSync(dirname(apiFile), { recursive: true });

// ── Stub Breeze main: just the /app/site-memory control endpoint ─────────────
const STORE = []; // server-side notes
let lastPost = null;

function startStub() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.headers.authorization !== 'Bearer test-token') {
      res.writeHead(401).end('{}');
      return;
    }
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
          domain: body.domain,
          kind: body.kind || 'note',
          body: body.body,
          updated_at: '2026-06-27T00:00:00Z',
        };
        STORE.push(note);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: note.id, note }));
      });
      return;
    }
    res.writeHead(404).end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const server = await startStub();
const port = server.address().port;
writeApiFile(port);

function writeApiFile(p) {
  writeFileSync(apiFile, JSON.stringify({ port: p, token: 'test-token', pid: process.pid }));
}

// Import AFTER HOME/api.json are in place (memory.mjs reads them lazily per call,
// but importing late keeps the intent obvious).
const mem = await import(join(repoRoot, 'electron', 'browser', 'tools', 'memory.mjs'));

test('site add → online POST carries body + kind, returns the note id', async () => {
  const r = await mem.addMemoryOnline('site', 'https://www.example.com/path', 'h1 is a.story', {
    kind: 'selector',
  });
  assert.equal(r.online, true);
  assert.equal(r.ok, true);
  assert.ok(r.id, 'returns the server note id');
  assert.equal(lastPost.domain, 'example.com', 'domain normalized to registrable form');
  assert.equal(lastPost.kind, 'selector');
  assert.equal(lastPost.body, 'h1 is a.story');
});

test('site get → online recall maps server notes to entries', async () => {
  const r = await mem.getMemoryOnline('site', 'example.com');
  assert.equal(r.online, true);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].text, 'h1 is a.story');
  assert.ok(r.entries[0].id, 'entry carries the note id for later delete');
});

test('task scope stays LOCAL — never hits the stub, online:false', async () => {
  const before = STORE.length;
  const a = await mem.addMemoryOnline('task', 'task-xyz', 'click queue tab first');
  assert.equal(a.online, false);
  const g = await mem.getMemoryOnline('task', 'task-xyz');
  assert.equal(g.online, false);
  assert.equal(g.entries[0].text, 'click queue tab first');
  assert.equal(STORE.length, before, 'task notes never reach the shared store');
});

test('site get falls back to local cache OFFLINE (no Breeze)', async () => {
  // The successful recall above wrote a cache for example.com. Now kill the stub
  // and point api.json at a dead port so readApi succeeds but the fetch fails.
  await new Promise((r) => server.close(r));
  writeApiFile(1); // nothing listening
  const r = await mem.getMemoryOnline('site', 'example.com');
  assert.equal(r.online, false, 'reports offline');
  assert.equal(r.entries.length, 1, 'serves the last-synced cache');
  assert.equal(r.entries[0].text, 'h1 is a.story');
});

test.after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
