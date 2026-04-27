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
import { mkdirSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';

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
    created_at: r.created_at as number,
    updated_at: r.updated_at as number,
    completed_at: (r.completed_at as number | null) ?? null,
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
  d.prepare(
    `INSERT INTO tasks (
      id, title, notes, status, folder, ref_folder,
      start_at, due_at, pinned,
      created_at, updated_at, completed_at
    ) VALUES (
      @id, @title, @notes, @status, @folder, @ref_folder,
      @start_at, @due_at, @pinned,
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

function broadcastChange() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('tasks:changed');
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
