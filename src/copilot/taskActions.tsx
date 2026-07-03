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
import { useRef } from 'react';
import { z } from 'zod';
import { useTasks } from '../tasks';
import { useTaskActions } from '../components/tasks/useTaskActions';
import type { Task } from '../types';
import { immediateAction, confirmedAction } from './actionKit';

/** Mount once inside the CopilotKit provider (CopilotDock.tsx), alongside
 *  <CopilotActions/>. Registers the task-management actions. */
export function TaskActions() {
  // The FULL task inventory across every project + source, INCLUDING done —
  // so the copilot can retrieve/act on ANY task, not just the ones rendered on
  // the current page (task-24ea35660cd0). Not scoped to the active project.
  const { tasks } = useTasks({ includeDone: true });
  const { setStatus, togglePin, setDue, bulkDelete, bulkPatch } = useTaskActions();

  // STALE-CLOSURE NOTE (see FormCopilotBridge): immediateAction/confirmedAction
  // register each handler ONCE, so a handler closing over `tasks`/actions
  // directly would capture the FIRST render's values — an EMPTY task list,
  // since tasks load async. That's exactly why "retrieve any task" failed.
  // Read through `live` (a ref refreshed each render) so handlers always see
  // the current task inventory + mutation fns.
  const live = useRef({ tasks, setStatus, togglePin, setDue, bulkDelete, bulkPatch });
  live.current = { tasks, setStatus, togglePin, setDue, bulkDelete, bulkPatch };

  const find = (taskId: string): Task | undefined =>
    live.current.tasks.find((t) => t.id === taskId);

  // ─── Discovery ─────────────────────────────────────────────────────────
  // The one action that lets the copilot reach a task the page ISN'T showing.
  // The grounding context only lists what's on screen (the current project's
  // open tasks); this searches the whole inventory so the model can find a
  // task by name, get its id, then act on it.
  immediateAction({
    name: 'find_tasks',
    description:
      "Search ALL tasks — every project and status, not just the ones visible on the current page — by title text and/or status. Returns matches with their id, title, status, and project id so you can then open or update them. Use this whenever the user names a task that isn't already in view.",
    parameters: z.object({
      query: z
        .string()
        .describe('Case-insensitive text to match against task titles. Omit or pass "" to list recent tasks.')
        .optional(),
      status: z
        .enum(['pending', 'in_progress', 'done', 'cancelled'])
        .describe('Optional status filter.')
        .optional(),
      limit: z.number().describe('Max results to return (default 15).').optional(),
    }),
    perform: ({ query, status, limit }) => {
      const q = (query ?? '').trim().toLowerCase();
      let matches = live.current.tasks;
      if (q) matches = matches.filter((t) => t.title.toLowerCase().includes(q));
      if (status) matches = matches.filter((t) => t.status === status);
      const cap = Math.max(1, Math.min(limit ?? 15, 50));
      const shown = matches.slice(0, cap);
      if (!shown.length) {
        return q ? `No tasks match "${query}"${status ? ` with status ${status}` : ''}.` : 'No tasks found.';
      }
      const lines = shown.map(
        (t) =>
          `- "${t.title}" [${t.status}] id=${t.id}${t.projectId ? ` project=${t.projectId}` : ''}`,
      );
      const more = matches.length > shown.length ? `\n(+${matches.length - shown.length} more — narrow the query)` : '';
      return `Found ${matches.length} task(s):\n${lines.join('\n')}${more}`;
    },
  });

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
      await live.current.setStatus(task, status as 'done' | 'pending' | 'in_progress');
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
      await live.current.togglePin(task);
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
      await live.current.togglePin(task);
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
      await live.current.setDue(task, v || null);
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
      await live.current.setStatus(task, 'cancelled');
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
      await live.current.bulkDelete([task]);
      return `Deleted "${task.title}".`;
    },
  });

  // ─── Bulk update (task-fa9c5dea9037) ───────────────────────────────────
  // The write-side primitive: apply ONE change to MANY tasks at once. The
  // model picks the target set (usually via find_tasks) and passes their ids;
  // this previews the affected tasks + the change for human approval, then
  // applies through the SAME bulkPatch the Tasks UI uses (per-capability
  // partitioning + reporting included). Composable with find_tasks: query →
  // ids → bulk_update_tasks.
  confirmedAction({
    name: 'bulk_update_tasks',
    description:
      'Apply the SAME change (status, due date, and/or pin) to MANY tasks at once. Pass the task ids (get them from find_tasks) and at least one field to change. Requires human approval, which shows exactly which tasks change.',
    parameters: z.object({
      taskIds: z
        .array(z.string())
        .describe('Ids of the tasks to update (from find_tasks).'),
      status: z
        .enum(['done', 'pending', 'in_progress', 'cancelled'])
        .optional()
        .describe('Set every task to this status.'),
      due: z
        .string()
        .optional()
        .describe('Set every task\'s due date to this ISO date (e.g. 2026-07-15), or "" to clear it.'),
      pinned: z.boolean().optional().describe('Pin (true) or unpin (false) every task.'),
    }),
    title: 'Update these tasks?',
    validate: ({ taskIds, status, due, pinned }) => {
      if (!Array.isArray(taskIds) || taskIds.length === 0) {
        return 'Failed: no task ids given. Use find_tasks first to get the ids.';
      }
      if (status === undefined && due === undefined && pinned === undefined) {
        return 'Failed: nothing to change — set at least one of status, due, or pinned.';
      }
      const missing = taskIds.filter((id) => !find(id));
      if (missing.length === taskIds.length) {
        return `Failed: none of those task ids matched. (${missing.slice(0, 5).join(', ')}…)`;
      }
      return null;
    },
    summary: ({ taskIds, status, due, pinned }) => {
      const tasks = taskIds.map(find).filter(Boolean) as Task[];
      const changes: string[] = [];
      if (status !== undefined) changes.push(`status → ${status}`);
      if (due !== undefined) changes.push(due.trim() ? `due → ${due.trim()}` : 'clear due date');
      if (pinned !== undefined) changes.push(pinned ? 'pin' : 'unpin');
      const shown = tasks.slice(0, 8);
      return (
        <>
          Apply <strong>{changes.join(', ')}</strong> to <strong>{tasks.length}</strong> task
          {tasks.length === 1 ? '' : 's'}?
          <div className="ck-confirm-note">
            {shown.map((t) => t.title).join(' · ')}
            {tasks.length > shown.length ? ` · +${tasks.length - shown.length} more` : ''}
          </div>
        </>
      );
    },
    confirmLabel: 'Apply to all',
    rejectLabel: 'Cancel',
    rejectedMessage: 'Cancelled — no tasks were changed.',
    perform: async ({ taskIds, status, due, pinned }) => {
      const tasks = taskIds.map(find).filter(Boolean) as Task[];
      if (tasks.length === 0) return 'Failed: none of those task ids matched.';
      const patch: Record<string, unknown> = {};
      const verbBits: string[] = [];
      if (status !== undefined) {
        patch.status = status;
        verbBits.push(`set ${status}`);
      }
      if (due !== undefined) {
        patch.due_at = due.trim() ? due.trim() : null;
        verbBits.push(due.trim() ? `due ${due.trim()}` : 'cleared due');
      }
      if (pinned !== undefined) {
        patch.pinned = pinned;
        verbBits.push(pinned ? 'pinned' : 'unpinned');
      }
      const verb = verbBits.join(', ');
      await live.current.bulkPatch(tasks, patch as never, verb);
      return `Updated ${tasks.length} task${tasks.length === 1 ? '' : 's'} (${verb}).`;
    },
  });

  return null;
}
