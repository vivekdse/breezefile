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
