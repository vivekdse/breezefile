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
//   done      — task.status === 'done'.
//   cancelled — task.status === 'cancelled' (task-c0edffef25c6): a cancelled
//               task was deliberately withdrawn, not a failure — kept OUT of
//               the 'failed' bucket so it doesn't inflate the Failed stat or
//               offer Retry. This is the single derivation point that feeds
//               roster row chips, hero stats, AND (via rosterGroups.mjs
//               statusBucket, which mirrors this mapping) chain-parent
//               breakdown counts — fix here once, all three surfaces agree.
//   failed    — classify().failed (attempts exhausted / rawStatus 'failed').
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getTask, taskSourceAction, useOriginHealth, useTasks } from '../../tasks';
import { fm } from '../../bridge';
import { buildProjectTree, classify, descendantProjectIds, todayKey } from '../../projects/index.mjs';
import { useRunningSessions } from '../tasks/useRunningSessions';
import type { Agent, Project, Task, TaskAuditEvent } from '../../types';
import type { NewHomeStatus, NewHomeTask, TaskDef } from './types';
import { metaStatus as metaStatusOf, parseTaskFieldsBlock, parseTaskTemplateBlock } from './taskSchema.mjs';
import { buildJobValuesByRef, classifyJob, fieldedSchemaSource, partitionJobs, resolveFieldedJob, rewriteTaskFieldsBlock } from './pipelineRoster.mjs';
import { filterByGroup } from './groupScope.mjs';

// task-6c62e6f0905e — deriveStatus and deriveLive share ONE classify() call so
// "is this task an active agent" is never computed two different ways. classify()
// is the SAME pure predicate the Projects attention rollup uses (src/projects/
// attention.mjs), which keys liveness off CLAIM FRESHNESS — the signal of
// record — not a parallel heuristic invented here.
function deriveStatus(t: Task, c: ReturnType<typeof classify>): NewHomeStatus {
  if (t.status === 'done') return 'done';
  // task-c0edffef25c6 — cancelled ≠ failed: a deliberately-withdrawn task
  // must not collapse into 'failed' (inflated Failed stat, spurious Retry).
  // Checked before classify().failed so a cancelled task can never be
  // reclassified 'failed' by an unrelated attempts/rawStatus signal.
  if (t.status === 'cancelled') return 'cancelled';
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
  // task-24cd55d8a607 — audit is a NON-ESSENTIAL per-task enrichment wave. When
  // the origin breaker is open, DEFER it so a slow server only has to serve the
  // core list poll (deriveWho/deriveLastAction fall back to their heuristic in
  // the meantime — a non-regression, exactly the no-audit case). The KEPT audit
  // hints stay in state, so nothing that already resolved disappears.
  const { degraded } = useOriginHealth();
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
    // Origin is slow — hold off the enrichment wave until it recovers.
    if (degraded) return;
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
    // `degraded` gates the wave; when it clears the effect re-runs and the
    // still-`due` tasks (their fetched-at never advanced while deferred) fill in.
  }, [taskKey, tasks, degraded]);

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
    // Group ownership (NON-PHI) for group-scoped relevance filtering.
    groupId: t.groupId ?? null,
    // task-b8fa34a80a34 — forward-compatible template id (undefined until the
    // server ships `template_id` — see mapListRow). The template roster reads
    // it defensively and falls back to (name,project) grouping when absent.
    templateId: t.templateId ?? null,
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
    // whole bag), and (task-b1fa5098da3e) projects no longer declare custom
    // fields to eagerly probe for in the first place. customValues stays {}
    // here (list-scope).
    customValues: {},
    risk: deriveRisk(t),
    live,
    raw: t,
  };
}

export function useNewHomeData(
  projectId?: string | null,
  opts?: { includeArchived?: boolean; groupId?: string | null },
): {
  tasks: NewHomeTask[];
  counts: Record<NewHomeStatus, number>;
  approvals: NewHomeTask[];
  projects: Project[];
  agents: Agent[];
  /** The distinct GROUP ids present across the (project-scoped) task set, each
   *  with how many tasks it owns — the input a future group picker narrows on.
   *  NON-PHI (opaque group ids + counts). Empty when nothing is group-scoped. */
  groups: { id: string; count: number }[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  refreshProjects: () => Promise<void>;
} {
  const { tasks: rawTasks, loading, error, refresh } = useTasks({ includeDone: true });
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  // task-6c62e6f0905e — locally-open sessions for the `live` derivation below.
  const runningSessions = useRunningSessions();
  // task-1af4f59428eb (Item 2) — best-effort per-task audit overlay for
  // authoritative who/lastAction (see useLatestAuditByTask below).
  const auditByTask = useLatestAuditByTask(rawTasks);
  const includeArchived = !!opts?.includeArchived;

  // task-a9841cfc0e1b — project CRUD UI needs to re-pull the registry right
  // after a create/update/archive/delete so the picker + hero update IN
  // PLACE (no full-page reload, no NewHomePage remount — which would also
  // trip the task-fd5b93809b1b selection-persistence remount path). Pulled
  // out of the mount-only effect below so callers can invoke it on demand;
  // the mount effect below just calls it once. Re-created when the "show
  // archived" toggle flips so a caller's refreshProjects() always reflects
  // the CURRENT toggle state, not a stale closure.
  const loadProjects = useCallback(async () => {
    try {
      const list = await fm.typebuild.projects.list(includeArchived);
      setProjects(list);
    } catch {
      // task-24cd55d8a607 — CORE UX BUG FIX: during a slow episode this fetch
      // times out. Clearing to [] collapsed the picker to "All projects" and
      // destroyed the project tree + group scoping — the stripped-down view
      // that LOOKS like data loss. RETAIN the last-known projects instead; the
      // roster keeps its cached tasks (useTasks does the same on poll failure),
      // so the whole surface persists through the episode and refills on recovery.
    }
  }, [includeArchived]);

  // Re-fetches whenever the "show archived" toggle flips, in addition to
  // mount — loadProjects' own identity changes with includeArchived (see
  // above), so this stays in sync without a separate flag.
  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    let cancelled = false;
    void fm.typebuild.agents
      .list()
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch(() => {
        // task-24cd55d8a607 — retain the last-known agents through a slow
        // episode rather than blanking assignee names to []; refills on recovery.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // task-c82d8e0f4eae — SUBTREE aggregation. Scoping on a bare
  // `t.projectId === projectId` made a parent project (or any project with
  // subprojects that hold the actual tasks) render an empty roster — whole
  // subtrees were invisible. A selected project now scopes to its ENTIRE
  // descendant subtree (descendantProjectIds over the same tree the picker
  // nests with); "All projects" (projectId null) stays the unscoped roster.
  const scopeIds = useMemo(() => {
    if (!projectId) return null;
    return descendantProjectIds(buildProjectTree(projects), projectId);
  }, [projectId, projects]);

  // Group scope (relevance filter): when a group is selected, narrow to tasks
  // owned by it. Applied AFTER project scoping and BEFORE mapping so counts +
  // sections + roster all reflect the scoped set consistently. null/undefined =
  // no group scope (every group). This is a DISPLAY filter — the source cache
  // stays complete, so no other surface loses data.
  const groupId = opts?.groupId ?? null;

  const tasks = useMemo(() => {
    const projectScoped = scopeIds
      ? rawTasks.filter((t) => t.projectId != null && scopeIds.has(t.projectId))
      : rawTasks;
    // Group scope via the pure, unit-tested predicate (groupScope.mjs) — a
    // null groupId ("All groups") returns the list unchanged.
    const scoped = filterByGroup(projectScoped, groupId);
    const now = Date.now();
    const today = todayKey(now);
    return scoped.map((t) =>
      toNewHomeTask(t, today, now, runningSessions, auditByTask.get(t.id)),
    );
  }, [rawTasks, scopeIds, groupId, runningSessions, auditByTask]);

  // The distinct groups present in the PROJECT-scoped set (before the group
  // filter itself), each with a task count — the menu a group picker offers.
  // Derived off the raw project-scoped rows so selecting a group doesn't shrink
  // the very list the picker is built from.
  const groups = useMemo(() => {
    const base = scopeIds
      ? rawTasks.filter((t) => t.projectId != null && scopeIds.has(t.projectId))
      : rawTasks;
    const counts = new Map<string, number>();
    for (const t of base) {
      const g = t.groupId;
      if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count);
  }, [rawTasks, scopeIds]);

  const counts = useMemo(() => {
    // task-c0edffef25c6 — `cancelled` counted separately from `failed` so the
    // Failed hero stat/filter never includes a deliberately-withdrawn task.
    const c: Record<NewHomeStatus, number> = {
      done: 0,
      progress: 0,
      queued: 0,
      needs: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const t of tasks) c[t.status] += 1;
    return c;
  }, [tasks]);

  const approvals = useMemo(
    () => tasks.filter((t) => t.status === 'needs' && t.pendingQuestion),
    [tasks],
  );

  return {
    tasks,
    counts,
    approvals,
    projects,
    agents,
    groups,
    loading,
    error,
    refresh,
    refreshProjects: loadProjects,
  };
}

// ─── chained roster: lazy per-job own-body + child resolution ──────────────
// (task-a4397184def4 T5, reworked task-b1fa5098da3e R3)
//
// task-b1fa5098da3e (R3) — a "chained task" is no longer a project-level
// concept (there is no more project TemplateConfig.taskDefs to gate on): a
// top-level task with children is a JOB exactly when ITS OWN body parses a v2
// ```task-template block (docs/task-templates-design.md, "Removed/superseded"
// — the chain rides the parent task, not a project pref). Since a job's own
// body is `notes: null` at LIST scope too (see below), this hook fetches BOTH
// a candidate job's own detail (to learn whether/what it's chained) AND, once
// known chained, its children's details — the same lazy, cached-by-
// updated_at pattern throughout this file.
//
// Each job's pipeline cells need the INPUT values (child body ```task-fields
// block) and OUTPUT values (child `{type:'fields'}` result) of its children —
// but BOTH are absent at LIST scope: the TypeBuild source's mapListRow sets
// `notes: null` and carries no `result` (they only arrive via getTask / a
// detail fetch — see electron/sources/typebuild.ts). So this hook fetches
// DETAILS lazily and on demand — scoped to the currently-VISIBLE candidate
// jobs (and, once resolved chained, their children) — caches them in memory,
// and derives each job's `defs`/`valuesByRef` from the cache.
//
// It reads the FULL task list itself (useTasks, not the parent's already
// status/search-FILTERED `tasks` prop) so a job's DONE children (which a
// "Needs me" filter would hide) still resolve — a child dropped by the roster
// filter must not blank out the pipeline it belongs to.
//
// PHI (docs/typebuild-data-field-contract.md): fetched bodies/results and the
// derived values are DECRYPTED task content — held in this hook's React state
// (memory only), never logged or persisted, and cleared when the component
// unmounts. Same discipline as useLatestAuditByTask.
const PIPELINE_FETCH_CONCURRENCY = 4;
// task-6a14190fb2f7 — how often to force-refetch an ACTIVE chained job's
// children (see the "root cause" comment on the poll effect below). Short
// enough that a completed step's chip/auto-continue surfaces promptly
// without waiting on the 30s system TypeBuild poll; long enough that it
// isn't a meaningfully heavier request load than that poll already is.
const CHAIN_ACTIVE_POLL_MS = 5_000;

/** One candidate job's resolved chain data.
 *  - `status: 'loading'` — the job's OWN body hasn't been fetched yet, so we
 *    don't yet know whether it's chained. Callers should render it as a
 *    plain row until this resolves (no flash of an empty subtable).
 *  - `status: 'plain'` — the job's own body carries no v2 task-template block
 *    (or a v1-legacy one, or none), AND it has no server output_schema / legacy
 *    ```task-outputs block either — genuinely nothing to show; render a plain
 *    row.
 *  - `status: 'fielded'` (task-ce4b4c8ca955) — a TOP-LEVEL, NON-chained task
 *    (no v2 task-template block) that nonetheless declares output fields —
 *    either the server's first-class `output_schema` (preferred) or its own
 *    legacy ```task-outputs body block — and has a result to show for them.
 *    Rendered as a ONE-DEF subtable (reusing the exact chained-subtable
 *    machinery: `defs` has exactly one synthetic TaskDef, `childIdByDefId`
 *    points the def at the JOB ITSELF so a cell click opens the task, not a
 *    child). This is the "single-task output fields" case
 *    (task-73384d8e26e1/task-7d65e61fb581) that previously fell through to
 *    'plain' and rendered no output column at all.
 *  - `status: 'chained'` — `defs`/`groups` are non-empty; render a subtable.
 *  `childrenLoading` stays true until every child's detail has been fetched
 *  (cells show an em-dash placeholder until then). */
export type ChainedJobResolution =
  | { status: 'loading' }
  | { status: 'plain' }
  | {
      status: 'fielded';
      name: string;
      defs: TaskDef[];
      valuesByRef: Record<string, string | number>;
      childIdByDefId: Record<string, string>;
      childrenLoading: false;
    }
  | {
      status: 'chained';
      name: string;
      defs: TaskDef[];
      valuesByRef: Record<string, string | number>;
      childIdByDefId: Record<string, string>;
      childrenLoading: boolean;
    };

// task-ce4b4c8ca955 (round-18 fix) — the fetched detail ALSO carries the
// server's first-class `outputSchema`. The list-row mapping (mapListRow) never
// sets outputSchema (the list has no body), so a top-level DONE single-task's
// schema is ONLY available on the getTask/mapDetail path — exactly the detail
// we already fetch here. resolveJob's 'fielded' case must read it from THIS
// cache, not from the schema-less list row, or a server-schema'd task falls
// through to 'plain' (the round-18 regression: all three fielded fixtures
// rendered as plain rows). NON-PHI: field DEFINITIONS only, never values.
type TaskDetail = {
  notes: string | null;
  result: unknown;
  outputSchema?: import('../../types').Task['outputSchema'];
  // Input data-bag KEYS (names only, never values — NON-PHI). Detail-only,
  // same as outputSchema: mapListRow never sets dataKeys, so the roster's
  // template grouping (RosterTable groupableInputs → rosterGroups.mjs) can
  // only learn a task's input fields from THIS fetch. Without it an
  // input-only template instance (dataKeys but no outputSchema) classifies
  // plain and never groups under its template header.
  dataKeys?: string[];
};

export function useChainedRoster(opts: { jobIds: string[] }): {
  resolveJob: (jobId: string) => ChainedJobResolution;
  saveInput: (childId: string, key: string, value: string) => Promise<{ ok: boolean; error?: string }>;
  /** Input data-bag KEY NAMES from the fetched detail (NON-PHI; null until
   *  that job's detail lands). The list row never carries dataKeys, so this
   *  is the roster's only source for input-field grouping. */
  dataKeysFor: (jobId: string) => string[] | null;
} {
  const { jobIds } = opts;
  // Full, UNFILTERED roster — independent of the parent's filtered `tasks`
  // prop, so a job's children in any status resolve (see header note).
  const { tasks: fullTasks } = useTasks({ includeDone: true });
  // task-24cd55d8a607 — the per-row getTask detail fetches (job own-body +
  // children) and the fast active-chain poll are the heaviest per-item
  // enrichment wave. DEFER them while the origin breaker is open so a slow
  // server only serves the core list poll; already-fetched details stay cached
  // (the matrix keeps rendering last-known cells), and the waves resume when the
  // breaker closes. This is exactly the "pile-up on every 30s poll" the fix targets.
  const { degraded } = useOriginHealth();

  // Fetched task bodies/results, keyed by task id — holds BOTH candidate
  // jobs' own details and (once known chained) their children's details;
  // one cache, one fetch pattern (memory only, PHI).
  const [details, setDetails] = useState<Map<string, TaskDetail>>(new Map());
  // updated_at we last fetched a task at — the refetch key (ref, not state).
  const fetchedAtRef = useRef<Map<string, number>>(new Map());

  // Stable job-id set (the array identity changes every parent render).
  const jobIdKey = useMemo(() => [...jobIds].sort().join(','), [jobIds]);

  const byIdTask = useMemo(() => new Map(fullTasks.map((t) => [t.id, t])), [fullTasks]);

  // parentId → child Task[], over the FULL roster.
  const childrenByParent = useMemo(() => {
    const map = new Map<string, Task[]>();
    const { childrenByParent: byId } = partitionJobs(
      fullTasks.map((t) => ({ id: t.id, parentTaskId: t.parentTaskId ?? null })),
    );
    for (const [parent, ids] of Object.entries(byId)) {
      map.set(
        parent,
        ids.map((id) => byIdTask.get(id)).filter((t): t is Task => !!t),
      );
    }
    return map;
  }, [fullTasks, byIdTask]);

  const visibleJobs = useMemo(
    () => (jobIdKey ? jobIdKey.split(',') : []).map((id) => byIdTask.get(id)).filter((t): t is Task => !!t),
    [jobIdKey, byIdTask],
  );

  // Stage 1 — fetch each candidate job's OWN detail (to parse its v2 block).
  const jobKey = useMemo(
    () => visibleJobs.map((t) => `${t.id}:${t.updated_at}`).join(','),
    [visibleJobs],
  );

  useEffect(() => {
    let cancelled = false;
    if (degraded) return; // origin slow — defer job-detail enrichment
    const due = visibleJobs.filter((t) => fetchedAtRef.current.get(t.id) !== t.updated_at);
    if (due.length === 0) return;

    void (async () => {
      let idx = 0;
      const results: Array<[string, number, TaskDetail | null]> = [];
      async function worker() {
        while (idx < due.length) {
          const t = due[idx++];
          try {
            const full = await getTask(t.id, t.source);
            // task-ce4b4c8ca955 (round-18) — capture the server outputSchema
            // from the DETAIL fetch (mapListRow never sets it) so resolveJob's
            // 'fielded' case can read it. NON-PHI (field defs only).
            results.push([
              t.id,
              t.updated_at,
              full
                ? {
                    notes: full.notes,
                    result: full.result ?? null,
                    outputSchema: full.outputSchema,
                    dataKeys: full.dataKeys,
                  }
                : null,
            ]);
          } catch {
            results.push([t.id, t.updated_at, null]);
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(PIPELINE_FETCH_CONCURRENCY, due.length) }, () => worker()),
      );
      // task-8b43f588e3a9 (cold-load flicker, fix 1 — EAGER RESOLUTION) — mark
      // fetchedAtRef ONLY after a successful commit, never before the await.
      // The old code set fetchedAtRef optimistically at the top of the worker;
      // if this effect run was then SUPERSEDED mid-flight (a sibling useTasks
      // update re-identities `visibleJobs`, re-running this effect while the
      // getTask calls were still in flight), the `if (cancelled) return` below
      // discarded the results — but the ids were already marked fetched, so the
      // superseding run saw due=[] and NEVER re-fetched. Resolution then sat on
      // 'loading' until the row's updated_at moved (a 30s poll, or a user
      // interaction's refresh) — the reported "resolution only starts after a
      // row interaction" cold-load stall. Now a superseded run leaves
      // fetchedAtRef untouched, so the next run re-fetches and commits (at worst
      // one transient duplicate fetch during rapid cold-load re-renders).
      if (cancelled) return;
      for (const [id, updatedAt, detail] of results) {
        if (detail) fetchedAtRef.current.set(id, updatedAt);
      }
      setDetails((prev) => {
        const next = new Map(prev);
        for (const [id, , detail] of results) {
          if (detail) next.set(id, detail);
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [jobKey, visibleJobs, degraded]);

  // Which visible jobs are known-chained (v2 block, defs present) once their
  // own detail has landed.
  const chainedJobIds = useMemo(() => {
    const out: string[] = [];
    for (const t of visibleJobs) {
      const detail = details.get(t.id);
      if (!detail) continue;
      const parsed = parseTaskTemplateBlock(detail.notes ?? null);
      if (parsed?.defs && parsed.defs.length > 0) out.push(t.id);
    }
    return out;
  }, [visibleJobs, details]);
  const chainedJobIdKey = useMemo(() => [...chainedJobIds].sort().join(','), [chainedJobIds]);

  // Stage 2 — the children of chained jobs only — the rows we detail-fetch
  // to resolve their pipeline cells.
  const visibleChildren = useMemo(() => {
    const out: Task[] = [];
    for (const jobId of chainedJobIdKey ? chainedJobIdKey.split(',') : []) {
      for (const c of childrenByParent.get(jobId) ?? []) out.push(c);
    }
    return out;
  }, [chainedJobIdKey, childrenByParent]);

  const childKey = useMemo(
    () => visibleChildren.map((c) => `${c.id}:${c.updated_at}`).join(','),
    [visibleChildren],
  );

  useEffect(() => {
    let cancelled = false;
    if (degraded) return; // origin slow — defer child-detail enrichment
    const due = visibleChildren.filter(
      (c) => fetchedAtRef.current.get(c.id) !== c.updated_at,
    );
    if (due.length === 0) return;

    void (async () => {
      let idx = 0;
      const results: Array<[string, number, TaskDetail | null]> = [];
      async function worker() {
        while (idx < due.length) {
          const c = due[idx++];
          try {
            const full = await getTask(c.id, c.source);
            results.push([
              c.id,
              c.updated_at,
              full ? { notes: full.notes, result: full.result ?? null } : null,
            ]);
          } catch {
            // Signed out / offline / server error — leave this child unresolved;
            // its cells show the loading em-dash and retry on the next change.
            results.push([c.id, c.updated_at, null]);
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(PIPELINE_FETCH_CONCURRENCY, due.length) }, () => worker()),
      );
      // task-8b43f588e3a9 (fix 1) — same deferred fetchedAtRef marking as the
      // Stage-1 effect above: mark ONLY on a committed result so a superseded
      // run can't strand children as "fetched" and stall their resolution.
      if (cancelled) return;
      for (const [id, updatedAt, detail] of results) {
        if (detail) fetchedAtRef.current.set(id, updatedAt);
      }
      setDetails((prev) => {
        const next = new Map(prev);
        for (const [id, , detail] of results) {
          if (detail) next.set(id, detail);
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [childKey, visibleChildren, degraded]);

  // task-6a14190fb2f7 — ROOT CAUSE of "chain stops, nothing surfaces": the
  // child-detail refetch above is keyed ONLY off the list row's `updated_at`,
  // which only moves once useTasks re-pulls the list — and that re-pull is
  // driven by the TypeBuild source's 30s background poll (electron/sources/
  // typebuild.ts POLL_INTERVAL_MS) or an explicit user action's `refresh()`.
  // So right after a step completes server-side, the roster can sit on stale
  // valuesByRef for up to ~30s with NOTHING to prompt a re-check — the exact
  // "nothing starts or offers step 2" symptom. Rather than shortening the
  // whole-app system poll (a much bigger blast radius), this hook runs its
  // OWN short poll scoped to just the children that matter: while a chained
  // job is still non-terminal, periodically force-refetch its children's
  // details directly (bypassing the updated_at gate, since the LIST row's
  // updated_at is exactly what's lagging). A terminal job stops being polled
  // — no unbounded background chatter once a chain finishes.
  const anyChainActive = useMemo(() => {
    for (const jobId of chainedJobIdKey ? chainedJobIdKey.split(',') : []) {
      const jobDetail = details.get(jobId);
      if (!jobDetail) continue;
      const parsed = parseTaskTemplateBlock(jobDetail.notes ?? null);
      if (!parsed?.defs || parsed.defs.length === 0) continue;
      const children = childrenByParent.get(jobId) ?? [];
      const merged = children.map((c) => {
        const d = details.get(c.id);
        return { id: c.id, notes: d?.notes ?? c.notes ?? null, result: d?.result ?? c.result ?? null };
      });
      const { valuesByRef } = buildJobValuesByRef(merged);
      if (metaStatusOf(parsed.defs, valuesByRef) !== 'done') return true;
    }
    return false;
  }, [chainedJobIdKey, details, childrenByParent]);

  useEffect(() => {
    // Also suspended while the origin breaker is open — the fast poll is the
    // single heaviest recurring wave, so it's the first thing to stop.
    if (degraded || !anyChainActive || visibleChildren.length === 0) return;
    const timer = setInterval(() => {
      void (async () => {
        const targets = visibleChildren;
        const results: Array<[string, TaskDetail | null]> = [];
        let idx = 0;
        async function worker() {
          while (idx < targets.length) {
            const c = targets[idx++];
            try {
              const full = await getTask(c.id, c.source);
              results.push([c.id, full ? { notes: full.notes, result: full.result ?? null } : null]);
            } catch {
              // Best-effort fast poll — leave the child at its last-known
              // state and retry on the next tick.
            }
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(PIPELINE_FETCH_CONCURRENCY, targets.length) }, () => worker()),
        );
        if (results.length === 0) return;
        setDetails((prev) => {
          const next = new Map(prev);
          for (const [id, detail] of results) {
            if (detail) next.set(id, detail);
          }
          return next;
        });
      })();
    }, CHAIN_ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [anyChainActive, visibleChildren, degraded]);

  const resolveJob = useCallback(
    (jobId: string): ChainedJobResolution => {
      const jobDetail = details.get(jobId);
      const jobChildren = childrenByParent.get(jobId) ?? [];
      const parsed = parseTaskTemplateBlock(jobDetail?.notes ?? null);
      const job = byIdTask.get(jobId);
      // 'fielded' is a CHILDLESS single-task case — synthesize it only when
      // the task has no children grouped under it (classifyJob enforces the
      // same guard, but we skip the work when it can't apply). task-ce4b4c8ca955.
      const fielded =
        jobDetail && jobChildren.length === 0
          ? resolveFieldedJob({
              id: jobId,
              name: job?.title ?? jobId,
              // ROUND-18 FIX: the server outputSchema lives on the DETAIL fetch
              // (jobDetail), NOT the list row — mapListRow never sets it. Reading
              // job?.outputSchema (the list row) was ALWAYS undefined, so a
              // server-schema'd single task with no body block fell through to
              // 'plain'. fieldedSchemaSource prefers the fetched detail's schema;
              // the list row is a harmless (undefined today) fallback.
              outputSchema: fieldedSchemaSource(jobDetail, job),
              notes: jobDetail.notes,
              result: jobDetail.result,
            })
          : null;

      // Single pure source of truth for the four-way classification. The order
      // (loading → chained → container-is-plain → fielded → plain) is what keeps
      // a chain parent from ever being mis-classified 'fielded' (the d443423
      // regression) and its children from leaking out as top-level rows.
      const cls = classifyJob({
        hasDetail: !!jobDetail,
        parsedDefs: parsed?.defs ?? null,
        childCount: jobChildren.length,
        fielded,
      });
      if (cls.status === 'loading' || cls.status === 'plain') return cls;
      if (cls.status === 'fielded') return { ...cls, childrenLoading: false };

      // 'chained' — fold this parent's (real) children into one valuesByRef.
      const children = jobChildren;
      // Prefer the fetched detail (real notes/result); fall back to whatever
      // the list row carries (today always null) so an unfetched child simply
      // contributes nothing.
      const merged = children.map((c) => {
        const d = details.get(c.id);
        return { id: c.id, notes: d?.notes ?? c.notes ?? null, result: d?.result ?? c.result ?? null };
      });
      const { valuesByRef, childIdByDefId } = buildJobValuesByRef(merged);
      const childrenLoading = children.some((c) => !details.has(c.id));
      return {
        status: 'chained',
        name: parsed?.name ?? jobId,
        defs: parsed?.defs ?? [],
        valuesByRef,
        childIdByDefId,
        childrenLoading,
      };
    },
    [childrenByParent, details, byIdTask],
  );

  const saveInput = useCallback(
    async (childId: string, key: string, value: string): Promise<{ ok: boolean; error?: string }> => {
      const detail = details.get(childId);
      const child = fullTasks.find((t) => t.id === childId);
      const parsed = parseTaskFieldsBlock(detail?.notes ?? null);
      if (!detail || !child || !parsed) {
        return { ok: false, error: 'not ready' };
      }
      // Preserve every other value in the block; overwrite just this one.
      const nextValues: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.values)) nextValues[k] = String(v);
      nextValues[key] = value;
      const newBody = rewriteTaskFieldsBlock(
        detail.notes ?? '',
        parsed.templateId,
        parsed.taskDefId,
        nextValues,
      );
      // Optimistic: reflect the edit immediately, and mark this updated_at as
      // fetched so the impending broadcast doesn't clobber it with a stale
      // (pre-patch) refetch before the server catches up.
      const prev = detail;
      setDetails((m) => {
        const next = new Map(m);
        // task-6b1136a8ff77 — carry `outputSchema` through the optimistic set;
        // dropping it here would blank out a fielded resolution the instant a
        // sibling input is saved (harmless today since children never resolve
        // fielded, but a latent inconsistency with the real detail shape).
        next.set(childId, {
          notes: newBody,
          result: detail.result,
          outputSchema: detail.outputSchema,
          dataKeys: detail.dataKeys,
        });
        return next;
      });
      try {
        await taskSourceAction(child.source ?? 'typebuild', childId, 'patch', { task: newBody });
        return { ok: true };
      } catch (e) {
        // Revert on failure so the cell doesn't show a value the server rejected.
        setDetails((m) => {
          const next = new Map(m);
          next.set(childId, prev);
          return next;
        });
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [details, fullTasks],
  );

  const dataKeysFor = useCallback(
    (jobId: string): string[] | null => details.get(jobId)?.dataKeys ?? null,
    [details],
  );

  return { resolveJob, saveInput, dataKeysFor };
}

// ─── task-b8fa34a80a34 — lazy task DATA-BAG value resolver ──────────────────
// The template-grouped roster's INPUT cells show values from a task's `data`
// bag (docs/typebuild-data-field-contract.md). Those values are NOT on the
// list/detail row — they resolve ONE ref at a time via
// fm.typebuild.taskData.resolve (GET .../data?ref=<key>), by design (never the
// whole bag). This hook fans those per-(taskId,key) reads out with the SAME
// bounded-concurrency + in-memory-cache discipline useLatestAuditByTask /
// useChainedRoster use, so a wide grouped section doesn't issue an unbounded
// burst.
//
// PHI (docs/typebuild-data-field-contract.md): resolved values are DECRYPTED
// task content — held in this hook's React state (memory only), never logged
// or persisted, cleared on unmount. A (taskId,key) is fetched once and cached
// for the hook's lifetime (input values are set at creation and effectively
// immutable for display); the cache never reaches disk.
const TASK_DATA_CONCURRENCY = 4;

export function useTaskDataValues(
  requests: { taskId: string; keys: string[] }[],
): Map<string, Record<string, string>> {
  const [byTask, setByTask] = useState<Map<string, Record<string, string>>>(new Map());
  // task-24cd55d8a607 — per-key data-bag value resolves are a NON-ESSENTIAL
  // enrichment wave; defer them while the origin breaker is open. Already-
  // resolved values stay in state (input cells keep their last-known value).
  const { degraded } = useOriginHealth();
  // "taskId\0key" pairs we've already resolved (or attempted) — the cache/dedupe
  // key. A ref (not state) since it's bookkeeping, not a render input.
  const fetchedRef = useRef<Set<string>>(new Set());

  // Stable dep: sorted (taskId, keys) pairs joined, so the effect only re-runs
  // when the SET of requested refs actually changes — not on every render (the
  // `requests` array identity is fresh each parent render).
  const reqKey = useMemo(
    () =>
      requests
        .map((r) => `${r.taskId}:${[...r.keys].sort().join('|')}`)
        .sort()
        .join(','),
    [requests],
  );

  useEffect(() => {
    let cancelled = false;
    if (degraded) return; // origin slow — defer data-bag value resolves
    const due: { taskId: string; key: string }[] = [];
    for (const r of requests) {
      for (const k of r.keys) {
        const cacheKey = `${r.taskId} ${k}`;
        if (!fetchedRef.current.has(cacheKey)) due.push({ taskId: r.taskId, key: k });
      }
    }
    if (due.length === 0) return;

    void (async () => {
      let idx = 0;
      const results: Array<[string, string, string | null]> = [];
      async function worker() {
        while (idx < due.length) {
          const { taskId, key } = due[idx++];
          fetchedRef.current.add(`${taskId} ${key}`);
          try {
            const value = await fm.typebuild.taskData.resolve(taskId, key);
            results.push([taskId, key, value]);
          } catch {
            // Signed out / offline / no value — leave the cell empty; the input
            // column simply renders an em-dash for this ref.
            results.push([taskId, key, null]);
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(TASK_DATA_CONCURRENCY, due.length) }, () => worker()),
      );
      if (cancelled) return;
      setByTask((prev) => {
        const next = new Map(prev);
        for (const [taskId, key, value] of results) {
          if (value == null || value === '') continue;
          const rec = { ...(next.get(taskId) ?? {}) };
          rec[key] = value;
          next.set(taskId, rec);
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
    // reqKey encodes the full content of `requests`; re-run when it moves OR
    // when the origin breaker clears (`degraded`) so deferred resolves resume.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey, degraded]);

  return byTask;
}
