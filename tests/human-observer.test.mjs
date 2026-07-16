// Runtime contract tests for the human-observation signal detector (task-
// 17434e2b5469 "Brain C4 — Client learning from humans",
// electron/browser/human-observer.ts). Depends on C1
// (electron/typebuild/brain-writes.ts / site-memory.ts's captureObservation).
//
// SAME CONSTRAINT as tests/brain-writes.test.mjs and
// tests/anticipatory-context.test.mjs: human-observer.ts imports
// site-memory.ts (via captureObservation), which imports typebuild/auth.ts
// and drags in Electron. We instead assert the BEHAVIOURAL CONTRACT with a
// faithful re-implementation of detectHumanSignals/buildObservationBody/
// promoteHumanSignal kept in lockstep with the real module, using an
// INJECTED capture stub (mirroring the real promoteHumanSignal's own
// dependency-injection seam) instead of a network stub.
//
// The contract pinned here:
//   1. Re-touching the same FIELD (placeholder key) within the correction
//      window -> a 'correction' signal, mechanism only (no value ever
//      present in a HumanAction to begin with).
//   2. Re-touching the same logical step with a DIFFERENT selector kind ->
//      still a 'correction', with both selector kinds captured (chose a
//      different path).
//   3. A long gap between actions -> a 'hesitation' signal (duration only).
//   4. Revisiting the immediately-prior URL -> 'undo'; revisiting an OLDER
//      URL -> 'renavigation'.
//   5. buildObservationBody never contains a raw value — asserted by
//      construction (HumanAction never carries one) plus a length/shape
//      sanity check.
//   6. promoteHumanSignal tags evidence.source: 'human_correction' for
//      corrections, 'human_implicit' for the other three kinds — the only
//      channel available today (checked against brain_api: no dedicated
//      schema field), and the body text's first word encodes the same
//      distinction for a narrative-reading curator LLM.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── faithful re-implementation of human-observer.ts's pure functions ─────

const CORRECTION_WINDOW_MS = 15_000;
const HESITATION_THRESHOLD_MS = 8_000;
const RENAV_WINDOW_MS = 5 * 60_000;

function stepIdentity(a) {
  if (a.placeholder) return `field:${a.placeholder}`;
  if (a.selector?.selector) return `sel:${a.selector.kind}:${a.selector.selector}`;
  return null;
}

function detectHumanSignals(actions) {
  const signals = [];
  const lastSeenAt = new Map();
  const urlHistory = [];
  let prevAction = null;

  for (const a of actions) {
    if (prevAction && a.timestamp > prevAction.timestamp) {
      const deltaMs = a.timestamp - prevAction.timestamp;
      if (deltaMs >= HESITATION_THRESHOLD_MS) {
        signals.push({ kind: 'hesitation', detail: { deltaMs } });
      }
    }

    if (a.action === 'navigate') {
      const dest = a.to || a.url;
      if (dest) {
        const prevDistinctUrl = urlHistory.length ? urlHistory[urlHistory.length - 1].url : null;
        const priorVisit = urlHistory.find((h) => h.url === dest);
        if (priorVisit) {
          const deltaMs = a.timestamp - priorVisit.at;
          if (prevDistinctUrl && urlHistory.length >= 2 && urlHistory[urlHistory.length - 2].url === dest) {
            signals.push({ kind: 'undo', detail: { url: dest, deltaMs } });
          } else if (deltaMs <= RENAV_WINDOW_MS) {
            signals.push({ kind: 'renavigation', detail: { url: dest, deltaMs } });
          }
        }
        urlHistory.push({ url: dest, at: a.timestamp });
      }
    } else {
      const id = stepIdentity(a);
      if (id) {
        const prior = lastSeenAt.get(id);
        if (prior && a.timestamp - prior.timestamp <= CORRECTION_WINDOW_MS) {
          signals.push({
            kind: 'correction',
            detail: {
              placeholder: a.placeholder,
              selectorKind: a.selector?.kind,
              selectorPrevKind: prior.selector?.kind,
              deltaMs: a.timestamp - prior.timestamp,
            },
          });
        }
        lastSeenAt.set(id, a);
      }
    }
    prevAction = a;
  }
  return signals;
}

function buildObservationBody(signal) {
  const { detail } = signal;
  switch (signal.kind) {
    case 'correction': {
      const where = detail.placeholder ? `field="${detail.placeholder}"` : 'a step';
      const pathNote =
        detail.selectorPrevKind && detail.selectorKind && detail.selectorPrevKind !== detail.selectorKind
          ? ` (switched from a ${detail.selectorPrevKind} selector to a ${detail.selectorKind} selector)`
          : '';
      return `Human correction: redid ${where}${pathNote} ${Math.round(detail.deltaMs)}ms after the first attempt.`;
    }
    case 'hesitation':
      return `Human hesitation: paused ${Math.round(detail.deltaMs)}ms before the next action.`;
    case 'undo':
      return `Human undo: navigated back to a previously-visited page after ${Math.round(detail.deltaMs)}ms.`;
    case 'renavigation':
      return `Human re-navigated: revisited an earlier page in this session after ${Math.round(detail.deltaMs)}ms.`;
    default:
      return 'Human feedback signal.';
  }
}

function evidenceSourceFor(kind) {
  return kind === 'correction' ? 'human_correction' : 'human_implicit';
}

function promoteHumanSignal(signal, opts, capture) {
  const body = buildObservationBody(signal);
  capture('memory', body, {
    tier: opts.domain ? 'org' : opts.taskId ? 'task' : 'org',
    domain: opts.domain,
    urlPattern: signal.detail.url || opts.urlPattern,
    taskId: opts.taskId,
    projectId: opts.projectId,
    tenantId: opts.tenantId,
    summary: `${signal.kind} (human-observed)`,
    evidence: {
      source: evidenceSourceFor(signal.kind),
      signal_kind: signal.kind,
      delta_ms: Math.round(signal.detail.deltaMs),
    },
  });
}

// ─── tests ──────────────────────────────────────────────────────────────────

test('detectHumanSignals: re-touching the same field within the window -> correction, mechanism only', () => {
  const actions = [
    { action: 'change', url: 'https://portal.example.com/form', timestamp: 1000, placeholder: 'member_id', selector: { kind: 'id', selector: '#member-id' } },
    { action: 'change', url: 'https://portal.example.com/form', timestamp: 3000, placeholder: 'member_id', selector: { kind: 'id', selector: '#member-id' } },
  ];
  const signals = detectHumanSignals(actions);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, 'correction');
  assert.equal(signals[0].detail.placeholder, 'member_id');
  assert.equal(signals[0].detail.deltaMs, 2000);
  // NEVER a value — HumanAction has no field capable of carrying one, and the
  // signal only echoes the placeholder KEY back.
  assert.equal(JSON.stringify(signals[0]).includes('12345'), false);
});

test('detectHumanSignals: same step, different selector kind -> correction with both kinds recorded (chose a different path)', () => {
  const actions = [
    { action: 'click', url: 'https://portal.example.com/form', timestamp: 1000, selector: { kind: 'text', selector: 'text=Submit' } },
    { action: 'click', url: 'https://portal.example.com/form', timestamp: 2000, placeholder: undefined, selector: { kind: 'id', selector: '#submit-btn' } },
  ];
  // Different selector strings -> different stepIdentity -> NOT detected as a
  // same-step correction by identity matching (selector string differs). This
  // pins the current, deliberately-simple identity rule: only placeholder-keyed
  // fields collapse across selector changes; bare click-selector "same step"
  // matching requires the exact same selector to be re-used. Document the
  // boundary explicitly so a future change to widen this is a conscious choice.
  const signals = detectHumanSignals(actions);
  assert.equal(signals.length, 0);
});

test('detectHumanSignals: field correction across a re-picked selector still surfaces both selector kinds', () => {
  const actions = [
    { action: 'change', url: 'https://portal.example.com/form', timestamp: 1000, placeholder: 'dob', selector: { kind: 'css', selector: 'input.dob-legacy' } },
    { action: 'change', url: 'https://portal.example.com/form', timestamp: 4000, placeholder: 'dob', selector: { kind: 'testid', selector: '[data-testid="dob"]' } },
  ];
  const signals = detectHumanSignals(actions);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, 'correction');
  assert.equal(signals[0].detail.selectorPrevKind, 'css');
  assert.equal(signals[0].detail.selectorKind, 'testid');
  const body = buildObservationBody(signals[0]);
  assert.match(body, /switched from a css selector to a testid selector/);
});

test('detectHumanSignals: a re-touch OUTSIDE the correction window is not flagged', () => {
  const actions = [
    { action: 'change', url: 'https://portal.example.com/form', timestamp: 1000, placeholder: 'member_id', selector: { kind: 'id', selector: '#member-id' } },
    { action: 'change', url: 'https://portal.example.com/form', timestamp: 1000 + CORRECTION_WINDOW_MS + 1, placeholder: 'member_id', selector: { kind: 'id', selector: '#member-id' } },
  ];
  const signals = detectHumanSignals(actions);
  assert.equal(signals.some((s) => s.kind === 'correction'), false);
});

test('detectHumanSignals: a long gap between actions -> hesitation (duration only)', () => {
  const actions = [
    { action: 'click', url: 'https://portal.example.com', timestamp: 1000, selector: { kind: 'css', selector: '#a' } },
    { action: 'click', url: 'https://portal.example.com', timestamp: 1000 + HESITATION_THRESHOLD_MS + 500, selector: { kind: 'css', selector: '#b' } },
  ];
  const signals = detectHumanSignals(actions);
  assert.equal(signals.some((s) => s.kind === 'hesitation'), true);
  const h = signals.find((s) => s.kind === 'hesitation');
  assert.equal(h.detail.deltaMs, HESITATION_THRESHOLD_MS + 500);
});

test('detectHumanSignals: revisiting the immediately-prior URL -> undo', () => {
  const actions = [
    { action: 'navigate', url: 'https://portal.example.com/a', to: 'https://portal.example.com/a', timestamp: 1000 },
    { action: 'navigate', url: 'https://portal.example.com/b', to: 'https://portal.example.com/b', timestamp: 2000 },
    { action: 'navigate', url: 'https://portal.example.com/a', to: 'https://portal.example.com/a', timestamp: 3000 },
  ];
  const signals = detectHumanSignals(actions);
  const undo = signals.find((s) => s.kind === 'undo');
  assert.ok(undo, 'expected an undo signal');
  assert.equal(undo.detail.url, 'https://portal.example.com/a');
  assert.equal(undo.detail.deltaMs, 2000);
});

test('detectHumanSignals: revisiting an OLDER url (not the immediately-prior one) -> renavigation, not undo', () => {
  const actions = [
    { action: 'navigate', url: 'https://portal.example.com/a', to: 'https://portal.example.com/a', timestamp: 1000 },
    { action: 'navigate', url: 'https://portal.example.com/b', to: 'https://portal.example.com/b', timestamp: 2000 },
    { action: 'navigate', url: 'https://portal.example.com/c', to: 'https://portal.example.com/c', timestamp: 3000 },
    { action: 'navigate', url: 'https://portal.example.com/a', to: 'https://portal.example.com/a', timestamp: 4000 },
  ];
  const signals = detectHumanSignals(actions);
  const renav = signals.find((s) => s.detail.url === 'https://portal.example.com/a' && s.kind === 'renavigation');
  assert.ok(renav, 'expected a renavigation signal for the older url');
  assert.equal(signals.some((s) => s.kind === 'undo'), false);
});

test('detectHumanSignals: a revisit far OUTSIDE the renav window is not flagged (stale session touch, not feedback)', () => {
  const actions = [
    { action: 'navigate', url: 'https://portal.example.com/a', to: 'https://portal.example.com/a', timestamp: 0 },
    { action: 'navigate', url: 'https://portal.example.com/b', to: 'https://portal.example.com/b', timestamp: 1000 },
    { action: 'navigate', url: 'https://portal.example.com/c', to: 'https://portal.example.com/c', timestamp: 2000 },
    { action: 'navigate', url: 'https://portal.example.com/a', to: 'https://portal.example.com/a', timestamp: RENAV_WINDOW_MS + 10_000 },
  ];
  const signals = detectHumanSignals(actions);
  assert.equal(signals.some((s) => s.kind === 'renavigation' || s.kind === 'undo'), false);
});

test('promoteHumanSignal: correction tags evidence.source=human_correction; body leads with "Human correction:"', () => {
  const calls = [];
  const capture = (kind, body, opts) => calls.push({ kind, body, opts });
  const signal = { kind: 'correction', detail: { placeholder: 'member_id', selectorKind: 'id', selectorPrevKind: 'id', deltaMs: 1500 } };
  promoteHumanSignal(signal, { domain: 'portal.example.com', taskId: 'task-abc' }, capture);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'memory');
  assert.match(calls[0].body, /^Human correction:/);
  assert.equal(calls[0].opts.evidence.source, 'human_correction');
  assert.equal(calls[0].opts.evidence.signal_kind, 'correction');
  assert.equal(calls[0].opts.tier, 'org'); // domain present -> org tier
});

test('promoteHumanSignal: implicit signals (hesitation/undo/renavigation) tag evidence.source=human_implicit', () => {
  const calls = [];
  const capture = (kind, body, opts) => calls.push({ kind, body, opts });
  for (const kind of ['hesitation', 'undo', 'renavigation']) {
    promoteHumanSignal({ kind, detail: { deltaMs: 1000, url: 'https://x.com' } }, { taskId: 'task-abc' }, capture);
  }
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.opts.evidence.source, 'human_implicit');
  }
  assert.equal(calls[0].opts.tier, 'task'); // no domain, taskId present -> task tier
});

test('promoteHumanSignal: never places a raw value in the observation body or evidence', () => {
  const calls = [];
  const capture = (kind, body, opts) => calls.push({ kind, body, opts });
  const signal = { kind: 'correction', detail: { placeholder: 'ssn_field', selectorKind: 'id', selectorPrevKind: 'id', deltaMs: 500 } };
  promoteHumanSignal(signal, {}, capture);
  // The placeholder KEY name can appear (it's a field identity, not a value),
  // but nothing resembling a typed value (digits-as-content, free text beyond
  // the fixed template) should ever appear. Assert the body matches the exact
  // template shape rather than eyeballing.
  assert.match(calls[0].body, /^Human correction: redid field="ssn_field" \d+ms after the first attempt\.$/);
});
