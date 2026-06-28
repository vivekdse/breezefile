// Tests for param-binding memory (task-a7e56f6bc583, Operator Speed epic).
//
// Two halves:
//   1. PURE unit tests of param-bindings.mjs — the keys-only record shape,
//      parse/format round-trip, the value-rejection guard (the PHI invariant),
//      domain normalization, and last-write-wins de-dupe from memory entries.
//   2. ROUTED tests of the `bindings record|recall` CLI path through the SAME
//      shared task-scope memory the rest of the system uses, with the same
//      stub-Breeze-main pattern as site-memory-online.test.mjs. These prove a
//      binding is stored KEYS ONLY, recalled by (domain, task_tag), and that NO
//      resolved value ever enters the stored note — we inspect the actual POST
//      bodies the stub received.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

// Isolate HOME (→ api.json) + the memory cache dir BEFORE importing memory.mjs.
const HOME = mkdtempSync(join(tmpdir(), 'bz-pb-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BREEZE_MEMORY_DIR = mkdtempSync(join(tmpdir(), 'bz-pb-cache-'));
const apiFile = join(HOME, '.breezefile', 'api.json');
mkdirSync(dirname(apiFile), { recursive: true });

const pb = await import(join(repoRoot, 'electron', 'browser', 'tools', 'param-bindings.mjs'));

// ── 1. PURE: record shape, parse/format, the keys-only guard ─────────────────

test('formatBinding emits a canonical KEYS-ONLY line (no value)', () => {
  const line = pb.formatBinding({
    domain: 'https://mail.google.com/mail/u/0',
    tool: 'gmail-prefill-send',
    param: 'to',
    dataKey: 'patient.contact_email',
  });
  assert.equal(
    line,
    'param-binding domain:mail.google.com tool:gmail-prefill-send param:to <- data:patient.contact_email',
  );
  // The only "value-like" token is the placeholder KEY itself — a dotted ident.
  assert.ok(!/@/.test(line), 'no email value');
});

test('format → parse round-trips and normalizes the domain', () => {
  const b = pb.parseBinding(
    pb.formatBinding({
      domain: 'www.Example.com',
      tool: 'pay-bill',
      param: 'amount',
      dataKey: 'invoice.total',
    }),
  );
  assert.deepEqual(b, {
    domain: 'example.com',
    tool: 'pay-bill',
    param: 'amount',
    dataKey: 'invoice.total',
  });
});

test('a VALUE in the data slot is REJECTED — never serialized (PHI invariant)', () => {
  for (const bad of [
    'jane.doe@example.com', // an email value
    '123-45-6789', // an SSN value
    'Jane Doe', // a name value (whitespace)
    '$42.00', // a money value
  ]) {
    const v = pb.validateBinding({ domain: 'x.com', tool: 't', param: 'p', dataKey: bad });
    assert.equal(v.ok, false, `value must be rejected: ${bad}`);
    assert.throws(
      () => pb.formatBinding({ domain: 'x.com', tool: 't', param: 'p', dataKey: bad }),
      /placeholder KEY/,
    );
  }
  // A legitimate placeholder KEY passes.
  assert.equal(
    pb.validateBinding({ domain: 'x.com', tool: 't', param: 'p', dataKey: 'me.npi' }).ok,
    true,
  );
});

test('parseBinding ignores free-text notes sharing the bucket', () => {
  assert.equal(pb.parseBinding('headlines are a.story under .card'), null);
  assert.equal(pb.parseBinding(''), null);
  // A spoofed line with a value in the data slot is rejected on parse too.
  assert.equal(
    pb.parseBinding('param-binding domain:x.com tool:t param:p <- data:jane@x.com'),
    null,
  );
});

test('bindingsFromEntries filters by tool/domain and is last-write-wins', () => {
  const entries = [
    { text: 'param-binding domain:a.com tool:t1 param:to <- data:patient.email', id: '1' },
    { text: 'a free-text how-to note', id: '2' },
    { text: 'param-binding domain:a.com tool:t1 param:to <- data:patient.alt_email', id: '3' },
    { text: 'param-binding domain:b.com tool:t1 param:to <- data:contact.email', id: '4' },
    { text: 'param-binding domain:a.com tool:t2 param:amt <- data:bill.total', id: '5' },
  ];
  // Latest binding for (a.com,t1,to) wins (id 3, alt_email).
  const t1a = pb.bindingsFromEntries(entries, { tool: 't1', domain: 'a.com' });
  assert.equal(t1a.length, 1);
  assert.equal(t1a[0].dataKey, 'patient.alt_email');
  assert.equal(t1a[0].id, '3');
  // Domain filter keeps a.com vs b.com distinct.
  assert.equal(pb.bindingsFromEntries(entries, { domain: 'b.com' }).length, 1);
  // No filter → all distinct (domain,tool,param) bindings, no free-text.
  assert.equal(pb.bindingsFromEntries(entries).length, 3);
});

// ── 2. ROUTED: record → recall through the shared task-scope memory ──────────
// Stand up a stub of Breeze main's /app/site-memory control endpoint, exactly
// like site-memory-online.test.mjs, and drive the real memory.mjs *Online path.

const STORE = [];
const POSTS = []; // every POST body the stub received (to assert keys-only)

function startStub() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.headers.authorization !== 'Bearer test-token') {
      res.writeHead(401).end('{}');
      return;
    }
    if (url.pathname === '/app/site-memory' && req.method === 'GET') {
      const taskTag = url.searchParams.get('task_tag') || '';
      const domain = url.searchParams.get('domain') || '';
      const notes = taskTag
        ? STORE.filter((n) => n.task_tag === taskTag)
        : STORE.filter((n) => n.domain === domain);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(taskTag ? { task_tag: taskTag, notes } : { domain, notes }));
      return;
    }
    if (url.pathname === '/app/site-memory' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        POSTS.push(body);
        const note = {
          id: 'note-' + STORE.length,
          domain: body.domain || null,
          task_tag: body.task_tag || null,
          kind: body.kind || 'note',
          body: body.body,
          updated_at: '2026-06-28T00:00:00Z',
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
const port = server.address().port;
writeFileSync(apiFile, JSON.stringify({ port, token: 'test-token', pid: process.pid }));

const mem = await import(join(repoRoot, 'electron', 'browser', 'tools', 'memory.mjs'));

// The CLI helpers the `bindings` command composes (record = format+addMemoryOnline,
// recall = getMemoryOnline+bindingsFromEntries). We exercise that same pair here.
async function recordBinding(taskTag, b) {
  const line = pb.formatBinding(b);
  return mem.addMemoryOnline('task', taskTag, line, { kind: pb.BINDING_KIND });
}
async function recallBindings(taskTag, filter) {
  const m = await mem.getMemoryOnline('task', taskTag);
  return pb.bindingsFromEntries(m.entries, filter);
}

test('record stores a KEYS-ONLY note keyed by task_tag (kind param-binding)', async () => {
  const r = await recordBinding('intake-fax', {
    domain: 'https://mail.google.com',
    tool: 'gmail-prefill-send',
    param: 'to',
    dataKey: 'patient.contact_email',
  });
  assert.equal(r.online, true);
  assert.ok(r.id);
  const post = POSTS.at(-1);
  assert.equal(post.task_tag, 'intake-fax', 'keyed by task_tag, not domain');
  assert.equal(post.domain, undefined, 'POST omits domain — task-scoped');
  assert.equal(post.kind, 'param-binding');
  // The load-bearing PHI assertion: the stored body is the keys-only line and
  // contains NO resolved value — only identifiers + the placeholder KEY.
  assert.match(post.body, /^param-binding domain:mail\.google\.com tool:gmail-prefill-send param:to <- data:patient\.contact_email$/);
});

test('recall returns the binding by (domain, task_tag) so params fill directly', async () => {
  await recordBinding('intake-fax', {
    domain: 'mail.google.com',
    tool: 'gmail-prefill-send',
    param: 'subject',
    dataKey: 'referral.subject',
  });
  const got = await recallBindings('intake-fax', {
    tool: 'gmail-prefill-send',
    domain: 'mail.google.com',
  });
  const byParam = Object.fromEntries(got.map((b) => [b.param, b.dataKey]));
  assert.deepEqual(byParam, {
    to: 'patient.contact_email',
    subject: 'referral.subject',
  });
  // A different task_tag must NOT see these bindings.
  assert.equal((await recallBindings('some-other-task')).length, 0);
  // A different domain under the SAME task_tag is filtered out.
  assert.equal(
    (await recallBindings('intake-fax', { domain: 'portal.example.com' })).length,
    0,
  );
});

test('NO resolved value EVER entered any stored record (sweep all POSTs)', () => {
  // Every POST that carried a param-binding must have a keys-only body. We assert
  // the negative directly: no value-shaped token (email/whitespace/digits-run)
  // appears in any binding body that reached the store.
  const bindingPosts = POSTS.filter((p) => p.kind === 'param-binding');
  assert.ok(bindingPosts.length >= 1);
  for (const p of bindingPosts) {
    assert.ok(pb.parseBinding(p.body), 'every binding body parses as keys-only');
    assert.ok(!/@/.test(p.body), 'no email value');
    assert.ok(!/\s\S+@/.test(p.body), 'no embedded address');
    // After the 4 structured fields, the only free token is the data KEY (dotted
    // identifier). Confirm the body is EXACTLY the canonical line.
    const b = pb.parseBinding(p.body);
    assert.equal(p.body, pb.formatBinding(b));
  }
});

test('a value-shaped data ref is refused before any write (no POST)', async () => {
  const before = POSTS.length;
  await assert.rejects(
    () =>
      recordBinding('intake-fax', {
        domain: 'mail.google.com',
        tool: 'gmail-prefill-send',
        param: 'to',
        dataKey: 'jane.doe@example.com', // a real email value, not a key
      }),
    /placeholder KEY/,
  );
  assert.equal(POSTS.length, before, 'a rejected binding never reached the store');
});

test.after(() => {
  try {
    server.close();
  } catch {
    /* best-effort */
  }
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
