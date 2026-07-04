// task-83a30b3c8804 — OutcomesPanel: the finished-work rollup (spec §1's
// "one place to understand what every task produced"). Renders ONLY tasks
// NewHomePage has already filtered to done/failed, grouped into two
// collapsible sections. Each row's one-line outcome summary reuses the same
// result-extraction TaskDetailDialog uses — task.raw.result (structured,
// via normalizeTablePayload) with a fallback to task.lastAction — so the two
// surfaces never drift on "what counts as the outcome".
//
// The panel disappears entirely when there is nothing finished yet (spec:
// "hide panel entirely when no done/failed tasks") rather than rendering an
// empty-state shell.
//
// PHI: title / lastAction / result payload values may carry task content —
// render in memory only, never persist/log (docs/typebuild-data-field-contract.md).

import { useMemo, useState } from 'react';
import type { NewHomeTask } from './types';
import { normalizeTablePayload, coerceCell } from '../tasks/taskResult.mjs';
import { resultFields } from './taskSchema.mjs';
import './OutcomesPanel.css';

const WHO_GLYPH: Record<NewHomeTask['who'], string> = {
  agent: '\u{1F916}', // 🤖
  human: '\u{1F464}', // 👤
  both: '\u{1F916}+\u{1F464}', // 🤖+👤
};

const GROUP_LABEL: Record<'done' | 'failed', string> = {
  done: 'Done',
  failed: 'Failed',
};

/** One-line best-effort outcome summary: prefer a structured `table` result
 *  (first row's cells, joined), fall back to the task's last-action text,
 *  and finally a generic placeholder. Mirrors TaskDetailDialog's outcome
 *  section (TaskResultView / task.raw.result, fallback to lastAction) but
 *  collapsed to a single line for the rollup row. */
function summarizeOutcome(task: NewHomeTask): string {
  const result = task.raw?.result;
  if (result && typeof result === 'object' && (result as { type?: unknown }).type === 'table') {
    const table = normalizeTablePayload((result as { payload?: unknown }).payload);
    if (table) {
      const firstRow = table.rows[0];
      if (firstRow && firstRow.length > 0) {
        return firstRow.map((c) => coerceCell(c)).filter(Boolean).join(' · ');
      }
      if (table.headers.length > 0) {
        return table.headers.join(' · ');
      }
    }
  }
  // task-ce4b4c8ca955 — a `{type:'fields'}` result (single-task output fields
  // OR a chained task-def's outputs) previously fell straight through to
  // lastAction, leaving the one-liner blank/generic even for a DONE task with
  // real output values. resultFields already accepts BOTH the canonical FLAT
  // `{k:v}` payload and the LEGACY NESTED `{taskDefId,fields:{k:v}}` shape
  // (task-2638eeedd9ef) — reuse it rather than re-parsing here. Prefer the
  // server's output_schema label for a key when present (task-ce4b4c8ca955
  // wire threading); fall back to the raw key so an unlabeled/legacy field
  // still renders something readable.
  const fields = resultFields(result ?? null);
  if (fields && Object.keys(fields.fields).length > 0) {
    const labelByKey = new Map((task.raw?.outputSchema ?? []).map((f) => [f.key, f.label]));
    return Object.entries(fields.fields)
      .map(([k, v]) => `${labelByKey.get(k) ?? k}=${String(v)}`)
      .join(' · ');
  }
  return task.lastAction || 'No summary available';
}

function OutcomeGroup({
  status,
  tasks,
  onOpenTask,
}: {
  status: 'done' | 'failed';
  tasks: NewHomeTask[];
  onOpenTask: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  if (tasks.length === 0) return null;

  return (
    <div className="nh-outcomes__group">
      <button
        type="button"
        className="nh-outcomes__group-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`nh-outcomes__chevron${expanded ? ' nh-outcomes__chevron--open' : ''}`} aria-hidden="true">
          ▸
        </span>
        <span className={`nh-outcomes__group-title nh-outcomes__group-title--${status}`}>
          {GROUP_LABEL[status]}
        </span>
        <span className="nh-outcomes__group-count">{tasks.length}</span>
      </button>

      {expanded && (
        <ul className="nh-outcomes__list">
          {tasks.map((t) => (
            <li key={t.id}>
              <button type="button" className="nh-outcomes__row" onClick={() => onOpenTask(t.id)}>
                <span className={`nh-outcomes__pill nh-outcomes__pill--${t.status}`}>{GROUP_LABEL[status]}</span>
                <span className="nh-outcomes__row-title">{t.title}</span>
                <span className="nh-outcomes__summary">{summarizeOutcome(t)}</span>
                <span className="nh-outcomes__who" title={t.who}>
                  {WHO_GLYPH[t.who]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function OutcomesPanel({
  tasks,
  onOpenTask,
}: {
  tasks: NewHomeTask[];
  onOpenTask: (id: string) => void;
}) {
  const done = useMemo(
    () => tasks.filter((t): t is NewHomeTask & { status: 'done' } => t.status === 'done'),
    [tasks],
  );
  const failed = useMemo(
    () => tasks.filter((t): t is NewHomeTask & { status: 'failed' } => t.status === 'failed'),
    [tasks],
  );

  // Hide entirely when there's nothing finished yet — no empty-state shell.
  if (done.length === 0 && failed.length === 0) return null;

  return (
    <div className="nh-outcomes">
      <div className="nh-outcomes__title">Outcomes</div>
      <OutcomeGroup status="failed" tasks={failed} onOpenTask={onOpenTask} />
      <OutcomeGroup status="done" tasks={done} onOpenTask={onOpenTask} />
    </div>
  );
}
