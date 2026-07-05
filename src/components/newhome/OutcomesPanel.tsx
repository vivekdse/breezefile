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

import { useEffect, useMemo, useState } from 'react';
import type { Task } from '../../types';
import type { NewHomeTask } from './types';
import { getTask } from '../../tasks';
import { normalizeTablePayload, coerceCell } from '../tasks/taskResult.mjs';
import { resultFields } from './taskSchema.mjs';
import { fieldedSchemaSource } from './pipelineRoster.mjs';
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
 *  collapsed to a single line for the rollup row.
 *
 * @param detailTask task-6b1136a8ff77 — the FETCHED detail for this row, when
 *  available (mapListRow/mapListJob never populates `outputSchema` on the
 *  list row — see fieldedSchemaSource's doc comment / task-ce4b4c8ca955
 *  round-18). Reading `task.raw.outputSchema` alone reproduces that same
 *  blank-out bug for a server-schema'd fielded task; combine both sources via
 *  fieldedSchemaSource, exactly like TaskDetailDrawer's resolvedOutputSchema. */
function summarizeOutcome(task: NewHomeTask, detailTask: Task | null | undefined): string {
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
    const schema = fieldedSchemaSource(
      { outputSchema: detailTask?.outputSchema },
      { outputSchema: task.raw?.outputSchema },
    );
    const labelByKey = new Map((schema ?? []).map((f) => [f.key, f.label]));
    return Object.entries(fields.fields)
      .map(([k, v]) => `${labelByKey.get(k) ?? k}=${String(v)}`)
      .join(' · ');
  }
  return task.lastAction || 'No summary available';
}

function OutcomeGroup({
  status,
  tasks,
  detailById,
  onOpenTask,
}: {
  status: 'done' | 'failed';
  tasks: NewHomeTask[];
  detailById: Map<string, Task>;
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
                <span className="nh-outcomes__summary">{summarizeOutcome(t, detailById.get(t.id))}</span>
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

  // task-6b1136a8ff77 — DETAIL for every finished row (getTask): the list row
  // (task.raw) never carries `outputSchema` (mapListRow gap — see
  // fieldedSchemaSource's doc comment), so a server-schema'd fielded task's
  // one-liner would render blank/key-only without this. Same lazy/cached
  // fetch-and-merge pattern TaskMatrix uses for its per-child detail map.
  const idKey = useMemo(
    () => [...done, ...failed].map((t) => t.id).sort().join(','),
    [done, failed],
  );
  const [detailById, setDetailById] = useState<Map<string, Task>>(new Map());
  useEffect(() => {
    let cancelled = false;
    const ids = idKey ? idKey.split(',') : [];
    const missing = ids.filter((id) => !detailById.has(id));
    if (missing.length === 0) return;
    void (async () => {
      const fetched: [string, Task][] = [];
      for (const id of missing) {
        try {
          const t = await getTask(id);
          if (t) fetched.push([id, t]);
        } catch {
          // Offline / no access — leave undetailed; summary falls back to the list row.
        }
      }
      if (cancelled || fetched.length === 0) return;
      setDetailById((prev) => {
        const next = new Map(prev);
        for (const [id, t] of fetched) next.set(id, t);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // idKey encodes the finished-task id set; re-run only when it moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey]);

  // Hide entirely when there's nothing finished yet — no empty-state shell.
  if (done.length === 0 && failed.length === 0) return null;

  return (
    <div className="nh-outcomes">
      <div className="nh-outcomes__title">Outcomes</div>
      <OutcomeGroup status="failed" tasks={failed} detailById={detailById} onOpenTask={onOpenTask} />
      <OutcomeGroup status="done" tasks={done} detailById={detailById} onOpenTask={onOpenTask} />
    </div>
  );
}
