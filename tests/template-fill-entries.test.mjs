// task-e112d60a3b7c — "New from Template" moved from a client-side scan over
// prior tasks (deriveTemplateEntry, removed) to the first-class server Template
// API (GET /chromeext/templates). The picker walks one value-question per
// template `variable`; `templateFillEntries` (src/components/newhome/
// taskSchema.mjs) is the pure derivation of that ordered walk from a fetched
// Template. These tests pin its contract: declaration order preserved, each
// entry carries the flat `<templateId>.<key>` ref the composer keys values by,
// and malformed/keyless variables are skipped rather than throwing. No React;
// runs under `node --test`, mirroring the task-schema module family conventions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templateFillEntries, fieldRef } from '../src/components/newhome/taskSchema.mjs';

function template(overrides) {
  return {
    id: 'tmpl-1',
    name: 'Intake',
    variables: [],
    outputSchema: [],
    ...overrides,
  };
}

test('templateFillEntries: one ordered entry per variable, with flat refs', () => {
  const t = template({
    variables: [
      { key: 'patient', label: 'Patient name', type: 'text' },
      { key: 'urgency', label: 'Urgency', type: 'select', options: ['low', 'high'] },
    ],
  });
  const entries = templateFillEntries(t);
  assert.equal(entries.length, 2);
  // Declaration order preserved.
  assert.deepEqual(
    entries.map((e) => e.field.key),
    ['patient', 'urgency'],
  );
  // Each entry carries the `<templateId>.<key>` ref the picker keys values by.
  assert.equal(entries[0].ref, fieldRef('tmpl-1', 'patient'));
  assert.equal(entries[1].ref, fieldRef('tmpl-1', 'urgency'));
  assert.equal(entries[0].taskDefId, 'tmpl-1');
  // The raw field def is passed through for the field-question renderer.
  assert.equal(entries[1].field.type, 'select');
  assert.deepEqual(entries[1].field.options, ['low', 'high']);
});

test('templateFillEntries: a template with no variables yields no questions', () => {
  assert.deepEqual(templateFillEntries(template({ variables: [] })), []);
});

test('templateFillEntries: null/malformed inputs never throw', () => {
  assert.deepEqual(templateFillEntries(null), []);
  assert.deepEqual(templateFillEntries(undefined), []);
  assert.deepEqual(templateFillEntries({}), []);
  assert.deepEqual(templateFillEntries({ id: 'x', variables: null }), []);
});

test('templateFillEntries: variables lacking a usable key are skipped', () => {
  const t = template({
    variables: [
      { key: 'ok', label: 'Fine', type: 'text' },
      { label: 'no key', type: 'text' }, // no `key`
      null, // not an object
      { key: '', label: 'empty key', type: 'text' }, // empty key
    ],
  });
  const entries = templateFillEntries(t);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].field.key, 'ok');
});

test('templateFillEntries: falls back to a stable synthetic id when template id is absent', () => {
  const entries = templateFillEntries({ variables: [{ key: 'a', label: 'A', type: 'text' }] });
  assert.equal(entries[0].ref, fieldRef('template', 'a'));
});
