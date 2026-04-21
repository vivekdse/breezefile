import { contextBridge, ipcRenderer } from 'electron';

const fm = {
  platform: process.platform,
  versions: process.versions,
  homedir: () => ipcRenderer.invoke('fs:homedir') as Promise<string>,
  readdir: (p: string) => ipcRenderer.invoke('fs:readdir', p),
  stat: (p: string) => ipcRenderer.invoke('fs:stat', p),
  mkdir: (p: string) => ipcRenderer.invoke('fs:mkdir', p),
  rename: (from: string, to: string) => ipcRenderer.invoke('fs:rename', from, to),
  trash: (paths: string[]) => ipcRenderer.invoke('fs:trash', paths),
  touch: (p: string) => ipcRenderer.invoke('fs:touch', p),
  paste: (
    ops: {
      src: string;
      dst: string;
      mode: 'copy' | 'move' | 'symlink' | 'symlinkRel' | 'hardlink';
      overwrite?: boolean;
    }[],
  ) => ipcRenderer.invoke('fs:paste', ops),
  reveal: (p: string) => ipcRenderer.invoke('shell:reveal', p),
  openTerminal: (cwd: string) => ipcRenderer.invoke('shell:openTerminal', cwd),
  runCommand: (cwd: string, cmd: string) => ipcRenderer.invoke('shell:runCommand', cwd, cmd),
  open: (p: string) => ipcRenderer.invoke('shell:open', p),
  openWith: (p: string, appName: string) => ipcRenderer.invoke('shell:openWith', p, appName),
  clipboardWrite: (p: string) => ipcRenderer.invoke('shell:clipboardWrite', p),
  thumb: (p: string, size: number) =>
    ipcRenderer.invoke('thumb:get', p, size) as Promise<string | null>,
  readTextFile: (p: string, maxBytes?: number) =>
    ipcRenderer.invoke('fs:readTextFile', p, maxBytes) as Promise<{
      content: string;
      truncated: boolean;
      bytes: number;
      error?: string;
    }>,
  // Encode an absolute path into an asset:// URL for <img src>/<video src>.
  // The renderer is served from http://localhost in dev, which makes
  // file:// URLs cross-origin and blocked. A custom app-scoped `asset://`
  // scheme (registered in electron/main.ts) streams file bytes from disk
  // with proper Content-Type. Path segments are percent-encoded so names
  // with spaces / unicode / reserved characters survive URL parsing.
  fileUrl: (p: string): string => {
    const parts = p.split('/').map((seg) => encodeURIComponent(seg));
    // Absolute POSIX paths start with '/', so parts[0] === '' — joining
    // with '/' yields `asset://` + `/Users/…` = `asset:///Users/…`.
    return 'asset://' + parts.join('/');
  },
  bulkRename: (names: string[]) =>
    ipcRenderer.invoke('editor:bulkRename', names) as Promise<string[]>,
  dragStart: (paths: string[]) => ipcRenderer.send('drag:start', paths),
  findFolders: (query: string, limit?: number) =>
    ipcRenderer.invoke('search:folders', query, limit) as Promise<string[]>,
};

contextBridge.exposeInMainWorld('fm', fm);

export type FmApi = typeof fm;
