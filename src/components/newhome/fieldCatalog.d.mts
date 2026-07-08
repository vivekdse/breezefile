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
