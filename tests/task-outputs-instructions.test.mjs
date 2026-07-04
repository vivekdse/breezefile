// Unit tests for the pure ```task-outputs instruction renderer
// (task-5170073890ed / T7, electron/typebuild/task-outputs-instructions.mjs).
// Same scoping as credential-normalize.test.mjs: this module has no Electron
// dependency, so we import it directly rather than standing up a stub server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const { parseTaskOutputsBlock, renderTaskOutputsInstructions } = await import(
  join(repoRoot, 'electron', 'typebuild', 'task-outputs-instructions.mjs')
);

const VALID_BODY = [
  'Wash the intake load.',
  '',
  '```task-outputs',
  JSON.stringify({
    taskDefId: 'intake',
    fields: [
      { key: 'has_stains', label: 'Stains present?', type: 'bool', required: true },
      { key: 'intake_photo', label: 'Intake photo id', type: 'text', required: true },
      { key: 'notes', label: 'Notes', type: 'text', required: false },
    ],
  }),
  '```',
].join('\n');

test('parseTaskOutputsBlock: extracts taskDefId + well-shaped fields', () => {
  const parsed = parseTaskOutputsBlock(VALID_BODY);
  assert.deepEqual(parsed, {
    taskDefId: 'intake',
    fields: [
      { key: 'has_stains', label: 'Stains present?', type: 'bool', required: true },
      { key: 'intake_photo', label: 'Intake photo id', type: 'text', required: true },
      { key: 'notes', label: 'Notes', type: 'text', required: false },
    ],
  });
});

test('valid block: instruction section lists every field with required/evidence wording', () => {
  const out = renderTaskOutputsInstructions(VALID_BODY);
  assert.notEqual(out, '');
  // Every field key + label + type is present.
  assert.match(out, /has_stains/);
  assert.match(out, /Stains present\?/);
  assert.match(out, /\[bool\]/);
  assert.match(out, /intake_photo/);
  assert.match(out, /\[text\]/);
  assert.match(out, /notes/);
  // Required/evidence wording present.
  assert.match(out, /REQUIRED/);
  assert.match(out, /evidence/i);
  assert.match(out, /not complete until/i);
  // submit_task_result contract: type "fields", FLAT payload shape (no taskDefId
  // wrapper), before submit_task — matches the server's own agent wording
  // (task-2638eeedd9ef: flat is canonical).
  assert.match(out, /submit_task_result\(type="fields", payload=/);
  assert.match(out, /"has_stains":\s*"<value>"/);
  assert.doesNotMatch(out, /"taskDefId"/);
  assert.match(out, /before submit_task/i);
  // PHI warning: never persist values to files/notes/logs.
  assert.match(out, /never write field values to files, notes, or logs/i);
  assert.match(out, /encrypted/i);
});

test('body without a task-outputs block: output is byte-identical to no-op (empty string)', () => {
  const plainBody = 'Just do the thing. No structured outputs here.';
  assert.equal(parseTaskOutputsBlock(plainBody), null);
  assert.equal(renderTaskOutputsInstructions(plainBody), '');
  assert.equal(renderTaskOutputsInstructions(''), '');
  assert.equal(renderTaskOutputsInstructions(null), '');
  assert.equal(renderTaskOutputsInstructions(undefined), '');
});

test('malformed block (invalid JSON): treated as absent', () => {
  const body = ['```task-outputs', '{not valid json', '```'].join('\n');
  assert.equal(parseTaskOutputsBlock(body), null);
  assert.equal(renderTaskOutputsInstructions(body), '');
});

test('malformed block (missing taskDefId): treated as absent', () => {
  const body = [
    '```task-outputs',
    JSON.stringify({ fields: [{ key: 'k', label: 'L', type: 'text' }] }),
    '```',
  ].join('\n');
  assert.equal(parseTaskOutputsBlock(body), null);
  assert.equal(renderTaskOutputsInstructions(body), '');
});

test('malformed block (fields not an array): degrades to empty fields, no instructions rendered', () => {
  const body = [
    '```task-outputs',
    JSON.stringify({ taskDefId: 'intake', fields: 'nope' }),
    '```',
  ].join('\n');
  const parsed = parseTaskOutputsBlock(body);
  assert.deepEqual(parsed, { taskDefId: 'intake', fields: [] });
  // No usable fields → nothing to instruct about.
  assert.equal(renderTaskOutputsInstructions(body), '');
});

test('malformed field entries are filtered out; well-shaped ones survive', () => {
  const body = [
    '```task-outputs',
    JSON.stringify({
      taskDefId: 'intake',
      fields: [
        { key: 'ok', label: 'OK field', type: 'text', required: true },
        { key: 'bad-type', label: 'Bad type', type: 'currency' }, // invalid type
        { label: 'No key', type: 'text' }, // missing key
        { key: 'no-label', type: 'text' }, // missing label
        'not-an-object',
        null,
      ],
    }),
    '```',
  ].join('\n');
  const parsed = parseTaskOutputsBlock(body);
  assert.deepEqual(parsed, {
    taskDefId: 'intake',
    fields: [{ key: 'ok', label: 'OK field', type: 'text', required: true }],
  });
  const out = renderTaskOutputsInstructions(body);
  assert.match(out, /ok/);
  assert.doesNotMatch(out, /bad-type/);
});

test('no task-outputs block among other fenced blocks: absent', () => {
  const body = [
    '```task-fields',
    JSON.stringify({ templateId: 't1', taskDefId: 'intake', values: { a: '1' } }),
    '```',
  ].join('\n');
  assert.equal(parseTaskOutputsBlock(body), null);
  assert.equal(renderTaskOutputsInstructions(body), '');
});
