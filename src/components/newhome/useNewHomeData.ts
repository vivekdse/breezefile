// task-b9cdad64ab9c — New Home data hook. Wraps useTasks + the TypeBuild
// projects/agents registries into the shapes NewHomePage and its children
// consume. Kept separate from the existing ProjectsPage data plumbing
// (useProjectTaskRows.tsx) — New Home is a from-scratch surface and must not
// perturb that page's behavior.
//
// Status-bucket derivation reuses src/projects/attention.mjs `classify()` —
// the SAME pure, tested "what needs attention" predicate the existing Home
// ranks projects with — rather than re-deriving blocked/failed/asked rules
// here and risking drift:
//   done     — task.status === 'done'.
//   failed   — task.status === 'cancelled' (didn't complete cleanly — TODO
//              (New Home follow-up): give cancelled its own bucket if the
//              roster UX wants to distinguish "failed" from "cancelled"),
//              OR classify().failed (attempts exhausted / rawStatus 'failed').
//   needs    — classify().asked (a pending question — human-only unblock),
//              OR classify().blocked (rawStatus 'blocked'/'failed'), OR
//              classify().stalled (an in_progress row with no live worker).
//   progress — everything else still open (classify().open, or in_progress
//              with a live worker). classify().overdue is folded into
//              'progress' here — New Home doesn't have a due-date lane yet;
//              TODO(New Home follow-up) surface overdue separately if the
//              roster needs it.
//
// `who` derivation is a rough heuristic pending a real activity/audit feed:
//   'human' when a pending_question is open (the ball is with a human),
//   'agent' when the task is actively claimed/in-progress with no question,
//   'both'  when there's message history from both sides (best-effort: we
//           can't yet tell agent vs. human authorship apart cheaply here —
//           TODO: thread `messages[].by` against the agent's identity once
//           New Home need it for real, e.g. in TaskDetailDialog).
// For now, tasks with any `messages` entries default to 'both'; otherwise we
// fall back on claim state. This is intentionally approximate.

import { useEffect, useMemo, useState } from 'react';
import { useTasks } from '../../tasks';
import { fm } from '../../bridge';
import { classify, todayKey } from '../../projects/index.mjs';
import type { Agent, Project, Task } from '../../types';
import type { NewHomeStatus, NewHomeTask } from './types';

function deriveStatus(t: Task, today: string, now: number): NewHomeStatus {
  if (t.status === 'done') return 'done';
  if (t.status === 'cancelled') return 'failed';
  const c = classify(t, today, now);
  if (c.failed) return 'failed';
  if (c.asked || c.blocked || c.stalled) return 'needs';
  return 'progress';
}

function deriveWho(t: Task): NewHomeTask['who'] {
  // TODO(New Home follow-up) — this is a placeholder heuristic. Once the
  // roster needs a trustworthy "who's turn is it" signal, thread it through
  // messages[].by / audit events instead of guessing from claim + question
  // state.
  if (t.pending_question) return 'human';
  if (t.messages && t.messages.length > 0) return 'both';
  if (t.claimedBy || t.status === 'in_progress') return 'agent';
  return 'agent';
}

function deriveLastAction(t: Task): string {
  // TODO(New Home follow-up) — swap for a real audit-trail line once
  // available; this is a best-effort summary from whatever's already on the
  // task object.
  if (t.pending_question) return `Asked: ${t.pending_question.text}`;
  const lastMsg = t.messages?.at(-1);
  if (lastMsg) return lastMsg.text;
  if (t.notes && t.notes.trim()) return t.notes.trim().split('\n')[0];
  if (t.rawStatus) return `status: ${t.rawStatus}`;
  return t.status;
}

function deriveRisk(t: Task): string | undefined {
  if (t.attempts && t.maxAttempts && t.attempts >= t.maxAttempts) {
    return `${t.attempts}/${t.maxAttempts} attempts — exhausted`;
  }
  if (t.attempts && t.attempts > 1) return `retry ${t.attempts}`;
  if (t.rawStatus === 'blocked') return 'blocked';
  return undefined;
}

function toNewHomeTask(t: Task, today: string, now: number): NewHomeTask {
  return {
    id: t.id,
    title: t.title,
    status: deriveStatus(t, today, now),
    projectId: t.projectId ?? null,
    lastAction: deriveLastAction(t),
    who: deriveWho(t),
    pendingQuestion: t.pending_question ?? null,
    // TODO(New Home follow-up) — real custom-field values come from the
    // task's `data` placeholder-key field once the template/custom-field
    // wiring lands (see docs/typebuild-data-field-contract.md). Empty until
    // then so RosterTable/TaskDetailDialog can render custom columns without
    // crashing.
    customValues: {},
    risk: deriveRisk(t),
    raw: t,
  };
}

export function useNewHomeData(projectId?: string | null): {
  tasks: NewHomeTask[];
  counts: Record<NewHomeStatus, number>;
  approvals: NewHomeTask[];
  projects: Project[];
  agents: Agent[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const { tasks: rawTasks, loading, error, refresh } = useTasks({ includeDone: true });
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fm.typebuild.projects
      .list()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    void fm.typebuild.agents
      .list()
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tasks = useMemo(() => {
    const scoped = projectId
      ? rawTasks.filter((t) => t.projectId === projectId)
      : rawTasks;
    const now = Date.now();
    const today = todayKey(now);
    return scoped.map((t) => toNewHomeTask(t, today, now));
  }, [rawTasks, projectId]);

  const counts = useMemo(() => {
    const c: Record<NewHomeStatus, number> = { done: 0, progress: 0, needs: 0, failed: 0 };
    for (const t of tasks) c[t.status] += 1;
    return c;
  }, [tasks]);

  const approvals = useMemo(
    () => tasks.filter((t) => t.status === 'needs' && t.pendingQuestion),
    [tasks],
  );

  return { tasks, counts, approvals, projects, agents, loading, error, refresh };
}
