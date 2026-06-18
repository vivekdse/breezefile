import type { Entry, RemoteSchedule, Task, TaskAuditEvent, TaskCreate, TaskFilter, TaskRun, TaskRunWithTitle, TaskSourceInfo, TaskUpdate, TaskUser } from './types';

export type Capabilities = {
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
};

type Fm = {
  platform: NodeJS.Platform;
  versions: NodeJS.ProcessVersions;
  capabilities: () => Promise<Capabilities>;
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
  openUrl: (url: string) => Promise<void>;
  openWith: (p: string, appName: string) => Promise<void>;
  pickApplication: () => Promise<string | null>;
  pickFolder: (defaultPath?: string) => Promise<string | null>;
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
  // fm-vu55 — in-app text editor (markdown via Milkdown, others plain).
  editorOpen: (p: string) => Promise<{ content: string; mtimeMs: number; error?: string }>;
  editorSave: (
    p: string,
    content: string,
    expectedMtimeMs: number | null,
  ) => Promise<{ mtimeMs: number; conflict?: boolean; error?: string }>;
  dragStart: (paths: string[]) => void;
  pathForFile: (file: File) => string;
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
  upgrade: () => Promise<{ ok: boolean; mode: 'inline' | 'terminal' | 'browser' }>;
  termSpawn: (opts: {
    cwd: string;
    cols?: number;
    rows?: number;
    shell?: string;
    args?: string[];
    env?: Record<string, string>;
    remoteAttach?: { target: string; ttlSec?: number };
  }) => Promise<number>;
  remoteListTargets: () => Promise<string[]>;
  termWrite: (id: number, data: string) => void;
  termMirror: (id: number) => void;
  termUnmirror: (id: number) => void;
  termResize: (id: number, cols: number, rows: number) => void;
  termKill: (id: number, signal?: string) => Promise<void>;
  termStatus: (id: number) => Promise<{ alive: boolean; pid: number | null }>;
  onTermData: (cb: (id: number, data: string) => void) => () => void;
  onTermExit: (
    cb: (id: number, code: number, signal: string | null) => void,
  ) => () => void;
  onTermFg: (
    cb: (
      id: number,
      busy: boolean,
      comm: string | null,
      state?: 'busy' | 'idle' | 'waiting',
    ) => void,
  ) => () => void;
  // ─── SPIKE (spike/playwright-cdp): embedded browser-view control.
  browserAttach: (opts: { url?: string }) => Promise<number>;
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
  ) => void;
  browserHide: (id: number) => void;
  browserDestroy: (id: number) => Promise<void>;
  browserNavigate: (id: number, url: string) => void;
  browserBack: (id: number) => void;
  browserForward: (id: number) => void;
  browserReload: (id: number) => void;
  browserSync: (id: number) => void;
  browserDebug: (info: unknown) => void;
  onBrowserState: (
    cb: (s: {
      id: number;
      url: string;
      title: string;
      canGoBack: boolean;
      canGoForward: boolean;
    }) => void,
  ) => () => void;
  // SPIKE (spike/playwright-cdp): main → renderer "open a browser tab" request.
  onBrowserOpen: (cb: (s: { url?: string }) => void) => () => void;
  launchersList: () => Promise<Launcher[]>;
  launchersSave: (list: Launcher[]) => Promise<void>;
  launchersConfigPath: () => Promise<string>;
  launchersRevealConfig: () => Promise<void>;
  // fm-dhc — task store
  tasksList: (filter?: TaskFilter) => Promise<Task[]>;
  tasksGet: (id: string, source?: string) => Promise<Task | null>;
  tasksCreate: (input: TaskCreate, source?: string) => Promise<Task>;
  tasksUpdate: (id: string, patch: TaskUpdate, source?: string) => Promise<Task>;
  tasksDelete: (id: string, source?: string) => Promise<void>;
  // ── TaskSource providers (fm-b5at.1) ──
  tasksSources: () => Promise<TaskSourceInfo[]>;
  tasksSourceAction: (
    source: string,
    taskId: string,
    action: string,
    payload?: unknown,
  ) => Promise<unknown>;
  // ── Schedule overlay for remote-source tasks (fm-b5at.8) ──
  tasksOverlaySet: (
    source: string,
    taskId: string,
    cron: string,
  ) => Promise<RemoteSchedule>;
  tasksOverlayClear: (source: string, taskId: string) => Promise<void>;
  tasksOverlayList: () => Promise<RemoteSchedule[]>;
  // ── Multi-source (breezed P4) ──
  sourcesList: () => Promise<
    Array<{ id: string; kind: 'local' | 'remote'; status: 'connected' | 'connecting' }>
  >;
  sourcesConnect: (host: string) => Promise<void>;
  sourcesDisconnect: (host: string) => Promise<void>;
  onSourcesChanged: (cb: () => void) => () => void;
  tasksCountByFolder: (folder: string) => Promise<number>;
  tasksDbExists: () => Promise<boolean>;
  // fm-adc — write the per-task sidecar markdown for AI launchers
  tasksWriteActiveSidecar: (id: string, source?: string) => Promise<string | null>;
  onTasksChanged: (cb: () => void) => () => void;
  // fm-lji6 (S2) — per-source list failures (broadcast from the tasks:list
  // aggregation). The list itself stays a bare array (one source failing
  // degrades to its cache rather than throwing), but subscribers can surface
  // which source broke + why. PHI-free: source id + a message, never content.
  onTaskSourceError: (
    cb: (e: { source: string; message: string }) => void,
  ) => () => void;
  // fm-zf3m — task runs
  tasksRunsList: (taskId: string, limit?: number) => Promise<TaskRun[]>;
  tasksRunsListAll: (limit?: number) => Promise<TaskRunWithTitle[]>;
  tasksRunsCountByTask: () => Promise<Record<string, number>>;
  tasksLastRun: (taskId: string) => Promise<TaskRun | null>;
  // fm-v0rc — the return shape is source-defined: the local source resolves
  // { run, result }; TypeBuild's Start resolves a { ok, ptyId } success or a
  // { ok:false, reason, claimedBy } rejection union. Typed as unknown here so
  // the renderer narrows at the call site.
  tasksRunNow: (taskId: string, source?: string) => Promise<unknown>;
  tasksRunNowAt: (
    taskId: string,
    cwd: string,
  ) => Promise<{ run: TaskRun; result: unknown }>;
  tasksCancelRun: (runId: string) => Promise<boolean>;
  onTaskRunsChanged: (cb: (taskId: string) => void) => () => void;
  onTaskRunFailed: (cb: (payload: { taskId: string; body: string }) => void) => () => void;
  // fm-h8g7 — task-notification surfaces. The transition feed is PHI-FREE
  // (opaque task id + kind + source id only).
  onTaskRunSucceeded: (cb: (payload: { taskId: string }) => void) => () => void;
  onTaskTransitions: (
    cb: (
      transitions: Array<{
        taskId: string;
        kind: 'new' | 'completed' | 'partial' | 'cancelled' | 'blocked' | 'claim-lost';
        source: string;
      }>,
    ) => void,
  ) => () => void;
  onTasksNotificationClicked: (
    cb: (payload: { taskId?: string }) => void,
  ) => () => void;
  setTaskNotifications: (value: 'all' | 'failures' | 'off') => void;
  // fm-9fd — control bridge between the HTTP API server (main) and the
  // renderer (which owns tab state + navigation). Renderer listens for
  // control:request events and replies via sendControlReply.
  onControlRequest: (
    cb: (req: { reqId: string; kind: string; [k: string]: unknown }) => void,
  ) => () => void;
  sendControlReply: (payload: {
    reqId: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  }) => void;
  // fm-c2w — app-level attention (dock badge + focus events)
  setDockBadge: (text: string) => Promise<void>;
  playAttentionSound: () => Promise<void>;
  onAppFocus: (cb: (focused: boolean) => void) => () => void;
  showAttentionNotification: (opts: { title: string; body: string; tabId: string }) => Promise<void>;
  onNotificationClicked: (cb: (tabId: string) => void) => () => void;
  // fm-b5at.7 — interactive task run: main spawned a claude PTY and asks
  // the renderer to open a tab attached to the existing ptyId.
  onTasksInteractiveRun: (
    cb: (payload: {
      taskId: string;
      runId: string | null;
      ptyId: number;
      title: string;
      cwd: string;
      source?: string;
    }) => void,
  ) => () => void;
  // fm-b5at.5 — a TypeBuild interactive session's PTY exited while the user
  // still holds the claim. The renderer surfaces a gentle "Release?" prompt.
  // PHI-free: task id only, no title/body.
  onTypebuildReleasePrompt: (
    cb: (payload: { taskId: string }) => void,
  ) => () => void;
  // fm-b5at.10 — TypeBuild MCP session expiry. The 8h token can't refresh
  // mid-session; main's expiry clock warns at T-15min and, at/after expiry,
  // offers a one-click relaunch. PHI-free: opaque taskId + epoch only.
  onTypebuildSessionExpiry: (
    cb: (payload: {
      ptyId: number;
      taskId: string;
      phase: 'warning' | 'expired';
      expiresAt: number;
    }) => void,
  ) => () => void;
  // Main repoints the session tab onto the freshly-minted PTY after a relaunch
  // so the user keeps the same tab (no churn).
  onTypebuildSessionRelaunched: (
    cb: (payload: {
      oldPtyId: number;
      newPtyId: number;
      cwd: string;
      title: string;
    }) => void,
  ) => () => void;
  // One-click relaunch trigger: kill the expired PTY, mint fresh, resume the
  // conversation. Throws a typed `[typebuild-mint:<code>]` error on mint
  // failure (renderer maps it to the same three in-app messages as launch).
  typebuildRelaunchSession: (payload: {
    ptyId: number;
    taskId: string;
  }) => Promise<{ ok: boolean; ptyId: number }>;
  // fm-b5at.2 — TypeBuild plugin Firebase auth. Self-contained namespaced
  // block; tokens live in main, the renderer only sees TypebuildAuthState.
  typebuild: {
    signIn: (email: string, password: string) => Promise<TypebuildAuthState>;
    // fm-b5at.11 — browser sign-in via the server's OAuth flow + hosted page
    // (Google or email/password). Rejects with a `[typebuild-browser:<code>]`
    // tagged Error (cancelled | unreachable | rejected | server-pending).
    signInBrowser: () => Promise<TypebuildAuthState>;
    cancelBrowser: () => Promise<void>;
    signOut: () => Promise<void>;
    authState: () => Promise<TypebuildAuthState>;
    onAuthChanged: (cb: (state: TypebuildAuthState) => void) => () => void;
    // fm-b5at.3/.5 — onboarding prerequisite detection (booleans + paths).
    detectChecks: () => Promise<{
      claude: { ok: boolean; path?: string };
      chrome: { ok: boolean; path?: string };
    }>;
    installCommand: () => Promise<string>;
    // fm-j7w0 (S4) — user registry for the assignee picker (NON-PHI).
    listUsers: () => Promise<TaskUser[]>;
    // fm-k6wz (S7) — per-task audit history (NON-PHI actor/action/detail/time).
    audit: (taskId: string, limit?: number) => Promise<TaskAuditEvent[]>;
  };
  // fm-b5at.6 — TypeBuild side-by-side layout. Chrome left / our window
  // right while a session runs. Self-contained namespaced block; the OS work
  // lives in main (electron/window-arrange.ts + PlatformAdapter).
  sideBySide: {
    enter: (split?: number) => Promise<{
      ownWindow: boolean;
      chrome: { ok: boolean; reason?: 'no-permission' | 'no-chrome-window' | 'unsupported' };
    }>;
    exit: () => Promise<{ restored: boolean }>;
    toggle: (split?: number) => Promise<{
      active: boolean;
      chrome?: { ok: boolean; reason?: 'no-permission' | 'no-chrome-window' | 'unsupported' };
    }>;
    state: () => Promise<{ active: boolean }>;
    probe: () => Promise<'ok' | 'no-permission' | 'unsupported'>;
  };
};

export type TypebuildAuthState = { signedIn: boolean; email?: string };

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
