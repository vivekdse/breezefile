// The Electron implementation of BreezeHost: broadcast task/run changes
// to every open window and raise a system Notification on auto-run
// failure. This is the ONLY place in the task subsystem that touches
// `electron` after the P1 extraction. main.ts injects it at startup via
// setBreezeHost(); behavior is identical to the pre-refactor inline code.

import { BrowserWindow, Notification } from 'electron';
import type { BreezeHost } from './host';

export const ElectronBreezeHost: BreezeHost = {
  onTasksChanged() {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('tasks:changed');
    }
  },

  onRunsChanged(taskId: string) {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send('task-runs:changed', { taskId });
      }
    }
  },

  onRunFailed(task: { id: string; title: string }, body: string) {
    // Prefer a system notification when supported; in headless / test
    // environments it's a no-op which is fine.
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: `Auto-execute failed: ${task.title}`,
          body,
          silent: false,
        }).show();
      }
    } catch (e) {
      console.error('[electron-host] notify:', e);
    }
    // Also tell the renderer so it can update the sidebar badge.
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send('task-runs:failed', { taskId: task.id, body });
      }
    }
  },
};
