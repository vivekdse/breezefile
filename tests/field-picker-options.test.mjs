// task-342f3e151d99 — unit tests for the keyboard-first field-source picker's
// pure option lists (src/components/newhome/fieldCatalog.mjs): ordering,
// threshold/browse truncation, search filtering, degrade-to-custom-only, and
// the source→field drill-down. No React; runs under `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickerOptions,
  sourceOptions,
  fieldOptionsForSource,
} from '../src/components/newhome/fieldCatalog.mjs';

const oneQuery = [
  {
    id: 'sq-1',
    name: 'people-search',
    fields: [
      { name: 'name', type: 'string' },
      { name: 'dob', type: 'date' },
      { name: 'mrn', type: 'string' },
    ],
  },
];

const manyFields = [
  {
    id: 'sq-1',
    name: 'people-search',
    fields: Array.from({ length: 8 }, (_, i) => ({ name: `field_${i}`, type: 'string' })),
  },
];

const twoQueries = [
  { id: 'sq-1', name: 'people-search', fields: [{ name: 'name', type: 'string' }] },
  { id: 'sq-2', name: 'orders', fields: [{ name: 'order_id', type: 'string' }] },
];

// ── ordering: custom is ALWAYS option 1 ─────────────────────────────────────
test('pickerOptions puts custom first, then fields, for a small single-source catalog', () => {
  const opts = pickerOptions(oneQuery);
  assert.equal(opts[0].kind, 'custom');
  assert.equal(opts.length, 4); // custom + 3 fields, no browse (single source, under threshold)
  assert.deepEqual(
    opts.slice(1).map((o) => o.field.name),
    ['name', 'dob', 'mrn'],
  );
  assert.equal(opts[1].label, 'people-search · Name');
});

test('pickerOptions degrades to just custom for an empty/malformed catalog', () => {
  for (const bad of [[], null, undefined, [{ id: 'sq', fields: [] }]]) {
    const opts = pickerOptions(bad);
    assert.equal(opts.length, 1);
    assert.equal(opts[0].kind, 'custom');
  }
});

// ── threshold / browse truncation ───────────────────────────────────────────
test('pickerOptions truncates + appends browse when fields exceed the threshold', () => {
  const opts = pickerOptions(manyFields, { threshold: 6 });
  // custom + 6 shown fields + browse
  assert.equal(opts.length, 8);
  assert.equal(opts[0].kind, 'custom');
  assert.equal(opts[opts.length - 1].kind, 'browse');
  assert.equal(opts.filter((o) => o.kind === 'field').length, 6);
});

test('pickerOptions appends browse when there is more than one source, even under threshold', () => {
  const opts = pickerOptions(twoQueries, { threshold: 6 });
  // custom + 2 fields (both queries, well under threshold) + browse anyway
  assert.equal(opts.length, 4);
  assert.equal(opts[opts.length - 1].kind, 'browse');
  assert.equal(opts.filter((o) => o.kind === 'field').length, 2);
});

test('pickerOptions with a single source at exactly the threshold shows no browse', () => {
  const exact = [
    {
      id: 'sq-1',
      name: 'q',
      fields: Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, type: 'string' })),
    },
  ];
  const opts = pickerOptions(exact, { threshold: 6 });
  assert.equal(opts.length, 7); // custom + 6 fields, no browse
  assert.ok(opts.every((o) => o.kind !== 'browse'));
});

// ── search filtering ────────────────────────────────────────────────────────
test('pickerOptions search matches across ALL sources + fields and omits browse', () => {
  const opts = pickerOptions(twoQueries, { query: 'order', threshold: 1 });
  assert.equal(opts[0].kind, 'custom');
  assert.equal(opts.length, 2);
  assert.equal(opts[1].field.name, 'order_id');
  assert.ok(opts.every((o) => o.kind !== 'browse'));
});

test('pickerOptions search matches on field name OR the rendered label (query name)', () => {
  const byQueryName = pickerOptions(twoQueries, { query: 'people' });
  assert.equal(byQueryName.length, 2);
  assert.equal(byQueryName[1].field.name, 'name');

  const byFieldName = pickerOptions(twoQueries, { query: 'order_id' });
  assert.equal(byFieldName.length, 2);
  assert.equal(byFieldName[1].field.name, 'order_id');
});

test('pickerOptions search is case-insensitive and re-numbers naturally (fewer results)', () => {
  const opts = pickerOptions(manyFields, { query: 'FIELD_3' });
  assert.equal(opts.length, 2); // custom + the one match
  assert.equal(opts[1].field.name, 'field_3');
});

test('pickerOptions search with no matches leaves only custom', () => {
  const opts = pickerOptions(oneQuery, { query: 'zzz-no-match' });
  assert.equal(opts.length, 1);
  assert.equal(opts[0].kind, 'custom');
});

// ── source → field drill-down (step 1 + step 2 of "Browse all…") ───────────
test('sourceOptions lists one option per pickable source, filtered by name', () => {
  const opts = sourceOptions(twoQueries);
  assert.equal(opts.length, 2);
  assert.deepEqual(opts.map((o) => o.label), ['people-search', 'orders']);
  assert.ok(opts.every((o) => o.kind === 'source'));

  const filtered = sourceOptions(twoQueries, { query: 'ord' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].label, 'orders');
});

test('sourceOptions drops entries with no id or no usable fields', () => {
  assert.deepEqual(sourceOptions([{ id: 'sq', fields: [] }]), []);
  assert.deepEqual(sourceOptions([{ name: 'x', fields: [{ name: 'a', type: 'string' }] }]), []);
  assert.deepEqual(sourceOptions(null), []);
});

test('fieldOptionsForSource lists just the field label (no query prefix), filtered', () => {
  const entry = oneQuery[0];
  const opts = fieldOptionsForSource(entry);
  assert.equal(opts.length, 3);
  assert.deepEqual(
    opts.map((o) => o.label),
    ['Name', 'Dob', 'Mrn'],
  );
  assert.ok(opts.every((o) => o.entry === entry));

  const filtered = fieldOptionsForSource(entry, { query: 'do' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].field.name, 'dob');
});

test('fieldOptionsForSource is fail-soft on a missing/malformed entry', () => {
  assert.deepEqual(fieldOptionsForSource(null), []);
  assert.deepEqual(fieldOptionsForSource(undefined), []);
  assert.deepEqual(fieldOptionsForSource({}), []);
});
