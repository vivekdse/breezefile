// task-4a8d2c98f667 — unit tests for the pure task-data-inputs module
// (src/components/tasks/taskDataInputs.mjs), which the drawer's Inputs
// section (TaskDataInputs.tsx) is a thin React wrapper over: key
// normalization/validation, the sensitive-key mask heuristic, the effective
// key-list merge (server data_keys + session-known keys), the auth-gating
// decision, and the upsert/delete patch-payload builder that feeds the
// resolve-merge-replace PATCH (electron/typebuild/task-data.ts
// patchTaskData). Also covers replaceTaskFieldsBlock (legacy ```task-fields
// rewrite) from taskSchema.mjs.
//
// This module holds NO PHI values itself — the values it operates on in
// these tests are synthetic placeholders, never real patient data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDataKey,
  isValidDataKey,
  looksSensitive,
  effectiveDataKeys,
  canEditTaskData,
  dataAuthDeniedMessage,
  buildDataPatchPayload,
  hasPendingDataChanges,
  siblingKeysForPatch,
} from '../src/components/tasks/taskDataInputs.mjs';
import {
  buildTaskFieldsBlock,
  parseTaskFieldsBlock,
  replaceTaskFieldsBlock,
} from '../src/components/newhome/taskSchema.mjs';

// ─── normalizeDataKey / isValidDataKey ────────────────────────────────────

test('normalizeDataKey trims and lowercases', () => {
  assert.equal(normalizeDataKey('  Source  '), 'source');
  assert.equal(normalizeDataKey('Patient.SSN'), 'patient.ssn');
  assert.equal(normalizeDataKey(''), '');
  assert.equal(normalizeDataKey(null), '');
  assert.equal(normalizeDataKey(undefined), '');
});

test('isValidDataKey accepts the dotted-lowercase convention', () => {
  assert.equal(isValidDataKey('source'), true);
  assert.equal(isValidDataKey('patient.ssn'), true);
  assert.equal(isValidDataKey('policy.member_id'), true);
  assert.equal(isValidDataKey('card-number'), true);
  assert.equal(isValidDataKey('  Source  '), true); // normalized first
});

test('isValidDataKey rejects empty / spaces / uppercase-after-trim / bad chars', () => {
  assert.equal(isValidDataKey(''), false);
  assert.equal(isValidDataKey('   '), false);
  assert.equal(isValidDataKey('has space'), false);
  assert.equal(isValidDataKey('bad$char'), false);
  assert.equal(isValidDataKey(null), false);
});

// ─── looksSensitive ────────────────────────────────────────────────────────

test('looksSensitive flags obviously-PHI-shaped keys', () => {
  assert.equal(looksSensitive('patient.ssn'), true);
  assert.equal(looksSensitive('patient.dob'), true);
  assert.equal(looksSensitive('card.number'), true);
  assert.equal(looksSensitive('me.npi'), true);
  assert.equal(looksSensitive('policy.member_id'), true);
});

test('looksSensitive does not flag a plain non-sensitive key', () => {
  assert.equal(looksSensitive('source'), false);
  assert.equal(looksSensitive('url'), false);
  assert.equal(looksSensitive(''), false);
  assert.equal(looksSensitive(null), false);
});

// ─── effectiveDataKeys ─────────────────────────────────────────────────────

test('effectiveDataKeys prefers server keys, folds in session-known, dedupes+sorts', () => {
  assert.deepEqual(effectiveDataKeys(['b', 'a'], ['c', 'a']), ['a', 'b', 'c']);
});

test('effectiveDataKeys falls back to session-known keys when server sends none', () => {
  assert.deepEqual(effectiveDataKeys(undefined, ['source']), ['source']);
  assert.deepEqual(effectiveDataKeys(null, []), []);
});

// ─── canEditTaskData / dataAuthDeniedMessage ──────────────────────────────

test('canEditTaskData allows the claim holder', () => {
  assert.equal(
    canEditTaskData({ claimedBy: 'a@x.com', createdBy: 'b@x.com', viewerEmail: 'a@x.com' }),
    true,
  );
});

test('canEditTaskData allows the creator even if someone else holds the claim', () => {
  assert.equal(
    canEditTaskData({ claimedBy: 'other@x.com', createdBy: 'me@x.com', viewerEmail: 'me@x.com' }),
    true,
  );
});

test('canEditTaskData denies a viewer with no email (signed out)', () => {
  assert.equal(
    canEditTaskData({ claimedBy: 'a@x.com', createdBy: 'b@x.com', viewerEmail: null }),
    false,
  );
});

test('canEditTaskData defaults to attempt (true) when neither claim nor creator match — server 403 is the backstop for group-admin', () => {
  assert.equal(
    canEditTaskData({ claimedBy: 'other@x.com', createdBy: 'creator@x.com', viewerEmail: 'third@x.com' }),
    true,
  );
});

test('dataAuthDeniedMessage differs for read vs write and names the allowed roles', () => {
  const read = dataAuthDeniedMessage('read');
  const write = dataAuthDeniedMessage('write');
  assert.notEqual(read, write);
  assert.match(read, /claim holder/i);
  assert.match(write, /claim holder/i);
});

// ─── buildDataPatchPayload / hasPendingDataChanges ────────────────────────

test('buildDataPatchPayload only upserts keys whose draft differs from original', () => {
  const payload = buildDataPatchPayload({
    drafts: { source: 'changed', other: 'same' },
    originals: { source: 'orig', other: 'same' },
    removedKeys: [],
  });
  assert.deepEqual(payload.upsert, { source: 'changed' });
  assert.deepEqual(payload.delete, []);
});

test('buildDataPatchPayload moves removed keys to delete and drops them from upsert', () => {
  const payload = buildDataPatchPayload({
    drafts: { source: 'changed' },
    originals: { source: 'orig' },
    removedKeys: ['source'],
  });
  assert.deepEqual(payload.upsert, {});
  assert.deepEqual(payload.delete, ['source']);
});

test('buildDataPatchPayload with no changes produces an empty payload', () => {
  const payload = buildDataPatchPayload({
    drafts: { source: 'orig' },
    originals: { source: 'orig' },
    removedKeys: [],
  });
  assert.deepEqual(payload.upsert, {});
  assert.deepEqual(payload.delete, []);
  assert.equal(hasPendingDataChanges(payload), false);
});

test('hasPendingDataChanges is true when there is an upsert or a delete', () => {
  assert.equal(hasPendingDataChanges({ upsert: { a: '1' }, delete: [] }), true);
  assert.equal(hasPendingDataChanges({ upsert: {}, delete: ['a'] }), true);
  assert.equal(hasPendingDataChanges({ upsert: {}, delete: [] }), false);
  assert.equal(hasPendingDataChanges(null), false);
});

// ─── siblingKeysForPatch ────────────────────────────────────────────────────

test('siblingKeysForPatch excludes keys being upserted or deleted this save', () => {
  const siblings = siblingKeysForPatch(
    ['source', 'other', 'gone'],
    { upsert: { source: 'v' }, delete: ['gone'] },
  );
  assert.deepEqual(siblings, ['other']);
});

test('siblingKeysForPatch is all known keys when the payload touches none of them', () => {
  assert.deepEqual(
    siblingKeysForPatch(['a', 'b'], { upsert: { newkey: 'v' }, delete: [] }),
    ['a', 'b'],
  );
});

// ─── replaceTaskFieldsBlock (legacy edit path, taskSchema.mjs) ────────────

test('replaceTaskFieldsBlock rewrites an existing block in place, leaving the rest of the body untouched', () => {
  const original = `Please fill the form.\n\n${buildTaskFieldsBlock('tpl-1', 'def-1', { source: 'orig' })}\n\nTrailing note.`;
  const next = replaceTaskFieldsBlock(original, 'tpl-1', 'def-1', { source: 'updated' });
  const parsed = parseTaskFieldsBlock(next);
  assert.deepEqual(parsed, { templateId: 'tpl-1', taskDefId: 'def-1', values: { source: 'updated' } });
  assert.match(next, /Please fill the form\./);
  assert.match(next, /Trailing note\./);
});

test('replaceTaskFieldsBlock appends a fresh block when the body has none yet', () => {
  const next = replaceTaskFieldsBlock('Just a body.', 'tpl-1', 'def-1', { source: 'v' });
  assert.match(next, /Just a body\./);
  const parsed = parseTaskFieldsBlock(next);
  assert.deepEqual(parsed, { templateId: 'tpl-1', taskDefId: 'def-1', values: { source: 'v' } });
});

test('replaceTaskFieldsBlock on an empty body produces just the block', () => {
  const next = replaceTaskFieldsBlock('', 'tpl-1', 'def-1', { source: 'v' });
  const parsed = parseTaskFieldsBlock(next);
  assert.deepEqual(parsed, { templateId: 'tpl-1', taskDefId: 'def-1', values: { source: 'v' } });
});
