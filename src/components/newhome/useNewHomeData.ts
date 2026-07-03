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
// `who` derivation prefers the per-task AUDIT trail (fm.typebuild.audit /
// getAudit — task-1af4f59428eb, Item 2) when we have it: the audit's latest
// event `user` (actor) is a SERVER-RECORDED fact, not an inference, so it is
// AUTHORITATIVE over the message-authorship heuristic below. Audit doesn't
// itself tag an actor agent-vs-human either — the server records an identity,
// same as `messages[].by` — so we still classify that identity via
// isHumanPrincipal (assignedTo/createdBy/asked_by), but the ACTOR we classify
// now comes from the trail of record instead of being guessed from whichever
// side happened to leave a `messages[]` row. Falls back to the original
// heuristic (below) whenever the audit fetch hasn't landed yet / is empty /
// unavailable (signed out, offline, older deployment) — additive, never
// regresses the no-audit case:
//   'human' when a pending_question is open (the ball is with a human) —
//           unchanged, checked before audit since it's the loudest signal.
//   otherwise, with audit: the LATEST audit event's actor classified via
//           isHumanPrincipal — 'human' or 'agent' (audit gives us one actor
//           per event, not a two-sided transcript, so 'both' is not derived
//           from audit; it stays a messages[]-only case, below).
//   without audit (fallback, original heuristic): 'agent' when actively
//           claimed/in-progress with no question, 'both' when there's message
//           history from both sides (best-effort authorship-by-known-identity),
//           else 'agent' by default.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTasks } from '../../tasks';
import { fm } from '../../bridge';
import { classify, todayKey } from '../../projects/index.mjs';
import { useRunningSessions } from '../tasks/useRunningSessions';
import type { Agent, Project, Task, TaskAuditEvent } from '../../types';
import type { NewHomeStatus, NewHomeTask, TemplateField } from './types';

// task-6c62e6f0905e — deriveStatus and deriveLive share ONE classify() call so
// "is this task an active agent" is never computed two different ways. classify()
// is the SAME pure predicate the Projects attention rollup uses (src/projects/
// attention.mjs), which keys liveness off CLAIM FRESHNESS — the signal of
// record — not a parallel heuristic invented here.
function deriveStatus(t: Task, c: ReturnType<typeof classify>): NewHomeStatus {
  if (t.status === 'done') return 'done';
  if (t.status === 'cancelled') return 'failed';
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

// task-1af4f59428eb (Item 2) — the minimal, NON-PHI slice of a task's audit
// trail this module needs: just the latest event's actor + action label.
// Audit rows are NON-PHI by design (server never puts task text in `detail`);
// we keep only what deriveWho/deriveLastAction use, not the raw
// TaskAuditEvent[], so this stays a small, purpose-built hint, not a body cache.
export type LatestAudit = { actor: string | null; action: string | null; at: string | null };

function deriveWho(t: Task, audit?: LatestAudit): NewHomeTask['who'] {
  // A live pending question means the ball is with a human right now,
  // regardless of who acted before it.
  if (t.pending_question) return 'human';
  // Prefer the audit trail's actor for the latest event — a server-recorded
  // fact, not an inference from whichever side happened to leave a message.
  if (audit?.actor) {
    return isHumanPrincipal(audit.actor, t) ? 'human' : 'agent';
  }
  // Fallback: the original messages[]-authorship heuristic (audit
  // unavailable/empty/not yet loaded — signed out, offline, older deployment,
  // or just no messages/audit rows on this task).
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

// Audit action → a short verb for the Last Action line, mirroring
// src/components/tasks/lifecycle.mjs's ACTION_LABEL vocabulary (kept
// independent/local — that file is presentation-cased for the Timeline UI;
// this wants a terse lowercase verb for the roster tooltip/line).
const AUDIT_VERB: Record<string, string> = {
  create: 'created',
  created: 'created',
  claim: 'claimed',
  claimed: 'claimed',
  reclaim: 're-claimed',
  renew: 'claim renewed',
  renewed: 'claim renewed',
  release: 'released',
  released: 'released',
  done: 'completed',
  complete: 'completed',
  completed: 'completed',
  partial: 'partially completed',
  fail: 'failed',
  failed: 'failed',
  block: 'blocked',
  blocked: 'blocked',
  cancel: 'cancelled',
  cancelled: 'cancelled',
  reopen: 'reopened',
  reopened: 'reopened',
  start: 'started',
  in_progress: 'started work',
};

function deriveLastAction(t: Task, audit?: LatestAudit): string {
  // An open question is still the loudest signal, regardless of audit.
  if (t.pending_question) return `Asked: ${t.pending_question.text}`;
  // Prefer the audit trail's latest event when we have one: audit gives an
  // AUTHORITATIVE actor for a lifecycle action ("claimed", "released", ...),
  // which the message transcript doesn't carry at all.
  if (audit?.action) {
    const verb = AUDIT_VERB[audit.action.toLowerCase()] ?? audit.action;
    const who = isHumanPrincipal(audit.actor, t) ? 'Reply' : 'Update';
    // Keep the SAME "Actor: text" shape the roster/tooltip already renders,
    // substituting the audit verb for message text (audit `detail` is
    // NON-PHI action metadata only, never task text).
    return `${who}: ${verb}`;
  }
  // Fallback: original best-effort summary from whatever's already on the
  // task object (audit unavailable/empty/not yet loaded).
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

/** Newest-first audit rows (per getAudit's contract) → this module's
 *  LatestAudit hint, or undefined for an empty/malformed list. */
function toLatestAudit(events: TaskAuditEvent[]): LatestAudit | undefined {
  const latest = events[0];
  if (!latest) return undefined;
  return { actor: latest.user || null, action: latest.action || null, at: latest.at || null };
}

// task-1af4f59428eb (Item 2) — best-effort, BOUNDED audit overlay for the
// currently-loaded task list. `who`/`lastAction` want the AUTHORITATIVE
// actor of each task's latest audit event (see deriveWho/deriveLastAction
// above); getAudit is a per-task fetch (GET /chromeext/audit?task_id=), so we
// fan it out with a small concurrency cap rather than one Promise.all across
// the whole roster — this is a "make it truthful" enhancement layered over an
// already-working heuristic, not something any render should block on.
//
// Refetch key: a task is re-queried only when its `updated_at` (ms) moves —
// the roster already re-renders every 30s poll even when nothing changed, and
// re-fetching audit for every task on every poll tick would multiply the
// request volume for no benefit. A task whose activity timestamp hasn't
// moved has, definitionally, no new audit row to learn about.
//
// PHI: audit rows are NON-PHI (actor/action/timestamp only — the server never
// puts task text in `detail`); we keep only the LatestAudit projection in
// state, never the raw rows, and never log anything here.
const AUDIT_CONCURRENCY = 4;

function useLatestAuditByTask(tasks: Task[]): Map<string, LatestAudit> {
  const [byTask, setByTask] = useState<Map<string, LatestAudit>>(new Map());
  // Cache of the `updated_at` we last fetched audit for, per task id — the
  // refetch-key described above. A ref (not state) since it's bookkeeping,
  // not something that should itself trigger a render.
  const fetchedAtRef = useRef<Map<string, number>>(new Map());

  // Stable dep: (id, updated_at) pairs joined into one string, so the effect
  // only re-runs when the SET of tasks or their update times actually change
  // — not on every parent re-render (rawTasks is a fresh array each poll).
  const taskKey = useMemo(
    () => tasks.map((t) => `${t.id}:${t.updated_at}`).join(','),
    [tasks],
  );

  useEffect(() => {
    let cancelled = false;
    const due = tasks.filter((t) => fetchedAtRef.current.get(t.id) !== t.updated_at);
    if (due.length === 0) return;

    // Small worker-pool fan-out (AUDIT_CONCURRENCY at a time) rather than one
    // unbounded Promise.all — bounds in-flight requests when a project has a
    // large roster, without adding a new dependency.
    void (async () => {
      let idx = 0;
      const results: Array<[string, LatestAudit | undefined]> = [];
      async function worker() {
        while (idx < due.length) {
          const t = due[idx++];
          fetchedAtRef.current.set(t.id, t.updated_at);
          try {
            const events = await fm.typebuild.audit(t.id, 1);
            results.push([t.id, toLatestAudit(events)]);
          } catch {
            // Signed out / offline / server error — leave this task's audit
            // hint absent; deriveWho/deriveLastAction fall back to the
            // existing heuristic for it.
            results.push([t.id, undefined]);
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(AUDIT_CONCURRENCY, due.length) }, () => worker()),
      );
      if (cancelled) return;
      setByTask((prev) => {
        const next = new Map(prev);
        for (const [id, audit] of results) {
          if (audit) next.set(id, audit);
          else next.delete(id);
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [taskKey, tasks]);

  return byTask;
}

function toNewHomeTask(
  t: Task,
  today: string,
  now: number,
  runningSessions: Map<string, unknown>,
  audit?: LatestAudit,
): NewHomeTask {
  const lastActionAt = deriveLastActionAt(t);
  const c = classify(t, today, now);
  const status = deriveStatus(t, c);
  // task-6c62e6f0905e — `live`: an agent is actively working right now. The
  // 'progress' bucket already IS "in_progress and not stalled" (claim
  // freshness, the signal of record); OR in a locally-open session for this
  // task id (useRunningSessions) as a zero-latency corroborating signal for
  // THIS machine — never a replacement for the server-side claim check, which
  // is what makes the signal trustworthy for OTHER clients/machines too.
  const live = status === 'progress' || runningSessions.has(t.id);
  return {
    id: t.id,
    title: t.title,
    status,
    projectId: t.projectId ?? null,
    lastAction: lastActionAt === null ? '—' : compactAgo(lastActionAt, now),
    lastActionAt,
    // task-1af4f59428eb (Item 2) — `audit` (this task's latest audit event,
    // when we've fetched it — see useLatestAudit below) makes both of these
    // AUTHORITATIVE instead of best-effort; absent/not-yet-loaded degrades to
    // exactly the prior heuristic (NON-REGRESSION).
    lastActionDetail: deriveLastAction(t, audit),
    who: deriveWho(t, audit),
    pendingQuestion: t.pending_question ?? null,
    // task-1af4f59428eb — real custom-field values live in the task's `data`
    // placeholder-key bag (docs/typebuild-data-field-contract.md), resolved
    // ONE KEY AT A TIME via fm.typebuild.taskData.resolve (main → the same
    // resolveTaskDataRef the browser-agent fill path uses). The server does
    // NOT yet expose `data_keys` on list/detail rows (confirmed empty across
    // every mapped field in electron/sources/typebuild.ts — the doc's "only
    // the server side is outstanding" is still true), so there is no way to
    // know WHICH keys a task has without probing, and no bulk-read endpoint —
    // only GET .../data?ref=<key>, one value per call, by design (never the
    // whole bag). Eagerly probing every TemplateField.key for every roster row
    // would mean (tasks × fields) uncached network round-trips on every
    // render, which this codebase avoids for detail-only data (see
    // useLastRun/useTaskRuns below — per-task detail data is fetched lazily,
    // on demand, only for the OPEN task, never eagerly across a list).
    // customValues therefore stays {} here (list-scope, matches today's
    // behavior exactly — NON-REGRESSION); useTaskCustomValues (below) does
    // the real resolution, scoped to the single open task, and
    // TaskDetailDialog merges its result over this empty base for the
    // "Details" grid. RosterTable's custom COLUMNS (which need values across
    // the whole visible roster to render per-row) stay blank until the server
    // ships `data_keys` + a batch-friendly read — the one-ref-per-call
    // contract makes a correct eager roster-wide fill a server-side decision,
    // not a client workaround.
    customValues: {},
    risk: deriveRisk(t),
    live,
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
  // task-6c62e6f0905e — locally-open sessions for the `live` derivation below.
  const runningSessions = useRunningSessions();
  // task-1af4f59428eb (Item 2) — best-effort per-task audit overlay for
  // authoritative who/lastAction (see useLatestAuditByTask below).
  const auditByTask = useLatestAuditByTask(rawTasks);

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
    return scoped.map((t) =>
      toNewHomeTask(t, today, now, runningSessions, auditByTask.get(t.id)),
    );
  }, [rawTasks, projectId, runningSessions, auditByTask]);

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

// ─── per-task custom-field values (task-1af4f59428eb, Item 1) ──────────────
//
// On-demand resolver for ONE task's `data`-backed TemplateField values —
// mirrors the useLastRun/useTaskRuns pattern above (per-task detail data,
// fetched lazily only while a detail view is open, never eagerly across the
// roster). Tries fm.typebuild.taskData.resolve(taskId, field.key) for every
// declared template field key; a field with no matching data entry (the
// common case until the server ships data_keys) resolves to null and is
// simply omitted, so the caller's existing `customValues[key] ?? '—'`
// rendering is unaffected (NON-REGRESSION with the always-empty {} today).
//
// PHI: resolved values are held in this hook's React state (memory only) and
// never logged — same discipline as resolveTaskDataRef/task-data.ts. Cleared
// whenever taskId/fields change or the component unmounts.
export function useTaskCustomValues(
  taskId: string | null,
  fields: TemplateField[],
): Record<string, string> {
  const [values, setValues] = useState<Record<string, string>>({});
  // Stable key so the effect only re-runs when the SET of field keys changes,
  // not on every parent re-render (template.fields is often a fresh array).
  const fieldKeys = useMemo(() => fields.map((f) => f.key).join(' '), [fields]);

  useEffect(() => {
    setValues({});
    if (!taskId || !fieldKeys) return;
    let cancelled = false;
    const keys = fieldKeys.split(' ');
    void Promise.all(
      keys.map(async (key) => {
        try {
          const value = await fm.typebuild.taskData.resolve(taskId, key);
          return [key, value] as const;
        } catch {
          // Never let one bad ref break the others; degrade to "no value".
          return [key, null] as const;
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const [key, value] of pairs) {
        if (typeof value === 'string' && value !== '') next[key] = value;
      }
      setValues(next);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId, fieldKeys]);

  return values;
}
