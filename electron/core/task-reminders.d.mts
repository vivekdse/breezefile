// fm-5xy — type surface for task-reminders.mjs (runtime is plain ESM).

export type ReminderMode = 'off' | 'start' | 'start-near-due';

export interface ReminderTask {
  id: string;
  start_at?: string | null;
  due_at?: string | null;
  last_notified_for_date?: string | null;
}

export function selectReminderTasks(args: {
  tasks: ReminderTask[];
  today: string;
  tomorrow: string;
  mode: ReminderMode;
}): { startToday: ReminderTask[]; dueTomorrow: ReminderTask[] };

export function normalizeReminderMode(v: unknown): ReminderMode;
