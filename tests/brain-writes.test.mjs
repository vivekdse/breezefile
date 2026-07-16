// Runtime contract tests for the brain WRITE side (task-1a6da52a3017
// "Brain C1" — client edge capture, electron/typebuild/brain-writes.ts).
//
// SAME CONSTRAINT as tests/anticipatory-context.test.mjs: these run in CI
// WITHOUT a live Electron app. brain-writes.ts hardcodes BRAIN_BASE (via
// brain-client.ts) + getIdToken() (via electron/typebuild/auth.ts), so
// importing it directly drags in Electron. We instead assert the BEHAVIOURAL
// CONTRACT against a tiny in-process stub mirroring the server endpoints it
// consumes (POST /brain/observations, /brain/tools, /brain/edges), with a
// faithful re-implementation of brain-writes.ts's classifyStatus/postBrain
// mapping kept in lockstep with the real module.
//
// The contract pinned here:
//   1. A 2xx body maps to {ok:true, nodeId/edgeId, duplicate?}.
//   2. 401/403 -> {ok:false, reason:'auth'} — never throws.
//   3. 422 with {error, hits} (chromeext-parity PHI envelope) -> {ok:false,
//      reason:'phi', hits} — hits carried through, body never echoed.
//   4. 422 with a tier-shaped detail -> {ok:false, reason:'tier'}.
//   5. 5xx -> {ok:false, reason:'server'}.
//   6. A network/transport failure (connection refused) -> {ok:false,
//      reason:'network'} — never throws, matching every other brain client
//      degrade-to-nothing path in this repo (brain-client.ts, site-memory.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ─── faithful re-implementation of brain-writes.ts's response mapping ──────

function classifyStatus(status, errBody) {
  const body = errBody && typeof errBody === 'object' ? errBody : {};
  if (status === 401 || status === 403) {
    return { ok: false, reason: 'auth', status };
  }
  if (status === 422) {
    const hits = Array.isArray(body.hits) ? body.hits.filter((h) => typeof h === 'string') : undefined;
    if (hits) {
      return { ok: false, reason: 'phi', status, hits };
    }
    const detail = String(body.detail || body.error || '');
    if (/tier/i.test(detail)) return { ok: false, reason: 'tier', status };
    return { ok: false, reason: 'invalid', status };
  }
  if (status >= 500) return { ok: false, reason: 'server', status };
  return { ok: false, reason: 'invalid', status };
}

async function postBrain(base, path, payload) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return classifyStatus(res.status, data);
  return { ok: true, status: res.status, data };
}

async function recordObservation(base, opts) {
  const result = await postBrain(base, '/brain/observations', {
    tier: opts.tier,
    kind: opts.kind,
    body: opts.body,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    nodeId: typeof result.data.node_id === 'string' ? result.data.node_id : undefined,
    duplicate: result.data.duplicate === true,
  };
}

async function proposeTool(base, opts) {
  const result = await postBrain(base, '/brain/tools', {
    code: opts.code,
    context: opts.context,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    nodeId: typeof result.data.node_id === 'string' ? result.data.node_id : undefined,
    duplicate: result.data.duplicate === true,
  };
}

async function link(base, opts) {
  const result = await postBrain(base, '/brain/edges', {
    from_id: opts.fromId,
    to_id: opts.toId,
    relation: opts.relation,
    weight: opts.weight ?? 1.0,
  });
  if (!result.ok) return result;
  return { ok: true, edgeId: typeof result.data.edge_id === 'string' ? result.data.edge_id : undefined };
}

function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => handler(req, res, raw ? JSON.parse(raw) : {}));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

test('recordObservation: 201 maps to {ok:true, nodeId, duplicate:false}', async () => {
  const { server, base } = await startStub((req, res) => {
    assert.equal(req.url, '/brain/observations');
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ node_id: 'node-abc', duplicate: false }));
  });
  try {
    const r = await recordObservation(base, { tier: 'task', kind: 'memory', body: 'saw a novel DOM shape' });
    assert.equal(r.ok, true);
    assert.equal(r.nodeId, 'node-abc');
    assert.equal(r.duplicate, false);
  } finally {
    server.close();
  }
});

test('recordObservation: 200 duplicate maps duplicate:true (dedup, no new row)', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ node_id: 'node-existing', duplicate: true }));
  });
  try {
    const r = await recordObservation(base, { tier: 'org', kind: 'memory', body: 'same body as before' });
    assert.equal(r.ok, true);
    assert.equal(r.duplicate, true);
  } finally {
    server.close();
  }
});

test('recordObservation: 401 -> {ok:false, reason:"auth"} — never throws', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Missing bearer token.' }));
  });
  try {
    const r = await recordObservation(base, { tier: 'task', kind: 'memory', body: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'auth');
  } finally {
    server.close();
  }
});

test('recordObservation: 422 PHI envelope -> {ok:false, reason:"phi", hits}', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'PHI-shaped text detected', hits: ['ssn', 'dob'] }));
  });
  try {
    const r = await recordObservation(base, { tier: 'task', kind: 'memory', body: 'looks like it has a ssn' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'phi');
    assert.deepEqual(r.hits, ['ssn', 'dob']);
  } finally {
    server.close();
  }
});

test('recordObservation: 422 tier-boundary violation -> {ok:false, reason:"tier"}', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: "tier must be 'org' or 'task', never 'global'" }));
  });
  try {
    const r = await recordObservation(base, { tier: 'task', kind: 'memory', body: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'tier');
  } finally {
    server.close();
  }
});

test('recordObservation: 5xx -> {ok:false, reason:"server"}', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Brain DB not configured' }));
  });
  try {
    const r = await recordObservation(base, { tier: 'task', kind: 'memory', body: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'server');
  } finally {
    server.close();
  }
});

test('recordObservation: unreachable server -> {ok:false, reason:"network"} — never throws', async () => {
  // Nothing listening on this port.
  const r = await recordObservation('http://127.0.0.1:1', { tier: 'task', kind: 'memory', body: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'network');
});

test('proposeTool: 201 maps to {ok:true, nodeId}', async () => {
  const { server, base } = await startStub((req, res) => {
    assert.equal(req.url, '/brain/tools');
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ node_id: 'tool-1', duplicate: false }));
  });
  try {
    const r = await proposeTool(base, { code: '1. click role=button', context: 'Recorded flow on example.com' });
    assert.equal(r.ok, true);
    assert.equal(r.nodeId, 'tool-1');
  } finally {
    server.close();
  }
});

test('proposeTool: 422 PHI envelope surfaces reason + hits, no throw', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'PHI-shaped text detected', hits: ['name'] }));
  });
  try {
    const r = await proposeTool(base, { code: 'value contains a name', context: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'phi');
    assert.deepEqual(r.hits, ['name']);
  } finally {
    server.close();
  }
});

test('link: 201 maps to {ok:true, edgeId}', async () => {
  const { server, base } = await startStub((req, res, body) => {
    assert.equal(req.url, '/brain/edges');
    assert.equal(body.from_id, 'node-a');
    assert.equal(body.to_id, 'node-b');
    assert.equal(body.relation, 'refines');
    assert.equal(body.weight, 1.0);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ edge_id: 'edge-1' }));
  });
  try {
    const r = await link(base, { fromId: 'node-a', toId: 'node-b', relation: 'refines' });
    assert.equal(r.ok, true);
    assert.equal(r.edgeId, 'edge-1');
  } finally {
    server.close();
  }
});

test('link: cross-tenant visibility violation (422, no hits) -> reason:"invalid"', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Both nodes must be visible to this tenant.' }));
  });
  try {
    const r = await link(base, { fromId: 'a', toId: 'b', relation: 'cites' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid');
  } finally {
    server.close();
  }
});

test('malformed 2xx body still resolves without throwing', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(201, { 'Content-Type': 'text/plain' });
    res.end('not json');
  });
  try {
    const r = await recordObservation(base, { tier: 'task', kind: 'memory', body: 'x' });
    assert.equal(r.ok, true);
    assert.equal(r.nodeId, undefined);
  } finally {
    server.close();
  }
});
