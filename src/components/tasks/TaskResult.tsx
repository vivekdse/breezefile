// task-19ba9f7f43f1 — bespoke task-result rendering (React half).
//
// A task can carry a STRUCTURED result — `result?: { type, payload } | null` —
// and we DISPATCH on `type` to a registered renderer, mirroring GitHub Actions
// job-summaries / Slack Block Kit: a typed block → a template. The first (and,
// for now, only) renderer is `table`; the registry is a plain map so adding
// `diff` / `checklist` / `metrics` later is a one-line entry + a component.
//
// FALLBACK is the whole point: <TaskResultView> renders the registered
// component ONLY for a known, well-formed result; for a missing/null result, an
// unknown `type`, or a malformed payload it returns `null`, and the caller
// renders today's plain notes view unchanged (NON-REGRESSION).
//
// PHI: a result payload is task OUTPUT and could contain PHI. It rides in
// component memory exactly like task.title/notes — we render it, but never log,
// persist, or notify with it. The pure shaping helpers (taskResult.mjs) likewise
// only reshape values in memory.

import type { ComponentType } from 'react';
import {
  normalizeFieldsPayload,
  normalizeTablePayload,
  resultRendererKind,
} from './taskResult.mjs';
import type { TaskResult } from './taskResult.mjs';
import './TaskResult.css';

/** Props every result renderer receives: the raw (already type-matched)
 *  payload. Each renderer validates its own payload shape and returns null to
 *  fall back if it can't render it. */
export type ResultRendererProps = { payload: unknown };

// ── the `table` renderer ────────────────────────────────────────────────────
// payload: { headers: string[]; rows: any[][] }. Cells are coerced to strings
// safely (numbers/null/booleans handled); a malformed/empty payload normalizes
// to null and we return null so the host falls back to notes.
export function TableResult({ payload }: ResultRendererProps) {
  const table = normalizeTablePayload(payload);
  if (!table) return null;
  const { headers, rows, width } = table;
  return (
    <div className="tasks__result tasks__result--table">
      <table className="tasks__result-table">
        {headers.length > 0 && (
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {Array.from({ length: width }).map((_, ci) => (
                <td key={ci}>{row[ci] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── the `fields` renderer ───────────────────────────────────────────────────
// payload: `{ taskDefId?, fields: { key: value } }` — the task-templates
// design doc's submit_task_result "fields" contract (docs/task-templates-
// design.md, "Result contract"). Renders as a plain label/value definition
// list (key used as the label — this renderer is domain-neutral and has no
// access to a TaskDef's field labels; TaskDetailDialog's template-aware
// Outputs section is the place that resolves real labels). A malformed/empty
// payload normalizes to null so the host falls back to notes.
export function FieldsResult({ payload }: ResultRendererProps) {
  const fields = normalizeFieldsPayload(payload);
  if (!fields) return null;
  return (
    <div className="tasks__result tasks__result--fields">
      <dl className="tasks__result-fields">
        {fields.entries.map((e) => (
          <div className="tasks__result-field" key={e.key}>
            <dt className="tasks__result-field-k">{e.key}</dt>
            <dd className="tasks__result-field-v">{e.value || '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ── the renderer registry ───────────────────────────────────────────────────
// type-string → React component. To add a new result type: (1) add its name to
// KNOWN_RESULT_TYPES in taskResult.mjs, (2) add a row here mapping it to a
// component that takes { payload } and returns null when it can't render. The
// dispatcher and the fallback need no changes.
export const RESULT_RENDERERS: Record<
  string,
  ComponentType<ResultRendererProps>
> = {
  table: TableResult,
  fields: FieldsResult,
};

// ── the dispatcher ──────────────────────────────────────────────────────────
// Render the registered component for a known, well-formed result; otherwise
// return null so the caller shows today's plain notes view. Safe for any input
// shape (missing / null / non-object / unknown-type all → null).
export function TaskResultView({ result }: { result?: TaskResult | null }) {
  const kind = resultRendererKind(result);
  if (!kind) return null;
  const Renderer = RESULT_RENDERERS[kind];
  if (!Renderer) return null; // registry/known-types drift — fall back
  // `result` is non-null here (resultRendererKind guarded it).
  return <Renderer payload={(result as TaskResult).payload} />;
}

export default TaskResultView;
