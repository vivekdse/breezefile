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
import { ProjectDialog } from './ProjectDialog';
import { useTaskActions } from '../tasks/useTaskActions';
import type { StartOutcome } from '../tasks/useTaskActions';
import { setNewHomeContext, clearNewHomeContext } from '../../copilot/newHomeContext';
import { fm } from '../../bridge';
import type { Project } from '../../types';
import { buildProjectTree } from '../../projects/index.mjs';
import { nextSelectionAfterArchive, nextSelectionAfterDelete, projectDeleteDecision } from './projectCrud.mjs';
import {
  loadSelectedProjectId,
  saveSelectedProjectId,
  isStaleProjectSelection,
  // Explicit `.ts` extension: a sibling `selectedProjectPrefs.mjs` (pure
  // helpers only) shadows this wrapper on Vite/esbuild's extensionless
  // resolution, so an unqualified import loads the .mjs — which lacks
  // load/save and blanks the whole app at runtime. Same discipline as the
  // fileTypes.ts / launcherPrefs.ts imports elsewhere.
} from './selectedProjectPrefs.ts';
import './NewHomePage.css';

// task-69651204e222 — CONVERGENCE FLAG. When true, New Home's task-open path
// routes to the app-wide unified TaskDetailDrawer (via the fm:openTaskDetail
// event App.tsx listens on) instead of this surface's own TaskDetailDialog.
// The dialog stays MOUNTED behind this flag; flip this to `false` to restore
// the old dialog for one release if the drawer regresses. Remove the dialog
// (and this flag) only after the drawer has proven out.
const USE_UNIFIED_DETAIL = true;

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
  // task-fd5b93809b1b — seed from the persisted pick rather than always
  // starting at null: the "+ New Task" / edit-and-save path swaps this whole
  // component out for the TaskComposer in App.tsx and remounts it on close,
  // so plain useState(null) reset the project picker to "All projects" every
  // time. Every setter call below is mirrored to storage (see the effect)
  // so the NEXT mount (post-save) rehydrates the same selection instead of
  // losing it.
  const [selectedProjectId, setSelectedProjectIdState] = useState<string | null>(
    () => loadSelectedProjectId(),
  );
  function setSelectedProjectId(id: string | null) {
    setSelectedProjectIdState(id);
    saveSelectedProjectId(id);
  }
  const [filter, setFilter] = useState<FilterState>('all');
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  // task-7bdb94445321 follow-up — free-text roster search, ANDed with the
  // status filter. Empty string = no text filter (status filter still applies).
  const [search, setSearch] = useState('');

  // task-a9841cfc0e1b (spec §3) — "Show archived" reveals archived projects
  // in the picker (with an Unarchive action) so an archive is recoverable
  // from the same surface, not a one-way door into a settings page.
  const [showArchived, setShowArchived] = useState(false);
  const { tasks, counts, projects, loading, refresh, refreshProjects } = useNewHomeData(
    selectedProjectId,
    { includeArchived: showArchived },
  );
  // task-a9841cfc0e1b — project CRUD UI state: which dialog (create vs edit)
  // is open, if any. Edit passes the project being edited; create passes
  // `undefined` (ProjectDialog's own isEdit check).
  const [projectDialog, setProjectDialog] = useState<
    { mode: 'create' } | { mode: 'edit'; project: Project } | null
  >(null);
  const [projectActionError, setProjectActionError] = useState<string | null>(null);
  const [projectActionBusy, setProjectActionBusy] = useState(false);
  // Nesting (spec §4): a project's indent in the picker reflects its depth in
  // the parent/child forest — the SAME pure, tested tree builder the
  // Projects attention rollup uses (src/projects/tree.mjs), not a re-derived
  // heuristic.
  const projectTree = useMemo(() => buildProjectTree(projects), [projects]);
  const flatProjectOptions = useMemo(() => {
    const out: { project: Project; depth: number }[] = [];
    const walk = (nodes: ReturnType<typeof buildProjectTree>) => {
      for (const n of nodes) {
        out.push({ project: n.project, depth: n.depth });
        walk(n.children);
      }
    };
    walk(projectTree);
    return out;
  }, [projectTree]);
  // task — the roster's ▶ Start button. Launches via the SAME mechanism the old
  // Tasks page's play button uses (useTaskActions().start → runTaskNow), then
  // refreshes the roster the SAME way onRetry does — this shell owns the action
  // + refresh so RosterTable stays presentational (mirrors the onRetry pattern).
  const actions = useTaskActions();

  // task-69651204e222 — the ONE open path all four New-Home sources funnel
  // through (RosterTable rows, OutcomesPanel, the copilot open_task listener,
  // and the Pipeline child jumps). When USE_UNIFIED_DETAIL is on it resolves
  // the underlying Task from the current roster snapshot and dispatches the
  // app-wide fm:openTaskDetail event (App.tsx → TaskDetailDrawer) — matching
  // the payload shape App.tsx expects: { task, roster, onOpenTask }. When off
  // it falls back to the old local dialog (setOpenTaskId).
  function openTaskDetail(id: string) {
    if (USE_UNIFIED_DETAIL) {
      const t = tasks.find((x) => x.id === id);
      if (!t) return;
      window.dispatchEvent(
        new CustomEvent('fm:openTaskDetail', {
          detail: {
            task: t.raw,
            // The full roster (as raw Tasks) so the drawer's Pipeline rollup
            // can resolve a meta-parent's children; onOpenTask re-enters this
            // same path so a child jump reopens the drawer on that child.
            roster: tasks.map((x) => x.raw),
            onOpenTask: openTaskDetail,
          },
        }),
      );
      return;
    }
    setOpenTaskId(id);
  }
  // task-c141c7765aa4 — returns the StartOutcome (never throws) so callers
  // that need to KNOW whether a session actually spawned (auto-continue) can
  // react; the manual ▶ Start / Retry callers ignore the resolved value
  // exactly as before (actions.start already surfaces failures via the
  // status line, and now also releases an orphaned claim on launch failure).
  async function startTask(id: string): Promise<StartOutcome> {
    const t = tasks.find((x) => x.id === id);
    if (!t) return { ok: false, spawned: false, message: 'task not found', released: false };
    try {
      return await actions.start(t.raw);
    } finally {
      void refresh();
    }
  }
  // task-ef961d60dc1b — "+ New Task" opens the CANONICAL Task form (the
  // globally-mounted TaskComposer, via fm:openTask — the same form the task
  // verb / Sidebar / copilot create_task open) AND pops the copilot chat, so
  // the human can fill it by hand or drive it conversationally — including
  // "New Chained Task" (docs/task-templates-design.md), which defines a chain
  // inline, right there, rather than through a project-level template.
  function openNewTask(kind?: 'chain' | 'template') {
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

  // task-a9841cfc0e1b — project CRUD. ProjectDialog performs the actual
  // create/patch/folder mutations itself (via fm.typebuild.projects.*, the
  // SAME bridge the copilot actions call); this callback just refreshes the
  // registry so the picker/hero update IN PLACE, and — for a fresh create —
  // selects the new project. Editing an already-selected project keeps the
  // selection untouched (same project, new fields).
  function onProjectSaved(project: Project, wasCreate: boolean) {
    void refreshProjects();
    if (wasCreate) setSelectedProjectId(project.id);
  }

  async function archiveSelectedProject() {
    if (!selectedProject) return;
    setProjectActionBusy(true);
    setProjectActionError(null);
    try {
      await fm.typebuild.projects.archive(selectedProject.id);
      await refreshProjects();
      // task-fd5b93809b1b — never let a CRUD op silently reset an UNRELATED
      // selection; only fall back to "All projects" when the archived
      // project WAS the current selection.
      setSelectedProjectId(nextSelectionAfterArchive(selectedProjectId, selectedProject.id));
    } catch (e) {
      setProjectActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjectActionBusy(false);
    }
  }

  async function unarchiveProject(id: string) {
    setProjectActionBusy(true);
    setProjectActionError(null);
    try {
      await fm.typebuild.projects.unarchive(id);
      await refreshProjects();
    } catch (e) {
      setProjectActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjectActionBusy(false);
    }
  }

  // Delete only ever runs for an EMPTY project (see projectDeleteDecision) —
  // the affordance that calls this checks the roster count first and offers
  // archive instead when the project has tasks. The server also enforces
  // this (a 409 { reason:'has_tasks' } surfaces here as a message rather than
  // a silent no-op) so a stale client-side count can't force a bad delete.
  async function deleteSelectedProject() {
    if (!selectedProject) return;
    setProjectActionBusy(true);
    setProjectActionError(null);
    try {
      const res = await fm.typebuild.projects.delete(selectedProject.id);
      if (!res.ok) {
        setProjectActionError(
          res.reason === 'has_tasks'
            ? 'This project still has tasks — archive it instead of deleting.'
            : res.reason === 'not_owner'
              ? "You don't own this project."
              : `Failed: ${res.reason}`,
        );
        return;
      }
      await refreshProjects();
      setSelectedProjectId(nextSelectionAfterDelete(selectedProjectId, selectedProject.id));
    } catch (e) {
      setProjectActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjectActionBusy(false);
    }
  }

  function confirmArchive() {
    if (!selectedProject) return;
    window.dispatchEvent(
      new CustomEvent('fm:confirm', {
        detail: {
          title: `Archive ${selectedProject.name}?`,
          body: 'Archived projects are hidden from the picker. You can unarchive them later from "Show archived".',
          confirmLabel: 'Archive',
          destructive: false,
          onConfirm: () => void archiveSelectedProject(),
        },
      }),
    );
  }

  function confirmDelete() {
    if (!selectedProject) return;
    const ownTaskCount = tasks.filter((t) => t.projectId === selectedProject.id).length;
    const decision = projectDeleteDecision(ownTaskCount);
    if (!decision.canDelete) {
      window.dispatchEvent(
        new CustomEvent('fm:confirm', {
          detail: {
            title: `${selectedProject.name} has tasks`,
            body: 'A project with tasks can only be archived, not deleted. Archive it instead?',
            confirmLabel: 'Archive instead',
            destructive: false,
            onConfirm: () => void archiveSelectedProject(),
          },
        }),
      );
      return;
    }
    window.dispatchEvent(
      new CustomEvent('fm:confirm', {
        detail: {
          title: `Delete ${selectedProject.name}?`,
          body: 'This project has no tasks and will be permanently deleted. This cannot be undone.',
          confirmLabel: 'Delete',
          destructive: true,
          onConfirm: () => void deleteSelectedProject(),
        },
      }),
    );
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

  // task-fd5b93809b1b — a persisted selection can outlive the project it
  // points at (deleted/archived elsewhere, or a stale value from another
  // machine). Once the registry has actually loaded, fall back to "All
  // projects" rather than silently wedging the roster on a filter that can
  // never match. isStaleProjectSelection treats an empty `projects` as
  // "not yet loaded" (never stale), so this never fires against the initial
  // pre-fetch render.
  useEffect(() => {
    if (isStaleProjectSelection(selectedProjectId, projects)) {
      setSelectedProjectId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, projects]);

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
      // task-a9841cfc0e1b — archived projects can be included in `projects`
      // when "Show archived" is on; keep the copilot's grounding scoped to
      // non-archived ones (matching its docstring: "the FULL list the picker
      // offers"'s intent — a project a human hid shouldn't casually surface
      // as a copilot select_home_project/update_project/etc. target).
      availableProjects: projects.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name })),
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
            {/* task-a9841cfc0e1b (spec §4) — indent reflects each project's
                depth in the parent/child forest (buildProjectTree), so
                nesting is visible right in the picker without a separate
                breadcrumb UI. Non-breaking-space repeated per depth level
                keeps the indent inside a <select>'s plain-text options. */}
            {flatProjectOptions.map(({ project: p, depth }) => (
              <option key={p.id} value={p.id}>
                {'  '.repeat(depth)}
                {depth > 0 ? '↳ ' : ''}
                {p.name}
                {p.archived ? ' (archived)' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="nh__btn"
            onClick={() => setProjectDialog({ mode: 'create' })}
            title="Create a new project — a named category for tasks"
          >
            + New project
          </button>
          <label className="nh__show-archived">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
          {showArchived && selectedProject?.archived && (
            <button
              type="button"
              className="nh__btn"
              onClick={() => void unarchiveProject(selectedProject.id)}
              disabled={projectActionBusy}
            >
              Unarchive
            </button>
          )}
        </div>
        <div className="nh__topbar-right">
          <button
            type="button"
            className="nh__btn"
            onClick={() => openNewTask('template')}
            title="Pick a prior fielded task or chain and fill just its input values — everything else (project, notes, output schema, agent) is inherited"
          >
            + New from Template
          </button>
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
          <div>
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
            {selectedProject?.instructions && (
              <div className="nh__hero-instructions" title="Agent instructions">
                <span className="nh__hero-instructions-label">Agent instructions:</span>{' '}
                {selectedProject.instructions}
              </div>
            )}
          </div>
          {/* task-a9841cfc0e1b (spec §2/§3) — edit/archive/delete live on the
              selected project's hero, not a separate settings page: rename,
              edit description/instructions/folders, or archive/delete it,
              all without leaving New Home. */}
          {selectedProject && (
            <div className="nh__hero-actions">
              <button
                type="button"
                className="nh__btn"
                onClick={() => setProjectDialog({ mode: 'edit', project: selectedProject })}
                disabled={projectActionBusy}
              >
                Edit
              </button>
              <button
                type="button"
                className="nh__btn"
                onClick={confirmArchive}
                disabled={projectActionBusy}
                title="Hide this project from the picker (reversible)"
              >
                Archive
              </button>
              <button
                type="button"
                className="nh__btn nh__btn--danger"
                onClick={confirmDelete}
                disabled={projectActionBusy}
                title="Permanently delete this project (only if it has no tasks)"
              >
                Delete
              </button>
            </div>
          )}
        </div>

        {projectActionError && (
          <div className="nh__project-action-error">
            {projectActionError}
            <button
              type="button"
              className="nh-filter-chip__x"
              aria-label="Dismiss"
              onClick={() => setProjectActionError(null)}
            >
              ×
            </button>
          </div>
        )}

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

      {projectDialog && (
        <ProjectDialog
          project={projectDialog.mode === 'edit' ? projectDialog.project : null}
          projects={projects}
          onClose={() => setProjectDialog(null)}
          onSaved={(project) => onProjectSaved(project, projectDialog.mode === 'create')}
        />
      )}

    </div>
  );
}
