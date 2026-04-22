import type { Entry } from './types';

type Fm = {
  platform: NodeJS.Platform;
  versions: NodeJS.ProcessVersions;
  homedir: () => Promise<string>;
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
  ) => Promise<void>;
  reveal: (p: string) => Promise<void>;
  openTerminal: (cwd: string) => Promise<void>;
  runCommand: (cwd: string, cmd: string) => Promise<void>;
  open: (p: string, appPath?: string) => Promise<void>;
  openWith: (p: string, appName: string) => Promise<void>;
  pickApplication: () => Promise<string | null>;
  getBindings: () => Promise<Record<string, string>>;
  setBinding: (ext: string, appPath: string) => Promise<void>;
  clearBinding: (ext: string) => Promise<void>;
  clipboardWrite: (p: string) => Promise<void>;
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
  checkUpdate: () => Promise<{
    tag: string;
    version: string;
    url: string;
    body: string;
    publishedAt: string | null;
  } | null>;
};

declare global {
  interface Window {
    fm: Fm;
  }
}

export const fm: Fm = window.fm;
