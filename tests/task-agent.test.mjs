// task-896f3f7f5e75 — unit tests for the pure agent module
// (src/components/tasks/agent.mjs). No React; runs under `node --test`.
//
// The composer picker and the detail-panel agent line are thin wrappers over
// these pure helpers: the picker builds its option list from mapAgentRows() +
// agentOptionHint(), and the detail line renders agentDetailSummary(task.agent)
// only when the resolved block is present. The source's inline mapAgentRow /
// mapResolvedAgent mirror mapAgentRow here (same defensive rules), so testing
// this pure layer covers the mapping + NON-REGRESSION contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAUNCH_MODES,
  launchModeLabel,
  mapAgentRow,
  mapAgentRows,
  mapResolvedAgent,
  agentOptionHint,
  agentDetailSummary,
} from '../src/components/tasks/agent.mjs';

// ── launch_mode vocabulary + captions ───────────────────────────────────────
test('LAUNCH_MODES is the locked chrome/auto/resume/manual vocabulary', () => {
  assert.deepEqual([...LAUNCH_MODES], ['chrome', 'auto', 'resume', 'manual']);
});

test('launchModeLabel captions the four known modes and passes through others', () => {
  assert.equal(launchModeLabel('chrome'), 'drives Chrome');
  assert.equal(launchModeLabel('auto'), 'auto-accept');
  assert.equal(launchModeLabel('resume'), 'resumes a session');
  assert.equal(launchModeLabel('manual'), 'manual launch');
  // An unknown mode is advisory — passed through verbatim.
  assert.equal(launchModeLabel('spaceship'), 'spaceship');
  // Absent / non-string → '' (no caption).
  assert.equal(launchModeLabel(''), '');
  assert.equal(launchModeLabel(undefined), '');
  assert.equal(launchModeLabel(null), '');
  assert.equal(launchModeLabel(42), '');
});

// ── mapAgentRow: snake→camel, defensive, group-OPTIONAL ──────────────────────
test('mapAgentRow maps a full server row to the camelCase client agent', () => {
  const a = mapAgentRow({
    id: 'ag_1',
    name: 'Booker',
    group: 'clinic-ops',
    tools: ['calendar', 'email'],
    launch_mode: 'chrome',
  });
  assert.deepEqual(a, {
    id: 'ag_1',
    name: 'Booker',
    group: 'clinic-ops',
    tools: ['calendar', 'email'],
    launchMode: 'chrome',
  });
});

test('mapAgentRow handles a group-OPTIONAL (private) agent — group → null', () => {
  const a = mapAgentRow({ id: 'ag_2', name: 'Solo', launch_mode: 'manual' });
  assert.ok(a);
  assert.equal(a.group, null);
  assert.deepEqual(a.tools, []); // absent tools → []
  assert.equal(a.launchMode, 'manual');
  // An empty-string group is also treated as "no group".
  assert.equal(mapAgentRow({ id: 'x', name: 'Y', group: '' }).group, null);
});

test('mapAgentRow coerces a non-array tools list to [] (advisory, never throws)', () => {
  assert.deepEqual(mapAgentRow({ id: 'a', name: 'b', tools: 'nope' }).tools, []);
  assert.deepEqual(mapAgentRow({ id: 'a', name: 'b', tools: 42 }).tools, []);
  // Non-string entries inside the array are dropped.
  assert.deepEqual(
    mapAgentRow({ id: 'a', name: 'b', tools: ['ok', 5, null, 'fine'] }).tools,
    ['ok', 'fine'],
  );
});

test('mapAgentRow accepts a camelCase launchMode too (defensive)', () => {
  assert.equal(mapAgentRow({ id: 'a', name: 'b', launchMode: 'auto' }).launchMode, 'auto');
});

test('mapAgentRow drops a malformed row (missing id or name, or non-object) → null', () => {
  assert.equal(mapAgentRow(null), null);
  assert.equal(mapAgentRow(undefined), null);
  assert.equal(mapAgentRow('agent'), null);
  assert.equal(mapAgentRow(42), null);
  assert.equal(mapAgentRow({}), null);
  assert.equal(mapAgentRow({ id: 'a' }), null); // no name
  assert.equal(mapAgentRow({ name: 'b' }), null); // no id
  assert.equal(mapAgentRow({ id: '', name: 'b' }), null); // empty id
  assert.equal(mapAgentRow({ id: 'a', name: '' }), null); // empty name
});

// ── mapAgentRows: list mapping, parse-miss safety ────────────────────────────
test('mapAgentRows maps a list and drops malformed entries', () => {
  const list = mapAgentRows([
    { id: 'a', name: 'Alpha', launch_mode: 'chrome' },
    null,
    { id: 'b' }, // no name → dropped
    { id: 'c', name: 'Gamma' },
  ]);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((a) => a.id), ['a', 'c']);
});

test('mapAgentRows returns [] on a parse miss (non-array), mirroring listProjects', () => {
  assert.deepEqual(mapAgentRows(undefined), []);
  assert.deepEqual(mapAgentRows(null), []);
  assert.deepEqual(mapAgentRows({}), []);
  assert.deepEqual(mapAgentRows('nope'), []);
  assert.deepEqual(mapAgentRows([]), []);
});

// ── mapResolvedAgent: the inlined get_task block; NON-REGRESSION when absent ──
test('mapResolvedAgent passes through a well-shaped resolved block', () => {
  const a = mapResolvedAgent({ id: 'r1', name: 'Resolved', launch_mode: 'resume' });
  assert.deepEqual(a, {
    id: 'r1',
    name: 'Resolved',
    group: null,
    tools: [],
    launchMode: 'resume',
  });
});

test('mapResolvedAgent → null for absent/malformed (so the detail line is omitted)', () => {
  // Absent → null → the detail panel renders NOTHING (no regression).
  assert.equal(mapResolvedAgent(undefined), null);
  assert.equal(mapResolvedAgent(null), null);
  assert.equal(mapResolvedAgent({}), null);
  assert.equal(mapResolvedAgent({ id: 'r1' }), null);
});

// ── agentOptionHint: the picker's per-option caption ─────────────────────────
test('agentOptionHint returns the launch-mode caption for an agent', () => {
  assert.equal(agentOptionHint({ id: 'a', name: 'b', group: null, tools: [], launchMode: 'chrome' }), 'drives Chrome');
  assert.equal(agentOptionHint({ id: 'a', name: 'b', group: null, tools: [], launchMode: '' }), '');
  assert.equal(agentOptionHint(null), '');
  assert.equal(agentOptionHint(undefined), '');
});

// ── agentDetailSummary: the detail-panel one-liner ───────────────────────────
test('agentDetailSummary joins name + launch caption, or name alone', () => {
  assert.equal(
    agentDetailSummary({ id: 'a', name: 'Booker', group: null, tools: [], launchMode: 'auto' }),
    'Booker · auto-accept',
  );
  // No meaningful launch mode → just the name (no trailing separator).
  assert.equal(
    agentDetailSummary({ id: 'a', name: 'Booker', group: null, tools: [], launchMode: '' }),
    'Booker',
  );
  // Absent → '' (caller omits the row).
  assert.equal(agentDetailSummary(null), '');
  assert.equal(agentDetailSummary(undefined), '');
});
