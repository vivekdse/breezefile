import { ipcMain, shell, app, BrowserWindow, clipboard, nativeImage, dialog } from 'electron';
import { promises as fs, constants as fsc } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import crypto from 'node:crypto';
import * as nodePty from '@homebridge/node-pty-prebuilt-multiarch';
import * as tasks from './tasks';
import type { TaskCreate, TaskFilter, TaskUpdate } from './tasks';

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

function classify(name: string, stat: import('node:fs').Stats, mode: number): Entry['kind'] {
  if (stat.isSymbolicLink()) return 'link';
  if (stat.isDirectory()) return 'dir';
  const execBit = mode & 0o111;
  if (execBit && !stat.isDirectory()) return 'exec';
  void name;
  return 'file';
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
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
  const names = await fs.readdir(abs);
  const out: Entry[] = [];
  for (const name of names) {
    const full = path.join(abs, name);
    try {
      const lst = await fs.lstat(full);
      const ext = name.includes('.') && !name.startsWith('.')
        ? name.split('.').pop()!.toLowerCase()
        : undefined;
      out.push({
        name,
        path: full,
        kind: classify(name, lst, lst.mode),
        ext,
        size: lst.size,
        mtimeMs: lst.mtimeMs,
        ctimeMs: lst.ctimeMs,
        isHidden: name.startsWith('.'),
      });
    } catch {
      // skip unreadable entries
    }
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
  const stats = await diskStats('/');
  const loc: Location = {
    id: 'boot',
    label: 'Macintosh HD',
    path: '/',
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

export function registerIpc() {
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
      // On macOS `open -a <app.app> <file>` is the canonical way to route
      // a file to a specific application bundle.
      return new Promise<void>((resolve, reject) => {
        spawn('open', ['-a', bound!, abs], { stdio: 'ignore', detached: true })
          .on('error', reject)
          .on('spawn', () => resolve());
      });
    }
    await shell.openPath(abs);
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
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose an Application',
      buttonLabel: 'Choose',
      defaultPath: '/Applications',
      properties: ['openFile'],
      filters: process.platform === 'darwin'
        ? [{ name: 'Applications', extensions: ['app'] }]
        : undefined,
    };
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    const picked = res.filePaths[0];
    // Belt-and-suspenders: if somehow a non-.app path slips through (other
    // platforms, future flag changes), reject so the renderer can surface
    // a clear error rather than spawning `open -a` against a binary.
    if (process.platform === 'darwin' && !picked.toLowerCase().endsWith('.app')) {
      throw new Error('Pick a .app bundle (not a file inside one)');
    }
    return picked;
  });

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
        try {
          if (kind === 'zip') {
            await runTool('ditto', ['-x', '-k', src, destDir]);
          } else if (kind === 'tar') {
            await runTool('tar', ['-xf', src, '-C', destDir]);
          } else if (kind === '7z') {
            try {
              await runTool('7zz', ['x', `-o${destDir}`, '-y', src]);
            } catch (err) {
              if ((err as Error).message.includes('not found on PATH')) {
                throw new Error('Install 7-Zip (brew install sevenzip)');
              }
              throw err;
            }
          } else if (kind === 'rar') {
            try {
              await runTool('unar', ['-o', destDir, src]);
            } catch (err) {
              if ((err as Error).message.includes('not found on PATH')) {
                throw new Error('Install unar (brew install unar)');
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
    return new Promise<void>((resolve, reject) => {
      execFile('open', ['-a', appName, expandHome(p)], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
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

  ipcMain.handle('editor:bulkRename', async (_e, names: string[]) => {
    const tmp = path.join(os.tmpdir(), `fm-rename-${Date.now()}.txt`);
    await fs.writeFile(tmp, names.join('\n') + '\n', 'utf8');
    const editor = process.env.EDITOR || 'vi';
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
    const parts = p.split('/');
    for (const part of parts) {
      if (FOLDER_EXCLUDE_SEGMENTS.has(part)) return true;
    }
    return false;
  }

  ipcMain.handle('search:folders', async (_e, query: string, limit = 40): Promise<string[]> => {
    if (process.platform !== 'darwin') return [];
    const q = query.trim();
    if (q.length === 0) return [];
    // Split the query into whitespace-separated tokens and AND them. This
    // lets the user type words out of order — "webinar folder" matches
    // "Webinar data shared folder". Each token is a case-insensitive
    // substring on kMDItemDisplayName.
    const tokens = q.split(/\s+/).filter((t) => t.length > 0);
    const nameClauses = tokens
      .map((t) => `kMDItemDisplayName == "*${t.replace(/"/g, '')}*"c`)
      .join(' && ');
    const mdQuery = `${nameClauses} && kMDItemContentType == "public.folder"`;
    const home = os.homedir();
    return new Promise((resolve) => {
      execFile(
        'mdfind',
        ['-onlyin', home, mdQuery],
        { maxBuffer: 2 * 1024 * 1024, timeout: 3000 },
        (err, stdout) => {
          if (err) { resolve([]); return; }
          const lines = stdout.split('\n').filter((l) => l.length > 0);
          const filtered: string[] = [];
          for (const line of lines) {
            if (isNoisePath(line)) continue;
            filtered.push(line);
            if (filtered.length >= limit) break;
          }
          resolve(filtered);
        },
      );
    });
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

  type FindHit = { path: string; name: string; isDir: boolean; tier: 'local' | 'spotlight' };

  ipcMain.handle(
    'fs:findEntries',
    async (_e, roots: string[], query: string, limit = 60): Promise<FindHit[]> => {
      const q = query.trim().toLowerCase();
      if (q.length === 0) return [];
      const out: FindHit[] = [];
      const seen = new Set<string>();

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
                  if (ent.name.startsWith('.')) continue;
                  if (FIND_SKIP.has(ent.name)) continue;
                  const full = path.join(dir, ent.name);
                  const isDir = ent.isDirectory();
                  if (ent.name.toLowerCase().includes(q)) {
                    hits.push({ path: full, name: ent.name, isDir, tier: 'local' });
                  }
                  if (isDir) subdirs.push(full);
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

      // Broaden with Spotlight if we have headroom (only on darwin).
      if (out.length < limit && process.platform === 'darwin') {
        const tokens = q.split(/\s+/).filter((t) => t.length > 0);
        const nameClauses = tokens
          .map((t) => `kMDItemDisplayName == "*${t.replace(/"/g, '')}*"c`)
          .join(' && ');
        const home = os.homedir();
        const spotHits = await new Promise<string[]>((resolve) => {
          execFile(
            'mdfind',
            ['-onlyin', home, nameClauses],
            { maxBuffer: 2 * 1024 * 1024, timeout: 3000 },
            (err, stdout) => {
              if (err) { resolve([]); return; }
              resolve(stdout.split('\n').filter((l) => l.length > 0));
            },
          );
        });
        for (const p of spotHits) {
          if (out.length >= limit) break;
          if (seen.has(p)) continue;
          // Filter out heavyweight noise paths.
          const parts = p.split('/');
          let skip = false;
          for (const part of parts) {
            if (FIND_SKIP.has(part)) { skip = true; break; }
          }
          if (skip) continue;
          const name = path.basename(p);
          if (!name.toLowerCase().includes(q.split(/\s+/)[0])) continue;
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
  // node-pty lives in the main process; the renderer drives it over IPC.
  // High-frequency channels (write, resize, data) use ipcRenderer.send /
  // webContents.send so we never queue a Promise per keystroke. spawn,
  // status, kill go through invoke because the caller wants a result.
  type PtyRecord = {
    proc: import('@homebridge/node-pty-prebuilt-multiarch').IPty;
    senderId: number;
    cmd: string;
  };
  const ptys = new Map<number, PtyRecord>();
  let nextPtyId = 1;

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

  function defaultShell(): { file: string; args: string[] } {
    if (process.platform === 'win32') {
      return { file: process.env.COMSPEC || 'cmd.exe', args: [] };
    }
    const file = process.env.SHELL || '/bin/zsh';
    // -l so the user's profile loads (PATH from .zshrc/.bash_profile).
    return { file, args: ['-l'] };
  }

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
      },
    ): Promise<number> => {
      const cwd = expandHome(opts.cwd);
      const def = defaultShell();
      const file = opts.shell ?? def.file;
      const args = opts.args ?? def.args;
      const cols = Math.max(2, Math.min(opts.cols ?? 80, 1000));
      const rows = Math.max(2, Math.min(opts.rows ?? 24, 1000));
      const proc = nodePty.spawn(file, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: ptyEnv(opts.env) as { [key: string]: string },
      });
      const id = nextPtyId++;
      const senderId = e.sender.id;
      ptys.set(id, { proc, senderId, cmd: file });
      proc.onData((data) => {
        const wc = BrowserWindow.fromId(senderId)?.webContents;
        // sender stays valid even if window is hidden; just guard against
        // the window being closed mid-stream.
        if (wc && !wc.isDestroyed()) wc.send('term:data', { id, data });
      });
      proc.onExit(({ exitCode, signal }) => {
        const wc = BrowserWindow.fromId(senderId)?.webContents;
        if (wc && !wc.isDestroyed()) {
          wc.send('term:exit', { id, code: exitCode, signal: signal ?? null });
        }
        ptys.delete(id);
      });
      // Kill orphan PTYs if the renderer process goes away (window reload,
      // crash). Otherwise the shell keeps the file_manager parent alive.
      e.sender.once('destroyed', () => {
        const r = ptys.get(id);
        if (r) {
          try { r.proc.kill(); } catch { /* noop */ }
          ptys.delete(id);
        }
      });
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
      if (l.variants !== undefined) return l;
      const seed = DEFAULT_LAUNCHERS.find((d) => d.id === l.id);
      if (!seed || !seed.variants) return l;
      changed = true;
      return { ...l, variants: seed.variants };
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

  // ─── Tasks (fm-dhc) ────────────────────────────────────────────────
  // SQLite-backed task store at ~/.breezefile/tasks.db. Reads run on the
  // main thread (better-sqlite3 is synchronous and fast); writes broadcast
  // a 'tasks:changed' event to every window so the UI re-pulls.
  ipcMain.handle('tasks:list', (_e, filter?: TaskFilter) => tasks.listTasks(filter ?? {}));
  ipcMain.handle('tasks:get', (_e, id: string) => tasks.getTask(id));
  ipcMain.handle('tasks:create', (_e, input: TaskCreate) => tasks.createTask(input));
  ipcMain.handle('tasks:update', (_e, id: string, patch: TaskUpdate) =>
    tasks.updateTask(id, patch),
  );
  ipcMain.handle('tasks:delete', (_e, id: string) => tasks.deleteTask(id));
  ipcMain.handle('tasks:countByFolder', (_e, folder: string) => tasks.countByFolder(folder));
  ipcMain.handle('tasks:dbExists', () => tasks.dbExists());
}

export function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow();
}

export { expandHome };
