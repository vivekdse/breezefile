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

// task-8f27d842f14d — Connection-binding counterparts to
// sourceFromCatalogEntry/fieldFromCatalog. No Connection-browsing catalog UI
// exists yet (a separate task builds the picker); these exist so any caller
// that already holds a Connection id + a declarative lookup CallSpec
// (docs/connections-design.md §D.2) can build a well-formed `source` /
// TaskDefField the same way the SavedQuery form does, instead of hand-rolling
// the shape at each call site.

/** Build the Connection-form `source` binding: `bundle` defaults to `'all'`
 *  (snapshot every field the lookup's `output.fields` declares) unless the
 *  caller narrows it to an explicit `{ fields: [...] }` list. */
export function sourceFromConnection(connectionId, connectionVersion, lookup, opts = {}) {
  const source = {
    connectionId,
    connectionVersion,
    lookup,
    bundle: opts.bundle ?? 'all',
  };
  if (typeof opts.entityType === 'string' && opts.entityType) source.entityType = opts.entityType;
  return source;
}

/** Build a new TaskDefField bound to a Connection lookup. Mirrors
 *  fieldFromCatalog's key-dedup behavior; unlike the catalog form there is no
 *  external "field name" to derive a key from (a Connection lookup's row
 *  shape isn't known ahead of a live call), so the caller supplies key/label/
 *  type directly. Returns null when `key` normalizes to empty. */
export function fieldFromConnection(key, label, type, connectionId, connectionVersion, lookup, opts = {}) {
  const base = normalizeFieldKey(key);
  if (!base) return null;
  const source = sourceFromConnection(connectionId, connectionVersion, lookup, opts);
  return {
    key: dedupeKey(base, opts.existingKeys ?? []),
    label: label || humanizeFieldName(key) || key,
    type: type || 'text',
    source,
  };
}

// task-8f27d842f14d — docs/connections-design.md §D.2 step 3/4: turn a picked
// Connection-lookup ROW into the `<fieldKey>.*` sibling entries that ride the
// task `data` bag alongside the existing `<fieldKey>` (label) and
// `<fieldKey>.ref` (JSON ref) convention. Pure + side-effect-free (like the
// rest of this module) so TaskComposer's write path and any future consumer
// (a resolved-fresh fill, once the lazy mode in D.2 is built) share ONE
// definition of "what does a Connection pick snapshot."
//
// String -> string only, per typebuild-data-field-contract.md §1: a
// structured row-field VALUE (object/array) is JSON-encoded into its string
// slot; the consumer parses. Values are read off `row` by the bundle's `from`
// name (the CallSpec output.fields key the row was mapped under, NOT
// `row.ref`, which is handled separately below).
//
// Returns `{ upsert, keys }` — `upsert` is ready to merge into a
// fm.typebuild.taskData.patch call's upsert map (prefixed `${fieldKey}.`),
// `keys` is the full list of sibling keys written (bundle fields +
// `.ref`/`.connection_id`/`.connection_version`/`.picked_at`) so the caller
// can pass them as knownSiblingKeys/deleteKeys on a re-pick or clear (see
// connectionBundleKeys below for the "what to DELETE on clear" half).
export function snapshotConnectionRow(fieldKey, source, row, pickedAt = new Date().toISOString()) {
  const upsert = {};
  const keys = [];
  const setField = (k, v) => {
    const full = `${fieldKey}.${k}`;
    const str = typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
    upsert[full] = str;
    keys.push(full);
  };
  const bundle = source && source.bundle;
  const fieldsToWrite =
    bundle === 'all' || !bundle
      ? Object.keys(row).filter((k) => k !== 'ref')
      : Array.isArray(bundle.fields)
        ? bundle.fields
        : [];
  if (bundle === 'all' || !bundle) {
    for (const from of fieldsToWrite) setField(from, row[from]);
  } else {
    for (const { from, key } of fieldsToWrite) {
      if (from in row) setField(key, row[from]);
    }
  }
  setField('ref', JSON.stringify(row.ref));
  setField('connection_id', (source && source.connectionId) || '');
  setField('connection_version', (source && source.connectionVersion) || '');
  setField('picked_at', pickedAt);
  return { upsert, keys };
}

// task-8f27d842f14d — the DELETE-side counterpart of snapshotConnectionRow:
// given a field's CURRENT source binding + the full task-data bag (key ->
// value) already known to the caller, return every `<fieldKey>.*` key that a
// bundle snapshot may have written previously, so a re-pick or an explicit
// clear can pass them as deleteKeys and leave no orphan sibling when the
// bundle map (or the picked row's shape) changes between picks. Prefix-based
// (not bundle-shape-based) so it also cleans up keys from a PRIOR bundle
// definition, not just the current one — a changed `bundle.fields` list, or a
// switch from 'all' to a narrower list, still fully cleans up.
export function connectionBundleKeys(fieldKey, existingDataKeys = []) {
  const prefix = `${fieldKey}.`;
  return Array.from(existingDataKeys).filter((k) => k.startsWith(prefix));
}

// task-342f3e151d99 — shared normalization step for everything below that
// walks the catalog: drops entries with no usable id or no usable fields, and
// resolves the display name once. Keeps catalogPickerGroups/pickerOptions/
// sourceOptions all agreeing on what counts as a "pickable" entry.
function normalizedEntries(catalog) {
  if (!Array.isArray(catalog)) return [];
  const out = [];
  for (const entry of catalog) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) continue;
    const fields = Array.isArray(entry.fields)
      ? entry.fields.filter((f) => f && typeof f === 'object' && typeof f.name === 'string' && f.name.trim())
      : [];
    if (fields.length === 0) continue;
    const name = typeof entry.name === 'string' && entry.name ? entry.name : entry.id;
    out.push({ entry, name, fields });
  }
  return out;
}

/** Flatten a catalog into the picker's option list: one group per query (with
 *  its display name), each carrying its fields. Entries with no usable id or no
 *  fields are dropped so the menu never shows an empty/unpickable group.
 *  Pure + defensive: a null/malformed catalog yields []. Kept for back-compat
 *  (no remaining internal call sites after task-342f3e151d99's keyboard-first
 *  picker landed; still exported in case another surface wants the grouped
 *  shape). */
export function catalogPickerGroups(catalog) {
  return normalizedEntries(catalog).map(({ entry, name, fields }) => ({ id: entry.id, name, fields }));
}

// Every (entry, field) pair in the catalog, flattened, each carrying the
// "<query name> · <Field Label>" label the TOP-LEVEL picker (pickerOptions)
// shows — the query name disambiguates once >1 source is in play.
function flattenFields(catalog) {
  const out = [];
  for (const { entry, name, fields } of normalizedEntries(catalog)) {
    for (const field of fields) {
      const fieldLabel = humanizeFieldName(field.name) || field.name.trim();
      out.push({ entry, field, label: `${name} · ${fieldLabel}` });
    }
  }
  return out;
}

function norm(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

/** task-342f3e151d99 — the ordered option list for the keyboard-first picker's
 *  TOP (default) step: `{kind:'custom'}` is always first (a freeform key the
 *  user names), then source-backed field options flattened + labelled
 *  "<query name> · <Field Label>", then a trailing `{kind:'browse'}` when the
 *  list was truncated.
 *
 *  Truncation: when there are more fields than `threshold` (default 6) OR
 *  more than one source/query in the catalog, don't dump everything — show
 *  the top `threshold` fields and append `browse` so the user can drill into
 *  a two-step source→field picker instead. A single query with <= threshold
 *  fields shows everything with no `browse`.
 *
 *  Search: when `query` is a non-empty string, it filters across ALL sources
 *  + fields (case-insensitive, matches the field's raw name or its full
 *  "<query> · <label>" text) and `browse` is omitted — search already reaches
 *  everything `browse` would have drilled into. `custom` still leads. */
export function pickerOptions(catalog, { query = '', threshold = 6 } = {}) {
  const all = flattenFields(catalog);
  const custom = { kind: 'custom' };
  const q = norm(query);
  if (q) {
    const matched = all.filter(
      ({ field, label }) => norm(field.name).includes(q) || norm(label).includes(q),
    );
    return [custom, ...matched.map(({ entry, field, label }) => ({ kind: 'field', entry, field, label }))];
  }
  const entryCount = new Set(all.map((i) => i.entry.id)).size;
  const truncate = all.length > threshold || entryCount > 1;
  const shown = truncate ? all.slice(0, threshold) : all;
  const options = [custom, ...shown.map(({ entry, field, label }) => ({ kind: 'field', entry, field, label }))];
  if (truncate) options.push({ kind: 'browse' });
  return options;
}

/** task-342f3e151d99 — step 1 of "Browse all…": one `{kind:'source', entry,
 *  label}` per pickable query, filtered by `query` against the query's
 *  display name (case-insensitive substring). */
export function sourceOptions(catalog, { query = '' } = {}) {
  const q = norm(query);
  const entries = normalizedEntries(catalog);
  const filtered = q ? entries.filter(({ name }) => norm(name).includes(q)) : entries;
  return filtered.map(({ entry, name }) => ({ kind: 'source', entry, label: name }));
}

/** task-342f3e151d99 — step 2 of "Browse all…": the field options for ONE
 *  source entry (already chosen at step 1), labelled with just the humanized
 *  field name (no query prefix — the source is already the context), filtered
 *  by `query` against the raw field name or its label. */
export function fieldOptionsForSource(entry, { query = '' } = {}) {
  if (!entry || typeof entry !== 'object') return [];
  const fields = Array.isArray(entry.fields)
    ? entry.fields.filter((f) => f && typeof f === 'object' && typeof f.name === 'string' && f.name.trim())
    : [];
  const q = norm(query);
  const withLabel = fields.map((field) => ({
    field,
    label: humanizeFieldName(field.name) || field.name.trim(),
  }));
  const filtered = q
    ? withLabel.filter(({ field, label }) => norm(field.name).includes(q) || norm(label).includes(q))
    : withLabel;
  return filtered.map(({ field, label }) => ({ kind: 'field', entry, field, label }));
}
