// Breeze-native task store (fm-dhc).
//
// Single SQLite database at ~/.breezefile/tasks.db. Tasks are folder-anchored
// to-dos with optional date-only start/due, status, pinned flag, and notes.
// All writes broadcast `tasks:changed` over IPC so any open BrowserWindow can
// re-pull the affected slice without polling.

import Database from 'better-sqlite3';
import { BrowserWindow } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { nextFireFromExpr } from './cron';

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';

/** Identifier of a registered AgentRunner. Open-ended on purpose so the
 *  registry can grow (Codex, Gemini, custom shells) without churning the
 *  task schema. The runtime registry is the source of truth for which
 *  values are actually executable. */
export type AgentId = string;

export type Task = {
  id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  folder: string;
  ref_folder: string | null;
  start_at: string | null; // 'YYYY-MM-DD'
  due_at: string | null;   // 'YYYY-MM-DD'
  pinned: boolean;
  /** 5-field cron expression in LOCAL time, or null for non-recurring.
   *  Source of truth for scheduling; next_run_at is the cached fire time. */
  cron: string | null;
  /** ms epoch of the next scheduled fire, or null when nothing pending.
   *  For one-shot autos: set to now() at creation; cleared after the run.
   *  For cron autos: recomputed from `cron` after each run. */
  next_run_at: number | null;
  auto_mode: boolean;
  /** Agent registry id (e.g. 'claude'). Null = use default. */
  auto_agent: AgentId | null;
  /** Optional override prompt; falls back to title + notes when null. */
  auto_prompt: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

export type TaskCreate = {
  title: string;
  folder: string;
  notes?: string | null;
  status?: TaskStatus;
  ref_folder?: string | null;
  start_at?: string | null;
  due_at?: string | null;
  pinned?: boolean;
  cron?: string | null;
  next_run_at?: number | null;
  auto_mode?: boolean;
  auto_agent?: AgentId | null;
  auto_prompt?: string | null;
};

export type TaskUpdate = Partial<{
  title: string;
  notes: string | null;
  status: TaskStatus;
  folder: string;
  ref_folder: string | null;
  start_at: string | null;
  due_at: string | null;
  pinned: boolean;
  cron: string | null;
  next_run_at: number | null;
  auto_mode: boolean;
  auto_agent: AgentId | null;
  auto_prompt: string | null;
}>;

export type TaskRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'retrying';

export type TaskRunErrorClass =
  | 'rate_limit'
  | 'usage'
  | 'auth'
  | 'transient'
  | 'fatal';

export type TaskRun = {
  id: string;
  task_id: string;
  agent: AgentId;
  status: TaskRunStatus;
  attempt: number;
  scheduled_for: number;
  started_at: number | null;
  finished_at: number | null;
  conversation_id: string | null;
  output_path: string | null;
  error_class: TaskRunErrorClass | null;
  error_message: string | null;
  exit_code: number | null;
};

export type TaskRunCreate = {
  task_id: string;
  agent: AgentId;
  scheduled_for: number;
  attempt?: number;
  status?: TaskRunStatus;
};

export type TaskRunUpdate = Partial<{
  status: TaskRunStatus;
  started_at: number | null;
  finished_at: number | null;
  conversation_id: string | null;
  output_path: string | null;
  error_class: TaskRunErrorClass | null;
  error_message: string | null;
  exit_code: number | null;
}>;

export type TaskFilter = {
  status?: TaskStatus | TaskStatus[];
  folder?: string;
  pinned?: boolean;
  search?: string;
  /** Show tasks with start_at <= today (or null). */
  activeOnly?: boolean;
  /** Include status='done'. Default true; UI filters separately. */
  includeDone?: boolean;
};

let db: Database.Database | null = null;

function dbPath(): string {
  return path.join(os.homedir(), '.breezefile', 'tasks.db');
}

/** Check whether a tasks DB already exists on disk. Used by the
 *  feature-flag migration: existing installs that have written tasks
 *  before the flag landed should auto-enable task management on first
 *  launch with the new build. Does NOT open the DB or create directories. */
export function dbExists(): boolean {
  return existsSync(dbPath());
}

function ensureDir() {
  const dir = path.dirname(dbPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function open(): Database.Database {
  if (db) return db;
  ensureDir();
  db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);
  const row = d.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined;
  const current = row?.version ?? 0;

  const migrations: Array<(db: Database.Database) => void> = [
    // v1 — initial schema
    (db) => {
      db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          notes TEXT,
          status TEXT NOT NULL CHECK(status IN ('pending','in_progress','done','cancelled')),
          folder TEXT NOT NULL,
          ref_folder TEXT,
          start_at TEXT,
          due_at TEXT,
          pinned INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER
        );
        CREATE INDEX idx_tasks_status ON tasks(status);
        CREATE INDEX idx_tasks_due    ON tasks(due_at) WHERE status != 'done';
        CREATE INDEX idx_tasks_folder ON tasks(folder);
        CREATE INDEX idx_tasks_pinned ON tasks(pinned) WHERE pinned = 1;
      `);
    },

    // v2 — recurrence + auto-execute + run history (epic fm-zf3m)
    (db) => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN cron        TEXT;
        ALTER TABLE tasks ADD COLUMN next_run_at INTEGER;
        ALTER TABLE tasks ADD COLUMN auto_mode   INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tasks ADD COLUMN auto_agent  TEXT;
        ALTER TABLE tasks ADD COLUMN auto_prompt TEXT;

        -- Hot path for the scheduler: "soonest pending fire among auto tasks".
        CREATE INDEX idx_tasks_next_run
          ON tasks(next_run_at)
          WHERE auto_mode = 1 AND next_run_at IS NOT NULL;

        CREATE TABLE task_runs (
          id              TEXT PRIMARY KEY,
          task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          agent           TEXT NOT NULL,
          status          TEXT NOT NULL CHECK(status IN
                            ('queued','running','succeeded','failed','cancelled','retrying')),
          attempt         INTEGER NOT NULL DEFAULT 1,
          scheduled_for   INTEGER NOT NULL,
          started_at      INTEGER,
          finished_at     INTEGER,
          conversation_id TEXT,
          output_path     TEXT,
          error_class     TEXT,
          error_message   TEXT,
          exit_code       INTEGER
        );
        CREATE INDEX idx_runs_task   ON task_runs(task_id, started_at DESC);
        CREATE INDEX idx_runs_status ON task_runs(status);
      `);
    },
  ];

  const runFrom = current; // 0-indexed, matches array
  d.transaction(() => {
    for (let i = runFrom; i < migrations.length; i++) {
      migrations[i](d);
    }
    d.prepare('DELETE FROM schema_version').run();
    d.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migrations.length);
  })();
}

function rowToTask(r: Record<string, unknown>): Task {
  return {
    id: r.id as string,
    title: r.title as string,
    notes: (r.notes as string | null) ?? null,
    status: r.status as TaskStatus,
    folder: r.folder as string,
    ref_folder: (r.ref_folder as string | null) ?? null,
    start_at: (r.start_at as string | null) ?? null,
    due_at: (r.due_at as string | null) ?? null,
    pinned: ((r.pinned as number) ?? 0) === 1,
    cron: (r.cron as string | null) ?? null,
    next_run_at: (r.next_run_at as number | null) ?? null,
    auto_mode: ((r.auto_mode as number) ?? 0) === 1,
    auto_agent: (r.auto_agent as string | null) ?? null,
    auto_prompt: (r.auto_prompt as string | null) ?? null,
    created_at: r.created_at as number,
    updated_at: r.updated_at as number,
    completed_at: (r.completed_at as number | null) ?? null,
  };
}

function rowToRun(r: Record<string, unknown>): TaskRun {
  return {
    id: r.id as string,
    task_id: r.task_id as string,
    agent: r.agent as AgentId,
    status: r.status as TaskRunStatus,
    attempt: r.attempt as number,
    scheduled_for: r.scheduled_for as number,
    started_at: (r.started_at as number | null) ?? null,
    finished_at: (r.finished_at as number | null) ?? null,
    conversation_id: (r.conversation_id as string | null) ?? null,
    output_path: (r.output_path as string | null) ?? null,
    error_class: (r.error_class as TaskRunErrorClass | null) ?? null,
    error_message: (r.error_message as string | null) ?? null,
    exit_code: (r.exit_code as number | null) ?? null,
  };
}

function todayLocalISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function listTasks(filter: TaskFilter = {}): Task[] {
  const d = open();
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (filter.status) {
    const arr = Array.isArray(filter.status) ? filter.status : [filter.status];
    where.push(`status IN (${arr.map((_, i) => `@status_${i}`).join(',')})`);
    arr.forEach((s, i) => (params[`status_${i}`] = s));
  } else if (filter.includeDone === false) {
    where.push(`status != 'done'`);
  }

  if (filter.folder) {
    where.push('folder = @folder');
    params.folder = filter.folder;
  }
  if (filter.pinned !== undefined) {
    where.push('pinned = @pinned');
    params.pinned = filter.pinned ? 1 : 0;
  }
  if (filter.search) {
    where.push('(title LIKE @search OR notes LIKE @search)');
    params.search = `%${filter.search}%`;
  }
  if (filter.activeOnly) {
    where.push(`(start_at IS NULL OR start_at <= @today)`);
    where.push(`status NOT IN ('done','cancelled')`);
    params.today = todayLocalISO();
  }

  const sql = `
    SELECT * FROM tasks
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY pinned DESC,
             CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
             due_at ASC,
             created_at DESC
  `;
  const rows = d.prepare(sql).all(params) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function getTask(id: string): Task | null {
  const d = open();
  const row = d.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTask(row) : null;
}

export function createTask(input: TaskCreate): Task {
  if (!input.title?.trim()) throw new Error('title is required');
  if (!input.folder?.trim()) throw new Error('folder is required');
  if (input.start_at && input.due_at && input.due_at < input.start_at) {
    throw new Error('due date must be on or after start date');
  }
  const d = open();
  const now = Date.now();
  const id = crypto.randomUUID();
  const status: TaskStatus = input.status ?? 'pending';
  // fm-zf3m — schedule on creation:
  //   auto + no cron + no explicit next  → fire now (one-shot run-on-save)
  //   auto + cron + no explicit next     → first cron fire from now
  //   explicit next_run_at supplied      → trust the caller
  //   non-auto                           → null
  const autoMode = input.auto_mode ? 1 : 0;
  const explicitNext = input.next_run_at ?? null;
  let nextRunAt: number | null = explicitNext;
  if (autoMode && explicitNext == null) {
    if (input.cron) {
      try {
        nextRunAt = nextFireFromExpr(input.cron, new Date(now));
      } catch (e) {
        throw new Error(`invalid cron expression: ${(e as Error).message}`);
      }
    } else {
      nextRunAt = now;
    }
  }
  d.prepare(
    `INSERT INTO tasks (
      id, title, notes, status, folder, ref_folder,
      start_at, due_at, pinned,
      cron, next_run_at, auto_mode, auto_agent, auto_prompt,
      created_at, updated_at, completed_at
    ) VALUES (
      @id, @title, @notes, @status, @folder, @ref_folder,
      @start_at, @due_at, @pinned,
      @cron, @next_run_at, @auto_mode, @auto_agent, @auto_prompt,
      @created_at, @updated_at, @completed_at
    )`,
  ).run({
    id,
    title: input.title.trim(),
    notes: input.notes ?? null,
    status,
    folder: input.folder,
    ref_folder: input.ref_folder ?? null,
    start_at: input.start_at ?? null,
    due_at: input.due_at ?? null,
    pinned: input.pinned ? 1 : 0,
    cron: input.cron ?? null,
    next_run_at: nextRunAt,
    auto_mode: autoMode,
    auto_agent: input.auto_agent ?? null,
    auto_prompt: input.auto_prompt ?? null,
    created_at: now,
    updated_at: now,
    completed_at: status === 'done' ? now : null,
  });
  broadcastChange();
  return getTask(id)!;
}

export function updateTask(id: string, patch: TaskUpdate): Task {
  const d = open();
  const existing = getTask(id);
  if (!existing) throw new Error(`task not found: ${id}`);

  const next = { ...existing, ...patch };
  if (next.start_at && next.due_at && next.due_at < next.start_at) {
    throw new Error('due date must be on or after start date');
  }
  if (!next.title?.trim()) throw new Error('title is required');
  if (!next.folder?.trim()) throw new Error('folder is required');

  const now = Date.now();
  const justCompleted =
    patch.status !== undefined && patch.status === 'done' && existing.status !== 'done';
  const reopened =
    patch.status !== undefined && patch.status !== 'done' && existing.status === 'done';

  // fm-zf3m — derive next_run_at when the patch touches auto/cron and
  // doesn't supply one explicitly. Caller can always force a value
  // (including null) by including next_run_at in the patch.
  if (patch.next_run_at === undefined &&
      (patch.auto_mode !== undefined || patch.cron !== undefined)) {
    if (!next.auto_mode) {
      next.next_run_at = null;
    } else if (next.cron) {
      try {
        next.next_run_at = nextFireFromExpr(next.cron, new Date(now));
      } catch (e) {
        throw new Error(`invalid cron expression: ${(e as Error).message}`);
      }
    } else if (existing.next_run_at == null && !existing.auto_mode) {
      // Auto just turned on with no cron → fire now.
      next.next_run_at = now;
    }
    // else: leave existing schedule alone (e.g. user just edited title).
  }

  // Marking a recurring task done/cancelled means "stop running this." The
  // scheduler already skips done/cancelled rows so it won't fire, but the
  // stale next_run_at would still drive the sidebar's "next in Nm" pill —
  // misleading for a task the user just closed. Clear it unless the caller
  // explicitly supplied one (e.g. the scheduler rolling forward a cron).
  if (justCompleted && patch.next_run_at === undefined) {
    next.next_run_at = null;
  }

  d.prepare(
    `UPDATE tasks SET
       title = @title,
       notes = @notes,
       status = @status,
       folder = @folder,
       ref_folder = @ref_folder,
       start_at = @start_at,
       due_at = @due_at,
       pinned = @pinned,
       cron = @cron,
       next_run_at = @next_run_at,
       auto_mode = @auto_mode,
       auto_agent = @auto_agent,
       auto_prompt = @auto_prompt,
       updated_at = @updated_at,
       completed_at = @completed_at
     WHERE id = @id`,
  ).run({
    id,
    title: next.title.trim(),
    notes: next.notes ?? null,
    status: next.status,
    folder: next.folder,
    ref_folder: next.ref_folder ?? null,
    start_at: next.start_at ?? null,
    due_at: next.due_at ?? null,
    pinned: next.pinned ? 1 : 0,
    cron: next.cron ?? null,
    next_run_at: next.next_run_at ?? null,
    auto_mode: next.auto_mode ? 1 : 0,
    auto_agent: next.auto_agent ?? null,
    auto_prompt: next.auto_prompt ?? null,
    updated_at: now,
    completed_at: justCompleted ? now : reopened ? null : existing.completed_at,
  });
  broadcastChange();
  return getTask(id)!;
}

export function deleteTask(id: string): void {
  const d = open();
  const info = d.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  if (info.changes > 0) broadcastChange();
}

export function countByFolder(folder: string): number {
  const d = open();
  const today = todayLocalISO();
  const row = d
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE folder = @folder
         AND status NOT IN ('done','cancelled')
         AND (start_at IS NULL OR start_at <= @today)`,
    )
    .get({ folder, today }) as { n: number };
  return row.n;
}

// fm-zf3m — main-process subscriber (the scheduler) registers here so
// it can re-arm its single timer after any task write that might have
// changed the soonest fire time. Kept in-module to avoid a circular
// import between tasks.ts and scheduler.ts.
let onTaskChange: (() => void) | null = null;
export function setTaskChangeHook(fn: () => void): void {
  onTaskChange = fn;
}

function broadcastChange() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('tasks:changed');
  }
  // Best-effort, never throws past the caller — a misbehaving hook
  // shouldn't fail a CRUD operation.
  try { onTaskChange?.(); } catch (e) { console.error('[tasks] change hook:', e); }
}

// fm-adc — sidecar markdown for AI-launcher context. When the user
// launches an agent from a task tab we drop the full task here so the
// agent can `cat` it any time (or via the future `breeze` CLI) without
// us re-stuffing every prompt with metadata. YAML frontmatter keeps the
// machine fields parseable; the markdown body is what humans + LLMs
// actually read.
export function writeActiveTaskSidecar(task: Task): string {
  const dir = path.join(os.homedir(), '.breezefile', 'active-tasks');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${task.id}.md`);
  const fm: string[] = [
    '---',
    `id: ${task.id}`,
    `title: ${yamlString(task.title)}`,
    `status: ${task.status}`,
    `folder: ${yamlString(task.folder)}`,
    `ref_folder: ${task.ref_folder == null ? 'null' : yamlString(task.ref_folder)}`,
    `start_at: ${task.start_at == null ? 'null' : task.start_at}`,
    `due_at: ${task.due_at == null ? 'null' : task.due_at}`,
    `pinned: ${task.pinned ? 'true' : 'false'}`,
    '---',
    '',
    `# ${task.title}`,
    '',
  ];
  if (task.notes && task.notes.trim()) {
    fm.push(task.notes.trimEnd(), '');
  }
  writeFileSync(file, fm.join('\n'), 'utf8');
  return file;
}

function yamlString(s: string): string {
  // Quote strings that contain anything that could break a bare scalar.
  // Cheap and conservative — we'd rather over-quote than emit invalid YAML.
  if (/^[\w./ -]+$/.test(s) && !/^(true|false|null|yes|no)$/i.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ─── task_runs (fm-zf3m) ────────────────────────────────────────────
// History of auto-execution attempts. Created when the scheduler decides
// to fire a task; updated as the agent transitions running → succeeded /
// failed / retrying. Read by the sidebar (last-run state), All Tasks
// page (history expand), and the `breeze runs` CLI.

export function createRun(input: TaskRunCreate): TaskRun {
  const d = open();
  const id = crypto.randomUUID();
  d.prepare(
    `INSERT INTO task_runs (
       id, task_id, agent, status, attempt, scheduled_for
     ) VALUES (
       @id, @task_id, @agent, @status, @attempt, @scheduled_for
     )`,
  ).run({
    id,
    task_id: input.task_id,
    agent: input.agent,
    status: input.status ?? 'queued',
    attempt: input.attempt ?? 1,
    scheduled_for: input.scheduled_for,
  });
  broadcastRunChange(input.task_id);
  return getRun(id)!;
}

export function updateRun(id: string, patch: TaskRunUpdate): TaskRun {
  const d = open();
  const existing = getRun(id);
  if (!existing) throw new Error(`run not found: ${id}`);
  const next = { ...existing, ...patch };
  d.prepare(
    `UPDATE task_runs SET
       status = @status,
       started_at = @started_at,
       finished_at = @finished_at,
       conversation_id = @conversation_id,
       output_path = @output_path,
       error_class = @error_class,
       error_message = @error_message,
       exit_code = @exit_code
     WHERE id = @id`,
  ).run({
    id,
    status: next.status,
    started_at: next.started_at,
    finished_at: next.finished_at,
    conversation_id: next.conversation_id,
    output_path: next.output_path,
    error_class: next.error_class,
    error_message: next.error_message,
    exit_code: next.exit_code,
  });
  broadcastRunChange(existing.task_id);
  return getRun(id)!;
}

export function getRun(id: string): TaskRun | null {
  const d = open();
  const row = d.prepare('SELECT * FROM task_runs WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRun(row) : null;
}

export function listRunsForTask(taskId: string, limit = 50): TaskRun[] {
  const d = open();
  const rows = d
    .prepare(
      `SELECT * FROM task_runs
       WHERE task_id = ?
       ORDER BY COALESCE(started_at, scheduled_for) DESC
       LIMIT ?`,
    )
    .all(taskId, limit) as Record<string, unknown>[];
  return rows.map(rowToRun);
}

/** Most recent meaningful run for a task. "Meaningful" excludes
 *  cancelled rows (process-death reaps, manual aborts) when there's a
 *  real run to show — cancellations rarely reflect what the user
 *  cares about. Falls back to the absolute most-recent row when only
 *  cancelled rows exist. */
export function getLastRun(taskId: string): TaskRun | null {
  const d = open();
  const meaningful = d
    .prepare(
      `SELECT * FROM task_runs
        WHERE task_id = @taskId
          AND status != 'cancelled'
        ORDER BY COALESCE(started_at, scheduled_for) DESC
        LIMIT 1`,
    )
    .get({ taskId }) as Record<string, unknown> | undefined;
  if (meaningful) return rowToRun(meaningful);
  const fallback = d
    .prepare(
      `SELECT * FROM task_runs
        WHERE task_id = @taskId
        ORDER BY COALESCE(started_at, scheduled_for) DESC
        LIMIT 1`,
    )
    .get({ taskId }) as Record<string, unknown> | undefined;
  return fallback ? rowToRun(fallback) : null;
}


/** Most recent in-flight run for a task — i.e. one with status in
 *  queued/running/retrying. Used as the backend dedupe guard for
 *  concurrent run-now requests (UI guard alone can race against the
 *  scheduler / external API hits). Returns null when nothing is live. */
export function getInflightRun(taskId: string): TaskRun | null {
  const d = open();
  const row = d
    .prepare(
      `SELECT * FROM task_runs
        WHERE task_id = @taskId
          AND status IN ('queued','running','retrying')
        ORDER BY COALESCE(started_at, scheduled_for) DESC
        LIMIT 1`,
    )
    .get({ taskId }) as Record<string, unknown> | undefined;
  return row ? rowToRun(row) : null;
}

/** Recent runs across all tasks, joined with task title + folder so the
 *  renderer's Runs view can render them without a per-row task fetch.
 *  Sorted newest-first, capped by `limit`. */
export function listAllRuns(limit = 100): Array<TaskRun & { task_title: string; task_folder: string }> {
  const d = open();
  const rows = d
    .prepare(
      `SELECT r.*,
              t.title  AS __task_title,
              t.folder AS __task_folder
         FROM task_runs r
         LEFT JOIN tasks t ON t.id = r.task_id
        ORDER BY COALESCE(r.started_at, r.scheduled_for) DESC
        LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...rowToRun(r),
    task_title: (r.__task_title as string | null) ?? '(deleted task)',
    task_folder: (r.__task_folder as string | null) ?? '',
  }));
}

/** Per-task run counts in one query. Used to render the "N runs" pill
 *  on TasksPage rows without N+1 IPC calls. */
export function runCountsByTask(): Record<string, number> {
  const d = open();
  const rows = d
    .prepare(`SELECT task_id, COUNT(*) AS n FROM task_runs GROUP BY task_id`)
    .all() as Array<{ task_id: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.task_id] = r.n;
  return out;
}

/** Mark any queued/running runs as cancelled. Called once on scheduler
 *  startup — these rows are necessarily orphaned because their owning
 *  process is dead. Returns the number of rows touched. */
export function reapInFlightRuns(): number {
  const d = open();
  const now = Date.now();
  const info = d
    .prepare(
      `UPDATE task_runs
         SET status = 'cancelled',
             finished_at = COALESCE(finished_at, @now),
             error_class = COALESCE(error_class, 'transient'),
             error_message = COALESCE(error_message, 'process exited before run completed')
       WHERE status IN ('queued','running','retrying')`,
    )
    .run({ now });
  return info.changes;
}

/** Tasks whose next_run_at is at or before `now`, ordered by soonest.
 *  This is the scheduler's wake-up query — keep cheap (covered by
 *  idx_tasks_next_run). Excludes tasks already in a non-active status. */
export function dueAutoTasks(now: number): Task[] {
  const d = open();
  const rows = d
    .prepare(
      `SELECT * FROM tasks
       WHERE auto_mode = 1
         AND next_run_at IS NOT NULL
         AND next_run_at <= @now
         AND status NOT IN ('done','cancelled')
       ORDER BY next_run_at ASC`,
    )
    .all({ now }) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

/** Soonest pending fire across all auto tasks, or null. The scheduler
 *  uses this to set its single setTimeout. */
export function nextScheduledFire(): number | null {
  const d = open();
  const row = d
    .prepare(
      `SELECT MIN(next_run_at) AS t FROM tasks
       WHERE auto_mode = 1
         AND next_run_at IS NOT NULL
         AND status NOT IN ('done','cancelled')`,
    )
    .get() as { t: number | null } | undefined;
  return row?.t ?? null;
}

function broadcastRunChange(taskId: string) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('task-runs:changed', { taskId });
    }
  }
}

// For tests / explicit cleanup. Production code never calls this — the
// connection lives for the lifetime of the main process.
export function _closeForTests() {
  if (db) {
    db.close();
    db = null;
  }
}
