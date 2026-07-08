// task-73f6304ffb94 — unit tests for the pure field-catalog helpers
// (src/components/newhome/fieldCatalog.mjs): catalog→TaskDefField mapping, key
// normalization + dedup, type mapping, and degrade-on-empty. No React; runs
// under `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogTypeToFieldType,
  humanizeFieldName,
  dedupeKey,
  sourceFromCatalogEntry,
  fieldFromCatalog,
  blankCustomField,
  catalogPickerGroups,
} from '../src/components/newhome/fieldCatalog.mjs';

// ── type mapping ────────────────────────────────────────────────────────────
test('catalogTypeToFieldType maps the known catalog types', () => {
  assert.equal(catalogTypeToFieldType('string'), 'text');
  assert.equal(catalogTypeToFieldType('number'), 'number');
  assert.equal(catalogTypeToFieldType('integer'), 'number');
  assert.equal(catalogTypeToFieldType('date'), 'date');
  assert.equal(catalogTypeToFieldType('boolean'), 'bool');
});

test('catalogTypeToFieldType falls back to text for array/object/unknown/missing', () => {
  assert.equal(catalogTypeToFieldType('array'), 'text');
  assert.equal(catalogTypeToFieldType('object'), 'text');
  assert.equal(catalogTypeToFieldType('whatever'), 'text');
  assert.equal(catalogTypeToFieldType(undefined), 'text');
  assert.equal(catalogTypeToFieldType(null), 'text');
  assert.equal(catalogTypeToFieldType(42), 'text');
});

test('catalogTypeToFieldType is case-insensitive and trims', () => {
  assert.equal(catalogTypeToFieldType('  STRING '), 'text');
  assert.equal(catalogTypeToFieldType('Boolean'), 'bool');
});

// ── humanize ──────────────────────────────────────────────────────────────
test('humanizeFieldName title-cases on separators and camelCase humps', () => {
  assert.equal(humanizeFieldName('dob'), 'Dob');
  assert.equal(humanizeFieldName('date_of_birth'), 'Date Of Birth');
  assert.equal(humanizeFieldName('first-name'), 'First Name');
  assert.equal(humanizeFieldName('firstName'), 'First Name');
  assert.equal(humanizeFieldName('patient.mrn'), 'Patient Mrn');
});

test('humanizeFieldName is fail-soft on non-strings / empties', () => {
  assert.equal(humanizeFieldName(''), '');
  assert.equal(humanizeFieldName(undefined), '');
  assert.equal(humanizeFieldName(null), '');
  assert.equal(humanizeFieldName(5), '');
});

// ── dedup ───────────────────────────────────────────────────────────────────
test('dedupeKey returns base when free, else appends -2, -3, …', () => {
  assert.equal(dedupeKey('name', []), 'name');
  assert.equal(dedupeKey('name', ['other']), 'name');
  assert.equal(dedupeKey('name', ['name']), 'name-2');
  assert.equal(dedupeKey('name', ['name', 'name-2']), 'name-3');
  assert.equal(dedupeKey('name', ['name', 'name-2', 'name-3']), 'name-4');
});

// ── sourceFromCatalogEntry ────────────────────────────────────────────────
test('sourceFromCatalogEntry builds the binding, dropping absent optionals', () => {
  assert.deepEqual(sourceFromCatalogEntry({ id: 'sq-1' }), { savedQueryId: 'sq-1' });
  assert.deepEqual(sourceFromCatalogEntry({ id: 'sq-1', version: 3, entityType: 'person' }), {
    savedQueryId: 'sq-1',
    version: 3,
    entityType: 'person',
  });
  assert.equal(sourceFromCatalogEntry({}), null);
  assert.equal(sourceFromCatalogEntry(null), null);
});

// ── fieldFromCatalog ─────────────────────────────────────────────────────────
test('fieldFromCatalog builds a fully-formed, source-bound TaskDefField', () => {
  const entry = { id: 'sq-1', name: 'people-search', version: 2, entityType: 'person' };
  const field = fieldFromCatalog(entry, { name: 'date_of_birth', type: 'date' }, []);
  assert.deepEqual(field, {
    key: 'date_of_birth',
    label: 'Date Of Birth',
    type: 'date',
    source: { savedQueryId: 'sq-1', version: 2, entityType: 'person' },
  });
});

test('fieldFromCatalog dedupes the derived key against existing keys', () => {
  const entry = { id: 'sq-1', name: 'q' };
  const field = fieldFromCatalog(entry, { name: 'name', type: 'string' }, ['name']);
  assert.equal(field.key, 'name-2');
  assert.equal(field.label, 'Name');
  assert.equal(field.type, 'text');
});

test('fieldFromCatalog normalizes a messy field name into a valid key', () => {
  const entry = { id: 'sq-1', name: 'q' };
  const field = fieldFromCatalog(entry, { name: 'Home Address Line 1', type: 'string' }, []);
  assert.equal(field.key, 'home_address_line_1');
  assert.match(field.key, /^[a-z0-9._-]+$/);
  assert.equal(field.label, 'Home Address Line 1');
});

test('fieldFromCatalog is fail-soft: null on unusable entry/field', () => {
  assert.equal(fieldFromCatalog(null, { name: 'x', type: 'string' }, []), null);
  assert.equal(fieldFromCatalog({}, { name: 'x', type: 'string' }, []), null); // no id
  assert.equal(fieldFromCatalog({ id: 'sq' }, null, []), null);
  assert.equal(fieldFromCatalog({ id: 'sq' }, { name: '   ' }, []), null); // normalizes to no key
});

// ── blankCustomField ("Other") ────────────────────────────────────────────
test('blankCustomField returns a plain unbound blank field', () => {
  assert.deepEqual(blankCustomField(), { key: '', label: '', type: 'text' });
});

// ── catalogPickerGroups + degrade-on-empty ──────────────────────────────────
test('catalogPickerGroups flattens entries into pickable groups', () => {
  const catalog = [
    {
      id: 'sq-1',
      name: 'people-search',
      fields: [
        { name: 'name', type: 'string' },
        { name: 'dob', type: 'date' },
      ],
    },
  ];
  const groups = catalogPickerGroups(catalog);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'sq-1');
  assert.equal(groups[0].name, 'people-search');
  assert.equal(groups[0].fields.length, 2);
});

test('catalogPickerGroups drops entries with no id or no fields (degrade)', () => {
  assert.deepEqual(catalogPickerGroups([]), []);
  assert.deepEqual(catalogPickerGroups(null), []);
  assert.deepEqual(catalogPickerGroups(undefined), []);
  assert.deepEqual(catalogPickerGroups([{ id: 'sq-1', fields: [] }]), []); // no fields
  assert.deepEqual(catalogPickerGroups([{ name: 'x', fields: [{ name: 'a', type: 'string' }] }]), []); // no id
  // A field with a non-string name is filtered out; if that leaves none, drop it.
  assert.deepEqual(catalogPickerGroups([{ id: 'sq', fields: [{ type: 'string' }] }]), []);
});

test('catalogPickerGroups falls back to id when name missing', () => {
  const groups = catalogPickerGroups([{ id: 'sq-7', fields: [{ name: 'a', type: 'string' }] }]);
  assert.equal(groups[0].name, 'sq-7');
});
