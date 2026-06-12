// fm-7909 — unit tests for the pure primary-action state machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { primaryActionFor } from '../src/components/tasks/primaryAction.mjs';

function task(over = {}) {
  return {
    id: over.id ?? 't',
    title: 't',
    notes: null,
    status: over.status ?? 'pending',
    folder: over.folder ?? '/tmp',
    start_at: null,
    due_at: null,
    pinned: false,
    cron: null,
    next_run_at: null,
    auto_mode: over.auto_mode ?? false,
    auto_agent: null,
    auto_prompt: null,
    created_at: 0,
    updated_at: 0,
    completed_at: null,
    source: over.source,
    rawStatus: over.rawStatus,
    priority: over.priority,
    claimedBy: over.claimedBy,
  };
}

const READY = { signedIn: true, claudeOk: true, chromeOk: true, ready: true };

test('local manual open → done-toggle', () => {
  const a = primaryActionFor(task({ source: 'local' }), {});
  assert.equal(a.kind, 'done-toggle');
});

test('local manual done → reopen', () => {
  const a = primaryActionFor(task({ source: 'local', status: 'done' }), {});
  assert.equal(a.kind, 'reopen');
});

test('local auto idle → run-now', () => {
  const a = primaryActionFor(task({ source: 'local', auto_mode: true }), {});
  assert.equal(a.kind, 'run-now');
});

test('local auto with run in flight (no session) → view-run', () => {
  const a = primaryActionFor(task({ source: 'local', auto_mode: true }), {
    lastRunRunning: true,
  });
  assert.equal(a.kind, 'view-run');
});

test('a live session always wins → open-session', () => {
  const a = primaryActionFor(task({ source: 'typebuild', rawStatus: 'open' }), {
    session: { ptyId: 7, tabIndex: 3 },
  });
  assert.equal(a.kind, 'open-session');
  assert.equal(a.tabIndex, 3);
});

test('typebuild open + ready → start (enabled)', () => {
  const a = primaryActionFor(task({ source: 'typebuild', rawStatus: 'open' }), {
    tbReady: READY,
  });
  assert.equal(a.kind, 'start');
  assert.equal(a.enabled, true);
});

test('typebuild open + not signed in → start disabled with reason', () => {
  const a = primaryActionFor(task({ source: 'typebuild', rawStatus: 'open' }), {
    tbReady: { signedIn: false, claudeOk: false, chromeOk: false, ready: false },
  });
  assert.equal(a.kind, 'start');
  assert.equal(a.enabled, false);
  assert.match(a.tooltip, /Sign in to TypeBuild/);
});

test('typebuild claimed by me → start (resume)', () => {
  const a = primaryActionFor(
    task({ source: 'typebuild', rawStatus: 'open', claimedBy: 'me@x' }),
    { tbReady: READY, myEmail: 'me@x' },
  );
  assert.equal(a.kind, 'start');
  assert.equal(a.enabled, true);
});

test('typebuild claimed by someone else → none + note', () => {
  const a = primaryActionFor(
    task({ source: 'typebuild', rawStatus: 'open', claimedBy: 'other@x' }),
    { tbReady: READY, myEmail: 'me@x' },
  );
  assert.equal(a.kind, 'none');
  assert.match(a.note, /claimed by other@x/);
});

test('typebuild blocked → reopen', () => {
  const a = primaryActionFor(
    task({ source: 'typebuild', rawStatus: 'blocked' }),
    { tbReady: READY },
  );
  assert.equal(a.kind, 'reopen');
});

test('typebuild done/partial → none (lives in DONE)', () => {
  assert.equal(
    primaryActionFor(task({ source: 'typebuild', rawStatus: 'done' }), {}).kind,
    'none',
  );
  assert.equal(
    primaryActionFor(task({ source: 'typebuild', rawStatus: 'partial' }), {}).kind,
    'none',
  );
});

// fm-alfz (S1) — cancelled is terminal; the primary stays `none` (Reopen is a
// kebab/detail action, not the row's primary).
test('typebuild cancelled → none (reopen-from-done is a kebab action)', () => {
  assert.equal(
    primaryActionFor(
      task({ source: 'typebuild', rawStatus: 'cancelled', status: 'cancelled' }),
      {},
    ).kind,
    'none',
  );
});

test('typebuild failed (unclaimed) → start', () => {
  const a = primaryActionFor(
    task({ source: 'typebuild', rawStatus: 'failed' }),
    { tbReady: READY },
  );
  assert.equal(a.kind, 'start');
});
