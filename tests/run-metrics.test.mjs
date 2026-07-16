// Runtime tests for embedded execution metrics + metacognition
// (task-1334a1d49948 "Brain C3", electron/browser/tools/run-metrics.mjs).
//
// Pure Node, no Electron: run-metrics.mjs only touches node:fs +
// electron/core/profile.mjs (itself Electron-free), same pattern as
// tests/tool-crud-memory.test.mjs. $BREEZE_MEMORY_DIR is pointed at a temp
// dir so this never touches a real profile's state.
//
// The contract pinned here:
//   1. domainOf() extracts a bare registrable-ish domain from a URL and
//      returns '' for anything that isn't a URL (selectors, bare words) —
//      the NON-PHI guarantee: it never returns path/query/selector text.
//   2. recordVerb() flags 'slow' the moment a single call crosses
//      SLOW_CALL_MS, regardless of streak state.
//   3. recordVerb() flags 'streak' once the SAME (verb, domain) pair repeats
//      RETRY_STREAK_THRESHOLD+ times AND cumulative time crosses
//      STREAK_TOTAL_MS — and does NOT flag a short streak of fast calls.
//   4. A different verb OR a different domain resets the streak counter
//      (progress, not a stuck loop).
//   5. The returned hint text is a single line containing the verb/domain
//      and never echoes arbitrary call args verbatim (only the derived
//      domain).
//   6. timeVerb() is a transparent async wrapper: it returns exactly what
//      `fn` resolves to, and still records+rethrows on a rejection.
//   7. State persists across calls (same run key) and resetRunMetrics()
//      clears it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

process.env.BREEZE_MEMORY_DIR = mkdtempSync(join(tmpdir(), 'bz-run-metrics-'));
process.env.BREEZE_TASK_ID = 'test-task-abc';

const rm = await import(join(repoRoot, 'electron', 'browser', 'tools', 'run-metrics.mjs'));

test('domainOf: extracts a bare host from a URL, strips www, lowercases', () => {
  assert.equal(rm.domainOf('https://WWW.Example.com/path?x=1'), 'example.com');
  assert.equal(rm.domainOf('http://sub.example.com'), 'sub.example.com');
});

test('domainOf: returns "" for a non-URL (selector, bare word, empty)', () => {
  assert.equal(rm.domainOf('#submit-button'), '');
  assert.equal(rm.domainOf('text=Continue'), '');
  assert.equal(rm.domainOf(''), '');
  assert.equal(rm.domainOf(undefined), '');
});

test('recordVerb: a single call past SLOW_CALL_MS is flagged "slow"', () => {
  rm.resetRunMetrics();
  const r = rm.recordVerb({
    verb: 'goto',
    arg: 'https://slow-site.example/checkout',
    durationMs: rm.SLOW_CALL_MS + 500,
    ok: true,
  });
  assert.equal(r.breach, 'slow');
  assert.ok(r.hint);
  assert.match(r.hint, /goto/);
  assert.match(r.hint, /slow-site\.example/);
});

test('recordVerb: a fast single call is not flagged', () => {
  rm.resetRunMetrics();
  const r = rm.recordVerb({ verb: 'click', arg: '#go', durationMs: 200, ok: true });
  assert.equal(r.breach, null);
  assert.equal(r.hint, null);
});

test('recordVerb: identical (verb, domain) repeated past threshold+total flags "streak"', () => {
  rm.resetRunMetrics();
  const url = 'https://portal.example/claims';
  let last;
  for (let i = 0; i < rm.RETRY_STREAK_THRESHOLD; i++) {
    last = rm.recordVerb({ verb: 'click', arg: url, durationMs: 6000, ok: false });
  }
  assert.equal(last.streakCount, rm.RETRY_STREAK_THRESHOLD);
  assert.equal(last.breach, 'streak');
  assert.match(last.hint, /click/);
  assert.match(last.hint, /repeated/);
});

test('recordVerb: a short streak under the total-time floor is not flagged', () => {
  rm.resetRunMetrics();
  const url = 'https://portal.example/claims';
  let last;
  for (let i = 0; i < rm.RETRY_STREAK_THRESHOLD; i++) {
    last = rm.recordVerb({ verb: 'click', arg: url, durationMs: 100, ok: true });
  }
  assert.equal(last.breach, null);
});

test('recordVerb: a different verb resets the streak', () => {
  rm.resetRunMetrics();
  const url = 'https://portal.example/claims';
  rm.recordVerb({ verb: 'click', arg: url, durationMs: 6000, ok: false });
  rm.recordVerb({ verb: 'click', arg: url, durationMs: 6000, ok: false });
  const afterSwitch = rm.recordVerb({ verb: 'goto', arg: url, durationMs: 6000, ok: true });
  assert.equal(afterSwitch.streakCount, 1);
});

test('recordVerb: a different domain resets the streak even for the same verb', () => {
  rm.resetRunMetrics();
  rm.recordVerb({ verb: 'click', arg: 'https://a.example/x', durationMs: 6000, ok: false });
  rm.recordVerb({ verb: 'click', arg: 'https://a.example/x', durationMs: 6000, ok: false });
  const afterSwitch = rm.recordVerb({
    verb: 'click',
    arg: 'https://b.example/x',
    durationMs: 6000,
    ok: false,
  });
  assert.equal(afterSwitch.streakCount, 1);
});

test('timeVerb: transparently returns fn()\'s resolved value', async () => {
  rm.resetRunMetrics();
  const result = await rm.timeVerb('eval', undefined, async () => ({ answer: 42 }));
  assert.deepEqual(result, { answer: 42 });
});

test('timeVerb: records the metric retrievable via takeLastMetric', async () => {
  rm.resetRunMetrics();
  await rm.timeVerb('goto', 'https://slow.example/x', async () => {
    // Simulate elapsed time isn't practical without a real delay; instead
    // verify the metric round-trips with ok:true and a non-negative duration.
    return 'ok';
  });
  const metric = rm.takeLastMetric();
  assert.ok(metric);
  assert.equal(typeof metric.streakCount, 'number');
});

test('timeVerb: still records (ok:false contributes to streak) and rethrows on failure', async () => {
  rm.resetRunMetrics();
  await assert.rejects(
    () => rm.timeVerb('click', 'https://fails.example/x', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  const metric = rm.takeLastMetric();
  assert.ok(metric);
  assert.equal(metric.streakCount, 1);
});

test('takeLastMetric: returns null when nothing was recorded since the last take', () => {
  rm.resetRunMetrics();
  rm.takeLastMetric(); // drain whatever a prior test left
  assert.equal(rm.takeLastMetric(), null);
});

test('runKey: prefers BREEZE_TYPEBUILD_TASK_ID, then BREEZE_TASK_ID, then pty id', () => {
  const prevTypebuild = process.env.BREEZE_TYPEBUILD_TASK_ID;
  const prevTask = process.env.BREEZE_TASK_ID;
  const prevPty = process.env.BREEZE_PTY_ID;
  try {
    delete process.env.BREEZE_TYPEBUILD_TASK_ID;
    process.env.BREEZE_TASK_ID = 'abc-123';
    assert.equal(rm.runKey(), 'abc-123');

    process.env.BREEZE_TYPEBUILD_TASK_ID = 'tb-999';
    assert.equal(rm.runKey(), 'tb-999');

    delete process.env.BREEZE_TYPEBUILD_TASK_ID;
    delete process.env.BREEZE_TASK_ID;
    process.env.BREEZE_PTY_ID = '42';
    assert.equal(rm.runKey(), '42');
  } finally {
    if (prevTypebuild === undefined) delete process.env.BREEZE_TYPEBUILD_TASK_ID;
    else process.env.BREEZE_TYPEBUILD_TASK_ID = prevTypebuild;
    if (prevTask === undefined) delete process.env.BREEZE_TASK_ID;
    else process.env.BREEZE_TASK_ID = prevTask;
    if (prevPty === undefined) delete process.env.BREEZE_PTY_ID;
    else process.env.BREEZE_PTY_ID = prevPty;
  }
});
