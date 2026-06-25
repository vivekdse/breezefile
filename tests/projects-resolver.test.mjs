// task-897a13d67632 — unit tests for the pure description + instruction
// resolvers (scopes + provenance + override). Imports the plain ESM module
// directly: `node --test tests/projects-resolver.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCOPE_ORDER,
  resolveEffectiveDescription,
  resolveEffectiveInstructions,
  formatSummary,
} from '../src/projects/resolver.mjs';

function proj(over = {}) {
  return {
    id: over.id,
    name: over.name ?? over.id,
    description: over.description ?? null,
    instructions: over.instructions ?? null,
    parentProjectId: over.parentProjectId ?? null,
    folders: [],
    createdBy: null,
    groupId: null,
    createdAt: null,
    updatedAt: null,
    effectiveInstructions: over.effectiveInstructions,
  };
}

// ─── DESCRIPTION cascade ─────────────────────────────────────────────────────

test('resolveEffectiveDescription: ancestor + own, general→specific', () => {
  const chain = [
    proj({ id: 'ins', name: 'Insurance', description: 'Handle insurance auth.' }),
    proj({ id: 'aetna', name: 'Aetna HMO', description: 'Aetna HMO specifics.' }),
  ];
  const res = resolveEffectiveDescription(chain);
  assert.equal(res.segments.length, 2);
  assert.equal(res.segments[0].own, false);
  assert.equal(res.segments[0].projectId, 'ins');
  assert.equal(res.segments[1].own, true);
  assert.equal(res.segments[1].projectId, 'aetna');
  assert.equal(res.text, 'Handle insurance auth.\n\nAetna HMO specifics.');
});

test('resolveEffectiveDescription: empty ancestor descriptions are skipped', () => {
  const chain = [
    proj({ id: 'ins', name: 'Insurance', description: '   ' }),
    proj({ id: 'aetna', name: 'Aetna HMO', description: 'Only own.' }),
  ];
  const res = resolveEffectiveDescription(chain);
  assert.equal(res.segments.length, 1);
  assert.equal(res.segments[0].own, true);
  assert.equal(res.text, 'Only own.');
});

test('resolveEffectiveDescription: empty chain → empty', () => {
  const res = resolveEffectiveDescription([]);
  assert.deepEqual(res.segments, []);
  assert.equal(res.text, '');
});

// ─── INSTRUCTION cascade: union + provenance ─────────────────────────────────

test('SCOPE_ORDER is general→specific', () => {
  assert.deepEqual(SCOPE_ORDER, [
    'organization',
    'project',
    'category',
    'parent-task',
    'task',
  ]);
});

test('resolveEffectiveInstructions: union across scopes with provenance', () => {
  const res = resolveEffectiveInstructions({
    project: {
      id: 'ins',
      effectiveInstructions: 'Attach the referral\nUse the payer portal\nLog the auth number\nConfirm member id',
    },
    categories: [
      { key: 'payer:HMO', instructions: 'Require PCP referral\nCheck HMO network' },
      { key: 'kind:prior-auth', instructions: 'Submit on the prior-auth form' },
    ],
    task: { id: 't1', instructions: 'Mark urgent' },
  });
  // 4 project + 2 HMO + 1 prior-auth + 1 task = 8 (no overlaps).
  assert.equal(res.total, 8);
  assert.equal(res.byKind.project, 4);
  assert.equal(res.byKind.category, 3);
  assert.equal(res.byKind.task, 1);
  // Summary uses scope labels, omits 0-count scopes.
  assert.equal(res.summary, '8 — 4 project · 2 payer:HMO · 1 kind:prior-auth · 1 task');
  // Each rule carries provenance.
  const urgent = res.rules.find((r) => r.text === 'Mark urgent');
  assert.equal(urgent.scopeKind, 'task');
  const pcp = res.rules.find((r) => r.text === 'Require PCP referral');
  assert.equal(pcp.scopeKind, 'category');
  assert.equal(pcp.scopeLabel, 'payer:HMO');
});

test('resolveEffectiveInstructions: more-specific scope OVERRIDES same rule', () => {
  const res = resolveEffectiveInstructions({
    project: { id: 'p', instructions: 'Attach the referral.' },
    task: { id: 't', instructions: 'attach the referral' }, // same rule, diff case/punct
  });
  // Collapses to ONE rule, attributed to the more-specific (task) scope.
  assert.equal(res.total, 1);
  assert.equal(res.rules[0].scopeKind, 'task');
  assert.equal(res.rules[0].text, 'attach the referral'); // winning text = task's
  // Provenance counts reflect the surviving attribution.
  assert.equal(res.byKind.task, 1);
  assert.equal(res.byKind.project, 0);
  assert.equal(res.summary, '1 — 1 task');
});

test('resolveEffectiveInstructions: order independence (input order ≠ scope order)', () => {
  // Supply task before project; resolver must still sort general→specific so
  // the task rule overrides the project one.
  const res = resolveEffectiveInstructions({
    task: { id: 't', instructions: 'Do X' },
    project: { id: 'p', instructions: 'Do X\nDo Y' },
  });
  assert.equal(res.total, 2); // "Do X" (task) + "Do Y" (project)
  const doX = res.rules.find((r) => r.key === 'do x');
  assert.equal(doX.scopeKind, 'task');
});

test('resolveEffectiveInstructions: bullet lists split into rules + collapse with plain lines', () => {
  const res = resolveEffectiveInstructions({
    project: { id: 'p', instructions: '- Attach referral\n- Verify coverage' },
    task: { id: 't', instructions: '1. Attach referral' }, // numbered, same rule
  });
  // "Attach referral" appears in both → 1; "Verify coverage" → 1. Total 2.
  assert.equal(res.total, 2);
  const attach = res.rules.find((r) => r.key === 'attach referral');
  assert.equal(attach.scopeKind, 'task'); // task wins the override
});

test('resolveEffectiveInstructions: explicit rules[] array wins over block', () => {
  const res = resolveEffectiveInstructions({
    project: { id: 'p', instructions: 'ignored', rules: ['Rule A', 'Rule B'] },
  });
  assert.equal(res.total, 2);
  assert.deepEqual(res.rules.map((r) => r.text).sort(), ['Rule A', 'Rule B']);
});

test('resolveEffectiveInstructions: project leg reuses effectiveInstructions over instructions', () => {
  const res = resolveEffectiveInstructions({
    project: {
      id: 'p',
      instructions: 'OWN ONLY (should be ignored)',
      effectiveInstructions: 'Org rule\nProject rule',
    },
  });
  assert.equal(res.total, 2);
  assert.ok(res.rules.some((r) => r.text === 'Org rule'));
  assert.ok(!res.rules.some((r) => r.text.includes('OWN ONLY')));
});

test('resolveEffectiveInstructions: parent-task scope sits between category and task', () => {
  const res = resolveEffectiveInstructions({
    project: { id: 'p', instructions: 'Shared rule' },
    parentTask: { id: 'pt', instructions: 'Shared rule\nParent only' },
    task: { id: 't', instructions: 'Shared rule' },
  });
  // "Shared rule" collapses to task (most specific); "Parent only" → parent-task.
  assert.equal(res.total, 2);
  const shared = res.rules.find((r) => r.key === 'shared rule');
  assert.equal(shared.scopeKind, 'task');
  const parentOnly = res.rules.find((r) => r.key === 'parent only');
  assert.equal(parentOnly.scopeKind, 'parent-task');
});

test('resolveEffectiveInstructions: organization scope is most general', () => {
  const res = resolveEffectiveInstructions({
    organization: { id: 'org', instructions: 'HIPAA always\nNever email PHI' },
    project: { id: 'p', instructions: 'HIPAA always' }, // overrides org's copy
  });
  assert.equal(res.total, 2);
  const hipaa = res.rules.find((r) => r.key === 'hipaa always');
  assert.equal(hipaa.scopeKind, 'project'); // project (more specific) wins
  const email = res.rules.find((r) => r.key === 'never email phi');
  assert.equal(email.scopeKind, 'organization');
});

test('resolveEffectiveInstructions: empty input → zero rules, clean summary', () => {
  const res = resolveEffectiveInstructions({});
  assert.equal(res.total, 0);
  assert.deepEqual(res.rules, []);
  assert.equal(res.summary, '0');
  assert.deepEqual(res.scopes, []);
});

test('resolveEffectiveInstructions: scopes list preserves identity even at 0 surviving rules', () => {
  const res = resolveEffectiveInstructions({
    project: { id: 'p', instructions: 'Only rule' },
    task: { id: 't', instructions: 'Only rule' }, // fully overrides project
  });
  // Both scopes present in summaries; project shows count 0.
  const project = res.scopes.find((s) => s.kind === 'project');
  const task = res.scopes.find((s) => s.kind === 'task');
  assert.equal(project.count, 0);
  assert.equal(task.count, 1);
  // ...but the summary omits the 0-count project.
  assert.equal(res.summary, '1 — 1 task');
});

// ─── formatSummary ───────────────────────────────────────────────────────────

test('formatSummary: omits 0-count scopes, joins with " · "', () => {
  const summary = formatSummary(8, [
    { kind: 'project', id: 'p', label: 'project', count: 4 },
    { kind: 'category', id: 'h', label: 'payer:HMO', count: 2 },
    { kind: 'category', id: 'k', label: 'kind:prior-auth', count: 1 },
    { kind: 'parent-task', id: 'pt', label: 'parent task', count: 0 },
    { kind: 'task', id: 't', label: 'task', count: 1 },
  ]);
  assert.equal(summary, '8 — 4 project · 2 payer:HMO · 1 kind:prior-auth · 1 task');
});

test('formatSummary: bare total when nothing contributes', () => {
  assert.equal(formatSummary(0, []), '0');
});
