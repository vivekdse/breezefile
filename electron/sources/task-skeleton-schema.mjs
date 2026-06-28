// task-b3fb2928bb3c (Phase 1) — PHI-FREE persistent skeleton schema + pure
// reconcile/diff helpers for the TypeBuild task cache.
//
// WHY A PLAIN .mjs: the better-sqlite3 store that uses this is TypeScript
// (electron/sources/task-skeleton-store.ts), but the project's test runner is
// `node --test tests/*.test.mjs` with NO TS transpile step. Keeping the schema
// DDL, the EXPLICIT non-PHI column allow-list, and the pure diff/reconcile
// functions in a plain ESM module lets the tests import them directly — and,
// crucially, lets the no-PHI-columns test assert against the SAME source of
// truth the store actually creates its table from.
//
// PHI INVARIANT (non-negotiable — see typebuild.ts header + task-source.ts
// phiSensitive): decrypted task TITLES and BODIES are PHI and live in
// MEMORY ONLY. This persistent store holds ONLY the NON-PHI routing skeleton.
// The schema below has NO title/body/notes/task column, BY CONSTRUCTION, so
// PHI literally cannot be written here even by a buggy caller. The
// SKELETON_COLUMNS allow-list and PHI_FORBIDDEN_SUBSTRINGS guard assert that.

// The exact, ordered set of columns the skeleton table carries. Every one is
// NON-PHI: opaque ids, the routing status pair, email principals (claimed_by/
// assigned_to), counters, flags (a small enum vocabulary), ISO/epoch
// timestamps, and routing flags. NOTHING here is patient text.
export const SKELETON_COLUMNS = [
  'id', // opaque task id (PK)
  'status', // mapped local status (pending|in_progress|done|cancelled)
  'raw_status', // server raw status (open|failed|blocked|partial|...)
  'claimed_by', // email principal holding the claim, or NULL
  'assigned_to', // email principal assigned, or NULL
  'attempts', // run attempt counter
  'max_attempts', // run attempt cap
  'flags', // JSON array of agent flags (chrome/auto/resume/...)
  'priority', // numeric priority
  'due_at', // day-only 'YYYY-MM-DD' (mapped) or NULL
  'defer_until', // full ISO snooze timestamp or NULL
  'project_id', // opaque owning-project id or NULL
  'parent_task_id', // opaque container id or NULL
  // Numeric epoch sort keys. These mirror the in-memory Task.created_at/
  // updated_at. They DEFAULT to the server's real timestamps when present and
  // fall back to the mapListRow Date.now() floor otherwise (see the store's
  // upsert + the attention-floor note in typebuild.ts:340).
  'created_at',
  'updated_at',
  'completed_at',
  // RAW server ISO timestamps (non-PHI) for the timeline UI. Persisted so a
  // cold start can render the timeline without a detail round-trip.
  'created_at_iso',
  'updated_at_iso',
  'claimed_at',
  // Tombstone bookkeeping. tombstone=1 marks an id the server no longer
  // returns (removed/no-longer-visible) so it stops counting as live but we
  // remember we saw it. seen_at is the last reconcile epoch that touched it.
  'tombstone',
  'seen_at',
];

// Substrings a column name must NOT contain — a structural tripwire so a
// future migration that tries to add a PHI-bearing column fails the test.
// `title`/`body`/`notes` are always-PHI. `task` is the server's BODY field
// name (mapped to `notes` in memory), so a column literally named `task` (or
// `*_task` / `task_*`) is forbidden — BUT an opaque routing id like
// `parent_task_id` is NON-PHI and allowed (it ends in `_id`); isPhiColumn
// encodes that nuance.
export const PHI_FORBIDDEN_SUBSTRINGS = ['title', 'body', 'notes', 'task'];

// The CREATE TABLE DDL. Kept in lockstep with SKELETON_COLUMNS (the test
// asserts the parsed column set equals SKELETON_COLUMNS, so drift is caught).
export const SKELETON_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS task_skeleton (
    id             TEXT PRIMARY KEY,
    status         TEXT,
    raw_status     TEXT,
    claimed_by     TEXT,
    assigned_to    TEXT,
    attempts       INTEGER,
    max_attempts   INTEGER,
    flags          TEXT NOT NULL DEFAULT '[]',
    priority       INTEGER,
    due_at         TEXT,
    defer_until    TEXT,
    project_id     TEXT,
    parent_task_id TEXT,
    created_at     INTEGER,
    updated_at     INTEGER,
    completed_at   INTEGER,
    created_at_iso TEXT,
    updated_at_iso TEXT,
    claimed_at     TEXT,
    tombstone      INTEGER NOT NULL DEFAULT 0,
    seen_at        INTEGER NOT NULL DEFAULT 0
  );
`;

export const SKELETON_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_skeleton_live
    ON task_skeleton(status) WHERE tombstone = 0;
  CREATE INDEX IF NOT EXISTS idx_skeleton_project
    ON task_skeleton(project_id) WHERE tombstone = 0;
`;

// Projects are NON-PHI too (name/description/instructions/folders are not
// patient data) and have no cache today (listProjects fetches per-call). We
// persist a light projects skeleton so cold start can render project names
// instantly. To keep this store PHI-impossible BY CONSTRUCTION we store only
// id + name + a routing flag; the full project detail (instructions) stays a
// per-call fetch.
export const PROJECT_COLUMNS = ['id', 'name', 'archived', 'seen_at'];

export const PROJECT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS project_skeleton (
    id       TEXT PRIMARY KEY,
    name     TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    seen_at  INTEGER NOT NULL DEFAULT 0
  );
`;

// Parse the column names out of a CREATE TABLE statement. Deliberately simple
// (the DDL above is hand-controlled): take the parenthesized body, split on
// top-level commas, and read the first token of each definition line, skipping
// table-level constraints. Used by the test to verify NO PHI column exists.
export function parseColumnNames(createTableSql) {
  const open = createTableSql.indexOf('(');
  const close = createTableSql.lastIndexOf(')');
  if (open < 0 || close < 0) return [];
  const body = createTableSql.slice(open + 1, close);
  let depth = 0;
  let cur = '';
  const parts = [];
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  const TABLE_CONSTRAINTS = new Set([
    'PRIMARY',
    'UNIQUE',
    'CHECK',
    'FOREIGN',
    'CONSTRAINT',
  ]);
  const cols = [];
  for (const part of parts) {
    const tok = part.trim().split(/\s+/)[0];
    if (!tok) continue;
    if (TABLE_CONSTRAINTS.has(tok.toUpperCase())) continue;
    cols.push(tok);
  }
  return cols;
}

// True when a column name would carry PHI (matches a forbidden substring,
// case-insensitive). The store's upsert NEVER passes title/body fields, and
// this guard makes a regression a test failure rather than a silent leak.
export function isPhiColumn(name) {
  const n = String(name).toLowerCase();
  // Opaque routing identifiers (ending in `_id`) are NON-PHI even when the
  // word "task" appears (e.g. parent_task_id) — they carry an id, not text.
  const isOpaqueId = n.endsWith('_id') || n === 'id';
  for (const bad of PHI_FORBIDDEN_SUBSTRINGS) {
    if (!n.includes(bad)) continue;
    // `task` inside an opaque id column is allowed; every other forbidden
    // substring (title/body/notes) is PHI wherever it appears.
    if (bad === 'task' && isOpaqueId) continue;
    return true;
  }
  return false;
}

// ─── Pure reconcile / diff ────────────────────────────────────────────────
// Given the PREVIOUS live skeleton rows and the FRESH server list rows,
// compute what changed. Pure (no I/O) so it's unit-testable and the store +
// the broadcast both derive from ONE definition of "diff".

const ROUTING_FIELDS = [
  'status',
  'raw_status',
  'claimed_by',
  'assigned_to',
  'attempts',
  'max_attempts',
  'priority',
  'due_at',
  'defer_until',
  'project_id',
  'parent_task_id',
];

export function routingSignature(row) {
  return ROUTING_FIELDS.map((f) => `${row[f] ?? ''}`).join('');
}

// Compute added / changed / removed id sets between the previous LIVE set and
// the fresh server set. `prev` and `fresh` are arrays of skeleton-shaped rows
// (must carry `id` + the ROUTING_FIELDS). Removed = was live, now absent.
export function diffSkeleton(prev, fresh) {
  const prevById = new Map();
  for (const r of prev) prevById.set(r.id, r);
  const freshById = new Map();
  for (const r of fresh) freshById.set(r.id, r);

  const added = [];
  const changed = [];
  const removed = [];

  for (const [id, fr] of freshById) {
    const pr = prevById.get(id);
    if (!pr) {
      added.push(id);
    } else if (routingSignature(pr) !== routingSignature(fr)) {
      changed.push(id);
    }
  }
  for (const id of prevById.keys()) {
    if (!freshById.has(id)) removed.push(id);
  }
  return { added, changed, removed };
}

// True when a diff carries no change at all (lets the poll skip the broadcast).
export function diffIsEmpty(diff) {
  return (
    diff.added.length === 0 &&
    diff.changed.length === 0 &&
    diff.removed.length === 0
  );
}
