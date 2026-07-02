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

import { useMemo, useState } from 'react';
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
import './NewHomePage.css';

type FilterState = 'all' | NewHomeStatus;

export function NewHomePage() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterState>('all');
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);

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
    // Re-read whenever the project changes OR the editor just saved (the
    // editor's onSave below bumps a local version via setShowTemplateEditor,
    // which already re-renders this component).
    [selectedProjectId, showTemplateEditor],
  );

  const filteredTasks = useMemo(
    () => (filter === 'all' ? tasks : tasks.filter((t) => t.status === filter)),
    [tasks, filter],
  );

  const selectedProject = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId) ?? null
    : null;

  const openTask = openTaskId ? tasks.find((t) => t.id === openTaskId) : undefined;

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
