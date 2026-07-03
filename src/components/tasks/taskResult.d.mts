// task-19ba9f7f43f1 — type surface for the pure taskResult.mjs module (runtime
// is plain ESM so the node test runner imports it without a transpile step).

/** A structured, type-dispatched task result. `type` selects a renderer;
 *  `payload` is renderer-specific and treated as PHI-bearing task output. */
export type TaskResult = { type: string; payload: unknown };

/** A validated + normalized `table` payload. `width` is the column count every
 *  row has been padded/truncated to, so <td> count always matches <th>. */
export type NormalizedTable = {
  headers: string[];
  rows: string[][];
  width: number;
};

/** A validated + normalized `fields` payload. `taskDefId` is null for a
 *  generic (non-template) fields result. */
export type NormalizedFields = {
  taskDefId: string | null;
  entries: Array<{ key: string; value: string }>;
};

export const KNOWN_RESULT_TYPES: readonly string[];

export function resultRendererKind(result: unknown): string | null;

export function coerceCell(value: unknown): string;

export function normalizeTablePayload(payload: unknown): NormalizedTable | null;

export function normalizeFieldsPayload(payload: unknown): NormalizedFields | null;
