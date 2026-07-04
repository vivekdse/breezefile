// Unit tests for chainParentResolve.mjs — the PURE parts of the client-side
// chain-parent-resolution interim. No React; runs under `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChainAggregateResult,
  parentStatusFromChildren,
  shouldResolveParent,
  isTerminalRaw,
} from '../src/components/newhome/chainParentResolve.mjs';
import { fieldRef } from '../src/components/newhome/taskSchema.mjs';

// ── buildChainAggregateResult ────────────────────────────────────────────────
const INTAKE = {
  id: 'intake',
  name: 'Intake',
  inputs: [],
  outputs: [{ key: 'ok', label: 'OK', type: 'text', required: true }],
};
const DELIVER = {
  id: 'deliver',
  name: 'Deliver',
  inputs: [],
  outputs: [{ key: 'delivered_at', label: 'Delivered at', type: 'date', required: true }],
};

test('buildChainAggregateResult merges every non-skipped step output, ref-keyed', () => {
  const out = buildChainAggregateResult({
    defs: [INTAKE, DELIVER],
    valuesByRef: {
      [fieldRef('intake', 'ok')]: 'true',
      [fieldRef('deliver', 'delivered_at')]: '2026-07-04',
    },
  });
  assert.deepEqual(out, {
    type: 'fields',
    fields: {
      [fieldRef('intake', 'ok')]: 'true',
      [fieldRef('deliver', 'delivered_at')]: '2026-07-04',
    },
  });
});

test('buildChainAggregateResult omits empty/missing output values', () => {
  const out = buildChainAggregateResult({
    defs: [INTAKE, DELIVER],
    valuesByRef: { [fieldRef('intake', 'ok')]: 'true' }, // deliver has no value yet
  });
  assert.deepEqual(out.fields, { [fieldRef('intake', 'ok')]: 'true' });
});

test('buildChainAggregateResult skips a conditionally-gated (n/a) def', () => {
  const gated = { ...DELIVER, neededWhen: { ref: fieldRef('intake', 'ok'), equals: 'no' } };
  const out = buildChainAggregateResult({
    defs: [INTAKE, gated],
    valuesByRef: {
      [fieldRef('intake', 'ok')]: 'true', // condition unmet → deliver is skip
      [fieldRef('deliver', 'delivered_at')]: '2026-07-04', // present but excluded
    },
  });
  assert.deepEqual(out.fields, { [fieldRef('intake', 'ok')]: 'true' });
});

test('buildChainAggregateResult tolerates empty input', () => {
  assert.deepEqual(buildChainAggregateResult({ defs: [], valuesByRef: {} }), {
    type: 'fields',
    fields: {},
  });
  assert.deepEqual(buildChainAggregateResult(undefined), { type: 'fields', fields: {} });
});

// ── parentStatusFromChildren ─────────────────────────────────────────────────
test('parentStatusFromChildren: every child done → done', () => {
  assert.deepEqual(
    parentStatusFromChildren([{ rawStatus: 'done' }, { rawStatus: 'done' }]),
    { status: 'done' },
  );
});

test('parentStatusFromChildren: a cancelled child → partial (not done)', () => {
  assert.deepEqual(
    parentStatusFromChildren([{ rawStatus: 'done' }, { rawStatus: 'cancelled' }]),
    { status: 'partial' },
  );
});

test('parentStatusFromChildren: a failed child → partial', () => {
  assert.deepEqual(
    parentStatusFromChildren([{ rawStatus: 'failed' }, { rawStatus: 'done' }]),
    { status: 'partial' },
  );
});

test('parentStatusFromChildren: a blocked child → partial', () => {
  assert.deepEqual(
    parentStatusFromChildren([{ rawStatus: 'done' }, { rawStatus: 'blocked' }]),
    { status: 'partial' },
  );
});

test('parentStatusFromChildren: a still-running (in_progress) child → null (not terminal yet)', () => {
  assert.equal(parentStatusFromChildren([{ rawStatus: 'done' }, { rawStatus: 'in_progress' }]), null);
});

test('parentStatusFromChildren: an unstarted step (rawStatus null) → null', () => {
  assert.equal(parentStatusFromChildren([{ rawStatus: 'done' }, { rawStatus: null }]), null);
});

test('parentStatusFromChildren: no children → null', () => {
  assert.equal(parentStatusFromChildren([]), null);
  assert.equal(parentStatusFromChildren(undefined), null);
});

// ── shouldResolveParent (idempotency + safety) ───────────────────────────────
test('shouldResolveParent: non-terminal parent + a resolution → true (do submit)', () => {
  assert.equal(shouldResolveParent('open', { status: 'done' }), true);
  assert.equal(shouldResolveParent('in_progress', { status: 'partial' }), true);
  assert.equal(shouldResolveParent(null, { status: 'done' }), true);
});

test('shouldResolveParent: ALREADY-terminal parent → false (idempotent; never resubmit)', () => {
  // Whether WE submitted it a moment ago or the SERVER resolved it itself, a
  // terminal parent is never touched again.
  for (const raw of ['done', 'partial', 'cancelled', 'failed']) {
    assert.equal(shouldResolveParent(raw, { status: 'done' }), false, `raw=${raw}`);
  }
});

test('shouldResolveParent: no resolution (children not all terminal) → false', () => {
  assert.equal(shouldResolveParent('open', null), false);
});

test('isTerminalRaw classifies the settled vocabulary (blocked counts as settled)', () => {
  for (const raw of ['done', 'partial', 'cancelled', 'failed', 'blocked']) {
    assert.equal(isTerminalRaw(raw), true, `raw=${raw}`);
  }
  for (const raw of ['open', 'in_progress', null, undefined, '']) {
    assert.equal(isTerminalRaw(raw), false, `raw=${raw}`);
  }
});
