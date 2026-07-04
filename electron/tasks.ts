// Breeze-native task store (fm-dhc).
//
// Single SQLite database at ~/.breezefile/tasks.db. Tasks are folder-anchored
// to-dos with optional date-only start/due, status, pinned flag, and notes.
// All writes broadcast `tasks:changed` over IPC so any open BrowserWindow can
// re-pull the affected slice without polling.

import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { nextFireFromExpr } from './cron';
import { breezeHost } from './core/host';

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
  /** fm-b5at.7 — run-style + agent flags vocabulary (chrome/auto/resume/
   *  interactive). Stored as a JSON array; an empty array (the default)
   *  means a plain headless run. 'interactive' selects the embedded-tab
   *  run style; the rest map to claude CLI args (electron/agents/flags.ts). */
  flags: string[];
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  /** fm-5xy — day-only 'YYYY-MM-DD' the task was last surfaced in a start/
   *  near-due reminder, or null if never. Dedupe key so a restart or the daily
   *  8am tick doesn't re-notify the same task for the same calendar day. This
   *  is a LOCAL-store concern only; remote (TypeBuild) rows omit it, so it's
   *  optional across the source seam. rowToTask always populates it for local
   *  rows. */
  last_notified_for_date?: string | null;
  // task-19ba9f7f43f1 — a STRUCTURED, type-dispatched task result (bespoke
  // rendering; a `table` first). Populated by a remote source (TypeBuild) when
  // the server carries one; local rows omit it. OPTIONAL across the seam so
  // nothing breaks for tasks without it, and the client falls back to the plain
  // notes view for a missing/unknown/malformed result (NON-REGRESSION). PHI:
  // `payload` is task OUTPUT — carried in memory with the task (like notes),
  // NEVER persisted to the skeleton store (which has no result column), logged,
  // or written to notes/files.
  result?: { type: string; payload: unknown } | null;
  // task-da23979fd907 — the USER-facing status channel: an append-only,
  // newest-last feed of { text, by, at }. DISTINCT from `notes` (which is the
  // claim-holder-only AGENT progress body): anyone who can see the task may
  // append a message. Populated by a remote source (TypeBuild) from the detail
  // endpoint; local rows omit it, so it's OPTIONAL across the seam (a task
  // without messages renders exactly as today — NON-REGRESSION). PHI: `text` is
  // patient-visible content (encrypted at rest server-side) — carried in memory
  // with the task (like notes/body), NEVER persisted to the skeleton store
  // (which has no messages column), logged, or written to notes/files. `by`+`at`
  // are NON-PHI (an email principal + an ISO timestamp).
  messages?: { text: string; by: string; at: string }[];
  // task-91d13f9d5469 — a PENDING QUESTION the task is BLOCKED on: an agent (or
  // a person) called `ask_user`, and the task now waits on a HUMAN answer.
  // Populated by a remote source (TypeBuild) from the get_task/list endpoint;
  // cleared server-side by `answer_question`. Local rows omit it, so it's
  // OPTIONAL across the seam (a task without a pending question renders exactly
  // as today — NON-REGRESSION). It drives the LOUDEST attention bucket (`asked`,
  // W_ASKED) because only a human can clear it. PHI: `text` is patient-visible
  // question content (encrypted at rest server-side) — carried in memory with
  // the task (like notes/messages), NEVER persisted to the skeleton store (which
  // has no pending_question column), logged, or written to notes/files.
  // `options`/`asked_by`/`asked_at` are NON-PHI (choices + email principal + ISO
  // timestamp). `null` (or absent) means "no pending question".
  pending_question?: {
    text: string;
    options?: string[];
    asked_by?: string;
    asked_at?: string;
  } | null;
  // task-ce4b4c8ca955 — the server's first-class OUTPUT FIELD SCHEMA (S2): the
  // declared output fields for a task that isn't part of a v2 task-template
  // chain (a "single-task" job) — same TaskDefField shape the client's own
  // ```task-outputs block carries (src/components/newhome/types.ts
  // TaskDefField), just declared server-side instead of parsed out of a task
  // body. This is what lets a PLAIN top-level task (no children, no
  // ```task-template block) still surface an output column in the New Home
  // roster + a one-line summary in OutcomesPanel — see useNewHomeData
  // resolveJob's `status:'fielded'` case. Populated by a remote source
  // (TypeBuild) from the get_task endpoint; local rows omit it, so it's
  // OPTIONAL across the seam (a task without a schema renders exactly as
  // today — NON-REGRESSION). NON-PHI: field DEFINITIONS only (key/label/type/
  // options/required), NEVER values — values ride `result.payload` as always.
  outputSchema?: {
    key: string;
    label: string;
    type: 'text' | 'number' | 'date' | 'select' | 'bool';
    options?: string[];
    required?: boolean;
  }[];
};

export type TaskCreate = {
  title: string;
  folder: string;
  notes?: string | null;
  status?: TaskStatus;
  start_at?: string | null;
  due_at?: string | null;
  pinned?: boolean;
  cron?: string | null;
  next_run_at?: number | null;
  auto_mode?: boolean;
  auto_agent?: AgentId | null;
  auto_prompt?: string | null;
  flags?: string[];
  // fm-r8vj (S5 plumbing) — optional TypeBuild-create fields the composer may
  // pass through. The local store ignores both (createTask builds its row from
  // the fields above); declared here only so the shared TaskCreate shape
  // type-checks across the source seam.
  deferUntil?: string | null;
  priority?: number;
  // task-ab1d7955e23f — optional TypeBuild project container (opaque id,
  // non-PHI). The local store ignores it; the TypeBuild source maps it to the
  // server's `project_id` on create.
  projectId?: string;
  // task-896f3f7f5e75 — optional TypeBuild agent assignment (opaque id, NON-PHI;
  // one agent per task). The local store ignores it; the TypeBuild source maps
  // it to the server's `agent_id` on create. Omitted / '' = no agent.
  agentId?: string;
  // task-83a30b3c8804 — optional TypeBuild chain/linking fields (opaque ids,
  // NON-PHI). The local store ignores both; the TypeBuild source maps
  // parentTaskId → `parent_task_id` and dependsOn → `depends_on` on create.
  parentTaskId?: string | null;
  dependsOn?: string[] | null;
  // task-7bdb94445321 — optional NON-PHI repeat schedule (RRULE-lite '<n><unit>',
  // unit d|w|m). The local store ignores it; the TypeBuild source maps it to the
  // server's `recurrence` on create so a "repeatable task" repeats from birth.
  recurrence?: string | null;
  // task-a7214605a998 (S6) — optional STRUCTURED output field schema (NON-PHI
  // definitions) + data map (PHI form-fill values), first-class on the server
  // (S2 output_schema, S1 data) instead of the composer's old ```task-outputs/
  // ```task-fields fenced blocks. The local store ignores both; the TypeBuild
  // source maps them onto the server's `output_schema`/`data` create fields.
  // Declared here (mirroring src/types.ts TaskCreate) only so the shared shape
  // type-checks across the source seam.
  outputSchema?: {
    key: string;
    label: string;
    type: 'text' | 'number' | 'date' | 'select' | 'bool';
    options?: string[];
    required?: boolean;
  }[];
  data?: Record<string, string>;
};

export type TaskUpdate = Partial<{
  title: string;
  notes: string | null;
  status: TaskStatus;
  folder: string;
  start_at: string | null;
  due_at: string | null;
  pinned: boolean;
  cron: string | null;
  next_run_at: number | null;
  auto_mode: boolean;
  auto_agent: AgentId | null;
  auto_prompt: string | null;
  flags: string[];
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
  /** fm-lji6 (S2) — "Mine" toggle. Only the typebuild source consumes this
   *  (server-backed via ?claimed_by=me); the local source ignores it. */
  claimedByMe?: boolean;
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

/** Run the migration chain on an arbitrary connection. Exposed so a sibling
 *  module (electron/schedule-overlay.ts) that opens its own handle to the same
 *  tasks.db can ensure its table exists without racing tasks.ts's lazy open.
 *  Idempotent — gated on schema_version, so calling it per-connection is safe
 *  (WAL allows multiple connections to the same file). */
export function ensureSchema(d: Database.Database): void {
  migrate(d);
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
          ref_folder TEXT, -- dropped in v3; kept here so the migration chain is consistent
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

    // v3 — drop ref_folder. The "tasks anchored to two folders" idea
    // never shipped, and tasks with no folder are now valid (run from
    // anywhere). DROP COLUMN is supported on SQLite ≥ 3.35 (2021), well
    // below better-sqlite3's bundled version.
    (db) => {
      db.exec(`ALTER TABLE tasks DROP COLUMN ref_folder;`);
    },

    // v4 — flags vocabulary (fm-b5at.7). JSON array of agent flags
    // (chrome/auto/resume/interactive). Default '[]' = plain headless run.
    (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN flags TEXT NOT NULL DEFAULT '[]';`);
    },

    // v5 — PHI-free schedule overlay for remote-source tasks (fm-b5at.8).
    // Lets a time-gated remote (TypeBuild) task fire on the local cron. The
    // server owns the queue; Breezefile owns timing. STRICTLY PHI-free:
    // opaque ids + cron only — never titles/bodies. The overlay module
    // (electron/schedule-overlay.ts) owns all reads/writes; this migration
    // just creates the table on the shared DB. No FK to `tasks` (the rows
    // reference REMOTE ids that have no local task row).
    (db) => {
      db.exec(`
        CREATE TABLE remote_schedule (
          source_id   TEXT NOT NULL,
          task_id     TEXT NOT NULL,
          cron        TEXT NOT NULL,
          next_run_at INTEGER NOT NULL,
          created_at  INTEGER NOT NULL,
          PRIMARY KEY (source_id, task_id)
        );
        CREATE INDEX idx_remote_schedule_next ON remote_schedule(next_run_at);
      `);
    },

    // v6 — start_at / due_at reminder dedupe (fm-5xy). Records the day-only
    // 'YYYY-MM-DD' a task was last surfaced in a start/near-due reminder, so a
    // restart or the daily 8am tick never re-notifies the same task for the
    // same day. NULL = never notified. The value is the LOCAL calendar day the
    // notification was raised for (matches start_at/due_at's day-only shape).
    (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN last_notified_for_date TEXT;`);
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
    start_at: (r.start_at as string | null) ?? null,
    due_at: (r.due_at as string | null) ?? null,
    pinned: ((r.pinned as number) ?? 0) === 1,
    cron: (r.cron as string | null) ?? null,
    next_run_at: (r.next_run_at as number | null) ?? null,
    auto_mode: ((r.auto_mode as number) ?? 0) === 1,
    auto_agent: (r.auto_agent as string | null) ?? null,
    auto_prompt: (r.auto_prompt as string | null) ?? null,
    flags: parseFlags(r.flags),
    created_at: r.created_at as number,
    updated_at: r.updated_at as number,
    completed_at: (r.completed_at as number | null) ?? null,
    last_notified_for_date: (r.last_notified_for_date as string | null) ?? null,
  };
}

/** flags is stored as a JSON array string. Tolerate legacy NULL / malformed
 *  values by falling back to an empty list; keep only string entries. */
function parseFlags(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function serializeFlags(flags: string[] | null | undefined): string {
  return JSON.stringify(Array.isArray(flags) ? flags.filter((x) => typeof x === 'string') : []);
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
  // fm-femh — folder is required only for *scheduled* agent runs: the
  // scheduler has no folder context at fire time, so it needs an anchor.
  // On-demand agent tasks (auto_mode=true, no cron, next_run_at=null) and
  // manual tasks both run with a click-time cwd, so folder is optional.
  const explicitNextProvided = Object.prototype.hasOwnProperty.call(
    input,
    'next_run_at',
  );
  // On-demand: caller explicitly passes next_run_at=null AND no cron.
  // Anything else with auto_mode=true ends up scheduled (cron, fire-now
  // default, or explicit non-null next_run_at).
  const isOnDemand =
    input.auto_mode === true &&
    !input.cron &&
    explicitNextProvided &&
    input.next_run_at == null;
  const willBeScheduled = input.auto_mode === true && !isOnDemand;
  if (willBeScheduled && !input.folder?.trim()) {
    throw new Error('folder is required for scheduled agent tasks');
  }
  if (input.start_at && input.due_at && input.due_at < input.start_at) {
    throw new Error('due date must be on or after start date');
  }
  const d = open();
  const now = Date.now();
  const id = crypto.randomUUID();
  const status: TaskStatus = input.status ?? 'pending';
  // fm-zf3m / fm-femh — schedule on creation:
  //   auto + cron, no explicit next         → first cron fire from now
  //   auto, no cron, no explicit next       → fire now (one-shot run-on-save)
  //   auto + explicit next_run_at = null    → on-demand (folder tab triggers)
  //   auto + explicit next_run_at = number  → trust the caller
  //   non-auto                              → null
  // The hasOwnProperty check distinguishes "caller passed null on
  // purpose" (on-demand) from "caller didn't pass anything" (default
  // to fire-now). Without it, on-demand tasks fire immediately on save.
  const autoMode = input.auto_mode ? 1 : 0;
  let nextRunAt: number | null = input.next_run_at ?? null;
  if (autoMode && !explicitNextProvided) {
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
      id, title, notes, status, folder,
      start_at, due_at, pinned,
      cron, next_run_at, auto_mode, auto_agent, auto_prompt, flags,
      created_at, updated_at, completed_at
    ) VALUES (
      @id, @title, @notes, @status, @folder,
      @start_at, @due_at, @pinned,
      @cron, @next_run_at, @auto_mode, @auto_agent, @auto_prompt, @flags,
      @created_at, @updated_at, @completed_at
    )`,
  ).run({
    id,
    title: input.title.trim(),
    notes: input.notes ?? null,
    status,
    folder: input.folder ?? '',
    start_at: input.start_at ?? null,
    due_at: input.due_at ?? null,
    pinned: input.pinned ? 1 : 0,
    cron: input.cron ?? null,
    next_run_at: nextRunAt,
    auto_mode: autoMode,
    auto_agent: input.auto_agent ?? null,
    auto_prompt: input.auto_prompt ?? null,
    flags: serializeFlags(input.flags),
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
  // fm-femh — same scheduled-vs-on-demand split as createTask. We can use
  // `next` directly here because the patch has been merged onto `existing`
  // and updateTask doesn't run the auto-default logic until after this check.
  const nextIsOnDemand =
    next.auto_mode === true && !next.cron && next.next_run_at == null;
  const nextIsScheduled = next.auto_mode === true && !nextIsOnDemand;
  if (nextIsScheduled && !next.folder?.trim()) {
    throw new Error('folder is required for scheduled agent tasks');
  }

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
       start_at = @start_at,
       due_at = @due_at,
       pinned = @pinned,
       cron = @cron,
       next_run_at = @next_run_at,
       auto_mode = @auto_mode,
       auto_agent = @auto_agent,
       auto_prompt = @auto_prompt,
       flags = @flags,
       updated_at = @updated_at,
       completed_at = @completed_at
     WHERE id = @id`,
  ).run({
    id,
    title: next.title.trim(),
    notes: next.notes ?? null,
    status: next.status,
    folder: next.folder,
    start_at: next.start_at ?? null,
    due_at: next.due_at ?? null,
    pinned: next.pinned ? 1 : 0,
    cron: next.cron ?? null,
    next_run_at: next.next_run_at ?? null,
    auto_mode: next.auto_mode ? 1 : 0,
    auto_agent: next.auto_agent ?? null,
    auto_prompt: next.auto_prompt ?? null,
    flags: serializeFlags(next.flags),
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
  breezeHost().onTasksChanged();
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

/** fm-5xy — record that `id` was surfaced in a start/near-due reminder for the
 *  given local calendar day ('YYYY-MM-DD'). Idempotent dedupe key: the reminder
 *  scan skips tasks whose last_notified_for_date already equals today. Written
 *  to the durable DB so a restart on the same day doesn't re-notify. Does NOT
 *  bump updated_at or broadcast — this is bookkeeping, not a user-visible edit. */
export function markNotifiedForDate(id: string, date: string): void {
  const d = open();
  d.prepare('UPDATE tasks SET last_notified_for_date = @date WHERE id = @id').run({
    id,
    date,
  });
}

/** fm-5xy — open local tasks whose start_at or due_at is relevant for reminders
 *  (not done/cancelled). Returns the raw Task rows; the pure selector in
 *  core/task-reminders.mjs decides which actually fire for a given day + mode.
 *  Cheap: bounded by the open-task count and only pulls dated rows. */
export function reminderCandidates(): Task[] {
  const d = open();
  const rows = d
    .prepare(
      `SELECT * FROM tasks
        WHERE status NOT IN ('done','cancelled')
          AND (start_at IS NOT NULL OR due_at IS NOT NULL)`,
    )
    .all() as Record<string, unknown>[];
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
  breezeHost().onRunsChanged(taskId);
}

// For tests / explicit cleanup. Production code never calls this — the
// connection lives for the lifetime of the main process.
export function _closeForTests() {
  if (db) {
    db.close();
    db = null;
  }
}
