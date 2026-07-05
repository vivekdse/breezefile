// task-3ac8cbe60758 — unit tests for the pure wire-mapping helpers extracted
// out of electron/sources/typebuild.ts (electron/sources/typebuild-wire.mjs).
// No Electron, no fetch; runs under `node --test`. Mirrors
// tests/task-schema.test.mjs's conventions (same "pure .mjs sibling of a
// bigger module" family).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapStatus,
  rawStatusOf,
  dateOnly,
  toIso,
  isoToMs,
  mapResult,
  mapOutputSchema,
  mapDataKeys,
  mapMessages,
  mapPendingQuestion,
  mapAgentRow,
  mapResolvedAgent,
  mapChainFields,
  mapChainStep,
  mapChainRow,
  mapListRow,
  buildCreatePayload,
  buildTemplatePatchPayload,
} from '../electron/sources/typebuild-wire.mjs';

// ── mapStatus ───────────────────────────────────────────────────────────────
test('mapStatus maps known raw statuses', () => {
  assert.equal(mapStatus('in_progress'), 'in_progress');
  assert.equal(mapStatus('done'), 'done');
  assert.equal(mapStatus('partial'), 'done');
  assert.equal(mapStatus('cancelled'), 'cancelled');
  assert.equal(mapStatus('open'), 'pending');
  assert.equal(mapStatus('failed'), 'pending');
  assert.equal(mapStatus('blocked'), 'pending');
});

test('mapStatus defaults unknown/undefined raw statuses to pending', () => {
  assert.equal(mapStatus(undefined), 'pending');
  assert.equal(mapStatus('bogus'), 'pending');
  assert.equal(mapStatus(''), 'pending');
});

// ── rawStatusOf ──────────────────────────────────────────────────────────────
test('rawStatusOf prefers the blocked flag', () => {
  assert.equal(rawStatusOf({ blocked: true, raw_status: 'open', status: 'open' }), 'blocked');
});

test('rawStatusOf falls back through raw_status then status then open', () => {
  assert.equal(rawStatusOf({ raw_status: 'failed', status: 'open' }), 'failed');
  assert.equal(rawStatusOf({ status: 'done' }), 'done');
  assert.equal(rawStatusOf({}), 'open');
});

// ── dateOnly ─────────────────────────────────────────────────────────────────
test('dateOnly trims an ISO timestamp to the date part', () => {
  assert.equal(dateOnly('2026-07-05T12:34:56Z'), '2026-07-05');
});

test('dateOnly passes through an already day-only string', () => {
  assert.equal(dateOnly('2026-07-05'), '2026-07-05');
});

test('dateOnly returns null for nullish/empty input', () => {
  assert.equal(dateOnly(null), null);
  assert.equal(dateOnly(undefined), null);
  assert.equal(dateOnly(''), null);
});

// ── toIso ────────────────────────────────────────────────────────────────────
test('toIso passes through a valid ISO string', () => {
  assert.equal(toIso('2026-07-05T00:00:00Z'), '2026-07-05T00:00:00Z');
});

test('toIso converts a seconds epoch to ISO', () => {
  const iso = toIso(1751673600); // < 1e12 => seconds
  assert.equal(typeof iso, 'string');
  assert.ok(iso.startsWith('2025-07-04') || iso.startsWith('2025-07-05'));
});

test('toIso converts a milliseconds epoch to ISO', () => {
  const iso = toIso(1751673600000);
  assert.equal(typeof iso, 'string');
});

test('toIso returns null for nullish/empty/garbage input', () => {
  assert.equal(toIso(null), null);
  assert.equal(toIso(undefined), null);
  assert.equal(toIso(''), null);
  assert.equal(toIso('not a date'), null);
  assert.equal(toIso(Number.NaN), null);
});

// ── isoToMs ──────────────────────────────────────────────────────────────────
test('isoToMs parses a valid ISO string to epoch ms', () => {
  assert.equal(isoToMs('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z'));
});

test('isoToMs returns null for nullish/empty/garbage input', () => {
  assert.equal(isoToMs(null), null);
  assert.equal(isoToMs(undefined), null);
  assert.equal(isoToMs(''), null);
  assert.equal(isoToMs('garbage'), null);
});

// ── mapResult ────────────────────────────────────────────────────────────────
test('mapResult passes through a well-shaped result', () => {
  assert.deepEqual(mapResult({ type: 'table', payload: { rows: [] } }), {
    type: 'table',
    payload: { rows: [] },
  });
});

test('mapResult defaults a missing payload to null', () => {
  assert.deepEqual(mapResult({ type: 'note' }), { type: 'note', payload: null });
});

test('mapResult returns undefined for malformed/missing input', () => {
  assert.equal(mapResult(undefined), undefined);
  assert.equal(mapResult(null), undefined);
  assert.equal(mapResult({}), undefined);
  assert.equal(mapResult({ type: 123 }), undefined);
  assert.equal(mapResult({ type: '' }), undefined);
});

// ── mapOutputSchema ──────────────────────────────────────────────────────────
test('mapOutputSchema keeps well-shaped fields', () => {
  const fields = [{ key: 'a', label: 'A', type: 'text' }];
  assert.deepEqual(mapOutputSchema(fields), fields);
});

test('mapOutputSchema drops malformed entries but keeps the rest', () => {
  const fields = [
    { key: 'ok', label: 'OK', type: 'bool' },
    { key: 'bad-type', label: 'Bad', type: 'not-a-type' },
    { label: 'no key', type: 'text' },
    { key: 'no-label', type: 'text' },
    { key: 'bad-options', label: 'Bad options', type: 'select', options: 'not-array' },
    { key: 'bad-required', label: 'Bad required', type: 'text', required: 'yes' },
  ];
  assert.deepEqual(mapOutputSchema(fields), [{ key: 'ok', label: 'OK', type: 'bool' }]);
});

test('mapOutputSchema returns undefined for non-array/empty-after-filter input', () => {
  assert.equal(mapOutputSchema(undefined), undefined);
  assert.equal(mapOutputSchema(null), undefined);
  assert.equal(mapOutputSchema('nope'), undefined);
  assert.equal(mapOutputSchema([]), undefined);
  assert.equal(mapOutputSchema([{ key: 'x' }]), undefined);
});

// ── mapDataKeys ──────────────────────────────────────────────────────────────
test('mapDataKeys filters to non-empty strings', () => {
  assert.deepEqual(mapDataKeys(['a', '', 1, null, 'b']), ['a', 'b']);
});

test('mapDataKeys returns undefined for non-array or all-filtered-out input', () => {
  assert.equal(mapDataKeys(undefined), undefined);
  assert.equal(mapDataKeys(null), undefined);
  assert.equal(mapDataKeys('nope'), undefined);
  assert.equal(mapDataKeys([]), undefined);
  assert.equal(mapDataKeys([1, null, '']), undefined);
});

// ── mapMessages ──────────────────────────────────────────────────────────────
test('mapMessages keeps well-shaped, order-preserved entries', () => {
  const raw = [
    { text: 'first', by: 'alice@x.com', at: '2026-01-01T00:00:00Z' },
    { text: 'second', by: 'bob@x.com', at: '2026-01-02T00:00:00Z' },
  ];
  assert.deepEqual(mapMessages(raw), raw);
});

test('mapMessages drops entries with no usable text and degrades by/at to empty string', () => {
  const raw = [
    { text: '', by: 'alice@x.com', at: '2026-01-01T00:00:00Z' },
    { text: 'kept' },
    'not an object',
    null,
  ];
  assert.deepEqual(mapMessages(raw), [{ text: 'kept', by: '', at: '' }]);
});

test('mapMessages returns undefined for non-array/empty-after-filter input', () => {
  assert.equal(mapMessages(undefined), undefined);
  assert.equal(mapMessages(null), undefined);
  assert.equal(mapMessages('nope'), undefined);
  assert.equal(mapMessages([]), undefined);
  assert.equal(mapMessages([{ by: 'x' }]), undefined);
});

// ── mapPendingQuestion ───────────────────────────────────────────────────────
test('mapPendingQuestion keeps a well-shaped question with all optional fields', () => {
  const q = {
    text: 'Which color?',
    options: ['red', 'blue'],
    asked_by: 'alice@x.com',
    asked_at: '2026-01-01T00:00:00Z',
  };
  assert.deepEqual(mapPendingQuestion(q), {
    text: 'Which color?',
    options: ['red', 'blue'],
    asked_by: 'alice@x.com',
    asked_at: '2026-01-01T00:00:00Z',
  });
});

test('mapPendingQuestion degrades missing optional fields by omission', () => {
  assert.deepEqual(mapPendingQuestion({ text: 'Q?' }), { text: 'Q?' });
});

test('mapPendingQuestion drops a non-array/empty options array', () => {
  assert.deepEqual(mapPendingQuestion({ text: 'Q?', options: 'not-array' }), { text: 'Q?' });
  assert.deepEqual(mapPendingQuestion({ text: 'Q?', options: [] }), { text: 'Q?' });
  assert.deepEqual(mapPendingQuestion({ text: 'Q?', options: [1, 2] }), { text: 'Q?' });
});

test('mapPendingQuestion returns undefined for missing/malformed input or empty text', () => {
  assert.equal(mapPendingQuestion(undefined), undefined);
  assert.equal(mapPendingQuestion(null), undefined);
  assert.equal(mapPendingQuestion('nope'), undefined);
  assert.equal(mapPendingQuestion({}), undefined);
  assert.equal(mapPendingQuestion({ text: '' }), undefined);
  assert.equal(mapPendingQuestion({ text: 123 }), undefined);
});

// ── mapAgentRow / mapResolvedAgent ───────────────────────────────────────────
test('mapAgentRow maps a well-shaped row', () => {
  assert.deepEqual(
    mapAgentRow({ id: 'a1', name: 'Claude', group: 'eng', tools: ['bash', 42, 'edit'], launch_mode: 'auto' }),
    { id: 'a1', name: 'Claude', group: 'eng', tools: ['bash', 'edit'], launchMode: 'auto' },
  );
});

test('mapAgentRow defaults blank/absent optional fields', () => {
  assert.deepEqual(mapAgentRow({ id: 'a1', name: 'Claude' }), {
    id: 'a1',
    name: 'Claude',
    group: null,
    tools: [],
    launchMode: '',
  });
  assert.deepEqual(mapAgentRow({ id: 'a1', name: 'Claude', group: '' }).group, null);
});

test('mapAgentRow returns null when id or name is missing/malformed', () => {
  assert.equal(mapAgentRow(undefined), null);
  assert.equal(mapAgentRow(null), null);
  assert.equal(mapAgentRow({}), null);
  assert.equal(mapAgentRow({ id: 'a1' }), null);
  assert.equal(mapAgentRow({ name: 'Claude' }), null);
});

test('mapResolvedAgent delegates to mapAgentRow', () => {
  assert.deepEqual(mapResolvedAgent({ id: 'a1', name: 'Claude' }), {
    id: 'a1',
    name: 'Claude',
    group: null,
    tools: [],
    launchMode: '',
  });
  assert.equal(mapResolvedAgent(null), null);
});

// ── mapChainFields ────────────────────────────────────────────────────────────
test('mapChainFields keeps well-shaped fields and drops keyless entries', () => {
  const raw = [
    { key: 'k1', label: 'K1', type: 'text', required: true },
    { label: 'no key' },
    { key: 'k2' },
  ];
  assert.deepEqual(mapChainFields(raw), [
    { key: 'k1', label: 'K1', type: 'text', required: true },
    { key: 'k2' },
  ]);
});

test('mapChainFields returns undefined for non-array input', () => {
  assert.equal(mapChainFields(undefined), undefined);
  assert.equal(mapChainFields(null), undefined);
  assert.equal(mapChainFields('nope'), undefined);
});

test('mapChainFields returns [] for an array with no usable entries', () => {
  assert.deepEqual(mapChainFields([{ label: 'no key' }]), []);
});

// ── mapChainStep ──────────────────────────────────────────────────────────────
test('mapChainStep maps a well-shaped step with inputs/outputs/neededWhen', () => {
  const raw = {
    title_template: 'Step {{n}}',
    body_template: 'Do the thing',
    human_gate: true,
    inputs: [{ key: 'in1' }],
    outputs: [{ key: 'out1' }],
    needed_when: { ref: 'x', op: '==', value: 'y' },
  };
  assert.deepEqual(mapChainStep(raw), {
    titleTemplate: 'Step {{n}}',
    bodyTemplate: 'Do the thing',
    humanGate: true,
    inputs: [{ key: 'in1' }],
    outputs: [{ key: 'out1' }],
    neededWhen: { ref: 'x', op: '==', value: 'y' },
  });
});

test('mapChainStep returns a minimal step when only titleTemplate is present', () => {
  assert.deepEqual(mapChainStep({ title_template: 'Only title' }), { titleTemplate: 'Only title' });
});

test('mapChainStep returns null when titleTemplate is missing/malformed', () => {
  assert.equal(mapChainStep(undefined), null);
  assert.equal(mapChainStep(null), null);
  assert.equal(mapChainStep({}), null);
  assert.equal(mapChainStep({ title_template: '' }), null);
});

// ── mapChainRow ───────────────────────────────────────────────────────────────
test('mapChainRow maps a well-shaped chain, dropping malformed steps', () => {
  const raw = {
    id: 'chain-1',
    name: 'My Chain',
    steps: [{ title_template: 'Step 1' }, { title_template: '' }, 'not-an-object'],
    project_id: 'proj-1',
    group_id: 'group-1',
    created_by: 'alice@x.com',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  };
  assert.deepEqual(mapChainRow(raw), {
    id: 'chain-1',
    name: 'My Chain',
    steps: [{ titleTemplate: 'Step 1' }],
    projectId: 'proj-1',
    groupId: 'group-1',
    createdBy: 'alice@x.com',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  });
});

test('mapChainRow defaults name to id and nullable fields to null when absent', () => {
  assert.deepEqual(mapChainRow({ id: 'chain-2' }), {
    id: 'chain-2',
    name: 'chain-2',
    steps: [],
    projectId: null,
    groupId: null,
    createdBy: null,
    createdAt: null,
    updatedAt: null,
  });
});

test('mapChainRow returns null when id is missing/malformed', () => {
  assert.equal(mapChainRow(undefined), null);
  assert.equal(mapChainRow(null), null);
  assert.equal(mapChainRow({}), null);
  assert.equal(mapChainRow({ name: 'no id' }), null);
});

// ── mapListRow ────────────────────────────────────────────────────────────────
test('mapListRow maps a fully-populated open row', () => {
  const now = 1_800_000_000_000;
  const row = {
    id: 't1',
    status: 'open',
    title: 'Do the thing',
    priority: 3,
    claimed_by: 'alice@x.com',
    assigned_to: 'bob@x.com',
    attempts: 1,
    max_attempts: 3,
    flags: ['urgent'],
    due_at: '2026-07-10T00:00:00Z',
    defer_until: '2026-07-08T00:00:00Z',
    parent_task_id: 'parent-1',
    project_id: 'proj-1',
    template_id: 'tmpl-1',
    agent_id: 'agent-1',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-02T00:00:00Z',
    pending_question: { text: 'Which?' },
  };
  const mapped = mapListRow(row, now);
  assert.equal(mapped.id, 't1');
  assert.equal(mapped.title, 'Do the thing');
  assert.equal(mapped.status, 'pending');
  assert.equal(mapped.rawStatus, 'open');
  assert.equal(mapped.due_at, '2026-07-10');
  assert.equal(mapped.priority, 3);
  assert.equal(mapped.claimedBy, 'alice@x.com');
  assert.equal(mapped.assignedTo, 'bob@x.com');
  assert.equal(mapped.attempts, 1);
  assert.equal(mapped.maxAttempts, 3);
  assert.deepEqual(mapped.flags, ['urgent']);
  assert.equal(mapped.deferUntil, '2026-07-08T00:00:00Z');
  assert.equal(mapped.parentTaskId, 'parent-1');
  assert.equal(mapped.projectId, 'proj-1');
  assert.equal(mapped.templateId, 'tmpl-1');
  assert.equal(mapped.agentId, 'agent-1');
  assert.deepEqual(mapped.pending_question, { text: 'Which?' });
  assert.equal(mapped.created_at, Date.parse('2026-07-01T00:00:00Z'));
  assert.equal(mapped.updated_at, Date.parse('2026-07-02T00:00:00Z'));
  assert.equal(mapped.completed_at, null); // non-terminal status
  assert.equal(mapped.source, 'typebuild');
});

test('mapListRow sets completed_at for terminal statuses (done/cancelled)', () => {
  const now = 1_800_000_000_000;
  const done = mapListRow({ id: 't2', status: 'done', updated_at: '2026-07-02T00:00:00Z' }, now);
  assert.equal(done.status, 'done');
  assert.equal(done.completed_at, Date.parse('2026-07-02T00:00:00Z'));

  const cancelled = mapListRow({ id: 't3', status: 'cancelled' }, now);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.completed_at, now); // no updated_at → falls back to now
});

test('mapListRow falls back to now() and defaults when timestamps/fields are absent', () => {
  const now = 1_800_000_000_000;
  const mapped = mapListRow({ id: 't4' }, now);
  assert.equal(mapped.title, 't4'); // title falls back to id
  assert.equal(mapped.created_at, now);
  assert.equal(mapped.updated_at, now);
  assert.equal(mapped.due_at, null);
  assert.equal(mapped.claimedBy, null);
  assert.equal(mapped.assignedTo, null);
  assert.deepEqual(mapped.flags, []);
  assert.equal(mapped.priority, undefined);
  assert.equal(mapped.attempts, undefined);
  assert.equal(mapped.maxAttempts, undefined);
  assert.equal(mapped.templateId, undefined);
  assert.equal(mapped.agentId, null);
  assert.equal(mapped.pending_question, undefined);
});

test('mapListRow treats a blocked row as rawStatus "blocked" mapped to pending', () => {
  const mapped = mapListRow({ id: 't5', status: 'open', blocked: true }, 0);
  assert.equal(mapped.rawStatus, 'blocked');
  assert.equal(mapped.status, 'pending');
});

test('mapListRow defaults `now` to Date.now() when omitted', () => {
  const before = Date.now();
  const mapped = mapListRow({ id: 't6' });
  const after = Date.now();
  assert.ok(mapped.created_at >= before && mapped.created_at <= after);
});

// ── buildCreatePayload ────────────────────────────────────────────────────────
test('buildCreatePayload builds the minimal payload for title+notes only', () => {
  assert.deepEqual(buildCreatePayload({ title: '  Hello  ', notes: '  body text  ' }), {
    title: 'Hello',
    task: 'body text',
  });
});

test('buildCreatePayload includes every optional field when supplied', () => {
  const input = {
    title: 'T',
    notes: 'N',
    due_at: '2026-07-10',
    deferUntil: '2026-07-08T00:00:00Z',
    priority: 2,
    projectId: 'proj-1',
    agentId: 'agent-1',
    assignedTo: 'bob@x.com',
    parentTaskId: 'parent-1',
    dependsOn: ['dep-1', 'dep-2'],
    recurrence: '1w',
    outputSchema: [{ key: 'k', label: 'K', type: 'text' }],
    data: { k: 'v' },
  };
  assert.deepEqual(buildCreatePayload(input), {
    title: 'T',
    task: 'N',
    due_at: '2026-07-10',
    defer_until: '2026-07-08T00:00:00Z',
    priority: 2,
    project_id: 'proj-1',
    agent_id: 'agent-1',
    assigned_to: 'bob@x.com',
    parent_task_id: 'parent-1',
    depends_on: ['dep-1', 'dep-2'],
    recurrence: '1w',
    output_schema: [{ key: 'k', label: 'K', type: 'text' }],
    data: { k: 'v' },
  });
});

test('buildCreatePayload omits empty/falsy optional fields (no no-op keys)', () => {
  const input = {
    title: 'T',
    notes: '',
    due_at: null,
    deferUntil: null,
    projectId: '',
    agentId: '',
    assignedTo: '',
    parentTaskId: null,
    dependsOn: [],
    recurrence: null,
    outputSchema: [],
    data: {},
  };
  assert.deepEqual(buildCreatePayload(input), { title: 'T', task: '' });
});

test('buildCreatePayload defaults absent title/notes to empty strings', () => {
  assert.deepEqual(buildCreatePayload({}), { title: '', task: '' });
});

// ── buildTemplatePatchPayload ─────────────────────────────────────────────────
test('buildTemplatePatchPayload maps only the supplied fields to snake_case', () => {
  assert.deepEqual(buildTemplatePatchPayload({ name: 'New name', agentId: null }), {
    name: 'New name',
    agent_id: null,
  });
});

test('buildTemplatePatchPayload maps every field when all are supplied', () => {
  const patch = {
    name: 'N',
    variables: [{ key: 'v' }],
    outputSchema: [{ key: 'o' }],
    notes: 'body',
    agentId: 'agent-1',
    flags: ['f1'],
    projectId: 'proj-1',
    groupId: 'group-1',
  };
  assert.deepEqual(buildTemplatePatchPayload(patch), {
    name: 'N',
    variables: [{ key: 'v' }],
    output_schema: [{ key: 'o' }],
    notes: 'body',
    agent_id: 'agent-1',
    flags: ['f1'],
    project_id: 'proj-1',
    group_id: 'group-1',
  });
});

test('buildTemplatePatchPayload returns {} when patch supplies nothing', () => {
  assert.deepEqual(buildTemplatePatchPayload({}), {});
});
