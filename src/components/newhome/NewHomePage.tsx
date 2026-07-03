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
import { getTemplateConfig, setTemplateConfig } from './newHomePrefs';
import type { NewHomeStatus } from './types';
import { ApprovalBar } from './ApprovalBar';
import { HeroStats } from './HeroStats';
import { RosterTable } from './RosterTable';
import { TaskDetailDialog } from './TaskDetailDialog';
import { NewTaskModal } from './NewTaskModal';
import { TemplateEditor, type CustomizeTab } from './TemplateEditor';
import { OutcomesPanel } from './OutcomesPanel';
import { setNewHomeContext, clearNewHomeContext } from '../../copilot/newHomeContext';
import './NewHomePage.css';

type FilterState = 'all' | NewHomeStatus;

const FILTER_STATES: FilterState[] = ['all', 'done', 'progress', 'queued', 'needs', 'failed'];
function isFilterState(v: unknown): v is FilterState {
  return typeof v === 'string' && (FILTER_STATES as string[]).includes(v);
}

const CUSTOMIZE_TABS: CustomizeTab[] = ['fields', 'columns', 'approvals', 'steps', 'chains', 'preview'];
function isCustomizeTab(v: unknown): v is CustomizeTab {
  return typeof v === 'string' && (CUSTOMIZE_TABS as string[]).includes(v);
}

export function NewHomePage() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterState>('all');
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
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

  // The two true overlays (detail dialog / new-task modal) stay mutually
  // exclusive so backdrop/Escape never has to reason about a stack. Customize
  // is now an INLINE panel in the page flow (task-7bdb94445321), not an
  // overlay, so it can coexist with them and isn't forced closed here.
  function openTaskDetail(id: string) {
    setShowNewTask(false);
    setOpenTaskId(id);
  }
  function openNewTask() {
    setOpenTaskId(null);
    setShowNewTask(true);
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

  // Copilot action bridge (task-ce125a047c70): set_roster_filter and
  // open_task (src/copilot/actions.tsx) can't reach this component's state
  // directly since the copilot is mounted at the app root, so they dispatch
  // window CustomEvents instead. customize_columns/add_template_field write
  // straight to newHomePrefs (the same storage TemplateEditor uses) and
  // announce the change the same way, since this component owns no
  // in-memory copy of the template beyond the memo above.
  useEffect(() => {
    function onFilter(e: Event) {
      const detail = (e as CustomEvent<{ filter?: string }>).detail;
      if (detail && isFilterState(detail.filter)) setFilter(detail.filter);
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

  const filteredTasks = useMemo(
    () => (filter === 'all' ? tasks : tasks.filter((t) => t.status === filter)),
    [tasks, filter],
  );

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
      },
    });
  }, [selectedProject, projects, counts, tasks, showCustomize, customizeTab, template]);

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
          template={template}
          loading={loading}
          onOpenTask={openTaskDetail}
          onFilter={setFilter}
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

      {showNewTask && (
        <NewTaskModal
          projectId={selectedProjectId ?? ''}
          template={template}
          onClose={() => setShowNewTask(false)}
          onCreated={() => {
            void refresh();
            setShowNewTask(false);
          }}
        />
      )}
    </div>
  );
}
