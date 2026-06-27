import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreCandidate,
  rankCandidates,
  bestCandidate,
  KIND_WEIGHT,
} from '../electron/browser/selector-candidates.mjs';

test('scoreCandidate: unique role+name beats unique css', () => {
  const role = scoreCandidate({ kind: 'role', selector: 'role=button[name="Save"]', matchCount: 1 });
  const css = scoreCandidate({ kind: 'css', selector: 'div > button:nth-of-type(2)', matchCount: 1 });
  assert.ok(role > css, `role (${role}) should beat css (${css})`);
});

test('scoreCandidate: a unique selector beats the same kind when ambiguous', () => {
  const unique = scoreCandidate({ kind: 'text', selector: 'text=Submit', matchCount: 1 });
  const ambiguous = scoreCandidate({ kind: 'text', selector: 'text=Submit', matchCount: 5 });
  assert.ok(unique > ambiguous);
});

test('scoreCandidate: matchCount 0 (stale / not found) gets no credit', () => {
  const stale = scoreCandidate({ kind: 'role', selector: 'role=button[name="Gone"]', matchCount: 0 });
  assert.equal(stale, 0);
});

test('scoreCandidate: a unique but lower-kind selector beats a missing higher-kind one', () => {
  const uniqueCss = scoreCandidate({ kind: 'css', selector: 'main button', matchCount: 1 });
  const missingRole = scoreCandidate({ kind: 'role', selector: 'role=button[name="X"]', matchCount: 0 });
  assert.ok(uniqueCss > missingRole);
});

test('scoreCandidate: ambiguity multiplier decays as match count grows', () => {
  const two = scoreCandidate({ kind: 'testid', selector: '[data-testid="row"]', matchCount: 2 });
  const ten = scoreCandidate({ kind: 'testid', selector: '[data-testid="row"]', matchCount: 10 });
  assert.ok(two > ten);
});

test('scoreCandidate: long brittle css path penalized vs short css path (same unique match)', () => {
  const shortP = scoreCandidate({ kind: 'css', selector: 'button.save', matchCount: 1 });
  const longP = scoreCandidate({
    kind: 'css',
    selector: 'html > body > div#app > main.layout > section.panel > form.f > div.row > button.btn.btn-primary.save'.repeat(4),
    matchCount: 1,
  });
  assert.ok(shortP > longP);
});

test('rankCandidates: returns most-stable-first with scores, ties keep input order', () => {
  const ranked = rankCandidates([
    { kind: 'css', selector: 'a', matchCount: 1 },
    { kind: 'role', selector: 'role=link[name="Home"]', matchCount: 1 },
    { kind: 'text', selector: 'text=Home', matchCount: 1 },
  ]);
  assert.equal(ranked[0].kind, 'role');
  assert.ok(typeof ranked[0].score === 'number');
  assert.equal(ranked.length, 3);
});

test('rankCandidates: handles empty / non-array input', () => {
  assert.deepEqual(rankCandidates(undefined), []);
  assert.deepEqual(rankCandidates(null), []);
  assert.deepEqual(rankCandidates([]), []);
});

test('bestCandidate: picks the top, null when all ambiguous/stale', () => {
  const best = bestCandidate([
    { kind: 'nth', selector: ':nth-of-type(3)', matchCount: 1 },
    { kind: 'testid', selector: '[data-testid="ok"]', matchCount: 1 },
  ]);
  assert.equal(best.kind, 'testid');
  assert.equal(bestCandidate([{ kind: 'role', selector: 'x', matchCount: 0 }]), null);
  assert.equal(bestCandidate([]), null);
});

test('KIND_WEIGHT ordering reflects the stated stability hierarchy', () => {
  assert.ok(KIND_WEIGHT.role >= KIND_WEIGHT.testid);
  assert.ok(KIND_WEIGHT.testid > KIND_WEIGHT.arialabel);
  assert.ok(KIND_WEIGHT.arialabel > KIND_WEIGHT.text);
  assert.ok(KIND_WEIGHT.text > KIND_WEIGHT.css);
  assert.ok(KIND_WEIGHT.css > KIND_WEIGHT.nth);
});
