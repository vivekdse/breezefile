import { contextBridge, ipcRenderer, webUtils } from 'electron';

// task-ab1d7955e23f — TypeBuild Project as it crosses the bridge (camelCase;
// mirrors src/types.ts `Project`). Inlined here because preload carries no
// shared-type imports. NON-PHI.
type Project = {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  parentProjectId: string | null;
  folders: string[];
  createdBy: string | null;
  groupId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  effectiveInstructions?: string;
};

// One credential-vault entry as it crosses the bridge (NAMES only — never a
// value). `key` is the "me."-prefixed field; `secret` marks write-only fields
// (ssn/dob/bank_account) the server's resolver refuses to reveal. Inlined here
// for the same reason as Project (preload carries no shared-type imports);
// mirrors `VaultEntry` in electron/typebuild/user-vault.ts. NON-PHI (names only).
type VaultEntry = {
  key: string;
  secret: boolean;
};

const fm = {
  platform: process.platform,
  versions: process.versions,
  capabilities: () =>
    ipcRenderer.invoke('platform:capabilities') as Promise<{
      id: 'mac' | 'linux' | 'windows';
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
      windowArrange: boolean;
    }>,
  homedir: () => ipcRenderer.invoke('fs:homedir') as Promise<string>,
  listLocations: () =>
    ipcRenderer.invoke('fs:listLocations') as Promise<
      Array<{
        id: string;
        label: string;
        path: string;
        icon: 'drive' | 'usb' | 'folder';
        kind: 'boot' | 'external' | 'cloud' | 'icloud';
        usedPct?: number;
        caption: string;
      }>
    >,
  readdir: (p: string) => ipcRenderer.invoke('fs:readdir', p),
  stat: (p: string) => ipcRenderer.invoke('fs:stat', p),
  mkdir: (p: string) => ipcRenderer.invoke('fs:mkdir', p),
  rename: (from: string, to: string) => ipcRenderer.invoke('fs:rename', from, to),
  trash: (paths: string[]) => ipcRenderer.invoke('fs:trash', paths),
  permanentDelete: (paths: string[]) =>
    ipcRenderer.invoke('fs:permanent-delete', paths),
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
  openUrl: (url: string) => ipcRenderer.invoke('app:openUrl', url) as Promise<void>,
  windowToggleMaximize: () =>
    ipcRenderer.invoke('window:toggleMaximize') as Promise<void>,
  windowToggleFullscreen: () =>
    ipcRenderer.invoke('window:toggleFullscreen') as Promise<void>,
  windowChatResize: (open: boolean, panelWidth: number) =>
    ipcRenderer.invoke('window:chatResize', open, panelWidth) as Promise<void>,
  openWith: (p: string, appName: string) => ipcRenderer.invoke('shell:openWith', p, appName),
  pickApplication: () => ipcRenderer.invoke('app:pickApplication') as Promise<string | null>,
  pickFolder: (defaultPath?: string) =>
    ipcRenderer.invoke('app:pickFolder', defaultPath) as Promise<string | null>,
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
  editorOpen: (p: string) =>
    ipcRenderer.invoke('editor:openFile', p) as Promise<{
      content: string;
      mtimeMs: number;
      error?: string;
    }>,
  editorSave: (p: string, content: string, expectedMtimeMs: number | null) =>
    ipcRenderer.invoke('editor:saveFile', p, content, expectedMtimeMs) as Promise<{
      mtimeMs: number;
      conflict?: boolean;
      error?: string;
    }>,
  // fm-mdwatch — watch/unwatch an open editor file for external edits, and
  // subscribe to change notifications. The editor uses this to live-refresh
  // when an agent edits the file from the chat panel.
  editorWatch: (p: string) =>
    ipcRenderer.invoke('editor:watch', p) as Promise<void>,
  editorUnwatch: (p: string) =>
    ipcRenderer.invoke('editor:unwatch', p) as Promise<void>,
  onEditorFileChanged: (cb: (p: string, mtimeMs: number) => void) => {
    const handler = (_e: unknown, payload: { path: string; mtimeMs: number }) =>
      cb(payload.path, payload.mtimeMs);
    ipcRenderer.on('editor:fileChanged', handler);
    return () => ipcRenderer.off('editor:fileChanged', handler);
  },
  dragStart: (paths: string[]) => ipcRenderer.send('drag:start', paths),
  // Electron 32+ removed the `path` field from renderer File objects; the
  // sanctioned replacement is webUtils.getPathForFile, which lives in the
  // preload-side electron module. Expose it so drop targets in the
  // renderer (e.g. the embedded terminal) can resolve dropped Finder
  // files to absolute paths.
  pathForFile: (file: File): string => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
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
  upgrade: () =>
    ipcRenderer.invoke('app:upgrade') as Promise<{
      ok: boolean;
      mode: 'inline' | 'terminal' | 'browser';
    }>,
  // ─── Embedded terminal (fm-jtu) ───────────────────────────────────
  termSpawn: (opts: {
    cwd: string;
    cols?: number;
    rows?: number;
    shell?: string;
    args?: string[];
    env?: Record<string, string>;
    remoteAttach?: { target: string; ttlSec?: number };
  }) => ipcRenderer.invoke('term:spawn', opts) as Promise<number>,
  remoteListTargets: () =>
    ipcRenderer.invoke('remote:list-targets') as Promise<string[]>,
  termWrite: (id: number, data: string) => ipcRenderer.send('term:write', id, data),
  // SPIKE (spike/playwright-cdp): agent-overlay window mirrors a pty's stream.
  termMirror: (id: number) => ipcRenderer.send('term:mirror', id),
  termUnmirror: (id: number) => ipcRenderer.send('term:unmirror', id),
  // SPIKE (spike/playwright-cdp): the in-browser chat widget drives its own
  // WebContentsView bounds — drag by a delta, resize to panel/bubble.
  overlayMove: (dx: number, dy: number) => ipcRenderer.send('overlay:move', dx, dy),
  overlayResize: (width: number, height: number) =>
    ipcRenderer.send('overlay:resize', width, height),
  termResize: (id: number, cols: number, rows: number) =>
    ipcRenderer.send('term:resize', id, cols, rows),
  termKill: (id: number, signal?: string) =>
    ipcRenderer.invoke('term:kill', id, signal) as Promise<void>,
  termStatus: (id: number) =>
    ipcRenderer.invoke('term:status', id) as Promise<{
      alive: boolean;
      pid: number | null;
    }>,
  // Subscribe to data/exit events. Returns an unsubscribe fn.
  onTermData: (cb: (id: number, data: string) => void) => {
    const handler = (_e: unknown, payload: { id: number; data: string }) =>
      cb(payload.id, payload.data);
    ipcRenderer.on('term:data', handler);
    return () => ipcRenderer.off('term:data', handler);
  },
  onTermExit: (
    cb: (id: number, code: number, signal: string | null) => void,
  ) => {
    const handler = (
      _e: unknown,
      payload: { id: number; code: number; signal: string | null },
    ) => cb(payload.id, payload.code, payload.signal);
    ipcRenderer.on('term:exit', handler);
    return () => ipcRenderer.off('term:exit', handler);
  },
  // ─── SPIKE (spike/playwright-cdp): embedded browser-view control. Mirrors
  // the term:* shape — invoke for create/destroy, send for fire-and-forget
  // bounds/nav, on() for state pushes. See electron/ipc.ts browser:* handlers.
  browserAttach: (opts: { url?: string }) =>
    ipcRenderer.invoke('browser:attach', opts) as Promise<number>,
  browserBounds: (
    id: number,
    rect: {
      x: number;
      y: number;
      width: number;
      height: number;
      winW: number;
      winH: number;
    },
  ) => ipcRenderer.send('browser:bounds', id, rect),
  browserHide: (id: number) => ipcRenderer.send('browser:hide', id),
  browserDestroy: (id: number) =>
    ipcRenderer.invoke('browser:destroy', id) as Promise<void>,
  browserNavigate: (id: number, url: string) =>
    ipcRenderer.send('browser:navigate', id, url),
  browserBack: (id: number) => ipcRenderer.send('browser:back', id),
  browserForward: (id: number) => ipcRenderer.send('browser:forward', id),
  browserReload: (id: number) => ipcRenderer.send('browser:reload', id),
  browserSync: (id: number) => ipcRenderer.send('browser:sync', id),
  onBrowserState: (
    cb: (s: {
      id: number;
      url: string;
      title: string;
      canGoBack: boolean;
      canGoForward: boolean;
    }) => void,
  ) => {
    const handler = (_e: unknown, payload: Parameters<typeof cb>[0]) =>
      cb(payload);
    ipcRenderer.on('browser:state', handler);
    return () => ipcRenderer.off('browser:state', handler);
  },
  // SPIKE (spike/playwright-cdp): main → renderer request to OPEN a browser
  // tab (e.g. the `playwright` task flag opens one for the agent to drive).
  onBrowserOpen: (cb: (s: { url?: string }) => void) => {
    const handler = (_e: unknown, payload: { url?: string }) => cb(payload);
    ipcRenderer.on('browser:open', handler);
    return () => ipcRenderer.off('browser:open', handler);
  },
  // fm-z7v — process-tree foreground transitions for tab busy/idle tint.
  // `state` is the rich tri-state ('busy'|'idle'|'waiting'); 'waiting'
  // is a mid-turn attention request (Claude permission prompt). `busy`
  // is kept for older callers that only need the binary signal.
  onTermFg: (
    cb: (
      id: number,
      busy: boolean,
      comm: string | null,
      state?: 'busy' | 'idle' | 'waiting',
    ) => void,
  ) => {
    const handler = (
      _e: unknown,
      payload: {
        id: number;
        busy: boolean;
        comm: string | null;
        state?: 'busy' | 'idle' | 'waiting';
      },
    ) => cb(payload.id, payload.busy, payload.comm, payload.state);
    ipcRenderer.on('term:fg', handler);
    return () => ipcRenderer.off('term:fg', handler);
  },
  // ─── Launchers (fm-g6r) ───────────────────────────────────────────
  launchersList: () =>
    ipcRenderer.invoke('launchers:list') as Promise<
      Array<{
        id: string;
        label: string;
        aliases: string[];
        command: string;
        args?: string[];
        description?: string;
      }>
    >,
  launchersSave: (
    list: Array<{
      id: string;
      label: string;
      aliases: string[];
      command: string;
      args?: string[];
      description?: string;
    }>,
  ) => ipcRenderer.invoke('launchers:save', list) as Promise<void>,
  launchersConfigPath: () =>
    ipcRenderer.invoke('launchers:configPath') as Promise<string>,
  launchersRevealConfig: () =>
    ipcRenderer.invoke('launchers:revealConfig') as Promise<void>,
  // ─── Tasks (fm-dhc) ───────────────────────────────────────────────
  tasksList: (filter?: unknown) => ipcRenderer.invoke('tasks:list', filter),
  tasksGet: (id: string, source?: string) =>
    ipcRenderer.invoke('tasks:get', id, source),
  tasksCreate: (input: unknown, source?: string) =>
    ipcRenderer.invoke('tasks:create', input, source),
  tasksUpdate: (id: string, patch: unknown, source?: string) =>
    ipcRenderer.invoke('tasks:update', id, patch, source),
  tasksDelete: (id: string, source?: string) =>
    ipcRenderer.invoke('tasks:delete', id, source),
  // ── TaskSource providers (fm-b5at.1) ──
  tasksSources: () => ipcRenderer.invoke('tasks:sources'),
  tasksSourceAction: (
    source: string,
    taskId: string,
    action: string,
    payload?: unknown,
  ) => ipcRenderer.invoke('tasks:sourceAction', source, taskId, action, payload),
  // ── Schedule overlay for remote-source tasks (fm-b5at.8) ──
  tasksOverlaySet: (source: string, taskId: string, cron: string) =>
    ipcRenderer.invoke('tasks:overlaySet', source, taskId, cron),
  tasksOverlayClear: (source: string, taskId: string) =>
    ipcRenderer.invoke('tasks:overlayClear', source, taskId),
  tasksOverlayList: () => ipcRenderer.invoke('tasks:overlayList'),
  // ── Multi-source (breezed P4) ──
  sourcesList: () => ipcRenderer.invoke('sources:list'),
  sourcesConnect: (host: string) => ipcRenderer.invoke('sources:connect', host),
  sourcesAutoAttach: (cwd: string) =>
    ipcRenderer.invoke('sources:auto-attach', cwd) as Promise<string | null>,
  sourcesDisconnect: (host: string) =>
    ipcRenderer.invoke('sources:disconnect', host),
  // fm-at5 — Claude Code integration reset
  claudeUnregisterHooks: () =>
    ipcRenderer.invoke('claude:unregister-hooks') as Promise<
      'removed' | 'absent' | 'error'
    >,
  onSourcesChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('sources:changed', handler);
    return () => ipcRenderer.off('sources:changed', handler);
  },
  tasksCountByFolder: (folder: string) => ipcRenderer.invoke('tasks:countByFolder', folder),
  tasksDbExists: () => ipcRenderer.invoke('tasks:dbExists') as Promise<boolean>,
  // ─── External-API control bridge (fm-9fd) ─────────────────────────
  // The HTTP server in main delegates app-level commands (navigate,
  // openTaskTab, launch, listTabs) to the renderer because state.tabs
  // lives there. Renderer subscribes via onControlRequest, replies with
  // sendControlReply matched by reqId.
  onControlRequest: (
    cb: (req: { reqId: string; kind: string; [k: string]: unknown }) => void,
  ) => {
    const handler = (
      _e: unknown,
      payload: { reqId: string; kind: string; [k: string]: unknown },
    ) => cb(payload);
    ipcRenderer.on('control:request', handler);
    return () => ipcRenderer.off('control:request', handler);
  },
  sendControlReply: (payload: {
    reqId: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  }) => ipcRenderer.send('control:reply', payload),
  tasksWriteActiveSidecar: (id: string, source?: string) =>
    ipcRenderer.invoke('tasks:writeActiveSidecar', id, source) as Promise<
      string | null
    >,
  onTasksChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('tasks:changed', handler);
    return () => ipcRenderer.off('tasks:changed', handler);
  },
  // Per-source failures from the tasks:list aggregation. The list itself stays
  // a bare array (so one source failing degrades gracefully rather than
  // throwing the whole fetch), but subscribers can surface which source broke
  // and why — instead of the failure vanishing into the main-process log.
  onTaskSourceError: (cb: (e: { source: string; message: string }) => void) => {
    const handler = (
      _: unknown,
      payload: { source: string; message: string },
    ) => cb(payload);
    ipcRenderer.on('tasks:sourceError', handler);
    return () => ipcRenderer.off('tasks:sourceError', handler);
  },
  // ─── Task runs (fm-zf3m) ──────────────────────────────────────────
  tasksRunsList: (taskId: string, limit?: number) =>
    ipcRenderer.invoke('tasks:runsList', taskId, limit),
  tasksRunsListAll: (limit?: number) =>
    ipcRenderer.invoke('tasks:runsListAll', limit),
  tasksRunsCountByTask: () => ipcRenderer.invoke('tasks:runsCountByTask'),
  tasksLastRun: (taskId: string) => ipcRenderer.invoke('tasks:lastRun', taskId),
  tasksRunNow: (taskId: string, source?: string) =>
    ipcRenderer.invoke('tasks:runNow', taskId, source),
  tasksRunNowAt: (taskId: string, cwd: string) =>
    ipcRenderer.invoke('tasks:runNowAt', taskId, cwd),
  tasksCancelRun: (runId: string) =>
    ipcRenderer.invoke('tasks:cancelRun', runId),
  onTaskRunsChanged: (cb: (taskId: string) => void) => {
    const handler = (_e: unknown, payload: { taskId: string }) => cb(payload.taskId);
    ipcRenderer.on('task-runs:changed', handler);
    return () => ipcRenderer.off('task-runs:changed', handler);
  },
  onTaskRunFailed: (cb: (payload: { taskId: string; body: string }) => void) => {
    const handler = (_e: unknown, p: { taskId: string; body: string }) => cb(p);
    ipcRenderer.on('task-runs:failed', handler);
    return () => ipcRenderer.off('task-runs:failed', handler);
  },
  // fm-h8g7 — task-notification surfaces (run success + remote transitions +
  // notification clicks). The transition feed is PHI-FREE: each entry carries
  // only the opaque task id, a transition kind, and the source id.
  onTaskRunSucceeded: (cb: (payload: { taskId: string }) => void) => {
    const handler = (_e: unknown, p: { taskId: string }) => cb(p);
    ipcRenderer.on('task-runs:succeeded', handler);
    return () => ipcRenderer.off('task-runs:succeeded', handler);
  },
  onTaskTransitions: (
    cb: (
      transitions: Array<{
        taskId: string;
        kind: 'new' | 'completed' | 'partial' | 'cancelled' | 'blocked' | 'claim-lost';
        source: string;
      }>,
    ) => void,
  ) => {
    const handler = (
      _e: unknown,
      p: Array<{ taskId: string; kind: string; source: string }>,
    ) =>
      cb(
        p as Array<{
          taskId: string;
          kind: 'new' | 'completed' | 'partial' | 'blocked' | 'claim-lost';
          source: string;
        }>,
      );
    ipcRenderer.on('tasks:transitions', handler);
    return () => ipcRenderer.off('tasks:transitions', handler);
  },
  onTasksNotificationClicked: (
    cb: (payload: { taskId?: string }) => void,
  ) => {
    const handler = (_e: unknown, p: { taskId?: string }) => cb(p);
    ipcRenderer.on('tasks:notification-clicked', handler);
    return () => ipcRenderer.off('tasks:notification-clicked', handler);
  },
  // Mirror the renderer's task-notification verbosity to main (the OS-
  // notification gate runs in main). Fire-and-forget on boot + on change.
  setTaskNotifications: (value: 'all' | 'failures' | 'off') =>
    ipcRenderer.send('settings:taskNotifications', value),
  // ─── App-level attention (fm-c2w) ─────────────────────────────────
  setDockBadge: (text: string) =>
    ipcRenderer.invoke('app:setDockBadge', text) as Promise<void>,
  playAttentionSound: () =>
    ipcRenderer.invoke('app:playAttentionSound') as Promise<void>,
  onAppFocus: (cb: (focused: boolean) => void) => {
    const handler = (_e: unknown, focused: boolean) => cb(focused);
    ipcRenderer.on('app:focus', handler);
    return () => ipcRenderer.off('app:focus', handler);
  },
  showAttentionNotification: (opts: { title: string; body: string; tabId: string }) =>
    ipcRenderer.invoke('app:showAttentionNotification', opts) as Promise<void>,
  onNotificationClicked: (cb: (tabId: string) => void) => {
    const handler = (_e: unknown, payload: { tabId: string }) => cb(payload.tabId);
    ipcRenderer.on('app:notification-clicked', handler);
    return () => ipcRenderer.off('app:notification-clicked', handler);
  },
  // ─── Interactive task runs (fm-b5at.7) ────────────────────────────
  // Main spawns the claude PTY for an interactive run and broadcasts this
  // so the renderer opens a tab attached to the existing ptyId. Self-
  // contained entry — the renderer only attaches a tab; it never spawns.
  onTasksInteractiveRun: (
    cb: (payload: {
      taskId: string;
      runId: string | null;
      ptyId: number;
      title: string;
      cwd: string;
      source?: string;
    }) => void,
  ) => {
    const handler = (
      _e: unknown,
      payload: {
        taskId: string;
        runId: string | null;
        ptyId: number;
        title: string;
        cwd: string;
        source?: string;
      },
    ) => cb(payload);
    ipcRenderer.on('tasks:interactiveRun', handler);
    return () => ipcRenderer.off('tasks:interactiveRun', handler);
  },
  // fm-b5at.5 — a TypeBuild session ended while the user still holds the
  // claim; main broadcasts this so the renderer can offer Release. PHI-free.
  onTypebuildReleasePrompt: (cb: (payload: { taskId: string }) => void) => {
    const handler = (_e: unknown, payload: { taskId: string }) => cb(payload);
    ipcRenderer.on('typebuild:releasePrompt', handler);
    return () => ipcRenderer.off('typebuild:releasePrompt', handler);
  },
  // ─── TypeBuild MCP session expiry (fm-b5at.10) ────────────────────────
  // The 8h MCP token can't refresh mid-session. Main's expiry clock
  // broadcasts a T-15min 'warning' and an at/after-expiry 'expired' phase per
  // live session (keyed by ptyId; PHI-free — opaque taskId only). 'expired'
  // drives a one-click relaunch: relaunchSession kills the old PTY, mints a
  // fresh token, and resumes the conversation with --continue; on success
  // sessionRelaunched tells the renderer to repoint the tab onto the new
  // ptyId (no tab churn). Self-contained block.
  onTypebuildSessionExpiry: (
    cb: (payload: {
      ptyId: number;
      taskId: string;
      phase: 'warning' | 'expired';
      expiresAt: number;
    }) => void,
  ) => {
    const handler = (
      _e: unknown,
      payload: {
        ptyId: number;
        taskId: string;
        phase: 'warning' | 'expired';
        expiresAt: number;
      },
    ) => cb(payload);
    ipcRenderer.on('typebuild:sessionExpiry', handler);
    return () => ipcRenderer.off('typebuild:sessionExpiry', handler);
  },
  onTypebuildSessionRelaunched: (
    cb: (payload: {
      oldPtyId: number;
      newPtyId: number;
      cwd: string;
      title: string;
    }) => void,
  ) => {
    const handler = (
      _e: unknown,
      payload: { oldPtyId: number; newPtyId: number; cwd: string; title: string },
    ) => cb(payload);
    ipcRenderer.on('typebuild:sessionRelaunched', handler);
    return () => ipcRenderer.off('typebuild:sessionRelaunched', handler);
  },
  typebuildRelaunchSession: (payload: { ptyId: number; taskId: string }) =>
    ipcRenderer.invoke('typebuild:relaunchSession', payload) as Promise<{
      ok: boolean;
      ptyId: number;
    }>,
  // ─── TypeBuild auth (fm-b5at.2) ───────────────────────────────────
  // Self-contained namespaced block for the TypeBuild plugin's Firebase
  // sign-in. Token lifecycle lives entirely in main (electron/typebuild/
  // auth.ts); the renderer only ever sees AuthState ({signedIn, email?}).
  typebuild: {
    signIn: (email: string, password: string) =>
      ipcRenderer.invoke('typebuild:auth:signIn', email, password) as Promise<{
        signedIn: boolean;
        email?: string;
      }>,
    // fm-b5at.11 — browser sign-in via the server's OAuth flow + hosted
    // page (Google or email/password). Rejects with a tagged
    // `[typebuild-browser:<code>]` Error on a typed failure.
    signInBrowser: () =>
      ipcRenderer.invoke('typebuild:auth:signInBrowser') as Promise<{
        signedIn: boolean;
        email?: string;
      }>,
    cancelBrowser: () =>
      ipcRenderer.invoke('typebuild:auth:cancelBrowser') as Promise<void>,
    signOut: () =>
      ipcRenderer.invoke('typebuild:auth:signOut') as Promise<void>,
    authState: () =>
      ipcRenderer.invoke('typebuild:auth:state') as Promise<{
        signedIn: boolean;
        email?: string;
      }>,
    onAuthChanged: (
      cb: (state: { signedIn: boolean; email?: string }) => void,
    ) => {
      const handler = (
        _e: unknown,
        state: { signedIn: boolean; email?: string },
      ) => cb(state);
      ipcRenderer.on('typebuild:auth:changed', handler);
      return () => ipcRenderer.off('typebuild:auth:changed', handler);
    },
    // fm-b5at.3/.5 — onboarding prerequisite detection. Detection logic
    // lives in main (electron/typebuild/detect.ts); the renderer only sees
    // booleans + resolved paths (no PHI).
    detectChecks: () =>
      ipcRenderer.invoke('typebuild:detect:checks') as Promise<{
        claude: { ok: boolean; path?: string };
        chrome: { ok: boolean; path?: string };
      }>,
    installCommand: () =>
      ipcRenderer.invoke('typebuild:detect:installCommand') as Promise<string>,
    // User credential vault (:secrets panel) — class-2 data (the user's OWN
    // identifiers: NPI, Tax ID, login IDs). Server-backed; values cross only on
    // explicit reveal/save. `list` returns NAMES only ({key, secret}); the
    // `secret` flag lets the panel disable reveal for write-only secret fields.
    vault: {
      list: () => ipcRenderer.invoke('typebuild:vault:list') as Promise<VaultEntry[]>,
      reveal: (ref: string) =>
        ipcRenderer.invoke('typebuild:vault:reveal', ref) as Promise<string>,
      set: (key: string, value: string) =>
        ipcRenderer.invoke('typebuild:vault:set', key, value) as Promise<string>,
      remove: (ref: string) =>
        ipcRenderer.invoke('typebuild:vault:delete', ref) as Promise<void>,
    },
    // task-ab1d7955e23f — TypeBuild Projects: named task containers with
    // optional instructions + owned folders. NON-PHI; server-backed via the
    // TypeBuild source. `resolve` is the auto-attach lookup (folder → owner or
    // null).
    projects: {
      list: () =>
        ipcRenderer.invoke('typebuild:projects:list') as Promise<Project[]>,
      get: (id: string, effective?: boolean) =>
        ipcRenderer.invoke(
          'typebuild:projects:get',
          id,
          effective,
        ) as Promise<Project | null>,
      resolve: (folder: string) =>
        ipcRenderer.invoke(
          'typebuild:projects:resolve',
          folder,
        ) as Promise<Project | null>,
      create: (input: {
        name: string;
        description?: string;
        instructions?: string;
        parentProjectId?: string;
        folders?: string[];
      }) =>
        ipcRenderer.invoke('typebuild:projects:create', input) as Promise<Project>,
    },
    // fm-j7w0 (S4) — user registry for the assignee picker (NON-PHI identities).
    listUsers: () =>
      ipcRenderer.invoke('typebuild:listUsers') as Promise<
        Array<{ principal: string; email?: string | null; display_name?: string | null }>
      >,
    // fm-k6wz (S7) — per-task audit history (NON-PHI actor/action/detail/time).
    audit: (taskId: string, limit?: number) =>
      ipcRenderer.invoke('typebuild:audit', taskId, limit) as Promise<
        Array<{ user: string; action: string; detail: string; at: string }>
      >,
  },
  // ─── TypeBuild side-by-side layout (fm-b5at.6) ────────────────────────
  // Self-contained block. Chrome left / our window right while a TypeBuild
  // session runs. `probe` tells the UI whether Chrome arranging is ok /
  // needs a permission grant / is unsupported (Wayland → degraded mode).
  sideBySide: {
    enter: (split?: number) =>
      ipcRenderer.invoke('window:sideBySide:enter', split) as Promise<{
        ownWindow: boolean;
        chrome: { ok: boolean; reason?: 'no-permission' | 'no-chrome-window' | 'unsupported' };
      }>,
    exit: () =>
      ipcRenderer.invoke('window:sideBySide:exit') as Promise<{ restored: boolean }>,
    toggle: (split?: number) =>
      ipcRenderer.invoke('window:sideBySide:toggle', split) as Promise<{
        active: boolean;
        chrome?: { ok: boolean; reason?: 'no-permission' | 'no-chrome-window' | 'unsupported' };
      }>,
    state: () =>
      ipcRenderer.invoke('window:sideBySide:state') as Promise<{ active: boolean }>,
    probe: () =>
      ipcRenderer.invoke('window:sideBySide:probe') as Promise<
        'ok' | 'no-permission' | 'unsupported'
      >,
  },
  // Native-menu → renderer bridge. Main process menu items click() forward
  // a verb id here so the renderer can open ChipPrompt pre-loaded with
  // that verb (zero-slot verbs execute immediately).
  onMenuVerb: (cb: (verbId: string) => void) => {
    const handler = (_e: unknown, payload: { verbId: string }) => cb(payload.verbId);
    ipcRenderer.on('app:menu-verb', handler);
    return () => ipcRenderer.off('app:menu-verb', handler);
  },
  // fm-ued6 — cold-start profiling: the renderer fires this once after its
  // first committed frame so the main process can close out the startup
  // timeline at the "first interactive frame" boundary. NON-PHI, fire-and-forget.
  reportFirstPaint: () => ipcRenderer.send('app:firstPaint'),
};

contextBridge.exposeInMainWorld('fm', fm);

export type FmApi = typeof fm;
