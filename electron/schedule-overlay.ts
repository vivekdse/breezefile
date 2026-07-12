// Local PHI-free schedule overlay for remote-source tasks (fm-b5at.8).
//
// The TypeBuild server is the source of truth for the task QUEUE, but it has
// no scheduler — so Breezefile owns TIMING. This module stores a local cron
// overlay so a time-gated remote task can fire on the local scheduler the same
// way a local auto task does. The scheduler (electron/scheduler.ts) consumes
// this alongside the local `tasks` next_run_at fires.
//
// PHI INVARIANT (non-negotiable, from the epic + typebuild CLAUDE.md): an
// overlay row carries ONLY opaque ids (source_id, task_id) and a cron string.
// Never titles, never bodies, never any decrypted content. The table lives in
// the SAME sqlite DB as tasks (~/.breezefile/tasks.db) but holds nothing
// sensitive — a cron expression + two opaque ids.
//
// We reuse tasks.ts's db handle + migration mechanism (a CREATE TABLE shipped
// as migration v5 there) but keep all overlay logic self-contained here. The
// DB connection is process-lifetime; we open lazily and share the same file.

import Database from 'better-sqlite3';
import path from 'node:path';
import { stateDir } from './core/profile.mjs';
import { existsSync, mkdirSync } from 'node:fs';
import { nextFireFromExpr, parseCron } from './cron';
import { breezeHost } from './core/host';
import { ensureSchema } from './tasks';

export type RemoteSchedule = {
  sourceId: string;
  taskId: string;
  /** 5-field cron expression in LOCAL time. */
  cron: string;
  /** ms epoch of the next scheduled fire. */
  nextRunAt: number;
  createdAt: number;
};

let db: Database.Database | null = null;

function dbPath(): string {
  return path.join(stateDir(), 'tasks.db');
}

function open(): Database.Database {
  if (db) return db;
  const dir = path.dirname(dbPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // tasks.ts owns the migration chain (including the remote_schedule CREATE
  // TABLE). Run it on whatever connection we opened so the table exists even
  // if this module is the first to touch the DB (e.g. a tool/test).
  ensureSchema(db);
  return db;
}

function rowToSchedule(r: Record<string, unknown>): RemoteSchedule {
  return {
    sourceId: r.source_id as string,
    taskId: r.task_id as string,
    cron: r.cron as string,
    nextRunAt: r.next_run_at as number,
    createdAt: r.created_at as number,
  };
}

/** Validate a cron expression the same way local tasks do. Throws on invalid.
 *  Exposed so the IPC layer can reject a bad expression before writing. */
export function validateCron(cron: string): void {
  // parseCron throws a descriptive Error on a malformed expression; let it
  // propagate so callers can surface the message inline.
  parseCron(cron);
}

/** Create or replace the overlay schedule for a (source, task). Computes
 *  next_run_at from `cron` via the shared cron helper. Throws on invalid
 *  cron (no row is written). Broadcasts tasks-changed so the UI re-pulls. */
export function setSchedule(sourceId: string, taskId: string, cron: string): RemoteSchedule {
  const trimmed = cron.trim();
  // Throws on a bad expression — surfaced to the renderer for inline error.
  const next = nextFireFromExpr(trimmed, new Date());
  const d = open();
  const now = Date.now();
  d.prepare(
    `INSERT INTO remote_schedule (source_id, task_id, cron, next_run_at, created_at)
     VALUES (@source_id, @task_id, @cron, @next_run_at, @created_at)
     ON CONFLICT(source_id, task_id) DO UPDATE SET
       cron = excluded.cron,
       next_run_at = excluded.next_run_at`,
  ).run({
    source_id: sourceId,
    task_id: taskId,
    cron: trimmed,
    next_run_at: next,
    created_at: now,
  });
  broadcast();
  return { sourceId, taskId, cron: trimmed, nextRunAt: next, createdAt: now };
}

/** Remove the overlay schedule for a (source, task). No-op (and no broadcast)
 *  when nothing was scheduled. */
export function clearSchedule(sourceId: string, taskId: string): void {
  const d = open();
  const info = d
    .prepare('DELETE FROM remote_schedule WHERE source_id = ? AND task_id = ?')
    .run(sourceId, taskId);
  if (info.changes > 0) broadcast();
}

/** Every overlay schedule, ordered by soonest fire. */
export function listSchedules(): RemoteSchedule[] {
  const d = open();
  const rows = d
    .prepare('SELECT * FROM remote_schedule ORDER BY next_run_at ASC')
    .all() as Record<string, unknown>[];
  return rows.map(rowToSchedule);
}

/** The overlay schedule for one (source, task), or null. */
export function getSchedule(sourceId: string, taskId: string): RemoteSchedule | null {
  const d = open();
  const row = d
    .prepare('SELECT * FROM remote_schedule WHERE source_id = ? AND task_id = ?')
    .get(sourceId, taskId) as Record<string, unknown> | undefined;
  return row ? rowToSchedule(row) : null;
}

/** Overlay schedules whose next_run_at is at or before `now`, soonest first.
 *  The scheduler's wake-up query for remote fires. */
export function dueSchedules(now: number): RemoteSchedule[] {
  const d = open();
  const rows = d
    .prepare(
      `SELECT * FROM remote_schedule
       WHERE next_run_at <= @now
       ORDER BY next_run_at ASC`,
    )
    .all({ now }) as Record<string, unknown>[];
  return rows.map(rowToSchedule);
}

/** Advance a schedule's next_run_at to the next cron fire after now. Called by
 *  the scheduler after it dispatches (or skip+notifies) a due overlay fire so
 *  we never re-fire the same minute. On an invalid/unsatisfiable cron the row
 *  is dropped (it can never fire again) so it doesn't wedge the scheduler. */
export function rollForward(sourceId: string, taskId: string): void {
  const cur = getSchedule(sourceId, taskId);
  if (!cur) return;
  let next: number;
  try {
    next = nextFireFromExpr(cur.cron, new Date());
  } catch {
    clearSchedule(sourceId, taskId);
    return;
  }
  const d = open();
  d.prepare(
    'UPDATE remote_schedule SET next_run_at = ? WHERE source_id = ? AND task_id = ?',
  ).run(next, sourceId, taskId);
  broadcast();
}

/** Soonest pending overlay fire across all sources, or null. The scheduler
 *  mins this with nextScheduledFire() to arm its single timer. */
export function nextOverlayFire(): number | null {
  const d = open();
  const row = d
    .prepare('SELECT MIN(next_run_at) AS t FROM remote_schedule')
    .get() as { t: number | null } | undefined;
  return row?.t ?? null;
}

/** Drop overlay rows whose owning (source, task) no longer exists or is in a
 *  terminal state, given a resolver that returns the task's current status (or
 *  null if it's gone / the source is unreachable). The resolver returning
 *  `undefined` means "can't tell right now" (e.g. signed out) — we keep the
 *  row in that case so a transient outage doesn't silently lose a schedule.
 *  Returns the number of rows pruned. */
export function pruneStale(
  statusOf: (sourceId: string, taskId: string) => 'gone' | 'terminal' | 'live' | 'unknown',
): number {
  const rows = listSchedules();
  let pruned = 0;
  for (const s of rows) {
    const verdict = statusOf(s.sourceId, s.taskId);
    if (verdict === 'gone' || verdict === 'terminal') {
      clearSchedule(s.sourceId, s.taskId);
      pruned++;
    }
  }
  return pruned;
}

// The scheduler registers here so it can re-arm its single timer after any
// overlay write that might change the soonest fire. Kept in-module to mirror
// tasks.ts's setTaskChangeHook and avoid a circular import with scheduler.ts.
let onScheduleChange: (() => void) | null = null;
export function setScheduleChangeHook(fn: () => void): void {
  onScheduleChange = fn;
}

function broadcast(): void {
  // Best-effort; a misbehaving host must not fail an overlay write.
  try {
    breezeHost().onTasksChanged();
  } catch (e) {
    console.error('[schedule-overlay] broadcast:', e);
  }
  try {
    onScheduleChange?.();
  } catch (e) {
    console.error('[schedule-overlay] change hook:', e);
  }
}

/** For tests / explicit cleanup. Production never calls this — the connection
 *  lives for the process lifetime. */
export function _closeForTests(): void {
  if (db) {
    db.close();
    db = null;
  }
}
