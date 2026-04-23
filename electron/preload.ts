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
  listTerminals: () => ipcRenderer.invoke('shell:listTerminals') as Promise<string[]>,
  getDefaultTerminal: () =>
    ipcRenderer.invoke('shell:getDefaultTerminal') as Promise<string | null>,
  setDefaultTerminal: (bundle: string | null) =>
    ipcRenderer.invoke('shell:setDefaultTerminal', bundle) as Promise<void>,
  runCommand: (cwd: string, cmd: string) => ipcRenderer.invoke('shell:runCommand', cwd, cmd),
  compress: (sources: string[], cwd: string) =>
    ipcRenderer.invoke('shell:compress', sources, cwd) as Promise<string>,
  extract: (archives: string[], cwd: string) =>
    ipcRenderer.invoke('shell:extract', archives, cwd) as Promise<string[]>,
  open: (p: string, appPath?: string) => ipcRenderer.invoke('app:open', p, appPath),
  openWith: (p: string, appName: string) => ipcRenderer.invoke('shell:openWith', p, appName),
  pickApplication: () => ipcRenderer.invoke('app:pickApplication') as Promise<string | null>,
  getBindings: () => ipcRenderer.invoke('bindings:get') as Promise<Record<string, string>>,
  setBinding: (ext: string, appPath: string) => ipcRenderer.invoke('bindings:set', ext, appPath),
  clearBinding: (ext: string) => ipcRenderer.invoke('bindings:clear', ext),
  clipboardWrite: (p: string) => ipcRenderer.invoke('shell:clipboardWrite', p),
  share: (paths: string[], anchor: { x: number; y: number; w: number; h: number }) =>
    ipcRenderer.invoke('shell:share', { paths, anchor }) as Promise<void>,
  shareHelperAvailable: () =>
    ipcRenderer.invoke('shell:shareHelperAvailable') as Promise<boolean>,
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
    // Standard schemes require a host, so we use a fixed sentinel host
    // `local`; otherwise Chromium promotes the first path segment to the
    // host (and lowercases it), turning `/Users/...` into `asset://users/...`
    // which 404s when the handler tries to read case-sensitive paths.
    const parts = p.split('/').map((seg) => encodeURIComponent(seg));
    return 'asset://local' + parts.join('/');
  },
  bulkRename: (names: string[]) =>
    ipcRenderer.invoke('editor:bulkRename', names) as Promise<string[]>,
  dragStart: (paths: string[]) => ipcRenderer.send('drag:start', paths),
  findFolders: (query: string, limit?: number) =>
    ipcRenderer.invoke('search:folders', query, limit) as Promise<string[]>,
  listSubdirs: (cwd: string, depth?: number, limit?: number) =>
    ipcRenderer.invoke('fs:listSubdirs', cwd, depth, limit) as Promise<string[]>,
  findEntries: (roots: string[], query: string, limit?: number) =>
    ipcRenderer.invoke('fs:findEntries', roots, query, limit) as Promise<
      Array<{ path: string; name: string; isDir: boolean; tier: 'local' | 'spotlight' }>
    >,
  openPrivacyPane: (pane?: 'files' | 'fullDisk') =>
    ipcRenderer.invoke('shell:openPrivacyPane', pane) as Promise<void>,
  primePermissions: () =>
    ipcRenderer.invoke('permissions:prime') as Promise<
      Record<string, 'granted' | 'denied' | 'missing'>
    >,
  checkUpdate: () =>
    ipcRenderer.invoke('app:checkUpdate') as Promise<{
      tag: string;
      version: string;
      url: string;
      body: string;
      publishedAt: string | null;
    } | null>,
};

contextBridge.exposeInMainWorld('fm', fm);

export type FmApi = typeof fm;
