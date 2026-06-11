import { execFile } from 'node:child_process';
import os from 'node:os';
import type { Capabilities, PlatformAdapter } from './index';
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
