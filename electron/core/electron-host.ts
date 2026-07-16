// The Electron implementation of BreezeHost: broadcast task/run changes
// to every open window and raise a system Notification on auto-run
// failure. This is the ONLY place in the task subsystem that touches
// `electron` after the P1 extraction. main.ts injects it at startup via
// setBreezeHost(); behavior is identical to the pre-refactor inline code.

import { BrowserWindow, Notification } from 'electron';
import type { BreezeHost, TasksChangedDetail } from './host';
import {
  shouldNotifyFailure,
  shouldNotifySuccess,
  shouldNotifyTransition,
} from './notify-settings.mjs';
import { isOriginDegraded } from '../typebuild/http';
import { getTaskSource } from '../sources/registry';

function broadcast(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

// fm-h8g7 — shared task-notification helper. Routes the CLICK through the main
// process (focus + restore + `tasks:notification-clicked`) exactly like the
// attention-notification path in main.ts — web-API Notification clicks are
// unreliable on Linux libnotify daemons, so all three task notifications
// (failure / success / transition) funnel through here rather than duplicating
// the click-routing boilerplate. PHI: callers pass only PHI-free title/body.
function showTaskNotification(opts: {
  title: string;
  body: string;
  taskId?: string;
  silent?: boolean;
}): void {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: opts.title,
      body: opts.body,
      silent: opts.silent ?? false,
    });
    n.on('click', () => {
      const w =
        BrowserWindow.getAllWindows().find((b) => !b.isDestroyed()) ?? null;
      if (w) {
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
        // Open/focus the Tasks page; taskId (when present) lets the renderer
        // select the row. PHI-free: only the opaque id crosses the seam.
        w.webContents.send('tasks:notification-clicked', { taskId: opts.taskId });
      }
      try { n.close(); } catch { /* already gone */ }
    });
    n.show();
  } catch (e) {
    console.error('[electron-host] notify:', e);
  }
}

// fm-h8g7 — human-readable, PHI-FREE body per transition kind. The title is
// always built from the opaque short id by the caller.
const TRANSITION_BODY: Record<string, string> = {
  new: 'New task available',
  completed: 'Completed',
  partial: 'Partially completed',
  // fm-alfz (S1) — cancelled is a real terminal transition now.
  cancelled: 'Cancelled',
  blocked: 'Blocked — needs attention',
  'claim-lost': 'Your claim was released or taken over',
};

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

export const ElectronBreezeHost: BreezeHost = {
  onTasksChanged(detail?: TasksChangedDetail) {
    // task-b3fb2928bb3c (Phase 1) — forward the PHI-free diff (opaque ids only)
    // when present so the renderer can prune removed rows / skip a full re-pull.
    // Legacy callers pass nothing → payload is undefined → full re-pull path.
    broadcast('tasks:changed', detail);
    // task-6589ec3934a4 — every successful poll pass fires onTasksChanged
    // (see typebuild.ts broadcastDiff), so piggyback a fresh 'typebuild:health'
    // push here too: keeps the renderer's "last synced Nm ago" current on
    // every reconcile, not only on a degraded/recovered transition.
    broadcast('typebuild:health', {
      degraded: isOriginDegraded(),
      lastSyncedAt: getTaskSource('typebuild')?.lastSyncedAt?.() ?? null,
    });
  },

  onRunsChanged(taskId: string) {
    broadcast('task-runs:changed', { taskId });
  },

  // task-6589ec3934a4 (follow-up) — sync heartbeat. The piggyback in
  // onTasksChanged above only covers passes that found a DIFF, so during a quiet
  // stretch the renderer's "last synced" reading stopped advancing and Home
  // eventually declared a perfectly live view stale. Push the same health
  // payload on every successful pass so that reading tracks the real clock.
  // Cheap: one small IPC message per poll, no task data.
  onSynced() {
    broadcast('typebuild:health', {
      degraded: isOriginDegraded(),
      lastSyncedAt: getTaskSource('typebuild')?.lastSyncedAt?.() ?? null,
    });
  },

  hasInteractiveWindow() {
    return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed());
  },

  // task-6589ec3934a4 — moved off the ad hoc browserWindows()/require('electron')
  // helper in typebuild.ts (see the hasInteractiveWindow doc in host.ts for why).
  onSessionRelaunched(detail) {
    broadcast('typebuild:sessionRelaunched', detail);
  },

  onReleasePrompt(detail) {
    broadcast('typebuild:releasePrompt', detail);
  },

  onRunFailed(task: { id: string; title: string }, body: string) {
    // Failures show unless the user turned task notifications fully off.
    if (shouldNotifyFailure()) {
      showTaskNotification({
        title: `Auto-execute failed: ${task.title}`,
        body,
        taskId: task.id,
        silent: false,
      });
    }
    // Always tell the renderer so it can update the sidebar badge — the badge
    // feed is independent of the OS-notification verbosity gate.
    broadcast('task-runs:failed', { taskId: task.id, body });
  },

  // fm-h8g7 — success mirror of onRunFailed. Only fires for non-manual runs
  // (the scheduler/auto seam). The body is already truncated/PHI-safe by the
  // caller (execute.ts); phiSensitive forces a generic title as a belt-and-
  // braces guard even though executeTaskRun should never run a remote task.
  onRunSucceeded(
    task: { id: string; title: string },
    body: string,
    opts?: { manualInvocation?: boolean; phiSensitive?: boolean },
  ) {
    // A MANUAL run-now must not OS-notify when a Breeze window is focused —
    // the user is right there watching. But DO notify when the app is
    // unfocused/minimized (they tabbed away during a long run). Scheduled/auto
    // runs always notify (subject to the verbosity gate below).
    const focused = !!BrowserWindow.getFocusedWindow();
    const suppressForManual = !!opts?.manualInvocation && focused;
    // Success OS-notifies only at the most-verbose ('all') level.
    if (shouldNotifySuccess() && !suppressForManual) {
      const title = opts?.phiSensitive
        ? 'Task completed'
        : `Task completed: ${task.title}`;
      showTaskNotification({
        title,
        body: opts?.phiSensitive ? 'Agent run finished' : body,
        taskId: task.id,
        silent: true,
      });
    }
    // Badge feed is independent of the verbosity gate.
    broadcast('task-runs:succeeded', { taskId: task.id });
  },

  // fm-5xy — grouped start-at / near-due reminder. PHI-FREE: built ENTIRELY
  // from counts (the caller never passes a title), so a PHI task's body never
  // reaches the OS notification. One native notification summarizes both legs:
  // "N tasks start today" (+ "M due tomorrow"). Clicking opens the Tasks page
  // (no specific row — it's a grouped reminder). Always fires when the caller
  // decided to (the start/near-due verbosity gate lives in the reminder driver,
  // separate from the run-notification verbosity gate above).
  onTaskReminders(counts: { startCount: number; dueCount: number }) {
    const startCount = Math.max(0, counts?.startCount ?? 0);
    const dueCount = Math.max(0, counts?.dueCount ?? 0);
    if (startCount === 0 && dueCount === 0) return;
    const parts: string[] = [];
    if (startCount > 0) {
      parts.push(`${startCount} task${startCount === 1 ? '' : 's'} start${startCount === 1 ? 's' : ''} today`);
    }
    if (dueCount > 0) {
      parts.push(`${dueCount} task${dueCount === 1 ? '' : 's'} due tomorrow`);
    }
    const title = parts[0];
    const body = parts.length > 1 ? parts.slice(1).join(' · ') : 'Open Tasks to review';
    showTaskNotification({ title, body, silent: true });
  },

  // fm-h8g7 — remote task transitions from a source poll. PHI-FREE end to end:
  // titles are NEVER available here; the OS notification label is built solely
  // from the opaque short id. Batch politeness: >3 transitions in one poll
  // collapse into ONE summary notification instead of a burst.
  onTaskTransitions(
    transitions: Array<{
      taskId: string;
      kind: 'new' | 'completed' | 'partial' | 'cancelled' | 'blocked' | 'claim-lost';
      source: string;
    }>,
  ) {
    if (!transitions || transitions.length === 0) return;
    // Always feed the renderer so the badge + in-app toast can react,
    // regardless of the OS-notification verbosity gate.
    broadcast('tasks:transitions', transitions);

    if (!shouldNotifyTransition()) return;

    const sourceLabel = (s: string) =>
      s === 'typebuild' ? 'TypeBuild' : s;

    if (transitions.length > 3) {
      // Summary — one notification for the whole burst. Clicking opens Tasks
      // with no specific row (mixed batch).
      const label = sourceLabel(transitions[0].source);
      showTaskNotification({
        title: `${transitions.length} ${label} tasks changed`,
        body: 'Open Tasks to review',
        silent: true,
      });
      return;
    }

    for (const t of transitions) {
      showTaskNotification({
        title: `${sourceLabel(t.source)} task ${shortId(t.taskId)}`,
        body: TRANSITION_BODY[t.kind] ?? 'Changed',
        taskId: t.taskId,
        silent: true,
      });
    }
  },
};
