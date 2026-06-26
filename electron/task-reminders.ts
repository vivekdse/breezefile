// fm-5xy — start-at / near-due task reminders.
//
// On startup (catch-up) and every day at ~8am local time, surface a single
// grouped, PHI-FREE native notification for tasks that come into play today:
//   - tasks whose start_at === today          (always, when mode != 'off')
//   - tasks whose due_at  === tomorrow         (only in 'start-near-due' mode)
//
// Mode comes from the renderer (Settings → "Task start / due reminders"),
// mirrored into this main-process module over the `settings:taskReminders` IPC
// (main can't read localStorage). Default 'start' until the renderer reports in.
//
// Dedupe survives restarts and the daily tick:
//   - LOCAL tasks: the v6 `last_notified_for_date` column (tasks.ts).
//   - REMOTE tasks: a tiny JSON map at ~/.breezefile/reminder-state.json
//     (remote rows aren't in the local DB). Both keyed by the LOCAL calendar
//     day a reminder was raised for.
//
// PHI: notifications NEVER include a task title/body — the host builds a generic
// grouped message from COUNTS only (electron-host.onTaskReminders). Remote
// TypeBuild bodies are PHI; this module only ever routes opaque ids + day-only
// dates.

import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { breezeHost } from './core/host';
import * as tasks from './tasks';
import { listTaskSources } from './sources/registry';
import {
  selectReminderTasks,
  normalizeReminderMode,
} from './core/task-reminders.mjs';
import type {
  ReminderMode,
  ReminderTask,
} from './core/task-reminders.d.mts';

// ── settings mirror ──────────────────────────────────────────────────────────
// Renderer-owned; pushed over IPC on boot + on change. Default 'start'.
let mode: ReminderMode = 'start';

export function setTaskReminderMode(v: unknown): void {
  mode = normalizeReminderMode(v);
}

export function getTaskReminderMode(): ReminderMode {
  return mode;
}

// ── day helpers (local time, day-only 'YYYY-MM-DD') ─────────────────────────
function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayISO(now = new Date()): string {
  return isoDay(now);
}

function tomorrowISO(now = new Date()): string {
  const t = new Date(now);
  t.setDate(t.getDate() + 1);
  return isoDay(t);
}

// ── remote dedupe state (JSON; survives restarts) ───────────────────────────
function statePath(): string {
  return path.join(os.homedir(), '.breezefile', 'reminder-state.json');
}

function readRemoteState(): Record<string, string> {
  try {
    const raw = readFileSync(statePath(), 'utf8');
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v)) {
        if (typeof val === 'string') out[k] = val;
      }
      return out;
    }
  } catch {
    /* missing / malformed → start clean */
  }
  return {};
}

function writeRemoteState(map: Record<string, string>, today: string): void {
  // Compact: drop entries for any day other than today so the file can't grow
  // unbounded. We only ever need "was this id notified today?".
  const compact: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (v === today) compact[k] = v;
  }
  try {
    const dir = path.dirname(statePath());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(statePath(), JSON.stringify(compact), 'utf8');
  } catch (e) {
    console.warn('[reminders] state write failed:', (e as Error).message);
  }
}

// ── the scan ────────────────────────────────────────────────────────────────
/** Run one reminder pass for `now` (default: real now). Pure-ish: reads the
 *  local DB + registered sources, selects via the pure helper, raises ONE
 *  grouped notification, and records dedupe state. Safe to call repeatedly —
 *  the per-day dedupe makes a second call in the same day a no-op. Returns the
 *  counts it notified about (0/0 when nothing/off) for testing + logging. */
export async function runReminderScan(
  now: Date = new Date(),
): Promise<{ startCount: number; dueCount: number }> {
  if (mode === 'off') return { startCount: 0, dueCount: 0 };
  const today = todayISO(now);
  const tomorrow = tomorrowISO(now);

  // ── local tasks (DB column dedupe) ──
  let localTasks: ReminderTask[] = [];
  try {
    localTasks = tasks.reminderCandidates().map((t) => ({
      id: t.id,
      start_at: t.start_at,
      due_at: t.due_at,
      last_notified_for_date: t.last_notified_for_date ?? null,
    }));
  } catch (e) {
    console.warn('[reminders] local scan failed:', (e as Error).message);
  }

  // ── remote tasks (JSON-map dedupe) ──
  // Remote rows map start_at→null (typebuild.ts), so in practice this fires on
  // due_at only — that's expected and fine. We attach last_notified_for_date
  // from the JSON state so the pure selector dedupes uniformly.
  const remoteState = readRemoteState();
  const remoteTasks: ReminderTask[] = [];
  const remoteIds = new Set<string>();
  for (const source of listTaskSources()) {
    try {
      const rows = await source.listTasks({ includeDone: false });
      for (const r of rows) {
        remoteTasks.push({
          id: r.id,
          start_at: r.start_at ?? null,
          due_at: r.due_at ?? null,
          last_notified_for_date: remoteState[r.id] ?? null,
        });
        remoteIds.add(r.id);
      }
    } catch (e) {
      console.warn('[reminders] source scan failed:', (e as Error).message);
    }
  }

  const local = selectReminderTasks({ tasks: localTasks, today, tomorrow, mode });
  const remote = selectReminderTasks({ tasks: remoteTasks, today, tomorrow, mode });

  const startCount = local.startToday.length + remote.startToday.length;
  const dueCount = local.dueTomorrow.length + remote.dueTomorrow.length;
  if (startCount === 0 && dueCount === 0) return { startCount: 0, dueCount: 0 };

  // Raise ONE grouped, PHI-free notification (counts only).
  try {
    breezeHost().onTaskReminders?.({ startCount, dueCount });
  } catch (e) {
    console.warn('[reminders] notify failed:', (e as Error).message);
  }

  // Record dedupe AFTER notifying so a crash mid-notify retries next pass.
  for (const t of [...local.startToday, ...local.dueTomorrow]) {
    try {
      tasks.markNotifiedForDate(t.id, today);
    } catch (e) {
      console.warn('[reminders] mark failed:', (e as Error).message);
    }
  }
  for (const t of [...remote.startToday, ...remote.dueTomorrow]) {
    remoteState[t.id] = today;
  }
  if (remote.startToday.length + remote.dueTomorrow.length > 0) {
    writeRemoteState(remoteState, today);
  }

  console.log(
    `[reminders] notified: ${startCount} start-today, ${dueCount} due-tomorrow`,
  );
  return { startCount, dueCount };
}

// ── daily 8am tick ───────────────────────────────────────────────────────────
let dailyTimer: NodeJS.Timeout | null = null;
let started = false;

/** ms until the next local 08:00. If it's already past 8am today, returns the
 *  delay to 8am tomorrow. */
export function msUntilNext8am(now: Date = new Date()): number {
  const next = new Date(now);
  next.setHours(8, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function armDaily(): void {
  if (dailyTimer) clearTimeout(dailyTimer);
  const wait = msUntilNext8am();
  dailyTimer = setTimeout(() => {
    void runReminderScan().finally(() => armDaily());
  }, wait);
  if (dailyTimer.unref) dailyTimer.unref();
}

/** Start the reminder subsystem: a startup catch-up scan (so a task that came
 *  due while the app was closed is surfaced immediately) plus a daily 08:00
 *  timer. Idempotent. */
export function startTaskReminders(): void {
  if (started) return;
  started = true;
  // Startup catch-up. Fire-and-forget; the per-day dedupe makes it a no-op if
  // the daily tick already ran today.
  void runReminderScan().catch((e) =>
    console.warn('[reminders] startup scan failed:', (e as Error).message),
  );
  armDaily();
  console.log('[reminders] started');
}

/** Test / shutdown helper. */
export function stopTaskReminders(): void {
  if (dailyTimer) clearTimeout(dailyTimer);
  dailyTimer = null;
  started = false;
}
