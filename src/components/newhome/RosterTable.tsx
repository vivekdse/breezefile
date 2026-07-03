// task-cc9a4ef6f38a — RosterTable: the Project View table (spec §1) + the
// escalation layer on top of it (spec §7). Renders the tasks NewHomePage
// already scoped/filtered by project + status, with per-project custom
// columns from `template.columns`, contextual row actions, and upcoming-date
// callouts.
//
// PHI: `title`, `lastAction`, `customValues` values, and `risk` may carry
// task text — render in memory only, never persist/log (see
// docs/typebuild-data-field-contract.md).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { NewHomeStatus, NewHomeTask, TemplateConfig, TemplateField } from './types';
import { claimFreshness } from '../tasks/lifecycle.mjs';
import { evalCondition, fieldRef, metaStatus } from './taskSchema.mjs';
import { pipelineColumns } from './pipelineRoster.mjs';
import type { PipelineColumn, PipelineGroup } from './pipelineRoster.mjs';
import { usePipelineRoster } from './useNewHomeData';
import type { PipelineJobResolution } from './useNewHomeData';
import './RosterTable.css';

const FILTER_PILLS: { id: 'all' | NewHomeStatus; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs', label: 'Needs Me' },
  { id: 'progress', label: 'In Progress' },
  { id: 'queued', label: 'Queued' },
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
  queued: 'Queued',
  needs: 'Needs You',
  failed: 'Failed',
};

const UPCOMING_WINDOW_DAYS = 7;

/** task-6c62e6f0905e — tooltip for the live pulse: "Agent active · claim
 *  renewed 12m ago" when we have a claim timestamp to describe (the common
 *  case for a 'progress' row); a generic fallback when we don't (e.g. a
 *  locally-open session whose row hasn't picked up claimedAt yet). Reuses the
 *  SAME claim-freshness math the task-detail claim badge already uses
 *  (src/components/tasks/lifecycle.mjs) rather than re-deriving relative time. */
function liveTooltip(task: NewHomeTask): string {
  const fresh = claimFreshness(task.raw.claimedAt ?? null);
  return fresh ? `Agent active · claim renewed ${fresh.relative}` : 'Agent active';
}

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

// ─── pipeline table (task-a4397184def4, T5) ────────────────────────────────
// When a project's template has task-defs the roster becomes a PIPELINE table:
// one row per JOB (meta-parent), with a grouped column section per task-def
// aggregating that def's INPUT (editable) + OUTPUT (read-only) fields. See
// docs/task-templates-design.md "Roster" UX invariants. Everything below is
// dormant when template.taskDefs is empty — the roster renders exactly as
// today (NON-REGRESSION).

/** metaStatus ('done'|'active'|'pending') → the roster pill class + label the
 *  built-in status column already ships. Mirrors how TaskDetailDialog derives a
 *  step/job rollup from the SAME taskSchema helper. */
const META_PILL: Record<ReturnType<typeof metaStatus>, { cls: NewHomeStatus; label: string }> = {
  done: { cls: 'done', label: 'Done' },
  active: { cls: 'progress', label: 'In Progress' },
  pending: { cls: 'queued', label: 'Pending' },
};

function hasCellValue(v: string | number | undefined): boolean {
  return v !== undefined && v !== null && v !== '';
}

/** Inline INPUT editor — the approved-prototype dashed-input pattern. Commits
 *  on blur (text/number/date) or on change (select/bool). Stops click/keydown
 *  from bubbling so focusing/typing never opens the child or triggers row
 *  keyboard-nav. PHI: the value lives in local state only, never logged. */
function PipelineInput({
  col,
  value,
  disabled,
  onCommit,
}: {
  col: PipelineColumn;
  value: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Keep the draft in sync when the resolved value changes underneath us
  // (e.g. a lazy detail fetch lands, or another client edits the child).
  useEffect(() => setDraft(value), [value]);

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };

  if (col.type === 'select' && col.options && col.options.length > 0) {
    return (
      <select
        className="nh-pipe__input nh-pipe__input--select"
        value={draft}
        disabled={disabled}
        onClick={stop}
        onKeyDown={stop}
        onChange={(e) => {
          setDraft(e.target.value);
          onCommit(e.target.value);
        }}
      >
        <option value="">—</option>
        {col.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (col.type === 'bool') {
    return (
      <select
        className="nh-pipe__input nh-pipe__input--select"
        value={draft}
        disabled={disabled}
        onClick={stop}
        onKeyDown={stop}
        onChange={(e) => {
          setDraft(e.target.value);
          onCommit(e.target.value);
        }}
      >
        <option value="">—</option>
        <option value="Yes">Yes</option>
        <option value="No">No</option>
      </select>
    );
  }
  const inputType = col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : 'text';
  return (
    <input
      className="nh-pipe__input"
      type={inputType}
      value={draft}
      disabled={disabled}
      placeholder="—"
      onClick={stop}
      onKeyDown={(e) => {
        stop(e);
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
    />
  );
}

/** One pipeline cell. INPUT cells are editable (dashed input); OUTPUT cells are
 *  read-only. A conditional-skipped def's cells render hatched `n/a`. Clicking
 *  the cell (outside the input) opens THAT def's child task. */
function PipelineCell({
  col,
  valuesByRef,
  childId,
  skipped,
  loading,
  onOpenChild,
  onSaveInput,
}: {
  col: PipelineColumn;
  valuesByRef: Record<string, string | number>;
  childId: string | undefined;
  skipped: boolean;
  loading: boolean;
  onOpenChild: (id: string) => void;
  onSaveInput: (childId: string, key: string, value: string) => void;
}) {
  const openChild = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    if (childId) onOpenChild(childId);
  };

  if (skipped) {
    return (
      <td
        className="nh-pipe__cell nh-pipe__cell--na"
        title="Not needed for this job"
        onClick={openChild}
      >
        <span className="nh-pipe__na">n/a</span>
      </td>
    );
  }

  const value = valuesByRef[fieldRef(col.taskDefId, col.key)];
  const has = hasCellValue(value);

  if (col.io === 'out') {
    const missing = col.required && !has;
    return (
      <td
        className={`nh-pipe__cell nh-pipe__cell--out${missing ? ' nh-pipe__cell--missing' : ''}`}
        onClick={openChild}
        title={col.label}
      >
        {has ? (
          <span className="nh-pipe__val">{String(value)}</span>
        ) : (
          <span className="nh-pipe__empty">
            {loading ? '·' : '—'}
            {missing && (
              <sup className="nh-pipe__missing-mark" title="required output not yet submitted">
                *
              </sup>
            )}
          </span>
        )}
      </td>
    );
  }

  // INPUT cell — editable.
  return (
    <td className="nh-pipe__cell nh-pipe__cell--in" onClick={openChild} title={col.label}>
      <PipelineInput
        col={col}
        value={has ? String(value) : ''}
        disabled={!childId || loading}
        onCommit={(v) => {
          if (childId) onSaveInput(childId, col.key, v);
        }}
      />
    </td>
  );
}

/** One job row's pipeline cells + built-in Title/Status/LastAction/Who/Action,
 *  resolved lazily via `resolveJob`. Kept as a component so the resolution
 *  (per-job valuesByRef) recomputes only for the row it belongs to. */
function PipelineRow({
  task,
  groups,
  taskDefs,
  resolution,
  rowRef,
  onOpenTask,
  onRetry,
  onSaveInput,
}: {
  task: NewHomeTask;
  groups: PipelineGroup[];
  taskDefs: NonNullable<TemplateConfig['taskDefs']>;
  resolution: PipelineJobResolution;
  rowRef: (el: HTMLTableRowElement | null) => void;
  onOpenTask: (id: string) => void;
  onRetry: (id: string) => void;
  onSaveInput: (childId: string, key: string, value: string) => void;
}) {
  const { valuesByRef, childIdByDefId, loading } = resolution;
  const meta = META_PILL[metaStatus(taskDefs, valuesByRef)];
  const rowTint =
    task.status === 'needs'
      ? 'nh-roster__row--needs'
      : task.status === 'failed'
        ? 'nh-roster__row--failed'
        : '';
  return (
    <tr
      ref={rowRef}
      data-roster-row={task.id}
      className={rowTint}
      tabIndex={0}
      onClick={() => onOpenTask(task.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpenTask(task.id);
      }}
    >
      <td className="nh-roster__title-cell">
        <div className="nh-roster__title">{task.title}</div>
        {task.risk && (task.status === 'needs' || task.status === 'failed') && (
          <div className="nh-roster__risk">{task.risk}</div>
        )}
      </td>
      <td>
        {task.live && (
          <span className="nh-roster__live-dot" aria-hidden="true" title={liveTooltip(task)} />
        )}
        <span className={`nh-roster__pill nh-roster__pill--${meta.cls}`}>{meta.label}</span>
      </td>
      {groups.map((g) => {
        const skipped = !!g.neededWhen && !evalCondition(g.neededWhen, valuesByRef);
        const childId = childIdByDefId[g.taskDefId];
        return g.columns.map((col) => (
          <PipelineCell
            key={`${g.taskDefId}.${col.key}.${col.io}`}
            col={col}
            valuesByRef={valuesByRef}
            childId={childId}
            skipped={skipped}
            loading={loading}
            onOpenChild={onOpenTask}
            onSaveInput={onSaveInput}
          />
        ));
      })}
      <td className="nh-roster__last-action" title={task.lastActionDetail}>
        {task.lastAction}
      </td>
      <td className="nh-roster__who" title={task.who}>
        {WHO_GLYPH[task.who]}
      </td>
      <td className="nh-roster__action-cell">
        <RowAction task={task} onOpenTask={onOpenTask} onRetry={onRetry} />
      </td>
    </tr>
  );
}

export function RosterTable({
  tasks,
  filter,
  search = '',
  queryMode = 'none',
  queryError,
  template,
  onOpenTask,
  onRetry,
  onFilter,
  onSearch,
  loading,
}: {
  tasks: NewHomeTask[];
  filter: 'all' | NewHomeStatus;
  /** Free-text search query, ANDed with the status filter. NewHomePage owns
   *  the actual filtering (it pre-filters `tasks`); this component just renders
   *  the box + reflects the current value. */
  search?: string;
  /** How NewHomePage interpreted the search box: 'none' (empty), 'text'
   *  (free-text), 'query' (structured DSL matched), 'invalid' (query-shaped but
   *  didn't parse). Drives the hint under the box. */
  queryMode?: 'none' | 'text' | 'query' | 'invalid';
  /** Parse error to show when queryMode === 'invalid'. */
  queryError?: string;
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
  /** Set the free-text search query. Optional so older call sites still
   *  compile; when absent the search box is hidden. */
  onSearch?: (query: string) => void;
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

  // ── pipeline mode (task-a4397184def4, T5) ────────────────────────────────
  // Active whenever the project's template declares task-defs. In this mode the
  // roster is a PIPELINE table: one row per JOB (meta-parent), pipeline group
  // columns per task-def between Status and Last Action. When there are no
  // task-defs, everything here is inert and the classic table renders unchanged.
  const pipelineGroups = useMemo(
    () => pipelineColumns(template.taskDefs ?? []),
    [template.taskDefs],
  );
  const pipelineMode = pipelineGroups.length > 0;
  const pipelineColCount = useMemo(
    () => pipelineGroups.reduce((n, g) => n + g.columns.length, 0),
    [pipelineGroups],
  );
  // Job rows = top-level rows (no parentTaskId) from the already-filtered set;
  // a job's CHILD tasks are folded into its pipeline cells, never their own row.
  const pipelineRows = useMemo(
    () => (pipelineMode ? rows.filter((t) => !t.raw.parentTaskId) : []),
    [pipelineMode, rows],
  );
  const pipelineJobIds = useMemo(() => pipelineRows.map((t) => t.id), [pipelineRows]);
  const pipeline = usePipelineRoster({ enabled: pipelineMode, jobIds: pipelineJobIds });

  // The rows the keyboard nav and empty-state logic operate on — job rows in
  // pipeline mode, the flat task rows otherwise.
  const navRows = pipelineMode ? pipelineRows : rows;

  const hasAnyTasks = tasks.length > 0;
  const isFiltered = filter !== 'all' || !!search.trim();
  // "Clear" resets BOTH dimensions so one click always gets you back to the
  // full roster, regardless of which filter emptied it.
  const clearFilter = () => {
    onFilter?.('all');
    onSearch?.('');
  };

  // task-1af4f59428eb (Item 4) — j/k + arrow-key row navigation, SCOPED to
  // this table: the handler lives on <tbody>'s onKeyDown (React's synthetic
  // bubble phase), fires only while focus is already inside the roster (a
  // row has tabIndex=0 and DOM focus), and calls stopPropagation so the key
  // never reaches src/useKeyboard.ts's window-level listener — the SAME
  // scoping pattern BrowserSurface uses for its Chromium shortcuts
  // (`.browser-pane`'s onKeyDown, never a document/window listener). This is
  // additive: it only handles j/k/ArrowUp/ArrowDown/Enter while a <tr> has
  // focus; clicking a row (onOpenTask) and the existing per-row Enter handler
  // are untouched, so nothing that worked today changes.
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());

  const focusRow = (id: string) => {
    rowRefs.current.get(id)?.focus();
  };

  const onBodyKeyDown = (e: ReactKeyboardEvent<HTMLTableSectionElement>) => {
    // Only handle when a ROW itself has focus (not e.g. the search input or
    // a row's Answer/Retry button) — mirrors BrowserSurface's "only fires
    // when focus is inside the surface" scoping, one level tighter.
    const target = e.target as HTMLElement;
    if (!target.dataset || target.dataset.rosterRow == null) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return; // don't shadow any chord

    const ids = navRows.map((t) => t.id);
    const currentId = target.dataset.rosterRow;
    const idx = ids.indexOf(currentId);
    if (idx === -1) return;

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      const next = ids[Math.min(idx + 1, ids.length - 1)];
      focusRow(next);
      return;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const prev = ids[Math.max(idx - 1, 0)];
      focusRow(prev);
      return;
    }
    if (e.key === 'Enter') {
      // Already handled per-row below; stop it here too so a future refactor
      // that removes the per-row handler doesn't silently lose Enter-to-open.
      e.stopPropagation();
      onOpenTask(currentId);
    }
  };

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
        {onSearch && (
          <div className="nh-roster__search">
            <input
              type="search"
              className={
                'nh-roster__search-input' +
                (queryMode === 'query' ? ' nh-roster__search-input--query' : '') +
                (queryMode === 'invalid' ? ' nh-roster__search-input--invalid' : '')
              }
              placeholder="Search, or query e.g. status=needs and repeatable"
              aria-label="Search or query tasks"
              title="Type words to search, or a query like: status in (needs, failed) and due < now+7d"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
            />
            {queryMode === 'query' && (
              <span className="nh-roster__search-hint nh-roster__search-hint--query">⚡ query</span>
            )}
            {queryMode === 'invalid' && (
              <span className="nh-roster__search-hint nh-roster__search-hint--invalid" title={queryError}>
                ⚠ {queryError}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="nh-roster__table-wrap">
        {pipelineMode ? (
          <table className="nh-roster__table nh-pipe__table">
            <thead>
              <tr>
                <th rowSpan={2}>Title</th>
                <th rowSpan={2}>Status</th>
                {pipelineGroups.map((g) => (
                  <th
                    key={g.taskDefId}
                    colSpan={g.columns.length}
                    className="nh-pipe__group-th"
                    title={g.name}
                  >
                    {g.name}
                  </th>
                ))}
                <th rowSpan={2}>Last Action</th>
                <th rowSpan={2}>Who</th>
                <th rowSpan={2} className="nh-roster__th-action" />
              </tr>
              <tr>
                {pipelineGroups.flatMap((g) =>
                  g.columns.map((col) => (
                    <th
                      key={`${g.taskDefId}.${col.key}.${col.io}`}
                      className={`nh-pipe__field-th nh-pipe__field-th--${col.io}`}
                      title={`${g.name} · ${col.label} · ${col.io === 'in' ? 'input' : 'output'}${col.required ? ' · required' : ''}`}
                    >
                      <span className="nh-pipe__field-label">{col.label}</span>
                      <span className={`nh-pipe__io nh-pipe__io--${col.io}`}>
                        {col.io === 'in' ? 'IN' : 'OUT'}
                      </span>
                      {col.required && <span className="nh-pipe__req">REQ</span>}
                    </th>
                  )),
                )}
              </tr>
            </thead>
            <tbody onKeyDown={onBodyKeyDown}>
              {loading && !hasAnyTasks && (
                <>
                  {[0, 1, 2].map((i) => (
                    <tr key={`skeleton-${i}`} className="nh-roster__row--skeleton" aria-hidden="true">
                      <td colSpan={5 + pipelineColCount}>
                        <div className="nh-roster__skeleton-bar" />
                      </td>
                    </tr>
                  ))}
                </>
              )}
              {!loading && !hasAnyTasks && !isFiltered && (
                <tr>
                  <td colSpan={5 + pipelineColCount} className="nh-roster__empty">
                    No jobs yet for this project.
                  </td>
                </tr>
              )}
              {!loading && pipelineRows.length === 0 && (hasAnyTasks || isFiltered) && (
                <tr>
                  <td colSpan={5 + pipelineColCount} className="nh-roster__empty">
                    No jobs match {search.trim() ? <>“{search.trim()}”</> : 'this filter'}.{' '}
                    {isFiltered && (
                      <button type="button" className="nh-roster__clear-filter" onClick={clearFilter}>
                        Clear filter
                      </button>
                    )}
                  </td>
                </tr>
              )}
              {pipelineRows.map((t) => (
                <PipelineRow
                  key={t.id}
                  task={t}
                  groups={pipelineGroups}
                  taskDefs={template.taskDefs ?? []}
                  resolution={pipeline.resolveJob(t.id)}
                  rowRef={(el) => {
                    if (el) rowRefs.current.set(t.id, el);
                    else rowRefs.current.delete(t.id);
                  }}
                  onOpenTask={onOpenTask}
                  onRetry={onRetry}
                  onSaveInput={(childId, key, value) => {
                    void pipeline.saveInput(childId, key, value);
                  }}
                />
              ))}
            </tbody>
          </table>
        ) : (
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
          <tbody onKeyDown={onBodyKeyDown}>
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
            {!loading && !hasAnyTasks && !isFiltered && (
              <tr>
                <td colSpan={5 + customColumns.length} className="nh-roster__empty">
                  No tasks yet for this project.
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && isFiltered && (
              <tr>
                <td colSpan={5 + customColumns.length} className="nh-roster__empty">
                  No tasks match {search.trim() ? <>“{search.trim()}”</> : 'this filter'}.{' '}
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
                  ref={(el) => {
                    if (el) rowRefs.current.set(t.id, el);
                    else rowRefs.current.delete(t.id);
                  }}
                  data-roster-row={t.id}
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
                    {t.live && (
                      <span
                        className="nh-roster__live-dot"
                        aria-hidden="true"
                        title={liveTooltip(t)}
                      />
                    )}
                    <span className={`nh-roster__pill nh-roster__pill--${t.status}`}>
                      {STATUS_LABEL[t.status]}
                    </span>
                  </td>
                  {customColumns.map((f) => (
                    <CustomCell key={f.key} task={t} field={f} now={now} />
                  ))}
                  <td className="nh-roster__last-action" title={t.lastActionDetail}>
                    {t.lastAction}
                  </td>
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
        )}
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
