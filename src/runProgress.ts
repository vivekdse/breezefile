// fm-femh — Per-folder progress tracking for runs initiated from the
// renderer (Run-task modal, etc.). The IPC awaits the entire run, so
// to surface progress we keep a small store on the renderer side and
// register an entry the moment the user clicks Run. The runId is
// attached asynchronously when the backend's task-runs:changed event
// fires; once we have it, the Cancel button works.
//
// Why a module-scoped store rather than React context: the run can
// outlive the component that initiated it (RunTaskModal closes on
// click), so the data needs to live somewhere stable. A tiny
// pub/sub map is the lightest thing that does the job.

import { useEffect, useState } from 'react';

export type RunEntry = {
  id: string;             // ui-side id, distinct from runId
  cwd: string;            // folder the run was initiated in
  taskId: string;
  taskTitle: string;
  runId: string | null;   // populated once the backend creates the run row
  startedAt: number;      // epoch ms — used to disambiguate which run is ours
};

const entries: Map<string, RunEntry> = new Map();
const listeners: Set<() => void> = new Set();

function notify() {
  for (const l of Array.from(listeners)) l();
}

export function startTracking(
  taskId: string,
  taskTitle: string,
  cwd: string,
): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  entries.set(id, {
    id,
    cwd,
    taskId,
    taskTitle,
    runId: null,
    startedAt: Date.now(),
  });
  notify();
  return id;
}

export function attachRunId(uiId: string, runId: string) {
  const e = entries.get(uiId);
  if (e && !e.runId) {
    entries.set(uiId, { ...e, runId });
    notify();
  }
}

export function stopTracking(uiId: string) {
  if (entries.delete(uiId)) notify();
}

export function getEntriesForCwd(cwd: string): RunEntry[] {
  const out: RunEntry[] = [];
  for (const e of Array.from(entries.values())) if (e.cwd === cwd) out.push(e);
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** Return the oldest entry for this taskId that hasn't yet been linked
 *  to a runId. Used by the global onTaskRunsChanged subscriber to
 *  pair backend-created run rows with renderer-side placeholders. */
export function findUnlinkedByTaskId(taskId: string): RunEntry | undefined {
  for (const e of Array.from(entries.values())) {
    if (e.taskId === taskId && !e.runId) return e;
  }
  return undefined;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Hook: returns the current run entries for a given folder. Re-renders
 *  when entries change. */
export function useRunsForCwd(cwd: string): RunEntry[] {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  return getEntriesForCwd(cwd);
}
