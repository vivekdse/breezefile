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
}

const noop: BreezeHost = {
  onTasksChanged() {},
  onRunsChanged() {},
  onRunFailed() {},
};

let current: BreezeHost = noop;

export function setBreezeHost(h: BreezeHost): void {
  current = h;
}

export function breezeHost(): BreezeHost {
  return current;
}
