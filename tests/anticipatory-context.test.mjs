// Runtime contract tests for the anticipatory planner (task-8f71349656db
// "Brain C2", electron/typebuild/anticipatory-context.ts +
// electron/typebuild/brain-client.ts's assembleContext).
//
// SAME CONSTRAINT as tests/task-context-bundle.test.mjs: these run in CI
// WITHOUT a live Electron app. brain-client.ts hardcodes BRAIN_BASE +
// getIdToken() (via electron/typebuild/auth.ts), so importing it directly
// drags in Electron. We instead assert the BEHAVIOURAL CONTRACT against a
// tiny in-process stub mirroring the server endpoint it consumes:
//
//   POST /brain/context
//     -> 200 ContextBundleOut { global_tools, site_memory, tenant_rules,
//        task_notes, candidate_sites, all_rows, token_count }
//     -> non-200 (auth failure / brain down)
//
// The contract pinned here:
//   1. A 200 body maps into the camelCase BrainContextBundle shape 1:1 with
//      brain_api's ContextBundleOut fields (mirrors asRow/asLayer in
//      brain-client.ts).
//   2. A non-200 / network failure / malformed body -> the EMPTY bundle
//      (every layer's rows: [], candidateSites: [], tokenCount: 0) — the
//      launch must never block or throw on a brain outage.
//   3. renderAnticipatoryAddendum(emptyBundle) === '' — conditional-spread
//      safe, matching renderBundleAddendum's contract in task-context-bundle.
//   4. renderAnticipatoryAddendum renders each non-empty tier + candidate
//      sites, and omits headings for tiers with no rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ─── faithful re-implementation of brain-client.ts's response mapping ──────
// Kept in lockstep with electron/typebuild/brain-client.ts (asRow/asLayer/
// assembleContext) and electron/typebuild/anticipatory-context.ts
// (renderAnticipatoryAddendum) so the CONTRACT is verified without importing
// Electron — the same scoping decision as task-context-bundle.test.mjs.

function asRow(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.id !== 'string' || typeof value.tier !== 'string') return null;
  return {
    id: value.id,
    tier: value.tier,
    content: String(value.content ?? ''),
    summary: value.summary ?? null,
    artifact: value.artifact ?? null,
    hit_rate: value.hit_rate ?? null,
    downstream_success_rate: value.downstream_success_rate ?? null,
    staleness_score: Number(value.staleness_score ?? 0),
    avg_latency_ms: value.avg_latency_ms ?? null,
    vec_distance: Number(value.vec_distance ?? 0),
    composite_score: Number(value.composite_score ?? 0),
    source_rank: Number(value.source_rank ?? 0),
  };
}

function emptyLayer(tier) {
  return { tier, rows: [] };
}

function asLayer(value, fallbackTier) {
  if (!value || typeof value !== 'object') return emptyLayer(fallbackTier);
  const rows = Array.isArray(value.rows)
    ? value.rows.map(asRow).filter((r) => r !== null)
    : [];
  const tier = typeof value.tier === 'string' ? value.tier : fallbackTier;
  return { tier, rows };
}

function emptyBundle() {
  return {
    globalTools: emptyLayer('global'),
    siteMemory: emptyLayer('global'),
    tenantRules: emptyLayer('org'),
    taskNotes: emptyLayer('task'),
    candidateSites: [],
    allRows: [],
    tokenCount: 0,
  };
}

async function selectContextBundle(res) {
  if (!res.ok) return emptyBundle();
  const data = await res.json().catch(() => null);
  if (!data) return emptyBundle();
  const allRows = Array.isArray(data.all_rows)
    ? data.all_rows.map(asRow).filter((r) => r !== null)
    : [];
  const candidateSites = Array.isArray(data.candidate_sites)
    ? data.candidate_sites.filter((s) => typeof s === 'string')
    : [];
  return {
    globalTools: asLayer(data.global_tools, 'global'),
    siteMemory: asLayer(data.site_memory, 'global'),
    tenantRules: asLayer(data.tenant_rules, 'org'),
    taskNotes: asLayer(data.task_notes, 'task'),
    candidateSites,
    allRows,
    tokenCount: Number(data.token_count ?? 0),
  };
}

function tierLabel(tier) {
  switch (tier) {
    case 'global':
      return 'Global';
    case 'org':
      return 'Org';
    case 'task':
      return 'Task';
    default:
      return String(tier || 'Unknown');
  }
}

function summarizeRows(rows, limit) {
  return rows
    .slice(0, limit)
    .map((r) => (r.summary && r.summary.trim()) || r.content.trim())
    .filter(Boolean);
}

function renderAnticipatoryAddendum(bundle) {
  const sections = [];
  const tiers = [
    [`Tools (${tierLabel('global')})`, bundle.globalTools.rows],
    [`Site memory (${tierLabel('global')})`, bundle.siteMemory.rows],
    [`Org rules (${tierLabel('org')})`, bundle.tenantRules.rows],
    [`This task (${tierLabel('task')})`, bundle.taskNotes.rows],
  ];
  for (const [label, rows] of tiers) {
    const lines = summarizeRows(rows, 8);
    if (lines.length === 0) continue;
    sections.push(`${label}:\n${lines.map((l) => `- ${l}`).join('\n')}`);
  }
  if (bundle.candidateSites.length > 0) {
    sections.push(
      `Candidate site(s) for this task (task→site resolution — no domain/url was ` +
        `given, so these are inferred, most-relevant first; confirm before acting ` +
        `on an ambiguous match):\n${bundle.candidateSites.map((s) => `- ${s}`).join('\n')}`,
    );
  }
  if (sections.length === 0) return '';
  return [
    '# Brain memory (anticipatory planner — treat as already-recalled)',
    '',
    sections.join('\n\n'),
  ].join('\n');
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

function row(overrides = {}) {
  return {
    id: 'row-1',
    tier: 'global',
    content: 'fallback text',
    staleness_score: 0.1,
    vec_distance: 0.2,
    composite_score: 0.9,
    source_rank: 1,
    ...overrides,
  };
}

test('200 with full bundle maps every layer + candidate_sites', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        global_tools: { tier: 'global', rows: [row({ id: 't1', summary: 'Use the fast-path curl' })] },
        site_memory: { tier: 'global', rows: [row({ id: 's1', content: 'Selector note' })] },
        tenant_rules: { tier: 'org', rows: [] },
        task_notes: { tier: 'task', rows: [row({ id: 'n1', tier: 'task', content: 'Prior attempt failed at step 3' })] },
        candidate_sites: ['availity.com', 'aetna.com'],
        all_rows: [row({ id: 't1' }), row({ id: 's1' }), row({ id: 'n1', tier: 'task' })],
        token_count: 512,
      }),
    );
  });
  try {
    const res = await fetch(`${base}/brain/context`, { method: 'POST' });
    const bundle = await selectContextBundle(res);
    assert.equal(bundle.globalTools.rows.length, 1);
    assert.equal(bundle.globalTools.rows[0].summary, 'Use the fast-path curl');
    assert.equal(bundle.siteMemory.rows[0].content, 'Selector note');
    assert.equal(bundle.tenantRules.rows.length, 0);
    assert.equal(bundle.taskNotes.rows[0].tier, 'task');
    assert.deepEqual(bundle.candidateSites, ['availity.com', 'aetna.com']);
    assert.equal(bundle.tokenCount, 512);
  } finally {
    server.close();
  }
});

test('non-200 (auth failure / brain down) degrades to the empty bundle', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Missing bearer token.' }));
  });
  try {
    const res = await fetch(`${base}/brain/context`, { method: 'POST' });
    const bundle = await selectContextBundle(res);
    assert.equal(bundle.globalTools.rows.length, 0);
    assert.equal(bundle.candidateSites.length, 0);
    assert.equal(bundle.tokenCount, 0);
  } finally {
    server.close();
  }
});

test('malformed 200 body degrades to the empty bundle', async () => {
  const { server, base } = await startStub((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('not json');
  });
  try {
    const res = await fetch(`${base}/brain/context`, { method: 'POST' });
    const bundle = await selectContextBundle(res);
    assert.equal(bundle.globalTools.rows.length, 0);
    assert.equal(bundle.tokenCount, 0);
  } finally {
    server.close();
  }
});

test('addendum contract: an entirely empty bundle yields empty addendum', () => {
  assert.equal(renderAnticipatoryAddendum(emptyBundle()), '');
});

test('addendum renders non-empty tiers and omits empty ones', () => {
  const bundle = emptyBundle();
  bundle.globalTools.rows = [row({ id: 't1', content: 'curl the export API directly' })];
  bundle.taskNotes.rows = [row({ id: 'n1', tier: 'task', summary: 'Watch the TIN picker default' })];
  const out = renderAnticipatoryAddendum(bundle);
  assert.match(out, /Brain memory \(anticipatory planner/);
  assert.match(out, /Tools \(Global\):/);
  assert.match(out, /curl the export API directly/);
  assert.match(out, /This task \(Task\):/);
  assert.match(out, /Watch the TIN picker default/);
  assert.doesNotMatch(out, /Org rules/);
  assert.doesNotMatch(out, /Site memory/);
});

test('addendum surfaces candidate_sites (Brain #7 fold) with a confirm-before-acting caveat', () => {
  const bundle = emptyBundle();
  bundle.candidateSites = ['availity.com', 'aetna.com'];
  const out = renderAnticipatoryAddendum(bundle);
  assert.match(out, /Candidate site\(s\) for this task/);
  assert.match(out, /availity\.com/);
  assert.match(out, /aetna\.com/);
  assert.match(out, /confirm before acting/);
});

test('addendum prefers a row summary over its content when both are present', () => {
  const bundle = emptyBundle();
  bundle.globalTools.rows = [row({ id: 't1', content: 'raw content', summary: 'short summary' })];
  const out = renderAnticipatoryAddendum(bundle);
  assert.match(out, /short summary/);
  assert.doesNotMatch(out, /raw content/);
});
