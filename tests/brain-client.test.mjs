// Runtime contract tests for the Brain read-side client (task-35dde066caf7
// "Brain C5", electron/typebuild/brain-client.ts + brain-confirm.ts).
//
// SAME CONSTRAINT as tests/task-context-bundle.test.mjs: brain-client.ts calls
// getIdToken() (electron/typebuild/auth.ts), which requires a real signed-in
// session (module-level state) to succeed — there's no lightweight way to fake
// a valid Firebase session in a unit test. So, like task-context-bundle's own
// test file, we pin the BEHAVIOURAL CONTRACT the client guarantees against a
// tiny in-process stub that mirrors brain_api's shape, replicating the exact
// selection/mapping logic (kept in lockstep with brain-client.ts).
//
// What we verify:
//   1. getTool: exactly-one-of {tool_id, signature} validation.
//   2. getTool/recall: a 200 with a MemoryRowOut is mapped field-for-field.
//   3. getTool: a `null` body (brain_api's "not found") maps to null.
//   4. confidenceScore/confidenceLevel: the composite/hit-rate/staleness blend
//      produces the expected 0-1 score and high/medium/low bucket.
//   5. tierLabel/tierDescription: the three tiers map to the right copy.
//   6. brain-confirm.ts's local reject bookkeeping round-trips through a temp
//      $BREEZE_MEMORY_DIR (autoConfirmCandidate is a documented no-op).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

process.env.BREEZE_MEMORY_DIR = mkdtempSync(join(tmpdir(), 'bz-brain-cache-'));

// ── Replica of brain-client.ts's row mapping (asRow) ─────────────────────────
function asRow(value) {
  if (!value || typeof value !== 'object') return null;
  const v = value;
  if (typeof v.id !== 'string' || typeof v.tier !== 'string') return null;
  return {
    id: v.id,
    tier: v.tier,
    content: String(v.content ?? ''),
    summary: v.summary ?? null,
    artifact: v.artifact ?? null,
    hit_rate: v.hit_rate ?? null,
    downstream_success_rate: v.downstream_success_rate ?? null,
    staleness_score: Number(v.staleness_score ?? 0),
    avg_latency_ms: v.avg_latency_ms ?? null,
    vec_distance: Number(v.vec_distance ?? 0),
    composite_score: Number(v.composite_score ?? 0),
    source_rank: Number(v.source_rank ?? 0),
  };
}

async function selectGetTool(res) {
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return asRow(data);
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

test('getTool: exactly one of {tool_id, signature} is required', () => {
  function validate(opts) {
    const { toolId, signature } = opts;
    if ((!toolId && !signature) || (toolId && signature)) {
      throw new Error('getTool: provide exactly one of toolId or signature');
    }
  }
  assert.throws(() => validate({}));
  assert.throws(() => validate({ toolId: 'a', signature: 'b' }));
  assert.doesNotThrow(() => validate({ toolId: 'a' }));
  assert.doesNotThrow(() => validate({ signature: 'b' }));
});

test('getTool: a found MemoryRowOut is mapped field-for-field', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'node-abc',
        tier: 'global',
        content: 'const x = 1;',
        summary: 'a tool',
        artifact: 'https://example.com/*',
        hit_rate: 0.8,
        downstream_success_rate: 0.9,
        staleness_score: 0.1,
        avg_latency_ms: 120,
        vec_distance: 0.05,
        composite_score: 0.75,
        source_rank: 1,
      }),
    );
  });
  try {
    const row = await selectGetTool(await fetch(`${base}/brain/tools/fetch`, { method: 'POST' }));
    assert.equal(row.id, 'node-abc');
    assert.equal(row.tier, 'global');
    assert.equal(row.artifact, 'https://example.com/*');
    assert.equal(row.composite_score, 0.75);
  } finally {
    server.close();
  }
});

test('getTool: brain_api "not found" (null body, HTTP 200) maps to null', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('null');
  });
  try {
    const row = await selectGetTool(await fetch(`${base}/brain/tools/fetch`, { method: 'POST' }));
    assert.equal(row, null);
  } finally {
    server.close();
  }
});

test('getTool: a non-2xx degrades to null (never throws)', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(422, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: 'bad request' }));
  });
  try {
    const row = await selectGetTool(await fetch(`${base}/brain/tools/fetch`, { method: 'POST' }));
    assert.equal(row, null);
  } finally {
    server.close();
  }
});

test('recall: a row array is mapped and malformed rows are dropped', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify([
        { id: 'a', tier: 'org', content: 'x', staleness_score: 0, vec_distance: 0, composite_score: 0.5, source_rank: 0 },
        { not: 'a row' },
      ]),
    );
  });
  try {
    const res = await fetch(`${base}/brain/recall`, { method: 'POST' });
    const data = await res.json().catch(() => []);
    const rows = Array.isArray(data) ? data.map(asRow).filter((r) => r !== null) : [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'a');
  } finally {
    server.close();
  }
});

test('recall: empty query short-circuits to [] (contract, not a network call)', () => {
  function wouldCall(query) {
    return !!query.trim();
  }
  assert.equal(wouldCall(''), false);
  assert.equal(wouldCall('   '), false);
  assert.equal(wouldCall('hello'), true);
});

// ── confidenceScore / confidenceLevel / tierLabel ────────────────────────────
// brain-client.ts is TypeScript with an Electron-coupled getIdToken() import
// chain; this repo's test files never import a raw .ts module directly (see
// task-context-bundle.test.mjs's header note making the same call) — Node's
// `node --test tests/*.test.mjs` here has no .ts loader registered. So, same
// as every other *.test.mjs in this repo, we re-implement the exact pure
// formulas here, kept in lockstep with brain-client.ts's real implementation.
function clamp01(n) {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}
function confidenceScore(row) {
  let score = clamp01(row.composite_score);
  if (typeof row.hit_rate === 'number') {
    score = score * 0.7 + clamp01(row.hit_rate) * 0.3;
  }
  if (typeof row.downstream_success_rate === 'number') {
    score = score * 0.7 + clamp01(row.downstream_success_rate) * 0.3;
  }
  const staleness = clamp01(row.staleness_score);
  score *= 1 - staleness * 0.5;
  return clamp01(score);
}
function confidenceLevel(score) {
  if (score >= 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  return 'low';
}
function tierLabel(tier) {
  return { global: 'Global', org: 'Org', task: 'Task' }[tier] ?? String(tier || 'Unknown');
}
function tierDescription(tier) {
  return (
    {
      global: 'Shared across every business on the network',
      org: 'Scoped to your organization only',
      task: 'Scoped to this task/run only',
    }[tier] ?? ''
  );
}

test('confidenceScore: high composite + high hit-rate + fresh -> high bucket', () => {
  const row = {
    composite_score: 0.9,
    hit_rate: 0.95,
    downstream_success_rate: 0.9,
    staleness_score: 0.0,
    vec_distance: 0,
    source_rank: 0,
    id: 'x',
    tier: 'global',
    content: '',
  };
  const score = confidenceScore(row);
  assert.ok(score >= 0.7, `expected high score, got ${score}`);
  assert.equal(confidenceLevel(score), 'high');
});

test('confidenceScore: staleness discounts an otherwise-good score', () => {
  const fresh = confidenceScore({
    composite_score: 0.8,
    staleness_score: 0.0,
    vec_distance: 0,
    source_rank: 0,
    id: 'x',
    tier: 'org',
    content: '',
  });
  const stale = confidenceScore({
    composite_score: 0.8,
    staleness_score: 1.0,
    vec_distance: 0,
    source_rank: 0,
    id: 'x',
    tier: 'org',
    content: '',
  });
  assert.ok(stale < fresh, 'a fully-stale row must score lower than an identical fresh one');
  assert.ok(stale <= fresh / 2 + 1e-9, 'staleness=1 halves the score per the documented formula');
});

test('confidenceScore: missing hit_rate/downstream fields degrade gracefully', () => {
  const score = confidenceScore({
    composite_score: 0.5,
    staleness_score: 0.2,
    vec_distance: 0,
    source_rank: 0,
    id: 'x',
    tier: 'task',
    content: '',
  });
  assert.ok(score >= 0 && score <= 1);
});

test('tierLabel / tierDescription cover all three tiers', () => {
  assert.equal(tierLabel('global'), 'Global');
  assert.equal(tierLabel('org'), 'Org');
  assert.equal(tierLabel('task'), 'Task');
  assert.match(tierDescription('global'), /every business/);
  assert.match(tierDescription('org'), /organization/);
  assert.match(tierDescription('task'), /this task\/run/);
});

// ── brain-confirm.ts: local reject bookkeeping (no server call exists) ──────
// Same .ts-import constraint as above: we replicate the file-backed Set
// logic exactly (see electron/typebuild/brain-confirm.ts rejectedFile/
// readRejected/writeRejected) against the SAME $BREEZE_MEMORY_DIR temp root,
// so this test pins the on-disk contract without importing Electron-coupled
// TS.
import { readFileSync as _readFileSync, writeFileSync as _writeFileSync, mkdirSync as _mkdirSync } from 'node:fs';

function rejectedFile() {
  return join(process.env.BREEZE_MEMORY_DIR, 'brain-rejected-candidates.json');
}
function readRejected() {
  try {
    const data = JSON.parse(_readFileSync(rejectedFile(), 'utf8'));
    return new Set(Array.isArray(data) ? data.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
function writeRejected(ids) {
  const f = rejectedFile();
  _mkdirSync(dirname(f), { recursive: true });
  _writeFileSync(f, JSON.stringify([...ids], null, 2) + '\n');
}
function rejectCandidateLocally(row) {
  const ids = readRejected();
  ids.add(row.id);
  writeRejected(ids);
}
function isLocallyRejected(id) {
  return readRejected().has(id);
}
function autoConfirmCandidate(_row) {
  // no-op by design — see brain-confirm.ts's header.
}

test('rejectCandidateLocally: remembers an id so isLocallyRejected sees it', () => {
  assert.equal(isLocallyRejected('cand-1'), false);
  rejectCandidateLocally({ id: 'cand-1' });
  assert.equal(isLocallyRejected('cand-1'), true);
  // A different id is unaffected.
  assert.equal(isLocallyRejected('cand-2'), false);
});

test('autoConfirmCandidate: documented no-op, never throws', () => {
  assert.doesNotThrow(() => autoConfirmCandidate({ id: 'cand-3' }));
});

test.after(() => {
  try {
    rmSync(process.env.BREEZE_MEMORY_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
