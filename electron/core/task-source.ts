// TaskSource provider abstraction (fm-b5at.1).
//
// Formalizes the multi-source seam that previously lived piecemeal in
// ipc.ts: a TaskSource is anything that can list/read/mutate/run tasks
// under a stable `id`. The local sqlite store is one source
// (electron/sources/local.ts); TypeBuild's REST API is another, built
// later against this interface. The registry (electron/sources/registry.ts)
// holds the live set; the tasks:* IPC handlers route by source id.
//
// Note: the breezed multi-host aggregation (connectedHosts/remoteRequest)
// stays parallel to this registry — those hosts are not wrapped as
// sources, they're a separate per-machine federation path.

import type { Task, TaskCreate, TaskFilter, TaskUpdate } from '../tasks';

/** What a source can do. The UI gates row affordances on these (same
 *  pattern as PlatformContext capability gating). A capability being off
 *  means the corresponding mutation may throw 'unsupported'. */
export type TaskSourceCapabilities = {
  /** Supports cron / scheduled auto-runs (local does; remote may not). */
  canSchedule: boolean;
  /** Supports source-native claim/release of a task. */
  canClaim: boolean;
  /** Editable in place (title/notes/status/etc.). */
  canEdit: boolean;
  /** Deletable. */
  canDelete: boolean;
  /** Supports creating tasks. The composer gates its target picker on this
   *  (fm-r8vj S5 plumbing). Local + TypeBuild both create. */
  canCreate: boolean;
  /** Bodies are PHI-sensitive — decrypted text must never be persisted
   *  to disk, logs, or notifications. Gates those code paths off. */
  phiSensitive: boolean;
  /** Tasks carry a meaningful filesystem folder (local) vs. a cwd hint
   *  or nothing (remote). */
  hasFolder: boolean;
};

/** Task as it flows across the source seam: the local sqlite shape plus
 *  optional fields a remote source may supply. `folder` is effectively
 *  optional here (remote rows may omit it); the local module keeps its
 *  own validation rules unchanged. */
export type SourcedTask = Omit<Task, 'folder'> & {
  /** Owning source id ('local' | <source id>). Tagged by the registry. */
  source?: string;
  /** Filesystem folder (local) or cwd hint (remote). Optional across the
   *  seam; required where the local module needs it for scheduled runs. */
  folder?: string;
  /** Source-native status before mapping into the local enum
   *  (e.g. 'failed' | 'partial' | 'blocked'). UI renders a badge when it
   *  differs from the mapped `status`. */
  rawStatus?: string;
  priority?: number;
  claimedBy?: string | null;
  // task-b8306d2b85c2 — lifecycle timestamps surfaced for the task timeline /
  // claim-freshness UI. Carried as the server's RAW ISO strings (NON-PHI: time
  // + email principals only, never task text) alongside the numeric created_at/
  // updated_at the local sort uses. `claimedAt` is on the DETAIL endpoint;
  // `createdAtIso`/`updatedAtIso`/`createdBy` are populated only when the
  // server returns them (the list endpoint carries no timestamps). Absent
  // pieces are derived from the audit trail in the UI, never faked.
  claimedAt?: string | null;
  createdAtIso?: string | null;
  updatedAtIso?: string | null;
  createdBy?: string | null;
  // fm-j7w0 (S4) — assignee principal/email (server `assigned_to`). Non-PHI
  // (a user identity); null/undefined when unassigned.
  assignedTo?: string | null;
  attempts?: number;
  maxAttempts?: number;
  flags?: string[];
  // fm-lji6 (S2) — Task API v2 fields. `deferUntil` is a full ISO timestamp
  // (the snooze pill compares it against now); `parentTaskId` is an opaque
  // container id. Detail-only: `dependsOn` / `depsSatisfied` / `blockedBy`
  // (memory-only, opaque non-PHI ids).
  deferUntil?: string | null;
  parentTaskId?: string | null;
  // task-ab1d7955e23f — owning project container (opaque, non-PHI). Optional;
  // present when a task was created into / belongs to a TypeBuild Project.
  projectId?: string | null;
  // task-b8fa34a80a34 — the TEMPLATE this task was instantiated from (opaque,
  // NON-PHI id). FORWARD-COMPATIBLE: the server does not emit `template_id`
  // yet, so mapListRow sets this only when present; until then it's undefined
  // and the New Home roster groups template instances by (name, project).
  templateId?: string | null;
  // task-896f3f7f5e75 — the AGENT assigned to this task (scalar; one per task).
  // `agentId` is the opaque, NON-PHI registry id (server `agent_id`); null/absent
  // when unassigned. `agent` is the RESOLVED agent block inlined by get_task
  // (id + name + group + advisory tools + launch_mode) — present only on the
  // DETAIL path (mapDetail), absent on list rows. Both threaded defensively
  // (pass through when well-shaped) so a task with no agent maps exactly as
  // today (NON-REGRESSION). NON-PHI (an agent identity, not patient data).
  agentId?: string | null;
  agent?: {
    id: string;
    name: string;
    group: string | null;
    tools: string[];
    launchMode: string;
  } | null;
  dependsOn?: string[];
  depsSatisfied?: boolean;
  blockedBy?: string[];
};

/** Options for a run-now request. Mirrors the local executeTaskRun knobs
 *  a source might honor; sources ignore what they don't support. */
export type RunNowOptions = {
  overrideCwd?: string;
  manualInvocation?: boolean;
};

/** A registered provider of tasks. The local sqlite store and remote
 *  REST APIs both implement this; the registry holds the live set. */
export interface TaskSource {
  /** Stable identifier ('local', 'typebuild', ...). Rows are tagged with
   *  this so the UI can route mutations back to the owning source. */
  readonly id: string;
  /** Human-facing label for grouping headers. */
  readonly label: string;
  readonly capabilities: TaskSourceCapabilities;

  listTasks(filter: TaskFilter): Promise<SourcedTask[]> | SourcedTask[];
  getTask(id: string): Promise<SourcedTask | null> | SourcedTask | null;

  /** Mutations may throw an Error('unsupported') when the matching
   *  capability is off. */
  createTask(input: TaskCreate): Promise<SourcedTask> | SourcedTask;
  updateTask(id: string, patch: TaskUpdate): Promise<SourcedTask> | SourcedTask;
  deleteTask(id: string): Promise<void> | void;

  /** Execute the task now. Return shape is source-defined (the local
   *  source returns { run, result }); the renderer treats it opaquely. */
  runNow(id: string, opts?: RunNowOptions): Promise<unknown>;

  /** Source-native verbs beyond CRUD (claim/release/reopen, etc.). Wired
   *  to the tasks:sourceAction IPC. Optional — sources without native
   *  verbs omit it. */
  sourceAction?(
    taskId: string,
    action: string,
    payload?: unknown,
  ): Promise<unknown>;

  /** Claim and return the next runnable task for this machine, or null when
   *  the queue is empty — the equivalent of the MCP `claim_next_task` verb.
   *  Used by the headless breezed daemon's poll-claim-execute loop. Optional:
   *  only sources with a server-side claim-next endpoint (TypeBuild) implement
   *  it; local-style stores omit it. The returned task carries its decrypted
   *  body in memory (PHI) when the source is phiSensitive. */
  claimNext?(): Promise<SourcedTask | null>;
}

/** Serializable descriptor returned by the tasks:sources IPC so the
 *  renderer can gate affordances without holding a live source. */
export type TaskSourceInfo = {
  id: string;
  label: string;
  capabilities: TaskSourceCapabilities;
};

export function describeSource(s: TaskSource): TaskSourceInfo {
  return { id: s.id, label: s.label, capabilities: s.capabilities };
}

/** Thrown (or constructed) by sources when a capability-gated mutation
 *  is requested. Callers can pattern-match on the message. */
export function unsupported(action: string): Error {
  return new Error(`unsupported: ${action}`);
}

// ─── claim heartbeat (task-6c62e6f0905e) ──────────────────────────────────
// "An agent is actively working on task X" is only trustworthy when the
// server-side claim stays FRESH for as long as the run is actually alive —
// claim freshness is the liveness signal of record (src/projects/attention.mjs
// isStalledRow / classify()), so a long-running executor must keep RENEWING
// it, not just claim once at the start. Re-claiming by the current holder is
// an idempotent renew (it only refreshes the TTL server-side) — this mirrors
// the GUI-side keep-alive already armed for interactive sessions
// (electron/sources/typebuild.ts, fm-cveh/S8, ~90min cadence against a 2h
// TTL). This helper is the source-agnostic HEADLESS analog: any long-running
// executor (daemon/breezed.ts today) arms a heartbeat for the duration of a
// run via `source.sourceAction(id, 'claim')` — the SAME endpoint, no new
// verb — and disarms it the instant the run ends (success, failure, or
// error) so staleness never lingers past the run's own lifetime.
export const CLAIM_HEARTBEAT_MS = 90 * 60_000; // matches typebuild.ts's KEEPALIVE_MS

/** Arm a periodic call to `renew` every `ms` (default CLAIM_HEARTBEAT_MS).
 *  Returns a disarm function — callers MUST call it exactly once when the run
 *  ends so a finished run never keeps renewing a claim nobody holds anymore.
 *  `renew` is expected to swallow its own errors (a transient network blip
 *  should not crash the heartbeat, and this helper does not retry/backoff —
 *  it only schedules). Idempotent to disarm twice. */
export function armClaimHeartbeat(
  renew: () => void | Promise<void>,
  ms: number = CLAIM_HEARTBEAT_MS,
): () => void {
  const timer = setInterval(() => {
    void renew();
  }, ms);
  let disarmed = false;
  return () => {
    if (disarmed) return;
    disarmed = true;
    clearInterval(timer);
  };
}
