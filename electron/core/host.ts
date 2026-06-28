// Host adapter for the Electron-free task core (breezed plan, P1).
//
// tasks.ts / scheduler.ts must run both inside Electron (broadcast to
// BrowserWindows, system Notification) and headless in `breezed` (just
// bump a change-seq + log). They depend on this interface, never on
// `electron` directly. The concrete impl is injected at startup:
//   - app:     ElectronBreezeHost  (electron/core/electron-host.ts)
//   - breezed: HeadlessBreezeHost  (daemon/breezed.ts)
//
// Default is a no-op so importing tasks.ts in a test / tool that never
// calls setBreezeHost() is harmless.

/** task-b3fb2928bb3c (Phase 1) — an OPTIONAL diff payload riding `tasks:changed`.
 *  PHI-FREE: opaque ids only, never titles/bodies. Lets the renderer prune
 *  removed rows in place and skip a full IPC re-pull when nothing was added or
 *  changed. Backward-compatible: omitted (undefined) on every legacy caller, in
 *  which case subscribers fall back to the existing full re-pull. */
export type TasksChangedDetail = {
  /** Source id whose list moved ('typebuild'). */
  source: string;
  /** Ids newly present in the source list. */
  added: string[];
  /** Ids whose routing fields changed. */
  changed: string[];
  /** Ids the source list no longer carries (tombstoned). */
  removed: string[];
};

export interface BreezeHost {
  /** A task row changed (create/update/delete). The optional `detail` carries a
   *  PHI-free added/changed/removed diff so subscribers can avoid a full
   *  re-pull; omitted by legacy callers (full re-pull fallback). */
  onTasksChanged(detail?: TasksChangedDetail): void;
  /** A run row changed for `taskId` (scheduled/queued/finished). */
  onRunsChanged(taskId: string): void;
  /** An auto/scheduled run terminally failed. */
  onRunFailed(task: { id: string; title: string }, body: string): void;
  /** fm-h8g7 — a NON-manual (scheduled/auto) run completed successfully.
   *  Mirror of onRunFailed: OS notification ("Task completed: <title>") +
   *  `task-runs:succeeded` broadcast. `phiSensitive` tells the host to use a
   *  generic, content-free body/title (the caller already passes a PHI-free
   *  title in that case). Optional so old/headless hosts default to log-only. */
  onRunSucceeded?(
    task: { id: string; title: string },
    body: string,
    opts?: { manualInvocation?: boolean; phiSensitive?: boolean },
  ): void;
  /** fm-h8g7 — a batch of remote task transitions detected by a source poll
   *  (TypeBuild). PHI-FREE: each entry carries only the opaque task id, a
   *  transition kind, and the source id — never titles/bodies. The host turns
   *  these into PHI-free OS notifications + a `tasks:transitions` broadcast for
   *  the renderer's badge. Optional so old/headless hosts default to log-only. */
  onTaskTransitions?(
    transitions: Array<{
      taskId: string;
      kind: 'new' | 'completed' | 'partial' | 'cancelled' | 'blocked' | 'claim-lost';
      source: string;
    }>,
  ): void;
  /** fm-b5at.7 — true when a GUI window is available to host an
   *  interactive (embedded-terminal) run. The Electron host returns true
   *  when a BrowserWindow exists; the headless breezed host returns false
   *  so interactive tasks fall back to a headless run. Optional so old
   *  hosts default to headless-only. */
  hasInteractiveWindow?(): boolean;
  /** fm-5xy — a grouped start-at / near-due reminder. PHI-FREE: callers pass
   *  only counts (never task titles/bodies), so the host builds a generic
   *  grouped message ("3 tasks start today"). `startCount` is tasks whose
   *  start_at is today; `dueCount` is tasks due tomorrow (near-due). The host
   *  raises ONE native notification summarizing both. Optional so old/headless
   *  hosts default to log-only. */
  onTaskReminders?(counts: { startCount: number; dueCount: number }): void;
}

const noop: BreezeHost = {
  onTasksChanged(_detail?: TasksChangedDetail) {},
  onRunsChanged() {},
  onRunFailed() {},
  onRunSucceeded() {},
  onTaskTransitions() {},
  hasInteractiveWindow() { return false; },
  onTaskReminders() {},
};

let current: BreezeHost = noop;

export function setBreezeHost(h: BreezeHost): void {
  current = h;
}

export function breezeHost(): BreezeHost {
  return current;
}
