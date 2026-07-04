// task-48cd46a0e2da — the never-silent invariant of the shared start wrapper.
// classifyStartFeedback is the pure core of useStartAction: EVERY start attempt
// must resolve to a VISIBLE state — 'pending' or 'error' with a reason — never
// nothing. A silent start click was the single most repeated defect of the QA
// night (Retry round 2, auto-continue rounds 4-7, Start-chain round 8).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStartFeedback } from '../src/components/tasks/startFeedback.mjs';

test('a start that spawned a live session → pending', () => {
  const fb = classifyStartFeedback({ kind: 'start' }, { ok: true, spawned: true, ptyId: 7 });
  assert.deepEqual(fb, { state: 'pending' });
});

test('a start whose launch failed → error carrying the outcome message', () => {
  const fb = classifyStartFeedback(
    { kind: 'start' },
    { ok: false, spawned: false, message: 'the session exited immediately (exit 1)' },
  );
  assert.equal(fb.state, 'error');
  assert.match(fb.reason, /exit 1/);
});

test('kind:none ALWAYS yields an error with the reason — never a silent no-op', () => {
  const fb = classifyStartFeedback({
    kind: 'none',
    reason: 'no runnable step — remaining steps are cancelled (reopen one to continue)',
  });
  assert.equal(fb.state, 'error');
  assert.match(fb.reason, /cancelled/);
});

test('a start that resolved ok but did NOT spawn → error (phantom never reported as success)', () => {
  const fb = classifyStartFeedback({ kind: 'start' }, { ok: true, spawned: false });
  assert.equal(fb.state, 'error');
  assert.match(fb.reason, /did not spawn/);
});

test('a start with a missing/garbled outcome → error, never silent', () => {
  const fb = classifyStartFeedback({ kind: 'start' }, undefined);
  assert.equal(fb.state, 'error');
  assert.ok(fb.reason.length > 0);
});

test('kind:none with an empty reason still produces a non-empty error reason', () => {
  const fb = classifyStartFeedback({ kind: 'none', reason: '' });
  assert.equal(fb.state, 'error');
  assert.ok(fb.reason.length > 0);
});

// The core invariant, exhaustively: the result is ALWAYS pending or error —
// there is no third "silent" outcome, for any input shape.
test('INVARIANT: classifyStartFeedback never returns anything but pending|error', () => {
  const cases = [
    [{ kind: 'none', reason: 'x' }, undefined],
    [{ kind: 'start' }, { ok: true, spawned: true }],
    [{ kind: 'start' }, { ok: true, spawned: false }],
    [{ kind: 'start' }, { ok: false, message: 'boom' }],
    [{ kind: 'start' }, null],
    [{ kind: 'start' }, {}],
  ];
  for (const [attempt, outcome] of cases) {
    const fb = classifyStartFeedback(attempt, outcome);
    assert.ok(fb.state === 'pending' || fb.state === 'error', `state=${fb.state}`);
    if (fb.state === 'error') assert.ok(typeof fb.reason === 'string' && fb.reason.length > 0);
  }
});
