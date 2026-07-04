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
