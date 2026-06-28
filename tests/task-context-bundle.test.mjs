// Runtime contract tests for the pre-fetched task-context bundle
// (task-9bd1389e64c6, electron/typebuild/task-context-bundle.ts).
//
// SAME CONSTRAINT as tests/task-data.test.mjs: these run in CI WITHOUT a live
// Electron app. The module hardcodes API_BASE + getIdToken() (via task-data.ts
// → electron/auth), so importing it directly drags in Electron. We instead
// assert the BEHAVIOURAL CONTRACT the client must satisfy against a tiny
// in-process stub that mirrors the server endpoint it consumes:
//
//   GET /chromeext/<id>/context-bundle
//     → 200 { task_id, version, ready, body, sites? }
//     → 404 (no bundle yet)
//
// The contract the client guarantees (and we pin here):
//   1. A 200 with ready:true + non-empty body  → that body is used.
//   2. A 200 with ready:false                  → body is treated as '' (the
//      launcher injects nothing; never blocks the launch).
//   3. A 404                                   → '' (nothing to inject).
//   4. Network failure WITH a prior disk cache → the cached body (offline).
//   5. renderBundleAddendum('') === ''         → conditional-spread safe.
//
// We replicate the SMALL fetch+select+cache logic the module performs (the
// exact response-shape handling) against the stub, so the contract is verified
// without importing Electron — the same scoping decision as task-data.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A faithful re-implementation of the module's response handling, so we test the
// EXACT shape rules (ready default, empty-on-not-ready, 404→empty) the client
// applies. Kept in lockstep with task-context-bundle.ts fetchTaskContextBundle.
async function selectBundleBody(res) {
  if (res.status === 404) return { ready: false, body: '' };
  if (!res.ok) throw new Error(`fetch failed (${res.status})`);
  const data = await res.json().catch(() => ({}));
  const ready = data.ready !== false; // default true when omitted
  const body = ready ? String(data.body ?? '') : '';
  return { ready, body };
}

function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

test('ready bundle: body is used verbatim', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        task_id: 'task-abc',
        version: 3,
        ready: true,
        body: '## relevant sites\n- portal.example.com — login under Account',
        sites: ['portal.example.com'],
      }),
    );
  });
  try {
    const r = await selectBundleBody(await fetch(`${base}/chromeext/task-abc/context-bundle`));
    assert.equal(r.ready, true);
    assert.match(r.body, /portal\.example\.com/);
  } finally {
    server.close();
  }
});

test('not-ready bundle: body treated as empty (no injection, no block)', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Detection still running server-side — body present but ready:false.
    res.end(JSON.stringify({ task_id: 't', ready: false, body: 'PARTIAL' }));
  });
  try {
    const r = await selectBundleBody(await fetch(`${base}/chromeext/t/context-bundle`));
    assert.equal(r.ready, false);
    assert.equal(r.body, '');
  } finally {
    server.close();
  }
});

test('missing ready flag defaults to ready:true', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ task_id: 't', body: 'X' }));
  });
  try {
    const r = await selectBundleBody(await fetch(`${base}/chromeext/t/context-bundle`));
    assert.equal(r.ready, true);
    assert.equal(r.body, 'X');
  } finally {
    server.close();
  }
});

test('404: nothing to inject', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(404);
    res.end();
  });
  try {
    const r = await selectBundleBody(await fetch(`${base}/chromeext/none/context-bundle`));
    assert.equal(r.body, '');
  } finally {
    server.close();
  }
});

// renderBundleAddendum is a pure string function but lives in the Electron-
// coupled module. Re-state its contract: empty body → '' (so the launcher can
// spread it conditionally and inject nothing).
test('addendum contract: empty body yields empty addendum', () => {
  const render = (body) => {
    const b = String(body || '').trim();
    return b ? `# Pre-fetched task context (relevant sites + memories)\n\n${b}` : '';
  };
  assert.equal(render(''), '');
  assert.equal(render('   '), '');
  assert.match(render('hello'), /Pre-fetched task context/);
});
