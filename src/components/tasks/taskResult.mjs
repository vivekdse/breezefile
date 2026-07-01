// task-19ba9f7f43f1 — bespoke task-result rendering (pure logic half).
//
// A task can carry a STRUCTURED result — `{ type: string, payload: unknown }` —
// that the client renders in a format suited to the task (a TABLE first), the
// way GitHub Actions job-summaries / Slack Block Kit dispatch a typed block to a
// template. This module holds the PURE, framework-free pieces so they can be
// unit-tested under `node --test` (Node has no TSX loader): the type-dispatch
// key, safe cell coercion, and table-payload normalization/validation.
//
// The React half (the renderer registry + <TableResult> + the dispatching
// <TaskResultView>) lives in TaskResult.tsx and imports these helpers.
//
// NON-REGRESSION is the bar: a task with NO `result`, or an unknown/malformed
// `type`, must fall through to today's plain notes view. So every validator
// here fails SOFT — it returns null rather than throwing — and the dispatcher
// treats null as "nothing structured to render, use the fallback".
//
// PHI: a result payload is TASK OUTPUT and could contain PHI. These helpers only
// SHAPE in-memory values (coerce a cell to a string, validate an array) — they
// never log, persist, or emit the payload. Treat it exactly like task.title/
// notes: render it in the UI, never write it to disk/logs/notifications.

/** The set of result types this client knows how to render. Keep in lockstep
 *  with the RESULT_RENDERERS map in TaskResult.tsx (a test asserts parity). */
export const KNOWN_RESULT_TYPES = ['table'];

/** Does this task carry a STRUCTURED result with a known, renderable type?
 *  Defensive against any shape: missing, null, non-object, or unknown-type all
 *  answer false so the caller falls through to the plain notes view. */
export function resultRendererKind(result) {
  if (!result || typeof result !== 'object') return null;
  const type = result.type;
  if (typeof type !== 'string' || !type) return null;
  if (!KNOWN_RESULT_TYPES.includes(type)) return null;
  return type;
}

/** Coerce ANY cell value into a display string, safely. Numbers/booleans render
 *  as themselves; null/undefined become an empty string (a blank cell, not the
 *  literal word "null"); objects/arrays are JSON-stringified (with a plain
 *  fallback if that throws on a circular ref) so a stray nested value never
 *  crashes the render. */
export function coerceCell(value) {
  if (value === null || value === undefined) return '';
  const t = typeof value;
  if (t === 'string') return value;
  if (t === 'number') return Number.isFinite(value) ? String(value) : '';
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'bigint') return value.toString();
  // Objects/arrays: best-effort JSON, else a stable placeholder.
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Validate + normalize a `table` payload into a safe { headers, rows } shape,
 *  or null when it's malformed (so the caller falls back). Rules:
 *   - `headers` must be an array; each header is coerced to a string.
 *   - `rows` must be an array of arrays; each row is padded/truncated to the
 *     header width so <td> count always matches <th> count (a ragged row can't
 *     break the table layout); cells are coerced to strings.
 *   - A payload with neither a usable header nor any row is treated as empty →
 *     null → fall back to notes (an empty <table> is not a useful result).
 */
export function normalizeTablePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const rawHeaders = payload.headers;
  const rawRows = payload.rows;

  const headers = Array.isArray(rawHeaders) ? rawHeaders.map(coerceCell) : [];
  const rowsIn = Array.isArray(rawRows) ? rawRows : [];

  // Column count is the widest of the declared headers and any row, so a
  // header-less-but-rows payload (or vice-versa) still renders every cell.
  const width = rowsIn.reduce(
    (max, r) => (Array.isArray(r) ? Math.max(max, r.length) : max),
    headers.length,
  );
  if (width === 0) return null; // nothing to show → fall back

  const rows = rowsIn
    .filter((r) => Array.isArray(r))
    .map((r) => {
      const cells = r.map(coerceCell);
      // Pad short rows so every row has `width` cells; extra cells are kept
      // (width already accounts for the widest row).
      while (cells.length < width) cells.push('');
      return cells;
    });

  if (headers.length === 0 && rows.length === 0) return null;

  return { headers, rows, width };
}
