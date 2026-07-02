// CopilotKit navigation actions — parity with the human-facing navigation UI.
// Every action here reaches the SAME code path a human click uses: it either
// dispatches the exact window CustomEvent the existing UI dispatches
// (fm:openNewHome / fm:openProjects / fm:openTasksPage), or calls the SAME
// store action the UI dispatches (openTaskTab) — no parallel navigation logic.
//
// Navigation is always reversible / read-only (it never mutates task data), so
// every action uses immediateAction (fires the instant the LLM calls it).
//
// Event/store-action shapes are matched to their existing callers so this is
// provably the same path, not a mirror:
//   • fm:openNewHome         — App.tsx onOpenNewHome (no detail)
//   • fm:openProjects        — App.tsx onOpenProjects; detail.projectId drills
//                              into a project via fm:projects:focus (exactly
//                              ProjectsPage.openProjectDetail)
//   • fm:openTasksPage       — App.tsx onOpenTasksPage; optional detail.folder
//   • openTaskTab (store)    — same dispatch TasksPage / Sidebar /
//                              useProjectTaskRows fire (taskId + task.folder)
//   • fm:projects:openFolder — new deep-link added to ProjectsPage for this;
//                              resolves projectId -> bound folder, then calls
//                              the SAME openProjectFolder() the folder-link
//                              click handler calls (no mirrored logic)
//   • fm:projects:needsYou   — new deep-link added to ProjectsPage for this;
//                              calls the SAME openProjectNeedsYou() the
//                              "needs you" count click handler calls
//
// PHI: action params/results are chat content the user authored — never
// additionally logged here. Return short, unambiguous strings so the chat
// transcript is a clear audit trail of what actually happened.
import { z } from 'zod';
import { useStore } from '../store';
import { useTasks } from '../tasks';
import type { Task } from '../types';
import { immediateAction } from './actionKit';

/** Mount once inside the CopilotKit provider (CopilotDock.tsx), alongside
 *  <CopilotActions/>. Registers the app-navigation actions. */
export function NavActions() {
  const { dispatch } = useStore();
  // Full, unfiltered task inventory so any task id the LLM references resolves
  // to its folder (openTaskTab needs the task's folder to root the tab).
  const { tasks } = useTasks();
  const findTask = (taskId: string): Task | undefined =>
    tasks.find((t) => t.id === taskId);

  // ─── Top-level surfaces (no params) ─────────────────────────────────────

  immediateAction({
    name: 'goto_new_home',
    description:
      'Open the New Home page — the app launch surface with recent tasks and projects.',
    perform: () => {
      window.dispatchEvent(new CustomEvent('fm:openNewHome'));
      return 'Opened New Home.';
    },
  });

  immediateAction({
    name: 'goto_projects',
    description:
      'Open the Projects home (Project Atlas) — the projects-as-folders overview.',
    perform: () => {
      window.dispatchEvent(new CustomEvent('fm:openProjects'));
      return 'Opened Projects.';
    },
  });

  immediateAction({
    name: 'goto_tasks',
    description:
      "Open the Tasks page — the flat, all-tasks list. Optionally filter it to a single folder.",
    parameters: z.object({
      folder: z
        .string()
        .describe('Optional folder path to filter the tasks list to.')
        .optional(),
    }),
    perform: ({ folder }) => {
      const detail = folder?.trim() ? { folder: folder.trim() } : undefined;
      window.dispatchEvent(new CustomEvent('fm:openTasksPage', { detail }));
      return detail
        ? `Opened the Tasks page filtered to "${detail.folder}".`
        : 'Opened the Tasks page.';
    },
  });

  // ─── Open a task in a file-manager-style task tab ───────────────────────

  immediateAction({
    name: 'open_task_tab',
    description:
      "Open a task in a file-manager-style task tab (the same tab a double-click on a task row opens), rooted at the task's folder.",
    parameters: z.object({
      taskId: z.string().describe('The id of the task to open.'),
      folder: z
        .string()
        .describe("Optional folder to root the tab at. Defaults to the task's own folder.")
        .optional(),
    }),
    perform: ({ taskId, folder }) => {
      const task = findTask(taskId);
      if (!task) return `No task found with id "${taskId}".`;
      const resolvedFolder = folder?.trim() || task.folder;
      dispatch({ type: 'openTaskTab', taskId: task.id, folder: resolvedFolder });
      return `Opened "${task.title}" in a task tab.`;
    },
  });

  // ─── Drill into a project (Projects home) ───────────────────────────────

  immediateAction({
    name: 'open_project',
    description:
      'Open (drill into) a project by id in the Projects home — the same detail view a click on a project card opens.',
    parameters: z.object({
      projectId: z.string().describe('The id of the project to open.'),
    }),
    perform: ({ projectId }) => {
      const id = projectId?.trim();
      if (!id) return 'Failed: a project id is required.';
      // fm:openProjects with detail.projectId opens/focuses the Projects home
      // tab and drills into the project via fm:projects:focus — exactly
      // ProjectsPage.openProjectDetail's path (App.tsx onOpenProjects).
      window.dispatchEvent(
        new CustomEvent('fm:openProjects', { detail: { projectId: id } }),
      );
      return `Opened project ${id}.`;
    },
  });

  immediateAction({
    name: 'open_project_folder',
    description:
      "Open a project's bound folder in a file-manager tab — the same folder the project header's folder link opens.",
    parameters: z.object({
      projectId: z.string().describe('The id of the project.'),
    }),
    perform: ({ projectId }) => {
      const id = projectId?.trim();
      if (!id) return 'Failed: a project id is required.';
      window.dispatchEvent(new CustomEvent('fm:projects:openFolder', { detail: { projectId: id } }));
      return `Opened project ${id}'s folder.`;
    },
  });

  immediateAction({
    name: 'open_project_needs_you',
    description:
      "Drill into a project and filter its task list to exactly the tasks that need human attention — the same view the project's \"needs you\" count opens when clicked.",
    parameters: z.object({
      projectId: z.string().describe('The id of the project.'),
    }),
    perform: ({ projectId }) => {
      const id = projectId?.trim();
      if (!id) return 'Failed: a project id is required.';
      window.dispatchEvent(new CustomEvent('fm:projects:needsYou', { detail: { projectId: id } }));
      return `Opened project ${id}'s needs-you tasks.`;
    },
  });

  return null;
}
