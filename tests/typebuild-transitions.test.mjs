// fm-h8g7 — tests for the pure TypeBuild transition classifier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransitions } from '../electron/sources/typebuild-transitions.mjs';

const ME = 'me@example.com';

test('first poll suppresses "new" for the whole starting inventory', () => {
  const fresh = [
    { id: 'a', status: 'pending', rawStatus: 'open', claimedBy: null },
    { id: 'b', status: 'pending', rawStatus: 'open', claimedBy: null },
  ];
  const out = classifyTransitions([], fresh, ME, true);
  assert.deepEqual(out, []);
});

test('new task surfaces after the first poll', () => {
  const prev = [{ id: 'a', status: 'pending', rawStatus: 'open', claimedBy: null }];
  const fresh = [
    { id: 'a', status: 'pending', rawStatus: 'open', claimedBy: null },
    { id: 'b', status: 'pending', rawStatus: 'open', claimedBy: null },
  ];
  const out = classifyTransitions(prev, fresh, ME, false);
  assert.deepEqual(out, [{ taskId: 'b', kind: 'new' }]);
});

test('transition to done → completed', () => {
  const prev = [{ id: 'a', status: 'in_progress', rawStatus: 'in_progress', claimedBy: ME }];
  const fresh = [{ id: 'a', status: 'done', rawStatus: 'done', claimedBy: null }];
  const out = classifyTransitions(prev, fresh, ME, false);
  // completed + claim-lost (the done row also dropped my claim).
  assert.ok(out.some((t) => t.taskId === 'a' && t.kind === 'completed'));
});

test('transition to partial → partial', () => {
  const prev = [{ id: 'a', status: 'in_progress', rawStatus: 'in_progress', claimedBy: null }];
  const fresh = [{ id: 'a', status: 'done', rawStatus: 'partial', claimedBy: null }];
  const out = classifyTransitions(prev, fresh, ME, false);
  assert.deepEqual(out, [{ taskId: 'a', kind: 'partial' }]);
});

test('transition to cancelled → cancelled', () => {
  const prev = [{ id: 'a', status: 'pending', rawStatus: 'open', claimedBy: null }];
  const fresh = [{ id: 'a', status: 'cancelled', rawStatus: 'cancelled', claimedBy: null }];
  const out = classifyTransitions(prev, fresh, ME, false);
  assert.deepEqual(out, [{ taskId: 'a', kind: 'cancelled' }]);
});

test('cancelled held across polls does not re-fire', () => {
  const prev = [{ id: 'a', status: 'cancelled', rawStatus: 'cancelled', claimedBy: null }];
  const fresh = [{ id: 'a', status: 'cancelled', rawStatus: 'cancelled', claimedBy: null }];
  const out = classifyTransitions(prev, fresh, ME, false);
  assert.deepEqual(out, []);
});

test('cancel from in_progress fires cancelled + claim-lost', () => {
  const prev = [{ id: 'a', status: 'in_progress', rawStatus: 'in_progress', claimedBy: ME }];
  const fresh = [{ id: 'a', status: 'cancelled', rawStatus: 'cancelled', claimedBy: null }];
  const out = classifyTransitions(prev, fresh, ME, false);
  assert.ok(out.some((t) => t.taskId === 'a' && t.kind === 'cancelled'));
  assert.ok(out.some((t) => t.taskId === 'a' && t.kind === 'claim-lost'));
});

test('transition to blocked → blocked', () => {
  const prev = [{ id: 'a', status: 'pending', rawStatus: 'open', claimedBy: null }];
  const fresh = [{ id: 'a', status: 'pending', rawStatus: 'blocked', claimedBy: null }];
  const out = classifyTransitions(prev, fresh, ME, false);
  assert.deepEqual(out, [{ taskId: 'a', kind: 'blocked' }]);
});

test('claim lost to another principal', () => {
  const prev = [{ id: 'a', status: 'in_progress', rawStatus: 'in_progress', claimedBy: ME }];
  const fresh = [{ id: 'a', status: 'in_progress', rawStatus: 'in_progress', claimedBy: 'other@x.com' }];
  const out = classifyTransitions(prev, fresh, ME, false);
  assert.deepEqual(out, [{ taskId: 'a', kind: 'claim-lost' }]);
});

test('claim lost to null (released remotely)', () => {
  const prev = [{ id: 'a', status: 'in_progress', rawStatus: 'in_progress', claimedBy: ME }];
  const fresh = [{ id: 'a', status: 'pending', rawStatus: 'open', claimedBy: null }];
  const out = classifyTransitions(prev, fresh, ME, false);
  assert.deepEqual(out, [{ taskId: 'a', kind: 'claim-lost' }]);
});

test('self-action suppression: cache already reflects the change → no transition', () => {
  // The app claimed the task locally, so the cache row ALREADY shows
  // claimedBy=ME. The next poll returns the same → no transition.
  const prev = [{ id: 'a', status: 'in_progress', rawStatus: 'in_progress', claimedBy: ME }];
  const fresh = [{ id: 'a', status: 'in_progress', rawStatus: 'in_progress', claimedBy: ME }];
  const out = classifyTransitions(prev, fresh, ME, false);
  assert.deepEqual(out, []);
});

test('self-completion suppression: cache already done → no completed transition', () => {
  // complete() patched the cache to done before this poll ran.
  const prev = [{ id: 'a', status: 'done', rawStatus: 'done', claimedBy: null }];
  const fresh = [{ id: 'a', status: 'done', rawStatus: 'done', claimedBy: null }];
  const out = classifyTransitions(prev, fresh, ME, false);
  assert.deepEqual(out, []);
});

test('terminal state held across polls does not re-fire', () => {
  const prev = [{ id: 'a', status: 'pending', rawStatus: 'blocked', claimedBy: null }];
  const fresh = [{ id: 'a', status: 'pending', rawStatus: 'blocked', claimedBy: null }];
  const out = classifyTransitions(prev, fresh, ME, false);
  assert.deepEqual(out, []);
});

test('no myEmail → no claim-lost transitions', () => {
  const prev = [{ id: 'a', status: 'in_progress', rawStatus: 'in_progress', claimedBy: 'me@example.com' }];
  const fresh = [{ id: 'a', status: 'in_progress', rawStatus: 'in_progress', claimedBy: null }];
  const out = classifyTransitions(prev, fresh, null, false);
  assert.deepEqual(out, []);
});

test('a burst of transitions is returned in full (batching is the caller\'s job)', () => {
  const prev = [];
  const fresh = Array.from({ length: 5 }, (_, i) => ({
    id: `t${i}`,
    status: 'pending',
    rawStatus: 'open',
    claimedBy: null,
  }));
  const out = classifyTransitions(prev, fresh, ME, false);
  assert.equal(out.length, 5);
  assert.ok(out.every((t) => t.kind === 'new'));
});
