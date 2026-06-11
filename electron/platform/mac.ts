import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import type { Capabilities, PlatformAdapter } from './index';

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
}
