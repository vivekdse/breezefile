// CopilotKit actions for task management — parity with the human-facing Tasks
// UI. Every action resolves its target from the FULL, unfiltered task list
// (useTasks() with no filter) by taskId and then calls the SAME real mutation
// functions the Tasks page uses (useTaskActions()) — no reimplemented mutation
// logic, no fake CustomEvents for mutations. Navigational actions
// (open_task_detail / edit_task) dispatch the same window CustomEvents a human
// click fires, passing the resolved Task object App.tsx expects.
//
// Risk posture is declared once via actionKit: immediateAction for reversible
// changes (status/pin/due/open/edit), confirmedAction (human approve/reject
// card) for the irreversible/destructive ones (cancel/delete).
//
// PHI: action params/results are chat content the user authored — never
// additionally logged here. Return short, unambiguous strings so the transcript
// is a clear audit trail of what actually happened.
import { z } from 'zod';
import { useTasks } from '../tasks';
import { useTaskActions } from '../components/tasks/useTaskActions';
import type { Task } from '../types';
import { immediateAction, confirmedAction } from './actionKit';

/** Mount once inside the CopilotKit provider (CopilotDock.tsx), alongside
 *  <CopilotActions/>. Registers the task-management actions. */
export function TaskActions() {
  // Full, unfiltered task inventory so any task id the LLM references resolves.
  const { tasks } = useTasks();
  const { setStatus, togglePin, setDue, bulkDelete } = useTaskActions();

  const find = (taskId: string): Task | undefined =>
    tasks.find((t) => t.id === taskId);

  // ─── Reversible ────────────────────────────────────────────────────────

  immediateAction({
    name: 'set_task_status',
    description:
      "Set a task's status to done, pending (reopen), or in_progress. To cancel a task use cancel_task instead.",
    parameters: z.object({
      taskId: z.string().describe('The id of the task to update.'),
      status: z
        .enum(['done', 'pending', 'in_progress'])
        .describe("New status: one of 'done', 'pending', 'in_progress'."),
    }),
    perform: async ({ taskId, status }) => {
      const task = find(taskId);
      if (!task) return `No task found with id "${taskId}".`;
      if (!['done', 'pending', 'in_progress'].includes(status)) {
        return `Failed: status must be one of done, pending, in_progress (got "${status}").`;
      }
      await setStatus(task, status as 'done' | 'pending' | 'in_progress');
      return `Set status of "${task.title}" to ${status}.`;
    },
  });

  immediateAction({
    name: 'pin_task',
    description: 'Pin a task so it surfaces to the top. No-op if already pinned.',
    parameters: z.object({
      taskId: z.string().describe('The id of the task to pin.'),
    }),
    perform: async ({ taskId }) => {
      const task = find(taskId);
      if (!task) return `No task found with id "${taskId}".`;
      if (task.pinned) return `"${task.title}" is already pinned.`;
      await togglePin(task);
      return `Pinned "${task.title}".`;
    },
  });

  immediateAction({
    name: 'unpin_task',
    description: 'Unpin a task. No-op if not currently pinned.',
    parameters: z.object({
      taskId: z.string().describe('The id of the task to unpin.'),
    }),
    perform: async ({ taskId }) => {
      const task = find(taskId);
      if (!task) return `No task found with id "${taskId}".`;
      if (!task.pinned) return `"${task.title}" is not pinned.`;
      await togglePin(task);
      return `Unpinned "${task.title}".`;
    },
  });

  immediateAction({
    name: 'set_task_due',
    description:
      "Set a task's due date, or clear it. Pass an ISO date string (e.g. 2026-07-15) to set, or an empty string to clear the due date.",
    parameters: z.object({
      taskId: z.string().describe('The id of the task to update.'),
      value: z
        .string()
        .describe('ISO date string (e.g. 2026-07-15) to set the due date, or an empty string to clear it.'),
    }),
    perform: async ({ taskId, value }) => {
      const task = find(taskId);
      if (!task) return `No task found with id "${taskId}".`;
      const v = (value ?? '').trim();
      await setDue(task, v || null);
      return v
        ? `Set due date of "${task.title}" to ${v}.`
        : `Cleared the due date of "${task.title}".`;
    },
  });

  immediateAction({
    name: 'open_task_detail',
    description: "Open a task's detail drawer (read-only view of its trace, config, and activity).",
    parameters: z.object({
      taskId: z.string().describe('The id of the task to open.'),
    }),
    perform: ({ taskId }) => {
      const task = find(taskId);
      if (!task) return `No task found with id "${taskId}".`;
      window.dispatchEvent(new CustomEvent('fm:openTaskDetail', { detail: { task } }));
      return `Opened the detail drawer for "${task.title}".`;
    },
  });

  immediateAction({
    name: 'edit_task',
    description: 'Open a task in the editor so its fields can be changed. This only opens the editor; it does not itself change anything.',
    parameters: z.object({
      taskId: z.string().describe('The id of the task to edit.'),
    }),
    perform: ({ taskId }) => {
      const task = find(taskId);
      if (!task) return `No task found with id "${taskId}".`;
      window.dispatchEvent(new CustomEvent('fm:openTask', { detail: { mode: 'edit', task } }));
      return `Opened "${task.title}" in the editor.`;
    },
  });

  // ─── Gated (confirmed) ─────────────────────────────────────────────────

  confirmedAction({
    name: 'cancel_task',
    description: 'Cancel a task (sets its status to cancelled). Requires human approval.',
    parameters: z.object({
      taskId: z.string().describe('The id of the task to cancel.'),
    }),
    title: 'Cancel task?',
    validate: ({ taskId }) => (find(taskId) ? null : `No task found with id "${taskId}".`),
    summary: ({ taskId }) => {
      const task = find(taskId);
      return (
        <>
          Cancel task <strong>{task?.title ?? taskId}</strong>?
        </>
      );
    },
    confirmLabel: 'Cancel task',
    rejectLabel: 'Keep task',
    rejectedMessage: 'Cancelled — the task was left as-is.',
    perform: async ({ taskId }) => {
      const task = find(taskId);
      if (!task) return `No task found with id "${taskId}".`;
      await setStatus(task, 'cancelled');
      return `Cancelled "${task.title}".`;
    },
  });

  confirmedAction({
    name: 'delete_task',
    description: 'Permanently delete a task. This is irreversible and requires human approval.',
    parameters: z.object({
      taskId: z.string().describe('The id of the task to delete.'),
    }),
    title: 'Delete task?',
    destructive: true,
    validate: ({ taskId }) => (find(taskId) ? null : `No task found with id "${taskId}".`),
    summary: ({ taskId }) => {
      const task = find(taskId);
      return (
        <>
          Permanently delete <strong>{task?.title ?? taskId}</strong>? This can't be undone.
        </>
      );
    },
    confirmLabel: 'Delete',
    rejectLabel: 'Keep',
    rejectedMessage: 'Cancelled — the task was not deleted.',
    perform: async ({ taskId }) => {
      const task = find(taskId);
      if (!task) return `No task found with id "${taskId}".`;
      await bulkDelete([task]);
      return `Deleted "${task.title}".`;
    },
  });

  return null;
}
