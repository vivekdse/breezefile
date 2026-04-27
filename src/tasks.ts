// fm-dhc — task client hook. Wraps the task IPC, listens for `tasks:changed`
// broadcasts, and re-pulls. Each consumer maintains its own filter slice;
// the broadcast is global so a single change notifies every active hook.

import { useEffect, useRef, useState } from 'react';
import { fm } from './bridge';
import type { Task, TaskCreate, TaskFilter, TaskUpdate } from './types';

export function useTasks(filter: TaskFilter = {}): {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Stringify the filter into a stable key so we re-fetch when it changes
  // semantically, not when the parent passes a fresh object identity.
  const filterKey = JSON.stringify(filter);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setLoading(true);
        const list = await fm.tasksList(filterRef.current);
        if (!cancelled) {
          setTasks(list);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const unsub = fm.onTasksChanged(load);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [filterKey]);

  return {
    tasks,
    loading,
    error,
    refresh: async () => {
      const list = await fm.tasksList(filterRef.current);
      setTasks(list);
    },
  };
}

export async function createTask(input: TaskCreate): Promise<Task> {
  return fm.tasksCreate(input);
}
export async function updateTask(id: string, patch: TaskUpdate): Promise<Task> {
  return fm.tasksUpdate(id, patch);
}
export async function deleteTask(id: string): Promise<void> {
  return fm.tasksDelete(id);
}
export async function getTask(id: string): Promise<Task | null> {
  return fm.tasksGet(id);
}

/** Today's date as 'YYYY-MM-DD' in local time (matches what the DB stores). */
export function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Add days to a 'YYYY-MM-DD' date, return new 'YYYY-MM-DD'. */
export function shiftISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return todayISOFromDate(date);
}

function todayISOFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
