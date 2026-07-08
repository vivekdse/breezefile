// task-73f6304ffb94 — pure helpers for the source-aware key picker.
//
// Template authoring becomes key-centric: when a user adds an INPUT field to a
// task-def they can pick from a catalog of fields exposed by approved external
// APIs (SavedQueries), OR add a plain custom key. This module holds the PURE,
// side-effect-free logic that turns one catalog field into a new TaskDefField
// (key normalization + dedup, label humanization, catalog→schema type mapping),
// so it runs under `node --test` with no transpile step (mirrors
// taskSchema.mjs). The React picker (FieldKeyPicker.tsx) is the thin UI shell
// over these functions.
//
// NON-PHI: a SavedQuery catalog is field NAMES + TYPES only (metadata,
// docs/typebuild-data-field-contract.md). No task VALUES ever flow through here.
//
// The catalog ENTRY shape this module consumes is the CLIENT-normalized one
// (camelCase `entityType`) produced by the API layer (src/copilot/savedQueries.ts
// describeQueries), NOT the server's raw snake_case — normalization stays at the
// boundary so this module has one shape to reason about.

import { normalizeFieldKey } from './taskSchema.mjs';

/** Map a catalog field's declared type to the TaskDefField.type enum
 *  ('text'|'number'|'date'|'select'|'bool'). Anything unrecognized —
 *  array/object/unknown/missing — falls back to 'text' (still keyable, still
 *  editable). Case-insensitive. */
export function catalogTypeToFieldType(type) {
  switch (typeof type === 'string' ? type.trim().toLowerCase() : '') {
    case 'string':
      return 'text';
    case 'number':
    case 'integer':
      return 'number';
    case 'date':
      return 'date';
    case 'boolean':
      return 'bool';
    default:
      // array | object | unknown | '' | anything else
      return 'text';
  }
}

/** Turn a raw field NAME into a human-readable label: split on separators
 *  (whitespace, dot, underscore, dash, and camelCase humps) and Title-Case each
 *  word. e.g. 'dob' → 'Dob', 'date_of_birth' → 'Date Of Birth', 'firstName' →
 *  'First Name'. Never throws; non-string/empty → ''. */
export function humanizeFieldName(name) {
  if (typeof name !== 'string') return '';
  const words = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase hump → space
    .split(/[\s._-]+/)
    .filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Dedup a candidate key against a set of keys already in use, appending
 *  `-2`, `-3`, … (still within the [a-z0-9._-] key charset) until unique.
 *  `base` is assumed already normalized; `existingKeys` is any iterable of
 *  strings. Returns `base` unchanged when it's already free. */
export function dedupeKey(base, existingKeys = []) {
  const set = new Set(existingKeys);
  if (!set.has(base)) return base;
  let n = 2;
  while (set.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Build the `source` binding for a TaskDefField from a catalog entry: the
 *  SavedQuery id (required), plus version + entityType when the catalog carries
 *  them. Returns null when the entry has no usable id. */
export function sourceFromCatalogEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const savedQueryId = typeof entry.id === 'string' ? entry.id : '';
  if (!savedQueryId) return null;
  const source = { savedQueryId };
  if (typeof entry.version === 'number') source.version = entry.version;
  if (typeof entry.entityType === 'string' && entry.entityType) source.entityType = entry.entityType;
  return source;
}

/** Build a new TaskDefField from a catalog entry + one of its fields, deduping
 *  the derived key against `existingKeys`. The field's `key` is the field name
 *  normalized to the server key charset (still user-editable afterward), its
 *  `label` is the humanized field name, its `type` is mapped from the catalog
 *  type, and `source` binds it to the SavedQuery (name/source are independent —
 *  the caller may later rename the key without touching source). Returns null
 *  when the entry/field can't yield a usable key (fail-soft, never throws). */
export function fieldFromCatalog(entry, field, existingKeys = []) {
  const source = sourceFromCatalogEntry(entry);
  if (!source) return null;
  if (!field || typeof field !== 'object' || typeof field.name !== 'string') return null;
  const base = normalizeFieldKey(field.name);
  if (!base) return null;
  return {
    key: dedupeKey(base, existingKeys),
    label: humanizeFieldName(field.name) || field.name.trim(),
    type: catalogTypeToFieldType(field.type),
    source,
  };
}

/** A fresh, unbound (plain custom) input field — the "Other (custom key)"
 *  pick, identical to today's blank add. */
export function blankCustomField() {
  return { key: '', label: '', type: 'text' };
}

/** Flatten a catalog into the picker's option list: one group per query (with
 *  its display name), each carrying its fields. Entries with no usable id or no
 *  fields are dropped so the menu never shows an empty/unpickable group.
 *  Pure + defensive: a null/malformed catalog yields []. */
export function catalogPickerGroups(catalog) {
  if (!Array.isArray(catalog)) return [];
  const groups = [];
  for (const entry of catalog) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) continue;
    const fields = Array.isArray(entry.fields)
      ? entry.fields.filter((f) => f && typeof f === 'object' && typeof f.name === 'string' && f.name.trim())
      : [];
    if (fields.length === 0) continue;
    groups.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
      fields,
    });
  }
  return groups;
}
