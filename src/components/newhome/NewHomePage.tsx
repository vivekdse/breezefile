// task-b9cdad64ab9c — New Home: shell for the agent-work-monitor surface.
// Full-screen singleton tab (kind:'newhome'), opened by the `:new-home`
// verb (aliases `:newhome` / `:nh`). Built from scratch alongside the
// existing Home (ProjectsPage, kind:'home'/'projects') — this file must never
// import from src/components/projects/ or otherwise couple to that surface.
//
// Layout (adapted from the V11 unified-prototype design reference — see
// task body for the source path — with app tokens standing in for its
// hardcoded colors):
//   topbar (project picker · Customize · + New Task)
//   project hero (name + subtitle)
//   ApprovalBar
//   HeroStats
//   filter pills (state owned here, passed down)
//   RosterTable
//   OutcomesPanel
//   conditional: TaskDetailDialog / NewTaskModal / TemplateEditor
//
// This component owns ALL cross-child state (selectedProjectId, filter,
// openTaskId, showNewTask, showTemplateEditor) and passes it down as props —
// children stay presentational stubs until follow-up tasks fill them in.
//
// PHI: task titles/custom-field values render in-app only; never persisted
// to disk/logs (see docs/typebuild-data-field-contract.md).

import { useEffect, useMemo, useState } from 'react';
import { useNewHomeData } from './useNewHomeData';
import { getTemplateConfig, setTemplateConfig, runRepeatable, instantiateChain } from './newHomePrefs';
import { scheduleLabel } from './newHomeTemplateOps';
import { compileTaskQuery, runTaskQuery } from './taskQuery';
import { createTask } from '../../tasks';
import type { NewHomeStatus } from './types';
import { ApprovalBar } from './ApprovalBar';
import { HeroStats } from './HeroStats';
import { RosterTable } from './RosterTable';
import { TaskDetailDialog } from './TaskDetailDialog';
import { TemplateEditor, type CustomizeTab } from './TemplateEditor';
import { OutcomesPanel } from './OutcomesPanel';
import { setNewHomeContext, clearNewHomeContext } from '../../copilot/newHomeContext';
import './NewHomePage.css';

type FilterState = 'all' | NewHomeStatus;

const FILTER_STATES: FilterState[] = ['all', 'done', 'progress', 'queued', 'needs', 'failed'];
function isFilterState(v: unknown): v is FilterState {
  return typeof v === 'string' && (FILTER_STATES as string[]).includes(v);
}

const CUSTOMIZE_TABS: CustomizeTab[] = ['fields', 'columns', 'approvals', 'steps', 'chains', 'repeatable', 'preview'];
function isCustomizeTab(v: unknown): v is CustomizeTab {
  return typeof v === 'string' && (CUSTOMIZE_TABS as string[]).includes(v);
}

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
  const [showCustomize, setShowCustomize] = useState(false);
  const [customizeTab, setCustomizeTab] = useState<CustomizeTab>('fields');
  // Bumped by the 'fm:newhome:templateChanged' listener below (fired by the
  // Copilot customize_columns/add_template_field actions — see
  // src/copilot/actions.tsx) so the `template` useMemo re-reads
  // newHomePrefs after an out-of-band edit, the same way it already does
  // after TemplateEditor's own onSave.
  const [templateVersion, setTemplateVersion] = useState(0);

  const { tasks, counts, approvals, projects, loading, refresh } =
    useNewHomeData(selectedProjectId);

  function openTaskDetail(id: string) {
    setOpenTaskId(id);
  }
  // task-ef961d60dc1b — "+ New Task" now opens the CANONICAL Task form (the
  // globally-mounted TaskComposer, via fm:openTask — the same form the task
  // verb / Sidebar / copilot create_task open) AND pops the copilot chat, so
  // the human can fill it by hand or drive it conversationally. New Home's own
  // NewTaskModal is deprecated and no longer mounted here.
  function openNewTask() {
    setOpenTaskId(null);
    window.dispatchEvent(
      new CustomEvent('fm:openTask', {
        detail: { mode: 'create', defaultFolder: '', projectId: selectedProjectId ?? undefined },
      }),
    );
    window.dispatchEvent(new CustomEvent('fm:openCopilotChat'));
  }
  function openCustomize(tab?: CustomizeTab) {
    if (tab) setCustomizeTab(tab);
    setShowCustomize(true);
  }

  const template = useMemo(
    () => getTemplateConfig(selectedProjectId),
    // Re-read whenever the project changes or the persisted template changes.
    // templateVersion is bumped both by the inline editor's own onChange
    // (live-apply) and by the 'fm:newhome:templateChanged' listener below
    // (Copilot actions editing the same store out-of-band) — one source of
    // truth, no private draft.
    [selectedProjectId, templateVersion],
  );

  // Persist an inline edit and re-read so the panel + copilot grounding stay
  // in lockstep. Same store (newHomePrefs) + same change signal the copilot
  // uses, so there is exactly one implementation of "the template changed".
  function applyTemplateChange(cfg: Parameters<typeof setTemplateConfig>[1]) {
    setTemplateConfig(selectedProjectId, cfg);
    setTemplateVersion((v) => v + 1);
  }

  // "Run now" for a repeatable task: spawn a real task through the SAME
  // createTask path the New Task form uses (recurrence rides along when the
  // def is scheduled), then refresh so the roster shows it.
  function runRepeatableById(id: string) {
    const def = (template.repeatables ?? []).find((r) => r.id === id);
    if (!def) return;
    void runRepeatable(def, selectedProjectId, createTask)
      .then(() => refresh())
      .catch(() => {
        /* surfaced by the app's task-error channel; nothing to do here */
      });
  }

  // "Run chain": instantiate the chain into linked tasks (container + one task
  // per step, wired parent/depends), resolving any repeatable-task references,
  // through the same createTask path, then refresh.
  function runChainById(chainId: string) {
    const chain = (template.chains ?? []).find((c) => c.id === chainId);
    if (!chain) return;
    void instantiateChain(chain, selectedProjectId, createTask, template.repeatables ?? [])
      .then(() => refresh())
      .catch(() => {
        /* surfaced by the app's task-error channel; nothing to do here */
      });
  }

  // Copilot action bridge (task-ce125a047c70): set_roster_filter and
  // open_task (src/copilot/actions.tsx) can't reach this component's state
  // directly since the copilot is mounted at the app root, so they dispatch
  // window CustomEvents instead. customize_columns/add_template_field write
  // straight to newHomePrefs (the same storage TemplateEditor uses) and
  // announce the change the same way, since this component owns no
  // in-memory copy of the template beyond the memo above.
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
    function onTemplateChanged() {
      setTemplateVersion((v) => v + 1);
    }
    // Copilot select_home_project drives the project picker (detail.projectId,
    // or null/'' for "All projects"). Same setter the <select> onChange calls.
    function onSelectProject(e: Event) {
      const id = (e as CustomEvent<{ projectId?: string | null }>).detail?.projectId;
      setSelectedProjectId(id ? id : null);
    }
    // Copilot open_customize / close_customize drive the inline Customize
    // panel — the same setters the Customize button + Done button call.
    function onOpenCustomize(e: Event) {
      const detail = (e as CustomEvent<{ tab?: string; open?: boolean }>).detail;
      if (detail && detail.open === false) {
        setShowCustomize(false);
        return;
      }
      if (detail && isCustomizeTab(detail.tab)) setCustomizeTab(detail.tab);
      setShowCustomize(true);
    }
    window.addEventListener('fm:newhome:filter', onFilter);
    window.addEventListener('fm:newhome:openTask', onOpenTask);
    window.addEventListener('fm:newhome:templateChanged', onTemplateChanged);
    window.addEventListener('fm:newhome:selectProject', onSelectProject);
    window.addEventListener('fm:newhome:openCustomize', onOpenCustomize);
    return () => {
      window.removeEventListener('fm:newhome:filter', onFilter);
      window.removeEventListener('fm:newhome:openTask', onOpenTask);
      window.removeEventListener('fm:newhome:templateChanged', onTemplateChanged);
      window.removeEventListener('fm:newhome:selectProject', onSelectProject);
      window.removeEventListener('fm:newhome:openCustomize', onOpenCustomize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The search box is dual-mode: if the text compiles as a structured query
  // (SQL-like DSL over task fields — see taskQuery.ts) we run that; otherwise
  // it's free-text. A query-shaped-but-invalid input surfaces its parse error
  // (kind 'invalid') instead of silently matching nothing.
  const queryState = useMemo(() => {
    const q = search.trim();
    if (!q) return { kind: 'none' as const };
    const c = compileTaskQuery(q, template.fields);
    if (c.ok) return { kind: 'query' as const, compiled: c.compiled };
    if (looksLikeQuery(q)) return { kind: 'invalid' as const, error: c.error };
    return { kind: 'text' as const };
  }, [search, template.fields]);

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
      // task-7bdb94445321 — publish the Customize panel's live state (NON-PHI
      // config only) so the copilot can SEE what the human is editing and
      // decide whether to open/navigate it.
      customize: {
        open: showCustomize,
        tab: showCustomize ? customizeTab : null,
        fields: template.fields.map((f) => ({ key: f.key, label: f.label })),
        steps: template.steps.map((s) => s.name),
        approvalRules: template.approvalRules.map((r) => r.description),
        chains: (template.chains ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          entryCount: c.entries.length,
        })),
        repeatables: (template.repeatables ?? []).map((r) => ({
          id: r.id,
          title: r.title,
          schedule: scheduleLabel(r.recurrence),
        })),
      },
      rosterFilter: { status: filter, search },
    });
  }, [selectedProject, projects, counts, tasks, showCustomize, customizeTab, template, filter, search]);

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
            className={'nh__btn' + (showCustomize ? ' nh__btn--active' : '')}
            aria-pressed={showCustomize}
            onClick={() => (showCustomize ? setShowCustomize(false) : openCustomize())}
          >
            Customize
          </button>
          <button
            type="button"
            className="nh__btn nh__btn--primary"
            onClick={openNewTask}
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

        {showCustomize && (
          <TemplateEditor
            projectId={selectedProjectId ?? ''}
            config={template}
            tab={customizeTab}
            onTabChange={setCustomizeTab}
            onChange={applyTemplateChange}
            onRunRepeatable={runRepeatableById}
            onRunChain={runChainById}
            onClose={() => setShowCustomize(false)}
          />
        )}

        <ApprovalBar
          approvals={approvals}
          onOpenTask={openTaskDetail}
          onResolved={() => void refresh()}
        />

        <HeroStats counts={counts} activeFilter={filter} onFilter={setFilter} />

        <RosterTable
          tasks={filteredTasks}
          filter={filter}
          search={search}
          queryMode={queryState.kind}
          queryError={queryState.kind === 'invalid' ? queryState.error : undefined}
          template={template}
          loading={loading}
          onOpenTask={openTaskDetail}
          onFilter={setFilter}
          onSearch={setSearch}
          onRetry={() => void refresh()}
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
          template={template}
          onClose={() => setOpenTaskId(null)}
          onResolved={() => {
            // Resolve/cancel/retry all flow through here so stats, the
            // roster row, and the approval bar update in place from the same
            // refreshed useNewHomeData snapshot, rather than each surface
            // tracking its own optimistic patch.
            void refresh();
            setOpenTaskId(null);
          }}
        />
      )}

    </div>
  );
}
