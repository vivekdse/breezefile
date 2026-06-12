// fm-7909 — session-per-task map. Walks the store tabs and surfaces every
// open terminal whose `terminal.taskId` is set, keyed by task id. The Tasks
// page uses this to offer "Open session" (focus the existing tab) instead of
// launching a duplicate Start.
//
// A task can in theory have more than one session tab; we keep the FIRST one
// found (lowest tab index) — that's the one a user most likely means.

import { useMemo } from 'react';
import { useStore } from '../../store';

export type RunningSession = { ptyId: number; tabIndex: number };

export function useRunningSessions(): Map<string, RunningSession> {
  const { state } = useStore();
  return useMemo(() => {
    const m = new Map<string, RunningSession>();
    state.tabs.forEach((tab, tabIndex) => {
      const taskId = tab.terminal?.taskId;
      const ptyId = tab.terminal?.ptyId;
      if (taskId && typeof ptyId === 'number' && !m.has(taskId)) {
        m.set(taskId, { ptyId, tabIndex });
      }
    });
    return m;
  }, [state.tabs]);
}
