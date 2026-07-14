// Auto-install / auto-update the TypeBuild `typebuild-work` plugin skill.
//
// The operator's startup prompt runs `/typebuild:typebuild-work` — a Claude Code
// PLUGIN skill that lives in the private `typebuild-plugin` repo, NOT in this
// client. If the plugin isn't installed in the USER-scope config the operator's
// `claude` subprocess reads (interactive.ts sets no CLAUDE_CONFIG_DIR, so that's
// the default ~/.claude), that command fails "Unknown skill".
//
// Rather than bundle the plugin in the client release (version-locked to the
// client) or clone a private GitHub repo on every machine, we FETCH it from the
// TypeBuild service (task_manager_api), mirroring how operator-instructions are
// server-hosted — so plugin updates ship server-side without a client release:
//   GET /chromeext/plugins/typebuild/manifest
//     -> { name, version, sha256?, size?, tarball_url }
//   GET <tarball_url>  -> application/gzip tar of the plugin dir
// The tar's ROOT contains `.claude-plugin/marketplace.json`, so a LOCAL-PATH
// `marketplace add` works. We cache the extracted plugin + its version under the
// profile state dir and re-sync only when the server version changes. Server
// contract: task-a65d87c82650 (task_manager_api).
//
// Registration uses the `claude` CLI at USER scope (the scope the operator
// reads). The sequence — verified 2026-07-14:
//   claude plugin marketplace add    <dir>            (idempotent: "already on disk")
//   claude plugin marketplace update typebuild-plugin (re-reads the local dir)
//   claude plugin install typebuild@typebuild-plugin --scope user  (no-op if present)
//   claude plugin update  typebuild@typebuild-plugin  (syncs installed -> cached ver)
// NOTE the update MUST use the fully-qualified `typebuild@typebuild-plugin` —
// bare `typebuild` errors "not found" and a plain re-install is a no-op, so
// neither upgrades a stale copy.
//
// Each operator is a fresh `claude` process spawned AFTER this runs, so an update
// takes effect on the next launch with no Electron restart.
//
// Best-effort + offline-tolerant: any failure degrades to whatever is already
// installed (or nothing) and the launch proceeds — the operator falls back to
// running the task without the packaged work-loop skill. NON-PHI throughout: the
// plugin is standing code/prompts, never a task value; nothing here is logged as
// PHI.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveClaudeBin } from '../agents/claude';
import { stateDir } from '../core/profile.mjs';
import { API_BASE, typebuildFetch } from './task-data';

const execFileP = promisify(execFile);

const MARKETPLACE_NAME = 'typebuild-plugin';
const PLUGIN_NAME = 'typebuild';
const PLUGIN_REF = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const MANIFEST_URL = `${API_BASE}/chromeext/plugins/typebuild/manifest`;

/** Per-command wall-clock cap. Marketplace add/update can clone/validate; the
 *  CLI itself already applies a 120s clone timeout, so match it. */
const CMD_TIMEOUT_MS = 130_000;
/** Whole-bootstrap cap so a hung leg can't wedge the launch wave indefinitely. */
const BOOTSTRAP_TIMEOUT_MS = 150_000;

export type PluginBootstrapStatus =
  | 'ready' // registered/updated to the server (or cached) version
  | 'offline' // could not reach the server; used the cached copy if present
  | 'unavailable' // no server copy AND nothing cached — nothing to register
  | 'error'; // an unexpected failure; launch proceeds regardless

export interface PluginBootstrapResult {
  status: PluginBootstrapStatus;
  version: string | null;
}

interface PluginManifest {
  name?: string;
  version?: string;
  sha256?: string;
  size?: number;
  tarball_url?: string;
}

/** Extracted plugin lives here; `<name>.version.json` records what we synced. */
function baseDir(): string {
  return path.join(stateDir(), 'plugins');
}
function pluginDir(): string {
  return path.join(baseDir(), MARKETPLACE_NAME);
}
function versionFile(): string {
  return path.join(baseDir(), `${MARKETPLACE_NAME}.version.json`);
}

async function readCachedVersion(): Promise<string | null> {
  try {
    const raw = await readFile(versionFile(), 'utf8');
    const v = (JSON.parse(raw) as { version?: string }).version;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/** The extracted dir is "present" only if it carries the marketplace manifest a
 *  local-path `marketplace add` needs — a half-written extract counts as absent. */
function pluginPresent(): boolean {
  return existsSync(path.join(pluginDir(), '.claude-plugin', 'marketplace.json'));
}

/** Fetch + verify + atomically swap in the plugin dir for `manifest.version`.
 *  Throws on any download/verify/extract failure so the caller can fall back to
 *  the cached copy. */
async function downloadAndExtract(manifest: PluginManifest): Promise<void> {
  const url = manifest.tarball_url
    ? manifest.tarball_url.startsWith('http')
      ? manifest.tarball_url
      : `${API_BASE}${manifest.tarball_url}`
    : `${API_BASE}/chromeext/plugins/typebuild/download`;

  const res = await typebuildFetch(url, { headers: { Accept: 'application/gzip' } });
  if (!res.ok) throw new Error(`plugin tarball fetch failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());

  if (manifest.sha256) {
    const got = createHash('sha256').update(buf).digest('hex');
    if (got.toLowerCase() !== manifest.sha256.toLowerCase()) {
      throw new Error('plugin tarball sha256 mismatch');
    }
  }

  await mkdir(baseDir(), { recursive: true });
  const tarPath = path.join(baseDir(), `${MARKETPLACE_NAME}.download.tgz`);
  const tmpDir = `${pluginDir()}.tmp`;
  await writeFile(tarPath, buf);
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  // `tar -xzf` is present on macOS + Linux (and Win10+ ships bsdtar as `tar`);
  // identical args on every OS, so no platform branch (cross-platform-strategy).
  await execFileP('tar', ['-xzf', tarPath, '-C', tmpDir], { timeout: CMD_TIMEOUT_MS });
  await rm(tarPath, { force: true });

  // Contract: the tar root IS the plugin dir (.claude-plugin at top). Defensively
  // also accept a single wrapping parent dir.
  const root = await resolveExtractedRoot(tmpDir);
  if (!root) throw new Error('extracted tarball has no .claude-plugin/marketplace.json');

  await rm(pluginDir(), { recursive: true, force: true });
  await rename(root, pluginDir());
  await rm(tmpDir, { recursive: true, force: true });
  await writeFile(
    versionFile(),
    JSON.stringify({ version: manifest.version ?? null, sha256: manifest.sha256 ?? null }),
  );
}

/** Find the dir holding `.claude-plugin/marketplace.json`: either `dir` itself
 *  or a single child dir (some tars wrap contents in a top-level folder). */
async function resolveExtractedRoot(dir: string): Promise<string | null> {
  if (existsSync(path.join(dir, '.claude-plugin', 'marketplace.json'))) return dir;
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    if (dirs.length === 1) {
      const child = path.join(dir, dirs[0].name);
      if (existsSync(path.join(child, '.claude-plugin', 'marketplace.json'))) return child;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Run one `claude plugin …` invocation. Never throws — returns ok=false with
 *  the combined output so the caller can log a one-line summary (NON-PHI). */
async function claudePlugin(bin: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await execFileP(bin, ['plugin', ...args], {
      timeout: CMD_TIMEOUT_MS,
      env: process.env,
    });
    return { ok: true, out: `${stdout ?? ''}${stderr ?? ''}`.trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`.trim(),
    };
  }
}

/** Register + sync the cached plugin dir into the user-scope config. Idempotent. */
async function registerFromCache(version: string | null): Promise<PluginBootstrapResult> {
  const bin = await resolveClaudeBin();
  const dir = pluginDir();
  // add (idempotent) -> update (re-read local files) -> install (no-op if present)
  // -> update (upgrade a stale installed copy to the cached version).
  await claudePlugin(bin, ['marketplace', 'add', dir]);
  await claudePlugin(bin, ['marketplace', 'update', MARKETPLACE_NAME]);
  const inst = await claudePlugin(bin, ['install', PLUGIN_REF, '--scope', 'user']);
  const upd = await claudePlugin(bin, ['update', PLUGIN_REF]);
  const ok = inst.ok || upd.ok;
  return { status: ok ? 'ready' : 'error', version };
}

async function run(): Promise<PluginBootstrapResult> {
  const cachedVersion = await readCachedVersion();

  // 1) Try the server. On any reachability failure, fall back to the cache.
  let manifest: PluginManifest | null = null;
  try {
    const res = await typebuildFetch(MANIFEST_URL);
    if (res.ok) manifest = (await res.json().catch(() => null)) as PluginManifest | null;
  } catch {
    manifest = null;
  }

  // 2) Re-download only when the server has a different version, or nothing is
  //    cached on disk yet. Otherwise reuse the cached extract.
  if (manifest?.version) {
    const needsSync = manifest.version !== cachedVersion || !pluginPresent();
    if (needsSync) {
      try {
        await downloadAndExtract(manifest);
      } catch {
        // Download/extract failed — keep whatever's cached (handled below).
      }
    }
  }

  // 3) Register whatever we have. No cached copy AND no fresh download => nothing
  //    to install; report so the caller can log (the launch still proceeds).
  if (!pluginPresent()) {
    return { status: manifest ? 'error' : 'unavailable', version: null };
  }
  const version = (await readCachedVersion()) ?? manifest?.version ?? null;
  const result = await registerFromCache(version);
  // Distinguish "used the server" from "server was down but cache saved us".
  if (!manifest && result.status === 'ready') return { ...result, status: 'offline' };
  return result;
}

let inflight: Promise<PluginBootstrapResult> | null = null;

/** Ensure the `typebuild-work` plugin is installed + current at user scope.
 *  Memoized for the app session: only the first caller does the work; every
 *  later launch awaits the same settled promise (instant). Bounded by
 *  BOOTSTRAP_TIMEOUT_MS so a hung network/CLI leg can't wedge the launch wave.
 *  Best-effort: the returned status is informational — callers do NOT gate the
 *  launch on it, they just await completion. */
export function ensureTypebuildPlugin(): Promise<PluginBootstrapResult> {
  if (!inflight) {
    inflight = Promise.race([
      run(),
      new Promise<PluginBootstrapResult>((resolve) =>
        setTimeout(() => resolve({ status: 'error', version: null }), BOOTSTRAP_TIMEOUT_MS),
      ),
    ]).catch((): PluginBootstrapResult => ({ status: 'error', version: null }));
  }
  return inflight;
}

/** Test/diagnostic hook — drop the memoized result so the next call re-runs. */
export function _resetPluginBootstrap(): void {
  inflight = null;
}
