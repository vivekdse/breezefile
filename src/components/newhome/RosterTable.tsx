// task-cc9a4ef6f38a — RosterTable: the Project View table (spec §1) + the
// escalation layer on top of it (spec §7). Renders the tasks NewHomePage
// already scoped/filtered by project + status, with per-project custom
// columns from `template.columns`, contextual row actions, and upcoming-date
// callouts.
//
// PHI: `title`, `lastAction`, `customValues` values, and `risk` may carry
// task text — render in memory only, never persist/log (see
// docs/typebuild-data-field-contract.md).
import { useMemo } from 'react';
import type { NewHomeStatus, NewHomeTask, TemplateConfig, TemplateField } from './types';
import './RosterTable.css';

const FILTER_PILLS: { id: 'all' | NewHomeStatus; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs', label: 'Needs Me' },
  { id: 'progress', label: 'In Progress' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' },
];

const WHO_GLYPH: Record<NewHomeTask['who'], string> = {
  agent: '\u{1F916}', // 🤖
  human: '\u{1F464}', // 👤
  both: '\u{1F916}+\u{1F464}', // 🤖+👤
};

const STATUS_LABEL: Record<NewHomeStatus, string> = {
  done: 'Done',
  progress: 'In Progress',
  needs: 'Needs You',
  failed: 'Failed',
};

const UPCOMING_WINDOW_DAYS = 7;

/** Best-effort date parse for a template field value — accepts anything
 *  `Date` can parse (ISO, "Aug 2027", "2026-07-09", ...). Returns null when
 *  unparseable so callers can skip the badge rather than mis-render. */
function tryParseDate(value: string | undefined): Date | null {
  if (!value || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysUntil(d: Date, now: number): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.ceil((d.getTime() - now) / MS_PER_DAY);
}

type UpcomingDate = { taskId: string; taskTitle: string; fieldLabel: string; days: number };

function findUpcomingDates(
  tasks: NewHomeTask[],
  dateFields: TemplateField[],
  now: number,
): UpcomingDate[] {
  const out: UpcomingDate[] = [];
  for (const t of tasks) {
    for (const f of dateFields) {
      const raw = t.customValues[f.key];
      const parsed = tryParseDate(raw);
      if (!parsed) continue;
      const days = daysUntil(parsed, now);
      if (days >= 0 && days <= UPCOMING_WINDOW_DAYS) {
        out.push({ taskId: t.id, taskTitle: t.title, fieldLabel: f.label, days });
      }
    }
  }
  return out.sort((a, b) => a.days - b.days);
}

/** Renders one custom-field/built-in cell value for a column id. Built-in
 *  column ids (title/status/who/lastAction) are handled separately in the
 *  row render below — this only covers template.columns entries that match a
 *  TemplateField.key. */
function CustomCell({
  task,
  field,
  now,
}: {
  task: NewHomeTask;
  field: TemplateField;
  now: number;
}) {
  const value = task.customValues[field.key];
  const parsed = field.type === 'date' ? tryParseDate(value) : null;
  const days = parsed ? daysUntil(parsed, now) : null;
  const isUpcoming = days !== null && days >= 0 && days <= UPCOMING_WINDOW_DAYS;
  return (
    <td className="nh-roster__cell">
      <span>{value ?? '—'}</span>
      {isUpcoming && (
        <span className="nh-roster__badge" title={`${days} day${days === 1 ? '' : 's'} remaining`}>
          {'⚠'}
        </span>
      )}
    </td>
  );
}

function RowAction({
  task,
  onOpenTask,
  onRetry,
}: {
  task: NewHomeTask;
  onOpenTask: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  if (task.status === 'needs') {
    return (
      <button
        type="button"
        className="nh-roster__action nh-roster__action--answer"
        onClick={(e) => {
          e.stopPropagation();
          onOpenTask(task.id);
        }}
      >
        Answer
      </button>
    );
  }
  if (task.status === 'failed') {
    return (
      <button
        type="button"
        className="nh-roster__action nh-roster__action--retry"
        onClick={(e) => {
          e.stopPropagation();
          onRetry(task.id);
        }}
      >
        Retry
      </button>
    );
  }
  return <span className="nh-roster__action-empty">{'—'}</span>;
}

export function RosterTable({
  tasks,
  filter,
  template,
  onOpenTask,
  onRetry,
  onFilter,
  loading,
}: {
  tasks: NewHomeTask[];
  filter: 'all' | NewHomeStatus;
  template: TemplateConfig;
  onOpenTask: (id: string) => void;
  onRetry: (id: string) => void;
  /** Optional — NewHomePage today drives filtering via HeroStats cards and
   *  pre-filters `tasks` before passing them down, so this pill bar is not
   *  yet wired to a live callback from the shell. Kept optional so this
   *  component still compiles/renders correctly against the current
   *  NewHomePage call site; wire this up from NewHomePage in a follow-up so
   *  the pills become the second, always-visible way to change `filter`
   *  (matching the V11 reference's toolbar). Until then the pills reflect
   *  the current `filter` and are a no-op if clicked without a handler. */
  onFilter?: (f: 'all' | NewHomeStatus) => void;
  /** Optional — NewHomePage doesn't thread its `loading` flag down to this
   *  component yet; wire it in a follow-up so the table can show a skeleton
   *  during the initial fetch instead of a bare "No tasks" flash. */
  loading?: boolean;
}) {
  const now = Date.now();

  const fieldByKey = useMemo(() => {
    const m = new Map<string, TemplateField>();
    for (const f of template.fields) m.set(f.key, f);
    return m;
  }, [template.fields]);

  const dateFields = useMemo(
    () => template.fields.filter((f) => f.type === 'date'),
    [template.fields],
  );

  // Defensive: filter locally too, in case a future caller passes an
  // unfiltered `tasks` array alongside a real `filter` value.
  const rows = useMemo(
    () => (filter === 'all' ? tasks : tasks.filter((t) => t.status === filter)),
    [tasks, filter],
  );

  const upcoming = useMemo(() => findUpcomingDates(rows, dateFields, now), [rows, dateFields, now]);

  // template.columns may reference built-in ids or custom field keys; split
  // out the custom ones (anything not a recognized built-in) to render after
  // the fixed Title/Status columns and before Last Action/Who/Action.
  const BUILT_IN = new Set(['title', 'status', 'who', 'lastAction']);
  const customColumns = template.columns
    .filter((c) => !BUILT_IN.has(c))
    .map((c) => fieldByKey.get(c))
    .filter((f): f is TemplateField => !!f);

  const hasAnyTasks = tasks.length > 0;
  const clearFilter = () => onFilter?.('all');

  return (
    <div className="nh-roster">
      <div className="nh-roster__toolbar">
        <div className="nh-roster__pills" role="tablist" aria-label="Filter tasks by status">
          {FILTER_PILLS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={filter === p.id}
              className={`nh-roster__pill-btn${filter === p.id ? ' nh-roster__pill-btn--active' : ''}`}
              onClick={() => onFilter?.(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="nh-roster__table-wrap">
        <table className="nh-roster__table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              {customColumns.map((f) => (
                <th key={f.key}>{f.label}</th>
              ))}
              <th>Last Action</th>
              <th>Who</th>
              <th className="nh-roster__th-action" />
            </tr>
          </thead>
          <tbody>
            {loading && !hasAnyTasks && (
              <>
                {[0, 1, 2].map((i) => (
                  <tr key={`skeleton-${i}`} className="nh-roster__row--skeleton" aria-hidden="true">
                    <td colSpan={5 + customColumns.length}>
                      <div className="nh-roster__skeleton-bar" />
                    </td>
                  </tr>
                ))}
              </>
            )}
            {!loading && !hasAnyTasks && (
              <tr>
                <td colSpan={5 + customColumns.length} className="nh-roster__empty">
                  No tasks yet for this project.
                </td>
              </tr>
            )}
            {hasAnyTasks && rows.length === 0 && (
              <tr>
                <td colSpan={5 + customColumns.length} className="nh-roster__empty">
                  No tasks match this filter.{' '}
                  <button type="button" className="nh-roster__clear-filter" onClick={clearFilter}>
                    Clear filter
                  </button>
                </td>
              </tr>
            )}
            {rows.map((t) => {
              const rowTint =
                t.status === 'needs'
                  ? 'nh-roster__row--needs'
                  : t.status === 'failed'
                    ? 'nh-roster__row--failed'
                    : '';
              return (
                <tr
                  key={t.id}
                  className={rowTint}
                  tabIndex={0}
                  onClick={() => onOpenTask(t.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onOpenTask(t.id);
                  }}
                >
                  <td className="nh-roster__title-cell">
                    <div className="nh-roster__title">{t.title}</div>
                    {t.risk && (t.status === 'needs' || t.status === 'failed') && (
                      <div className="nh-roster__risk">{t.risk}</div>
                    )}
                  </td>
                  <td>
                    <span className={`nh-roster__pill nh-roster__pill--${t.status}`}>
                      {STATUS_LABEL[t.status]}
                    </span>
                  </td>
                  {customColumns.map((f) => (
                    <CustomCell key={f.key} task={t} field={f} now={now} />
                  ))}
                  <td className="nh-roster__last-action">{t.lastAction}</td>
                  <td className="nh-roster__who" title={t.who}>
                    {WHO_GLYPH[t.who]}
                  </td>
                  <td className="nh-roster__action-cell">
                    <RowAction task={t} onOpenTask={onOpenTask} onRetry={onRetry} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {upcoming.length > 0 && (
        <div className="nh-roster__footnote">
          {upcoming.map((u) => (
            <div key={`${u.taskId}-${u.fieldLabel}`} className="nh-roster__footnote-row">
              <span className="nh-roster__badge">{'⚠'}</span>
              <span className="nh-roster__footnote-title">{u.taskTitle}</span>
              <span className="nh-roster__footnote-field">{u.fieldLabel}</span>
              <span className="nh-roster__footnote-days">
                {u.days === 0 ? 'due today' : `${u.days} day${u.days === 1 ? '' : 's'} remaining`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
