// task-3f0c6a6abe41 — unit tests for the pure Start-outcome logic
// (src/components/tasks/startOutcome.mjs). The correctness bar: auto-continue
// (and any Start) must NEVER report a typebuild start as spawned unless a real
// pty id came back — a claim without a session is the phantom bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  spawnedOutcome,
  launchErrorReason,
  mintErrorReason,
  classifyLiveness,
} from '../src/components/tasks/startOutcome.mjs';

// ── spawnedOutcome: the "did a real session spawn?" gate ─────────────────────

test('spawnedOutcome: typebuild WITH a real pty id → spawned, no throw', () => {
  const o = spawnedOutcome('typebuild', { ok: true, ptyId: 42 });
  assert.equal(o.spawned, true);
  assert.equal(o.ptyId, 42);
  assert.equal(o.needsPtyThrow, false);
});

test('spawnedOutcome: typebuild {ok:true} but NO pty id → phantom, needsPtyThrow', () => {
  const o = spawnedOutcome('typebuild', { ok: true });
  assert.equal(o.spawned, false);
  assert.equal(o.ptyId, undefined);
  assert.equal(o.needsPtyThrow, true);
});

test('spawnedOutcome: typebuild with ptyId:0 → phantom (0 is not a real session)', () => {
  const o = spawnedOutcome('typebuild', { ok: true, ptyId: 0 });
  assert.equal(o.spawned, false);
  assert.equal(o.needsPtyThrow, true);
});

test('spawnedOutcome: typebuild with undefined result → phantom', () => {
  const o = spawnedOutcome('typebuild', undefined);
  assert.equal(o.spawned, false);
  assert.equal(o.needsPtyThrow, true);
});

test('spawnedOutcome: local source with no pty id → spawned (no pty contract there)', () => {
  const o = spawnedOutcome('local', { ok: true });
  assert.equal(o.spawned, true);
  assert.equal(o.needsPtyThrow, false);
});

test('spawnedOutcome: undefined (local) source → spawned', () => {
  const o = spawnedOutcome(undefined, { run: {}, result: {} });
  assert.equal(o.spawned, true);
  assert.equal(o.needsPtyThrow, false);
});

// ── launchErrorReason: the REAL reason must surface (never swallowed) ────────

test('launchErrorReason: [typebuild-launch:no-window] → human reason', () => {
  const err = new Error('[typebuild-launch:no-window] Start needs an open Breeze window');
  assert.equal(launchErrorReason(err), 'no open Breeze window to host the session');
});

test('launchErrorReason: [typebuild-launch:no-pty] → human reason', () => {
  const err = new Error('[typebuild-launch:no-pty] launch returned no session id');
  assert.equal(launchErrorReason(err), 'the session process never started');
});

test('launchErrorReason: unknown launch code → generic (still non-null, not swallowed)', () => {
  const err = new Error('[typebuild-launch:weird] something');
  assert.equal(launchErrorReason(err), 'launch failed (weird)');
});

test('launchErrorReason: non-launch error → null (caller falls back)', () => {
  assert.equal(launchErrorReason(new Error('some other failure')), null);
  assert.equal(launchErrorReason('a string'), null);
});

test('launchErrorReason: [typebuild-launch:early-exit] → reason WITH the exit code', () => {
  const err = new Error('[typebuild-launch:early-exit] claude exited immediately (exit 1)');
  assert.equal(launchErrorReason(err), 'the session exited immediately (exit 1)');
});

test('launchErrorReason: early-exit with a null exit code still surfaces', () => {
  const err = new Error('[typebuild-launch:early-exit] claude exited immediately (exit null)');
  assert.equal(launchErrorReason(err), 'the session exited immediately (exit null)');
});

// ── classifyLiveness: the LIVENESS GATE (task-6fc9e503623e) ──────────────────
// The regression guarantee: a started session must be ALIVE; an early exit must
// become a released-claim + recorded-error carrying the exit code.

test('classifyLiveness: alive verdict → started (no error, no note)', () => {
  const v = classifyLiveness({ alive: true, exitCode: null, signal: null });
  assert.deepEqual(v, { alive: true });
});

test('classifyLiveness: early exit → tagged error + note carry the exit code', () => {
  const v = classifyLiveness({
    alive: false,
    exitCode: 1,
    signal: null,
    tail: 'error: unknown option --frobnicate',
  });
  assert.equal(v.alive, false);
  assert.equal(v.exitCode, 1);
  assert.match(v.taggedError, /\[typebuild-launch:early-exit\]/);
  assert.match(v.taggedError, /\(exit 1\)/);
  // The recorded note must include the exit code AND the captured tail so the
  // failure is self-diagnosing in the task's activity history.
  assert.match(v.note, /exit 1/);
  assert.match(v.note, /unknown option --frobnicate|--frobnicate|--frobnicate/);
});

test('classifyLiveness: early exit with null exit code → still classified, "null" label', () => {
  const v = classifyLiveness({ alive: false, exitCode: null, signal: 9, tail: '' });
  assert.equal(v.alive, false);
  assert.equal(v.exitCode, null);
  assert.match(v.taggedError, /\(exit null\)/);
  // No tail → note is just the code line (no trailing separator).
  assert.equal(v.note, 'Auto-start session exited immediately (exit null)');
});

test('classifyLiveness end-to-end: the taggedError feeds launchErrorReason with the code', () => {
  const v = classifyLiveness({ alive: false, exitCode: 137, signal: null, tail: 'OOM' });
  const err = new Error(v.taggedError);
  assert.equal(launchErrorReason(err), 'the session exited immediately (exit 137)');
});

// ── mintErrorReason: the three mint messages still map ───────────────────────

test('mintErrorReason: [typebuild-mint:signed-out] → sign-in message', () => {
  const err = new Error('[typebuild-mint:signed-out] Firebase sign-in required');
  assert.equal(mintErrorReason(err), 'Please sign in again');
});

test('mintErrorReason: [typebuild-mint:unreachable] → reachability message', () => {
  const err = new Error('[typebuild-mint:unreachable] Could not reach the mint endpoint');
  assert.equal(mintErrorReason(err), "Can't reach TypeBuild right now");
});

test('mintErrorReason: non-mint error → null', () => {
  assert.equal(mintErrorReason(new Error('nope')), null);
});
