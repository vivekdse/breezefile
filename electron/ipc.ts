import { ipcMain, shell, app, BrowserWindow, webContents, clipboard, nativeImage, dialog } from 'electron';
import { promises as fs, constants as fsc } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// Teach-by-recording (task-01facbf6b0bc): capture human browser actions +
// selector candidates over the embedded view. Stateful main wrapper — import
// the .ts explicitly so Rollup picks the wrapper, not the sibling .mjs core.
import {
  startRecording as startBrowserRecording,
  stopRecording as stopBrowserRecording,
  currentRecording as currentBrowserRecording,
} from './browser/record.ts';
// Full-page screenshot → PDF (task: PDF button next to Record).
import { capturePagePdf } from './browser/screenshot-pdf.ts';

import { spawn, execFile } from 'node:child_process';
import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import crypto from 'node:crypto';
import * as nodePty from '@homebridge/node-pty-prebuilt-multiarch';
import * as tasks from './tasks';
import type { TaskCreate, TaskFilter, TaskUpdate } from './tasks';
import * as overlaySchedule from './schedule-overlay';
import { platform } from './platform';
import {
  enterSideBySide,
  exitSideBySide,
  toggleSideBySide,
  isSideBySide,
  probeWindowArrange,
} from './window-arrange';
import { resolveRemote, shQuote, listRemoteTargets } from './remoteRoute';
import { ensureRemoteHooks, readLocalApi, pickRemotePort } from './remoteHooks';
import { mintSessionToken, revokeSessionToken } from './session-tokens';
import {
  listSources,
  connectSource,
  disconnectSource,
  connectedHosts,
  remoteRequest,
  autoAttachForPath,
} from './sources';
import {
  getTaskSource,
  listTaskSourceInfos,
} from './sources/registry';
import { unsupported } from './core/task-source';
import type { TypeBuildTaskSource } from './sources/typebuild';
// task-3abb663aba25 — DB-skeleton terminal (done/cancelled) counts so Home rolls
// up exact numbers without materializing the done archive in the renderer.
import { terminalCountsByProject } from './sources/task-skeleton-store';
import { registerTagStoreIpc } from './tag-store';
import { registerLlmIpc } from './llm';
import {
  createBrowserView,
  setBrowserViewBounds,
  getBrowserView,
  hideBrowserView,
  destroyBrowserView,
  reBroadcastState,
} from './browser/views';
import { suggest as suggestUrls, type Suggestion } from './browser/history-store';

// ─── Per-extension "Open With" bindings ─────────────────────────────
// Persisted as JSON at userData/openwith.json; loaded on startup and
// kept in-memory for fast dispatch from `app:open`.
type OpenWithBindings = Record<string, string>;
let bindings: OpenWithBindings = {};
let bindingsLoaded = false;

function bindingsPath(): string {
  return path.join(app.getPath('userData'), 'openwith.json');
}
async function loadBindings(): Promise<void> {
  if (bindingsLoaded) return;
  try {
    const raw = await fs.readFile(bindingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') bindings = parsed as OpenWithBindings;
  } catch {
    bindings = {};
  }
  bindingsLoaded = true;
}
async function saveBindings(): Promise<void> {
  const p = bindingsPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(bindings, null, 2), 'utf8');
}
function normExt(ext: string): string {
  return ext.replace(/^\./, '').toLowerCase();
}
function extOf(p: string): string | undefined {
  const base = path.basename(p);
  if (!base.includes('.') || base.startsWith('.')) return undefined;
  return base.split('.').pop()!.toLowerCase();
}

export type Entry = {
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'link' | 'exec';
  ext?: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  isHidden: boolean;
};

const WIN_EXEC_EXTS = new Set(['.exe', '.bat', '.cmd', '.com', '.ps1', '.msi']);

function classify(name: string, stat: import('node:fs').Stats, mode: number): Entry['kind'] {
  if (stat.isSymbolicLink()) return 'link';
  if (stat.isDirectory()) return 'dir';
  // NTFS has no POSIX execute bit; "executable" is determined by extension.
  if (process.platform === 'win32') {
    return WIN_EXEC_EXTS.has(path.extname(name).toLowerCase()) ? 'exec' : 'file';
  }
  const execBit = mode & 0o111;
  if (execBit && !stat.isDirectory()) return 'exec';
  return 'file';
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Route a file to a specific application. The `app` argument is whatever
// `app:pickApplication` returned for the platform:
//   - macOS: a `.app` bundle path → `open -a <bundle> <file>`.
//   - Windows / Linux: an absolute executable path → spawn it with the file
//     as its first argument. (`open` does not exist off macOS.)
function openWithApp(app: string, abs: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (process.platform === 'darwin') {
      spawn('open', ['-a', app, abs], { stdio: 'ignore', detached: true })
        .on('error', reject)
        .on('spawn', () => resolve());
      return;
    }
    spawn(app, [abs], { stdio: 'ignore', detached: true, windowsHide: false })
      .on('error', reject)
      .on('spawn', () => resolve());
  });
}

// Translate raw Node.js fs errors into sentences the UI can surface verbatim.
// Node messages like "EEXIST: file already exists, mkdir '/…/foo'" leak the
// syscall + absolute path and don't explain what the user should do. The
// wrapper keeps the original error as `.cause` for debugging but rethrows
// something the status bar can show without apology.
function friendlyFsError(err: unknown, ctx: { op: 'mkdir' | 'rename' | 'touch'; name?: string; target?: string }): Error {
  const e = err as NodeJS.ErrnoException;
  const name = ctx.name ?? (ctx.target ? path.basename(ctx.target) : 'item');
  let msg: string;
  switch (e.code) {
    case 'EEXIST':
      msg = ctx.op === 'mkdir'
        ? `a folder or file named "${name}" already exists here`
        : ctx.op === 'touch'
          ? `a file named "${name}" already exists here`
          : `"${name}" already exists at the destination`;
      break;
    case 'ENOENT':
      msg = `parent folder doesn't exist`;
      break;
    case 'EACCES':
    case 'EPERM':
      msg = `permission denied — ${ctx.op === 'mkdir' ? 'this folder is read-only' : 'not allowed to modify this item'}`;
      break;
    case 'ENOTEMPTY':
      msg = `"${name}" is a non-empty folder`;
      break;
    case 'EINVAL':
      msg = `"${name}" contains characters that aren't allowed in a filename`;
      break;
    case 'ENAMETOOLONG':
      msg = `name is too long`;
      break;
    case 'ENOSPC':
      msg = `out of disk space`;
      break;
    case 'EROFS':
      msg = `this location is read-only`;
      break;
    default:
      msg = e.message || String(err);
  }
  const out = new Error(msg);
  (out as Error & { cause?: unknown }).cause = err;
  return out;
}

async function readdirEntries(dirpath: string): Promise<Entry[]> {
  const abs = expandHome(dirpath);
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const results = await Promise.all(
    dirents.map(async (d): Promise<Entry | null> => {
      const name = d.name;
      const full = path.join(abs, name);
      try {
        const lst = await fs.lstat(full);
        const ext = name.includes('.') && !name.startsWith('.')
          ? name.split('.').pop()!.toLowerCase()
          : undefined;
        return {
          name,
          path: full,
          kind: classify(name, lst, lst.mode),
          ext,
          size: lst.size,
          mtimeMs: lst.mtimeMs,
          ctimeMs: lst.ctimeMs,
          isHidden: name.startsWith('.'),
        };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((e): e is Entry => e !== null);
}

// fm-mp1 / fm-xr0 — recursive scope walker shared by filter-tabs and frozen
// tags. Unlike readdirEntries (one directory, no recursion) this BFS-walks a
// scope and returns full-metadata Entry rows for EVERY descendant, so the
// renderer's pure selector evaluator (src/filterEntries.mjs) can match across a
// whole subtree. There is no full-metadata recursive lister elsewhere — the
// platform BFS (electron/platform/bfs.ts) returns name-matched PATHS only, with
// no size/mtime/kind — so this is net-new.
//
// CAPS (performance + safety): default depth ≤ 8 levels below the scope root
// and ≤ 5000 entries returned; both overridable by the caller but clamped to
// hard ceilings (depth ≤ 16, count ≤ 20000) so a runaway selector can't walk an
// unbounded tree. Heavy/uninteresting dirs (.git, node_modules, caches, build
// output) are skipped, matching the platform BFS skip set. Symlinked dirs are
// NOT descended into (lstat, never follow) so cycles can't blow the walk up.
const WALK_SKIP = new Set([
  '.git', 'node_modules', '__pycache__', '.cache', '.venv', 'venv',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.svn', '.hg',
  '.npm', '.yarn', '.pnpm-store', '.cargo', '.rustup',
  'dist', 'build', 'target', '.next', '.nuxt', 'out', 'snap',
]);
const WALK_MAX_DEPTH = 8;
const WALK_MAX_COUNT = 5000;
const WALK_DEPTH_CEILING = 16;
const WALK_COUNT_CEILING = 20000;

async function walkScope(
  scope: string,
  opts?: { maxDepth?: number; maxCount?: number; includeHidden?: boolean },
): Promise<Entry[]> {
  const root = expandHome(scope);
  const maxDepth = Math.min(opts?.maxDepth ?? WALK_MAX_DEPTH, WALK_DEPTH_CEILING);
  const maxCount = Math.min(opts?.maxCount ?? WALK_MAX_COUNT, WALK_COUNT_CEILING);
  const includeHidden = opts?.includeHidden ?? false;
  const out: Entry[] = [];

  // BFS by level so the cap bites breadth-first (nearer entries win when capped)
  // and a single very deep branch can't starve siblings.
  let frontier: string[] = [root];
  for (let level = 0; level <= maxDepth && frontier.length > 0 && out.length < maxCount; level++) {
    const next: string[] = [];
    const batches = await Promise.all(
      frontier.map(async (dir) => {
        let dirents;
        try {
          dirents = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return [] as { entry: Entry; descend: string | null }[];
        }
        return Promise.all(
          dirents.map(async (d): Promise<{ entry: Entry; descend: string | null } | null> => {
            const name = d.name;
            if (WALK_SKIP.has(name)) return null;
            const isHidden = name.startsWith('.');
            if (isHidden && !includeHidden) {
              // Hidden file → omit; hidden dir → omit AND don't descend.
              return null;
            }
            const full = path.join(dir, name);
            let lst;
            try {
              lst = await fs.lstat(full);
            } catch {
              return null;
            }
            const ext =
              name.includes('.') && !name.startsWith('.')
                ? name.split('.').pop()!.toLowerCase()
                : undefined;
            const kind = classify(name, lst, lst.mode);
            const entry: Entry = {
              name,
              path: full,
              kind,
              ext,
              size: lst.size,
              mtimeMs: lst.mtimeMs,
              ctimeMs: lst.ctimeMs,
              isHidden,
            };
            // Descend only into REAL directories (kind 'dir' excludes symlinks,
            // which classify reports as 'link') so symlink loops can't recurse.
            return { entry, descend: kind === 'dir' ? full : null };
          }),
        );
      }),
    );
    for (const batch of batches) {
      for (const item of batch) {
        if (!item) continue;
        if (out.length < maxCount) out.push(item.entry);
        if (item.descend) next.push(item.descend);
      }
      if (out.length >= maxCount) break;
    }
    frontier = next;
  }
  return out;
}

async function copyRecursive(src: string, dst: string) {
  const st = await fs.lstat(src);
  if (st.isDirectory()) {
    await fs.mkdir(dst, { recursive: true });
    const names = await fs.readdir(src);
    for (const n of names) await copyRecursive(path.join(src, n), path.join(dst, n));
  } else if (st.isSymbolicLink()) {
    const target = await fs.readlink(src);
    await fs.symlink(target, dst);
  } else {
    await fs.copyFile(src, dst, fsc.COPYFILE_EXCL);
  }
}

async function uniquePaste(dstDir: string, srcName: string): Promise<string> {
  let candidate = path.join(dstDir, srcName);
  let i = 1;
  const parsed = path.parse(srcName);
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(dstDir, `${parsed.name} (${i})${parsed.ext}`);
      i++;
    } catch {
      return candidate;
    }
  }
}

// Cache thumbnails in user cache dir
const thumbCache = path.join(app.getPath('userData'), 'thumbs');
async function ensureThumbDir() {
  await fs.mkdir(thumbCache, { recursive: true });
}

async function thumbnailFor(p: string, size = 128): Promise<string | null> {
  try {
    const st = await fs.stat(p);
    const key = crypto
      .createHash('sha1')
      .update(`${p}|${st.mtimeMs}|${size}`)
      .digest('hex');
    await ensureThumbDir();
    const out = path.join(thumbCache, `${key}.png`);
    try {
      await fs.access(out);
      return out;
    } catch {
      // create
    }
    const ext = path.extname(p).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
      const buf = await fs.readFile(p);
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return null;
      const resized = img.resize({ width: size, quality: 'good' });
      await fs.writeFile(out, resized.toPNG());
      return out;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Location helpers (sidebar's "Locations" section) ────────────────
export type Location = {
  id: string;
  label: string;
  path: string;
  icon: 'drive' | 'usb' | 'folder';
  kind: 'boot' | 'external' | 'cloud' | 'icloud';
  /** 0–100; omitted for cloud providers (no local quota). */
  usedPct?: number;
  caption: string;
};

function fmtBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

async function diskStats(p: string): Promise<{ used: number; total: number } | null> {
  try {
    // fs.statfs is available in Node 18.15+ / Electron's bundled Node.
    const s = await (fs as typeof fs & {
      statfs: (p: string) => Promise<{ bsize: number; blocks: bigint | number; bavail: bigint | number }>;
    }).statfs(p);
    const bsize = s.bsize;
    const blocks = typeof s.blocks === 'bigint' ? Number(s.blocks) : s.blocks;
    const bavail = typeof s.bavail === 'bigint' ? Number(s.bavail) : s.bavail;
    const total = blocks * bsize;
    const free = bavail * bsize;
    if (!Number.isFinite(total) || total <= 0) return null;
    return { used: Math.max(0, total - free), total };
  } catch {
    return null;
  }
}

async function bootLocation(): Promise<Location> {
  // Boot/system volume. On Windows the root is the system drive (the parent
  // of the user's home, normally C:\); POSIX uses `/`.
  const isWin = process.platform === 'win32';
  const rootPath = isWin ? path.parse(os.homedir()).root : '/';
  const stats = await diskStats(rootPath);
  const loc: Location = {
    id: 'boot',
    label: isWin
      ? `Local Disk (${rootPath.replace(/\\$/, '')})`
      : process.platform === 'darwin'
        ? 'Macintosh HD'
        : 'System',
    path: rootPath,
    icon: 'drive',
    kind: 'boot',
    caption: 'Startup disk',
  };
  if (stats) {
    loc.usedPct = Math.round((stats.used / stats.total) * 100);
    loc.caption = `${fmtBytes(stats.used)} of ${fmtBytes(stats.total)} used`;
  }
  return loc;
}

async function externalLocations(): Promise<Location[]> {
  if (process.platform === 'win32') return windowsDriveLocations();
  if (process.platform !== 'darwin') return [];
  const out: Location[] = [];
  let names: string[] = [];
  try {
    names = await fs.readdir('/Volumes');
  } catch {
    return out;
  }
  for (const name of names) {
    const full = path.join('/Volumes', name);
    try {
      const st = await fs.lstat(full);
      // The boot volume appears as a symlink in /Volumes — skip so it isn't
      // listed twice (bootLocation already shows it).
      if (st.isSymbolicLink()) continue;
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    const stats = await diskStats(full);
    const loc: Location = {
      id: `vol:${name}`,
      label: name,
      path: full,
      icon: 'usb',
      kind: 'external',
      caption: 'External',
    };
    if (stats) {
      loc.usedPct = Math.round((stats.used / stats.total) * 100);
      loc.caption = `${fmtBytes(stats.used)} of ${fmtBytes(stats.total)} used`;
    }
    out.push(loc);
  }
  return out;
}

// Windows has no /Volumes — drives are letters (C:, D:, …). Probe each letter
// for a mounted, accessible root, skipping the system drive (shown by
// bootLocation). statfs gives us usage just like the POSIX path.
async function windowsDriveLocations(): Promise<Location[]> {
  const out: Location[] = [];
  const systemRoot = path.parse(os.homedir()).root.toUpperCase(); // e.g. "C:\"
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const letter = String.fromCharCode(c);
    const root = `${letter}:\\`;
    if (root.toUpperCase() === systemRoot) continue;
    try {
      // accessing the root throws if no media is mounted (e.g. empty DVD).
      await fs.access(root);
    } catch {
      continue;
    }
    const stats = await diskStats(root);
    const loc: Location = {
      id: `vol:${letter}`,
      label: `Local Disk (${letter}:)`,
      path: root,
      icon: 'usb',
      kind: 'external',
      caption: 'Drive',
    };
    if (stats) {
      loc.usedPct = Math.round((stats.used / stats.total) * 100);
      loc.caption = `${fmtBytes(stats.used)} of ${fmtBytes(stats.total)} used`;
    }
    out.push(loc);
  }
  return out;
}

// CloudStorage directory names follow `<Provider>-<AccountOrId>` (e.g.
// GoogleDrive-alice@gmail.com, OneDrive-Personal, Dropbox). Map the known
// providers to human labels; unknown providers fall back to the raw prefix
// with underscores softened to spaces.
const CLOUD_PROVIDERS: Record<string, string> = {
  GoogleDrive: 'Google Drive',
  OneDrive: 'OneDrive',
  Dropbox: 'Dropbox',
  Box: 'Box',
  iCloud: 'iCloud',
  pCloud: 'pCloud',
  MEGA: 'MEGA',
  ProtonDrive: 'Proton Drive',
  Creative_Cloud_Files: 'Creative Cloud Files',
};

function parseCloudName(name: string): { label: string; caption: string } {
  const dash = name.indexOf('-');
  const prefix = dash >= 0 ? name.slice(0, dash) : name;
  const suffix = dash >= 0 ? name.slice(dash + 1) : '';
  const label = CLOUD_PROVIDERS[prefix] ?? prefix.replace(/_/g, ' ');
  const caption = suffix ? `Cloud · ${suffix}` : 'Cloud';
  return { label, caption };
}

async function cloudLocations(): Promise<Location[]> {
  const home = os.homedir();
  const out: Location[] = [];

  const icloud = path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs');
  try {
    await fs.access(icloud);
    out.push({
      id: 'icloud',
      label: 'iCloud Drive',
      path: icloud,
      icon: 'folder',
      kind: 'icloud',
      caption: 'Cloud',
    });
  } catch {
    /* not present */
  }

  const cs = path.join(home, 'Library/CloudStorage');
  let names: string[] = [];
  try {
    names = await fs.readdir(cs);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = path.join(cs, name);
    try {
      const st = await fs.lstat(full);
      if (!st.isDirectory() && !st.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const parsed = parseCloudName(name);
    out.push({
      id: `cloud:${name}`,
      label: parsed.label,
      path: full,
      icon: 'folder',
      kind: 'cloud',
      caption: parsed.caption,
    });
  }
  return out;
}

// fm-z7v — bridge from api-server (Claude Code hook receiver) to the
// renderer. The pty registry lives inside registerIpc's closure; the
// IPC setup phase calls registerFgDispatcher() to install the routing
// callback, and the api-server calls dispatchTerminalFg() to fire it.
//
// State values:
//   'busy'    — UserPromptSubmit (turn in flight)
//   'idle'    — Stop / StopFailure (turn ended)
//   'waiting' — Notification (mid-turn permission prompt, idle warning).
//               Distinct from 'idle' so the renderer can force a banner
//               on the active tab — permission prompts buried in TUI
//               output are otherwise easy to miss.
export type ClaudeFgState = 'busy' | 'idle' | 'waiting';
let _fgDispatcher: ((ptyId: number, state: ClaudeFgState) => void) | null = null;
function registerFgDispatcher(cb: (ptyId: number, state: ClaudeFgState) => void) {
  _fgDispatcher = cb;
}
export function dispatchTerminalFg(ptyId: number, state: ClaudeFgState) {
  _fgDispatcher?.(ptyId, state);
}

// ─── Managed PTY core (fm-jtu, hoisted in fm-b5at.7) ─────────────────
// node-pty lives in the main process; the renderer drives it over IPC,
// and task runs (interactive run style) spawn into the same registry so
// the fg-state attention path and term:write/resize/kill all work
// uniformly. The term:spawn IPC handler and runTaskInteractive both
// delegate their final spawn to spawnManagedPty below.
type PtyRecord = {
  proc: import('@homebridge/node-pty-prebuilt-multiarch').IPty;
  senderId: number;
  cmd: string;
};
const ptys = new Map<number, PtyRecord>();
let nextPtyId = 1;

// SPIKE (spike/playwright-cdp): extra webContents that MIRROR a pty's
// term:data/term:exit/term:fg, on top of the owning senderId. The dedicated
// agent-overlay window registers here (term:mirror) so it shows the same live
// terminal as the main window's tab. Keyed by pty id → set of webContents ids.
const ptyMirrors = new Map<number, Set<number>>();

// Bounded scrollback buffer per pty (the most recent ~256 KB of term:data). A
// mirror that subscribes via 'term:mirror-with-replay' AFTER output was emitted
// (e.g. the operator window's Claude pane remounts, or is re-shown from
// collapsed) would otherwise show a blank pane until the next chunk arrives. We
// replay this buffer to the subscriber on attach so the terminal repaints
// immediately. Keyed by pty id → { chunks, bytes }. Cleared on pty exit.
const PTY_REPLAY_MAX_BYTES = 256 * 1024;
type ReplayBuffer = { chunks: string[]; bytes: number };
const ptyReplay = new Map<number, ReplayBuffer>();

/** Append a term:data chunk to a pty's bounded replay buffer, dropping the
 *  oldest chunks once the byte budget is exceeded. */
function appendReplay(id: number, data: string): void {
  let buf = ptyReplay.get(id);
  if (!buf) ptyReplay.set(id, (buf = { chunks: [], bytes: 0 }));
  buf.chunks.push(data);
  buf.bytes += data.length;
  while (buf.bytes > PTY_REPLAY_MAX_BYTES && buf.chunks.length > 1) {
    buf.bytes -= buf.chunks.shift()!.length;
  }
}

// ── PTY liveness gate (task-6fc9e503623e) ───────────────────────────────────
// "Got a pty id" is NOT "the session started": a claude child can spawn and
// EXIT IMMEDIATELY (bad arg, missing token, invalid cwd) and we'd still have
// returned a pty id. A session counts as genuinely started only if it stays
// alive for a grace window OR emits its first output within it. This registry
// lets the launcher AWAIT that verdict, and captures the exit code + a stderr/
// output TAIL on early exit so the failure is self-diagnosing (nothing recorded
// why the child died before — the reason this took several generations).
type LivenessWatch = {
  gotData: boolean;
  resolve: (v: PtyLivenessVerdict) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
};
export type PtyLivenessVerdict = {
  /** True when the pty survived the grace window or emitted first output. */
  alive: boolean;
  /** Exit code if it exited within the window (else null). */
  exitCode: number | null;
  /** Exit signal if any. */
  signal: number | null;
  /** Tail of the pty's output (stdout+stderr are merged in a pty), token-free
   *  by construction here (the launcher spawns claude with no PHI in argv). */
  tail: string;
};
const livenessWatches = new Map<number, LivenessWatch>();

// Exit info kept briefly AFTER a pty is removed from `ptys`, so a liveness
// awaiter that races the exit can still read the code/signal + tail. Cleared
// lazily (see the setTimeout in the pty onExit handler).
const ptyExitInfo = new Map<
  number,
  { exitCode: number | null; signal: number | null; tail: string }
>();

/** The most recent ~4 KB of a pty's output — enough to carry an error/usage
 *  line without dragging the whole 256 KB replay around. */
function ptyTail(id: number, maxBytes = 4096): string {
  const buf = ptyReplay.get(id);
  if (!buf || buf.chunks.length === 0) return '';
  const joined = buf.chunks.join('');
  const sliced = joined.length > maxBytes ? joined.slice(-maxBytes) : joined;
  // Strip ANSI escape sequences so the recorded tail is human-readable in the
  // activity log (the live terminal keeps the colored version).
  // eslint-disable-next-line no-control-regex
  return sliced.replace(/\[[0-9;?]*[A-Za-z]/g, '').trim();
}

function settleLiveness(id: number, verdict: PtyLivenessVerdict): void {
  const w = livenessWatches.get(id);
  if (!w || w.settled) return;
  w.settled = true;
  clearTimeout(w.timer);
  livenessWatches.delete(id);
  w.resolve(verdict);
}

/**
 * Await a verdict on whether pty `id` genuinely started. Resolves:
 *   - { alive:true } if it emits first data OR survives `minAliveMs`.
 *   - { alive:false, exitCode, signal, tail } if it exits within the window.
 * Must be called right after spawnManagedPty(id). Safe to call once per pty.
 */
export function awaitPtyLiveness(
  id: number,
  opts?: { minAliveMs?: number; requireFirstData?: boolean },
): Promise<PtyLivenessVerdict> {
  const minAliveMs = opts?.minAliveMs ?? 5000;
  const deadVerdict = (): PtyLivenessVerdict => {
    const ei = ptyExitInfo.get(id);
    return {
      alive: false,
      exitCode: ei?.exitCode ?? null,
      signal: ei?.signal ?? null,
      tail: ei?.tail ?? ptyTail(id),
    };
  };
  // If the pty already vanished before we got here (it exited in the gap
  // between spawn and this call), it's dead — read its stashed exit info.
  if (!ptys.has(id)) return Promise.resolve(deadVerdict());
  return new Promise<PtyLivenessVerdict>((resolve) => {
    const timer = setTimeout(() => {
      // Survived the grace window → alive.
      settleLiveness(id, { alive: true, exitCode: null, signal: null, tail: '' });
    }, minAliveMs);
    livenessWatches.set(id, { gotData: false, resolve, timer, settled: false });
    // Re-check for an exit that fired AFTER our ptys.has() check but BEFORE we
    // registered the watcher (its settleLiveness would have no-op'd). Without
    // this the timer would wrongly report alive for an already-dead pty.
    if (!ptys.has(id)) settleLiveness(id, deadVerdict());
  });
}

/** Fan a pty event out to the owning window + any registered mirrors. */
function sendToPtyClients(
  id: number,
  primarySenderId: number,
  channel: string,
  payload: unknown,
): void {
  const ids = new Set<number>([primarySenderId, ...(ptyMirrors.get(id) ?? [])]);
  for (const wid of ids) {
    const wc = webContents.fromId(wid);
    if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  }
}

function ptyEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Electron sets ELECTRON_RUN_AS_NODE / NODE_OPTIONS that confuse user
  // shells. Strip them. TERM_PROGRAM lets prompts (oh-my-zsh, starship)
  // know we're a terminal so they enable rich UI.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.TERM = env.TERM || 'xterm-256color';
  env.COLORTERM = env.COLORTERM || 'truecolor';
  env.TERM_PROGRAM = 'BreezeFile';
  if (extra) Object.assign(env, extra);
  return env;
}

type SpawnManagedPtyOpts = {
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  /** webContents id that owns the PTY (term:data / term:exit target). */
  senderId: number;
  /** Extra env layered on top of ptyEnv. BREEZE_PTY_ID is always set. */
  env?: Record<string, string>;
  /** Run when the PTY exits (after term:exit is sent). */
  onExit?: (info: { exitCode: number; signal: number | null }) => void;
  /** Pre-reserved id (from reservePtyId) when the caller needed it to
   *  build env/args before spawning. Defaults to the next fresh id. */
  id?: number;
};

/** Spawn a PTY, register it under a fresh id, and wire term:data /
 *  term:exit to the owning webContents. Returns the new pty id. Shared by
 *  the term:spawn IPC handler (shell/ssh) and runTaskInteractive (claude). */
function spawnManagedPty(opts: SpawnManagedPtyOpts): number {
  const id = opts.id ?? nextPtyId;
  if (id >= nextPtyId) nextPtyId = id + 1;
  const proc = nodePty.spawn(opts.file, opts.args, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: ptyEnv({
      ...opts.env,
      BREEZE_PTY_ID: String(id),
    }) as { [key: string]: string },
  });
  ptys.set(id, { proc, senderId: opts.senderId, cmd: opts.file });
  proc.onData((data) => {
    // Read the CURRENT owner from the record (not the closure) so a future
    // retarget would be honored, and fan out to any overlay mirrors.
    const sid = ptys.get(id)?.senderId ?? opts.senderId;
    // Buffer for late-joining mirrors (operator pane remount / re-show).
    appendReplay(id, data);
    // task-6fc9e503623e — first output within the grace window counts as
    // "alive" (a claude session that printed anything is up and running).
    const w = livenessWatches.get(id);
    if (w && !w.gotData) {
      w.gotData = true;
      settleLiveness(id, { alive: true, exitCode: null, signal: null, tail: '' });
    }
    sendToPtyClients(id, sid, 'term:data', { id, data });
  });
  proc.onExit(({ exitCode, signal }) => {
    const sid = ptys.get(id)?.senderId ?? opts.senderId;
    sendToPtyClients(id, sid, 'term:exit', { id, code: exitCode, signal: signal ?? null });
    // task-6fc9e503623e — an exit while a liveness gate is still open is an
    // EARLY EXIT: settle it as dead, carrying the exit code + output tail so
    // the launcher can release the claim and RECORD why the child died. Read
    // the tail BEFORE clearing the replay buffer below.
    const tail = ptyTail(id);
    ptyExitInfo.set(id, { exitCode: exitCode ?? null, signal: signal ?? null, tail });
    settleLiveness(id, {
      alive: false,
      exitCode: exitCode ?? null,
      signal: signal ?? null,
      tail,
    });
    // Drop the stashed exit info after a short grace so a late awaiter can
    // still read it, without leaking unboundedly.
    setTimeout(() => ptyExitInfo.delete(id), 30_000);
    ptys.delete(id);
    ptyMirrors.delete(id);
    ptyReplay.delete(id);
    try { opts.onExit?.({ exitCode, signal: signal ?? null }); } catch (e) {
      console.error('[pty] onExit hook:', e);
    }
  });
  return id;
}

/** Reserve a pty id without spawning. Used by callers that need the id to
 *  thread into env/args before the spawn (pass it back as opts.id). */
function reservePtyId(): number {
  return nextPtyId++;
}

/** Gracefully terminate a managed PTY by id from the main process (no IPC
 *  round-trip). Used by the TypeBuild expiry relaunch (fm-b5at.10) to retire
 *  the old, expired session before respawning a fresh one. The proc's own
 *  onExit handler removes it from the registry and fires term:exit; we also
 *  delete defensively in case the kill races. No-op if the id is unknown. */
function killManagedPty(id: number, signal?: string): void {
  const r = ptys.get(id);
  if (!r) return;
  try {
    r.proc.kill(signal);
  } catch {
    /* already gone */
  }
  ptys.delete(id);
}

/** Write raw data into a managed PTY's stdin from MAIN (no IPC round-trip,
 *  no renderer involvement) — the same write path term:write uses (r.proc.
 *  write), just callable directly by main-process code. task-bd35fc4330c0:
 *  this is the channel the interactive launcher uses to deliver the
 *  pre-assembled, PHI-bearing task-work bundle as the agent's first message —
 *  the bundle text lives in process memory only (never argv, never a file)
 *  and crosses straight into the pty's stdin fd, exactly as if the user had
 *  typed it into the embedded terminal. No-op if the id is unknown or the
 *  child already exited (mirrors killManagedPty's tolerance). */
function writeManagedPty(id: number, data: string): void {
  const r = ptys.get(id);
  if (!r) return;
  try {
    r.proc.write(data);
  } catch {
    /* pty may have just exited */
  }
}

export { spawnManagedPty, reservePtyId, killManagedPty, writeManagedPty };
export type { SpawnManagedPtyOpts };

export function registerIpc() {
  // Capability manifest — boot-time read by the renderer to gate verbs and UI
  // (see docs/cross-platform-strategy.md). Synchronous on the adapter side.
  ipcMain.handle('platform:capabilities', () => ({
    id: platform().id,
    ...platform().capabilities(),
  }));

  // ─── TypeBuild side-by-side layout (fm-b5at.6) ────────────────────────
  // Self-contained block: arrange Chrome left / our window right while a
  // TypeBuild interactive session runs. The orchestrator (window-arrange.ts)
  // owns `screen` + own-window bounds; the OS branch for moving Chrome lives
  // in the PlatformAdapter. Renderer calls these via window.fm.sideBySide.*.
  ipcMain.handle('window:sideBySide:enter', (_e, split?: number) =>
    enterSideBySide(split),
  );
  ipcMain.handle('window:sideBySide:exit', () => exitSideBySide());
  ipcMain.handle('window:sideBySide:toggle', (_e, split?: number) =>
    toggleSideBySide(split),
  );
  ipcMain.handle('window:sideBySide:state', () => ({ active: isSideBySide() }));
  // Permission/capability probe so Settings can show the right affordance
  // ('no-permission' → privacy-pane button on mac; 'unsupported' → Wayland
  // degraded-mode note).
  ipcMain.handle('window:sideBySide:probe', () => probeWindowArrange());

  // Hydrate persisted "Open With" bindings on startup so `app:open` can
  // dispatch to the bound app without an extra async hop on each call.
  void loadBindings();

  ipcMain.handle('app:open', async (_e, filepath: string, appPath?: string) => {
    const abs = expandHome(filepath);
    await loadBindings();
    let bound = appPath;
    if (!bound) {
      const ext = extOf(abs);
      if (ext && bindings[ext]) bound = bindings[ext];
    }
    if (bound) {
      return openWithApp(bound, abs);
    }
    await shell.openPath(abs);
  });

  // Open an http/https URL in the user's default browser. Used by xterm's
  // WebLinksAddon so we route link clicks through a known-good IPC path
  // instead of relying on window.open (which can show a browser-level
  // navigate-confirm and silently fail in our sandboxed renderer).
  ipcMain.handle('app:openUrl', async (_e, url: string) => {
    if (!/^(https?:|mailto:|tel:)/i.test(url)) {
      console.log(`[link] ipc ignored: ${url.slice(0, 200)}`);
      return;
    }
    console.log(`[link] ipc opening: ${url.slice(0, 200)}`);
    try {
      await shell.openExternal(url);
    } catch (err) {
      console.error(`[link] ipc openExternal failed for ${url}:`, err);
    }
  });

  ipcMain.handle('app:pickApplication', async () => {
    const win = BrowserWindow.getFocusedWindow();
    // NB: do NOT pass `treatPackageAsDirectory` — on macOS that lets the
    // user double-click an .app and drill INTO its bundle, returning a
    // path like `/Applications/VS Code.app/Contents/MacOS/Electron`.
    // `open -a` then routes the file to that nested binary, which is what
    // the user perceived as "Open With goes into a subfolder of the app".
    // Without the flag, .app bundles are atomic — selectable but not
    // enterable — which is exactly what we want here.
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose an Application',
      buttonLabel: 'Choose',
      defaultPath: isMac
        ? '/Applications'
        : isWin
          ? process.env['PROGRAMFILES'] || 'C:\\Program Files'
          : '/usr/bin',
      properties: ['openFile'],
      filters: isMac
        ? [{ name: 'Applications', extensions: ['app'] }]
        : isWin
          ? [{ name: 'Programs', extensions: ['exe', 'bat', 'cmd', 'com'] }]
          : undefined,
    };
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    const picked = res.filePaths[0];
    // Belt-and-suspenders: on macOS the picked path must be a .app bundle so
    // `open -a` routes to it; a binary inside the bundle would mis-launch.
    if (isMac && !picked.toLowerCase().endsWith('.app')) {
      throw new Error('Pick a .app bundle (not a file inside one)');
    }
    return picked;
  });

  ipcMain.handle('app:pickFolder', async (_e, defaultPath?: string) => {
    const win = BrowserWindow.getFocusedWindow();
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose a Folder',
      buttonLabel: 'Choose',
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    };
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  // fm-3vl — export-list verb: show a Save dialog and write the supplied text
  // (the selected paths, plain or JSON) to the chosen file. Returns the saved
  // path, or null when the user cancels. The content is built renderer-side
  // (newline-joined paths or a JSON array) so this stays a dumb writer.
  ipcMain.handle(
    'app:saveList',
    async (
      _e,
      content: string,
      defaultName?: string,
    ): Promise<string | null> => {
      const win = BrowserWindow.getFocusedWindow();
      const opts: Electron.SaveDialogOptions = {
        title: 'Export selection list',
        defaultPath: defaultName || 'selection.txt',
        filters: [
          { name: 'Text', extensions: ['txt'] },
          { name: 'JSON', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      };
      const res = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts);
      if (res.canceled || !res.filePath) return null;
      await fs.writeFile(res.filePath, content, 'utf8');
      return res.filePath;
    },
  );

  ipcMain.handle('bindings:get', async () => {
    await loadBindings();
    return { ...bindings };
  });
  ipcMain.handle('bindings:set', async (_e, ext: string, appPath: string) => {
    await loadBindings();
    const key = normExt(ext);
    if (!key) return;
    bindings[key] = appPath;
    await saveBindings();
  });
  ipcMain.handle('bindings:clear', async (_e, ext: string) => {
    await loadBindings();
    const key = normExt(ext);
    if (!key) return;
    delete bindings[key];
    await saveBindings();
  });

  ipcMain.handle('fs:readdir', async (_e, dirpath: string) => {
    return readdirEntries(dirpath);
  });

  // fm-mp1 / fm-xr0 — recursively walk a scope and return full-metadata Entry
  // rows for every descendant, so the renderer can evaluate a tagDsl selector
  // across a whole subtree (filter-tabs) or capture a frozen snapshot of the
  // matching paths. Capped (see walkScope): default depth ≤ 8, ≤ 5000 entries.
  ipcMain.handle(
    'fs:walkScope',
    async (
      _e,
      scope: string,
      opts?: { maxDepth?: number; maxCount?: number; includeHidden?: boolean },
    ) => {
      return walkScope(scope, opts);
    },
  );

  ipcMain.handle('fs:homedir', () => os.homedir());

  // ─── Locations (drive / cloud detection) ───────────────────────────
  // Enumerates mountable things the sidebar's "Locations" section shows:
  //   1. boot volume via statfs('/') for real usage
  //   2. /Volumes/* externals, skipping the boot symlink macOS plants there
  //   3. ~/Library/CloudStorage/* cloud providers (Google Drive, OneDrive,
  //      Dropbox, etc.) — names encode "<Provider>-<account>" so we split
  //      on the first dash to get a readable label + account caption.
  //   4. iCloud Drive at the canonical com~apple~CloudDocs path.
  // Cloud providers don't expose quota locally; caption just says "Cloud".
  ipcMain.handle('fs:listLocations', async (): Promise<Location[]> => {
    const [boot, ext, cloud] = await Promise.all([
      bootLocation(),
      externalLocations(),
      cloudLocations(),
    ]);
    return [boot, ...ext, ...cloud];
  });

  ipcMain.handle('fs:stat', async (_e, p: string) => {
    const abs = expandHome(p);
    const st = await fs.lstat(abs);
    return { size: st.size, mtimeMs: st.mtimeMs, isDir: st.isDirectory() };
  });

  ipcMain.handle('fs:mkdir', async (_e, p: string) => {
    // Not recursive — if the folder already exists we want the caller to see
    // an EEXIST so the user learns why nothing changed. `recursive:true`
    // silently succeeds on an existing dir, which is how a "New Folder" with
    // a colliding name previously closed with no feedback.
    const abs = expandHome(p);
    try {
      await fs.mkdir(abs);
    } catch (err) {
      throw friendlyFsError(err, { op: 'mkdir', name: path.basename(abs) });
    }
  });

  ipcMain.handle('fs:rename', async (_e, from: string, to: string) => {
    const src = expandHome(from);
    const dst = expandHome(to);
    // POSIX `rename` silently overwrites an existing target (when it's a
    // file, or — on some filesystems — an empty directory), which in a file
    // manager looks like "I typed a duplicate name and my original vanished".
    // Pre-check and refuse with a clear message; a real overwrite should go
    // through the paste/overwrite flow where the user confirms.
    if (src !== dst) {
      try {
        await fs.lstat(dst);
        throw friendlyFsError({ code: 'EEXIST' }, { op: 'rename', target: dst });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code && code !== 'ENOENT') throw err;
      }
    }
    try {
      await fs.rename(src, dst);
    } catch (err) {
      throw friendlyFsError(err, { op: 'rename', target: dst });
    }
  });

  ipcMain.handle('fs:trash', async (_e, paths: string[]) => {
    for (const p of paths) await shell.trashItem(expandHome(p));
  });

  // fm-7klh — irreversible delete (no Trash). Gated behind a typed
  // confirmation in the renderer; there is no keyboard chord for it. `force`
  // ignores already-gone paths so a partial selection still completes.
  ipcMain.handle('fs:permanent-delete', async (_e, paths: string[]) => {
    for (const p of paths) {
      await fs.rm(expandHome(p), { recursive: true, force: true });
    }
  });

  ipcMain.handle(
    'fs:paste',
    async (
      _e,
      ops: {
        src: string;
        dst: string;
        mode: 'copy' | 'move' | 'symlink' | 'symlinkRel' | 'hardlink';
        overwrite?: boolean;
      }[],
    ) => {
      let renamed = 0;
      for (const op of ops) {
        const originalTarget = path.join(op.dst, path.basename(op.src));
        let target = op.overwrite
          ? originalTarget
          : await uniquePaste(op.dst, path.basename(op.src));
        if (!op.overwrite && target !== originalTarget) renamed += 1;
        if (op.overwrite) {
          try {
            await fs.rm(target, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
        if (op.mode === 'move') {
          try {
            await fs.rename(op.src, target);
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
              await copyRecursive(op.src, target);
              await fs.rm(op.src, { recursive: true, force: true });
            } else throw err;
          }
        } else if (op.mode === 'symlink') {
          await fs.symlink(op.src, target);
        } else if (op.mode === 'symlinkRel') {
          await fs.symlink(path.relative(op.dst, op.src), target);
        } else if (op.mode === 'hardlink') {
          await fs.link(op.src, target);
        } else {
          await copyRecursive(op.src, target);
        }
      }
      return { renamed };
    },
  );

  ipcMain.handle('fs:touch', async (_e, p: string) => {
    const abs = expandHome(p);
    // `wx` fails if the file already exists — the 'Create file' verb wants
    // that error surfaced rather than silently re-touching an existing file.
    try {
      await fs.writeFile(abs, '', { flag: 'wx' });
    } catch (err) {
      throw friendlyFsError(err, { op: 'touch', name: path.basename(abs) });
    }
  });

  ipcMain.handle('shell:reveal', (_e, p: string) => {
    shell.showItemInFolder(expandHome(p));
  });

  // ─── Terminal selection (fm-2du) ───────────────────────────────────
  // Users pick a terminal once; we persist it next to openwith.json.
  // Detection scans /Applications and ~/Applications for known bundles.
  // The launch branches per bundle use execFile/spawn with arg arrays,
  // never shell concatenation — paths routinely contain spaces.
  const KNOWN_TERMINALS = [
    'Terminal.app',
    'iTerm.app',
    'WezTerm.app',
    'Warp.app',
    'Ghostty.app',
    'Alacritty.app',
    'kitty.app',
  ];

  function terminalPrefPath(): string {
    return path.join(app.getPath('userData'), 'terminal.json');
  }
  async function loadTerminalPref(): Promise<string | null> {
    try {
      const raw = await fs.readFile(terminalPrefPath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.bundle === 'string') return parsed.bundle;
      return null;
    } catch {
      return null;
    }
  }
  async function saveTerminalPref(bundle: string | null): Promise<void> {
    const p = terminalPrefPath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    if (bundle === null) {
      await fs.writeFile(p, JSON.stringify({ bundle: null }, null, 2), 'utf8');
    } else {
      await fs.writeFile(p, JSON.stringify({ bundle }, null, 2), 'utf8');
    }
  }

  async function detectTerminals(): Promise<string[]> {
    if (process.platform !== 'darwin') return [];
    const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
    const found = new Set<string>();
    for (const root of roots) {
      try {
        const names = await fs.readdir(root);
        for (const n of names) {
          if (KNOWN_TERMINALS.includes(n)) found.add(n);
        }
      } catch {
        // root may not exist
      }
    }
    // Preserve KNOWN_TERMINALS order for stable UI.
    return KNOWN_TERMINALS.filter((t) => found.has(t));
  }

  function launchTerminal(bundle: string, abs: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const done = (err: Error | null) => (err ? reject(err) : resolve());
      switch (bundle) {
        case 'Terminal.app':
          execFile('open', ['-a', 'Terminal', abs], done);
          return;
        case 'iTerm.app': {
          // AppleScript: new window, then cd into the target folder. Using
          // `tell application "iTerm"` opens a window if none exists and
          // returns to an existing session otherwise.
          const escaped = abs.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const script = `tell application "iTerm"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow
    write text "cd \\"${escaped}\\" && clear"
  end tell
end tell`;
          execFile('osascript', ['-e', script], done);
          return;
        }
        case 'WezTerm.app':
          spawn('wezterm', ['start', '--cwd', abs], { stdio: 'ignore', detached: true })
            .on('error', reject)
            .on('spawn', () => resolve());
          return;
        case 'Warp.app':
          execFile('open', ['-a', 'Warp', abs], done);
          return;
        case 'Ghostty.app':
          execFile(
            'open',
            ['-na', 'Ghostty', '--args', `--working-directory=${abs}`],
            done,
          );
          return;
        case 'Alacritty.app':
          spawn('alacritty', ['--working-directory', abs], { stdio: 'ignore', detached: true })
            .on('error', reject)
            .on('spawn', () => resolve());
          return;
        case 'kitty.app':
          spawn('kitty', ['--directory', abs], { stdio: 'ignore', detached: true })
            .on('error', reject)
            .on('spawn', () => resolve());
          return;
        default:
          // Fallback to `open -a <Bundle>` for anything unknown.
          execFile('open', ['-a', bundle.replace(/\.app$/, ''), abs], done);
      }
    });
  }

  // Open a native terminal in `abs` on Windows/Linux. No selection UI — we try
  // the platform's best option and fall back to a guaranteed one.
  function launchNativeTerminal(abs: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const trySpawn = (
        candidates: Array<{ cmd: string; args: string[] }>,
        i = 0,
      ): void => {
        if (i >= candidates.length) {
          reject(new Error('no terminal emulator found'));
          return;
        }
        const { cmd, args } = candidates[i];
        const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
        let settled = false;
        child.on('error', () => {
          if (settled) return;
          settled = true;
          trySpawn(candidates, i + 1); // ENOENT etc. → next candidate
        });
        child.on('spawn', () => {
          if (settled) return;
          settled = true;
          child.unref();
          resolve();
        });
      };

      if (process.platform === 'win32') {
        // Windows Terminal (wt.exe) is the modern default; cmd.exe via the
        // shell's `start` is the universal fallback. `start "" cmd /K cd /d`
        // opens a fresh console window already in the folder.
        trySpawn([
          { cmd: 'wt.exe', args: ['-d', abs] },
          { cmd: process.env.COMSPEC || 'cmd.exe', args: ['/C', 'start', '', 'cmd.exe', '/K', `cd /d "${abs}"`] },
        ]);
        return;
      }
      // Linux: try the common terminals' cwd flags in turn.
      trySpawn([
        { cmd: 'x-terminal-emulator', args: ['--working-directory', abs] },
        { cmd: 'gnome-terminal', args: [`--working-directory=${abs}`] },
        { cmd: 'konsole', args: ['--workdir', abs] },
        { cmd: 'xterm', args: ['-e', `cd "${abs}" && ${process.env.SHELL || '/bin/sh'}`] },
      ]);
    });
  }

  ipcMain.handle('shell:listTerminals', async (): Promise<string[]> => {
    return detectTerminals();
  });

  ipcMain.handle('shell:getDefaultTerminal', async (): Promise<string | null> => {
    return loadTerminalPref();
  });

  ipcMain.handle('shell:setDefaultTerminal', async (_e, bundle: string | null) => {
    await saveTerminalPref(bundle);
  });

  ipcMain.handle('shell:openTerminal', async (_e, cwd: string) => {
    const abs = expandHome(cwd);
    // Off macOS we don't have a `.app` catalog to choose from — launch a
    // sensible native terminal in the folder directly (no selection step).
    if (process.platform !== 'darwin') {
      await launchNativeTerminal(abs);
      return;
    }
    const pref = await loadTerminalPref();
    if (!pref) {
      // Structured error so the renderer can open the chooser.
      const err = new Error('needsSelection');
      (err as Error & { needsSelection?: boolean }).needsSelection = true;
      throw err;
    }
    await launchTerminal(pref, abs);
  });

  ipcMain.handle('shell:runCommand', async (_e, cwd: string, cmd: string) => {
    const abs = expandHome(cwd);
    return new Promise<void>((resolve, reject) => {
      const p = spawn(cmd, { cwd: abs, shell: true, stdio: 'inherit' });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });
  });

  // ─── Compress / Extract ──────────────────────────────────────────────
  // Rationale: the verbs must never shell-concat paths (filenames can carry
  // spaces, quotes, even newlines). Every external tool is invoked with an
  // explicit argv array via execFile so the OS passes paths untouched.
  async function uniqueSiblingPath(candidate: string): Promise<string> {
    // Collision policy: " 2", " 3", … suffix on the stem. Matches the bead
    // spec and mirrors Finder's duplicate-naming style more closely than
    // the paren form used by uniquePaste (internal copy/move).
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
    const dir = path.dirname(candidate);
    const base = path.basename(candidate);
    // Split off final extension only (e.g. "Archive.zip" → "Archive"+".zip";
    // "foo.tar.gz" → "foo.tar"+".gz"). For the compress path this is fine
    // because callers pass a single-extension name. Extract uses this for
    // destination folders which have no extension at all.
    const dotIdx = base.lastIndexOf('.');
    const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
    const ext = dotIdx > 0 ? base.slice(dotIdx) : '';
    for (let i = 2; i < 1000; i++) {
      const next = path.join(dir, `${stem} ${i}${ext}`);
      try {
        await fs.access(next);
      } catch {
        return next;
      }
    }
    throw new Error('too many collisions');
  }

  function runTool(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === 'ENOENT') {
            reject(new Error(`${cmd} not found on PATH`));
            return;
          }
          reject(new Error(stderr?.toString().trim() || err.message));
          return;
        }
        resolve({ stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
      });
    });
  }

  // Build a .zip at `dest` containing `sources` (each kept under its basename).
  // Windows: PowerShell's Compress-Archive (always present, no extra install).
  // Linux: the `zip` CLI; falls back to a clear error if it isn't installed.
  // (macOS uses ditto directly in the compress handler and never calls this.)
  async function compressZip(sources: string[], dest: string): Promise<void> {
    if (process.platform === 'win32') {
      // -Path takes a comma-separated, single-quoted list. Single quotes in a
      // PowerShell literal are escaped by doubling. -Force overwrites the dest
      // we already deduped to a fresh name, so collisions can't happen.
      const psList = sources
        .map((s) => `'${s.replace(/'/g, "''")}'`)
        .join(',');
      const psDest = `'${dest.replace(/'/g, "''")}'`;
      await runTool('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path ${psList} -DestinationPath ${psDest} -Force`,
      ]);
      return;
    }
    // Linux: `zip -r <dest> <basenames>` run from the common parent so the
    // archive holds plain names, not absolute paths. All sources of a single
    // compress action share a directory (they're a multi-selection in one
    // folder), so chdir to the first source's parent.
    const cwd = path.dirname(sources[0]);
    const names = sources.map((s) => path.basename(s));
    await new Promise<void>((resolve, reject) => {
      execFile('zip', ['-r', '-q', dest, ...names], { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, _o, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === 'ENOENT') {
            reject(new Error('Install zip (e.g. apt install zip)'));
            return;
          }
          reject(new Error(stderr?.toString().trim() || err.message));
          return;
        }
        resolve();
      });
    });
  }

  ipcMain.handle(
    'shell:compress',
    async (_e, sources: string[], cwd: string): Promise<string> => {
      if (!sources || sources.length === 0) throw new Error('nothing to compress');
      const absSources = sources.map(expandHome);
      const absCwd = expandHome(cwd);
      const baseName =
        absSources.length === 1
          ? `${path.basename(absSources[0])}.zip`
          : 'Archive.zip';
      const dest = await uniqueSiblingPath(path.join(absCwd, baseName));
      if (process.platform === 'darwin') {
        // `ditto -c -k --sequesterRsrc --keepParent` preserves HFS metadata
        // (resource forks, xattrs) and keeps the selected item's folder name
        // at the archive root — the behavior macOS's Finder "Compress" uses.
        await runTool('ditto', [
          '-c',
          '-k',
          '--sequesterRsrc',
          '--keepParent',
          ...absSources,
          dest,
        ]);
        return dest;
      }
      // Windows ships bsdtar as `tar.exe`, which writes a real .zip with
      // `-a` (auto-detect format from the destination extension). Linux's
      // GNU tar lacks `-a`/zip, so use PowerShell's Compress-Archive there
      // and on Windows we prefer it too for predictability. Items are passed
      // relative to a common parent so the archive keeps their basenames.
      await compressZip(absSources, dest);
      return dest;
    },
  );

  // Archive detection is basename-based (no magic-number sniffing): matches
  // the renderer's `isAvailable` guard and keeps the IPC boundary simple.
  function archiveKind(p: string): 'zip' | 'tar' | '7z' | 'rar' | 'dmg' | null {
    const lower = p.toLowerCase();
    if (lower.endsWith('.zip')) return 'zip';
    if (
      lower.endsWith('.tar') ||
      lower.endsWith('.tar.gz') ||
      lower.endsWith('.tgz') ||
      lower.endsWith('.tar.bz2') ||
      lower.endsWith('.tbz2') ||
      lower.endsWith('.tar.xz') ||
      lower.endsWith('.txz')
    )
      return 'tar';
    if (lower.endsWith('.7z')) return '7z';
    if (lower.endsWith('.rar')) return 'rar';
    if (lower.endsWith('.dmg')) return 'dmg';
    return null;
  }

  // Strip the final extension (and an inner .tar for compound tarballs) to
  // derive the destination folder name. Sibling of the archive, not a child
  // of cwd, because a user might extract something selected from a pin or
  // Spotlight result that doesn't live in cwd.
  function archiveStem(p: string): string {
    const base = path.basename(p);
    const lower = base.toLowerCase();
    for (const compound of ['.tar.gz', '.tar.bz2', '.tar.xz']) {
      if (lower.endsWith(compound)) return base.slice(0, base.length - compound.length);
    }
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
  }

  ipcMain.handle(
    'shell:extract',
    async (_e, archives: string[], _cwd: string): Promise<string[]> => {
      if (!archives || archives.length === 0) throw new Error('nothing to extract');
      const out: string[] = [];
      for (const raw of archives) {
        const src = expandHome(raw);
        const kind = archiveKind(src);
        if (!kind) throw new Error(`not a recognized archive: ${path.basename(src)}`);
        if (kind === 'dmg') {
          // .dmg is a macOS disk image; hdiutil exists only on macOS. Mounting
          // is meaningless elsewhere — surface a clear error.
          if (process.platform !== 'darwin') {
            throw new Error('.dmg disk images can only be opened on macOS');
          }
          // hdiutil attach prints a 3-column tab-separated table; the last
          // row's 3rd column is the mount point (e.g. "/Volumes/Foo").
          const { stdout } = await runTool('hdiutil', ['attach', '-plist', src]);
          // Parse minimal plist — look for <string>/Volumes/...</string>.
          const m = stdout.match(/<string>(\/Volumes\/[^<]+)<\/string>/);
          const mount = m ? m[1] : '';
          if (!mount) throw new Error(`mounted but could not parse mount point`);
          out.push(mount);
          continue;
        }
        const parentDir = path.dirname(src);
        const stem = archiveStem(src);
        const destDir = await uniqueSiblingPath(path.join(parentDir, stem));
        await fs.mkdir(destDir, { recursive: true });
        const isWin = process.platform === 'win32';
        const isMac = process.platform === 'darwin';
        try {
          if (kind === 'zip') {
            if (isMac) {
              await runTool('ditto', ['-x', '-k', src, destDir]);
            } else if (isWin) {
              // Expand-Archive is built into PowerShell 5+ (ships with
              // Windows). -Force so a re-extract into our fresh dir is clean.
              await runTool('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `Expand-Archive -LiteralPath '${src.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
              ]);
            } else {
              // Linux: bsdtar / GNU `unzip` both common; prefer unzip.
              try {
                await runTool('unzip', ['-q', '-o', src, '-d', destDir]);
              } catch (err) {
                if ((err as Error).message.includes('not found on PATH')) {
                  throw new Error('Install unzip (e.g. apt install unzip)');
                }
                throw err;
              }
            }
          } else if (kind === 'tar') {
            // bsdtar ships as tar.exe on Windows 10+ and is standard on
            // mac/Linux. Same invocation everywhere.
            await runTool('tar', ['-xf', src, '-C', destDir]);
          } else if (kind === '7z') {
            // 7-Zip's CLI is `7z`/`7z.exe` on Windows, `7zz` on mac/Linux.
            const bin = isWin ? '7z' : '7zz';
            try {
              await runTool(bin, ['x', `-o${destDir}`, '-y', src]);
            } catch (err) {
              if ((err as Error).message.includes('not found on PATH')) {
                throw new Error(
                  isWin ? 'Install 7-Zip and add it to PATH' : 'Install 7-Zip (brew install sevenzip)',
                );
              }
              throw err;
            }
          } else if (kind === 'rar') {
            // unar on mac/Linux; on Windows fall back to 7-Zip which reads rar.
            const bin = isWin ? '7z' : 'unar';
            const args = isWin ? ['x', `-o${destDir}`, '-y', src] : ['-o', destDir, src];
            try {
              await runTool(bin, args);
            } catch (err) {
              if ((err as Error).message.includes('not found on PATH')) {
                throw new Error(
                  isWin ? 'Install 7-Zip to extract .rar' : 'Install unar (brew install unar)',
                );
              }
              throw err;
            }
          }
        } catch (err) {
          // Clean up the empty dest folder we just created so a failed
          // extract doesn't pollute the sidebar with a phantom directory.
          await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
          throw err;
        }
        out.push(destDir);
      }
      return out;
    },
  );

  // app:openPrivacyPane — deep-link into macOS System Settings → Privacy.
  // For unsigned apps, TCC won't always remember per-folder grants, so giving
  // users a one-click way into "Files and Folders" (per-folder list) or
  // "Full Disk Access" (the nuclear allow-everything switch) is the cheapest
  // permission UX without app signing.
  // permissions:prime — trigger the per-folder TCC prompts in sequence
  // so the user sees them with Breeze focused (just after dismissing the
  // Welcome notice), rather than being surprised later during navigation.
  // macOS only prompts once per (app, folder); a denial sticks, so the
  // returned map lets the renderer offer a recovery path if needed.
  ipcMain.handle('permissions:prime', async () => {
    const result: Record<string, 'granted' | 'denied' | 'missing'> = {};
    if (process.platform !== 'darwin') return result;
    const home = os.homedir();
    const targets: Array<[string, string]> = [
      ['desktop', path.join(home, 'Desktop')],
      ['documents', path.join(home, 'Documents')],
      ['downloads', path.join(home, 'Downloads')],
      ['icloud', path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs')],
    ];
    // Serialize so macOS shows prompts one at a time in a predictable order.
    // Use opendir+close (not readdir) — we just need to trigger the TCC
    // check, not enumerate. readdir on Downloads/Documents/iCloud can take
    // many seconds (iCloud materializes placeholders), hanging this IPC.
    for (const [key, dir] of targets) {
      try {
        const handle = await fs.opendir(dir);
        await handle.close();
        result[key] = 'granted';
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') result[key] = 'missing';
        else result[key] = 'denied';
      }
    }
    return result;
  });

  ipcMain.handle('shell:openPrivacyPane', async (_e, pane: 'files' | 'fullDisk' = 'files') => {
    if (process.platform !== 'darwin') return;
    // System Settings (macOS Ventura 13+) silently ignores the legacy
    // ?Privacy_FilesAndFolders fragment and lands on General. The most
    // reliable target is the Privacy & Security pane itself; from there
    // the user clicks "Files and Folders" or "Full Disk Access" — both
    // listed in the same column, one tap away. Using `osascript` to
    // navigate the sub-pane is brittle across macOS versions, so we
    // settle for a one-extra-click experience that always works.
    void pane; // accepted for future direct-deep-linking; currently both go to top of Privacy
    await shell.openExternal('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension');
  });

  ipcMain.handle('shell:open', async (_e, p: string) => {
    return shell.openPath(expandHome(p));
  });

  ipcMain.handle('shell:openWith', (_e, p: string, appName: string) => {
    return openWithApp(appName, expandHome(p));
  });

  // Resolve the bundled `sharer` Swift helper. In a packaged Electron app
  // `extraResources` lands under `process.resourcesPath`; in dev we run
  // straight from the repo. Returns null if the binary doesn't exist (e.g.
  // developer hasn't run `make -C native/sharer` yet) so the renderer can
  // disable the Share verb with a clear reason.
  function sharerPath(): string | null {
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'sharer')]
      : [
          path.join(app.getAppPath(), 'native', 'sharer', 'sharer'),
          path.join(process.cwd(), 'native', 'sharer', 'sharer'),
        ];
    for (const c of candidates) {
      try {
        if (existsSync(c)) return c;
      } catch {
        /* next */
      }
    }
    return null;
  }

  ipcMain.handle('shell:shareHelperAvailable', () => {
    if (process.platform !== 'darwin') return false;
    return sharerPath() !== null;
  });

  // shell:share — invoke the macOS native share sheet (NSSharingServicePicker)
  // anchored at a screen rect the renderer computed from the originating DOM
  // element. Spawns detached so the picker's lifetime isn't tied to this
  // IPC call (which returns as soon as the helper is launched).
  //
  // Design note: AirDrop + third-party share extensions are only reachable
  // via the native picker — AppleScript can only hit Mail/Messages/Notes.
  // That's why we ship a tiny Swift helper rather than shelling out to osa.
  ipcMain.handle(
    'shell:share',
    async (
      _e,
      opts: { paths: string[]; anchor: { x: number; y: number; w: number; h: number } },
    ) => {
      const bin = sharerPath();
      if (!bin) {
        const err = new Error('Native share helper not found. Run `make -C native/sharer`.');
        (err as Error & { helperMissing?: boolean }).helperMissing = true;
        throw err;
      }
      const { x, y, w, h } = opts.anchor;
      const paths = (opts.paths ?? []).map(expandHome);
      if (paths.length === 0) throw new Error('share: no paths');
      const args = [String(Math.round(x)), String(Math.round(y)), String(Math.round(w)), String(Math.round(h)), ...paths];
      await new Promise<void>((resolve, reject) => {
        const child = execFile(bin, args, { shell: false }, (err) => {
          // execFile's callback fires on exit. We still resolve promptly
          // below via 'spawn' so the renderer isn't blocked on user choice;
          // this callback just swallows errors after the picker closes.
          if (err && !child.killed) {
            // Non-zero exit after resolve — ignore.
          }
        });
        child.on('error', reject);
        child.on('spawn', () => {
          // Detach so quitting the main app doesn't close the picker.
          child.unref();
          resolve();
        });
      });
    },
  );

  ipcMain.handle('shell:clipboardWrite', (_e, p: string) => {
    // Writes a file reference to clipboard (macOS NSPasteboard file URL)
    clipboard.write({ text: expandHome(p) });
  });

  ipcMain.handle('thumb:get', async (_e, p: string, size: number) => {
    return thumbnailFor(expandHome(p), size);
  });

  // Read a text-like file for the preview pane. Caps at `maxBytes` (default
  // 40 KB) to avoid stalling the UI on huge logs / JSON blobs. Returns the
  // decoded utf8 content plus flags so the renderer can show a "truncated"
  // hint. Errors (binary, unreadable) surface as { content: '', error }.
  ipcMain.handle(
    'fs:readTextFile',
    async (
      _e,
      p: string,
      maxBytes = 40 * 1024,
    ): Promise<{ content: string; truncated: boolean; bytes: number; error?: string }> => {
      const abs = expandHome(p);
      let fh: import('node:fs/promises').FileHandle | null = null;
      try {
        const st = await fs.stat(abs);
        fh = await fs.open(abs, 'r');
        const cap = Math.min(st.size, maxBytes);
        const buf = Buffer.alloc(cap);
        const { bytesRead } = await fh.read(buf, 0, cap, 0);
        const slice = buf.subarray(0, bytesRead);
        const content = slice.toString('utf8');
        return {
          content,
          truncated: st.size > maxBytes,
          bytes: st.size,
        };
      } catch (err) {
        return {
          content: '',
          truncated: false,
          bytes: 0,
          error: (err as Error).message,
        };
      } finally {
        await fh?.close().catch(() => {});
      }
    },
  );

  // fm-vu55 — load a text file in full for the in-app editor. Unlike the
  // preview's readTextFile, this is uncapped (the editor needs to round-
  // trip the entire file). Returns content + mtime so the renderer can
  // detect external edits at save time.
  ipcMain.handle(
    'editor:openFile',
    async (
      _e,
      p: string,
    ): Promise<{ content: string; mtimeMs: number; error?: string }> => {
      const abs = expandHome(p);
      try {
        const st = await fs.stat(abs);
        const content = await fs.readFile(abs, 'utf8');
        return { content, mtimeMs: st.mtimeMs };
      } catch (err) {
        return { content: '', mtimeMs: 0, error: (err as Error).message };
      }
    },
  );

  // Atomic save via tmp-file + rename in the same directory. The
  // expectedMtimeMs guard rejects writes when the file changed on disk
  // since open (renderer surfaces "file was modified externally").
  ipcMain.handle(
    'editor:saveFile',
    async (
      _e,
      p: string,
      content: string,
      expectedMtimeMs: number | null,
    ): Promise<{ mtimeMs: number; conflict?: boolean; error?: string }> => {
      const abs = expandHome(p);
      try {
        if (expectedMtimeMs != null) {
          try {
            const st = await fs.stat(abs);
            // Tolerate ms-level rounding differences across filesystems.
            if (Math.abs(st.mtimeMs - expectedMtimeMs) > 1) {
              return { mtimeMs: st.mtimeMs, conflict: true };
            }
          } catch {
            // File missing — treat as a fresh write, no conflict.
          }
        }
        const dir = path.dirname(abs);
        const tmp = path.join(dir, `.${path.basename(abs)}.tmp-${process.pid}-${Date.now()}`);
        await fs.writeFile(tmp, content, 'utf8');
        await fs.rename(tmp, abs);
        const st = await fs.stat(abs);
        return { mtimeMs: st.mtimeMs };
      } catch (err) {
        return { mtimeMs: 0, error: (err as Error).message };
      }
    },
  );

  // fm-mdwatch — watch an open editor file for external changes (e.g. an
  // agent editing it from the chat panel). We watch the *parent directory*
  // rather than the file itself: atomic saves (tmp-file + rename, used by
  // this editor and by Claude Code) replace the inode, which silently kills
  // a watch bound to the old file. A directory watch survives that and we
  // filter by basename. Keyed by senderId+path so each editor tab owns its
  // own watcher and re-watching the same file is idempotent.
  const editorWatchers = new Map<
    string,
    { w: FSWatcher; timer: NodeJS.Timeout | null; senderId: number }
  >();
  const watchKey = (senderId: number, abs: string) => `${senderId} ${abs}`;

  const stopEditorWatch = (key: string) => {
    const rec = editorWatchers.get(key);
    if (!rec) return;
    if (rec.timer) clearTimeout(rec.timer);
    try { rec.w.close(); } catch { /* noop */ }
    editorWatchers.delete(key);
  };

  // One shared 'destroyed' listener per WebContents reaps all of that
  // sender's file watchers — attaching one per watch would trip Node's
  // MaxListeners warning (same lesson as ensurePtyDestroyHook below).
  const editorWatchHooked = new WeakSet<Electron.WebContents>();
  const ensureEditorWatchDestroyHook = (wc: Electron.WebContents) => {
    if (editorWatchHooked.has(wc)) return;
    editorWatchHooked.add(wc);
    wc.once('destroyed', () => {
      for (const [key, rec] of editorWatchers) {
        if (rec.senderId === wc.id) stopEditorWatch(key);
      }
    });
  };

  ipcMain.handle('editor:watch', async (e, p: string): Promise<void> => {
    const abs = expandHome(p);
    const key = watchKey(e.sender.id, abs);
    if (editorWatchers.has(key)) return;
    const dir = path.dirname(abs);
    const base = path.basename(abs);
    let watcher: FSWatcher;
    try {
      watcher = fsWatch(dir, { persistent: false }, (_event, filename) => {
        // filename can be null on some platforms; if present, filter to ours.
        if (filename && path.basename(filename.toString()) !== base) return;
        const rec = editorWatchers.get(key);
        if (!rec) return;
        // Debounce: a single save can emit rename+change in quick succession.
        if (rec.timer) clearTimeout(rec.timer);
        rec.timer = setTimeout(() => {
          rec.timer = null;
          void fs.stat(abs).then(
            (st) => {
              const wc = webContents.fromId(e.sender.id);
              if (wc && !wc.isDestroyed()) {
                wc.send('editor:fileChanged', { path: p, mtimeMs: st.mtimeMs });
              }
            },
            () => {
              // File vanished (mid-rename or deleted) — notify with mtime 0.
              const wc = webContents.fromId(e.sender.id);
              if (wc && !wc.isDestroyed()) {
                wc.send('editor:fileChanged', { path: p, mtimeMs: 0 });
              }
            },
          );
        }, 120);
      });
    } catch {
      return; // directory unwatchable — silently degrade (no live refresh)
    }
    editorWatchers.set(key, { w: watcher, timer: null, senderId: e.sender.id });
    // Reap the watcher if the renderer goes away.
    ensureEditorWatchDestroyHook(e.sender);
  });

  ipcMain.handle('editor:unwatch', async (e, p: string): Promise<void> => {
    stopEditorWatch(watchKey(e.sender.id, expandHome(p)));
  });

  ipcMain.handle('editor:bulkRename', async (_e, names: string[]) => {
    const tmp = path.join(os.tmpdir(), `fm-rename-${Date.now()}.txt`);
    await fs.writeFile(tmp, names.join('\n') + '\n', 'utf8');
    // $EDITOR if set; else the platform's always-present console/GUI editor.
    const editor =
      process.env.EDITOR ||
      (process.platform === 'win32' ? 'notepad.exe' : 'vi');
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(editor, [tmp], { stdio: 'inherit' });
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`editor exited ${code}`))));
    });
    const content = await fs.readFile(tmp, 'utf8');
    await fs.unlink(tmp).catch(() => {});
    return content.split('\n').filter((l) => l.length > 0);
  });

  // Tiny 1×1 transparent PNG. startDrag requires a non-empty icon and must
  // run synchronously in the user-gesture tick — an await or an invalid
  // SVG-derived image will silently abort (or crash) the drag.
  const TINY_ICON = nativeImage.createFromBuffer(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );

  // Folder search via macOS Spotlight. Returns absolute paths of folders
  // whose name matches the query, capped for speed. On non-darwin, falls
  // back to an empty list — renderer will only use curated/recents there.
  //
  // `mdfind` honors Spotlight's own index; we don't maintain anything.
  // We filter out well-known noise paths client-side (node_modules, .git,
  // build outputs, package caches, Library/Caches, etc.) because Spotlight
  // indexes these by default.
  const FOLDER_EXCLUDE_SEGMENTS = new Set([
    'node_modules', '.git', '.svn', '.hg',
    'build', 'dist', 'out', '.next', '.nuxt', 'target',
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
    '.venv', 'venv', 'env', '.env',
    '.cache', '.Trash',
    '.npm', '.yarn', '.pnpm-store', '.cargo', '.rustup', '.pyenv', '.rbenv',
    '.gradle', '.m2', '.nvm', '.cocoapods',
    'DerivedData', 'CrashReporter',
  ]);
  const FOLDER_EXCLUDE_SUBSTRINGS = [
    '/Library/Caches/',
    '/Library/Application Support/CrashReporter/',
    '/Library/Developer/Xcode/DerivedData/',
    '/Library/Metadata/',
    '/Library/Mobile Documents/com~apple~',
  ];
  function isNoisePath(p: string): boolean {
    for (const sub of FOLDER_EXCLUDE_SUBSTRINGS) {
      if (p.includes(sub)) return true;
    }
    // Split on both separators so Windows backslash paths segment correctly.
    const parts = p.split(/[/\\]/);
    for (const part of parts) {
      if (FOLDER_EXCLUDE_SEGMENTS.has(part)) return true;
    }
    return false;
  }

  ipcMain.handle('search:folders', async (_e, query: string, limit = 40): Promise<string[]> => {
    const q = query.trim();
    if (q.length === 0) return [];
    // Tokens are whitespace-separated and AND-ed — "webinar folder" matches
    // "Webinar data shared folder". Platform adapter picks an index strategy
    // (Spotlight on Mac, BFS on Linux); we filter platform-specific noise
    // paths (Library caches, node_modules, etc.) consistently here.
    const tokens = q.split(/\s+/).filter((t) => t.length > 0);
    const raw = await platform().searchFolders(tokens, limit * 2);
    const filtered: string[] = [];
    for (const line of raw) {
      if (isNoisePath(line)) continue;
      filtered.push(line);
      if (filtered.length >= limit) break;
    }
    return filtered;
  });

  // Recursive BFS subdir walker for the chip prompt's `goto` slot. Returns
  // absolute paths of subdirectories under `cwd`, level-by-level. Skips
  // dotfiles and the usual heavyweight names so a `goto` query in ~ doesn't
  // wander into node_modules / Library and stall the UI. Each level is
  // batched with Promise.all so wide trees don't serialize.
  const SUBDIR_SKIP = new Set([
    'node_modules', '.git', '.svn', '.hg', '__pycache__',
    '.pytest_cache', '.mypy_cache', '.ruff_cache',
    '.venv', 'venv', '.cache', '.Trash', 'Library',
    'DerivedData', '.next', '.nuxt', 'target', 'dist', 'build',
    '.npm', '.yarn', '.pnpm-store', '.cargo', '.rustup',
  ]);

  ipcMain.handle(
    'fs:listSubdirs',
    async (_e, cwd: string, depth = 3, limit = 120): Promise<string[]> => {
      const root = expandHome(cwd);
      const out: string[] = [];
      let frontier: string[] = [root];
      for (let level = 0; level < depth && frontier.length > 0 && out.length < limit; level++) {
        const results = await Promise.all(
          frontier.map(async (dir) => {
            try {
              const ents = await fs.readdir(dir, { withFileTypes: true });
              const subs: string[] = [];
              for (const ent of ents) {
                if (!ent.isDirectory()) continue;
                if (ent.name.startsWith('.')) continue;
                if (SUBDIR_SKIP.has(ent.name)) continue;
                subs.push(path.join(dir, ent.name));
              }
              return subs;
            } catch {
              return [];
            }
          }),
        );
        const next: string[] = [];
        outer: for (const subs of results) {
          for (const s of subs) {
            if (out.length >= limit) break outer;
            out.push(s);
            next.push(s);
          }
        }
        frontier = next;
      }
      return out;
    },
  );

  // Recursive entry search for the Find overlay (fm-8wf). Walks the given
  // root(s) BFS, capping depth + count, then broadens via Spotlight under
  // $HOME for hits outside the local subtree. Returns files AND folders,
  // tagged so the renderer can label results "in this folder" / "subfolder"
  // / "elsewhere". Substring match is on basename only (case-insensitive)
  // to avoid noisy path-segment matches.
  const FIND_SKIP = new Set([
    '.git', 'node_modules', '__pycache__', '.Trash', 'Library',
    'dist', 'build', 'target', '.next', '.cache', '.venv', 'venv',
    '.pytest_cache', '.mypy_cache', '.ruff_cache', '.svn', '.hg',
    '.npm', '.yarn', '.pnpm-store', '.cargo', '.rustup', 'DerivedData',
  ]);

  // `tier: 'spotlight'` historically meant Mac Spotlight; it now means "found
  // via the platform's broaden step" (Spotlight on Mac, BFS-under-$HOME on
  // Linux). Wire name is preserved so renderer labels don't churn.
  type FindHit = { path: string; name: string; isDir: boolean; tier: 'local' | 'spotlight' };

  ipcMain.handle(
    'fs:findEntries',
    async (_e, roots: string[], query: string, limit = 60): Promise<FindHit[]> => {
      const q = query.trim().toLowerCase();
      if (q.length === 0) return [];
      const out: FindHit[] = [];
      const seen = new Set<string>();

      // Tokenize the query. We match per-token (all tokens must appear in the
      // name) rather than as one literal substring — otherwise a typed query
      // like "publish and" misses files named "publish-and-perish.md" because
      // the hyphen is not a space. Short tokens (≤3 chars like "and", "of")
      // require a word-boundary match — anything separating word-parts in a
      // filename (`-`, `_`, `.`, ` `) — so they don't false-positive inside
      // longer words (e.g. "and" inside "androidpublisher"). Treats CamelCase
      // boundaries too: an uppercase letter following a lowercase one counts
      // as a boundary.
      const tokens = q.split(/\s+/).filter((t) => t.length > 0);
      const matchesName = (lname: string, oname: string): boolean => {
        for (const t of tokens) {
          if (t.length <= 3) {
            // Word-boundary: token surrounded by non-alphanumerics, OR at
            // start/end, OR preceded/followed by a CamelCase transition.
            const idx = (() => {
              let from = 0;
              while (from <= lname.length - t.length) {
                const i = lname.indexOf(t, from);
                if (i < 0) return -1;
                const before = i === 0 ? '' : lname[i - 1];
                const after = i + t.length >= lname.length ? '' : lname[i + t.length];
                const isWordChar = (ch: string) => /[a-z0-9]/.test(ch);
                const beforeOk = !before || !isWordChar(before)
                  || (oname[i - 1] && oname[i] && oname[i - 1] === oname[i - 1].toLowerCase() && oname[i] !== oname[i].toLowerCase());
                const afterOk = !after || !isWordChar(after)
                  || (oname[i + t.length - 1] && oname[i + t.length] && oname[i + t.length - 1] === oname[i + t.length - 1].toLowerCase() && oname[i + t.length] !== oname[i + t.length].toLowerCase());
                if (beforeOk && afterOk) return i;
                from = i + 1;
              }
              return -1;
            })();
            if (idx < 0) return false;
          } else {
            if (!lname.includes(t)) return false;
          }
        }
        return true;
      };

      // Local BFS — depth ≤ 6, count cap = limit. Skip dotfiles & heavyweights.
      const MAX_DEPTH = 6;
      for (const root of roots) {
        const abs = expandHome(root);
        let frontier: string[] = [abs];
        for (let level = 0; level <= MAX_DEPTH && frontier.length > 0 && out.length < limit; level++) {
          const results = await Promise.all(
            frontier.map(async (dir) => {
              try {
                const ents = await fs.readdir(dir, { withFileTypes: true });
                const subdirs: string[] = [];
                const hits: FindHit[] = [];
                for (const ent of ents) {
                  if (FIND_SKIP.has(ent.name)) continue;
                  const full = path.join(dir, ent.name);
                  const isDir = ent.isDirectory();
                  const isDot = ent.name.startsWith('.');
                  if (matchesName(ent.name.toLowerCase(), ent.name)) {
                    hits.push({ path: full, name: ent.name, isDir, tier: 'local' });
                  }
                  // Don't recurse into dot-directories — they're typically
                  // heavyweight caches not covered by FIND_SKIP. The dot-dir
                  // itself can still match by name.
                  if (isDir && !isDot) subdirs.push(full);
                }
                return { hits, subdirs };
              } catch {
                return { hits: [] as FindHit[], subdirs: [] as string[] };
              }
            }),
          );
          const next: string[] = [];
          outer: for (const r of results) {
            for (const h of r.hits) {
              if (seen.has(h.path)) continue;
              seen.add(h.path);
              out.push(h);
              if (out.length >= limit) break outer;
            }
            for (const s of r.subdirs) next.push(s);
          }
          frontier = next;
        }
        if (out.length >= limit) break;
      }

      // Broaden via the platform's index (Spotlight on Mac, BFS on Linux).
      // Both honor $HOME scope. Mac's adapter returns mdfind hits, which is
      // an instant superset; Linux's adapter walks $HOME synchronously and
      // is bounded by depth + count.
      if (out.length < limit) {
        const spotHits = await platform().searchByIndex(tokens, limit);
        for (const p of spotHits) {
          if (out.length >= limit) break;
          if (seen.has(p)) continue;
          // Filter out heavyweight noise paths. Split on both separators so
          // Windows backslash paths segment correctly.
          const parts = p.split(/[/\\]/);
          let skip = false;
          for (const part of parts) {
            if (FIND_SKIP.has(part)) { skip = true; break; }
          }
          if (skip) continue;
          const name = path.basename(p);
          // Apply the same per-token + word-boundary filter as the local BFS:
          // mdfind matches against extended metadata, so a name-only check
          // here keeps results focused on the filename the user typed.
          if (!matchesName(name.toLowerCase(), name)) continue;
          let isDir = false;
          try {
            const st = await fs.lstat(p);
            isDir = st.isDirectory();
          } catch {
            continue;
          }
          seen.add(p);
          out.push({ path: p, name, isDir, tier: 'spotlight' });
        }
      }

      return out;
    },
  );

  ipcMain.on('drag:start', (e, paths: string[]) => {
    if (paths.length === 0) return;
    try {
      const abs = paths.map(expandHome);
      e.sender.startDrag({ files: abs, icon: TINY_ICON } as unknown as Electron.Item);
    } catch {
      // Don't let a failed drag kill the main process.
    }
  });

  // app:checkUpdate — fetch the latest release from GitHub and return the
  // tag/version + release URL + body. Done in main (not renderer) so the
  // renderer's strict CSP doesn't have to whitelist external origins.
  // Returns null on any failure (offline, rate-limited, repo missing) so
  // the caller can fail silently and try again later.
  // app:upgrade — run `brew upgrade --cask breezefile` on the user's behalf.
  // brew needs the running .app bundle out of the way before it can replace
  // it, so we spawn the upgrade detached (with a self-relaunch at the end)
  // and then quit. If brew isn't at a known path, fall back to Terminal.app
  // where the user's login shell will resolve brew from their PATH.
  ipcMain.handle('app:upgrade', async () => {
    // Homebrew-cask self-upgrade is macOS-only. On Windows/Linux the app is
    // installed from a downloaded artifact (NSIS / AppImage), so the right
    // action is to open the latest GitHub release for a manual reinstall.
    if (process.platform !== 'darwin') {
      await shell.openExternal('https://github.com/vivekdse/breezefile/releases/latest');
      return { ok: true, mode: 'browser' } as const;
    }
    const brewPaths = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
    const brew = brewPaths.find((p) => existsSync(p)) ?? null;
    const appName = 'Breeze File';
    // `|| open -a` so we relaunch even if brew says "already up to date".
    const cmd = brew
      ? `${brew} upgrade --cask breezefile; open -a ${JSON.stringify(appName)}`
      : null;

    try {
      if (cmd) {
        spawn('/bin/bash', ['-lc', cmd], {
          stdio: 'ignore',
          detached: true,
        }).unref();
      } else {
        // Terminal fallback: user sees progress and can type sudo password.
        const script = `tell application "Terminal"
  activate
  do script "brew upgrade --cask breezefile && open -a ${appName}"
end tell`;
        spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref();
      }
    } catch {
      return { ok: false, mode: brew ? 'inline' : 'terminal' } as const;
    }

    // Give the spawned shell a beat to start before we quit, so brew can
    // see the running .app exit cleanly rather than racing our teardown.
    setTimeout(() => app.quit(), 600);
    return { ok: true, mode: brew ? 'inline' : 'terminal' } as const;
  });

  ipcMain.handle('app:checkUpdate', async () => {
    try {
      const res = await fetch(
        'https://api.github.com/repos/vivekdse/breezefile/releases/latest',
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Breeze-File-update-check',
          },
          // 5s timeout via AbortController so a slow network doesn't
          // hang the IPC.
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!res.ok) return null;
      const json = (await res.json()) as {
        tag_name?: string;
        html_url?: string;
        body?: string;
        published_at?: string;
      };
      if (!json.tag_name || !json.html_url) return null;
      return {
        tag: json.tag_name,                       // "v0.1.2"
        version: json.tag_name.replace(/^v/, ''), // "0.1.2"
        url: json.html_url,
        body: json.body ?? '',
        publishedAt: json.published_at ?? null,
      };
    } catch {
      return null;
    }
  });

  // ─── Embedded PTY (fm-jtu) ───────────────────────────────────────────
  // High-frequency channels (write, resize, data) use ipcRenderer.send /
  // webContents.send so we never queue a Promise per keystroke. spawn,
  // status, kill go through invoke because the caller wants a result. The
  // PTY registry + spawn core (PtyRecord, ptys, nextPtyId, ptyEnv,
  // spawnManagedPty, reservePtyId) live at module scope so task runs can
  // spawn into the same registry.
  //
  // One 'destroyed' listener per WebContents — earlier code attached one per
  // PTY spawn, which tripped Node's MaxListeners warning after ~10 terminals.
  const ptyDestroyHooked = new WeakSet<Electron.WebContents>();
  function ensurePtyDestroyHook(wc: Electron.WebContents) {
    if (ptyDestroyHooked.has(wc)) return;
    ptyDestroyHooked.add(wc);
    wc.once('destroyed', () => {
      for (const [id, r] of ptys) {
        if (r.senderId !== wc.id) continue;
        try { r.proc.kill(); } catch { /* noop */ }
        ptys.delete(id);
      }
    });
  }

  function defaultShell(): { file: string; args: string[] } {
    if (process.platform === 'win32') {
      return { file: process.env.COMSPEC || 'cmd.exe', args: [] };
    }
    const file = process.env.SHELL || '/bin/zsh';
    // -l so the user's profile loads (PATH from .zshrc/.bash_profile).
    return { file, args: ['-l'] };
  }

  ipcMain.handle('remote:list-targets', () =>
    listRemoteTargets().catch(() => [] as string[]),
  );

  ipcMain.handle(
    'term:spawn',
    async (
      e,
      opts: {
        cwd: string;
        cols?: number;
        rows?: number;
        shell?: string;
        args?: string[];
        env?: Record<string, string>;
        remoteAttach?: { target: string; ttlSec?: number };
      },
    ): Promise<number> => {
      const cwd = expandHome(opts.cwd);
      const def = defaultShell();
      let file = opts.shell ?? def.file;
      let args = opts.args ?? def.args;
      let spawnCwd = cwd;
      const cols = Math.max(2, Math.min(opts.cols ?? 80, 1000));
      const rows = Math.max(2, Math.min(opts.rows ?? 24, 1000));
      const id = reservePtyId();

      // ── remote-attach verb ──────────────────────────────────────────
      // Explicit target (not inferred from an sshfs cwd): open a login
      // shell on <target> with a session-scoped breeze CLI reachable over
      // a reverse-ssh tunnel. The session token is minted in-process and
      // revoked when this pty exits, so detached/cron processes on the
      // remote can never reach the task API.
      let attachSid: string | undefined;
      let remoteTarget: string | undefined;
      if (opts.remoteAttach?.target) {
        const target = opts.remoteAttach.target;
        remoteTarget = target;
        const api = readLocalApi();
        if (!api) throw new Error('Breeze API not ready — cannot remote-attach');
        const remotePort = pickRemotePort(api.port);
        await ensureRemoteHooks(target).catch(() => false);
        const ttlSec = Math.min(opts.remoteAttach.ttlSec ?? 8 * 3600, 24 * 3600);
        const sess = mintSessionToken(`remote-attach ${target}`, ttlSec);
        attachSid = sess.sid;
        const envPrefix = [
          `BREEZE_PTY_ID=${id}`,
          `BREEZE_REMOTE_MODE=1`,
          `BREEZE_REMOTE_HOST=${shQuote(target)}`,
          `BREEZE_API_HOST=127.0.0.1`,
          `BREEZE_API_PORT=${remotePort}`,
          `BREEZE_API_TOKEN=${shQuote(sess.token)}`,
          `PATH="$HOME/.breezefile:$PATH"`,
        ].join(' ');
        file = 'ssh';
        args = [
          '-t',
          // NOTE: do NOT add ClearAllForwardings=yes here — OpenSSH
          // clears command-line forwardings too, which kills this -R
          // tunnel. Config-file LocalForward noise is cosmetic; a dead
          // tunnel is fatal (breeze on the remote can't reach the API).
          '-R',
          `${remotePort}:127.0.0.1:${api.port}`,
          target,
          `${envPrefix} exec $SHELL -l`,
        ];
        spawnCwd = os.homedir();
      }

      // Remote routing: if cwd lives under an sshfs/macFUSE mount, swap the
      // local shell for `ssh -t <target> …` so the PTY runs on the remote
      // host. Translators run on the local mountpoint → remote root.
      // Failures here just log; spawn falls through to the local shell.
      const remote = opts.remoteAttach
        ? null
        : await resolveRemote(cwd).catch(() => null);
      if (remote) {
        remoteTarget = remote.target;
        // Pull api.json so we can plumb the port+token into the remote
        // hook via env + reverse-ssh tunnel. If api-server isn't ready,
        // we still open the shell — the hook just won't report status.
        const api = readLocalApi();
        const remotePort = api ? pickRemotePort(api.port) : null;
        // Ensure-install the hook on the remote (cached by content hash).
        // Fire-and-forget on failure — never block the user's terminal.
        if (api) {
          ensureRemoteHooks(remote.target).catch(() => false);
        }

        // Env to inject on the remote side. The hook script picks these
        // up; api.json doesn't exist on the remote so env is mandatory.
        const envParts: string[] = [`BREEZE_PTY_ID=${id}`];
        if (api && remotePort != null) {
          envParts.push(`BREEZE_API_HOST=127.0.0.1`);
          envParts.push(`BREEZE_API_PORT=${remotePort}`);
          envParts.push(`BREEZE_API_TOKEN=${shQuote(api.token)}`);
        }
        const envPrefix = envParts.join(' ');

        // Build the remote command. Preserve caller intent (tmux vs
        // login shell). For tmux, the local args have the *local* cwd in
        // `-c`; swap to the remote cwd.
        let inner: string;
        if (file === 'tmux') {
          const remoteArgs = args
            .map((a) => (a === cwd ? remote.remoteCwd : a))
            .map(shQuote)
            .join(' ');
          inner = `${envPrefix} tmux ${remoteArgs}`;
        } else {
          // shQuote the *whole* sh -c payload — naively wrapping in literal
          // single quotes breaks when remoteCwd itself contains a space,
          // because shQuote(remoteCwd) injects its own single quotes and
          // closes the outer quote prematurely.
          inner = `${envPrefix} sh -c ${shQuote(`cd ${shQuote(remote.remoteCwd)} && exec $SHELL -l`)}`;
        }

        const sshArgs = ['-t'];
        if (api && remotePort != null) {
          // -R: reverse-tunnel remote:remotePort → local 127.0.0.1:apiPort.
          // ExitOnForwardFailure=no (default) lets the 2nd+ concurrent
          // ssh to the same host share the existing tunnel silently.
          sshArgs.push('-R', `${remotePort}:127.0.0.1:${api.port}`);
        }
        sshArgs.push(remote.target, inner);

        file = 'ssh';
        args = sshArgs;
        // Local cwd is irrelevant once we ssh out; use $HOME so node-pty
        // doesn't fail if the mountpoint is momentarily unreachable.
        spawnCwd = os.homedir();
      }
      // BREEZE_PTY_ID lets Claude Code hooks (fm-z7v) tell us which tab
      // a UserPromptSubmit/Stop event belongs to. Set before spawn so it
      // propagates into the shell and any child it execs. The PTY core
      // (spawnManagedPty) sets BREEZE_PTY_ID itself from the reserved id.
      const senderId = e.sender.id;
      spawnManagedPty({
        id,
        file,
        args,
        cwd: spawnCwd,
        cols,
        rows,
        senderId,
        env: {
          ...opts.env,
          ...(remoteTarget ? { BREEZE_REMOTE_TARGET: remoteTarget } : {}),
        },
        onExit: () => {
          if (attachSid) revokeSessionToken(attachSid);
        },
      });
      // Kill orphan PTYs if the renderer process goes away (window reload,
      // crash). One shared 'destroyed' listener per WebContents reaps all
      // PTYs it owns; proc.onExit then revokes any attach token.
      ensurePtyDestroyHook(e.sender);
      return id;
    },
  );

  ipcMain.on('term:write', (_e, id: number, data: string) => {
    const r = ptys.get(id);
    if (!r) return;
    try { r.proc.write(data); } catch { /* pty may have just exited */ }
  });

  ipcMain.on('term:resize', (_e, id: number, cols: number, rows: number) => {
    const r = ptys.get(id);
    if (!r) return;
    try {
      r.proc.resize(Math.max(2, cols), Math.max(2, rows));
    } catch { /* noop */ }
  });

  ipcMain.handle('term:status', async (_e, id: number) => {
    const r = ptys.get(id);
    if (!r) return { alive: false, pid: null };
    return { alive: true, pid: r.proc.pid };
  });

  ipcMain.handle('term:kill', async (_e, id: number, signal?: string) => {
    const r = ptys.get(id);
    if (!r) return;
    try { r.proc.kill(signal); } catch { /* noop */ }
    ptys.delete(id);
  });

  // ─── SPIKE (spike/playwright-cdp): embedded browser views, one per
  // 'browser'-kind tab. A WebContentsView is an OS-level overlay parented to
  // the window's contentView — it floats ABOVE the React DOM, so the renderer
  // can't position or clip it. The BrowserSurface component measures its
  // placeholder div and streams bounds here via 'browser:bounds'; we mirror
  // the view onto that rect and toggle visibility on tab switch. Each view is
  // a real Chromium webContents, so Playwright drives it over CDP (port 9222).
  //
  // The view registry + lifecycle live in electron/browser/views.ts so the
  // SAME backend drives both the in-app tab here AND the operator window's left
  // pane (electron/browser/window.ts). These handlers are thin delegations.

  ipcMain.handle('browser:attach', (e, opts: { url?: string }): number => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return -1;
    // In-app tab: it collapses every other panel, so the view runs to the window
    // edges ('edge'). The operator pane uses 'rect' (it stops at the divider).
    return createBrowserView(win, { url: opts?.url, fill: 'edge' });
  });

  ipcMain.on(
    'browser:bounds',
    (
      _e,
      id: number,
      rect: {
        x: number;
        y: number;
        width: number;
        height: number;
        winW: number;
        winH: number;
      },
    ) => setBrowserViewBounds(id, rect),
  );

  // Re-broadcast a view's current url/title/nav on demand. The renderer calls
  // this when a BrowserSurface (re)mounts so its address bar reflects where the
  // view actually IS — it may have navigated while the tab was inactive (and
  // thus had no live state listener).
  ipcMain.on('browser:sync', (_e, id: number) => reBroadcastState(id));

  ipcMain.on('browser:hide', (_e, id: number) => hideBrowserView(id));

  ipcMain.handle('browser:destroy', (_e, id: number) => destroyBrowserView(id));

  ipcMain.on('browser:navigate', (_e, id: number, url: string) => {
    void getBrowserView(id)?.webContents.loadURL(url);
  });
  ipcMain.on('browser:back', (_e, id: number) => {
    const h = getBrowserView(id)?.webContents.navigationHistory;
    if (h?.canGoBack()) h.goBack();
  });
  ipcMain.on('browser:forward', (_e, id: number) => {
    const h = getBrowserView(id)?.webContents.navigationHistory;
    if (h?.canGoForward()) h.goForward();
  });
  ipcMain.on('browser:reload', (_e, id: number) => {
    getBrowserView(id)?.webContents.reload();
  });

  // Address-bar autocomplete (task-ff707aea93d8). Ranked suggestions from
  // visited-URL history + a small known-host seed, computed in main. Shared by
  // both surfaces (in-app tab + operator pane) since BrowserSurface is the one
  // address bar. NON-PHI: returns plain URLs/titles only.
  ipcMain.handle(
    'browser:suggest',
    (_e, query: string): Promise<Suggestion[]> => suggestUrls(query),
  );

  // ─── Teach-by-recording (task-01facbf6b0bc) ───────────────────────────────
  // Record the HUMAN's actions in an embedded browser view + capture every
  // selector candidate, so Claude Code can pick the most stable one and save it
  // as a shared NON-PHI skill. The agent's Playwright session must be released
  // first (CDP is single-client — see connect.mjs releaseForRecording).
  ipcMain.handle('browser:record:start', (_e, id: number) => {
    const view = getBrowserView(id);
    if (!view) return { ok: false, error: 'no such browser view' };
    return startBrowserRecording(view.webContents);
  });
  ipcMain.handle('browser:record:stop', (_e, opts?: { skillName?: string }) =>
    stopBrowserRecording(opts || {}),
  );
  ipcMain.handle('browser:record:state', () => currentBrowserRecording());

  // Full-page screenshot → PDF: auto-scroll the view, screenshot each
  // viewport, assemble into one PDF (electron/browser/screenshot-pdf.ts).
  ipcMain.handle(
    'browser:screenshot-pdf',
    (_e, id: number, opts?: { outPath?: string }) => {
      const view = getBrowserView(id);
      if (!view) return { ok: false, error: 'no such browser view' };
      return capturePagePdf(view, opts || {});
    },
  );

  // Return-visit autofill (task-4b786c018d78). Resolve the SAVED password for
  // (origin, username) in MAIN and type it into the page's login form over the
  // trusted hop — the value is NEVER returned to the renderer/agent. Returns a
  // value-free FillResult ('filled' | 'no-form' | 'error' | 'no-credential').
  ipcMain.handle(
    'browser:autofill',
    async (
      _e,
      id: number,
      origin: string,
      username: string,
    ): Promise<'filled' | 'no-form' | 'error' | 'no-credential'> => {
      const view = getBrowserView(id);
      if (!view) return 'error';
      const { resolveSiteCredential } = await import('./typebuild/site-credentials');
      const { fillCredentialIntoPage } = await import('./browser/credential-fill');
      let password: string;
      try {
        password = await resolveSiteCredential(origin, username);
      } catch {
        // 404 / not signed in / transport — value-free, never logged.
        return 'no-credential';
      }
      // The password lives only in this scope and the page DOM; never logged,
      // never sent back to the renderer.
      return fillCredentialIntoPage(view.webContents, username, password);
    },
  );

  // fm-z7v — busy/idle signal comes from Claude Code hooks
  // (UserPromptSubmit → busy, Stop/StopFailure → idle), routed through
  // the api-server and dispatched here as 'term:fg' keyed by ptyId.
  // The api-server calls dispatchTerminalFg() directly.
  registerFgDispatcher((id, state) => {
    const rec = ptys.get(id);
    if (!rec) return;
    // `busy` retained for legacy preload/renderer compat (pre-waiting). New
    // `state` carries the full tri-state so the renderer can branch on
    // 'waiting' without inferring from a bool. Fan out to the agent overlay
    // mirror too, so it can flag "Claude needs you".
    sendToPtyClients(id, rec.senderId, 'term:fg', {
      id,
      busy: state === 'busy',
      state,
      comm: null,
    });
  });

  // SPIKE (spike/playwright-cdp): the agent-overlay window registers/unregisters
  // as a mirror of a pty's term:* stream so it renders the same live terminal.
  ipcMain.on('term:mirror', (e, id: number) => {
    let set = ptyMirrors.get(id);
    if (!set) ptyMirrors.set(id, (set = new Set()));
    set.add(e.sender.id);
  });
  // Like term:mirror, but FIRST replays the pty's recent scrollback to the
  // subscriber (task-6b9b0032feda) so a pane that mounts/re-shows AFTER output
  // was emitted repaints immediately instead of staying blank until the next
  // chunk. The replay is sent only to the subscribing webContents (not fanned
  // out) so existing mirrors don't see duplicated output.
  ipcMain.on('term:mirror-with-replay', (e, id: number) => {
    let set = ptyMirrors.get(id);
    if (!set) ptyMirrors.set(id, (set = new Set()));
    set.add(e.sender.id);
    const buf = ptyReplay.get(id);
    if (buf && buf.chunks.length > 0 && !e.sender.isDestroyed()) {
      e.sender.send('term:data', { id, data: buf.chunks.join('') });
    }
  });
  ipcMain.on('term:unmirror', (e, id: number) => {
    ptyMirrors.get(id)?.delete(e.sender.id);
  });
  // SPIKE (spike/playwright-cdp): ADOPT a pty — retarget its OWNER to this
  // webContents so the operator window's terminal renders it DIRECTLY rather
  // than as a read-mirror of a main-window owner tab (which left two xterms
  // fighting over one pty's size). Output routing reads senderId fresh per
  // chunk (see spawnManagedPty.onData), so the retarget takes effect at once.
  // We also replay recent scrollback, since the pty was spawned (with a
  // placeholder owner) before this window mounted and that early output was
  // buffered, not rendered.
  ipcMain.on('term:adopt', (e, id: number) => {
    const rec = ptys.get(id);
    if (!rec) return;
    rec.senderId = e.sender.id;
    const buf = ptyReplay.get(id);
    if (buf && buf.chunks.length > 0 && !e.sender.isDestroyed()) {
      e.sender.send('term:data', { id, data: buf.chunks.join('') });
    }
  });

  // ─── Launchers (fm-g6r) ──────────────────────────────────────────────
  // User-editable JSON in userData/launchers.json. Each entry maps a verb
  // alias to a shell-resolvable command + args. The terminal verb consults
  // this list so :claude / :codex / :gemini open a PTY pre-running that
  // CLI. Defaults are seeded once on first read.
  type LauncherVariant = {
    id: string;
    label: string;
    args?: string[];
    description?: string;
  };
  type LauncherDef = {
    id: string;
    label: string;
    aliases: string[];
    command: string;
    args?: string[];
    description?: string;
    // fm-e66 — named flag combinations layered atop `args`.
    variants?: LauncherVariant[];
    // fm-dly3 — flag this agent uses to receive background context (folder /
    // document) as a system-prompt addendum, e.g. '--append-system-prompt'.
    // The chat panel passes context via this flag instead of typing it as a
    // first message. Launchers without it fall back to the typed preamble.
    contextFlag?: string;
    // fm-v3p — task-action-zone visibility overrides. The launcher DEFS stay
    // visibility-agnostic in userData/launchers.json; the actual show/hide +
    // default choice is a renderer-side pref (src/launcherPrefs.ts) applied at
    // render time. These optional fields exist on the type so the def and the
    // bridge Launcher type stay in sync; main does not currently populate them.
    hidden?: boolean;
    default?: boolean;
  };
  // fm-e66 — defaults seed the common modifier modes for each AI CLI.
  // Real users don't run `claude` once and forget; they run it three ways
  // (fresh, resume, yolo) depending on context. Variants let one launcher
  // capture all common modes instead of forcing three launcher entries.
  const DEFAULT_LAUNCHERS: LauncherDef[] = [
    {
      id: 'claude',
      label: 'Claude Code',
      aliases: ['claude', 'cc'],
      command: 'claude',
      description: 'Anthropic Claude Code CLI',
      contextFlag: '--append-system-prompt',
      variants: [
        {
          id: 'continue',
          label: 'Continue',
          args: ['--continue'],
          description: 'Resume the most recent session in this folder',
        },
        {
          id: 'unsafe',
          label: 'Skip permissions',
          args: ['--dangerously-skip-permissions'],
          description: 'Bypass tool permission prompts (yolo)',
        },
      ],
    },
    {
      id: 'codex',
      label: 'OpenAI Codex',
      aliases: ['codex'],
      command: 'codex',
      description: 'OpenAI Codex CLI',
      variants: [
        {
          id: 'continue',
          label: 'Continue',
          args: ['--continue'],
          description: 'Resume the most recent session',
        },
      ],
    },
    {
      id: 'gemini',
      label: 'Google Gemini',
      aliases: ['gemini'],
      command: 'gemini',
      description: 'Google Gemini CLI',
    },
  ];

  // fm-e66 — old launcher configs (pre-variants) get the default variants
  // injected on read so existing users get the new picker without losing
  // their custom commands/aliases. We only inject for ids we know about
  // (claude/codex/gemini); user-added launchers stay variant-less unless
  // the user adds variants by hand. Save back so the file on disk reflects
  // the migration — keeps subsequent reads fast and lets the user inspect
  // the seeded variants in launchers.json.
  function migrateLaunchers(list: LauncherDef[]): {
    list: LauncherDef[];
    changed: boolean;
  } {
    let changed = false;
    const next = list.map((l) => {
      const seed = DEFAULT_LAUNCHERS.find((d) => d.id === l.id);
      if (!seed) return l;
      let out = l;
      // fm-e66 — backfill default variants for pre-variants configs.
      if (out.variants === undefined && seed.variants) {
        out = { ...out, variants: seed.variants };
        changed = true;
      }
      // fm-dly3 — backfill the context flag so existing claude launchers get
      // background-context injection without a manual edit.
      if (out.contextFlag === undefined && seed.contextFlag) {
        out = { ...out, contextFlag: seed.contextFlag };
        changed = true;
      }
      return out;
    });
    return { list: next, changed };
  }

  function launchersPath(): string {
    return path.join(app.getPath('userData'), 'launchers.json');
  }
  async function loadLaunchers(): Promise<LauncherDef[]> {
    const p = launchersPath();
    try {
      const raw = await fs.readFile(p, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const { list, changed } = migrateLaunchers(parsed as LauncherDef[]);
        if (changed) {
          // Persist the migration so the user sees the seeded variants in
          // launchers.json next time they open the file.
          try {
            await fs.writeFile(p, JSON.stringify(list, null, 2), 'utf8');
          } catch { /* noop */ }
        }
        return list;
      }
      return DEFAULT_LAUNCHERS;
    } catch {
      // Seed defaults so the user has a starting point to edit.
      try {
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, JSON.stringify(DEFAULT_LAUNCHERS, null, 2), 'utf8');
      } catch { /* noop */ }
      return DEFAULT_LAUNCHERS;
    }
  }
  async function saveLaunchers(list: LauncherDef[]): Promise<void> {
    const p = launchersPath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(list, null, 2), 'utf8');
  }

  ipcMain.handle('launchers:list', async (): Promise<LauncherDef[]> => {
    return loadLaunchers();
  });
  ipcMain.handle('launchers:save', async (_e, list: LauncherDef[]) => {
    await saveLaunchers(list);
  });
  ipcMain.handle('launchers:configPath', async (): Promise<string> => {
    return launchersPath();
  });
  ipcMain.handle('launchers:revealConfig', async () => {
    const p = launchersPath();
    // Ensure file exists before revealing.
    await loadLaunchers();
    shell.showItemInFolder(p);
  });

  // ─── DSL tags (task-317c7fe41f90) ──────────────────────────────────
  // The new selector-based tag store (src/tagStore.mjs) lives in userData/
  // tags.json. Additive — runs alongside the live criterion tag system. The
  // dsltags:* handlers live in electron/tag-store.ts.
  registerTagStoreIpc();

  // ─── LLM tag frontend (fm-2ln / fm-5rk) ────────────────────────────
  // Metadata-only, in-process Anthropic call that compiles a natural-language
  // tag description into a tagDsl selector (+ name + color) and refines it from
  // rejected examples. The API key lives in main only (env or userData/llm.json)
  // — the llm:* handlers live in electron/llm.ts.
  registerLlmIpc();

  // ─── Tasks (fm-dhc) ────────────────────────────────────────────────
  // SQLite-backed task store at ~/.breezefile/tasks.db. Reads run on the
  // main thread (better-sqlite3 is synchronous and fast); writes broadcast
  // a 'tasks:changed' event to every window so the UI re-pulls.
  // ── Multi-source (breezed P4) ──────────────────────────────────────
  // Every task is tagged with `source` (<registered-source> | <host>) so the
  // UI can group by machine. Mutations route to the owning source. Remote
  // failures are logged, never thrown — a dead tunnel must not blank the
  // list.
  const taskQuery = (f?: TaskFilter): string => {
    if (!f) return '';
    const q = new URLSearchParams();
    if (typeof f.status === 'string') q.set('status', f.status);
    if (f.folder) q.set('folder', f.folder);
    if (f.pinned === true) q.set('pinned', '1');
    else if (f.pinned === false) q.set('pinned', '0');
    if (f.search) q.set('search', f.search);
    if (f.activeOnly) q.set('activeOnly', '1');
    if (f.includeDone === false) q.set('includeDone', '0');
    const s = q.toString();
    return s ? `?${s}` : '';
  };
  ipcMain.handle('sources:list', () => listSources());
  ipcMain.handle('sources:connect', (_e, host: string) => connectSource(host));
  // Navigation hook: if `cwd` lives under an active sshfs mount, attach its
  // host automatically (idempotent + once-per-host-per-session inside).
  ipcMain.handle('sources:auto-attach', (_e, cwd: string) =>
    autoAttachForPath(cwd).catch(() => null),
  );
  ipcMain.handle('sources:disconnect', (_e, host: string) =>
    disconnectSource(host),
  );

  // fm-b5at.1 — route through the TaskSource registry by source id. The
  // breezed connected-host path (remoteRequest/resolveRemote) stays
  // parallel: a `source` that names a connected ssh host is NOT a
  // registered TaskSource, so it falls through to remoteRequest unchanged.
  const isRegisteredSource = (id?: string): boolean => !!getTaskSource(id);

  // With no built-in local source, an unspecified source has nowhere to go
  // unless the caller is signed in to a remote source (TypeBuild). Surface a
  // clear, actionable error instead of crashing on `undefined!`.
  const NO_SOURCE = 'No task source available — sign in to TypeBuild';

  // fm-at5 — let the user cleanly back out of the auto-registered Claude
  // Code integration (settings.json hooks + hook script). Re-registration
  // runs on next app launch, so this is a reset, not a permanent opt-out.
  ipcMain.handle('claude:unregister-hooks', async () => {
    const { unregisterBreezeHooks } = await import('./hooks-register');
    return unregisterBreezeHooks();
  });

  ipcMain.handle('tasks:list', async (_e, filter?: TaskFilter) => {
    const out: Array<Record<string, unknown>> = [];
    // Aggregate across every registered source (local + e.g. TypeBuild),
    // tagging each row with its owning source id.
    for (const src of listTaskSourceInfos()) {
      try {
        const rows = await getTaskSource(src.id)!.listTasks(filter ?? {});
        for (const t of rows) out.push({ ...t, source: src.id });
      } catch (e) {
        // A single source failing must not silently vanish: a swallowed throw
        // here is exactly how "task list renders empty, no error anywhere"
        // happens. Keep the array return contract (renderer treats this as a
        // bare array), but make the failure loud — error-level in the main log
        // AND echoed to every renderer DevTools console via a debug channel.
        const message = (e as Error).message;
        console.error('[tasks:list]', src.id, 'failed:', message);
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) {
            w.webContents.send('tasks:sourceError', { source: src.id, message });
          }
        }
      }
    }
    // breezed multi-host federation (unchanged): connected ssh daemons are
    // not registry sources — aggregate them alongside.
    const qs = taskQuery(filter);
    for (const host of connectedHosts()) {
      try {
        const remote = await remoteRequest<Array<Record<string, unknown>>>(
          host,
          'GET',
          `/tasks${qs}`,
        );
        for (const t of remote) out.push({ ...(t as object), source: host });
      } catch (e) {
        console.warn('[tasks:list]', host, 'failed:', (e as Error).message);
      }
    }
    return out;
  });
  ipcMain.handle('tasks:get', (_e, id: string, source?: string) => {
    const src = getTaskSource(source);
    if (src) return src.getTask(id);
    if (!source) throw new Error(NO_SOURCE);
    return remoteRequest(source, 'GET', `/tasks/${encodeURIComponent(id)}`);
  });
  // task-3abb663aba25 — cache-only peek used by the renderer's diff-apply path.
  // Returns the rows for `ids` that match `filter` from the source's in-memory
  // cache (no network) so useTasks can update just the changed rows instead of
  // re-pulling the whole list. Returns null when the source can't peek (no
  // in-memory cache) so the renderer falls back to a full re-pull. Rows are
  // tagged with the source id, like tasks:list.
  ipcMain.handle(
    'tasks:peek',
    async (
      _e,
      source: string,
      ids: string[],
      filter?: TaskFilter,
    ): Promise<Array<Record<string, unknown>> | null> => {
      const src = getTaskSource(source);
      if (!src || typeof src.peekTasks !== 'function') return null;
      const rows = await src.peekTasks(
        Array.isArray(ids) ? ids : [],
        filter ?? {},
      );
      return rows.map((t) => ({ ...t, source }));
    },
  );
  // task-3abb663aba25 — per-project DONE/CANCELLED counts from the NON-PHI DB
  // skeleton. Lets Home show exact rolled-up terminal counts without pulling the
  // whole done archive into the renderer. Best-effort: any failure (locked/absent
  // db) returns {} so the grid just shows live-only counts rather than erroring.
  ipcMain.handle(
    'tasks:terminalCounts',
    (): Record<string, { done: number; cancelled: number }> => {
      try {
        return terminalCountsByProject();
      } catch (e) {
        console.warn('[tasks:terminalCounts]', (e as Error).message);
        return {};
      }
    },
  );
  // Auto-by-folder routing: if the caller didn't pin a source and the
  // task's folder lives under a *connected* host's sshfs mount, the
  // task belongs to that machine — create it on its daemon with the
  // folder rewritten to the real remote path. Otherwise route through the
  // named registered source (e.g. TypeBuild).
  ipcMain.handle('tasks:create', async (_e, input: TaskCreate, source?: string) => {
    if (source && !isRegisteredSource(source)) {
      return remoteRequest(source, 'POST', '/tasks', input);
    }
    if (!source && input.folder) {
      const rr = await resolveRemote(input.folder).catch(() => null);
      if (rr && connectedHosts().includes(rr.target)) {
        return remoteRequest(rr.target, 'POST', '/tasks', {
          ...input,
          folder: rr.remoteCwd,
        });
      }
    }
    const src = getTaskSource(source);
    if (!src) throw new Error(NO_SOURCE);
    return src.createTask(input);
  });
  ipcMain.handle(
    'tasks:update',
    (_e, id: string, patch: TaskUpdate, source?: string) => {
      const src = getTaskSource(source);
      if (src) return src.updateTask(id, patch);
      if (!source) throw new Error(NO_SOURCE);
      return remoteRequest(source, 'PATCH', `/tasks/${encodeURIComponent(id)}`, patch);
    },
  );
  ipcMain.handle('tasks:delete', (_e, id: string, source?: string) => {
    const src = getTaskSource(source);
    if (src) return src.deleteTask(id);
    if (!source) throw new Error(NO_SOURCE);
    return remoteRequest(source, 'DELETE', `/tasks/${encodeURIComponent(id)}`);
  });
  // fm-b5at.1 — registered sources + their capabilities (renderer gates
  // edit/delete/schedule affordances on these).
  ipcMain.handle('tasks:sources', () => listTaskSourceInfos());
  // fm-b5at.1 — generic source-native verb (claim/release/reopen, ...).
  // Routes to the owning source's sourceAction; throws if the source
  // doesn't implement it.
  ipcMain.handle(
    'tasks:sourceAction',
    (_e, source: string, taskId: string, action: string, payload?: unknown) => {
      const src = getTaskSource(source);
      if (!src) {
        return remoteRequest(
          source,
          'POST',
          `/tasks/${encodeURIComponent(taskId)}/action`,
          { action, payload },
        );
      }
      if (!src.sourceAction) throw unsupported(`action ${action}`);
      return src.sourceAction(taskId, action, payload);
    },
  );
  // fm-j7w0 (S4) / fm-k6wz (S7) — TypeBuild-specific reads that aren't part of
  // the generic TaskSource interface: the user registry (assignee picker) and
  // per-task audit history (detail History section). Both go through the live
  // TypeBuildTaskSource instance from the registry; if the source isn't
  // registered (signed out) we return an empty result rather than throwing, so
  // the picker/history degrade quietly. Payloads are NON-PHI (user identities,
  // audit actions).
  const typebuildSource = (): TypeBuildTaskSource | undefined => {
    const src = getTaskSource('typebuild');
    return src && 'listUsers' in src
      ? (src as unknown as TypeBuildTaskSource)
      : undefined;
  };
  ipcMain.handle('typebuild:listUsers', () => {
    const src = typebuildSource();
    return src ? src.listUsers() : [];
  });
  ipcMain.handle('typebuild:audit', (_e, taskId: string, limit?: number) => {
    const src = typebuildSource();
    return src ? src.getAudit(taskId, limit ?? 20) : [];
  });
  // task-e713f307c422 — SavedQuery selectors: run a form-field query on demand
  // (New Task typeahead + the lookup_record copilot action) and enumerate
  // approved queries for the Template Editor's source picker. Both route
  // through the live TypeBuild source; signed out → execute rejects (the
  // typeahead debounce swallows it) and list returns [] so the picker degrades.
  // Executed rows may carry PHI in display fields — never logged on this hop.
  ipcMain.handle(
    'typebuild:queries:execute',
    (_e, savedQueryId: string, inputs: Record<string, string>, version?: number) => {
      const src = typebuildSource();
      if (!src) throw new Error('typebuild: signed out');
      return src.executeQuery(savedQueryId, inputs ?? {}, version);
    },
  );
  ipcMain.handle('typebuild:queries:list', (_e, status?: string) => {
    const src = typebuildSource();
    return src ? src.listQueries(status) : [];
  });
  // task-d8a0b081eb93 — SavedQuery AUTHORING (design-time CopilotKit flow):
  // ground the LLM with the DataSource spec (datasources:list — NO creds),
  // create a DRAFT (queries:create), inspect it (queries:get), clone→draft a
  // new version (queries:version), and the MANDATORY human approve gate
  // (queries:approve — draft→approved == publish org-wide). Query code/schema
  // are NON-PHI author config; sample rows from a test run cross the execute
  // hop (already handled above) and are memory-only in the renderer. Signed
  // out → these reject; the actions surface the error string to the chat.
  ipcMain.handle('typebuild:datasources:list', (_e) => {
    const src = typebuildSource();
    if (!src) throw new Error('typebuild: signed out');
    return src.listDataSources();
  });
  ipcMain.handle(
    'typebuild:queries:create',
    (
      _e,
      input: {
        name: string;
        sourceId: string;
        code: string;
        outputSchema: unknown;
        inputs?: unknown;
        limits?: unknown;
        projectId?: string;
        groupId?: string;
      },
    ) => {
      const src = typebuildSource();
      if (!src) throw new Error('typebuild: signed out');
      return src.createQuery(input);
    },
  );
  ipcMain.handle('typebuild:queries:get', (_e, savedQueryId: string) => {
    const src = typebuildSource();
    if (!src) throw new Error('typebuild: signed out');
    return src.getQuery(savedQueryId);
  });
  ipcMain.handle('typebuild:queries:approve', (_e, savedQueryId: string) => {
    const src = typebuildSource();
    if (!src) throw new Error('typebuild: signed out');
    return src.approveQuery(savedQueryId);
  });
  ipcMain.handle(
    'typebuild:queries:version',
    (
      _e,
      savedQueryId: string,
      patch?: { code?: string; outputSchema?: unknown; inputs?: unknown; limits?: unknown },
    ) => {
      const src = typebuildSource();
      if (!src) throw new Error('typebuild: signed out');
      return src.newQueryVersion(savedQueryId, patch);
    },
  );
  // task-ae0ec0348930 — FormExtensions (the CLIENT half of the primitive): the
  // interpreter renders an approved extension's fields[] + applies its logic's
  // allowlisted effects, and the design-time copilot authors/approves them.
  // `list` enumerates extensions (returns [] signed-out so the interpreter
  // degrades to "no extension"); every MUTATING verb throws signed-out (the
  // action surfaces the message). Field VALUES cross run-logic (may be PHI) —
  // never logged on this hop. Config (fields/logic/applies_to) is NON-PHI.
  ipcMain.handle('typebuild:formext:list', (_e, status?: string) => {
    const src = typebuildSource();
    return src ? src.listFormExtensions(status) : [];
  });
  ipcMain.handle(
    'typebuild:formext:create',
    (
      _e,
      input: {
        name: string;
        appliesTo: Record<string, unknown>;
        fields: Array<Record<string, unknown>>;
        logic: string;
        limits?: Record<string, unknown>;
        projectId?: string;
        groupId?: string;
      },
    ) => {
      const src = typebuildSource();
      if (!src) throw new Error('typebuild: signed out');
      return src.createFormExtension(input);
    },
  );
  ipcMain.handle('typebuild:formext:get', (_e, id: string) => {
    const src = typebuildSource();
    if (!src) throw new Error('typebuild: signed out');
    return src.getFormExtension(id);
  });
  ipcMain.handle('typebuild:formext:approve', (_e, id: string) => {
    const src = typebuildSource();
    if (!src) throw new Error('typebuild: signed out');
    return src.approveFormExtension(id);
  });
  ipcMain.handle(
    'typebuild:formext:version',
    (
      _e,
      id: string,
      patch?: {
        fields?: Array<Record<string, unknown>>;
        logic?: string;
        appliesTo?: Record<string, unknown>;
        limits?: Record<string, unknown>;
      },
    ) => {
      const src = typebuildSource();
      if (!src) throw new Error('typebuild: signed out');
      return src.newFormExtensionVersion(id, patch);
    },
  );
  ipcMain.handle(
    'typebuild:formext:run-logic',
    (_e, id: string, values: Record<string, unknown>, changed: string | null) => {
      const src = typebuildSource();
      if (!src) throw new Error('typebuild: signed out');
      return src.runFormLogic(id, values ?? {}, changed ?? null);
    },
  );
  // task-e112d60a3b7c — first-class Task Templates (/chromeext/templates). The
  // "New from Template" picker `list`s templates (NON-PHI: names + field defs,
  // no prompt body), optionally `get`s the full template (decrypted `notes`,
  // PHI — memory-only), and `instantiate`s one into a real task server-side.
  // `list`/`get` return []/null signed-out so the picker degrades; `instantiate`
  // throws signed-out (the composer surfaces the error). `values` MAY be PHI —
  // never logged on this hop.
  ipcMain.handle('typebuild:templates:list', (_e, projectId?: string) => {
    const src = typebuildSource();
    return src ? src.listTemplates(projectId) : [];
  });
  ipcMain.handle('typebuild:templates:get', (_e, id: string) => {
    const src = typebuildSource();
    return src ? src.getTemplate(id) : null;
  });
  ipcMain.handle(
    'typebuild:templates:instantiate',
    (
      _e,
      templateId: string,
      values: Record<string, string>,
      titleOverride?: string,
      projectId?: string,
    ) => {
      const src = typebuildSource();
      if (!src) throw new Error('typebuild: signed out');
      return src.instantiateTemplate(templateId, values ?? {}, titleOverride, projectId);
    },
  );
  // task-41e5fc25ed2b (picker slice) — server-side ChainDefs in the "New from
  // Template" picker. `list` degrades to [] signed-out (picker shows only single
  // templates); `create`/`instantiate` throw signed-out (only reached from an
  // explicit user/script action). `instantiate` returns { parentTaskId, taskIds }.
  ipcMain.handle('typebuild:chains:list', (_e, projectId?: string) => {
    const src = typebuildSource();
    return src ? src.listChains(projectId) : [];
  });
  ipcMain.handle(
    'typebuild:chains:create',
    (
      _e,
      chainDef: { name: string; steps: unknown[]; project_id?: string; group_id?: string },
    ) => {
      const src = typebuildSource();
      if (!src) throw new Error('typebuild: signed out');
      return src.createChain(chainDef);
    },
  );
  ipcMain.handle(
    'typebuild:chains:instantiate',
    (_e, chainId: string, stepInputs?: Array<Record<string, string>>) => {
      const src = typebuildSource();
      if (!src) throw new Error('typebuild: signed out');
      return src.instantiateChain(chainId, stepInputs);
    },
  );
  // fm-b5at.8 — PHI-free schedule overlay for remote-source tasks. Lets a
  // time-gated remote (TypeBuild) task fire on the local cron. Rows carry
  // ONLY opaque ids + a cron string — never titles/bodies. setSchedule
  // validates the cron (throws on invalid → surfaced inline by the renderer).
  ipcMain.handle(
    'tasks:overlaySet',
    (_e, source: string, taskId: string, cron: string) =>
      overlaySchedule.setSchedule(source, taskId, cron),
  );
  ipcMain.handle(
    'tasks:overlayClear',
    (_e, source: string, taskId: string) =>
      overlaySchedule.clearSchedule(source, taskId),
  );
  ipcMain.handle('tasks:overlayList', () => overlaySchedule.listSchedules());
  ipcMain.handle('tasks:countByFolder', (_e, folder: string) => tasks.countByFolder(folder));
  ipcMain.handle('tasks:dbExists', () => tasks.dbExists());
  // fm-adc — drop a YAML-frontmatter+markdown sidecar at
  // ~/.breezefile/active-tasks/<id>.md so an agent launched on a task tab
  // can re-read context any time without burning prompt tokens. Failures
  // here must not block the launch; we log and return null so the caller
  // can still proceed to PTY spawn + prompt injection.
  // fm-zf3m — run history + manual run-now from the renderer.
  ipcMain.handle('tasks:runsList', (_e, taskId: string, limit?: number) =>
    tasks.listRunsForTask(taskId, limit ?? 50),
  );
  ipcMain.handle('tasks:runsListAll', (_e, limit?: number) =>
    tasks.listAllRuns(limit ?? 200),
  );
  ipcMain.handle('tasks:runsCountByTask', () => tasks.runCountsByTask());
  ipcMain.handle('tasks:lastRun', (_e, taskId: string) => tasks.getLastRun(taskId));
  ipcMain.handle('tasks:runNow', async (_e, taskId: string, source?: string) => {
    // Registered source (local + e.g. TypeBuild) runs through its own
    // runNow. A connected ssh host is not a registry source: the run
    // executes on that machine's daemon — fall through to remoteRequest.
    const src = getTaskSource(source);
    if (src) return src.runNow(taskId, { manualInvocation: true });
    if (!source) throw new Error(NO_SOURCE);
    return remoteRequest(
      source,
      'POST',
      `/tasks/${encodeURIComponent(taskId)}/run`,
      {},
    );
  });
  // fm-femh — manual run with a caller-supplied cwd. Used by the
  // Run-task modal in folder tabs so a folder-agnostic task (or even
  // a folder-anchored one) can execute against the active folder tab.
  ipcMain.handle('tasks:runNowAt', async (_e, taskId: string, cwd: string) => {
    const t = tasks.getTask(taskId);
    if (!t) throw new Error(`task not found: ${taskId}`);
    if (!cwd?.trim()) throw new Error('cwd is required');
    const { executeTaskRun } = await import('./agents/execute');
    return executeTaskRun(t, { overrideCwd: cwd, manualInvocation: true });
  });
  // fm-femh — cancel an in-flight run. Returns true when an active run
  // was found for the id and signalled; false if it had already finished.
  ipcMain.handle('tasks:cancelRun', async (_e, runId: string) => {
    const { cancelRun } = await import('./agents/execute');
    return cancelRun(runId);
  });
  ipcMain.handle(
    'tasks:writeActiveSidecar',
    (_e, id: string, source?: string): string | null => {
      try {
        // fm-b5at.4 PHI gate: never persist a phiSensitive source's task
        // (e.g. TypeBuild) to the on-disk active-task sidecar. The sidecar is
        // written from the LOCAL sqlite store; a remote PHI task has no local
        // row anyway, but gate explicitly so a future caller passing a source
        // can't leak decrypted content to disk.
        const src = getTaskSource(source);
        if (src?.capabilities.phiSensitive) return null;
        const t = tasks.getTask(id);
        if (!t) return null;
        return tasks.writeActiveTaskSidecar(t);
      } catch (err) {
        console.error('[tasks:writeActiveSidecar] failed:', err);
        return null;
      }
    },
  );
}

export function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow();
}

export { expandHome };
