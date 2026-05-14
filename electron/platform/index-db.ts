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

// Refresh the index incrementally. On a tree with no changes, this only
// lstat()s each known directory and writes nothing — the heavy walk only
// happens for directories whose mtime advanced since the last refresh.
//
// Why mtime: a directory's mtime changes when an entry is added, removed,
// or renamed inside it. For a name-only index, that's the only signal we
// need. File content changes don't affect parent mtime, but they also
// don't affect what we index. Idempotent; concurrent callers share one pass.
export function rebuild(): Promise<void> {
  if (walkInFlight) return walkInFlight;
  walkInFlight = doRefresh().finally(() => { walkInFlight = null; });
  return walkInFlight;
}

async function doRefresh(): Promise<void> {
  const d = open();
  const root = os.homedir();

  const upsert = d.prepare(`
    INSERT INTO entries(path, name, lname, parent, is_dir, mtime, indexed_at)
    VALUES (@path, @name, @lname, @parent, @is_dir, @mtime, @indexed_at)
    ON CONFLICT(path) DO UPDATE SET
      name=excluded.name, lname=excluded.lname, parent=excluded.parent,
      is_dir=excluded.is_dir, mtime=excluded.mtime, indexed_at=excluded.indexed_at
  `);
  const insertFts = d.prepare(
    'INSERT INTO entries_fts(rowid, lname, path) VALUES (?, ?, ?)'
  );
  const getRowid = d.prepare('SELECT rowid FROM entries WHERE path = ?');
  const getChildren = d.prepare(
    'SELECT path, name, is_dir, mtime FROM entries WHERE parent = ?'
  );
  const deleteEntry = d.prepare('DELETE FROM entries WHERE path = ?');
  const deleteFtsByRowid = d.prepare('DELETE FROM entries_fts WHERE rowid = ?');
  // For dir deletes, drop the whole subtree (path = X or starts with X/).
  const subtreeRowids = d.prepare(
    "SELECT rowid FROM entries WHERE path = ? OR path LIKE ?"
  );
  const deleteSubtree = d.prepare(
    "DELETE FROM entries WHERE path = ? OR path LIKE ?"
  );

  type StoredChild = { path: string; name: string; is_dir: number; mtime: number };
  type Frontier = { dir: string; depth: number; storedMtime: number | null };

  const rootMeta = d.prepare("SELECT value FROM meta WHERE key='root_mtime'").get() as
    | { value: string } | undefined;
  let frontier: Frontier[] = [
    { dir: root, depth: 0, storedMtime: rootMeta ? Number(rootMeta.value) : null },
  ];

  while (frontier.length > 0) {
    const nextFrontier: Frontier[] = [];

    // Per-dir results computed off the DB thread, then applied below.
    const results = await Promise.all(
      frontier.map(async (f) => {
        let st;
        try { st = await fs.lstat(f.dir); } catch { return null; }
        const liveMtime = Math.floor(st.mtimeMs);
        if (f.storedMtime !== null && liveMtime === f.storedMtime) {
          return { kind: 'unchanged' as const, dir: f.dir, depth: f.depth };
        }
        let ents;
        try { ents = await fs.readdir(f.dir, { withFileTypes: true }); }
        catch { return null; }
        // Stat subdirs so we can store their mtime for next-launch compare.
        // Non-dirs don't need lstat (we only index names).
        const childInfo = await Promise.all(ents.map(async (ent) => {
          if (SKIP_NAMES.has(ent.name)) return null;
          const isDir = ent.isDirectory();
          let mtime = 0;
          if (isDir) {
            try { mtime = Math.floor((await fs.lstat(path.join(f.dir, ent.name))).mtimeMs); }
            catch { return null; }
          }
          return { name: ent.name, isDir, mtime };
        }));
        return {
          kind: 'changed' as const,
          dir: f.dir,
          depth: f.depth,
          liveMtime,
          children: childInfo.filter((c): c is NonNullable<typeof c> => c !== null),
        };
      }),
    );

    d.transaction(() => {
      const now = Date.now();
      for (const r of results) {
        if (!r) continue;
        if (r.kind === 'unchanged') {
          // Skip readdir; just enqueue known subdirs to check deeper.
          const kids = getChildren.all(r.dir) as StoredChild[];
          for (const c of kids) {
            if (c.is_dir === 1 && r.depth + 1 < MAX_DEPTH && !c.name.startsWith('.')) {
              nextFrontier.push({ dir: c.path, depth: r.depth + 1, storedMtime: c.mtime });
            }
          }
          continue;
        }
        // Changed: diff against stored children.
        const stored = getChildren.all(r.dir) as StoredChild[];
        const storedByName = new Map<string, StoredChild>();
        for (const s of stored) storedByName.set(s.name, s);
        const liveNames = new Set<string>();
        for (const c of r.children) {
          liveNames.add(c.name);
          const full = path.join(r.dir, c.name);
          const before = getRowid.get(full) as { rowid: number } | undefined;
          upsert.run({
            path: full,
            name: c.name,
            lname: c.name.toLowerCase(),
            parent: r.dir,
            is_dir: c.isDir ? 1 : 0,
            mtime: c.mtime,
            indexed_at: now,
          });
          if (!before) {
            const after = getRowid.get(full) as { rowid: number };
            insertFts.run(after.rowid, c.name.toLowerCase(), full);
          }
          if (c.isDir && r.depth + 1 < MAX_DEPTH && !c.name.startsWith('.')) {
            nextFrontier.push({
              dir: full,
              depth: r.depth + 1,
              storedMtime: storedByName.get(c.name)?.mtime ?? null,
            });
          }
        }
        // Removals (and subtrees for removed dirs).
        for (const [name, s] of storedByName) {
          if (liveNames.has(name)) continue;
          if (s.is_dir === 1) {
            const like = s.path + '/%';
            const rows = subtreeRowids.all(s.path, like) as Array<{ rowid: number }>;
            for (const rr of rows) deleteFtsByRowid.run(rr.rowid);
            deleteSubtree.run(s.path, like);
          } else {
            const row = getRowid.get(s.path) as { rowid: number } | undefined;
            if (row) deleteFtsByRowid.run(row.rowid);
            deleteEntry.run(s.path);
          }
        }
        // Update this dir's own row mtime (skip root — it has no parent row).
        if (r.dir !== root) {
          d.prepare('UPDATE entries SET mtime = ?, indexed_at = ? WHERE path = ?')
            .run(r.liveMtime, now, r.dir);
        }
      }
    })();

    frontier = nextFrontier;
  }

  // Persist root mtime for next launch.
  try {
    const rst = await fs.lstat(root);
    d.prepare(
      "INSERT INTO meta(key,value) VALUES ('root_mtime', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(String(Math.floor(rst.mtimeMs)));
  } catch { /* ignore */ }

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
