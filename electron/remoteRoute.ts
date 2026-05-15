// Remote-mount routing: when a cwd lives under an sshfs / macFUSE / fuse-t
// mount, derive the underlying ssh target + remote path so callers can spawn
// commands on the remote host instead of through the FUSE layer.
//
// Cross-platform by design: we shell out to `mount` (present on both Linux
// and macOS) and identify candidate filesystems by fs-type token. No
// per-machine config — the kernel already knows `user@host:/remote` lives at
// `/local/mountpoint`, we just read it back.

import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execP = promisify(exec);

export type RemoteMount = {
  /** Local mountpoint, e.g. /home/vivek/vivekhp */
  mountpoint: string;
  /** ssh target as it appears in the mount source, e.g. vivekhp or user@host */
  target: string;
  /** Remote root path on the target, e.g. /home/vivek */
  remoteRoot: string;
};

export type RemoteRoute = {
  target: string;
  remoteCwd: string;
  mountpoint: string;
};

let cache: { at: number; mounts: RemoteMount[] } | null = null;
const TTL_MS = 5_000;

// Match `user@host:/path` or `host:/path`. host segment forbids ':' to avoid
// catching IPv6 (sshfs writes those bracketed anyway), forbids '/' so we
// don't swallow the path separator.
const SOURCE_RE = /^([^\s/:@]+(?:@[^\s/:]+)?):(\/.*)$/;

function looksRemoteFs(typeAndOpts: string): boolean {
  // Covers Linux sshfs (`fuse.sshfs`), macFUSE classic (`osxfuse`, `macfuse`),
  // and fuse-t (`fuse-t`, `nfs` when fuse-t is in NFS-bridge mode — we
  // disambiguate by also requiring a `user@host:/...` source, which plain
  // NFS doesn't produce).
  return /\b(sshfs|osxfuse|macfuse|fuse-t)\b/i.test(typeAndOpts) ||
    /fuse\.sshfs/i.test(typeAndOpts);
}

async function readMounts(): Promise<RemoteMount[]> {
  // `mount` with no args prints the mount table on both Linux and macOS.
  // Format we care about, common to both:
  //   <source> on <mountpoint> type <type> (<opts>)        [Linux]
  //   <source> on <mountpoint> (<type>, <opts>)            [macOS]
  let out = '';
  try {
    const { stdout } = await execP('mount', { timeout: 2000 });
    out = stdout;
  } catch {
    return [];
  }
  const results: RemoteMount[] = [];
  for (const line of out.split('\n')) {
    // Greedy `on` split: paths can contain " on " in theory, but the rest of
    // the line ` (<…>)` anchors it. Use a regex that requires the paren tail.
    const m = line.match(/^(\S.*?) on (\/\S(?:.*\S)?) (?:type \S+ )?\((.+)\)\s*$/);
    if (!m) continue;
    const source = m[1];
    const mountpoint = m[2];
    const tail = m[3]; // opts (and on Linux, opts only; type was already consumed)
    // Recover the type token on Linux from the original line.
    const typeMatch = line.match(/ type (\S+) /);
    const typeTag = typeMatch ? typeMatch[1] : tail;
    if (!looksRemoteFs(`${typeTag} ${tail}`)) continue;
    const srcM = source.match(SOURCE_RE);
    if (!srcM) continue;
    if (existsSync(path.join(mountpoint, '.breeze-remote-skip'))) continue;
    results.push({
      mountpoint: path.resolve(mountpoint),
      target: srcM[1],
      remoteRoot: srcM[2].replace(/\/+$/, '') || '/',
    });
  }
  // On Linux, /proc/self/mountinfo is more authoritative when present.
  // Augment / replace entries from there; the extra fidelity helps when
  // `mount` output is stale or filtered.
  if (process.platform === 'linux') {
    try {
      const raw = readFileSync('/proc/self/mountinfo', 'utf8');
      const procMounts: RemoteMount[] = [];
      for (const line of raw.split('\n')) {
        // mountinfo fields are space-separated; fields after " - " are
        // fs-type, source, super-options.
        const idx = line.indexOf(' - ');
        if (idx < 0) continue;
        const left = line.slice(0, idx).split(' ');
        const right = line.slice(idx + 3).split(' ');
        const mountpoint = left[4];
        const fsType = right[0];
        const source = right[1];
        if (!fsType || !source || !mountpoint) continue;
        if (!looksRemoteFs(fsType)) continue;
        const srcM = source.match(SOURCE_RE);
        if (!srcM) continue;
        if (existsSync(path.join(mountpoint, '.breeze-remote-skip'))) continue;
        procMounts.push({
          mountpoint: path.resolve(mountpoint),
          target: srcM[1],
          remoteRoot: srcM[2].replace(/\/+$/, '') || '/',
        });
      }
      if (procMounts.length > 0) return procMounts;
    } catch {
      /* fall through to `mount` results */
    }
  }
  return results;
}

async function getMounts(): Promise<RemoteMount[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.mounts;
  const mounts = await readMounts();
  cache = { at: now, mounts };
  return mounts;
}

export function clearRemoteCache(): void {
  cache = null;
}

/** Distinct ssh targets from currently active sshfs/macFUSE mounts.
 *  Drives the remote-attach verb's host slot. */
export async function listRemoteTargets(): Promise<string[]> {
  const mounts = await getMounts();
  return [...new Set(mounts.map((m) => m.target))];
}

/** Resolve an absolute local cwd to an ssh target + remote cwd, or null. */
export async function resolveRemote(cwd: string): Promise<RemoteRoute | null> {
  if (process.env.BREEZE_REMOTE_DISABLE === '1') return null;
  if (!cwd || !path.isAbsolute(cwd)) return null;
  const mounts = await getMounts();
  if (mounts.length === 0) return null;
  // Longest mountpoint wins (handles nested mounts).
  const sorted = [...mounts].sort((a, b) => b.mountpoint.length - a.mountpoint.length);
  for (const m of sorted) {
    if (cwd === m.mountpoint || cwd.startsWith(m.mountpoint + path.sep)) {
      const rel = cwd === m.mountpoint ? '' : cwd.slice(m.mountpoint.length);
      const remoteCwd = path.posix.join(m.remoteRoot, rel.split(path.sep).join('/')) || '/';
      return { target: m.target, remoteCwd, mountpoint: m.mountpoint };
    }
  }
  return null;
}

/** POSIX single-quote for embedding a path in a remote shell command. */
export function shQuote(s: string): string {
  if (/^[A-Za-z0-9_./@:+\-,=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
