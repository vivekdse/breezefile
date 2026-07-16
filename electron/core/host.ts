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
  /** task-6589ec3934a4 (follow-up) — a source poll pass completed SUCCESSFULLY,
   *  whether or not it found anything to change. Distinct from onTasksChanged,
   *  which fires only on a real diff: a quiet period (nothing moved server-side)
   *  produces successful passes and NO diffs, so a host relying on
   *  onTasksChanged alone never hears that the sync clock advanced and Home's
   *  "last synced" reading freezes at the last change — which the staleness
   *  banner then reports as "this view may be out of date" while the poll is in
   *  fact perfectly healthy. This is the heartbeat that keeps that reading
   *  honest; it carries NO task data (PHI-free by construction). Optional:
   *  headless hosts have no renderer to inform and default to a no-op. */
  onSynced?(): void;
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
   *  hosts default to headless-only.
   *
   *  task-6589ec3934a4 — ALSO reused by TypeBuildTaskSource's poll guard
   *  (electron/sources/typebuild.ts pollOnce) as the "is any window open to
   *  receive a broadcast" check, replacing an ad hoc browserWindows()
   *  helper that called `require('electron')` directly. That call threw a
   *  ReferenceError in both ESM bundles (main and the breezed daemon have
   *  no `require` binding) and was silently swallowed into `[]`, making the
   *  poll guard's `.every()` vacuously true forever — the poll never
   *  reconciled past the first pull. Callers gating work on this method
   *  MUST fail OPEN when it's undefined (no host registered / a host that
   *  doesn't implement it) — treat "can't tell" as "poll anyway", never as
   *  "no window". A redundant pull costs one request; a wrongly-skipped
   *  one freezes the roster silently, which is the bug this task fixes. */
  hasInteractiveWindow?(): boolean;
  /** fm-5xy — a grouped start-at / near-due reminder. PHI-FREE: callers pass
   *  only counts (never task titles/bodies), so the host builds a generic
   *  grouped message ("3 tasks start today"). `startCount` is tasks whose
   *  start_at is today; `dueCount` is tasks due tomorrow (near-due). The host
   *  raises ONE native notification summarizing both. Optional so old/headless
   *  hosts default to log-only. */
  onTaskReminders?(counts: { startCount: number; dueCount: number }): void;
  /** task-6589ec3934a4 — an interactive session's PTY was relaunched (e.g.
   *  after a resume). Tells the renderer to repoint the tab that hosted
   *  `oldPtyId` onto `newPtyId` instead of closing/reopening it. PHI-free:
   *  only opaque ids + a generic title cross the seam. Optional so headless
   *  hosts (no PTY-hosting window) default to a no-op. */
  onSessionRelaunched?(detail: {
    oldPtyId: number;
    newPtyId: number;
    cwd: string;
    title: string;
  }): void;
  /** task-6589ec3934a4 — an interactive session's PTY exited while this
   *  principal still holds the claim; gently prompt the renderer to offer
   *  releasing it. PHI-free: only the opaque task id crosses the seam.
   *  Optional so headless hosts default to a no-op. */
  onReleasePrompt?(detail: { taskId: string }): void;
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
