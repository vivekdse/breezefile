// CopilotKit actions for AGENT INTERACTION — parity with the New Home agent-work
// affordances (TaskDetailDialog / roster). Every action resolves
// its target from the FULL, unfiltered task list (useTasks({ includeDone:true }))
// by id (the SAME resolution taskActions.tsx uses) and then calls the SAME real
// functions the human UI calls — no reimplemented server calls:
//
//   • answer_task        → answerTaskQuestion + markQuestionAnswered
//                          (TaskDetailDialog.submitAnswer: the quick-reply /
//                           free-text / reject buttons + dialog Submit)
//   • bulk_answer_tasks  → the SAME answerTaskQuestion, applied to many pending
//                          questions at once
//   • retry_task         → useTaskActions().start (roster "Retry" / dialog "Retry")
//   • message_agent      → postTaskMessage (TaskDetailDialog "Send message")
//
// Risk posture (declared once via actionKit — see its header):
//   • answer_task / bulk_answer_tasks — confirmedAction. Answering (esp. a
//     rejection) is a meaningful, effectively-irreversible reply the agent acts
//     on; it warrants the same human approve card a "reject" gets. bulk matches
//     the bulk_update_tasks confirm precedent (preview which tasks change).
//   • retry_task — confirmedAction. It KICKS OFF agent work (claim-then-launch /
//     run-now).
//   • message_agent — confirmedAction. An outbound message the agent acts on.
//
// PHI: answer/message text are chat content the user authored — NEVER logged
// here (only task ids, which are opaque). Return short strings so the transcript
// is a clear audit trail of what actually happened.
import { useRef } from 'react';
import { z } from 'zod';
import {
  useTasks,
  answerTaskQuestion,
  markQuestionAnswered,
  postTaskMessage,
  formatMessageSendReason,
} from '../tasks';
import { useTaskActions } from '../components/tasks/useTaskActions';
import type { Task } from '../types';
import { confirmedAction } from './actionKit';

/** Mount once inside the CopilotKit provider (CopilotDock.tsx), alongside
 *  <CopilotActions/>. Registers the agent-interaction actions. */
export function AgentActions() {
  // FULL inventory across every project + source, INCLUDING done — so the
  // copilot can act on ANY task, not just what's on the current page. Same
  // source of truth taskActions.tsx uses.
  const { tasks } = useTasks({ includeDone: true });
  const actions = useTaskActions();

  // STALE-CLOSURE NOTE (see taskActions.tsx): each action registers its handler
  // ONCE, so close over a ref refreshed every render, never `tasks`/`actions`
  // directly (which would capture the FIRST render's empty task list).
  const live = useRef({ tasks, actions });
  live.current = { tasks, actions };

  const find = (taskId: string): Task | undefined =>
    live.current.tasks.find((t) => t.id === taskId);

  const pending = (t: Task | undefined): boolean => !!t?.pending_question;

  // ─── answer_task ─────────────────────────────────────────────────────────
  // Mirrors ApprovalBar / TaskDetailDialog: answerTaskQuestion clears the
  // server-side pending_question AND records the reply on the feed; on success
  // we optimistically clear the row (markQuestionAnswered) exactly as the UI
  // does. A rejection is just an answer with negative text — same path, no
  // separate flag (matches how the Cancel/Reject button submits).
  confirmedAction({
    name: 'answer_task',
    description:
      "Answer an agent's PENDING QUESTION on a task (what the Approval Bar quick-reply / free-text / reject buttons and the task detail Submit button do). Pass the task id and the answer text — including a rejection (e.g. \"No\", or the reason) to decline. Requires human approval which shows the answer being sent.",
    parameters: z.object({
      taskId: z.string().describe('The id of the task whose pending question to answer.'),
      answer: z
        .string()
        .describe(
          'The answer text to send the agent. This is what the agent will act on — to reject/decline, answer with "No" or the reason.',
        ),
    }),
    title: 'Send this answer?',
    validate: ({ taskId, answer }) => {
      const task = find(taskId);
      if (!task) return `No task found with id "${taskId}".`;
      if (!pending(task)) return `"${task.title}" has no pending question to answer.`;
      if (!answer || !answer.trim()) return 'Failed: the answer is empty.';
      return null;
    },
    summary: ({ taskId, answer }) => {
      const task = find(taskId);
      return (
        <>
          Send this answer to <strong>{task?.title ?? taskId}</strong>?
          <div className="ck-confirm-note">{answer}</div>
        </>
      );
    },
    confirmLabel: 'Send answer',
    rejectLabel: 'Cancel',
    rejectedMessage: 'Cancelled — no answer was sent.',
    perform: async ({ taskId, answer }) => {
      const task = find(taskId);
      if (!task) return `No task found with id "${taskId}".`;
      const res = await answerTaskQuestion(taskId, answer.trim());
      if (!res.ok) return `Couldn't answer "${task.title}": ${formatMessageSendReason(res.reason)}.`;
      markQuestionAnswered(taskId);
      return `Answered "${task.title}".`;
    },
  });

  // ─── bulk_answer_tasks ───────────────────────────────────────────────────
  // Mirrors ApprovalBar "Approve selected" — submit the SAME answer to several
  // pending questions at once through the SAME answerTaskQuestion. Confirmed,
  // matching bulk_update_tasks (preview the affected tasks before applying).
  confirmedAction({
    name: 'bulk_answer_tasks',
    description:
      'Answer the SAME reply to MANY tasks that have a pending question at once (like "Approve selected" in the Approval Bar). Pass the task ids and one answer text applied to all of them — use this for a shared approval like "Yes". For different answers per task, call answer_task once each instead. Requires human approval which lists the tasks.',
    parameters: z.object({
      taskIds: z
        .array(z.string())
        .describe('Ids of the tasks to answer (each must have a pending question).'),
      answer: z.string().describe('The single answer text applied to every task.'),
    }),
    title: 'Answer these tasks?',
    validate: ({ taskIds, answer }) => {
      if (!Array.isArray(taskIds) || taskIds.length === 0) {
        return 'Failed: no task ids given. Use find_tasks first to get the ids.';
      }
      if (!answer || !answer.trim()) return 'Failed: the answer is empty.';
      const answerable = taskIds.map(find).filter((t) => pending(t));
      if (answerable.length === 0) {
        return 'Failed: none of those tasks have a pending question to answer.';
      }
      return null;
    },
    summary: ({ taskIds, answer }) => {
      const answerable = taskIds.map(find).filter(pending) as Task[];
      const shown = answerable.slice(0, 8);
      return (
        <>
          Send <strong>{answer}</strong> to <strong>{answerable.length}</strong> task
          {answerable.length === 1 ? '' : 's'}?
          <div className="ck-confirm-note">
            {shown.map((t) => t.title).join(' · ')}
            {answerable.length > shown.length ? ` · +${answerable.length - shown.length} more` : ''}
          </div>
        </>
      );
    },
    confirmLabel: 'Send to all',
    rejectLabel: 'Cancel',
    rejectedMessage: 'Cancelled — no answers were sent.',
    perform: async ({ taskIds, answer }) => {
      const answerable = taskIds.map(find).filter(pending) as Task[];
      if (answerable.length === 0) return 'Failed: none of those tasks have a pending question.';
      const text = answer.trim();
      let ok = 0;
      let failed = 0;
      await Promise.all(
        answerable.map((t) =>
          answerTaskQuestion(t.id, text).then(
            (res) => {
              if (res.ok) {
                markQuestionAnswered(t.id);
                ok += 1;
              } else {
                failed += 1;
              }
            },
            () => {
              failed += 1;
            },
          ),
        ),
      );
      let msg = `Answered ${ok} task${ok === 1 ? '' : 's'}`;
      if (failed > 0) msg += ` · ${failed} failed`;
      return `${msg}.`;
    },
  });

  // ─── retry_task ──────────────────────────────────────────────────────────
  // Mirrors the roster "Retry" and dialog "Retry" buttons (both call
  // actions.start(task)). Start = claim-then-launch (TypeBuild) or run-now
  // (local). Confirmed, matching run_repeatable_task / run_chain — starting
  // agent work is a side effect worth a human gate. start() reports its own
  // contested-claim / mint errors to the statusbar and resolves quickly.
  confirmedAction({
    name: 'retry_task',
    description:
      'Retry / start a task — claim it and launch (or re-launch) the agent session that works it (what the roster "Retry" and the task detail "Retry" buttons do). Use this to re-run a failed task or kick off a queued one. Requires human approval.',
    parameters: z.object({
      taskId: z.string().describe('The id of the task to retry / start.'),
    }),
    title: 'Retry this task?',
    validate: ({ taskId }) => (find(taskId) ? null : `No task found with id "${taskId}".`),
    summary: ({ taskId }) => {
      const task = find(taskId);
      return (
        <>
          Retry <strong>{task?.title ?? taskId}</strong>? This starts the agent working on it.
        </>
      );
    },
    confirmLabel: 'Retry',
    rejectLabel: 'Cancel',
    rejectedMessage: 'Cancelled — the task was not started.',
    perform: async ({ taskId }) => {
      const task = find(taskId);
      if (!task) return `No task found with id "${taskId}".`;
      // Same call the roster/dialog Retry buttons make. start() surfaces any
      // contested-claim / mint failure to the statusbar itself and resolves.
      await live.current.actions.start(task);
      return `Starting "${task.title}".`;
    },
  });

  // ─── message_agent ───────────────────────────────────────────────────────
  // Mirrors the task detail "Send message" button: postTaskMessage appends to
  // the task's message feed (visibility-gated only; works on a task in ANY
  // status) so the agent picks it up. The UI's "Send & open session" / "Open
  // session" variants additionally open a live session TAB — that's dialog-only
  // UI state (a resolved conversation id + folder) the copilot can't reproduce,
  // so this action does exactly the plain append the default button does.
  confirmedAction({
    name: 'message_agent',
    description:
      "Send a message to the agent working a task — appended to the task's message feed so the agent sees it (what the task detail \"Send message\" button does). Works on a task in any status. Does not open a live session tab. Requires human approval which shows the message.",
    parameters: z.object({
      taskId: z.string().describe('The id of the task to message the agent about.'),
      message: z.string().describe('The message text to send the agent.'),
    }),
    title: 'Send this message?',
    validate: ({ taskId, message }) => {
      if (!find(taskId)) return `No task found with id "${taskId}".`;
      if (!message || !message.trim()) return 'Failed: the message is empty.';
      return null;
    },
    summary: ({ taskId, message }) => {
      const task = find(taskId);
      return (
        <>
          Send this message about <strong>{task?.title ?? taskId}</strong>?
          <div className="ck-confirm-note">{message}</div>
        </>
      );
    },
    confirmLabel: 'Send message',
    rejectLabel: 'Cancel',
    rejectedMessage: 'Cancelled — no message was sent.',
    perform: async ({ taskId, message }) => {
      const task = find(taskId);
      if (!task) return `No task found with id "${taskId}".`;
      const res = await postTaskMessage(taskId, message.trim());
      if (!res.ok) return `Couldn't message "${task.title}": ${formatMessageSendReason(res.reason)}.`;
      return `Sent your message to the agent on "${task.title}".`;
    },
  });

  return null;
}
