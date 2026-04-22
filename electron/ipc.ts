import { ipcMain, shell, app, BrowserWindow, clipboard, nativeImage, dialog } from 'electron';
import { promises as fs, constants as fsc } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';

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
    // `wx` fails if the file already exists — the 'Create file' verb wants
    // that error surfaced rather than silently re-touching an existing file.
    await fs.writeFile(abs, '', { flag: 'wx' });
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
}

export function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow();
}

export { expandHome };
