// task-6e6f4acb5d65 — unit tests for the headless env-refresh-token sign-in
// path (electron/typebuild/auth.ts: signInHeadlessWithRefreshToken,
// initHeadlessAuth). A Google-OAuth-only service account has no Firebase
// password, so the pre-existing TYPEBUILD_EMAIL/TYPEBUILD_PASSWORD headless
// path can't sign it in at all; this lets a token minted interactively on a
// GUI machine (TYPEBUILD_REFRESH_TOKEN) bootstrap the daemon's session
// instead, via the existing doRefresh() securetoken exchange.
//
// Same transpile-on-the-fly approach as tests/typebuild-http.test.mjs and
// tests/task-work-bundle.test.mjs: this repo's `node --test` runner has no TS
// loader, so we transpile+bundle the REAL source with esbuild rather than
// reimplementing the logic in a separately-tested copy. auth.ts has a
// relative import (./http), so we use esbuild's bundler (not just
// transformSync) with `electron` marked external — electron is only ever
// dynamically imported inside the CredentialStore methods, which this path
// never reaches (it installs the memory-only store).
//
// WHAT WE'RE PINNING:
//   1. TYPEBUILD_REFRESH_TOKEN present → initHeadlessAuth() calls doRefresh()
//      with it (via the securetoken REST exchange) and never touches disk
//      (no fs.writeFile call at all during the flow).
//   2. TYPEBUILD_REFRESH_TOKEN absent → falls back to the existing
//      TYPEBUILD_EMAIL/TYPEBUILD_PASSWORD behavior (or null if neither set).
//   3. The raw token value never appears in ANYTHING written to
//      console.log/warn/error during the flow — success, failure, or a
//      thrown error — grep-assertable against captured console output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcEntry = path.join(here, '..', 'electron', 'typebuild', 'auth.ts');

// Load a FRESH bundled copy of the module for each test, since `session` /
// `credentialStore` are process-global module state in the real module.
async function loadAuthModule() {
  const result = await esbuild.build({
    entryPoints: [srcEntry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    external: ['electron'],
    target: 'es2022',
  });
  const code = result.outputFiles[0].text;
  const tmpFile = path.join(
    tmpdir(),
    `typebuild-auth.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.mjs`,
  );
  writeFileSync(tmpFile, code);
  const mod = await import(pathToFileURL(tmpFile).href);
  rmSync(tmpFile, { force: true });
  return mod;
}

// Fake a real Firebase JWT so decodeClaims() doesn't choke — header.payload.sig,
// payload base64url of {email, sub}.
function fakeIdToken(email, sub) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ email, sub })).toString('base64url');
  return `${header}.${payload}.sig`;
}

const SECRET_TOKEN = 'AMf-vBy_super-secret-refresh-token-value-DO-NOT-LEAK';

function withEnv(vars, fn) {
  const prevValues = {};
  for (const key of Object.keys(vars)) prevValues[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(prevValues)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

// Capture every console.log/warn/error call's stringified args during `fn`.
async function captureConsole(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    await fn();
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
  return lines;
}

// ── 1. env var present → doRefresh() path is used, no disk write ───────────

test('TYPEBUILD_REFRESH_TOKEN present: initHeadlessAuth signs in via securetoken exchange, no disk write', async () => {
  const { initHeadlessAuth, getAuthState, setCredentialStore } = await loadAuthModule();

  // Install a spy CredentialStore standing in for the Electron-backed
  // (disk-persisting) default BEFORE calling initHeadlessAuth(). The
  // env-token path must swap in its own memory-only store, so if this spy's
  // save() is ever invoked, the code regressed to persisting via whatever
  // store happened to be active (i.e. it stopped installing the memory-only
  // store) — the real proof of "no disk write" for THIS path.
  let saveCalls = 0;
  let loadCalls = 0;
  setCredentialStore({
    async save() {
      saveCalls += 1;
    },
    async load() {
      loadCalls += 1;
      return null;
    },
    async clear() {},
  });

  let calledUrl = null;
  let calledBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calledUrl = String(url);
    calledBody = init?.body ? String(init.body) : null;
    return new Response(
      JSON.stringify({
        id_token: fakeIdToken('svc@example.com', 'uid-123'),
        refresh_token: 'rotated-refresh-token',
        expires_in: '3600',
      }),
      { status: 200 },
    );
  };

  try {
    await withEnv(
      { TYPEBUILD_REFRESH_TOKEN: SECRET_TOKEN, TYPEBUILD_EMAIL: undefined, TYPEBUILD_PASSWORD: undefined },
      async () => {
        const result = await initHeadlessAuth();
        assert.ok(result, 'expected a non-null AuthState');
        assert.equal(result.signedIn, true);
        assert.equal(result.email, 'svc@example.com');
      },
    );

    assert.ok(calledUrl, 'expected a fetch call');
    assert.match(calledUrl, /securetoken\.googleapis\.com/, 'must go through the securetoken refresh exchange, not signInWithPassword');
    assert.match(calledBody, /grant_type=refresh_token/);
    assert.match(calledBody, new RegExp(`refresh_token=${SECRET_TOKEN}`), 'the exact env token must be sent as the refresh_token');

    assert.equal(getAuthState().signedIn, true);
    assert.equal(saveCalls, 0, 'the pre-installed (disk-capable) store must never be used to persist — the env-token path installs its own memory-only store');
    assert.equal(loadCalls, 0, 'the pre-installed store must never be read from either');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── 2. env var absent → falls back to existing email/password behavior ─────

test('TYPEBUILD_REFRESH_TOKEN absent, email/password present: falls back to signInHeadless (email/password REST call)', async () => {
  const { initHeadlessAuth } = await loadAuthModule();

  let calledUrl = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calledUrl = String(url);
    return new Response(
      JSON.stringify({
        idToken: fakeIdToken('pw-user@example.com', 'uid-456'),
        refreshToken: 'pw-refresh-token',
        expiresIn: '3600',
        email: 'pw-user@example.com',
      }),
      { status: 200 },
    );
  };

  try {
    await withEnv(
      { TYPEBUILD_REFRESH_TOKEN: undefined, TYPEBUILD_EMAIL: 'pw-user@example.com', TYPEBUILD_PASSWORD: 'hunter2' },
      async () => {
        const result = await initHeadlessAuth();
        assert.ok(result);
        assert.equal(result.signedIn, true);
        assert.equal(result.email, 'pw-user@example.com');
      },
    );
    assert.match(calledUrl, /signInWithPassword/, 'must fall back to the email/password Identity Toolkit call');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('neither TYPEBUILD_REFRESH_TOKEN nor TYPEBUILD_EMAIL/PASSWORD set: returns null (no loop, no throw)', async () => {
  const { initHeadlessAuth } = await loadAuthModule();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('should not be called — no credentials were provided');
  };

  try {
    await withEnv(
      { TYPEBUILD_REFRESH_TOKEN: undefined, TYPEBUILD_EMAIL: undefined, TYPEBUILD_PASSWORD: undefined },
      async () => {
        const result = await initHeadlessAuth();
        assert.equal(result, null);
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('TYPEBUILD_REFRESH_TOKEN takes priority even when email/password are also set', async () => {
  const { initHeadlessAuth } = await loadAuthModule();

  let calledUrl = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calledUrl = String(url);
    return new Response(
      JSON.stringify({
        id_token: fakeIdToken('svc@example.com', 'uid-123'),
        refresh_token: 'rotated-refresh-token',
        expires_in: '3600',
      }),
      { status: 200 },
    );
  };

  try {
    await withEnv(
      {
        TYPEBUILD_REFRESH_TOKEN: SECRET_TOKEN,
        TYPEBUILD_EMAIL: 'pw-user@example.com',
        TYPEBUILD_PASSWORD: 'hunter2',
      },
      async () => {
        await initHeadlessAuth();
      },
    );
    assert.match(calledUrl, /securetoken\.googleapis\.com/, 'refresh-token path must win over email/password when both are set');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── 3. the token is never present in ANY log output, success or failure ────

test('the refresh token never appears in console output on a successful sign-in', async () => {
  const { initHeadlessAuth } = await loadAuthModule();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id_token: fakeIdToken('svc@example.com', 'uid-123'),
        refresh_token: 'rotated-refresh-token-also-secret',
        expires_in: '3600',
      }),
      { status: 200 },
    );

  try {
    const lines = await captureConsole(() =>
      withEnv({ TYPEBUILD_REFRESH_TOKEN: SECRET_TOKEN, TYPEBUILD_EMAIL: undefined, TYPEBUILD_PASSWORD: undefined }, () =>
        initHeadlessAuth(),
      ),
    );
    const joined = lines.join('\n');
    assert.doesNotMatch(joined, new RegExp(SECRET_TOKEN), 'the raw env refresh token must never be logged');
    assert.doesNotMatch(joined, /rotated-refresh-token-also-secret/, 'a rotated refresh token must never be logged either');
    // Also guard against truncated/partial leaks (e.g. a prefix slice).
    assert.doesNotMatch(joined, new RegExp(SECRET_TOKEN.slice(0, 12)), 'no partial/truncated token prefix should be logged');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the refresh token never appears in console output when the exchange fails', async () => {
  const { initHeadlessAuth } = await loadAuthModule();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'TOKEN_EXPIRED' } }), { status: 400 });

  try {
    const lines = await captureConsole(async () => {
      await withEnv(
        { TYPEBUILD_REFRESH_TOKEN: SECRET_TOKEN, TYPEBUILD_EMAIL: undefined, TYPEBUILD_PASSWORD: undefined },
        async () => {
          await assert.rejects(() => initHeadlessAuth(), /TOKEN_EXPIRED/);
        },
      );
    });
    const joined = lines.join('\n');
    assert.doesNotMatch(joined, new RegExp(SECRET_TOKEN), 'the raw env refresh token must never be logged, even on failure');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
