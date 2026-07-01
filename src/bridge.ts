import type { Entry, Project, RemoteSchedule, Task, TaskAuditEvent, TaskCreate, TaskFilter, TaskRun, TaskRunWithTitle, TaskSourceInfo, TaskUpdate, TaskUser } from './types';
import type { Tag as DslTag, TagCreate as DslTagCreate, TagUpdate as DslTagUpdate } from './tagStore.d.mts';

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
  // fm-mp1 / fm-xr0 — recursively walk a scope, returning full-metadata Entry
  // rows for every descendant (capped: default depth ≤ 8, ≤ 5000 entries).
  // Powers filter-tabs (selector → matching entries across the scope) and
  // frozen-tag snapshots (selector → set of matching paths).
  walkScope: (
    scope: string,
    opts?: { maxDepth?: number; maxCount?: number; includeHidden?: boolean },
  ) => Promise<Entry[]>;
  stat: (p: string) => Promise<{ size: number; mtimeMs: number; isDir: boolean }>;
  mkdir: (p: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  trash: (paths: string[]) => Promise<void>;
  // fm-7klh — irreversible delete (renderer gates this behind type-to-confirm)
  permanentDelete: (paths: string[]) => Promise<void>;
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
  windowToggleMaximize: () => Promise<void>;
  windowToggleFullscreen: () => Promise<void>;
  // fm-dly3 — grow/restore the OS window when the chat panel opens/closes
  windowChatResize: (open: boolean, panelWidth: number) => Promise<void>;
  openWith: (p: string, appName: string) => Promise<void>;
  pickApplication: () => Promise<string | null>;
  pickFolder: (defaultPath?: string) => Promise<string | null>;
  // fm-3vl — export-list verb: show a Save dialog and write the supplied text
  // (selected paths, plain or JSON) to the chosen file. Resolves to the saved
  // path, or null when the user cancels.
  saveList: (content: string, defaultName?: string) => Promise<string | null>;
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
  editorWatch: (p: string) => Promise<void>;
  editorUnwatch: (p: string) => Promise<void>;
  onEditorFileChanged: (cb: (p: string, mtimeMs: number) => void) => () => void;
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
  // task-6b9b0032feda — mirror + replay recent scrollback to this window so a
  // late-mounting/re-shown mirror pane repaints immediately.
  termMirrorWithReplay: (id: number) => void;
  termUnmirror: (id: number) => void;
  // SPIKE (spike/playwright-cdp): adopt a pty as THIS window's own terminal
  // (retarget owner + replay), so the operator window renders it directly
  // instead of mirroring a redundant main-window owner tab.
  termAdopt: (id: number) => void;
  // ─── SPIKE (spike/playwright-cdp): operator session split-pane chrome. The
  // browser pane is driven by the shared fm.browser* methods (keyed by the view
  // id baked into the operator chrome's `view=` hash) — only the window-level
  // verbs remain operator-specific.
  operatorClose: () => void;
  // Report the user's chosen UI theme to main so the "task starting" splash
  // shown in the page view matches the client (task-3a49fb5adf24). Main
  // re-themes the splash only while it's still showing (before the agent's
  // first real navigation).
  operatorSetTheme: (theme: string) => void;
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
  // Address-bar autocomplete (task-ff707aea93d8): ranked URL suggestions from
  // visited-URL history + a known-host seed, computed in main. NON-PHI.
  browserSuggest: (query: string) => Promise<UrlSuggestion[]>;
  // Teach-by-recording (task-01facbf6b0bc).
  browserRecordStart: (id: number) => Promise<{ ok: boolean; error?: string }>;
  browserRecordStop: (opts?: { skillName?: string }) => Promise<{
    ok: boolean;
    error?: string;
    actions?: unknown[];
    site?: string;
    saved?: boolean;
  }>;
  browserRecordState: () => Promise<{
    recording: boolean;
    count: number;
    webContentsId: number | null;
  }>;
  // Full-page screenshot → PDF: auto-scroll + capture each viewport, save as
  // one PDF (electron/browser/screenshot-pdf.ts).
  browserScreenshotPdf: (
    id: number,
    opts?: { outPath?: string },
  ) => Promise<{ ok: boolean; error?: string; path?: string; pages?: number }>;
  // Return-visit autofill (task-4b786c018d78): resolve the saved password for
  // (origin, username) in MAIN and type it into the page's login form. The
  // password never crosses back to the renderer — returns only a value-free
  // outcome.
  browserAutofill: (
    id: number,
    origin: string,
    username: string,
  ) => Promise<'filled' | 'no-form' | 'error' | 'no-credential'>;
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
  // Login-submit capture (task-1188c6535e91 / task-ad89064bf45f): fired when the
  // human submits a login form in an embedded browser tab. Carries the captured
  // password — TRUSTED UI only: show the "Save password?" prompt, never persist
  // or log it until the user accepts. Dropped on dismiss.
  onBrowserCredentialCaptured: (
    cb: (s: {
      id: number;
      origin: string;
      username: string;
      password: string;
    }) => void,
  ) => () => void;
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
  /** Auto-attach the remote behind `cwd` if it's under an active sshfs
   *  mount; resolves to the attached host or null (already attached / not a
   *  remote path / detection unavailable). Idempotent, never throws. */
  sourcesAutoAttach: (cwd: string) => Promise<string | null>;
  sourcesDisconnect: (host: string) => Promise<void>;
  // fm-at5 — reset the auto-registered Claude Code integration
  claudeUnregisterHooks: () => Promise<'removed' | 'absent' | 'error'>;
  onSourcesChanged: (cb: () => void) => () => void;
  tasksCountByFolder: (folder: string) => Promise<number>;
  tasksDbExists: () => Promise<boolean>;
  // fm-adc — write the per-task sidecar markdown for AI launchers
  tasksWriteActiveSidecar: (id: string, source?: string) => Promise<string | null>;
  // task-b3fb2928bb3c (Phase 1) — `detail` is an OPTIONAL PHI-free diff
  // ({ source, added, changed, removed } — opaque ids only). Subscribers that
  // ignore it keep the existing full-re-pull behavior; useTasks uses it to
  // prune removed rows and skip a re-pull when nothing was added/changed.
  onTasksChanged: (
    cb: (detail?: {
      source: string;
      added: string[];
      changed: string[];
      removed: string[];
    }) => void,
  ) => () => void;
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
  // fm-5xy — start-at / near-due reminder mode mirror (see preload).
  setTaskReminders: (value: 'off' | 'start' | 'start-near-due') => void;
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
      operator?: boolean;
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
    // Credential vault — the user's OWN identifiers (NPI, Tax ID, login IDs),
    // NOT patient PHI. Values are encrypted on TypeBuild, scoped to the user,
    // and never persisted to this machine's disk. `list` returns NAMES only
    // ({key, secret}); `reveal` decrypts a single value on explicit user
    // action. The `secret` flag marks write-only fields (ssn/dob/bank_account)
    // the server refuses to reveal — the panel disables their reveal toggle.
    vault: {
      list: () => Promise<VaultEntry[]>;
      reveal: (ref: string) => Promise<string>;
      set: (key: string, value: string) => Promise<string>;
      remove: (ref: string) => Promise<void>;
    };
    // Site-keyed credential store — per-user web logins (origin, username) →
    // password (task-ad89064bf45f prompt / task-d60860fb4d7f vault). The password
    // is encrypted at rest server-side, origin-normalized, principal-scoped, and
    // NEVER logged. `list`/`resolve` are value-free except resolve's single
    // returned password (revealed on explicit user/agent action). Distinct from
    // `vault` (the user's OWN identifiers); these are arbitrary site logins.
    credentials: {
      list: (origin?: string) => Promise<SavedCredential[]>;
      resolve: (origin: string, username: string) => Promise<string>;
      save: (cred: {
        origin: string;
        username: string;
        password: string;
      }) => Promise<{ origin: string; username: string }>;
      remove: (origin: string, username: string) => Promise<void>;
    };
    // task-ab1d7955e23f — TypeBuild Projects: named task containers with
    // optional instructions + owned folders. NON-PHI. `resolve` is the
    // auto-attach lookup (folder → owning project or null).
    projects: {
      list: (includeArchived?: boolean) => Promise<Project[]>;
      get: (id: string, effective?: boolean) => Promise<Project | null>;
      resolve: (folder: string) => Promise<Project | null>;
      create: (input: {
        name: string;
        description?: string;
        instructions?: string;
        parentProjectId?: string;
        folders?: string[];
      }) => Promise<Project>;
      // task-fdf3dc6b3c5c — PROJECT-scope teach write-back. Structured result so
      // the UI surfaces owner-only (403) / PHI-guard (422) failures gracefully.
      patch: (
        id: string,
        patch: { name?: string; description?: string; instructions?: string },
      ) => Promise<
        | { ok: true; project: Project }
        | { ok: false; reason: string; status: number }
      >;
      // task-2c5448be520a — archive/unarchive (hide from the default list).
      archive: (id: string) => Promise<Project>;
      unarchive: (id: string) => Promise<Project>;
    };
    // task-fdf3dc6b3c5c — TASK-scope teach write-back (per-task note).
    taskNote: (
      taskId: string,
      note: string,
    ) => Promise<
      { ok: true } | { ok: false; reason: string; status: number }
    >;
    // task-da23979fd907 — append to the USER-facing task message feed. NOT
    // claim-gated. `text` is PHI (sent to the server, never logged locally).
    taskMessage: (
      taskId: string,
      text: string,
    ) => Promise<
      { ok: true } | { ok: false; reason: string; status: number }
    >;
    // task-a763ca5be676 — answer a task's PENDING QUESTION (ask_user). Clears
    // pending_question + records the reply on the feed. `answer` is PHI (sent to
    // the server, never logged locally).
    taskAnswer: (
      taskId: string,
      answer: string,
    ) => Promise<
      { ok: true } | { ok: false; reason: string; status: number }
    >;
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
  // Native-menu → renderer bridge: a native menu item forwards a verb id.
  onMenuVerb: (cb: (verbId: string) => void) => () => void;
  // task-317c7fe41f90 — DSL-tag store (src/tagStore.mjs) owned by main in
  // userData/tags.json. Additive — runs alongside the criterion tag system.
  // A `selector` is a tagDsl query string; resolveTag (src/dslTagResolve.mjs)
  // turns a tag name into the membership predicate the evaluator injects.
  dslTags: {
    list: () => Promise<DslTag[]>;
    get: (id: string) => Promise<DslTag | null>;
    create: (input: DslTagCreate) => Promise<DslTag>;
    update: (id: string, patch: DslTagUpdate) => Promise<DslTag | null>;
    delete: (id: string) => Promise<boolean>;
  };
  // fm-2ln / fm-5rk — metadata-only LLM tag frontend. The renderer sends a
  // prompt payload built by src/tagCompose.mjs; main runs the in-process
  // Anthropic call (key kept in main) and returns raw model text. `available`
  // gates the NL input — when there is no key the feature degrades to disabled.
  llm: {
    available: () => Promise<boolean>;
    run: (payload: {
      model: string;
      system: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      maxTokens?: number;
    }) => Promise<{ ok: true; text: string } | { ok: false; code?: string; error: string }>;
    reloadKey: () => Promise<boolean>;
    // Set/clear the userData/llm.json key from the Settings UI. Pass '' to
    // clear. The key is written in main and never logged; resolves to whether a
    // key is now resolvable (env still wins over the file).
    setKey: (key: string) => Promise<boolean>;
  };
  // fm-ued6 — cold-start profiling: report the first committed frame to main.
  reportFirstPaint?: () => void;
};

export type TypebuildAuthState = { signedIn: boolean; email?: string };

// One address-bar autocomplete suggestion (task-ff707aea93d8). Ranked in main
// from visited-URL history + a known-host seed. NON-PHI: plain url/host/title.
export type UrlSuggestion = {
  url: string;
  host: string;
  title?: string;
  kind: 'history' | 'bookmark' | 'known';
};

// One credential-vault entry as it crosses the bridge (NAMES only — never a
// value). `key` is the "me."-prefixed field; `secret` marks write-only fields
// (ssn/dob/bank_account) the server's resolver refuses to reveal.
export type VaultEntry = { key: string; secret: boolean };

// One saved site login as it crosses the bridge for LISTING (NO password — the
// password only ever crosses on an explicit `credentials.resolve`). `updatedAt`
// is an ISO/string timestamp from the server for ordering. NON-PHI metadata.
export type SavedCredential = {
  origin: string;
  username: string;
  updatedAt?: string;
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
  // fm-dly3 — flag this agent takes background context through (e.g.
  // '--append-system-prompt'). The chat panel uses it to inject the folder /
  // document as a system prompt instead of a typed first message.
  contextFlag?: string;
  // fm-v3p — task-action-zone visibility overrides. These are NOT persisted in
  // the main-process launcher def; they're a renderer-side pref (see
  // src/launcherPrefs.ts) layered on at render time. Declared here so call
  // sites can reason about a launcher's effective visibility/default. Absent =
  // visible, not-default — the additive, no-surprise baseline.
  hidden?: boolean;
  default?: boolean;
};

declare global {
  interface Window {
    fm: Fm;
  }
}

export const fm: Fm = window.fm;
