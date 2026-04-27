import type { Entry, Task, TaskCreate, TaskFilter, TaskUpdate } from './types';

type Fm = {
  platform: NodeJS.Platform;
  versions: NodeJS.ProcessVersions;
  homedir: () => Promise<string>;
  listLocations: () => Promise<
    Array<{
      id: string;
      label: string;
      path: string;
      icon: 'drive' | 'usb' | 'folder';
      kind: 'boot' | 'external' | 'cloud' | 'icloud';
      usedPct?: number;
      caption: string;
    }>
  >;
  readdir: (p: string) => Promise<Entry[]>;
  stat: (p: string) => Promise<{ size: number; mtimeMs: number; isDir: boolean }>;
  mkdir: (p: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  trash: (paths: string[]) => Promise<void>;
  touch: (p: string) => Promise<void>;
  paste: (
    ops: {
      src: string;
      dst: string;
      mode: 'copy' | 'move' | 'symlink' | 'symlinkRel' | 'hardlink';
      overwrite?: boolean;
    }[],
  ) => Promise<{ renamed: number }>;
  reveal: (p: string) => Promise<void>;
  openTerminal: (cwd: string) => Promise<void>;
  listTerminals: () => Promise<string[]>;
  getDefaultTerminal: () => Promise<string | null>;
  setDefaultTerminal: (bundle: string | null) => Promise<void>;
  runCommand: (cwd: string, cmd: string) => Promise<void>;
  compress: (sources: string[], cwd: string) => Promise<string>;
  extract: (archives: string[], cwd: string) => Promise<string[]>;
  open: (p: string, appPath?: string) => Promise<void>;
  openWith: (p: string, appName: string) => Promise<void>;
  pickApplication: () => Promise<string | null>;
  getBindings: () => Promise<Record<string, string>>;
  setBinding: (ext: string, appPath: string) => Promise<void>;
  clearBinding: (ext: string) => Promise<void>;
  clipboardWrite: (p: string) => Promise<void>;
  share: (
    paths: string[],
    anchor: { x: number; y: number; w: number; h: number },
  ) => Promise<void>;
  shareHelperAvailable: () => Promise<boolean>;
  thumb: (p: string, size: number) => Promise<string | null>;
  readTextFile: (
    p: string,
    maxBytes?: number,
  ) => Promise<{ content: string; truncated: boolean; bytes: number; error?: string }>;
  fileUrl: (p: string) => string;
  bulkRename: (names: string[]) => Promise<string[]>;
  dragStart: (paths: string[]) => void;
  findFolders: (query: string, limit?: number) => Promise<string[]>;
  listSubdirs: (cwd: string, depth?: number, limit?: number) => Promise<string[]>;
  findEntries: (
    roots: string[],
    query: string,
    limit?: number,
  ) => Promise<Array<{ path: string; name: string; isDir: boolean; tier: 'local' | 'spotlight' }>>;
  openPrivacyPane: (pane?: 'files' | 'fullDisk') => Promise<void>;
  primePermissions: () => Promise<Record<string, 'granted' | 'denied' | 'missing'>>;
  checkUpdate: () => Promise<{
    tag: string;
    version: string;
    url: string;
    body: string;
    publishedAt: string | null;
  } | null>;
  upgrade: () => Promise<{ ok: boolean; mode: 'inline' | 'terminal' }>;
  termSpawn: (opts: {
    cwd: string;
    cols?: number;
    rows?: number;
    shell?: string;
    args?: string[];
    env?: Record<string, string>;
  }) => Promise<number>;
  termWrite: (id: number, data: string) => void;
  termResize: (id: number, cols: number, rows: number) => void;
  termKill: (id: number, signal?: string) => Promise<void>;
  termStatus: (id: number) => Promise<{ alive: boolean; pid: number | null }>;
  onTermData: (cb: (id: number, data: string) => void) => () => void;
  onTermExit: (
    cb: (id: number, code: number, signal: string | null) => void,
  ) => () => void;
  launchersList: () => Promise<Launcher[]>;
  launchersSave: (list: Launcher[]) => Promise<void>;
  launchersConfigPath: () => Promise<string>;
  launchersRevealConfig: () => Promise<void>;
  // fm-dhc — task store
  tasksList: (filter?: TaskFilter) => Promise<Task[]>;
  tasksGet: (id: string) => Promise<Task | null>;
  tasksCreate: (input: TaskCreate) => Promise<Task>;
  tasksUpdate: (id: string, patch: TaskUpdate) => Promise<Task>;
  tasksDelete: (id: string) => Promise<void>;
  tasksCountByFolder: (folder: string) => Promise<number>;
  tasksDbExists: () => Promise<boolean>;
  // fm-adc — write the per-task sidecar markdown for AI launchers
  tasksWriteActiveSidecar: (id: string) => Promise<string | null>;
  onTasksChanged: (cb: () => void) => () => void;
};

export type Launcher = {
  id: string;
  label: string;
  aliases: string[];
  command: string;
  args?: string[];
  description?: string;
  // fm-e66 — named flag combinations layered on top of `args`. When a
  // launcher has variants the chip-prompt verb gains a "Mode" slot so the
  // user picks the modifier (e.g. claude --continue, claude
  // --dangerously-skip-permissions) without typing it. Bare = no extra
  // flags. Absent = no slot, behave exactly as before.
  variants?: Array<{
    id: string;
    label: string;
    args?: string[];
    description?: string;
  }>;
};

declare global {
  interface Window {
    fm: Fm;
  }
}

export const fm: Fm = window.fm;
