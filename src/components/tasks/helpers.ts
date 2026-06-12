// fm-7909 — small presentation helpers shared across the tasks/* components.
// Pulled out of the old monolith so TaskRow / TaskDetailPanel / the container
// share one vocabulary (a date that reads "tomorrow" in the row reads
// "tomorrow" in the detail panel).

import type { TaskStatus } from '../../types';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function shortDate(iso: string, today: string): string {
  if (iso === today) return 'today';
  const d = new Date(iso + 'T00:00:00');
  const t = new Date(today + 'T00:00:00');
  const days = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 1 && days <= 6) return `in ${days}d`;
  if (days < -1 && days >= -6) return `${-days}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function homeRel(p: string | undefined | null): string {
  // Source tasks (TypeBuild) carry no folder across the seam, so `p` can be
  // undefined — never assume a string or we throw on `.replace`.
  if (!p) return '';
  const home =
    typeof window !== 'undefined' &&
    (window as unknown as { fm?: { home?: string } }).fm?.home;
  if (home && p === home) return '~';
  if (home && p.startsWith(home + '/')) return '~' + p.slice(home.length);
  const trimmed = p.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) || '/' : trimmed;
}

// Add `days` to an ISO 'YYYY-MM-DD' (timezone-naive). Used by snooze.
export function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

export function isoFromDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}
