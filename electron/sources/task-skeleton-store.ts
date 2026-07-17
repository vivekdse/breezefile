// task-b3fb2928bb3c (Phase 1) — PHI-FREE persistent skeleton store for the
// TypeBuild task cache. Backs TypeBuildTaskSource.cache so Home renders
// INSTANTLY on cold start from disk, before the first network round-trip.
//
// PHI INVARIANT (non-negotiable): decrypted TITLES and BODIES are PHI and live
// in MEMORY ONLY. This store persists ONLY the NON-PHI routing skeleton — the
// columns in task-skeleton-schema.mjs. There is NO title/body/notes column,
// by construction, and the upsert NEVER receives task text. A SourcedTask's
// `title`/`notes` are simply not read here. The schema module's
// SKELETON_COLUMNS + the no-PHI-columns test enforce this structurally.
//
// Lives at ~/.breezefile/typebuild-skeleton.db (its OWN db file, separate from
// tasks.db — the local tasks store; this keeps the remote routing cache from
// entangling with the local task schema/migration chain). WAL like the rest.
//
// Timestamps (load-bearing — see the attention-floor note in mapListRow): the
// server LIST endpoint NOW emits real created_at/updated_at (task-b1fe80e2669b
// / Phase 2). mapListRow uses those; the Date.now() floor only survives as the
// fallback when the server omits them. We persist whatever the caller hands us
// (the real server value, or that fallback). On RELOAD from disk we return the
// stored epoch. The created_at upsert still keeps the EARLIEST value seen (a
// stable floor) so a row's create-time sort key never jumps; updated_at takes
// the latest server value so "last touched" is true. This is STRICTLY BETTER
// for the attention floor than the Phase-1 now()-placeholder.

import Database from 'better-sqlite3';
import path from 'node:path';
import { stateDir } from '../core/profile.mjs';
import { existsSync, mkdirSync } from 'node:fs';
import {
  SKELETON_TABLE_SQL,
  SKELETON_INDEX_SQL,
  PROJECT_TABLE_SQL,
  META_TABLE_SQL,
  SYNC_CURSOR_KEY,
  diffSkeleton,
  deltaSkeleton,
  type SkeletonDiff,
} from './task-skeleton-schema.mjs';
import type { SourcedTask } from '../core/task-source';
import type { Project } from './typebuild';

// The non-PHI routing skeleton as persisted/loaded. A strict subset of
// SourcedTask — NO title/notes. Loaded rows are layered UNDER the in-memory
// title/body in TypeBuildTaskSource (the skeleton drives order/filter/counts;
// human text hydrates from memory).
export type SkeletonTask = Pick<
  SourcedTask,
  | 'id'
  | 'status'
  | 'rawStatus'
  | 'claimedBy'
  | 'assignedTo'
  | 'attempts'
  | 'maxAttempts'
  | 'flags'
  | 'priority'
  | 'due_at'
  | 'deferUntil'
  | 'projectId'
  | 'parentTaskId'
  | 'created_at'
  | 'updated_at'
  | 'completed_at'
  | 'createdAtIso'
  | 'updatedAtIso'
  | 'claimedAt'
>;

type SkelRow = {
  id: string;
  status: string | null;
  raw_status: string | null;
  claimed_by: string | null;
  assigned_to: string | null;
  attempts: number | null;
  max_attempts: number | null;
  flags: string | null;
  priority: number | null;
  due_at: string | null;
  defer_until: string | null;
  project_id: string | null;
  parent_task_id: string | null;
  created_at: number | null;
  updated_at: number | null;
  completed_at: number | null;
  created_at_iso: string | null;
  updated_at_iso: string | null;
  claimed_at: string | null;
  tombstone: number;
  seen_at: number;
};

let db: Database.Database | null = null;

function dbPath(): string {
  return path.join(stateDir(), 'typebuild-skeleton.db');
}

function ensureDir(): void {
  const dir = path.dirname(dbPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function open(): Database.Database {
  if (db) return db;
  ensureDir();
  db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  db.exec(SKELETON_TABLE_SQL);
  db.exec(SKELETON_INDEX_SQL);
  db.exec(PROJECT_TABLE_SQL);
  // task-b1fe80e2669b (Phase 2) — additive: the NON-PHI sync bookkeeping kv
  // table (holds only `sync_cursor`, a timestamp). CREATE IF NOT EXISTS, so an
  // existing Phase-1 db gains the table on first open with no migration step.
  db.exec(META_TABLE_SQL);
  return db;
}

function parseFlags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function rowToSkeleton(r: SkelRow): SkeletonTask {
  const status = (r.status ?? 'pending') as SourcedTask['status'];
  return {
    id: r.id,
    status,
    rawStatus: r.raw_status ?? undefined,
    claimedBy: r.claimed_by ?? null,
    assignedTo: r.assigned_to ?? null,
    attempts: r.attempts == null ? undefined : r.attempts,
    maxAttempts: r.max_attempts == null ? undefined : r.max_attempts,
    flags: parseFlags(r.flags),
    priority: r.priority == null ? undefined : r.priority,
    due_at: r.due_at ?? null,
    deferUntil: r.defer_until ?? null,
    projectId: r.project_id ?? null,
    parentTaskId: r.parent_task_id ?? null,
    created_at: r.created_at ?? Date.now(),
    updated_at: r.updated_at ?? Date.now(),
    completed_at: r.completed_at ?? null,
    createdAtIso: r.created_at_iso ?? null,
    updatedAtIso: r.updated_at_iso ?? null,
    claimedAt: r.claimed_at ?? null,
  };
}

// ─── Skeleton reads ────────────────────────────────────────────────────────

/** All LIVE (non-tombstoned) skeleton rows, for cold-start hydration of the
 *  in-memory cache. PHI-free by construction. */
export function loadLiveSkeleton(): SkeletonTask[] {
  const d = open();
  const rows = d
    .prepare('SELECT * FROM task_skeleton WHERE tombstone = 0')
    .all() as SkelRow[];
  return rows.map(rowToSkeleton);
}

/** A single live skeleton row (or null) — used to preserve a stable created_at
 *  floor across upserts. */
function existingRow(d: Database.Database, id: string): SkelRow | undefined {
  return d.prepare('SELECT * FROM task_skeleton WHERE id = ?').get(id) as
    | SkelRow
    | undefined;
}

/** The server's last-known `updated_at` (ISO) for one task, or null when the
 *  task is unknown locally. NON-PHI (routing metadata only). Used by the
 *  task-data value cache (task-data.ts / task-phi-store's data-cache tables) as
 *  a cheap freshness signal: a cached data-bag/vault value is trusted only
 *  while it matches the task's current skeleton `updated_at` — no need to open
 *  the encrypted PHI DB just to check staleness. */
export function getSkeletonUpdatedAtIso(id: string): string | null {
  const d = open();
  const row = d.prepare('SELECT updated_at_iso FROM task_skeleton WHERE id = ?').get(id) as
    | { updated_at_iso: string | null }
    | undefined;
  return row?.updated_at_iso ?? null;
}

// ─── Reconcile ─────────────────────────────────────────────────────────────
// Replace the live set with `fresh`, computing the added/changed/removed diff
// against what was live. Upserts every fresh row (clearing any tombstone),
// tombstones ids that are now absent, and returns the diff so the caller can
// broadcast ONLY what moved. Done in one transaction so a crash mid-reconcile
// can't leave a torn view.
//
// `fresh` carries the NON-PHI skeleton projection of the server list. The
// in-memory title/body is NOT passed here and is never persisted.
export function reconcile(fresh: SkeletonTask[]): SkeletonDiff {
  const d = open();
  const now = Date.now();

  // Previous LIVE rows (for the diff). Project to the schema-snake shape the
  // pure diff expects.
  const prevRows = d
    .prepare('SELECT * FROM task_skeleton WHERE tombstone = 0')
    .all() as SkelRow[];
  const prevForDiff = prevRows.map((r) => ({
    id: r.id,
    status: r.status,
    raw_status: r.raw_status,
    claimed_by: r.claimed_by,
    assigned_to: r.assigned_to,
    attempts: r.attempts,
    max_attempts: r.max_attempts,
    priority: r.priority,
    due_at: r.due_at,
    defer_until: r.defer_until,
    project_id: r.project_id,
    parent_task_id: r.parent_task_id,
  }));
  const freshForDiff = fresh.map((t) => ({
    id: t.id,
    status: t.status ?? null,
    raw_status: t.rawStatus ?? null,
    claimed_by: t.claimedBy ?? null,
    assigned_to: t.assignedTo ?? null,
    attempts: t.attempts ?? null,
    max_attempts: t.maxAttempts ?? null,
    priority: t.priority ?? null,
    due_at: t.due_at ?? null,
    defer_until: t.deferUntil ?? null,
    project_id: t.projectId ?? null,
    parent_task_id: t.parentTaskId ?? null,
  }));

  const diff = diffSkeleton(prevForDiff, freshForDiff);

  const upsert = d.prepare(`
    INSERT INTO task_skeleton (
      id, status, raw_status, claimed_by, assigned_to,
      attempts, max_attempts, flags, priority,
      due_at, defer_until, project_id, parent_task_id,
      created_at, updated_at, completed_at,
      created_at_iso, updated_at_iso, claimed_at,
      tombstone, seen_at
    ) VALUES (
      @id, @status, @raw_status, @claimed_by, @assigned_to,
      @attempts, @max_attempts, @flags, @priority,
      @due_at, @defer_until, @project_id, @parent_task_id,
      @created_at, @updated_at, @completed_at,
      @created_at_iso, @updated_at_iso, @claimed_at,
      0, @seen_at
    )
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      raw_status = excluded.raw_status,
      claimed_by = excluded.claimed_by,
      assigned_to = excluded.assigned_to,
      attempts = excluded.attempts,
      max_attempts = excluded.max_attempts,
      flags = excluded.flags,
      priority = excluded.priority,
      due_at = excluded.due_at,
      defer_until = excluded.defer_until,
      project_id = excluded.project_id,
      parent_task_id = excluded.parent_task_id,
      -- created_at is a stable floor: keep the EARLIEST value we've seen so a
      -- row's sort key doesn't jump to now() each poll (attention-floor note).
      created_at = MIN(task_skeleton.created_at, excluded.created_at),
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at,
      created_at_iso = COALESCE(excluded.created_at_iso, task_skeleton.created_at_iso),
      updated_at_iso = COALESCE(excluded.updated_at_iso, task_skeleton.updated_at_iso),
      claimed_at = COALESCE(excluded.claimed_at, task_skeleton.claimed_at),
      tombstone = 0,
      seen_at = excluded.seen_at
  `);

  const freshIds = new Set(fresh.map((t) => t.id));

  const txn = d.transaction(() => {
    for (const t of fresh) {
      const prev = existingRow(d, t.id);
      // Stable created_at floor: prefer the earliest of (existing, incoming).
      const incomingCreated = t.created_at ?? now;
      const created =
        prev?.created_at != null
          ? Math.min(prev.created_at, incomingCreated)
          : incomingCreated;
      upsert.run({
        id: t.id,
        status: t.status ?? null,
        raw_status: t.rawStatus ?? null,
        claimed_by: t.claimedBy ?? null,
        assigned_to: t.assignedTo ?? null,
        attempts: t.attempts ?? null,
        max_attempts: t.maxAttempts ?? null,
        flags: JSON.stringify(Array.isArray(t.flags) ? t.flags : []),
        priority: t.priority ?? null,
        due_at: t.due_at ?? null,
        defer_until: t.deferUntil ?? null,
        project_id: t.projectId ?? null,
        parent_task_id: t.parentTaskId ?? null,
        created_at: created,
        updated_at: t.updated_at ?? now,
        completed_at: t.completed_at ?? null,
        created_at_iso: t.createdAtIso ?? null,
        updated_at_iso: t.updatedAtIso ?? null,
        claimed_at: t.claimedAt ?? null,
        seen_at: now,
      });
    }
    // Tombstone live rows that the fresh list no longer carries.
    const liveIds = (
      d.prepare('SELECT id FROM task_skeleton WHERE tombstone = 0').all() as {
        id: string;
      }[]
    ).map((r) => r.id);
    const tomb = d.prepare(
      'UPDATE task_skeleton SET tombstone = 1, seen_at = ? WHERE id = ?',
    );
    for (const id of liveIds) {
      if (!freshIds.has(id)) tomb.run(now, id);
    }
  });
  txn();
  return diff;
}

// ─── Delta reconcile (task-b1fe80e2669b / Phase 2) ──────────────────────────
// Apply a DELTA pull: upsert ONLY the rows the server reported changed and
// DELETE-tombstone the ids the server reported deleted (we do NOT infer removal
// from absence here — the unchanged majority simply isn't in `changed`). Returns
// the added/changed/removed diff (computed against the previous live set) so the
// caller broadcasts only what moved. One transaction, like reconcile().
//
// `changed` carries the NON-PHI skeleton projection of the changed rows; the
// in-memory title/body is NOT passed here and is never persisted. `tombstones`
// is an explicit id list (server `tombstones[].id`).
export function applyDelta(
  changed: SkeletonTask[],
  tombstones: string[],
): SkeletonDiff {
  const d = open();
  const now = Date.now();

  // Previous LIVE set (for the diff). Same snake projection diffSkeleton/
  // deltaSkeleton expect.
  const prevRows = d
    .prepare('SELECT * FROM task_skeleton WHERE tombstone = 0')
    .all() as SkelRow[];
  const prevForDiff = prevRows.map((r) => ({
    id: r.id,
    status: r.status,
    raw_status: r.raw_status,
    claimed_by: r.claimed_by,
    assigned_to: r.assigned_to,
    attempts: r.attempts,
    max_attempts: r.max_attempts,
    priority: r.priority,
    due_at: r.due_at,
    defer_until: r.defer_until,
    project_id: r.project_id,
    parent_task_id: r.parent_task_id,
  }));
  const changedForDiff = changed.map((t) => ({
    id: t.id,
    status: t.status ?? null,
    raw_status: t.rawStatus ?? null,
    claimed_by: t.claimedBy ?? null,
    assigned_to: t.assignedTo ?? null,
    attempts: t.attempts ?? null,
    max_attempts: t.maxAttempts ?? null,
    priority: t.priority ?? null,
    due_at: t.due_at ?? null,
    defer_until: t.deferUntil ?? null,
    project_id: t.projectId ?? null,
    parent_task_id: t.parentTaskId ?? null,
  }));

  const tombIds = Array.isArray(tombstones) ? tombstones : [];
  const diff = deltaSkeleton(prevForDiff, changedForDiff, tombIds);

  const upsert = d.prepare(`
    INSERT INTO task_skeleton (
      id, status, raw_status, claimed_by, assigned_to,
      attempts, max_attempts, flags, priority,
      due_at, defer_until, project_id, parent_task_id,
      created_at, updated_at, completed_at,
      created_at_iso, updated_at_iso, claimed_at,
      tombstone, seen_at
    ) VALUES (
      @id, @status, @raw_status, @claimed_by, @assigned_to,
      @attempts, @max_attempts, @flags, @priority,
      @due_at, @defer_until, @project_id, @parent_task_id,
      @created_at, @updated_at, @completed_at,
      @created_at_iso, @updated_at_iso, @claimed_at,
      0, @seen_at
    )
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      raw_status = excluded.raw_status,
      claimed_by = excluded.claimed_by,
      assigned_to = excluded.assigned_to,
      attempts = excluded.attempts,
      max_attempts = excluded.max_attempts,
      flags = excluded.flags,
      priority = excluded.priority,
      due_at = excluded.due_at,
      defer_until = excluded.defer_until,
      project_id = excluded.project_id,
      parent_task_id = excluded.parent_task_id,
      -- created_at floor: keep the earliest value (a re-appearing row keeps its
      -- original create stamp; matches reconcile()).
      created_at = MIN(task_skeleton.created_at, excluded.created_at),
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at,
      created_at_iso = COALESCE(excluded.created_at_iso, task_skeleton.created_at_iso),
      updated_at_iso = COALESCE(excluded.updated_at_iso, task_skeleton.updated_at_iso),
      claimed_at = COALESCE(excluded.claimed_at, task_skeleton.claimed_at),
      tombstone = 0,
      seen_at = excluded.seen_at
  `);

  // task-b1fe80e2669b — a server delete is a HARD removal of the routing row, so
  // we tombstone it (mirrors reconcile's absence-tombstone). Tombstone (not row
  // delete) keeps the "re-appearing id is an add again" semantics consistent
  // with the full path and lets seen_at record when we dropped it.
  const tomb = d.prepare(
    'UPDATE task_skeleton SET tombstone = 1, seen_at = ? WHERE id = ?',
  );

  const txn = d.transaction(() => {
    for (const t of changed) {
      const prev = existingRow(d, t.id);
      const incomingCreated = t.created_at ?? now;
      const created =
        prev?.created_at != null
          ? Math.min(prev.created_at, incomingCreated)
          : incomingCreated;
      upsert.run({
        id: t.id,
        status: t.status ?? null,
        raw_status: t.rawStatus ?? null,
        claimed_by: t.claimedBy ?? null,
        assigned_to: t.assignedTo ?? null,
        attempts: t.attempts ?? null,
        max_attempts: t.maxAttempts ?? null,
        flags: JSON.stringify(Array.isArray(t.flags) ? t.flags : []),
        priority: t.priority ?? null,
        due_at: t.due_at ?? null,
        defer_until: t.deferUntil ?? null,
        project_id: t.projectId ?? null,
        parent_task_id: t.parentTaskId ?? null,
        created_at: created,
        updated_at: t.updated_at ?? now,
        completed_at: t.completed_at ?? null,
        created_at_iso: t.createdAtIso ?? null,
        updated_at_iso: t.updatedAtIso ?? null,
        claimed_at: t.claimedAt ?? null,
        seen_at: now,
      });
    }
    for (const id of tombIds) tomb.run(now, id);
  });
  txn();
  return diff;
}

// ─── Sync cursor (task-b1fe80e2669b / Phase 2) ──────────────────────────────
// The cursor is the server's `server_time` from the last delta pull, replayed
// as the next `?updated_since=`. It is a TIMESTAMP — categorically NON-PHI.

/** Read the persisted sync cursor (last server_time), or null if never set. */
export function getSyncCursor(): string | null {
  const d = open();
  const row = d
    .prepare('SELECT v FROM sync_meta WHERE k = ?')
    .get(SYNC_CURSOR_KEY) as { v: string | null } | undefined;
  return row?.v ?? null;
}

/** Persist the sync cursor (the next `updated_since` watermark). Non-PHI. */
export function setSyncCursor(cursor: string): void {
  const d = open();
  d.prepare(
    `INSERT INTO sync_meta (k, v) VALUES (?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
  ).run(SYNC_CURSOR_KEY, cursor);
}

/** Optimistic single-row patch mirror (fm-kmhq) — when the in-memory cache is
 *  patched after a succeeded mutation, mirror the NON-PHI routing fields to
 *  disk so a restart-before-next-poll keeps the optimistic state. Title/body
 *  are never touched. Unknown ids are ignored (the next reconcile inserts). */
export function patchSkeleton(id: string, patch: Partial<SkeletonTask>): void {
  const d = open();
  const row = existingRow(d, id);
  if (!row) return;
  const merged = { ...rowToSkeleton(row), ...patch };
  d.prepare(
    `UPDATE task_skeleton SET
       status = @status,
       raw_status = @raw_status,
       claimed_by = @claimed_by,
       assigned_to = @assigned_to,
       attempts = @attempts,
       max_attempts = @max_attempts,
       priority = @priority,
       due_at = @due_at,
       defer_until = @defer_until,
       project_id = @project_id,
       parent_task_id = @parent_task_id,
       completed_at = @completed_at,
       updated_at = @updated_at
     WHERE id = @id`,
  ).run({
    id,
    status: merged.status ?? null,
    raw_status: merged.rawStatus ?? null,
    claimed_by: merged.claimedBy ?? null,
    assigned_to: merged.assignedTo ?? null,
    attempts: merged.attempts ?? null,
    max_attempts: merged.maxAttempts ?? null,
    priority: merged.priority ?? null,
    due_at: merged.due_at ?? null,
    defer_until: merged.deferUntil ?? null,
    project_id: merged.projectId ?? null,
    parent_task_id: merged.parentTaskId ?? null,
    completed_at: merged.completed_at ?? null,
    updated_at: Date.now(),
  });
}

// ─── Terminal counts (task-3abb663aba25) ────────────────────────────────────
// Per-project DONE/CANCELLED tallies computed from the NON-PHI skeleton so Home
// can show exact rolled-up counts WITHOUT the renderer materializing the whole
// done archive (it fetches only the live working set). Reads opaque routing
// columns only (project_id + status) — no title/body ever involved. Live rows
// only (tombstone = 0); rows with no project are omitted (they roll up to no
// project). Returns { [projectId]: { done, cancelled } }.
export function terminalCountsByProject(): Record<
  string,
  { done: number; cancelled: number }
> {
  const d = open();
  const rows = d
    .prepare(
      `SELECT project_id AS pid, status, COUNT(*) AS c
         FROM task_skeleton
        WHERE tombstone = 0
          AND status IN ('done', 'cancelled')
          AND project_id IS NOT NULL
        GROUP BY project_id, status`,
    )
    .all() as { pid: string; status: string; c: number }[];
  const out: Record<string, { done: number; cancelled: number }> = {};
  for (const r of rows) {
    const bucket = (out[r.pid] ??= { done: 0, cancelled: 0 });
    if (r.status === 'done') bucket.done += r.c;
    else if (r.status === 'cancelled') bucket.cancelled += r.c;
  }
  return out;
}

// ─── Projects skeleton ─────────────────────────────────────────────────────
// Projects are NON-PHI; we cache id + name + archived so cold start renders
// names instantly. The full detail (instructions) stays a per-call fetch.

export function loadProjects(): Array<Pick<Project, 'id' | 'name' | 'archived'>> {
  const d = open();
  const rows = d.prepare('SELECT id, name, archived FROM project_skeleton').all() as {
    id: string;
    name: string | null;
    archived: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? '',
    archived: r.archived === 1,
  }));
}

/** Replace the cached project skeleton with `fresh`. Rows absent from `fresh`
 *  are deleted (projects have no tombstone semantics — they're cheap to refetch
 *  and not part of the attention rollups). */
export function reconcileProjects(fresh: Project[]): void {
  const d = open();
  const now = Date.now();
  const upsert = d.prepare(`
    INSERT INTO project_skeleton (id, name, archived, seen_at)
    VALUES (@id, @name, @archived, @seen_at)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      archived = excluded.archived,
      seen_at = excluded.seen_at
  `);
  const ids = new Set(fresh.map((p) => p.id));
  const txn = d.transaction(() => {
    for (const p of fresh) {
      upsert.run({
        id: p.id,
        name: p.name ?? '',
        archived: p.archived ? 1 : 0,
        seen_at: now,
      });
    }
    const existing = (
      d.prepare('SELECT id FROM project_skeleton').all() as { id: string }[]
    ).map((r) => r.id);
    const del = d.prepare('DELETE FROM project_skeleton WHERE id = ?');
    for (const id of existing) if (!ids.has(id)) del.run(id);
  });
  txn();
}

/** Drop the whole skeleton (sign-out). Keeps the file but empties both tables
 *  so a different principal never sees the prior account's routing skeleton. */
export function clearSkeleton(): void {
  const d = open();
  // task-b1fe80e2669b (Phase 2) — also drop the sync cursor so the next sign-in
  // re-seeds with a FULL pull instead of replaying the prior account's
  // watermark (which would delta-miss every row that didn't change since).
  d.exec(
    'DELETE FROM task_skeleton; DELETE FROM project_skeleton; DELETE FROM sync_meta;',
  );
}

// For tests / explicit cleanup. Production never calls this.
export function _closeForTests(): void {
  if (db) {
    db.close();
    db = null;
  }
}
