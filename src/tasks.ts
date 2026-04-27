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

// fm-adc — assemble the templated first-message that gets pre-typed into
// the agent's input box. v1 uses simple field substitution rather than a
// full templating engine: the field set is small, escaping is a
// non-issue (this is interactive prompt text, not a shell command), and
// we want zero new dependencies on the renderer side. The `userTemplate`
// parameter is a stub for a future Settings hook (fm-fc0 era) — passing
// undefined falls back to the built-in default.
export function buildContextPrompt(task: Task, userTemplate?: string): string {
  if (userTemplate && userTemplate.trim()) {
    return renderTemplate(userTemplate, task);
  }
  const lines: string[] = [];
  lines.push(`I am working on Breeze task: ${task.title}`);
  lines.push('');
  lines.push(`  Folder: ${task.folder}`);
  if (task.due_at) lines.push(`  Due: ${task.due_at}`);
  if (task.notes && task.notes.trim()) {
    // Inline single-line notes; for multi-line, keep as a block under a label
    // so the agent doesn't read the body as a continuation of the bullet.
    const notes = task.notes.trim();
    if (notes.includes('\n')) {
      lines.push('  Notes:');
      for (const ln of notes.split('\n')) lines.push(`    ${ln}`);
    } else {
      lines.push(`  Notes: ${notes}`);
    }
  }
  lines.push('');
  lines.push('You can update the task with `breeze task <subcmd>`.');
  return lines.join('\n');
}

function renderTemplate(tpl: string, task: Task): string {
  // Minimal {{field}} + {{#if field}}...{{/if}} substitution. Anything
  // beyond this should justify a real engine.
  const fields: Record<string, string | null> = {
    id: task.id,
    title: task.title,
    folder: task.folder,
    status: task.status,
    notes: task.notes,
    due_at: task.due_at,
    start_at: task.start_at,
    ref_folder: task.ref_folder,
  };
  let out = tpl.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_m, name: string, body: string) => {
      const v = fields[name];
      return v && String(v).trim() ? body : '';
    },
  );
  out = out.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    const v = fields[name];
    return v == null ? '' : String(v);
  });
  return out;
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

// fm-a9j — due-date display helpers, hoisted out of Sidebar.tsx so the
// task-mode shell uses the same vocabulary. One source of truth means a
// task that says "tomorrow" in the sidebar reads "tomorrow" in the header.

export type DueTone = 'overdue' | 'today' | 'soon' | 'future' | 'none';

export function dueTone(due: string | null, today: string = todayISO()): DueTone {
  if (!due) return 'none';
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  // "soon" = within the next 3 days
  const diffDays = daysBetween(today, due);
  if (diffDays <= 3) return 'soon';
  return 'future';
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const da = Date.UTC(ay, am - 1, ad);
  const db = Date.UTC(by, bm - 1, bd);
  return Math.round((db - da) / 86_400_000);
}

export function formatDueLabel(due: string, today: string = todayISO()): string {
  if (due < today) {
    const days = daysBetween(due, today);
    return days === 1 ? '1d overdue' : `${days}d overdue`;
  }
  if (due === today) return 'today';
  const days = daysBetween(today, due);
  if (days === 1) return 'tomorrow';
  if (days < 7) {
    // Day-of-week label for proximate dates feels more human than a date.
    const [y, m, d] = due.split('-').map(Number);
    const dow = new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short' });
    return dow.toLowerCase();
  }
  // 'YYYY-MM-DD' → 'Apr 30' for distant dates.
  const [y, m, d] = due.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}
