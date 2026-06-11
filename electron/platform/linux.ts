import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import type { ArrangeRect, ArrangeResult, Capabilities, PlatformAdapter } from './index';
import { bfsSearch } from './bfs';
import * as indexDb from './index-db';

// Linux adapter. Most OS-coupled features are off until a real implementation
// lands (see CAPABILITIES.md). The renderer hides verbs whose capability is
// false, so "off" here means "invisible UI" — never a runtime crash.
//
// Search strategy: we maintain our own SQLite name index at
// ~/.breezefile/index.db (see index-db.ts) since Linux has no always-on
// metadata index. First search kicks off a background walk and returns
// live-BFS results for that query; subsequent searches read the DB.
export class LinuxAdapter implements PlatformAdapter {
  readonly id = 'linux' as const;
  private rebuildKicked = false;

  capabilities(): Capabilities {
    return {
      // `spotlightSearch` reflects whether a no-cost OS index is available.
      // Linux has none by default; the renderer treats search as "local only".
      // Our own SQLite index still backs the verb — see searchByIndex.
      spotlightSearch: false,
      externalVolumes: false,
      cloudMounts: false,
      attentionSound: false,
      dockBadge: false,
      share: false,
      colorTags: false,
      quickLook: false,
      openWithLauncher: false,
      vibrancy: false,
      // X11 with wmctrl/xdotool present → we can move Chrome's window.
      // Wayland exposes no portable client API for moving foreign windows,
      // so the capability is false there and the UI explains degraded mode.
      windowArrange: !isWayland() && hasWmTool(),
    };
  }

  private kickRebuildOnce() {
    if (this.rebuildKicked) return;
    this.rebuildKicked = true;
    // Fire-and-forget: log on failure but don't surface to the caller.
    indexDb.rebuild().catch((e) => {
      console.warn('[index] rebuild failed:', (e as Error).message);
    });
  }

  async searchFolders(tokens: string[], limit: number): Promise<string[]> {
    return this.searchInternal(tokens, limit, true);
  }

  async searchByIndex(tokens: string[], limit: number): Promise<string[]> {
    return this.searchInternal(tokens, limit, false);
  }

  private async searchInternal(
    tokens: string[],
    limit: number,
    dirsOnly: boolean,
  ): Promise<string[]> {
    // Cold-start: kick the background walk and serve this query from a live
    // BFS so the user gets results in the first few seconds. Subsequent
    // queries hit the index.
    if (indexDb.isEmpty()) {
      this.kickRebuildOnce();
      return bfsSearch({
        roots: [os.homedir()],
        tokens,
        limit,
        maxDepth: 6,
        dirsOnly,
      });
    }
    // Warm: query the index. If a rebuild has been pending for a while, kick
    // a refresh in the background — staleness is acceptable for name search.
    const STALE_MS = 6 * 60 * 60 * 1000;
    if (Date.now() - indexDb.getLastBuildMs() > STALE_MS) {
      this.kickRebuildOnce();
    }
    return indexDb.search(tokens, limit, dirsOnly);
  }

  playAttentionSound(): void {
    /* no-op until a bundled sound + paplay/canberra impl lands */
  }

  async chromePath(): Promise<string | null> {
    // GUI apps don't inherit the user's shell PATH, but Chrome installs land
    // in system dirs already on the minimal PATH. Probe the common command
    // names in priority order; first one `which` resolves wins.
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      const p = await which(name);
      if (p) return p;
    }
    return null;
  }

  // fm-b5at.6 — Wayland gives us no foreign-window control; X11 needs a WM
  // tool. Mirrors the synchronous capability flag so the renderer's gating
  // and this async probe agree.
  async canArrangeWindows(): Promise<'ok' | 'no-permission' | 'unsupported'> {
    if (isWayland()) return 'unsupported';
    return hasWmTool() ? 'ok' : 'unsupported';
  }

  // Position the most-recently-active Chrome window into `rect` using wmctrl
  // (fallback xdotool). We match Chrome by window class so we don't touch our
  // own window, and act on the single most-recently-active match — never
  // every Chrome window. On Wayland this is structurally impossible → return
  // 'unsupported' and let the orchestrator fall back to own-window-only.
  async arrangeChromeLeft(rect: ArrangeRect): Promise<ArrangeResult> {
    if (isWayland()) return { ok: false, reason: 'unsupported' };
    const wmctrl = await which('wmctrl');
    const { x, y, width, height } = rect;
    if (wmctrl) {
      // -l -x lists windows with WM_CLASS; Chrome's class is
      // "*.Google-chrome". The last matching line is the most recently
      // stacked/active window in wmctrl's listing order. We then -r by its
      // 0x id and -e a gravity/geometry move-resize on exactly that window.
      const id = await chromeWindowId(wmctrl);
      if (!id) return { ok: false, reason: 'no-chrome-window' };
      const geom = `0,${Math.round(x)},${Math.round(y)},${Math.round(width)},${Math.round(height)}`;
      // Clear maximized state first so -e geometry is honored.
      await run(wmctrl, ['-i', '-r', id, '-b', 'remove,maximized_vert,maximized_horz']);
      const ok = await run(wmctrl, ['-i', '-r', id, '-e', geom]);
      return ok ? { ok: true } : { ok: false, reason: 'no-chrome-window' };
    }
    const xdotool = await which('xdotool');
    if (xdotool) {
      // search returns ids oldest→newest; the last is most recently mapped.
      const out = await runOut(xdotool, ['search', '--class', 'google-chrome']);
      const ids = out.trim().split('\n').filter(Boolean);
      const id = ids[ids.length - 1];
      if (!id) return { ok: false, reason: 'no-chrome-window' };
      await run(xdotool, ['windowmove', id, String(Math.round(x)), String(Math.round(y))]);
      const ok = await run(xdotool, ['windowsize', id, String(Math.round(width)), String(Math.round(height))]);
      return ok ? { ok: true } : { ok: false, reason: 'no-chrome-window' };
    }
    return { ok: false, reason: 'unsupported' };
  }
}

// Wayland can't move foreign windows from a sandboxed client; X11 can.
function isWayland(): boolean {
  return (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' ||
    !!process.env.WAYLAND_DISPLAY;
}

// Synchronous PATH probe so the (sync) capability flag can include it. We
// check the common bin dirs for wmctrl/xdotool. Cached after first call.
let _wmToolCache: boolean | null = null;
function hasWmTool(): boolean {
  if (_wmToolCache !== null) return _wmToolCache;
  const dirs = (process.env.PATH || '/usr/bin:/usr/local/bin:/bin').split(':');
  const found = ['wmctrl', 'xdotool'].some((tool) =>
    dirs.some((d) => {
      try { return existsSync(`${d}/${tool}`); } catch { return false; }
    }),
  );
  _wmToolCache = found;
  return found;
}

function chromeWindowId(wmctrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(wmctrl, ['-l', '-x'], { timeout: 4000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      // Lines: "0x04200007  0 Google-chrome.Google-chrome host  Title"
      const matches = stdout
        .split('\n')
        .filter((l) => /google-chrome|chromium/i.test(l));
      const last = matches[matches.length - 1];
      if (!last) { resolve(null); return; }
      resolve(last.trim().split(/\s+/)[0] || null);
    });
  });
}

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000 }, (err) => resolve(!err));
  });
}

function runOut(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => resolve(err ? '' : stdout || ''));
  });
}

function which(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    // `command` is a shell builtin, so run it through sh. name is from a
    // fixed allow-list (no user input), so the interpolation is safe.
    execFile('/bin/sh', ['-c', `command -v ${name}`], (err, stdout) => {
      const p = (stdout || '').trim().split('\n')[0] || '';
      resolve(!err && p ? p : null);
    });
  });
}
