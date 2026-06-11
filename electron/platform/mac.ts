import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import type { ArrangeRect, ArrangeResult, Capabilities, PlatformAdapter } from './index';

export class MacAdapter implements PlatformAdapter {
  readonly id = 'mac' as const;

  capabilities(): Capabilities {
    return {
      spotlightSearch: true,
      externalVolumes: true,
      cloudMounts: true,
      attentionSound: true,
      dockBadge: true,
      share: true,
      colorTags: true,
      quickLook: true,
      openWithLauncher: true,
      vibrancy: true,
      // Mac can drive other apps' windows via System Events; the *permission*
      // (Accessibility) is checked separately in canArrangeWindows().
      windowArrange: true,
    };
  }

  async searchFolders(tokens: string[], limit: number): Promise<string[]> {
    if (tokens.length === 0) return [];
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
          resolve(lines.slice(0, limit));
        },
      );
    });
  }

  async searchByIndex(tokens: string[], limit: number): Promise<string[]> {
    if (tokens.length === 0) return [];
    const nameClauses = tokens
      .map((t) => `kMDItemDisplayName == "*${t.replace(/"/g, '')}*"c`)
      .join(' && ');
    const home = os.homedir();
    return new Promise((resolve) => {
      execFile(
        'mdfind',
        ['-onlyin', home, nameClauses],
        { maxBuffer: 2 * 1024 * 1024, timeout: 3000 },
        (err, stdout) => {
          if (err) { resolve([]); return; }
          const lines = stdout.split('\n').filter((l) => l.length > 0);
          resolve(lines.slice(0, limit));
        },
      );
    });
  }

  playAttentionSound(): void {
    try {
      spawn('afplay', ['/System/Library/Sounds/Ping.aiff'], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } catch {
      /* best-effort */
    }
  }

  async chromePath(): Promise<string | null> {
    const standard =
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (existsSync(standard)) return standard;
    // Fallback: locate via Spotlight in case it lives elsewhere (e.g. a
    // per-user ~/Applications install). Resolve the bundle to its binary.
    return new Promise((resolve) => {
      execFile(
        'mdfind',
        ['kMDItemCFBundleIdentifier == "com.google.Chrome"'],
        { timeout: 3000 },
        (err, stdout) => {
          if (err) { resolve(null); return; }
          const app = stdout.split('\n').find((l) => l.endsWith('.app'));
          if (!app) { resolve(null); return; }
          const bin = `${app}/Contents/MacOS/Google Chrome`;
          resolve(existsSync(bin) ? bin : null);
        },
      );
    });
  }

  // fm-b5at.6 — probe whether System Events will let us drive other apps'
  // windows. We deliberately ask for something innocuous (the count of
  // System Events processes); without Accessibility the unsigned app gets
  // AppleScript error -1719 ("not allowed assistive access"), which we map
  // to 'no-permission'. We stay electron-free here (mac.ts imports only node),
  // so the orchestrator that owns Electron doesn't have to feed us a flag.
  async canArrangeWindows(): Promise<'ok' | 'no-permission' | 'unsupported'> {
    const script = 'tell application "System Events" to count processes';
    return new Promise((resolve) => {
      execFile('osascript', ['-e', script], { timeout: 4000 }, (err, _out, stderr) => {
        if (!err) { resolve('ok'); return; }
        const msg = `${stderr || ''} ${(err as Error).message || ''}`;
        if (/-1719|not allowed|assistive access|accessibility/i.test(msg)) {
          resolve('no-permission');
        } else {
          // Some other failure (osascript missing, timeout). Treat as
          // no-permission so the UI offers the recovery affordance rather
          // than silently doing nothing.
          resolve('no-permission');
        }
      });
    });
  }

  // Position the frontmost Google Chrome window into `rect`. `window 1` of
  // process "Google Chrome" is the front (most-recently-active) window, so we
  // touch exactly one window — never every profile/window.
  async arrangeChromeLeft(rect: ArrangeRect): Promise<ArrangeResult> {
    const { x, y, width, height } = rect;
    // Two-step (position then size) via System Events. `window 1` is the
    // front window. If Chrome has no windows we surface 'no-chrome-window'.
    const script = [
      'tell application "System Events"',
      '  if not (exists process "Google Chrome") then error "no-chrome-process"',
      '  tell process "Google Chrome"',
      '    if (count of windows) is 0 then error "no-chrome-window"',
      `    set position of window 1 to {${Math.round(x)}, ${Math.round(y)}}`,
      `    set size of window 1 to {${Math.round(width)}, ${Math.round(height)}}`,
      '  end tell',
      'end tell',
    ].join('\n');
    return new Promise((resolve) => {
      execFile('osascript', ['-e', script], { timeout: 5000 }, (err, _out, stderr) => {
        if (!err) { resolve({ ok: true }); return; }
        const msg = `${stderr || ''} ${(err as Error).message || ''}`;
        if (/-1719|not allowed|assistive access|accessibility/i.test(msg)) {
          resolve({ ok: false, reason: 'no-permission' });
        } else if (/no-chrome-window|no-chrome-process|-1728/i.test(msg)) {
          resolve({ ok: false, reason: 'no-chrome-window' });
        } else {
          resolve({ ok: false, reason: 'no-chrome-window' });
        }
      });
    });
  }
}
