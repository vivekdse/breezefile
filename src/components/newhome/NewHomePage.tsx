// task-b9cdad64ab9c — New Home: shell for the agent-work-monitor surface.
// Full-screen singleton tab (kind:'newhome'), opened by the `:new-home`
// verb (aliases `:newhome` / `:nh`). Built from scratch alongside the
// existing Home (ProjectsPage, kind:'home'/'projects') — this file must never
// import from src/components/projects/ or otherwise couple to that surface.
//
// task-b1fa5098da3e (R3) — the inline Customize dialog (per-project stored
// TemplateConfig: fields/columns/approval rules/steps/chains/repeatables) and
// the amber ApprovalBar strip are REMOVED — see docs/task-templates-design.md
// "Removed/superseded". A project carries no editable configuration anymore;
// a chain is defined inline in the canonical Task composer ("New Chained
// Task") or copied from an existing chained task, never edited via a project
// panel. Pending-question tasks still surface via the roster's "needs" bucket
// + RowAction "Answer" and the TaskDetailDialog's answer form.
//
// Layout:
//   topbar (project picker · + New Task)
//   project hero (name + subtitle)
//   HeroStats
//   filter pills (state owned here, passed down)
//   RosterTable
//   OutcomesPanel
//   conditional: TaskDetailDialog
//
// This component owns ALL cross-child state (selectedProjectId, filter,
// openTaskId) and passes it down as props.
//
// PHI: task titles/custom-field values render in-app only; never persisted
// to disk/logs (see docs/typebuild-data-field-contract.md).

import { useEffect, useMemo, useState } from 'react';
import { useNewHomeData } from './useNewHomeData';
import { compileTaskQuery, runTaskQuery } from './taskQuery';
import type { NewHomeStatus } from './types';
import { HeroStats } from './HeroStats';
import { RosterTable } from './RosterTable';
import { TaskDetailDialog } from './TaskDetailDialog';
import { OutcomesPanel } from './OutcomesPanel';
import { useTaskActions } from '../tasks/useTaskActions';
import { setNewHomeContext, clearNewHomeContext } from '../../copilot/newHomeContext';
import './NewHomePage.css';

type FilterState = 'all' | NewHomeStatus;

const FILTER_STATES: FilterState[] = ['all', 'done', 'progress', 'queued', 'needs', 'failed'];
function isFilterState(v: unknown): v is FilterState {
  return typeof v === 'string' && (FILTER_STATES as string[]).includes(v);
}

// Human-readable label per status bucket for the active-filter chip.
const FILTER_LABELS: Record<Exclude<FilterState, 'all'>, string> = {
  done: 'Done',
  progress: 'In Progress',
  queued: 'Queued',
  needs: 'Needs You',
  failed: 'Failed',
};

// Heuristic: does this input look like a STRUCTURED query (vs. plain words)?
// True when it contains a comparison operator or a DSL keyword — used to decide
// whether a compile failure is a real query error worth surfacing, or just
// free-text the user typed. (A bare "insurance" is free-text, not a typo'd
// query.)
function looksLikeQuery(s: string): boolean {
  return /[=<>~]|(^|\s)(and|or|not|in|between|glob)(\s|$)/i.test(s);
}

// Free-text roster search. Every whitespace-separated token in the query must
// appear (case-insensitive substring) somewhere in the row's searchable text:
// title, status, who, last-action text, risk, and any custom-field VALUES. This
// is in-memory only (PHI never leaves the render) — the same rule the roster
// already follows. Empty/whitespace query => no filtering.
function applySearch(tasks: import('./types').NewHomeTask[], query: string): import('./types').NewHomeTask[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return tasks;
  return tasks.filter((t) => {
    const haystack = [
      t.title,
      t.status,
      t.who,
      t.lastAction,
      t.lastActionDetail,
      t.risk ?? '',
      ...Object.values(t.customValues),
    ]
      .join(' ')
      .toLowerCase();
    return tokens.every((tok) => haystack.includes(tok));
  });
}

export function NewHomePage() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterState>('all');
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  // task-7bdb94445321 follow-up — free-text roster search, ANDed with the
  // status filter. Empty string = no text filter (status filter still applies).
  const [search, setSearch] = useState('');

  const { tasks, counts, projects, loading, refresh } =
    useNewHomeData(selectedProjectId);
  // task — the roster's ▶ Start button. Launches via the SAME mechanism the old
  // Tasks page's play button uses (useTaskActions().start → runTaskNow), then
  // refreshes the roster the SAME way onRetry does — this shell owns the action
  // + refresh so RosterTable stays presentational (mirrors the onRetry pattern).
  const actions = useTaskActions();

  function openTaskDetail(id: string) {
    setOpenTaskId(id);
  }
  function startTask(id: string) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    void actions.start(t.raw).finally(() => void refresh());
  }
  // task-ef961d60dc1b — "+ New Task" opens the CANONICAL Task form (the
  // globally-mounted TaskComposer, via fm:openTask — the same form the task
  // verb / Sidebar / copilot create_task open) AND pops the copilot chat, so
  // the human can fill it by hand or drive it conversationally — including
  // "New Chained Task" (docs/task-templates-design.md), which defines a chain
  // inline, right there, rather than through a project-level template.
  function openNewTask(kind?: 'chain') {
    setOpenTaskId(null);
    window.dispatchEvent(
      new CustomEvent('fm:openTask', {
        detail: {
          mode: 'create',
          defaultFolder: '',
          projectId: selectedProjectId ?? undefined,
          initialKind: kind,
        },
      }),
    );
    window.dispatchEvent(new CustomEvent('fm:openCopilotChat'));
  }

  // Copilot action bridge (task-ce125a047c70): set_roster_filter and
  // open_task (src/copilot/actions.tsx) can't reach this component's state
  // directly since the copilot is mounted at the app root, so they dispatch
  // window CustomEvents instead.
  useEffect(() => {
    function onFilter(e: Event) {
      const detail = (e as CustomEvent<{ filter?: string; search?: string }>).detail;
      if (detail && isFilterState(detail.filter)) setFilter(detail.filter);
      // A search string of '' explicitly clears the text filter, so honor the
      // key's PRESENCE rather than truthiness.
      if (detail && typeof detail.search === 'string') setSearch(detail.search);
    }
    function onOpenTask(e: Event) {
      const detail = (e as CustomEvent<{ taskId?: string }>).detail;
      if (detail?.taskId) openTaskDetail(detail.taskId);
    }
    // Copilot select_home_project drives the project picker (detail.projectId,
    // or null/'' for "All projects"). Same setter the <select> onChange calls.
    function onSelectProject(e: Event) {
      const id = (e as CustomEvent<{ projectId?: string | null }>).detail?.projectId;
      setSelectedProjectId(id ? id : null);
    }
    window.addEventListener('fm:newhome:filter', onFilter);
    window.addEventListener('fm:newhome:openTask', onOpenTask);
    window.addEventListener('fm:newhome:selectProject', onSelectProject);
    return () => {
      window.removeEventListener('fm:newhome:filter', onFilter);
      window.removeEventListener('fm:newhome:openTask', onOpenTask);
      window.removeEventListener('fm:newhome:selectProject', onSelectProject);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The search box is dual-mode: if the text compiles as a structured query
  // (SQL-like DSL over task fields — see taskQuery.ts) we run that; otherwise
  // it's free-text. A query-shaped-but-invalid input surfaces its parse error
  // (kind 'invalid') instead of silently matching nothing. Projects declare no
  // extra queryable fields anymore (task-b1fa5098da3e) — just the base
  // task-field catalogue.
  const queryState = useMemo(() => {
    const q = search.trim();
    if (!q) return { kind: 'none' as const };
    const c = compileTaskQuery(q, []);
    if (c.ok) return { kind: 'query' as const, compiled: c.compiled };
    if (looksLikeQuery(q)) return { kind: 'invalid' as const, error: c.error };
    return { kind: 'text' as const };
  }, [search]);

  const filteredTasks = useMemo(() => {
    const byStatus = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);
    if (queryState.kind === 'query') return runTaskQuery(byStatus, queryState.compiled, Date.now());
    if (queryState.kind === 'text') return applySearch(byStatus, search);
    // 'invalid' → don't filter (the error hint tells the user why); 'none' → all.
    return byStatus;
  }, [tasks, filter, search, queryState]);

  const selectedProject = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId) ?? null
    : null;

  const openTask = openTaskId ? tasks.find((t) => t.id === openTaskId) : undefined;

  // Publish grounding for the globally-mounted Copilot (src/copilot/
  // actions.tsx's useCopilotReadable) — titles + ids + counts only, never
  // task notes/custom field values (see newHomeContext.ts's PHI contract).
  // Cleared on unmount so the copilot doesn't keep grounding on a stale New
  // Home snapshot once the user navigates away.
  useEffect(() => {
    setNewHomeContext({
      surface: 'new-home',
      project: selectedProject ? { id: selectedProject.id, name: selectedProject.name } : null,
      availableProjects: projects.map((p) => ({ id: p.id, name: p.name })),
      counts,
      needsYou: tasks
        .filter((t) => t.status === 'needs')
        .map((t) => ({ id: t.id, title: t.title })),
      rosterFilter: { status: filter, search },
    });
  }, [selectedProject, projects, counts, tasks, filter, search]);

  useEffect(() => clearNewHomeContext, []);

  return (
    <div className="nh">
      <div className="nh__topbar">
        <div className="nh__topbar-left">
          <select
            className="nh__project-picker"
            value={selectedProjectId ?? ''}
            onChange={(e) => setSelectedProjectId(e.target.value || null)}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="nh__topbar-right">
          <button
            type="button"
            className="nh__btn"
            onClick={() => openNewTask('chain')}
            title="Create a multi-step chained task — steps, inputs, and evidence defined inline"
          >
            + New Chained Task
          </button>
          <button
            type="button"
            className="nh__btn nh__btn--primary"
            onClick={() => openNewTask()}
          >
            + New Task
          </button>
        </div>
      </div>

      <div className="nh__content">
        <div className="nh__hero">
          <div className="nh__hero-title">
            {selectedProject ? selectedProject.name : 'New Home'}
          </div>
          <div className="nh__hero-sub">
            {loading
              ? 'Loading…'
              : selectedProject
                ? selectedProject.description || 'Agent work monitor for this project'
                : 'Agent work monitor — every project, ranked by what needs you'}
          </div>
        </div>

        <HeroStats counts={counts} activeFilter={filter} onFilter={setFilter} />

        {(filter !== 'all' || search.trim()) && (
          <div className="nh-filter-chip-bar">
            <span className="nh-filter-chip-bar__label">Filtering:</span>
            {filter !== 'all' && (
              <span className="nh-filter-chip">
                <span className="nh-filter-chip__text">{FILTER_LABELS[filter]}</span>
                <button
                  type="button"
                  className="nh-filter-chip__x"
                  aria-label="Clear status filter"
                  title="Clear status filter"
                  onClick={() => setFilter('all')}
                >
                  ×
                </button>
              </span>
            )}
            {search.trim() && (
              <span
                className={
                  'nh-filter-chip' +
                  (queryState.kind === 'query' ? ' nh-filter-chip--query' : '') +
                  (queryState.kind === 'invalid' ? ' nh-filter-chip--invalid' : '')
                }
                title={
                  queryState.kind === 'invalid'
                    ? `Invalid query: ${queryState.error}`
                    : queryState.kind === 'query'
                      ? 'Structured query'
                      : 'Text search'
                }
              >
                <span className="nh-filter-chip__kind">
                  {queryState.kind === 'query' ? '⚡' : queryState.kind === 'invalid' ? '⚠' : '🔍'}
                </span>
                <span className="nh-filter-chip__text">{search.trim()}</span>
                <button
                  type="button"
                  className="nh-filter-chip__x"
                  aria-label="Clear search / query"
                  title="Clear search / query"
                  onClick={() => setSearch('')}
                >
                  ×
                </button>
              </span>
            )}
            <button
              type="button"
              className="nh-filter-chip-bar__clear-all"
              onClick={() => {
                setFilter('all');
                setSearch('');
              }}
            >
              Clear all
            </button>
          </div>
        )}

        <RosterTable
          tasks={filteredTasks}
          filter={filter}
          search={search}
          queryMode={queryState.kind}
          queryError={queryState.kind === 'invalid' ? queryState.error : undefined}
          loading={loading}
          onOpenTask={openTaskDetail}
          onFilter={setFilter}
          onSearch={setSearch}
          onRetry={startTask}
          onStart={startTask}
        />

        <OutcomesPanel
          tasks={tasks.filter((t) => t.status === 'done' || t.status === 'failed')}
          onOpenTask={openTaskDetail}
        />
      </div>

      {openTaskId && (
        <TaskDetailDialog
          taskId={openTaskId}
          task={openTask}
          tasks={tasks}
          onOpenTask={openTaskDetail}
          onClose={() => setOpenTaskId(null)}
          onResolved={() => {
            // Resolve/cancel/retry all flow through here so stats and the
            // roster row update in place from the same refreshed
            // useNewHomeData snapshot, rather than each surface tracking its
            // own optimistic patch.
            void refresh();
            setOpenTaskId(null);
          }}
        />
      )}

    </div>
  );
}
