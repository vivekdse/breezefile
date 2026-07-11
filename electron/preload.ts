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

// task-896f3f7f5e75 — TypeBuild Agent as it crosses the bridge (camelCase;
// mirrors src/types.ts `Agent`). Inlined like Project (preload carries no
// shared-type imports). NON-PHI: name/tools/launch_mode are not patient data.
// `group` is null for a private agent; `tools` is advisory; `launchMode` is one
// of chrome/auto/resume/manual.
type Agent = {
  id: string;
  name: string;
  group: string | null;
  tools: string[];
  launchMode: string;
};

// task-fd1be6f6b22d — a TypeBuild group member as it crosses the bridge
// (camelCase; mirrors src/types.ts `GroupMember`). Inlined like Agent. NON-PHI:
// a user identity (email/principal + optional display name/role).
type GroupMember = {
  principal: string;
  displayName: string | null;
  role: string | null;
};
// A group as { id, name } for the scope picker's label. Inlined; NON-PHI.
type Group = { id: string; name: string };
// The Groups management surface's richer view. Inlined; NON-PHI.
type GroupMemberDetail = {
  principal: string;
  displayName: string | null;
  role: 'admin' | 'member';
  status: 'active' | 'pending';
  invitedBy: string | null;
};
type GroupDetail = {
  id: string;
  name: string;
  createdBy: string | null;
  myRole: 'admin' | 'member' | null;
  members: GroupMemberDetail[];
};
type GroupInvite = {
  groupId: string;
  groupName: string;
  role: 'admin' | 'member';
  invitedBy: string | null;
};

// docs/connections-design.md §B/§C — a Connection as it crosses the bridge
// (creds-STRIPPED projection; mirrors src/types.ts `ConnectionSummary`).
// Inlined like Project (preload carries no shared-type imports). NON-PHI: the
// credential VALUE never crosses this bridge in either direction —
// `credentialDisplay` carries only non-secret metadata.
type ConnectionScope =
  | { type: 'project'; projectId: string }
  | { type: 'group'; groupId: string };
type ConnectionSummarySpec = {
  mode: 'live_url' | 'inline';
  hash: string;
  fetchedAt: string;
  specUrl?: string;
};
type ConnectionSummary = {
  id: string;
  name: string;
  kind: 'rest' | 'mcp';
  endpoint: string;
  scope: ConnectionScope;
  spec?: ConnectionSummarySpec;
  status: 'active' | 'needs_attention' | 'disabled';
  credentialDisplay?: Record<string, string>;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
};
type ConnectionCredential =
  | { kind: 'api_key'; value: string; header?: string }
  | { kind: 'bearer'; value: string }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'oauth2'; accessToken: string; refreshToken?: string; tokenType?: string }
  | { kind: 'mcp_token'; value: string };
type ConnectionSpecInput =
  | { mode: 'live_url'; specUrl: string }
  | { mode: 'inline'; raw: string };
type ConnectionRegisterInput = {
  name: string;
  kind: 'rest' | 'mcp';
  endpoint: string;
  scope?: ConnectionScope;
  spec?: ConnectionSpecInput;
  credential?: ConnectionCredential;
};

// docs/connections-design.md §E — a single declarative REST call (no code —
// every dynamic part is a named slot). Inlined here for the same reason as
// the Connection types above; mirrors src/types.ts `CallSpec`/
// `CallOutputMapping`. task-8f27d842f14d (field-source lookup).
type CallOutputMapping =
  | { shape: 'rows'; rowsPath: string; ref: { entityType: string; externalIdPath: string }; fields: Record<string, string> }
  | { shape: 'value'; fields: Record<string, string> };
type CallSpec = {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  output: CallOutputMapping;
  limits?: { timeoutMs?: number };
};
// §D.2 — the durable pointer + row shape a client-direct lookup returns.
// Mirrors src/types.ts `ConnectionRef`/`ConnectionLookupRow`.
type ConnectionRef = { connectionId: string; entityType: string; externalId: string };
type ConnectionLookupRow = { ref: ConnectionRef; [field: string]: unknown };

// One credential-vault entry as it crosses the bridge (NAMES only — never a
// value). `key` is the "me."-prefixed field; `secret` marks write-only fields
// (ssn/dob/bank_account) the server's resolver refuses to reveal. Inlined here
// for the same reason as Project (preload carries no shared-type imports);
// mirrors `VaultEntry` in electron/typebuild/user-vault.ts. NON-PHI (names only).
type VaultEntry = {
  key: string;
  secret: boolean;
};

// One saved site login as it crosses the bridge for LISTING (NO password — the
// password crosses only on an explicit resolve). Inlined like VaultEntry/Project.
type SavedCredential = {
  origin: string;
  username: string;
  updatedAt?: string;
};

// task-317c7fe41f90 — DSL-tag store record as it crosses the bridge. Inlined
// for the same reason as Project/VaultEntry (preload carries no shared-type
// imports); mirrors `Tag` in src/tagStore.d.mts. NON-PHI.
type DslTag = {
  id: string;
  name: string;
  color: string;
  selector: string;
  mode: 'live' | 'frozen';
  snapshot?: string[];
  created_at: string;
  updated_at: string;
};
type DslTagCreate = {
  name: string;
  selector: string;
  color?: string;
  mode?: 'live' | 'frozen';
  snapshot?: string[];
};
type DslTagUpdate = {
  name?: string;
  selector?: string;
  color?: string;
  mode?: 'live' | 'frozen';
  snapshot?: string[] | null;
};

// task-ae0ec0348930 — a FormExtension record as it crosses the bridge (public
// projection). Inlined like Project/VaultEntry (preload carries no shared-type
// imports). NON-PHI config (fields/logic/applies_to); `fields[]` are widget
// descriptors the interpreter renders. See src/copilot/formExtensions.ts for the
// canonical renderer-side type this must stay structurally compatible with.
type FormExtension = {
  id: string;
  familyId: string | null;
  name: string;
  version: number;
  status: string;
  approvedBy: string | null;
  appliesTo: Record<string, unknown>;
  fields: Array<Record<string, unknown>>;
  logic: string;
  limits: Record<string, unknown>;
  projectId: string | null;
  groupId: string | null;
};

// task-73f6304ffb94 — a SavedQuery CATALOG entry as it crosses the bridge
// (client-normalized camelCase). Inlined like the others (preload carries no
// shared-type imports); mirrors QueryCatalogEntryWire in
// electron/sources/typebuild.ts and QueryCatalogEntry in src/copilot/
// savedQueries.ts. NON-PHI metadata: field names + types only.
type QueryCatalogEntryWire = {
  id: string;
  familyId?: string;
  name: string;
  version: number;
  status: string;
  entityType?: string;
  display?: string;
  fields: Array<{ name: string; type: string }>;
  source?: { id: string; name: string; entityTypes: string[] } | null;
};

// task-e112d60a3b7c — a Task Template as it crosses the bridge (camelCase).
// Inlined like Project/Agent (preload carries no shared-type imports); mirrors
// `Template` in electron/sources/typebuild.ts. `variables`/`outputSchema` are
// the flat TaskDefField shape (key/label/type/options/required) — field
// DEFINITIONS only, NON-PHI. `notes` (present only on `get`) is the decrypted
// prompt body (PHI, memory-only, never logged/persisted).
type TemplateField = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'bool';
  options?: string[];
  required?: boolean;
};
type Template = {
  id: string;
  name: string;
  projectId: string | null;
  variables: TemplateField[];
  outputSchema: TemplateField[];
  agentId?: string | null;
  flags?: string[];
  createdBy?: string | null;
  groupId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  notes?: string | null;
};

// task-41e5fc25ed2b (picker slice) — a ChainDef as it crosses the bridge
// (camelCase). Inlined like Template (preload carries no shared-type imports);
// mirrors `ChainDef` in electron/sources/typebuild.ts and src/types.ts. Steps
// carry title/body TEMPLATES + NON-PHI field STRUCTURE only (never values).
type ChainDefField = {
  key: string;
  label?: string;
  type?: string;
  required?: boolean;
};
type ChainDefStep = {
  titleTemplate: string;
  bodyTemplate?: string;
  humanGate?: boolean;
  inputs?: ChainDefField[];
  outputs?: ChainDefField[];
  neededWhen?: unknown;
};
type ChainDef = {
  id: string;
  name: string;
  steps: ChainDefStep[];
  projectId: string | null;
  groupId?: string | null;
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
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
  // fm-mp1 / fm-xr0 — recursively walk a scope, returning full-metadata Entry
  // rows for every descendant (capped: default depth ≤ 8, ≤ 5000 entries). Used
  // by filter-tabs (selector → matching entries) and frozen tags (selector →
  // snapshot of matching paths).
  walkScope: (
    scope: string,
    opts?: { maxDepth?: number; maxCount?: number; includeHidden?: boolean },
  ) => ipcRenderer.invoke('fs:walkScope', scope, opts),
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
  // fm-3vl — export-list verb: Save-dialog + write the supplied text.
  saveList: (content: string, defaultName?: string) =>
    ipcRenderer.invoke('app:saveList', content, defaultName) as Promise<string | null>,
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
  // task-6b9b0032feda: like termMirror, but main first replays the pty's recent
  // scrollback to THIS webContents so a pane mounting/re-showing after output
  // was emitted repaints immediately (no blank-until-next-chunk gap).
  termMirrorWithReplay: (id: number) =>
    ipcRenderer.send('term:mirror-with-replay', id),
  termUnmirror: (id: number) => ipcRenderer.send('term:unmirror', id),
  // SPIKE (spike/playwright-cdp): ADOPT a pty — make THIS webContents its owner
  // (direct renderer), not a mirror, and replay recent scrollback. The operator
  // terminal uses this so the session runs in ONE place, not a main-window
  // owner tab + an operator mirror.
  termAdopt: (id: number) => ipcRenderer.send('term:adopt', id),
  // SPIKE (spike/playwright-cdp): the operator session's split-pane chrome. The
  // LEFT-pane page view is now driven by the shared browser* methods (keyed by
  // the view id in the operator chrome's `view=` hash); only the window-level
  // verbs remain operator-specific — close the whole session (window + PTY) as
  // one action, and report the theme for the start splash. See
  // electron/browser/window.ts and src/components/OperatorSession.tsx.
  operatorClose: () => ipcRenderer.send('operator:close'),
  operatorSetTheme: (theme: string) =>
    ipcRenderer.send('operator:set-theme', theme),
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
  // Return-visit autofill (task-4b786c018d78): ask main to resolve the saved
  // password for (origin, username) and type it into the page's login form. The
  // password is resolved + injected in MAIN and NEVER crosses back to the
  // renderer — this returns only a value-free outcome.
  browserAutofill: (id: number, origin: string, username: string) =>
    ipcRenderer.invoke('browser:autofill', id, origin, username) as Promise<
      'filled' | 'no-form' | 'error' | 'no-credential'
    >,
  browserSync: (id: number) => ipcRenderer.send('browser:sync', id),
  // Address-bar autocomplete (task-ff707aea93d8): ranked suggestions from
  // visited-URL history + a known-host seed, computed in main. NON-PHI (plain
  // urls/titles). Mirrors `UrlSuggestion` in src/bridge.ts.
  browserSuggest: (query: string) =>
    ipcRenderer.invoke('browser:suggest', query) as Promise<
      { url: string; host: string; title?: string; kind: 'history' | 'bookmark' | 'known' }[]
    >,
  // Teach-by-recording (task-01facbf6b0bc): record the human's actions in this
  // view, capturing every selector candidate so Claude Code can pick the
  // stablest. Stop returns the recorded {action,url,candidates,best} list.
  browserRecordStart: (id: number) =>
    ipcRenderer.invoke('browser:record:start', id) as Promise<{ ok: boolean; error?: string }>,
  browserRecordStop: (opts?: { skillName?: string }) =>
    ipcRenderer.invoke('browser:record:stop', opts) as Promise<{
      ok: boolean;
      error?: string;
      actions?: unknown[];
      site?: string;
      saved?: boolean;
    }>,
  browserRecordState: () =>
    ipcRenderer.invoke('browser:record:state') as Promise<{
      recording: boolean;
      count: number;
      webContentsId: number | null;
    }>,
  // Full-page screenshot → PDF: auto-scroll + capture each viewport, save as
  // one PDF (electron/browser/screenshot-pdf.ts).
  browserScreenshotPdf: (id: number, opts?: { outPath?: string }) =>
    ipcRenderer.invoke('browser:screenshot-pdf', id, opts) as Promise<{
      ok: boolean;
      error?: string;
      path?: string;
      pages?: number;
    }>,
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
  // task-2e6c926c466c — Ctrl/Cmd+B: launch (or focus) the ad-hoc browser + agent
  // pair in the operator window. Reuses the operator session-spawn path in main;
  // returns whether a fresh session launched or an existing one was focused.
  openAdHocBrowser: () =>
    ipcRenderer.invoke('browser:adhoc-open') as Promise<{
      launched: boolean;
      reused: boolean;
      ptyId: number;
    }>,
  // SPIKE (spike/playwright-cdp): main → renderer request to OPEN a browser
  // tab (e.g. the `playwright` task flag opens one for the agent to drive).
  onBrowserOpen: (cb: (s: { url?: string }) => void) => {
    const handler = (_e: unknown, payload: { url?: string }) => cb(payload);
    ipcRenderer.on('browser:open', handler);
    return () => ipcRenderer.off('browser:open', handler);
  },
  // Login-submit capture (task-1188c6535e91): main → renderer event carrying a
  // captured { origin, username, password } from a human login in an embedded
  // browser tab. SECURITY: the password is for the TRUSTED "Save password?"
  // prompt ONLY — the renderer must not persist or log it until the user
  // accepts. We forward it verbatim and never log it here.
  onBrowserCredentialCaptured: (
    cb: (s: {
      id: number;
      origin: string;
      username: string;
      password: string;
    }) => void,
  ) => {
    const handler = (_e: unknown, payload: Parameters<typeof cb>[0]) =>
      cb(payload);
    ipcRenderer.on('browser:credential-captured', handler);
    return () => ipcRenderer.off('browser:credential-captured', handler);
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
  // task-3abb663aba25 — cache-only peek for the renderer diff-apply path.
  tasksPeek: (source: string, ids: string[], filter?: unknown) =>
    ipcRenderer.invoke('tasks:peek', source, ids, filter),
  // task-3abb663aba25 — per-project done/cancelled counts from the DB skeleton.
  tasksTerminalCounts: () => ipcRenderer.invoke('tasks:terminalCounts'),
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
  // task-b3fb2928bb3c (Phase 1) — `tasks:changed` may now carry an OPTIONAL
  // PHI-free diff payload ({ source, added, changed, removed } — opaque ids
  // only). Forwarded to the callback so the renderer can prune removed rows /
  // skip a full re-pull. Legacy emitters send no payload (cb gets undefined),
  // preserving the existing full-re-pull contract.
  onTasksChanged: (
    cb: (
      detail?: {
        source: string;
        added: string[];
        changed: string[];
        removed: string[];
      },
    ) => void,
  ) => {
    const handler = (
      _e: unknown,
      detail?: {
        source: string;
        added: string[];
        changed: string[];
        removed: string[];
      },
    ) => cb(detail);
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
  // fm-5xy — mirror the start-at / near-due reminder mode to main (the daily
  // 8am tick + startup catch-up run in main). Fire-and-forget on boot + change.
  setTaskReminders: (value: 'off' | 'start' | 'start-near-due') =>
    ipcRenderer.send('settings:taskReminders', value),
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
      operator?: boolean;
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
        operator?: boolean;
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
    // Site-keyed credential store — per-user web logins (origin, username) →
    // password (Save-password prompt task-ad89064bf45f / vault task-d60860fb4d7f).
    // The password is encrypted at rest server-side and crosses ONLY on save and
    // on an explicit resolve. We never log it on this hop. `list` is value-free.
    credentials: {
      list: (origin?: string) =>
        ipcRenderer.invoke('typebuild:cred:list', origin) as Promise<
          SavedCredential[]
        >,
      resolve: (origin: string, username: string) =>
        ipcRenderer.invoke('typebuild:cred:resolve', origin, username) as Promise<string>,
      // task-e550e3a1f512 — compare a captured login against the vault; only the
      // verdict crosses back (no stored password).
      match: (origin: string, username: string, password: string) =>
        ipcRenderer.invoke('typebuild:cred:match', origin, username, password) as Promise<
          'absent' | 'match' | 'differs'
        >,
      save: (cred: { origin: string; username: string; password: string }) =>
        ipcRenderer.invoke('typebuild:cred:save', cred) as Promise<{
          origin: string;
          username: string;
        }>,
      remove: (origin: string, username: string) =>
        ipcRenderer.invoke('typebuild:cred:delete', origin, username) as Promise<void>,
    },
    // task-1af4f59428eb — task `data` (class-1 PHI) resolve, for New Home's own
    // display reads (TaskDetailDialog "Details" grid), separate from the
    // browser-agent fill path (electron/api-server.ts /app/task-data). One ref
    // per call; resolves to null (never throws) when there's no value to show —
    // never logged on this hop.
    taskData: {
      resolve: (taskId: string, ref: string) =>
        ipcRenderer.invoke('typebuild:data:resolve', taskId, ref) as Promise<string | null>,
      // task-4a8d2c98f667 — Inputs section edit/add. See ipc-task-data.ts
      // registerTypebuildTaskDataIpc for the resolve-merge-replace mechanics.
      patch: (
        taskId: string,
        upsert: Record<string, string>,
        deleteKeys: string[],
        knownSiblingKeys: string[],
      ) =>
        ipcRenderer.invoke(
          'typebuild:data:patch',
          taskId,
          upsert,
          deleteKeys,
          knownSiblingKeys,
        ) as Promise<
          { ok: true; droppedKeys: string[] } | { ok: false; status?: number; error: string }
        >,
    },
    // task-ab1d7955e23f — TypeBuild Projects: named task containers with
    // optional instructions + owned folders. NON-PHI; server-backed via the
    // TypeBuild source. `resolve` is the auto-attach lookup (folder → owner or
    // null).
    projects: {
      list: (includeArchived?: boolean) =>
        ipcRenderer.invoke(
          'typebuild:projects:list',
          includeArchived,
        ) as Promise<Project[]>,
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
      // task-fdf3dc6b3c5c — PROJECT-scope teach write-back. Structured result:
      // { ok:true, project } | { ok:false, reason, status } (403 not_owner /
      // 422 phi_rejected / 404 not_visible) so the UI shows a message, not a crash.
      patch: (
        id: string,
        patch: { name?: string; description?: string; instructions?: string },
      ) =>
        ipcRenderer.invoke('typebuild:projects:patch', id, patch) as Promise<
          | { ok: true; project: Project }
          | { ok: false; reason: string; status: number }
        >,
      archive: (id: string) =>
        ipcRenderer.invoke('typebuild:projects:archive', id) as Promise<Project>,
      unarchive: (id: string) =>
        ipcRenderer.invoke('typebuild:projects:unarchive', id) as Promise<Project>,
      // task-a9841cfc0e1b — project CRUD UI. Structured result (same shape as
      // patch) so the confirm dialog can show "this project has tasks —
      // archive instead?" on a 409 rather than crashing.
      delete: (id: string) =>
        ipcRenderer.invoke('typebuild:projects:delete', id) as Promise<
          { ok: true } | { ok: false; reason: string; status: number }
        >,
      addFolder: (id: string, folder: string) =>
        ipcRenderer.invoke(
          'typebuild:projects:addFolder',
          id,
          folder,
        ) as Promise<Project>,
      removeFolder: (id: string, folder: string) =>
        ipcRenderer.invoke(
          'typebuild:projects:removeFolder',
          id,
          folder,
        ) as Promise<Project>,
    },
    // task-896f3f7f5e75 — TypeBuild Agents: the registry the composer's agent
    // picker lists. NON-PHI; server-backed via the TypeBuild source. Mirrors
    // projects.list — [] on a parse miss so the picker degrades to None-only.
    agents: {
      list: () =>
        ipcRenderer.invoke('typebuild:agents:list') as Promise<Agent[]>,
    },
    // task-fd1be6f6b22d — the human group members the composer's "Who runs
    // this?" picker lists next to Claude Code. NON-PHI; server-backed via the
    // TypeBuild source. Mirrors agents.list — [] so the picker degrades to the
    // plain Manual/Claude fallback.
    groups: {
      members: () =>
        ipcRenderer.invoke('typebuild:groups:members') as Promise<GroupMember[]>,
      list: () => ipcRenderer.invoke('typebuild:groups:list') as Promise<Group[]>,
      // Group management (the Groups tab). Mutations reject with a
      // human-readable message the surface shows inline.
      listDetailed: () =>
        ipcRenderer.invoke('typebuild:groups:listDetailed') as Promise<GroupDetail[]>,
      create: (name: string) =>
        ipcRenderer.invoke('typebuild:groups:create', name) as Promise<Group>,
      update: (groupId: string, name: string) =>
        ipcRenderer.invoke('typebuild:groups:update', groupId, name) as Promise<void>,
      remove: (groupId: string, reassignTasksTo?: string) =>
        ipcRenderer.invoke(
          'typebuild:groups:delete',
          groupId,
          reassignTasksTo,
        ) as Promise<void>,
      addMember: (
        groupId: string,
        email: string,
        opts?: { role?: 'admin' | 'member'; direct?: boolean },
      ) =>
        ipcRenderer.invoke('typebuild:groups:addMember', groupId, email, opts) as Promise<{
          status: 'active' | 'pending';
          role: 'admin' | 'member';
        }>,
      removeMember: (groupId: string, principal: string) =>
        ipcRenderer.invoke(
          'typebuild:groups:removeMember',
          groupId,
          principal,
        ) as Promise<void>,
      setMemberRole: (groupId: string, principal: string, role: 'admin' | 'member') =>
        ipcRenderer.invoke(
          'typebuild:groups:setMemberRole',
          groupId,
          principal,
          role,
        ) as Promise<{ ok: boolean; unsupported?: true }>,
      invites: () =>
        ipcRenderer.invoke('typebuild:groups:invites') as Promise<GroupInvite[]>,
      respondToInvite: (groupId: string, accept: boolean) =>
        ipcRenderer.invoke(
          'typebuild:groups:respondToInvite',
          groupId,
          accept,
        ) as Promise<void>,
    },
    // task-62a5b4324954 — Connections: register an external service (REST API
    // or MCP server) with its credentials. The credential is sent to the
    // SERVER vault and never stored/echoed on this machine; `list`/`get`
    // return a creds-stripped ConnectionSummary. Server endpoints are not
    // deployed yet, so list/get degrade to []/null and mutations return a
    // structured { ok:false } (see electron/sources/typebuild.ts).
    connections: {
      list: () =>
        ipcRenderer.invoke('typebuild:connections:list') as Promise<ConnectionSummary[]>,
      get: (id: string) =>
        ipcRenderer.invoke('typebuild:connections:get', id) as Promise<
          ConnectionSummary | null
        >,
      register: (input: ConnectionRegisterInput) =>
        ipcRenderer.invoke('typebuild:connections:register', input) as Promise<
          ConnectionSummary
        >,
      update: (
        id: string,
        patch: Partial<Omit<ConnectionRegisterInput, 'credential'>>,
      ) =>
        ipcRenderer.invoke('typebuild:connections:update', id, patch) as Promise<
          | { ok: true; connection: ConnectionSummary }
          | { ok: false; reason: string; status: number }
        >,
      remove: (id: string) =>
        ipcRenderer.invoke('typebuild:connections:remove', id) as Promise<
          { ok: true } | { ok: false; reason: string; status: number }
        >,
      setCredential: (id: string, credential: ConnectionCredential) =>
        ipcRenderer.invoke(
          'typebuild:connections:setCredential',
          id,
          credential,
        ) as Promise<{ ok: true } | { ok: false; reason: string; status: number }>,
      refreshSpec: (id: string) =>
        ipcRenderer.invoke('typebuild:connections:refreshSpec', id) as Promise<
          ConnectionSummary
        >,
      // task-8f27d842f14d — field-source use of a Connection (docs/
      // connections-design.md §D.2): run ONE declarative lookup CLIENT-DIRECT
      // and return its rows. THIN pass-through — the client-direct HTTP +
      // credential brokering lives in TypeBuildTaskSource.lookupConnection
      // (electron/sources/typebuild.ts), which delegates to the parallel
      // operator-tools task's interpreter (connection-exec.ts).
      lookup: (connectionId: string, callSpec: CallSpec, params: Record<string, string>) =>
        ipcRenderer.invoke(
          'typebuild:connections:lookup',
          connectionId,
          callSpec,
          params,
        ) as Promise<ConnectionLookupRow[]>,
    },
    // task-fdf3dc6b3c5c — TASK-scope teach write-back (per-task note). Same
    // structured-result contract as projects.patch.
    taskNote: (taskId: string, note: string) =>
      ipcRenderer.invoke('typebuild:tasks:note', taskId, note) as Promise<
        { ok: true } | { ok: false; reason: string; status: number }
      >,
    // task-da23979fd907 — append to the USER-facing task message feed. NOT
    // claim-gated. PHI: `text` is sent to the server but never logged. Same
    // structured-result contract as taskNote (400 empty / 404 not_visible).
    taskMessage: (taskId: string, text: string) =>
      ipcRenderer.invoke('typebuild:tasks:message', taskId, text) as Promise<
        { ok: true } | { ok: false; reason: string; status: number }
      >,
    // task-a763ca5be676 — answer a task's PENDING QUESTION (ask_user). Clears
    // pending_question + records the reply on the feed. PHI: `answer` is sent to
    // the server but never logged. Structured result (409 no_pending_question /
    // 404 not_visible / 400 empty) so the inline reply box degrades gracefully.
    taskAnswer: (taskId: string, answer: string) =>
      ipcRenderer.invoke('typebuild:tasks:answer', taskId, answer) as Promise<
        { ok: true } | { ok: false; reason: string; status: number }
      >,
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
    // task-e713f307c422 — SavedQuery selectors. `execute` runs a form-field
    // query on demand (New Task typeahead + the lookup_record copilot action);
    // `list` enumerates approved queries for the Template Editor's source
    // picker. Executed rows' display fields may carry PHI (memory-only, never
    // logged); the list is NON-PHI (name/version/status). See
    // docs/saved-queries-design.md + docs/typebuild-data-field-contract.md.
    queries: {
      execute: (
        savedQueryId: string,
        inputs: Record<string, string>,
        version?: number,
      ) =>
        ipcRenderer.invoke(
          'typebuild:queries:execute',
          savedQueryId,
          inputs,
          version,
        ) as Promise<
          Array<
            {
              ref: { sourceId: string; entityType: string; externalId: string };
            } & Record<string, unknown>
          >
        >,
      list: (status?: string) =>
        ipcRenderer.invoke('typebuild:queries:list', status) as Promise<
          Array<{ id: string; name: string; version: number; status: string; entityType?: string }>
        >,
      // task-73f6304ffb94 — SavedQuery CATALOG for the source-aware key picker.
      // `describe` enumerates each approved query's exposed fields[] (latest
      // approved per family); `describeOne` is the same per-query shape for one
      // id. NON-PHI metadata (field names + types only). [] / null signed out.
      describe: () =>
        ipcRenderer.invoke('typebuild:queries:describe') as Promise<QueryCatalogEntryWire[]>,
      describeOne: (savedQueryId: string) =>
        ipcRenderer.invoke(
          'typebuild:queries:describeOne',
          savedQueryId,
        ) as Promise<QueryCatalogEntryWire | null>,
      // task-d8a0b081eb93 — SavedQuery AUTHORING (design-time CopilotKit flow).
      // `create` files a DRAFT; `get` reads it back (code+schema for the approve
      // card); `approve` is the MANDATORY human gate (draft→approved == publish);
      // `version` clones→draft for iterate-in-chat. Query code/schema NON-PHI.
      create: (input: {
        name: string;
        sourceId: string;
        code: string;
        outputSchema: unknown;
        inputs?: unknown;
        limits?: unknown;
        projectId?: string;
        groupId?: string;
      }) =>
        ipcRenderer.invoke('typebuild:queries:create', input) as Promise<{
          id: string;
          name: string;
          version: number;
          status: string;
        }>,
      get: (savedQueryId: string) =>
        ipcRenderer.invoke('typebuild:queries:get', savedQueryId) as Promise<{
          id: string;
          name: string;
          version: number;
          status: string;
          sourceId: string;
          code: string;
          outputSchema: unknown;
        }>,
      approve: (savedQueryId: string) =>
        ipcRenderer.invoke('typebuild:queries:approve', savedQueryId) as Promise<{
          id: string;
          name: string;
          version: number;
          status: string;
          approvedBy?: string;
        }>,
      version: (
        savedQueryId: string,
        patch?: { code?: string; outputSchema?: unknown; inputs?: unknown; limits?: unknown },
      ) =>
        ipcRenderer.invoke('typebuild:queries:version', savedQueryId, patch) as Promise<{
          id: string;
          name: string;
          version: number;
          status: string;
        }>,
    },
    // task-ae0ec0348930 — FormExtensions (client interpreter + design-time
    // authoring). `list` enumerates extensions ([] signed-out); `create`/`get`/
    // `approve`/`version` are the authoring lifecycle (approve == the mandatory
    // human gate); `runLogic` runs the PURE server-side logic and returns the
    // allowlisted `effects` the interpreter applies (setValue/setVisible/
    // setOptions/validate). Field VALUES cross runLogic (may be PHI, memory-only);
    // config (fields/logic/applies_to) is NON-PHI. See docs/saved-queries-design.md.
    formext: {
      list: (status?: string) =>
        ipcRenderer.invoke('typebuild:formext:list', status) as Promise<FormExtension[]>,
      create: (input: {
        name: string;
        appliesTo: Record<string, unknown>;
        fields: Array<Record<string, unknown>>;
        logic: string;
        limits?: Record<string, unknown>;
        projectId?: string;
        groupId?: string;
      }) => ipcRenderer.invoke('typebuild:formext:create', input) as Promise<FormExtension>,
      get: (id: string) =>
        ipcRenderer.invoke('typebuild:formext:get', id) as Promise<FormExtension>,
      approve: (id: string) =>
        ipcRenderer.invoke('typebuild:formext:approve', id) as Promise<FormExtension>,
      version: (
        id: string,
        patch?: {
          fields?: Array<Record<string, unknown>>;
          logic?: string;
          appliesTo?: Record<string, unknown>;
          limits?: Record<string, unknown>;
        },
      ) => ipcRenderer.invoke('typebuild:formext:version', id, patch) as Promise<FormExtension>,
      runLogic: (id: string, values: Record<string, unknown>, changed: string | null) =>
        ipcRenderer.invoke('typebuild:formext:run-logic', id, values, changed) as Promise<{
          effects: Record<string, unknown>;
          version: number;
        }>,
    },
    // task-d8a0b081eb93 — DataSource registry (the "API spec" grounding context
    // for the authoring LLM: name + base_url + entity_types; NO creds — stripped
    // server-side). Read-only from the client.
    datasources: {
      list: () =>
        ipcRenderer.invoke('typebuild:datasources:list') as Promise<
          Array<{ id: string; name: string; baseUrl: string; entityTypes: string[] }>
        >,
    },
    // task-e112d60a3b7c — first-class Task Templates (the "New from Template"
    // picker). `list` enumerates project + global templates (NON-PHI: names +
    // field defs, no prompt body — [] signed-out so the picker degrades);
    // `get` fetches one full template incl. the decrypted `notes` (PHI,
    // memory-only); `instantiate` creates a real task server-side from the
    // filled-in `values` (MAY be PHI — never logged; server encrypts) and
    // returns its id. Templates are auto-registered server-side on task-create;
    // the client never creates one itself. See docs/task-templates-design.md.
    templates: {
      list: (projectId?: string) =>
        ipcRenderer.invoke('typebuild:templates:list', projectId) as Promise<Template[]>,
      get: (id: string) =>
        ipcRenderer.invoke('typebuild:templates:get', id) as Promise<Template | null>,
      // task-57e1470fad6f — edit a template definition (owner-only server-side).
      update: (
        id: string,
        patch: {
          name?: string;
          variables?: TemplateField[];
          outputSchema?: TemplateField[];
          notes?: string;
          agentId?: string | null;
          flags?: string[];
          projectId?: string | null;
          groupId?: string | null;
        },
      ) => ipcRenderer.invoke('typebuild:templates:update', id, patch) as Promise<Template>,
      instantiate: (
        templateId: string,
        values: Record<string, string>,
        titleOverride?: string,
        projectId?: string,
      ) =>
        ipcRenderer.invoke(
          'typebuild:templates:instantiate',
          templateId,
          values,
          titleOverride,
          projectId,
        ) as Promise<{ id: string; status: string }>,
    },
    // task-41e5fc25ed2b (picker slice) — server-side ChainDefs in the "New from
    // Template" picker. `list` enumerates chains (NON-PHI: step title/body
    // templates + field defs — [] signed-out so the picker degrades to single
    // templates only); `create` files a new ChainDef from INLINE steps;
    // `instantiate` atomically creates a parent container + one child task per
    // step (empty step_inputs from the picker — a ChainDef has no per-run vars)
    // and returns { parentTaskId, taskIds }. Chain rendering/builder deferred.
    chains: {
      list: (projectId?: string) =>
        ipcRenderer.invoke('typebuild:chains:list', projectId) as Promise<ChainDef[]>,
      create: (chainDef: {
        name: string;
        steps: unknown[];
        project_id?: string;
        group_id?: string;
      }) => ipcRenderer.invoke('typebuild:chains:create', chainDef) as Promise<ChainDef>,
      instantiate: (chainId: string, stepInputs?: Array<Record<string, string>>) =>
        ipcRenderer.invoke('typebuild:chains:instantiate', chainId, stepInputs) as Promise<{
          parentTaskId: string;
          taskIds: string[];
        }>,
    },
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
  // ─── DSL tags (task-317c7fe41f90) ─────────────────────────────────
  // Selector-based tag store (src/tagStore.mjs) owned by main in
  // userData/tags.json. Additive — runs alongside the criterion tag system.
  // A `selector` is a tagDsl query string; `mode` is 'live'|'frozen' (frozen
  // pins a `snapshot` of paths). NON-PHI (tag names + selectors only).
  dslTags: {
    list: () => ipcRenderer.invoke('dsltags:list') as Promise<DslTag[]>,
    get: (id: string) =>
      ipcRenderer.invoke('dsltags:get', id) as Promise<DslTag | null>,
    create: (input: DslTagCreate) =>
      ipcRenderer.invoke('dsltags:create', input) as Promise<DslTag>,
    update: (id: string, patch: DslTagUpdate) =>
      ipcRenderer.invoke('dsltags:update', id, patch) as Promise<DslTag | null>,
    delete: (id: string) =>
      ipcRenderer.invoke('dsltags:delete', id) as Promise<boolean>,
  },
  // ─── LLM tag frontend (fm-2ln / fm-5rk) ───────────────────────────
  // Metadata-only NL→DSL compilation. The API key stays in main; the renderer
  // sends a prebuilt prompt payload (assembled by src/tagCompose.mjs) and gets
  // raw model text back, which it validates locally. `available` gates the UI.
  llm: {
    available: () => ipcRenderer.invoke('llm:available') as Promise<boolean>,
    run: (payload: {
      model: string;
      system: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      maxTokens?: number;
    }) =>
      ipcRenderer.invoke('llm:run', payload) as Promise<
        { ok: true; text: string } | { ok: false; code?: string; error: string }
      >,
    reloadKey: () => ipcRenderer.invoke('llm:reloadKey') as Promise<boolean>,
    // Set/clear the userData/llm.json key (Settings UI). Pass '' to clear.
    // SECURITY: the key crosses to main and is written there; it is never
    // logged on this hop. Returns whether a key is now resolvable.
    setKey: (key: string) =>
      ipcRenderer.invoke('llm:setKey', key) as Promise<boolean>,
  },
  // fm-ued6 — cold-start profiling: the renderer fires this once after its
  // first committed frame so the main process can close out the startup
  // timeline at the "first interactive frame" boundary. NON-PHI, fire-and-forget.
  reportFirstPaint: () => ipcRenderer.send('app:firstPaint'),
  // task-8676ddafadf0 — CopilotKit sidebar foundation. Connection metadata
  // only (no key, no chat content crosses this hop).
  copilot: {
    info: () =>
      ipcRenderer.invoke('copilot:info') as Promise<{
        enabled: boolean;
        port?: number;
        endpoint?: string;
      }>,
  },
};

contextBridge.exposeInMainWorld('fm', fm);

export type FmApi = typeof fm;
