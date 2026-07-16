// Runtime tests for the run-metrics -> brain relay
// (task-1334a1d49948 "Brain C3", electron/browser/tools/run-metrics-brain.mjs).
//
// This module is pure ESM/Node (fetch + node:fs via electron/browser/connect.mjs
// readApi/API_FILE, itself Electron-free — see connect.mjs's header), so unlike
// brain-writes.ts/site-memory.ts (which drag in Electron through auth.ts) we
// import it DIRECTLY. connect.mjs's API_FILE is a MODULE-LOAD-TIME const
// (path.join(stateDir(), 'api.json') evaluated once on import) — it does NOT
// re-resolve if we change $HOME afterward. So instead of trying to redirect
// it (task-data.test.mjs's approach relies on spawning a FRESH cli.mjs
// subprocess per test, which re-reads env; we're calling the already-imported
// module in-process), we back up whatever real api.json exists at the
// resolved path, replace it with our stub for the duration of each test, and
// restore it afterward — safe on a dev box where the real app may be running,
// since we always restore in a finally.
//
// The contract pinned here:
//   1. reportRunMetric() no-ops (never throws) when api.json is absent — main
//      not running must never fail/slow the run.
//   2. reportRunMetric() no-ops when metric.breach is falsy — nothing to report.
//   3. reportRunMetric() POSTs to /app/run-metric with NON-PHI fields only:
//      kind, body (a synthesized NON-PHI summary), domain, task_id, evidence
//      {verb, breach, streak_count, streak_total_ms} — never raw selector/URL
//      text beyond the already-derived domain.
//   4. The synthesized `body` text differs for 'slow' vs 'streak' breaches and
//      names the verb + domain.
//   5. reportSimplerPath() POSTs a tool-proposal shape (proposeTool:true, code,
//      context, domain) and no-ops when api.json is absent.
//   6. Network/HTTP failures (server down, non-2xx) are swallowed — never throw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

const { API_FILE } = await import(join(repoRoot, 'electron', 'browser', 'connect.mjs'));
const backupFile = API_FILE + '.run-metrics-brain-test-backup';

/** Swap in a stub api.json (or remove it entirely) for the duration of one
 *  test, backing up whatever the real file held (this may be a genuinely
 *  running dev instance's handshake) and restoring it afterward — every
 *  caller MUST call restoreApiFile() in a finally. */
function backupRealApiFile() {
  if (existsSync(API_FILE)) copyFileSync(API_FILE, backupFile);
}

function useNoApiFile() {
  backupRealApiFile();
  rmSync(API_FILE, { force: true });
}

function useStubApiFile(port, token = 'stub-token') {
  backupRealApiFile();
  mkdirSync(dirname(API_FILE), { recursive: true });
  writeFileSync(API_FILE, JSON.stringify({ port, token }));
}

function restoreApiFile() {
  if (existsSync(backupFile)) {
    copyFileSync(backupFile, API_FILE);
    rmSync(backupFile, { force: true });
  } else {
    rmSync(API_FILE, { force: true });
  }
}

function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => handler(req, res, raw ? JSON.parse(raw) : {}));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const { reportRunMetric, reportSimplerPath } = await import(
  join(repoRoot, 'electron', 'browser', 'tools', 'run-metrics-brain.mjs')
);

test('reportRunMetric: no-ops (never throws) when api.json is absent', async () => {
  useNoApiFile();
  try {
    await assert.doesNotReject(() =>
      reportRunMetric('click', { breach: 'slow', domain: 'example.com', streakCount: 1, streakTotalMs: 9000 }),
    );
  } finally {
    restoreApiFile();
  }
});

test('reportRunMetric: no-ops when metric.breach is falsy — no request sent', async () => {
  let called = false;
  const { server, port } = await startStub((req, res) => {
    called = true;
    res.writeHead(202);
    res.end('{}');
  });
  useStubApiFile(port);
  try {
    await reportRunMetric('click', { breach: null, domain: 'example.com' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(called, false, 'no breach should mean no network call');
  } finally {
    server.close();
    restoreApiFile();
  }
});

test('reportRunMetric: POSTs NON-PHI fields to /app/run-metric for a "slow" breach', async () => {
  let received = null;
  let authHeader = null;
  const { server, port } = await startStub((req, res, body) => {
    received = body;
    authHeader = req.headers['authorization'];
    assert.equal(req.url, '/app/run-metric');
    assert.equal(req.method, 'POST');
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  useStubApiFile(port, 'sekret-token');
  const prevTaskId = process.env.BREEZE_TYPEBUILD_TASK_ID;
  process.env.BREEZE_TYPEBUILD_TASK_ID = 'task-xyz';
  try {
    await reportRunMetric('click', {
      breach: 'slow',
      domain: 'portal.example',
      streakCount: 1,
      streakTotalMs: 9200,
    });
    assert.ok(received, 'expected a request body');
    assert.equal(authHeader, 'Bearer sekret-token');
    assert.equal(received.kind, 'memory');
    assert.equal(received.domain, 'portal.example');
    assert.equal(received.task_id, 'task-xyz');
    assert.match(received.body, /click/);
    assert.match(received.body, /portal\.example/);
    assert.equal(received.evidence.verb, 'click');
    assert.equal(received.evidence.breach, 'slow');
  } finally {
    if (prevTaskId === undefined) delete process.env.BREEZE_TYPEBUILD_TASK_ID;
    else process.env.BREEZE_TYPEBUILD_TASK_ID = prevTaskId;
    server.close();
    restoreApiFile();
  }
});

test('reportRunMetric: the "streak" summary names the repeat count, distinct from "slow"', async () => {
  let received = null;
  const { server, port } = await startStub((req, res, body) => {
    received = body;
    res.writeHead(202);
    res.end('{}');
  });
  useStubApiFile(port);
  try {
    await reportRunMetric('goto', {
      breach: 'streak',
      domain: 'carrier.example',
      streakCount: 4,
      streakTotalMs: 18000,
    });
    assert.match(received.body, /repeated 4x/);
    assert.match(received.body, /goto/);
    assert.match(received.body, /carrier\.example/);
    assert.equal(received.evidence.streak_count, 4);
    assert.equal(received.evidence.streak_total_ms, 18000);
  } finally {
    server.close();
    restoreApiFile();
  }
});

test('reportRunMetric: swallows a non-2xx / connection failure rather than throwing', async () => {
  const { server, port } = await startStub((req, res) => {
    res.writeHead(500);
    res.end('boom');
  });
  useStubApiFile(port);
  try {
    await assert.doesNotReject(() =>
      reportRunMetric('fill', { breach: 'slow', domain: 'x.example', streakCount: 1, streakTotalMs: 8000 }),
    );
  } finally {
    server.close();
    restoreApiFile();
  }
});

test('reportSimplerPath: no-ops when api.json is absent', async () => {
  useNoApiFile();
  try {
    await assert.doesNotReject(() =>
      reportSimplerPath({ verb: 'click', domain: 'example.com', code: '1. click #go', context: 'faster path' }),
    );
  } finally {
    restoreApiFile();
  }
});

test('reportSimplerPath: POSTs a tool-proposal shape', async () => {
  let received = null;
  const { server, port } = await startStub((req, res, body) => {
    received = body;
    res.writeHead(202);
    res.end('{}');
  });
  useStubApiFile(port);
  try {
    await reportSimplerPath({
      verb: 'click',
      domain: 'portal.example',
      code: '1. net-replay https://portal.example/api/x',
      context: 'API shortcut replaces a 3-click flow',
    });
    assert.equal(received.proposeTool, true);
    assert.equal(received.domain, 'portal.example');
    assert.match(received.code, /net-replay/);
    assert.match(received.context, /API shortcut/);
  } finally {
    server.close();
    restoreApiFile();
  }
});
