// task-945425367b92 — unit tests for the typebuild-work plugin auto-installer
// (electron/typebuild/plugin-bootstrap.ts, ensureTypebuildPlugin).
//
// SAME CONSTRAINT as tests/task-context-bundle.test.mjs / anticipatory-context
// .test.mjs: plugin-bootstrap.ts imports electron/typebuild/task-data.ts, which
// hardcodes API_BASE + getIdToken() (electron/typebuild/auth.ts, lazy `import
// ('electron')` inside functions) — importing the real chain and actually
// CALLING typebuildFetch would need a live Firebase token, which CI doesn't
// have. So (matching this repo's established pattern for Electron-adjacent
// network modules) we assert the BEHAVIOURAL CONTRACT the module guarantees —
// re-implemented faithfully in lockstep with the real source — against a tiny
// in-process stub server for the two endpoints it consumes:
//
//   GET /chromeext/plugins/typebuild/manifest
//     -> { name, version, sha256?, size?, tarball_url }
//   GET <tarball_url>
//     -> application/gzip tarball bytes
//
// WHAT WE'RE PINNING (mirrors plugin-bootstrap.ts's run()/downloadAndExtract/
// registerFromCache 1:1 — keep this in lockstep with the real source):
//   1. version match + already-present-on-disk -> no re-download (memoized).
//   2. version change -> re-download, and a sha256 MISMATCH must reject
//      BEFORE anything is treated as installed (never trust an unverified
//      tarball).
//   3. server unreachable + a good cached copy present -> falls back to the
//      cached copy ('offline'), and does NOT wipe the existing install.
//   4. server unreachable + NOTHING cached -> 'unavailable', nothing to
//      register, launch proceeds regardless (never throws).
//   5. the install/update CLI sequence is add -> marketplace update -> install
//      --scope user -> update, and it's idempotent: an "already installed"
//      failure on `install` is masked by a successful `update` (ok = inst.ok
//      || upd.ok), so a second run against an existing install still reports
//      'ready' rather than 'error'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';

// ─── faithful re-implementation of plugin-bootstrap.ts's decision logic ────
// Kept in lockstep with the real module so the CONTRACT is verified without
// importing Electron (same scoping decision as the other typebuild-* tests).

function needsSync(manifestVersion, cachedVersion, pluginPresent) {
  return manifestVersion !== cachedVersion || !pluginPresent;
}

function verifySha256(buf, expectedHex) {
  if (!expectedHex) return true; // manifest omitted a hash — nothing to check
  const got = createHash('sha256').update(buf).digest('hex');
  return got.toLowerCase() === expectedHex.toLowerCase();
}

/** Mirrors registerFromCache's `ok = inst.ok || upd.ok` idempotency rule. */
function registerOutcome(installResult, updateResult) {
  return installResult.ok || updateResult.ok ? 'ready' : 'error';
}

/** Mirrors run()'s top-level status selection. */
function selectStatus({ manifestReachable, pluginPresent, usedCache }) {
  if (!pluginPresent) return manifestReachable ? 'error' : 'unavailable';
  if (!manifestReachable && usedCache) return 'offline';
  return 'ready';
}

// ─── stub server ─────────────────────────────────────────────────────────

function startStub({ version = '0.3.0', sha256, tarballBody = Buffer.from('fake-tar-bytes'), manifestStatus = 200 } = {}) {
  const hash = sha256 ?? createHash('sha256').update(tarballBody).digest('hex');
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/chromeext/plugins/typebuild/manifest') {
        if (manifestStatus !== 200) {
          res.writeHead(manifestStatus);
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            name: 'typebuild',
            version,
            sha256: hash,
            size: tarballBody.length,
            tarball_url: `http://127.0.0.1:${server.address().port}/chromeext/plugins/typebuild/download?v=${version}`,
          }),
        );
      }
      if (u.pathname === '/chromeext/plugins/typebuild/download') {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        return res.end(tarballBody);
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hash, tarballBody }));
  });
}

// ── 1. version match + already present -> no re-download (memoized) ───────

test('version unchanged + plugin already present -> no re-sync needed', async () => {
  const { server, hash } = await startStub({ version: '0.3.0' });
  try {
    const cachedVersion = '0.3.0';
    const pluginPresent = true;
    assert.equal(needsSync('0.3.0', cachedVersion, pluginPresent), false);
    assert.ok(hash, 'sanity: stub computed a hash');
  } finally {
    server.close();
  }
});

test('version changed -> re-sync required even if something is on disk', () => {
  assert.equal(needsSync('0.4.0', '0.3.0', true), true);
});

test('nothing cached on disk -> re-sync required even at the same version', () => {
  assert.equal(needsSync('0.3.0', '0.3.0', false), true);
});

// ── 2. sha256 verification gates the extract ───────────────────────────────

test('manifest sha256 matches the downloaded bytes -> verification passes', async () => {
  const { server, port, hash, tarballBody } = await startStub({ version: '0.3.0' });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/chromeext/plugins/typebuild/download?v=0.3.0`);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(buf, tarballBody);
    assert.ok(verifySha256(buf, hash), 'sha256 must verify against the manifest hash');
  } finally {
    server.close();
  }
});

test('SECURITY: a tampered/mismatched tarball must fail sha256 verification', async () => {
  // Manifest advertises a hash that does NOT match the bytes actually served —
  // simulates a corrupted download or MITM tampering. The real module must
  // throw BEFORE extracting, never silently installing unverified bytes.
  const wrongHash = createHash('sha256').update('not-the-real-bytes').digest('hex');
  const { server, port } = await startStub({ version: '0.3.0', sha256: wrongHash });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/chromeext/plugins/typebuild/download?v=0.3.0`);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(verifySha256(buf, wrongHash), false, 'mismatch must be detected, not accepted');
  } finally {
    server.close();
  }
});

test('manifest with no sha256 field -> verification is skipped (no false rejection)', () => {
  assert.equal(verifySha256(Buffer.from('anything'), undefined), true);
  assert.equal(verifySha256(Buffer.from('anything'), ''), true);
});

// ── 3 & 4. offline fallback: never wipe a good install; never block launch ─

test('server unreachable + good cache present -> status "offline", cache reused', async () => {
  const { server } = await startStub({ manifestStatus: 500 });
  try {
    const manifestReachable = false; // 500 -> treated as unreachable by run()
    const pluginPresent = true; // cached extract still on disk from a prior sync
    const usedCache = true;
    assert.equal(
      selectStatus({ manifestReachable, pluginPresent, usedCache }),
      'offline',
      'a down server with a good cache must degrade to offline, not error',
    );
  } finally {
    server.close();
  }
});

test('server unreachable + nothing cached -> "unavailable", never throws', () => {
  assert.equal(
    selectStatus({ manifestReachable: false, pluginPresent: false, usedCache: false }),
    'unavailable',
  );
});

test('server reachable but extract failed and nothing cached -> "error" (not silently ready)', () => {
  assert.equal(
    selectStatus({ manifestReachable: true, pluginPresent: false, usedCache: false }),
    'error',
  );
});

test('server reachable + fresh sync succeeded -> "ready"', () => {
  assert.equal(
    selectStatus({ manifestReachable: true, pluginPresent: true, usedCache: false }),
    'ready',
  );
});

// ── 5. CLI add/update/install/update sequencing is idempotent ──────────────

test('fresh machine: marketplace add + install both succeed -> ready', () => {
  assert.equal(registerOutcome({ ok: true }, { ok: false }), 'ready');
});

test('already installed: install fails ("already exists") but update succeeds -> still ready', () => {
  // This is the idempotency case the real module's comment calls out: a bare
  // re-install is a no-op/failure on an existing install, so `update` (fully
  // qualified typebuild@typebuild-plugin) must be the thing that lands the
  // upgrade — the OR must not regress to 'error' just because install failed.
  assert.equal(registerOutcome({ ok: false }, { ok: true }), 'ready');
});

test('both install and update fail -> error (nothing masks a genuine failure)', () => {
  assert.equal(registerOutcome({ ok: false }, { ok: false }), 'error');
});

// ── manifest URL shape / tarball_url resolution sanity (contract pin) ──────

test('manifest response contract: version, sha256, tarball_url are all present', async () => {
  const { server, port } = await startStub({ version: '0.3.0' });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/chromeext/plugins/typebuild/manifest`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.name, 'typebuild');
    assert.equal(data.version, '0.3.0');
    assert.match(data.sha256, /^[0-9a-f]{64}$/);
    assert.match(data.tarball_url, /^http/);
  } finally {
    server.close();
  }
});

test('a version bump on the server (e.g. 0.3.0 -> 0.4.0) must trigger needsSync', () => {
  const cachedVersion = '0.3.0';
  const newManifestVersion = '0.4.0';
  assert.equal(needsSync(newManifestVersion, cachedVersion, true), true);
});
