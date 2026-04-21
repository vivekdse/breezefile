import { ipcMain, shell, app, BrowserWindow, clipboard, nativeImage } from 'electron';
import { promises as fs, constants as fsc } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';

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

export function registerIpc() {
  ipcMain.handle('fs:readdir', async (_e, dirpath: string) => {
    return readdirEntries(dirpath);
  });

  ipcMain.handle('fs:homedir', () => os.homedir());

  ipcMain.handle('fs:stat', async (_e, p: string) => {
    const abs = expandHome(p);
    const st = await fs.lstat(abs);
    return { size: st.size, mtimeMs: st.mtimeMs, isDir: st.isDirectory() };
  });

  ipcMain.handle('fs:mkdir', async (_e, p: string) => {
    await fs.mkdir(expandHome(p), { recursive: true });
  });

  ipcMain.handle('fs:rename', async (_e, from: string, to: string) => {
    await fs.rename(expandHome(from), expandHome(to));
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
      for (const op of ops) {
        let target = op.overwrite
          ? path.join(op.dst, path.basename(op.src))
          : await uniquePaste(op.dst, path.basename(op.src));
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
    },
  );

  ipcMain.handle('fs:touch', async (_e, p: string) => {
    const abs = expandHome(p);
    const now = new Date();
    try {
      await fs.utimes(abs, now, now);
    } catch {
      const fh = await fs.open(abs, 'a');
      await fh.close();
    }
  });

  ipcMain.handle('shell:reveal', (_e, p: string) => {
    shell.showItemInFolder(expandHome(p));
  });

  ipcMain.handle('shell:openTerminal', (_e, cwd: string) => {
    const abs = expandHome(cwd);
    return new Promise<void>((resolve, reject) => {
      execFile('open', ['-a', 'Terminal', abs], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  ipcMain.handle('shell:runCommand', async (_e, cwd: string, cmd: string) => {
    const abs = expandHome(cwd);
    return new Promise<void>((resolve, reject) => {
      const p = spawn(cmd, { cwd: abs, shell: true, stdio: 'inherit' });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });
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

  ipcMain.handle('shell:clipboardWrite', (_e, p: string) => {
    // Writes a file reference to clipboard (macOS NSPasteboard file URL)
    clipboard.write({ text: expandHome(p) });
  });

  ipcMain.handle('thumb:get', async (_e, p: string, size: number) => {
    return thumbnailFor(expandHome(p), size);
  });

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

  ipcMain.on('drag:start', (e, paths: string[]) => {
    if (paths.length === 0) return;
    try {
      const abs = paths.map(expandHome);
      e.sender.startDrag({ files: abs, icon: TINY_ICON } as unknown as Electron.Item);
    } catch {
      // Don't let a failed drag kill the main process.
    }
  });
}

export function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow();
}

export { expandHome };
