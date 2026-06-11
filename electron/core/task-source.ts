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
  attempts?: number;
  maxAttempts?: number;
  flags?: string[];
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
