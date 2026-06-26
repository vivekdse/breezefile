// fm-a2k — Tag store: a PURE persistence layer for user-defined tag rules.
//
// One JSON file (human-readable / hand-editable / diffable — JSON is deliberate;
// migrate to SQLite only if frozen snapshots get huge). v1 needs no migrations.
//
// Authored as plain ESM (with a co-located tagStore.d.mts for the TS app) so
// `node --test tests/` can import it directly on Node without a transpile step,
// mirroring src/tagDsl.mjs. The ONLY runtime deps are node:fs/node:path/node:os
// + node:crypto — NO Electron, NO React, NO `process.platform` (per CLAUDE.md
// the OS-coupled config-dir choice lives behind an injectable resolver, and the
// Electron host passes its own dir — `app.getPath('userData')` — in).
//
// ── How this ties to the DSL engine (src/tagDsl.mjs) ───────────────────────
// A Tag's `selector` is a DSL STRING in the exact format `parse()` consumes
// (see src/tagDsl.mjs grammar). This store stays a PURE persistence layer — it
// does NOT parse or evaluate selectors. It only guarantees the string round-
// trips intact so a later 'tag-algebra selection' task can do:
//     evaluate(parse(tag.selector), fileRow, { resolveTag })
// NOTE: a selector may contain `tag:name` self-references to OTHER tags; those
// resolve at evaluate time via the engine's injectable `opts.resolveTag`
// (wiring that resolver against this store is a FOLLOW-UP task, not this one).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// ── Cross-platform config dir ──────────────────────────────────────────────
// No `process.platform` branching (CLAUDE.md). We resolve a per-user config
// directory from environment conventions that are honored across OSes:
//   - $XDG_CONFIG_HOME (Linux / freedesktop; also commonly set by users)
//   - $APPDATA          (Windows roaming app data)
//   - else ~/.config    (POSIX fallback; macOS too — fine for a hand-editable
//                        JSON; the Electron host overrides this anyway)
// The Electron main process should pass its own dir (app.getPath('userData'))
// via `dir`/`file` so the store sits next to openwith.json/terminal.json/etc.
const APP_DIR = 'file_manager';
const FILE_NAME = 'tags.json';

function defaultConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) return path.join(xdg, APP_DIR);
  const appdata = process.env.APPDATA;
  if (appdata && appdata.trim()) return path.join(appdata, APP_DIR);
  return path.join(os.homedir(), '.config', APP_DIR);
}

/** Resolve the JSON file path from store options. `file` wins; else `dir`
 *  joined with the canonical file name; else the cross-platform default. */
export function resolveTagsFile(opts = {}) {
  if (opts.file) return opts.file;
  if (opts.dir) return path.join(opts.dir, FILE_NAME);
  return path.join(defaultConfigDir(), FILE_NAME);
}

// ── Schema helpers ──────────────────────────────────────────────────────────
const VALID_MODES = new Set(['live', 'frozen']);

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `tag-${crypto.randomUUID()}`;
}

/** Normalize/validate an in-memory Tag record (throws on invalid shape). */
function normalizeTag(t) {
  if (!t || typeof t !== 'object') throw new TypeError('tag must be an object');
  if (typeof t.name !== 'string' || t.name.trim() === '')
    throw new TypeError('tag.name is required (non-empty string)');
  if (typeof t.selector !== 'string')
    throw new TypeError('tag.selector is required (a tagDsl query string)');
  const mode = t.mode ?? 'live';
  if (!VALID_MODES.has(mode))
    throw new TypeError(`tag.mode must be 'live' or 'frozen' (got ${JSON.stringify(t.mode)})`);
  if (t.snapshot != null) {
    if (!Array.isArray(t.snapshot) || t.snapshot.some((p) => typeof p !== 'string'))
      throw new TypeError('tag.snapshot must be an array of path strings');
  }
  const out = {
    id: t.id,
    name: t.name,
    color: typeof t.color === 'string' ? t.color : '',
    selector: t.selector,
    mode,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
  if (t.snapshot != null) out.snapshot = t.snapshot.slice();
  return out;
}

// ── File IO (atomic) ─────────────────────────────────────────────────────────
async function readAll(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed; // tolerate a bare array
    if (parsed && Array.isArray(parsed.tags)) return parsed.tags;
    return [];
  } catch (err) {
    if (err && err.code === 'ENOENT') return []; // first run: empty store
    throw err;
  }
}

// Atomic write: serialize, write to a unique temp file in the SAME directory,
// fsync it, then rename over the real file. rename(2) is atomic on POSIX and
// ReplaceFile-backed on Windows, so the real file is never observed partial:
// a crash mid-write leaves the OLD file intact (the temp is orphaned, not the
// target). On any failure we best-effort unlink the temp so we don't litter.
async function writeAll(file, tags) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const body = JSON.stringify({ version: 1, tags }, null, 2) + '\n';
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(tmp, 'w');
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmp, file);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

// ── Store ─────────────────────────────────────────────────────────────────
// A thin handle bound to one JSON file. Every op reads-then-writes the whole
// file (the tag set is tiny); atomicity is per-write via writeAll above.
export class TagStore {
  /** @param {{ file?: string, dir?: string }} [opts] */
  constructor(opts = {}) {
    this.file = resolveTagsFile(opts);
  }

  /** All tags, in stored order. */
  async list() {
    const tags = await readAll(this.file);
    return tags.map(normalizeTag);
  }

  /** One tag by id, or null. */
  async getById(id) {
    const tags = await this.list();
    return tags.find((t) => t.id === id) ?? null;
  }

  /** First tag with this name (case-sensitive), or null. */
  async getByName(name) {
    const tags = await this.list();
    return tags.find((t) => t.name === name) ?? null;
  }

  /** Create a tag. Generates id + timestamps; returns the stored record.
   *  `input`: { name, selector, color?, mode?, snapshot? }. */
  async create(input) {
    const tags = await this.list();
    const ts = nowIso();
    const rec = normalizeTag({
      ...input,
      id: newId(),
      created_at: ts,
      updated_at: ts,
    });
    tags.push(rec);
    await writeAll(this.file, tags);
    return rec;
  }

  /** Patch an existing tag by id. Bumps updated_at; preserves id/created_at.
   *  Returns the updated record, or null if no tag has that id. Pass
   *  `snapshot: null` to clear a snapshot. */
  async update(id, patch) {
    const tags = await this.list();
    const i = tags.findIndex((t) => t.id === id);
    if (i === -1) return null;
    const prev = tags[i];
    const merged = { ...prev, ...patch, id: prev.id, created_at: prev.created_at };
    if (patch && patch.snapshot === null) delete merged.snapshot;
    const rec = normalizeTag(merged);
    rec.updated_at = nowIso();
    tags[i] = rec;
    await writeAll(this.file, tags);
    return rec;
  }

  /** Delete a tag by id. Returns true if one was removed. */
  async delete(id) {
    const tags = await this.list();
    const next = tags.filter((t) => t.id !== id);
    if (next.length === tags.length) return false;
    await writeAll(this.file, next.map(normalizeTag));
    return true;
  }
}

/** Convenience: a store bound to the default (or provided) location. */
export function openTagStore(opts = {}) {
  return new TagStore(opts);
}

// Internals exposed for focused unit testing.
export const _internal = {
  defaultConfigDir,
  resolveTagsFile,
  normalizeTag,
  readAll,
  writeAll,
  APP_DIR,
  FILE_NAME,
};
