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
import { TemplateEditor } from './TemplateEditor';
import { OutcomesPanel } from './OutcomesPanel';
import { setNewHomeContext, clearNewHomeContext } from '../../copilot/newHomeContext';
import './NewHomePage.css';

type FilterState = 'all' | NewHomeStatus;

const FILTER_STATES: FilterState[] = ['all', 'done', 'progress', 'queued', 'needs', 'failed'];
function isFilterState(v: unknown): v is FilterState {
  return typeof v === 'string' && (FILTER_STATES as string[]).includes(v);
}

export function NewHomePage() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterState>('all');
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  // Bumped by the 'fm:newhome:templateChanged' listener below (fired by the
  // Copilot customize_columns/add_template_field actions — see
  // src/copilot/actions.tsx) so the `template` useMemo re-reads
  // newHomePrefs after an out-of-band edit, the same way it already does
  // after TemplateEditor's own onSave.
  const [templateVersion, setTemplateVersion] = useState(0);

  const { tasks, counts, approvals, projects, loading, refresh } =
    useNewHomeData(selectedProjectId);

  // Only one overlay (detail dialog / new-task modal / template editor) may
  // be open at a time — opening one closes the others, so backdrop/Escape
  // handling never has to reason about a stack.
  function openTaskDetail(id: string) {
    setShowNewTask(false);
    setShowTemplateEditor(false);
    setOpenTaskId(id);
  }
  function openNewTask() {
    setOpenTaskId(null);
    setShowTemplateEditor(false);
    setShowNewTask(true);
  }
  function openTemplateEditor() {
    setOpenTaskId(null);
    setShowNewTask(false);
    setShowTemplateEditor(true);
  }

  const template = useMemo(
    () => getTemplateConfig(selectedProjectId),
    // Re-read whenever the project changes, the editor just saved (the
    // editor's onSave below bumps a local version via setShowTemplateEditor,
    // which already re-renders this component), or a Copilot action edited
    // the template out-of-band (templateVersion, bumped by the
    // 'fm:newhome:templateChanged' listener below).
    [selectedProjectId, showTemplateEditor, templateVersion],
  );

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
    window.addEventListener('fm:newhome:filter', onFilter);
    window.addEventListener('fm:newhome:openTask', onOpenTask);
    window.addEventListener('fm:newhome:templateChanged', onTemplateChanged);
    return () => {
      window.removeEventListener('fm:newhome:filter', onFilter);
      window.removeEventListener('fm:newhome:openTask', onOpenTask);
      window.removeEventListener('fm:newhome:templateChanged', onTemplateChanged);
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
      counts,
      needsYou: tasks
        .filter((t) => t.status === 'needs')
        .map((t) => ({ id: t.id, title: t.title })),
    });
  }, [selectedProject, counts, tasks]);

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
            onClick={openTemplateEditor}
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

      {showTemplateEditor && (
        <TemplateEditor
          projectId={selectedProjectId ?? ''}
          config={template}
          onSave={(cfg) => {
            setTemplateConfig(selectedProjectId, cfg);
            setShowTemplateEditor(false);
          }}
          onClose={() => setShowTemplateEditor(false)}
        />
      )}
    </div>
  );
}
