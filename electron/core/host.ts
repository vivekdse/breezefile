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

export interface BreezeHost {
  /** A task row changed (create/update/delete). */
  onTasksChanged(): void;
  /** A run row changed for `taskId` (scheduled/queued/finished). */
  onRunsChanged(taskId: string): void;
  /** An auto/scheduled run terminally failed. */
  onRunFailed(task: { id: string; title: string }, body: string): void;
  /** fm-b5at.7 — true when a GUI window is available to host an
   *  interactive (embedded-terminal) run. The Electron host returns true
   *  when a BrowserWindow exists; the headless breezed host returns false
   *  so interactive tasks fall back to a headless run. Optional so old
   *  hosts default to headless-only. */
  hasInteractiveWindow?(): boolean;
}

const noop: BreezeHost = {
  onTasksChanged() {},
  onRunsChanged() {},
  onRunFailed() {},
  hasInteractiveWindow() { return false; },
};

let current: BreezeHost = noop;

export function setBreezeHost(h: BreezeHost): void {
  current = h;
}

export function breezeHost(): BreezeHost {
  return current;
}
