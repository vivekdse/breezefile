// Linux file/folder name index, stored at ~/.breezefile/index.db.
//
// Why: macOS gets Spotlight for free; Linux has no comparable always-on name
// index. Rather than walk $HOME on every query, we maintain our own SQLite
// FTS5 table of (path, name) for every directory entry under $HOME. The walk
// runs once per launch in the background; queries are millisecond reads
// against the FTS index.
//
// Scope: names only — no content indexing. Skips the usual heavyweight dirs.
// Hidden dirs are skipped during recursion (the dir itself may still be
// indexed at its parent level), so .git, .cache, .venv etc. don't bloat the DB.

import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import { promises as fs, existsSync, mkdirSync } from 'node:fs';

const SKIP_NAMES = new Set([
  '.git', '.svn', '.hg', 'node_modules', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.venv', 'venv', '.cache', '.npm', '.yarn', '.pnpm-store',
  '.cargo', '.rustup', '.gradle', '.m2', '.nvm',
  'dist', 'build', 'target', '.next', '.nuxt', 'out',
  'snap',
]);

const MAX_DEPTH = 10;

let db: Database.Database | null = null;
let walkInFlight: Promise<void> | null = null;

function dbPath(): string {
  return path.join(os.homedir(), '.breezefile', 'index.db');
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
  migrate(db);
  return db;
}

function migrate(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
  `);
  const row = d.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined;
  const current = row?.version ?? 0;

  const migrations: Array<(db: Database.Database) => void> = [
    // v1 — entries + FTS5 mirror on lowercased name.
    (db) => {
      db.exec(`
        CREATE TABLE entries (
          path     TEXT PRIMARY KEY,
          name     TEXT NOT NULL,
          lname    TEXT NOT NULL,
          parent   TEXT NOT NULL,
          is_dir   INTEGER NOT NULL,
          mtime    INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL
        );
        CREATE INDEX idx_entries_parent ON entries(parent);
        CREATE INDEX idx_entries_lname  ON entries(lname);

        CREATE VIRTUAL TABLE entries_fts USING fts5(
          lname,
          path UNINDEXED,
          tokenize = 'unicode61 remove_diacritics 2'
        );

        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  ];

  d.transaction(() => {
    for (let i = current; i < migrations.length; i++) migrations[i](d);
    const next = migrations.length;
    if (next !== current) {
      d.prepare('DELETE FROM schema_version').run();
      d.prepare('INSERT INTO schema_version(version) VALUES (?)').run(next);
    }
  })();
}

function lastBuildMs(): number {
  const d = open();
  const row = d.prepare("SELECT value FROM meta WHERE key='last_build_ms'").get() as
    | { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

function setLastBuildMs(ms: number) {
  const d = open();
  d.prepare(
    "INSERT INTO meta(key,value) VALUES ('last_build_ms', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(String(ms));
}

export function isEmpty(): boolean {
  const d = open();
  const row = d.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number };
  return row.n === 0;
}

// Crawl $HOME and upsert entries. Idempotent. Safe to call repeatedly; we
// gate it with `walkInFlight` so concurrent searches share a single pass.
export function rebuild(): Promise<void> {
  if (walkInFlight) return walkInFlight;
  walkInFlight = doRebuild().finally(() => { walkInFlight = null; });
  return walkInFlight;
}

async function doRebuild(): Promise<void> {
  const d = open();
  const root = os.homedir();
  const now = Date.now();

  const upsert = d.prepare(`
    INSERT INTO entries(path, name, lname, parent, is_dir, mtime, indexed_at)
    VALUES (@path, @name, @lname, @parent, @is_dir, @mtime, @indexed_at)
    ON CONFLICT(path) DO UPDATE SET
      name=excluded.name, lname=excluded.lname, parent=excluded.parent,
      is_dir=excluded.is_dir, mtime=excluded.mtime, indexed_at=excluded.indexed_at
  `);
  const upsertFts = d.prepare(`
    INSERT INTO entries_fts(rowid, lname, path)
    VALUES ((SELECT rowid FROM entries WHERE path = @path), @lname, @path)
  `);

  // Reset FTS before rebuild — cheaper than diffing for first cut. The
  // primary `entries` table is upserted so partial walks leave a usable DB.
  d.exec('DELETE FROM entries_fts');

  type Frontier = { dir: string; depth: number };
  let frontier: Frontier[] = [{ dir: root, depth: 0 }];
  const BATCH = 500;
  let batch: Array<{
    path: string; name: string; lname: string; parent: string;
    is_dir: number; mtime: number; indexed_at: number;
  }> = [];

  const flush = () => {
    if (batch.length === 0) return;
    d.transaction((rows: typeof batch) => {
      for (const r of rows) {
        upsert.run(r);
        upsertFts.run({ path: r.path, lname: r.lname });
      }
    })(batch);
    batch = [];
  };

  while (frontier.length > 0) {
    const next: Frontier[] = [];
    await Promise.all(
      frontier.map(async ({ dir, depth }) => {
        let ents;
        try {
          ents = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of ents) {
          if (SKIP_NAMES.has(ent.name)) continue;
          const full = path.join(dir, ent.name);
          const isDir = ent.isDirectory();
          let mtime = 0;
          try {
            const st = await fs.lstat(full);
            mtime = Math.floor(st.mtimeMs);
          } catch {
            continue;
          }
          batch.push({
            path: full,
            name: ent.name,
            lname: ent.name.toLowerCase(),
            parent: dir,
            is_dir: isDir ? 1 : 0,
            mtime,
            indexed_at: now,
          });
          if (batch.length >= BATCH) flush();
          if (isDir && !ent.name.startsWith('.') && depth + 1 < MAX_DEPTH) {
            next.push({ dir: full, depth: depth + 1 });
          }
        }
      }),
    );
    frontier = next;
  }
  flush();
  setLastBuildMs(Date.now());
}

// Query helpers. Tokens are AND-ed; each becomes an FTS5 prefix term against
// the lowercased name. Short tokens (≤3 chars) are not prefixed — too much
// noise — they must appear as a discrete FTS token (word boundary).
function ftsQuery(tokens: string[]): string {
  return tokens
    .map((t) => {
      const safe = t.replace(/["\\]/g, '');
      if (safe.length <= 3) return `"${safe}"`;
      return `"${safe}"*`;
    })
    .join(' AND ');
}

export function search(tokens: string[], limit: number, dirsOnly: boolean): string[] {
  if (tokens.length === 0) return [];
  const d = open();
  const q = ftsQuery(tokens);
  const sql = dirsOnly
    ? `SELECT e.path FROM entries_fts f
         JOIN entries e ON e.rowid = f.rowid
         WHERE entries_fts MATCH ? AND e.is_dir = 1
         LIMIT ?`
    : `SELECT e.path FROM entries_fts f
         JOIN entries e ON e.rowid = f.rowid
         WHERE entries_fts MATCH ?
         LIMIT ?`;
  try {
    const rows = d.prepare(sql).all(q, limit) as Array<{ path: string }>;
    return rows.map((r) => r.path);
  } catch {
    // Malformed query (e.g. only punctuation) — return empty rather than throw.
    return [];
  }
}

export function getLastBuildMs(): number {
  return lastBuildMs();
}
