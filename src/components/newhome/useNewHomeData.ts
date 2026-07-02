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
//   progress — ONLY a task an agent is actively on: status 'in_progress'
//              with a live worker (a stalled in_progress row lands in
//              'needs' via classify().stalled above).
//   queued   — everything else still open (status 'pending' — created but
//              not claimed/being worked). classify().overdue is folded into
//              'queued' here — New Home doesn't have a due-date lane yet;
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
  // "In Progress" means an agent is actively on it — a live in_progress
  // claim (stalled claims were already routed to 'needs' above). A pending,
  // unclaimed task is merely queued.
  return t.status === 'in_progress' ? 'progress' : 'queued';
}

/** Compact relative age for the roster's Last Action column: "10m", "2h",
 *  "5d" (task feedback: a time, not a status). "now" under a minute. */
function compactAgo(ms: number, now: number): string {
  const abs = Math.max(0, now - ms);
  if (abs < 60_000) return 'now';
  if (abs < 3600_000) return `${Math.round(abs / 60_000)}m`;
  if (abs < 86_400_000) return `${Math.round(abs / 3600_000)}h`;
  return `${Math.round(abs / 86_400_000)}d`;
}

/** Epoch ms of the newest activity signal on the task, or null. */
function deriveLastActionAt(t: Task): number | null {
  const stamps: (string | null | undefined)[] = [
    t.messages?.at(-1)?.at,
    t.pending_question?.asked_at,
    t.updatedAtIso,
    t.claimedAt,
    t.createdAtIso,
  ];
  let best: number | null = null;
  for (const s of stamps) {
    if (!s) continue;
    const ms = Date.parse(s);
    if (!Number.isNaN(ms) && (best === null || ms > best)) best = ms;
  }
  return best;
}

// TODO(New Home follow-up) — `messages[].by` is documented only as "an email
// principal" (see src/types.ts) with no agent-vs-human tag, and there's no
// `runs`/audit trail embedded on Task (the real per-task audit feed is a
// separate fetch — fm.typebuild.audit — not cross-referenced here yet). Until
// that's threaded through, we approximate authorship by comparing `by`
// against the human identities we DO know (`assignedTo`, `pending_question
// .asked_by`) — a message from a known-human address is a human action,
// anything else (an agent's own identity, a system string) is treated as an
// agent action. This is still best-effort, not authoritative.
function isHumanPrincipal(by: string | undefined | null, t: Task): boolean {
  if (!by) return false;
  if (t.assignedTo && by === t.assignedTo) return true;
  if (t.createdBy && by === t.createdBy) return true;
  if (t.pending_question?.asked_by && by === t.pending_question.asked_by) return true;
  return false;
}

function deriveWho(t: Task): NewHomeTask['who'] {
  // A live pending question means the ball is with a human right now,
  // regardless of who acted before it.
  if (t.pending_question) return 'human';
  const msgs = t.messages ?? [];
  if (msgs.length > 0) {
    const sawHuman = msgs.some((m) => isHumanPrincipal(m.by, t));
    const sawAgent = msgs.some((m) => !isHumanPrincipal(m.by, t));
    if (sawHuman && sawAgent) return 'both';
    if (sawHuman) return 'human';
    return 'agent';
  }
  if (t.claimedBy || t.status === 'in_progress') return 'agent';
  return 'agent';
}

function deriveLastAction(t: Task): string {
  // TODO(New Home follow-up) — swap for a real audit-trail line once
  // fm.typebuild.audit is threaded through here; this is a best-effort
  // summary from whatever's already on the task object, newest-first
  // preference: open question > latest message > claim notes > raw status.
  if (t.pending_question) return `Asked: ${t.pending_question.text}`;
  const lastMsg = t.messages?.at(-1);
  if (lastMsg) {
    const actor = isHumanPrincipal(lastMsg.by, t) ? 'Reply' : 'Update';
    return `${actor}: ${lastMsg.text}`;
  }
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
  const lastActionAt = deriveLastActionAt(t);
  return {
    id: t.id,
    title: t.title,
    status: deriveStatus(t, today, now),
    projectId: t.projectId ?? null,
    lastAction: lastActionAt === null ? '—' : compactAgo(lastActionAt, now),
    lastActionAt,
    lastActionDetail: deriveLastAction(t),
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
    const c: Record<NewHomeStatus, number> = { done: 0, progress: 0, queued: 0, needs: 0, failed: 0 };
    for (const t of tasks) c[t.status] += 1;
    return c;
  }, [tasks]);

  const approvals = useMemo(
    () => tasks.filter((t) => t.status === 'needs' && t.pendingQuestion),
    [tasks],
  );

  return { tasks, counts, approvals, projects, agents, loading, error, refresh };
}
