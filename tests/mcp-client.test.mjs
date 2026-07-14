// Unit tests for electron/browser/tools/mcp-client.mjs — the minimal
// MCP-over-HTTP JSON-RPC client the breeze-tools 'mcp' channel uses to call
// first-party catalog servers (connectors, scheduling) without a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { callMcpTool } from '../electron/browser/tools/mcp-client.mjs';

function withServer(handler) {
  const srv = createServer(handler);
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/mcp` }));
  });
}

test('callMcpTool round-trips a bare-JSON structuredContent response', async () => {
  const { srv, url } = await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const rpc = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: { ok: true } } }));
    });
  });
  try {
    const result = await callMcpTool(url, 'list_catalog', {}, { token: 'x' });
    assert.deepEqual(result, { ok: true });
  } finally { srv.close(); }
});

test('callMcpTool parses a single-event SSE (data:) response frame', async () => {
  const { srv, url } = await withServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { via: 'sse' } } })}\n\n`);
    });
  });
  try {
    const result = await callMcpTool(url, 'list_catalog', {}, { token: 'x' });
    assert.deepEqual(result, { via: 'sse' });
  } finally { srv.close(); }
});

test('callMcpTool maps HTTP 401 to auth_failed', async () => {
  const { srv, url } = await withServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { res.writeHead(401); res.end('unauthorized'); });
  });
  try {
    await assert.rejects(
      () => callMcpTool(url, 'list_catalog', {}, { token: 'x' }),
      (e) => e.category === 'auth_failed',
    );
  } finally { srv.close(); }
});

test('callMcpTool maps HTTP 403 to unexpected_state, NOT auth_failed (403 is ambiguous — rate-limit/WAF, not only auth)', async () => {
  const { srv, url } = await withServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { res.writeHead(403); res.end('forbidden'); });
  });
  try {
    await assert.rejects(
      () => callMcpTool(url, 'list_catalog', {}, { token: 'x' }),
      (e) => e.category === 'unexpected_state',
    );
  } finally { srv.close(); }
});

test('callMcpTool times out a response that stalls mid-body (headers sent, body never completes)', async () => {
  const { srv, url } = await withServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      // Send headers + partial body, then just... never finish. The old
      // implementation cleared its abort timer as soon as fetch() resolved
      // (headers received), leaving this phase completely unbounded.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"jsonrpc":"2.0","id":1,"result":'); // never closes
    });
  });
  try {
    const start = Date.now();
    await assert.rejects(
      () => callMcpTool(url, 'list_catalog', {}, { token: 'x', timeoutMs: 300 }),
      (e) => e.category === 'timeout',
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `expected the 300ms timeout to bound the hang; took ${elapsed}ms`);
  } finally { srv.close(); }
});

test('callMcpTool surfaces an MCP-level tool error (isError) as unexpected_state', async () => {
  const { srv, url } = await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const rpc = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0', id: rpc.id,
        result: { isError: true, content: [{ type: 'text', text: 'unknown toolkit: bogus' }] },
      }));
    });
  });
  try {
    await assert.rejects(
      () => callMcpTool(url, 'call', { toolkit: 'bogus' }, { token: 'x' }),
      (e) => e.category === 'unexpected_state' && /unknown toolkit: bogus/.test(e.message),
    );
  } finally { srv.close(); }
});

test('callMcpTool requires a token', async () => {
  await assert.rejects(
    () => callMcpTool('http://127.0.0.1:1/mcp', 'list_catalog', {}, { token: '' }),
    (e) => e.category === 'auth_failed',
  );
});
