// Platform adapter layer. See docs/cross-platform-strategy.md.
//
// All OS-coupled work goes through PlatformAdapter. IPC handlers and renderer
// code never branch on `process.platform` — they ask the adapter or read the
// capability manifest.

export type FindHit = {
  path: string;
  name: string;
  isDir: boolean;
  tier: 'local' | 'index';
};

export type Capabilities = {
  spotlightSearch: boolean;
  externalVolumes: boolean;
  cloudMounts: boolean;
  attentionSound: boolean;
  dockBadge: boolean;
  share: boolean;
  colorTags: boolean;
  quickLook: boolean;
  openWithLauncher: boolean;
  vibrancy: boolean;
};

export interface PlatformAdapter {
  readonly id: 'mac' | 'linux';
  capabilities(): Capabilities;

  // Folder-name search across the user's home (sidebar quick-jump). Returns
  // absolute paths of directories whose name matches all tokens. Empty list
  // when the platform has no index — callers fall back to BFS / curated.
  searchFolders(tokens: string[], limit: number): Promise<string[]>;

  // Generic name search across the user's home — used by the Find overlay to
  // broaden beyond the bounded local BFS. May return files OR folders.
  searchByIndex(tokens: string[], limit: number): Promise<string[]>;

  // Best-effort attention sound for background-task completion.
  playAttentionSound(): void;
}

import { MacAdapter } from './mac';
import { LinuxAdapter } from './linux';

let _current: PlatformAdapter | null = null;
export function platform(): PlatformAdapter {
  if (_current) return _current;
  _current = process.platform === 'darwin' ? new MacAdapter() : new LinuxAdapter();
  return _current;
}
