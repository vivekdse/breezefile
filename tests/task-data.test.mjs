// Runtime tests for the cooperative-boundary PII placeholder-fill pieces
// (docs/pii-data-injection-design.md, commit 9682a9f). Uses node:test
// (built-in, no devDep cost), ESM, and the same skip-if-no-app convention as
// tests/cli.test.mjs.
//
// THE HARD CONSTRAINT: these must run in CI / on a fresh machine WITHOUT a live
// Electron app or a CDP browser. We therefore do NOT drive a real browser.
// Instead we stand up a tiny in-process stub HTTP server that imitates BOTH:
//   (a) Breeze's control API:  GET /app/task-data?taskId=&ref= -> {ok,ref,value}
//   (b) the TypeBuild REST, two class paths:
//        class 1: GET /chromeext/<id>/data?ref=            -> {value} / 404
//        class 2: GET /chromeext/entities/resolve?field=   -> {resolved,...}
//                 (the user-credential entity resolver — what actually shipped;
//                  the old /chromeext/me/data?ref= reveal endpoint was NEVER built)
//
// What we CAN and CANNOT reach from CI (the load-bearing scoping decision):
//   - electron/typebuild/task-data.ts hardcodes API_BASE + getIdToken() and
//     imports from electron/auth, so importing it directly drags in Electron.
//     We instead assert the BEHAVIOURAL CONTRACT it must satisfy against a stub
//     that mirrors its server contract (one-ref-at-a-time, 404->throw, value is
//     a string), plus the control-endpoint contract from api-server.ts
//     (400 on missing taskId/ref; {ok,ref,value} on success).
//   - electron/browser/cli.mjs reaches resolveDataRef() (and its no-task-id
//     guard, and the "never print the value" output) ONLY AFTER
//     chromium.connectOverCDP(), which CI lacks. So the genuine end-to-end
//     fill-ref path is unreachable here; that gap is recorded as test.todo()
//     below. We DO test the cli.mjs surface that runs BEFORE CDP.
//
// THE KEY SECURITY ASSERTION (#3): the resolved value must never reach stdout.
// Since cli.mjs's own resolveDataRef is CDP-gated, we assert the contract
// against the smallest reachable unit: a harness that performs the exact same
// fetch + the exact same `filled <sel> (ref <ref>)` print that cli.mjs's
// fill-ref does, and prove the printed line contains the REF and NOT the VALUE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const cliMjs = join(repoRoot, 'electron', 'browser', 'cli.mjs');
const apiFile = join(homedir(), '.breezefile', 'api.json');

// A canary value standing in for decrypted PII. No test may ever let this
// string appear on stdout/stderr of any agent-facing surface.
const SECRET_VALUE = 'SSN-000-00-0000-CANARY';
const TASK_ID = 'task-abc-123';
const REF = 'patient.ssn';

// ── Stub server ────────────────────────────────────────────────────────────
// One node:http server plays BOTH roles. The data bag below is the "decrypted
// at rest" content the TypeBuild server would hold; it never leaves this file.
const DATA_BAG = {
  [REF]: SECRET_VALUE,
  'patient.first': 'Alex',
};

// Class-2 vault (the user's OWN identifiers). A canary stands in for the NPI so
// no test may leak it onto an agent-facing surface either.
const NPI_CANARY = 'NPI-1669500302-CANARY';
const USER_REF = 'me.npi';
// The entity resolver is keyed by the BARE field name (the canonical registry is
// mocked as identity). The client maps `me.npi` -> ?field=npi, so this bag is
// keyed by `npi`, not `me.npi`.
const USER_BAG = {
  npi: NPI_CANARY,
};

// Mirror electron/typebuild/task-data.ts isUserDataRef + the me.* -> field strip.
const isUserRef = (ref) => ref.startsWith('me.');
const refToField = (ref) => ref.slice('me.'.length);

function startStub() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');

    // (b1) TypeBuild REST class 1: GET /chromeext/<id>/data?ref=<key> -> {value}
    // / 404. The <id> segment is the task id for class-1 (patient PHI) refs.
    const rest = u.pathname.match(/^\/chromeext\/([^/]+)\/data$/);
    if (rest && req.method === 'GET') {
      const ref = u.searchParams.get('ref') ?? '';
      const value = DATA_BAG[ref];
      if (typeof value !== 'string') {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: 'no data' }));
      }
      res.statusCode = 200;
      return res.end(JSON.stringify({ value }));
    }

    // (b2) TypeBuild REST class 2: the user-credential ENTITY RESOLVER.
    // GET /chromeext/entities/resolve?field=<name>[&entity=<id|me>] -> the
    // resolved/not-resolved envelope. entity defaults to `me`. The vault bag is
    // keyed by the bare field name (the canonical registry is mocked as identity
    // here). This is what the shipped server exposes; the client maps a `me.npi`
    // ref to ?field=npi.
    if (u.pathname === '/chromeext/entities/resolve' && req.method === 'GET') {
      const field = u.searchParams.get('field') ?? '';
      if (!field) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'field required' }));
      }
      const value = USER_BAG[field];
      res.statusCode = 200;
      if (typeof value === 'string') {
        return res.end(JSON.stringify({ resolved: true, field, value }));
      }
      // not_found carries non-secret field NAMES only — never a value.
      return res.end(
        JSON.stringify({ resolved: false, reason: 'not_found', available: Object.keys(USER_BAG) }),
      );
    }

    // (a) Breeze control API: GET /app/task-data?taskId=&ref= -> {ok,ref,value}.
    // Mirrors electron/api-server.ts: 400 when taskId/ref missing, otherwise
    // delegates to the same one-ref-at-a-time resolve the REST stub serves.
    if (u.pathname === '/app/task-data' && req.method === 'GET') {
      const taskId = u.searchParams.get('taskId') ?? '';
      const ref = u.searchParams.get('ref') ?? '';
      // A "me." ref resolves against the per-user vault and needs NO taskId; any
      // other ref is patient PHI on a specific task, so taskId is mandatory.
      if (!ref || (!isUserRef(ref) && !taskId)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'ref required (and taskId for non-me.* refs)' }));
      }
      const value = isUserRef(ref) ? USER_BAG[refToField(ref)] : DATA_BAG[ref];
      if (typeof value !== 'string') {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: `no data for ref "${ref}"` }));
      }
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, ref, value }));
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            /* leave null */
          }
          resolve({ status: res.statusCode, body, json });
        });
      })
      .on('error', reject);
  });
}

// ── (a) Breeze control-API contract: GET /app/task-data ─────────────────────

test('control API: missing taskId returns 400', async () => {
  const { server, port } = await startStub();
  try {
    const r = await get(port, `/app/task-data?ref=${encodeURIComponent(REF)}`);
    assert.equal(r.status, 400, 'missing taskId must be a 400');
    assert.equal(r.json?.ok, undefined, '400 must not be a success envelope');
  } finally {
    server.close();
  }
});

test('control API: missing ref returns 400', async () => {
  const { server, port } = await startStub();
  try {
    const r = await get(port, `/app/task-data?taskId=${encodeURIComponent(TASK_ID)}`);
    assert.equal(r.status, 400, 'missing ref must be a 400');
  } finally {
    server.close();
  }
});

test('control API: success envelope is {ok, ref, value} for a known ref', async () => {
  const { server, port } = await startStub();
  try {
    const r = await get(
      port,
      `/app/task-data?taskId=${encodeURIComponent(TASK_ID)}&ref=${encodeURIComponent(REF)}`,
    );
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.ref, REF, 'envelope must echo the opaque ref');
    assert.equal(r.json.value, SECRET_VALUE, 'envelope must carry the resolved value to the helper');
  } finally {
    server.close();
  }
});

test('control API: unknown ref is a non-200 and does not invent a value', async () => {
  const { server, port } = await startStub();
  try {
    const r = await get(
      port,
      `/app/task-data?taskId=${encodeURIComponent(TASK_ID)}&ref=patient.unknown`,
    );
    assert.equal(r.status, 404, 'unknown ref must map to non-200');
    assert.equal(r.json?.value, undefined, 'a non-200 must never carry a value');
    // The error envelope carries only the opaque ref key, never a value.
    assert.ok(!r.body.includes(SECRET_VALUE), 'error body leaked an unrelated secret value');
  } finally {
    server.close();
  }
});

// ── Class-2 (user credential vault, "me.*" refs) routing contract ───────────
// The control API routes "me." refs to the per-user vault and must NOT require
// a taskId for them; non-me refs still must. (electron/api-server.ts +
// electron/typebuild/task-data.ts isUserDataRef.)

test('control API: a "me." ref resolves WITHOUT a taskId (class-2 vault)', async () => {
  const { server, port } = await startStub();
  try {
    const r = await get(port, `/app/task-data?ref=${encodeURIComponent(USER_REF)}`);
    assert.equal(r.status, 200, 'me.* ref must resolve with no taskId');
    assert.equal(r.json.ok, true);
    assert.equal(r.json.ref, USER_REF, 'envelope must echo the opaque me.* ref');
    assert.equal(r.json.value, NPI_CANARY, 'me.* ref must carry the vault value to the helper');
  } finally {
    server.close();
  }
});

test('control API: a non-me ref STILL requires a taskId (400 without one)', async () => {
  const { server, port } = await startStub();
  try {
    const r = await get(port, `/app/task-data?ref=${encodeURIComponent(REF)}`);
    assert.equal(r.status, 400, 'patient.* ref without a taskId must be a 400');
    assert.equal(r.json?.ok, undefined, '400 must not be a success envelope');
  } finally {
    server.close();
  }
});

test('control API: an unknown "me." ref is a 404 and invents no value', async () => {
  const { server, port } = await startStub();
  try {
    const r = await get(port, `/app/task-data?ref=me.unknown`);
    assert.equal(r.status, 404, 'unknown me.* ref must map to non-200');
    assert.equal(r.json?.value, undefined, 'a non-200 must never carry a value');
    assert.ok(!r.body.includes(NPI_CANARY), 'error body leaked the vault canary');
  } finally {
    server.close();
  }
});

test('typebuild REST: the per-user vault resolves via /chromeext/entities/resolve', async () => {
  const { server, port } = await startStub();
  try {
    // The client maps `me.npi` -> ?field=npi (entity defaults to `me`, omitted).
    const r = await get(
      port,
      `/chromeext/entities/resolve?field=${encodeURIComponent(refToField(USER_REF))}`,
    );
    assert.equal(r.status, 200);
    assert.equal(r.json.resolved, true, 'a known field must resolve');
    assert.equal(r.json.value, NPI_CANARY, 'resolve must return the one value');
  } finally {
    server.close();
  }
});

test('typebuild REST: an unknown field is resolved:false/not_found with NAMES only', async () => {
  const { server, port } = await startStub();
  try {
    const r = await get(port, `/chromeext/entities/resolve?field=nope`);
    assert.equal(r.status, 200, 'the resolver answers 200 with a resolved:false envelope');
    assert.equal(r.json.resolved, false);
    assert.equal(r.json.reason, 'not_found');
    assert.ok(Array.isArray(r.json.available), 'not_found lists available field NAMES');
    // Names only — never a value.
    assert.ok(!r.body.includes(NPI_CANARY), 'not_found envelope leaked the vault canary');
  } finally {
    server.close();
  }
});

test('SECURITY: a class-2 (me.*) value never co-mingles with the task bag', async () => {
  const { server, port } = await startStub();
  try {
    // Asking the task path for the user's ref must NOT find it (separate bag),
    // so a me.* value can't be obtained by guessing it onto an arbitrary task.
    const r = await get(
      port,
      `/chromeext/${encodeURIComponent(TASK_ID)}/data?ref=${encodeURIComponent(USER_REF)}`,
    );
    assert.equal(r.status, 404, 'me.* refs must not resolve from a task bag');
    assert.ok(!r.body.includes(NPI_CANARY), 'task path leaked the vault canary');
  } finally {
    server.close();
  }
});

// ── (b) TypeBuild REST contract: GET /chromeext/<id>/data ────────────────────
// This is the contract electron/typebuild/task-data.ts resolveTaskDataRef
// depends on. We can't import that function without Electron, so we assert the
// server contract it is written against (one ref at a time; 404 -> the resolver
// throws; value must be a string).

test('typebuild REST: returns exactly {value} for a known ref (one ref at a time)', async () => {
  const { server, port } = await startStub();
  try {
    const r = await get(port, `/chromeext/${encodeURIComponent(TASK_ID)}/data?ref=${encodeURIComponent(REF)}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.value, SECRET_VALUE);
    // Single-ref discipline: the response must carry ONLY the asked value, not
    // the whole decrypted bag (the other key must not be present).
    assert.ok(!r.body.includes('Alex'), 'REST leaked an unrelated data key — should be one ref at a time');
  } finally {
    server.close();
  }
});

test('typebuild REST: unknown ref is a 404 (resolver maps this to a throw)', async () => {
  const { server, port } = await startStub();
  try {
    const r = await get(port, `/chromeext/${encodeURIComponent(TASK_ID)}/data?ref=nope`);
    assert.equal(r.status, 404, 'unknown ref must 404 so resolveTaskDataRef throws');
  } finally {
    server.close();
  }
});

// ── (3) THE KEY SECURITY ASSERTION: the value never reaches stdout ───────────
// cli.mjs's real resolveDataRef + fill-ref output are CDP-gated (see todo
// below), so we assert the contract against the smallest reachable unit: a
// harness that performs the IDENTICAL fetch + IDENTICAL success print that
// cli.mjs's fill-ref does:
//     resolveDataRef -> fetch /app/task-data -> body.value
//     print `filled <sel> (ref <ref>)`   (NEVER the value)
// We prove the only thing printed contains the REF and NOT the VALUE.

async function harnessFillRefOutput(port, sel, ref) {
  // Mirror of cli.mjs resolveDataRef + fill-ref's stdout line. The value is
  // fetched into this process's memory and used to "fill" (here: discarded),
  // but the ONLY thing emitted is the opaque-ref success line.
  const r = await get(
    port,
    `/app/task-data?taskId=${encodeURIComponent(TASK_ID)}&ref=${encodeURIComponent(ref)}`,
  );
  assert.equal(r.status, 200);
  const value = r.json.value;
  assert.equal(typeof value, 'string', 'resolve must yield a string value');
  // (the real cli.mjs would: await loc(page, sel).fill(value))
  return `filled ${sel} (ref ${ref})\n`;
}

test('SECURITY: fill-ref success output contains the ref and NOT the value', async () => {
  const { server, port } = await startStub();
  try {
    const out = await harnessFillRefOutput(port, '#ssn', REF);
    assert.ok(out.includes(REF), 'output should name the opaque ref for traceability');
    assert.ok(out.includes('#ssn'), 'output should name the selector');
    assert.ok(
      !out.includes(SECRET_VALUE),
      'LEAK: the resolved PII value reached stdout — the entire boundary is defeated',
    );
  } finally {
    server.close();
  }
});

test('SECURITY: the resolved value lives only in process memory, never in the emitted line', async () => {
  // A stronger phrasing: the value is fetched (so it IS in memory), yet the
  // returned/printed surface is byte-for-byte free of it.
  const { server, port } = await startStub();
  try {
    // Confirm the value really is retrievable (so the assertion below is not
    // vacuously true because the fetch failed).
    const probe = await get(
      port,
      `/app/task-data?taskId=${encodeURIComponent(TASK_ID)}&ref=${encodeURIComponent(REF)}`,
    );
    assert.equal(probe.json.value, SECRET_VALUE, 'precondition: value is resolvable');

    const out = await harnessFillRefOutput(port, 'input[name=ssn]', REF);
    assert.equal(out.indexOf(SECRET_VALUE), -1, 'emitted line must not contain the value');
  } finally {
    server.close();
  }
});

// ── cli.mjs surface reachable WITHOUT a browser/CDP ──────────────────────────
// Almost everything in cli.mjs runs after chromium.connectOverCDP(), which CI
// lacks. The few pre-CDP paths we CAN drive: the no-verb usage error, and the
// missing-api.json failure (apiConfig runs before CDP for the `open` verb).

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cliMjs, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...env },
  });
}

test('cli.mjs: no verb prints usage and exits 1 (pre-CDP path)', () => {
  const r = runCli([]);
  assert.equal(r.status, 1, `exit ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stderr, /usage: cli\.mjs <verb>/);
});

test('cli.mjs: `open` fails clearly when api.json is absent (pre-CDP path)', () => {
  // Point HOME at an empty dir so ~/.breezefile/api.json can't be read. The
  // `open` verb hits apiConfig() before connectOverCDP, so this is reachable.
  const emptyHome = mkdtempSync(join(tmpdir(), 'breeze-noapi-'));
  try {
    const r = runCli(['open'], { HOME: emptyHome, USERPROFILE: emptyHome });
    assert.equal(r.status, 1, `exit ${r.status}; stdout=${r.stdout}`);
    assert.match(r.stderr, /cannot read .*api\.json/);
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

// ── End-to-end fill-ref through cli.mjs: SECRET never on stdout/stderr ────────
// The genuine path (cli.mjs fill-ref -> resolveDataRef -> /app/task-data ->
// fill over CDP) needs a live CDP browser, which CI lacks (resolveDataRef and
// the no-task-id guard both run AFTER chromium.connectOverCDP). When a live app
// IS present we still can't guarantee a CDP browser tab, so this stays guarded
// by skip-if-no-app exactly like tests/cli.test.mjs. Even so we point api.json
// at our stub and assert that whatever cli.mjs emits, the SECRET never appears.

test(
  'cli.mjs fill-ref never leaks the value on stdout/stderr (needs live app + browser)',
  { skip: !existsSync(apiFile) },
  async () => {
    const { server, port } = await startStub();
    const fakeHome = mkdtempSync(join(tmpdir(), 'breeze-stubapi-'));
    try {
      mkdirSync(join(fakeHome, '.breezefile'), { recursive: true });
      writeFileSync(
        join(fakeHome, '.breezefile', 'api.json'),
        JSON.stringify({ port, token: 'stub-token' }),
      );
      const r = runCli(['fill-ref', '#ssn', REF], {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        BREEZE_TYPEBUILD_TASK_ID: TASK_ID,
        // Force a dead CDP endpoint so we never hang waiting for a browser; the
        // command will fail at connectOverCDP, but the security invariant —
        // the SECRET never being emitted — must still hold on every path.
        BREEZE_CDP_URL: 'http://127.0.0.1:1',
      });
      const combined = `${r.stdout}\n${r.stderr}`;
      assert.ok(
        !combined.includes(SECRET_VALUE),
        `LEAK: cli.mjs emitted the resolved PII value:\n${combined}`,
      );
    } finally {
      server.close();
      rmSync(fakeHome, { recursive: true, force: true });
    }
  },
);

// ── scrubError: the failed-fill value-leak fix (directly unit-testable) ──────
// A fill/type that fails AFTER the value is resolved throws a Playwright error
// whose "Call log:" block interpolates the literal value. fill-ref/type-ref run
// that error through scrubError before it can reach stderr. scrub.mjs is pure
// (no side effects on import), so we exercise the redaction contract head-on —
// closing the most important gap from the leak review.
const { scrubError } = await import(join(repoRoot, 'electron', 'browser', 'scrub.mjs'));
const SECRET = '123-45-6789';

test('scrubError: redacts the value from a Playwright Call log error', () => {
  const err = new Error(
    `locator.fill: Timeout 30000ms exceeded.\n` +
      `Call log:\n  - waiting for locator('#ssn')\n  - fill("${SECRET}")`,
  );
  const out = scrubError(err, SECRET);
  assert.ok(!out.includes(SECRET), 'scrubbed output must not contain the value');
  assert.ok(!out.includes('Call log'), 'call-log block must be dropped');
  assert.match(out, /Timeout/, 'keeps the useful first line for diagnosis');
});

test('scrubError: redacts the value even if it appears on the first line', () => {
  const err = new Error(`value "${SECRET}" was rejected by the field`);
  const out = scrubError(err, SECRET);
  assert.ok(!out.includes(SECRET), 'value must be redacted wherever it appears');
  assert.match(out, /<redacted>/);
});

test('scrubError: tolerates an empty/missing secret and bounds the length', () => {
  assert.doesNotThrow(() => scrubError(new Error('boom'), ''));
  assert.equal(scrubError(new Error('boom'), ''), 'boom');
  const long = scrubError(new Error('x'.repeat(500)), SECRET);
  assert.ok(long.length <= 200, 'output is bounded to one short line');
});

// ── Coverage gap, recorded explicitly ────────────────────────────────────────
// The TRUE end-to-end of cli.mjs's own resolveDataRef + fill-ref success print
// is unreachable in CI because both run after chromium.connectOverCDP(). The
// SECURITY tests above assert the contract against a faithful harness instead.
// To close this for real, cli.mjs would need either (a) resolveDataRef/usage
// checks hoisted before connectOverCDP, or (b) a test that stands up a CDP
// endpoint (a headless Electron/Chromium with --remote-debugging-port). Until
// then, mark the gap.
test.todo(
  'e2e: cli.mjs fill-ref drives resolveDataRef + fill over a real CDP browser ' +
    '(unreachable in CI — resolveDataRef is gated behind connectOverCDP)',
);
test.todo(
  'cli.mjs fill-ref without BREEZE_TYPEBUILD_TASK_ID fails with the task-id ' +
    'guard message (unreachable in CI — the guard runs after connectOverCDP)',
);
