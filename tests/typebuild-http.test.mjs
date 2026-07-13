// task-24cd55d8a607 — unit tests for the shared origin gate in
// electron/typebuild/http.ts (slow-episode resilience): the concurrency
// semaphore and the timeout circuit breaker that fetchWithTimeout funnels
// every TypeBuild-origin request through.
//
// Same transpile-on-the-fly approach as tests/task-work-bundle.test.mjs: this
// repo's `node --test` runner has no TS loader, so we transpile the real
// source with esbuild (already a dependency via vite) rather than
// reimplementing the logic in a separately-tested copy.
//
// WHAT WE'RE PINNING:
//   1. Semaphore: at most MAX_ORIGIN_CONCURRENCY requests run concurrently;
//      a queued waiter gets exactly one slot once one frees up; a THROWING
//      fetch still releases its slot (finally, not just the success path).
//   2. Breaker: N consecutive timeouts trips isOriginDegraded() to true and
//      fires onOriginHealthChange(true); a single subsequent SUCCESS (even a
//      "500" style response — any completed response) resets the counter and
//      closes the breaker; a non-timeout rejection (e.g. network refused)
//      does NOT trip the timeout breaker on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));

// Load a FRESH copy of the module (fresh module-level semaphore/breaker
// state) for each test, since that state is process-global in the real module.
async function loadHttpModule() {
  const srcPath = path.join(here, '..', 'electron', 'typebuild', 'http.ts');
  const source = readFileSync(srcPath, 'utf8');
  const { code } = esbuild.transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' });
  const tmpFile = path.join(
    tmpdir(),
    `typebuild-http.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.mjs`,
  );
  writeFileSync(tmpFile, code);
  const mod = await import(pathToFileURL(tmpFile).href);
  rmSync(tmpFile, { force: true });
  return mod;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── 1. Semaphore caps concurrency and admits queued waiters one at a time ───

test('fetchWithTimeout caps concurrent in-flight requests at MAX_ORIGIN_CONCURRENCY', async () => {
  const { fetchWithTimeout, MAX_ORIGIN_CONCURRENCY } = await loadHttpModule();

  let inFlight = 0;
  let maxObserved = 0;
  const gates = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    inFlight += 1;
    maxObserved = Math.max(maxObserved, inFlight);
    const g = deferred();
    gates.push(g);
    await g.promise;
    inFlight -= 1;
    return new Response('ok');
  };

  try {
    const total = MAX_ORIGIN_CONCURRENCY + 4;
    const calls = Array.from({ length: total }, () => fetchWithTimeout('https://example.test/x'));

    // Let all admitted requests reach the gate.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      maxObserved,
      MAX_ORIGIN_CONCURRENCY,
      'no more than MAX_ORIGIN_CONCURRENCY requests should be in flight at once',
    );
    assert.equal(gates.length, MAX_ORIGIN_CONCURRENCY, 'exactly the cap should have been admitted so far');

    // Release them all; the queued remainder should drain through the same cap.
    gates.splice(0).forEach((g) => g.resolve());
    await new Promise((r) => setTimeout(r, 20));
    gates.splice(0).forEach((g) => g.resolve());

    await Promise.all(calls);
    assert.ok(maxObserved <= MAX_ORIGIN_CONCURRENCY, 'concurrency cap held for the whole run');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a queued waiter is admitted exactly once when a slot frees (no double-increment)', async () => {
  const { fetchWithTimeout, MAX_ORIGIN_CONCURRENCY } = await loadHttpModule();

  let inFlight = 0;
  let overCap = false;
  const gates = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    inFlight += 1;
    if (inFlight > MAX_ORIGIN_CONCURRENCY) overCap = true;
    const g = deferred();
    gates.push(g);
    await g.promise;
    inFlight -= 1;
    return new Response('ok');
  };

  try {
    // Fill the cap exactly, plus one queued waiter.
    const calls = Array.from({ length: MAX_ORIGIN_CONCURRENCY + 1 }, () =>
      fetchWithTimeout('https://example.test/x'),
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(gates.length, MAX_ORIGIN_CONCURRENCY, 'the queued waiter must not be admitted yet');

    // Free exactly one slot — exactly one queued waiter should be admitted.
    gates.shift().resolve();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(gates.length, MAX_ORIGIN_CONCURRENCY, 'freeing one slot admits exactly one waiter');

    gates.splice(0).forEach((g) => g.resolve());
    await Promise.all(calls);
    assert.equal(overCap, false, 'in-flight count never exceeded the cap');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a slot is released even when the underlying fetch throws (finally, not just success)', async () => {
  const { fetchWithTimeout, MAX_ORIGIN_CONCURRENCY } = await loadHttpModule();

  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call <= MAX_ORIGIN_CONCURRENCY) {
      throw new Error('boom');
    }
    return new Response('ok');
  };

  try {
    // Saturate the cap with throwing calls; if slots leaked, the next batch
    // would hang forever waiting on a waiter that's never resolved.
    await Promise.all(
      Array.from({ length: MAX_ORIGIN_CONCURRENCY }, () =>
        fetchWithTimeout('https://example.test/x').catch(() => 'threw'),
      ),
    );

    // A fresh batch must still be able to acquire slots promptly.
    const res = await Promise.race([
      fetchWithTimeout('https://example.test/x'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out waiting for a slot — leak')), 200)),
    ]);
    assert.ok(res instanceof Response);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── 2. Circuit breaker: trip-after-N, reset-on-success ──────────────────────

test('breaker trips open after TIMEOUT_TRIP_THRESHOLD consecutive timeouts, closes on success', async () => {
  const { fetchWithTimeout, FetchTimeoutError, isOriginDegraded, onOriginHealthChange, TIMEOUT_TRIP_THRESHOLD } =
    await loadHttpModule();

  const transitions = [];
  const off = onOriginHealthChange((d) => transitions.push(d));

  const originalFetch = globalThis.fetch;
  // Every call hangs until aborted by fetchWithTimeout's own timer, and never
  // resolves on its own — simulating a dead/slow socket.
  globalThis.fetch = (input, init) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });

  try {
    assert.equal(isOriginDegraded(), false, 'starts healthy');

    for (let i = 1; i <= TIMEOUT_TRIP_THRESHOLD; i += 1) {
      await assert.rejects(() => fetchWithTimeout('https://example.test/x', undefined, 5), FetchTimeoutError);
      if (i < TIMEOUT_TRIP_THRESHOLD) {
        assert.equal(isOriginDegraded(), false, `should not be degraded before the ${i}th timeout closes it`);
      }
    }
    assert.equal(isOriginDegraded(), true, 'trips open after N consecutive timeouts');
    assert.deepEqual(transitions, [true], 'fires exactly one open transition, not one per timeout');

    // A single success (even without a 2xx status — merely "the origin
    // answered") resets the counter and closes the breaker.
    globalThis.fetch = async () => new Response('server error', { status: 500 });
    const res = await fetchWithTimeout('https://example.test/x', undefined, 5);
    assert.equal(res.status, 500);
    assert.equal(isOriginDegraded(), false, 'closes on the first completed response, even a 5xx');
    assert.deepEqual(transitions, [true, false], 'fires exactly one close transition');
  } finally {
    globalThis.fetch = originalFetch;
    off();
  }
});

test('a non-timeout rejection (e.g. connection refused) does not trip the timeout breaker by itself', async () => {
  const { fetchWithTimeout, isOriginDegraded, TIMEOUT_TRIP_THRESHOLD } = await loadHttpModule();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };

  try {
    for (let i = 0; i < TIMEOUT_TRIP_THRESHOLD + 2; i += 1) {
      await assert.rejects(() => fetchWithTimeout('https://example.test/x', undefined, 50), /ECONNREFUSED/);
    }
    assert.equal(
      isOriginDegraded(),
      false,
      'repeated non-timeout errors must not open the breaker — only consecutive TIMEOUTS count',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
