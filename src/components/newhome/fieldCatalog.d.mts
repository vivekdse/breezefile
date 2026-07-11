// task-73f6304ffb94 — type surface for the pure fieldCatalog.mjs module
// (runtime is plain ESM so the node test runner imports it without a transpile
// step). Consumes the CLIENT-normalized catalog shape from
// src/copilot/savedQueries.ts (QueryCatalogEntry / QueryCatalogField).

import type { TaskDefField } from './types';
import type { QueryCatalogEntry, QueryCatalogField } from '../../copilot/savedQueries';

export function catalogTypeToFieldType(type: unknown): TaskDefField['type'];
export function humanizeFieldName(name: unknown): string;
export function dedupeKey(base: string, existingKeys?: Iterable<string>): string;
export function sourceFromCatalogEntry(
  entry: QueryCatalogEntry | null | undefined,
): NonNullable<TaskDefField['source']> | null;
export function fieldFromCatalog(
  entry: QueryCatalogEntry | null | undefined,
  field: QueryCatalogField | null | undefined,
  existingKeys?: Iterable<string>,
): TaskDefField | null;
export function blankCustomField(): TaskDefField;
// task-8f27d842f14d — the Connection-binding counterpart to
// sourceFromCatalogEntry/fieldFromCatalog above. No Connection-browsing
// catalog UI exists yet (that's a separate task); this builder exists so any
// caller that already has a ConnectionSummary + a declarative lookup CallSpec
// (docs/connections-design.md §D.2) can produce a well-formed `source`/
// TaskDefField without hand-rolling the shape. `bundle` defaults to `'all'`.
export function sourceFromConnection(
  connectionId: string,
  connectionVersion: string,
  lookup: import('../../types').CallSpec,
  opts?: { entityType?: string; bundle?: { fields: Array<{ from: string; key: string }> } | 'all' },
): NonNullable<TaskDefField['source']>;
export function fieldFromConnection(
  key: string,
  label: string,
  type: TaskDefField['type'],
  connectionId: string,
  connectionVersion: string,
  lookup: import('../../types').CallSpec,
  opts?: {
    entityType?: string;
    bundle?: { fields: Array<{ from: string; key: string }> } | 'all';
    existingKeys?: Iterable<string>;
  },
): TaskDefField | null;

// task-8f27d842f14d — the picked-row -> data-bag-sibling-keys mapping
// (docs/connections-design.md §D.2 step 3/4) and its delete-side
// counterpart. See fieldCatalog.mjs for the full contract.
export function snapshotConnectionRow(
  fieldKey: string,
  source: NonNullable<TaskDefField['source']> | undefined,
  row: import('../../copilot/savedQueries').ConnectionLookupRow,
  pickedAt?: string,
): { upsert: Record<string, string>; keys: string[] };
export function connectionBundleKeys(
  fieldKey: string,
  existingDataKeys?: Iterable<string>,
): string[];
export type CatalogPickerGroup = { id: string; name: string; fields: QueryCatalogField[] };
export function catalogPickerGroups(
  catalog: QueryCatalogEntry[] | null | undefined,
): CatalogPickerGroup[];

// task-342f3e151d99 — the keyboard-first FieldSourcePicker's option shapes.
// `label` is pre-computed (no re-deriving humanize/join logic in the React
// layer): "<query> · <Field Label>" for top-level field options, just the
// field label for step-2 (fieldOptionsForSource) options.
export type PickerOptionCustom = { kind: 'custom' };
export type PickerOptionBrowse = { kind: 'browse' };
export type PickerOptionSource = { kind: 'source'; entry: QueryCatalogEntry; label: string };
export type PickerOptionField = {
  kind: 'field';
  entry: QueryCatalogEntry;
  field: QueryCatalogField;
  label: string;
};
export type PickerOption =
  | PickerOptionCustom
  | PickerOptionBrowse
  | PickerOptionSource
  | PickerOptionField;

export function pickerOptions(
  catalog: QueryCatalogEntry[] | null | undefined,
  opts?: { query?: string; threshold?: number },
): (PickerOptionCustom | PickerOptionField | PickerOptionBrowse)[];
export function sourceOptions(
  catalog: QueryCatalogEntry[] | null | undefined,
  opts?: { query?: string },
): PickerOptionSource[];
export function fieldOptionsForSource(
  entry: QueryCatalogEntry | null | undefined,
  opts?: { query?: string },
): PickerOptionField[];
