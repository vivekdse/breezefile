import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  Bookmarks,
  CustomTag,
  Entry,
  FolderPrefs,
  FolderPrefsMap,
  Keybinds,
  Tab,
  TagPaths,
  Tags,
  YankEntry,
} from './types';
import { fm } from './bridge';
import { visibleEntries, filterTabKey } from './actions';
import { filterEntries } from './filterEntries.mjs';
import { isEditablePath } from './fileTypes.ts';

const STORAGE_KEY = 'fm-state-v1';

// Track which paths have already triggered the privacy help dialog so a
// protected folder doesn't re-open it on every revisit.
const shownPrivacyFor = new Set<string>();

function isPermissionError(msg: string): boolean {
  return /EACCES|EPERM|operation not permitted|permission denied/i.test(msg);
}

// Ranger-compatible defaults (rc.conf). Where ranger has overlapping terms
// we prefer muscle memory: `om` mtime, `ot` type, `or` toggle-reverse, etc.
const DEFAULT_KEYBINDS: Keybinds = {
  // --- motion ---
  'nav.down': 'j',
  'nav.up': 'k',
  'nav.left': 'h',
  'nav.right': 'l',
  'nav.top': 'gg',
  'nav.bottom': 'G',
  'nav.open': 'Enter',
  'nav.parent': 'Backspace',
  'nav.halfDown': 'C-d',
  'nav.halfUp': 'C-u',
  'nav.pageDown': 'C-f',
  'nav.pageUp': 'C-b',
  'nav.historyBack': 'H',
  'nav.historyFwd': 'L',
  // --- quick cd (g-prefix) ---
  'goto.home': 'gh',
  'goto.root': 'g/',
  'goto.etc': 'ge',
  'goto.usr': 'gu',
  'goto.dev': 'gd',
  'goto.opt': 'go',
  'goto.var': 'gv',
  'goto.tmp': 'gp',
  'goto.srv': 'gs',
  'goto.media': 'gm',
  'goto.mnt': 'gM',
  // --- search / filter ---
  'find.live': '/',
  'find.next': 'n',
  'find.prev': 'N',
  'find.quick': 'f',
  'filter': 'zf',
  'command': ':',
  'shell': '!',
  'shell.here': 's',
  // --- selection ---
  'mark': ' ',
  'markInvert': 'v',
  'mark.all': 'uv',
  // --- file ops ---
  'yank': 'yy',
  'cut': 'dd',
  'paste': 'pp',
  'paste.overwrite': 'po',
  'paste.symlink': 'pl',
  'paste.symlinkRel': 'pL',
  'paste.hardlink': 'phl',
  'trash': 'dD',
  'delete.force': 'dF',
  'rename': 'cw',
  'rename.beforeExt': 'a',
  'rename.append': 'A',
  'rename.prepend': 'I',
  'bulkRename': ':bulkrename',
  'mkdir': 'F7',
  'touch': ':touch',
  'reveal': 'R',
  'refresh': 'C-r',
  // --- tabs ---
  'tab.new': 'gn',
  'tab.close': 'gw',
  'tab.next': 'gt',
  'tab.prev': 'gT',
  'tab.restore': 'ga',
  'tab.jumpN': 'g<n>',
  // --- sort (lowercase asc, uppercase desc; or toggles reverse) ---
  'sort.natural': 'on',
  'sort.size': 'os',
  'sort.mtime': 'om',
  'sort.ctime': 'oc',
  'sort.type': 'ot',
  'sort.ext': 'oe',
  'sort.rev': 'or',
  'sort.natural.rev': 'oN',
  'sort.size.rev': 'oS',
  'sort.mtime.rev': 'oM',
  'sort.ctime.rev': 'oC',
  'sort.type.rev': 'oT',
  'sort.ext.rev': 'oE',
  // --- view ---
  'hidden': 'zh',
  // fm-k9dg — "directories first" toggle (traditional ON; turn off to
  // see newest items in Downloads without folders crowding the top).
  'foldersFirst': 'zd',
  'view.list': 'wl',
  'view.grid': 'wg',
  'view.preview': 'wp',
  'view.tag': 'wt',
  'theme': 'zT',
  // --- bookmarks / tags ---
  'bookmark.set': 'm<k>',
  'bookmark.jump': "'<k>",
  'bookmark.unset': 'um<k>',
  'tag': 't<k>',
  'tag.clear': 'ut',
  // --- misc ---
  'settings': '?',
  'quit': 'ZZ',
  'quit.force': 'ZQ',
};

// fm-h8g7 — verbosity for task notifications. Mirrors the main-process
// notify-settings enum.
export type TaskNotifyVerbosity = 'all' | 'failures' | 'off';

// fm-5xy — start-at / near-due reminder mode. Mirrors the main-process
// task-reminders module. 'off' = none; 'start' = tasks whose start_at is today
// (default); 'start-near-due' = start-today plus tasks due tomorrow.
export type TaskReminderMode = 'off' | 'start' | 'start-near-due';

// Only durable preferences persist — tabs always start fresh at $HOME so a
// stale trail never greets you on launch.
type Persisted = {
  bookmarks: Bookmarks;
  tags: Tags;
  keybinds: Keybinds;
  recents: string[]; // LRU of recently-visited folders, most recent first
  recentFiles: string[]; // LRU of recently-opened files, most recent first
  pinned: string[]; // user-pinned folder paths shown in sidebar Favorites
  // fm-60k — user-authored tags (manual-only v1) and the path lists they
  // were applied to. tagPaths is keyed by tag id; covers both custom and
  // seeded tags (a built-in like 'recent' can also receive manual pins).
  customTags: CustomTag[];
  tagPaths: TagPaths;
  // fm-22o — opt-in toggle for the task management subsystem. When false
  // the sidebar Active Tasks section, :task / :tasks verbs, dialog, and
  // tasks page are all hidden, and ~/.breezefile is never created. The
  // mental model is PyPI extras: fresh installs get pure file management;
  // users who want folder-anchored to-dos + agent integration opt in via
  // Settings. Existing installs that already have a tasks DB are migrated
  // to true on first launch with this flag (see App.tsx hydrate path).
  taskManagementEnabled: boolean;
  // Opt-in toggle for the TypeBuild task backend. When false the TypeBuild
  // sign-in / onboarding (Settings → TypeBuild) and the sidebar sign-in
  // indicators are hidden — a fresh install gets pure local file/task
  // management and only sees TypeBuild once it's deliberately turned on.
  // Lives in the TypeBuild Settings section above the sign-in panel.
  // Migrated to true on first launch for users already signed in to
  // TypeBuild (see App/store hydrate path) so we don't hide their backend.
  typebuildEnabled: boolean;
  // fm-9iha — default agent launcher id for the chat panel (fm-dly3). null =
  // fall back to a 'claude' launcher, else the first AI launcher.
  defaultAgentId: string | null;
  // fm-c2w — system notification when a backgrounded tab's terminal
  // demands attention (cursor reappears or BEL/OSC9). Default ON since
  // it's the differentiator over tmux/iTerm. Sound separate and OFF by
  // default — the visual + dock badge is plenty unless the user opts in.
  notifyOnAttention: boolean;
  soundOnAttention: boolean;
  // fm-h8g7 — verbosity for TASK notifications (agent run completions +
  // remote TypeBuild task transitions). Distinct from the terminal-attention
  // toggles above. 'all' = run successes/failures + remote changes; 'failures'
  // = failures only; 'off' = none. Default 'all'. The value is mirrored to the
  // main process (which owns the OS-notification gate) over the
  // settings:taskNotifications IPC on boot + on every change.
  taskNotifications: TaskNotifyVerbosity;
  // fm-5xy — when to raise a start-at / near-due task reminder. 'off' = none;
  // 'start' = notify on tasks whose start_at is today (default); 'start-near-due'
  // = also remind about tasks due tomorrow. Mirrored to the main process (which
  // owns the daily 8am tick + startup catch-up) over settings:taskReminders.
  taskReminders: TaskReminderMode;
  // fm-hzo — when true, terminal spawns wrap in `tmux new-session -A -s
  // <tab-label>`. Two tabs with the same label share a tmux session;
  // closing & re-opening a terminal reattaches to the still-running
  // session. Default OFF — relies on tmux being on PATH.
  useTmux: boolean;
  // fm-k9dg — per-folder remembered view preferences. Written only when
  // the user makes a conscious choice (verb or sticky keybind). Hydrated
  // onto a tab when its leaf cwd changes. Folders the user never
  // customized stay absent here, so navigation does not clobber the
  // tab's current settings.
  folderPrefs: FolderPrefsMap;
};

const RECENTS_CAP = 30;

type State = Persisted & {
  tabs: Tab[];
  activeTab: number;
  entriesByPath: Record<string, Entry[]>; // cache
  yank: YankEntry[];
  statusMsg: string;
  mode: 'normal' | 'find' | 'command' | 'quickfind';
  modeBuffer: string;
  modeVerb: string; // optional pre-selected verb id when entering 'command' mode
  pending: string; // multi-key buffer for vim-style chords
  lastFind: string; // for n/N repeat
  lastClosedTab: Tab | null; // for ga "restore tab"
  // fm-h8g7 — unseen task-notification count for the sidebar badge. Bumped by
  // run success/failure + remote transition events while the Tasks page tab is
  // NOT active; cleared when the user opens/activates the Tasks page. Not
  // persisted — it's an ephemeral attention signal.
  tasksBadgeCount: number;
};

type Action =
  | { type: 'hydrate'; state: Partial<Persisted> }
  | { type: 'setHome'; home: string }
  | { type: 'setEntries'; path: string; entries: Entry[] }
  | { type: 'updateTab'; index: number; patch: Partial<Tab> }
  | { type: 'replaceTab'; index: number; tab: Tab }
  | { type: 'newTab'; tab: Tab }
  | { type: 'openFilterTab'; selector: string; scope?: string; focus?: boolean }
  | { type: 'openTaskTab'; taskId: string; folder: string; focus?: boolean }
  | { type: 'openTasksTab'; focus?: boolean }
  | { type: 'openProjectsTab'; focus?: boolean }
  | { type: 'openEditTab'; path: string; focus?: boolean }
  | { type: 'setTabDirty'; index: number; dirty: boolean }
  | { type: 'openOrFocusFolderTab'; path: string; focus?: boolean }
  | { type: 'setTabTaskId'; index: number; taskId: string | null }
  | { type: 'closeTab'; index: number }
  | { type: 'selectTab'; index: number }
  | { type: 'setYank'; yank: YankEntry[] }
  | { type: 'setStatus'; msg: string }
  | { type: 'setMode'; mode: State['mode']; buffer?: string; verb?: string }
  | { type: 'setModeBuffer'; buffer: string }
  | { type: 'setPending'; pending: string }
  | { type: 'setBookmark'; key: string; path: string }
  | { type: 'unsetBookmark'; key: string }
  | { type: 'setTag'; path: string; tag: string | null }
  | { type: 'setKeybinds'; keybinds: Keybinds }
  | { type: 'setTaskManagementEnabled'; enabled: boolean }
  | { type: 'setTypebuildEnabled'; enabled: boolean }
  | { type: 'setDefaultAgentId'; id: string | null }
  | { type: 'setLastFind'; query: string }
  | { type: 'restoreTab' }
  | { type: 'pushRecent'; path: string }
  | { type: 'pushRecentFile'; path: string }
  | { type: 'pinFolder'; path: string }
  | { type: 'unpinFolder'; path: string }
  | { type: 'createCustomTag'; tag: CustomTag }
  | { type: 'deleteCustomTag'; id: string }
  | { type: 'applyTag'; id: string; paths: string[] }
  | { type: 'untagPaths'; id: string; paths: string[] }
  | { type: 'addTagViz'; id: string }
  | { type: 'setNotifyOnAttention'; value: boolean }
  | { type: 'setSoundOnAttention'; value: boolean }
  | { type: 'setTaskNotifications'; value: TaskNotifyVerbosity }
  | { type: 'setTaskReminders'; value: TaskReminderMode }
  | { type: 'bumpTasksBadge'; by?: number }
  | { type: 'clearTasksBadge' }
  | { type: 'setUseTmux'; value: boolean }
  | { type: 'setFolderPref'; path: string; patch: FolderPrefs }
  | { type: 'clearFolderPref'; path: string }
  | {
      type: 'openTerminal';
      tabIndex: number;
      ptyId: number;
      cwd: string;
      label?: string;
      source?: string;
      // fm-7909 — owning task id for a session-per-task terminal. Lets
      // useRunningSessions() map taskId → open session tab so the Tasks page
      // can offer "Open session" instead of a second Start.
      taskId?: string;
      // Return to the Tasks tab when this terminal exits (set when launched
      // from the Tasks tab). See the terminal field of the same name.
      returnToTasksOnExit?: boolean;
    }
  | { type: 'closeTerminal'; tabIndex: number }
  | {
      type: 'setTerminalAttention';
      tabIndex: number;
      attention: 'idle' | 'busy' | 'bell' | null;
    }
  // fm-b5at.10 — repoint a tab's terminal onto a freshly-spawned pty after a
  // TypeBuild expiry relaunch. Keyed by the OLD ptyId so the renderer doesn't
  // need to know the tab index; resets attention since the pty is brand new.
  | {
      type: 'repointTerminal';
      oldPtyId: number;
      newPtyId: number;
      cwd: string;
      label?: string;
    }
  // fm-dly3 — agent chat side-panel
  | {
      type: 'openChat';
      tabIndex: number;
      ptyId: number;
      cwd: string;
      agentId: string;
      label?: string;
    }
  | { type: 'closeChat'; tabIndex: number }
  | {
      type: 'setChatAttention';
      tabIndex: number;
      attention: 'idle' | 'busy' | 'bell' | null;
    };

function makeTab(
  path: string,
  opts?: {
    kind?: 'folder' | 'task' | 'tasks' | 'edit' | 'browser' | 'projects';
    taskId?: string | null;
    editPath?: string | null;
    browserUrl?: string;
    // fm-mp1 — open as a filter-tab (smart folder). `boundSelector` is a tagDsl
    // query; `scopePath` is the walk root (defaults to the tab's path).
    boundSelector?: string;
    scopePath?: string;
  },
): Tab {
  const id = crypto.randomUUID();
  // fm-mp1 — a filter-tab caches its matched entries under a synthetic per-tab
  // key (never a real path), so its trail leaf is that key rather than `path`.
  // Every entriesByPath reader keys off the trail leaf, so they all work
  // unchanged while the real scope directory's own listing stays untouched.
  const trail = opts?.boundSelector ? [filterTabKey(id)] : [path];
  return {
    id,
    kind: opts?.kind ?? 'folder',
    taskId: opts?.taskId ?? null,
    editPath: opts?.editPath ?? null,
    browserUrl: opts?.browserUrl,
    boundSelector: opts?.boundSelector,
    // fm-mp1 — explicit scope only; a filter-tab with no scope walks home
    // (resolved at load time via fm.homedir()), per the task's default.
    scopePath: opts?.scopePath,
    dirty: false,
    trail,
    selected: { 0: 0 },
    marks: {},
    sortKey: 'name',
    sortReverse: false,
    showHidden: false,
    viewMode: 'list',
    foldersFirst: true,
    filter: '',
    tagViz: [],
    tagFilter: { mode: 'off', ids: [] },
    history: [],
    forward: [],
  };
}

export { makeTab };

const initialState: State = {
  tabs: [],
  activeTab: 0,
  bookmarks: {},
  tags: {},
  keybinds: DEFAULT_KEYBINDS,
  recents: [],
  recentFiles: [],
  pinned: [],
  customTags: [],
  tagPaths: {},
  // fm-22o — default ON. The toggle in Settings lets users opt out;
  // gating discoverability behind a flag-off-by-default created friction
  // for the primary use case (task-anchored AI workflows). Migration
  // probe can also turn it ON for installs that already have a tasks DB
  // but didn't carry the field; the explicit-false path stays available
  // for users who turn it off in Settings.
  taskManagementEnabled: true,
  // Default OFF — TypeBuild is opt-in. The hydrate migration flips it ON
  // for users already signed in so existing setups keep their backend.
  typebuildEnabled: false,
  defaultAgentId: null,
  notifyOnAttention: true,
  soundOnAttention: true,
  taskNotifications: 'all',
  taskReminders: 'start',
  useTmux: false,
  folderPrefs: {},
  entriesByPath: {},
  yank: [],
  statusMsg: '',
  mode: 'normal',
  modeBuffer: '',
  modeVerb: '',
  pending: '',
  lastFind: '',
  lastClosedTab: null,
  tasksBadgeCount: 0,
};

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'hydrate':
      return { ...s, ...a.state, entriesByPath: s.entriesByPath };
    case 'setHome':
      if (s.tabs.length > 0) return s;
      return { ...s, tabs: [makeTab(a.home)], activeTab: 0 };
    case 'setEntries':
      return { ...s, entriesByPath: { ...s.entriesByPath, [a.path]: a.entries } };
    case 'updateTab': {
      const tabs = s.tabs.slice();
      tabs[a.index] = { ...tabs[a.index], ...a.patch };
      return { ...s, tabs };
    }
    case 'replaceTab': {
      const tabs = s.tabs.slice();
      tabs[a.index] = a.tab;
      return { ...s, tabs };
    }
    case 'newTab':
      return { ...s, tabs: [...s.tabs, a.tab], activeTab: s.tabs.length };
    case 'openFilterTab': {
      // fm-mp1 — open a selector as a live filter-tab (smart folder). The tab
      // is a folder-kind tab with boundSelector set; makeTab parks a synthetic
      // cache key in its trail leaf. scopePath defaults to home — left
      // undefined here so loadFilterTab resolves it via fm.homedir().
      const seed = a.scope || s.tabs[s.activeTab]?.trail.at(-1) || '/';
      const tab = makeTab(seed, {
        boundSelector: a.selector,
        scopePath: a.scope, // undefined → walk home
      });
      return {
        ...s,
        tabs: [...s.tabs, tab],
        activeTab: a.focus !== false ? s.tabs.length : s.activeTab,
      };
    }
    case 'openTaskTab': {
      // fm-1y1 — open or focus a task tab. If a tab already exists for
      // this taskId, focus it; otherwise create a new task-kind tab
      // rooted at the task's folder. Idempotent click-from-sidebar.
      const existing = s.tabs.findIndex(
        (t) => t.kind === 'task' && t.taskId === a.taskId,
      );
      if (existing >= 0) {
        return a.focus !== false ? { ...s, activeTab: existing } : s;
      }
      const tab = makeTab(a.folder, { kind: 'task', taskId: a.taskId });
      return {
        ...s,
        tabs: [...s.tabs, tab],
        activeTab: a.focus !== false ? s.tabs.length : s.activeTab,
      };
    }
    case 'openTasksTab': {
      // fm-yi85 — singleton tasks-overview tab. Focus existing if present;
      // otherwise spawn one rooted at the active tab's cwd (any path works,
      // the trail is unused for kind='tasks' rendering).
      const existing = s.tabs.findIndex((t) => t.kind === 'tasks');
      if (existing >= 0) {
        return a.focus !== false ? { ...s, activeTab: existing } : s;
      }
      const seedCwd =
        s.tabs[s.activeTab]?.trail.at(-1) ?? s.tabs[0]?.trail.at(-1) ?? '/';
      const tab = makeTab(seedCwd, { kind: 'tasks' });
      return {
        ...s,
        tabs: [...s.tabs, tab],
        activeTab: a.focus !== false ? s.tabs.length : s.activeTab,
      };
    }
    case 'openProjectsTab': {
      // task-83048f692491 — singleton Projects-home (Project Atlas) tab.
      // Same lifecycle as openTasksTab: focus existing if present, else spawn
      // one rooted at the active tab's cwd (the trail is unused for render).
      const existing = s.tabs.findIndex((t) => t.kind === 'projects');
      if (existing >= 0) {
        return a.focus !== false ? { ...s, activeTab: existing } : s;
      }
      const seedCwd =
        s.tabs[s.activeTab]?.trail.at(-1) ?? s.tabs[0]?.trail.at(-1) ?? '/';
      const tab = makeTab(seedCwd, { kind: 'projects' });
      return {
        ...s,
        tabs: [...s.tabs, tab],
        activeTab: a.focus !== false ? s.tabs.length : s.activeTab,
      };
    }
    case 'openEditTab': {
      // fm-vu55 — focus an existing edit tab for the same path, else
      // create a new one. The trail is set to the file's parent dir so
      // breadcrumb/title logic has something to render.
      const existing = s.tabs.findIndex(
        (t) => t.kind === 'edit' && t.editPath === a.path,
      );
      const recentFilesNext = (() => {
        const clean = (s.recentFiles ?? []).filter((p) => p !== a.path);
        clean.unshift(a.path);
        if (clean.length > RECENTS_CAP) clean.length = RECENTS_CAP;
        return clean;
      })();
      if (existing >= 0) {
        const base = a.focus !== false ? { ...s, activeTab: existing } : s;
        return { ...base, recentFiles: recentFilesNext };
      }
      const parent = a.path.replace(/\/[^/]+$/, '') || '/';
      const tab = makeTab(parent, { kind: 'edit', editPath: a.path });
      return {
        ...s,
        tabs: [...s.tabs, tab],
        activeTab: a.focus !== false ? s.tabs.length : s.activeTab,
        recentFiles: recentFilesNext,
      };
    }
    case 'setTabDirty': {
      const tabs = s.tabs.slice();
      const t = tabs[a.index];
      if (!t) return s;
      if ((t.dirty ?? false) === a.dirty) return s;
      tabs[a.index] = { ...t, dirty: a.dirty };
      return { ...s, tabs };
    }
    case 'openOrFocusFolderTab': {
      // fm-dj5 — open or focus a folder tab for `path`. Match on
      // trail.last so a tab the user has navigated into still counts as
      // "the tab for this folder." Used when the active tab is a task
      // tab (sidebar / footer clicks must not corrupt its bound trail).
      const existing = s.tabs.findIndex(
        (t) => t.kind === 'folder' && t.trail[t.trail.length - 1] === a.path,
      );
      if (existing >= 0) {
        return a.focus !== false ? { ...s, activeTab: existing } : s;
      }
      const tab = makeTab(a.path);
      return {
        ...s,
        tabs: [...s.tabs, tab],
        activeTab: a.focus !== false ? s.tabs.length : s.activeTab,
      };
    }
    case 'setTabTaskId': {
      const tabs = s.tabs.slice();
      const t = tabs[a.index];
      if (!t) return s;
      tabs[a.index] = { ...t, taskId: a.taskId };
      return { ...s, tabs };
    }
    case 'closeTab': {
      if (s.tabs.length <= 1) return s;
      const closed = s.tabs[a.index];
      const tabs = s.tabs.filter((_, i) => i !== a.index);
      const active = Math.min(s.activeTab, tabs.length - 1);
      return { ...s, tabs, activeTab: active, lastClosedTab: closed };
    }
    case 'restoreTab': {
      if (!s.lastClosedTab) return s;
      return {
        ...s,
        tabs: [...s.tabs, { ...s.lastClosedTab, id: crypto.randomUUID() }],
        activeTab: s.tabs.length,
        lastClosedTab: null,
      };
    }
    case 'selectTab':
      return { ...s, activeTab: Math.max(0, Math.min(a.index, s.tabs.length - 1)) };
    case 'setYank':
      return { ...s, yank: a.yank };
    case 'setStatus':
      return { ...s, statusMsg: a.msg };
    case 'setMode':
      return { ...s, mode: a.mode, modeBuffer: a.buffer ?? '', modeVerb: a.verb ?? '' };
    case 'setModeBuffer':
      return { ...s, modeBuffer: a.buffer };
    case 'setPending':
      return { ...s, pending: a.pending };
    case 'setBookmark':
      return { ...s, bookmarks: { ...s.bookmarks, [a.key]: a.path } };
    case 'unsetBookmark': {
      const bookmarks = { ...s.bookmarks };
      delete bookmarks[a.key];
      return { ...s, bookmarks };
    }
    case 'setTag': {
      const tags = { ...s.tags };
      if (a.tag) tags[a.path] = a.tag;
      else delete tags[a.path];
      return { ...s, tags };
    }
    case 'setKeybinds':
      return { ...s, keybinds: a.keybinds };
    case 'setTaskManagementEnabled':
      return { ...s, taskManagementEnabled: a.enabled };
    case 'setTypebuildEnabled':
      return { ...s, typebuildEnabled: a.enabled };
    case 'setDefaultAgentId':
      return { ...s, defaultAgentId: a.id };
    case 'setLastFind':
      return { ...s, lastFind: a.query };
    case 'pushRecent': {
      const clean = (s.recents ?? []).filter((p) => p !== a.path);
      clean.unshift(a.path);
      if (clean.length > RECENTS_CAP) clean.length = RECENTS_CAP;
      return { ...s, recents: clean };
    }
    case 'pushRecentFile': {
      const clean = (s.recentFiles ?? []).filter((p) => p !== a.path);
      clean.unshift(a.path);
      if (clean.length > RECENTS_CAP) clean.length = RECENTS_CAP;
      return { ...s, recentFiles: clean };
    }
    case 'pinFolder': {
      const pinned = s.pinned ?? [];
      if (pinned.includes(a.path)) return s;
      return { ...s, pinned: [...pinned, a.path] };
    }
    case 'unpinFolder': {
      return { ...s, pinned: (s.pinned ?? []).filter((p) => p !== a.path) };
    }
    case 'createCustomTag':
      return { ...s, customTags: [...s.customTags, a.tag] };
    case 'deleteCustomTag': {
      const customTags = s.customTags.filter((t) => t.id !== a.id);
      const tagPaths = { ...s.tagPaths };
      delete tagPaths[a.id];
      return { ...s, customTags, tagPaths };
    }
    case 'applyTag': {
      const existing = s.tagPaths[a.id] ?? [];
      const merged = Array.from(new Set([...existing, ...a.paths]));
      return { ...s, tagPaths: { ...s.tagPaths, [a.id]: merged } };
    }
    case 'untagPaths': {
      const existing = s.tagPaths[a.id] ?? [];
      const drop = new Set(a.paths);
      const next = existing.filter((p) => !drop.has(p));
      const tagPaths = { ...s.tagPaths };
      if (next.length === 0) delete tagPaths[a.id];
      else tagPaths[a.id] = next;
      return { ...s, tagPaths };
    }
    case 'setNotifyOnAttention':
      return { ...s, notifyOnAttention: a.value };
    case 'setSoundOnAttention':
      return { ...s, soundOnAttention: a.value };
    case 'setTaskNotifications':
      return { ...s, taskNotifications: a.value };
    case 'setTaskReminders':
      return { ...s, taskReminders: a.value };
    case 'bumpTasksBadge':
      return { ...s, tasksBadgeCount: s.tasksBadgeCount + (a.by ?? 1) };
    case 'clearTasksBadge':
      return s.tasksBadgeCount === 0 ? s : { ...s, tasksBadgeCount: 0 };
    case 'setUseTmux':
      return { ...s, useTmux: a.value };
    case 'setFolderPref': {
      const prev = s.folderPrefs[a.path] ?? {};
      const merged: FolderPrefs = { ...prev, ...a.patch };
      return { ...s, folderPrefs: { ...s.folderPrefs, [a.path]: merged } };
    }
    case 'clearFolderPref': {
      const next = { ...s.folderPrefs };
      delete next[a.path];
      return { ...s, folderPrefs: next };
    }
    case 'addTagViz': {
      const tabs = s.tabs.slice();
      const t = tabs[s.activeTab];
      if (!t || t.tagViz.includes(a.id)) return s;
      tabs[s.activeTab] = { ...t, tagViz: [...t.tagViz, a.id] };
      return { ...s, tabs };
    }
    case 'openTerminal': {
      const tabs = s.tabs.slice();
      const t = tabs[a.tabIndex];
      if (!t) return s;
      tabs[a.tabIndex] = {
        ...t,
        terminal: {
          ptyId: a.ptyId,
          cwd: a.cwd,
          label: a.label,
          attention: null,
          source: a.source,
          // fm-7909 — carry the owning task id so useRunningSessions can map
          // taskId → this session tab.
          taskId: a.taskId,
          returnToTasksOnExit: a.returnToTasksOnExit,
        },
      };
      return { ...s, tabs };
    }
    case 'closeTerminal': {
      const t = s.tabs[a.tabIndex];
      if (!t) return s;
      // A session launched from the Tasks tab returns there on exit rather
      // than leaving a bare folder listing of the workspace dir. Prefer
      // closing this session tab and focusing the surviving Tasks tab; if none
      // survived, convert this tab into the Tasks view in place.
      if (t.terminal?.returnToTasksOnExit) {
        const tasksIdx = s.tabs.findIndex((tb) => tb.kind === 'tasks');
        if (tasksIdx >= 0 && tasksIdx !== a.tabIndex && s.tabs.length > 1) {
          const wasActive = s.activeTab === a.tabIndex;
          const tabs = s.tabs.filter((_, i) => i !== a.tabIndex);
          // Only yank focus to Tasks when the user was watching the session
          // tab; otherwise preserve their current tab (index shifts down by
          // one if it sat after the removed tab).
          let activeTab = wasActive
            ? tabs.findIndex((tb) => tb.kind === 'tasks')
            : s.activeTab > a.tabIndex
              ? s.activeTab - 1
              : s.activeTab;
          activeTab = Math.max(0, Math.min(activeTab, tabs.length - 1));
          return { ...s, tabs, activeTab, lastClosedTab: t };
        }
        // No separate Tasks tab to return to — convert this one in place. The
        // singleton invariant holds because we only reach here when none exists.
        const tabs = s.tabs.slice();
        const { terminal: _conv, ...rest } = t;
        void _conv;
        tabs[a.tabIndex] = { ...(rest as typeof t), kind: 'tasks', taskId: null };
        return { ...s, tabs };
      }
      const tabs = s.tabs.slice();
      const { terminal: _drop, ...rest } = t;
      void _drop;
      tabs[a.tabIndex] = rest as typeof t;
      return { ...s, tabs };
    }
    case 'setTerminalAttention': {
      const tabs = s.tabs.slice();
      const t = tabs[a.tabIndex];
      if (!t || !t.terminal) return s;
      tabs[a.tabIndex] = {
        ...t,
        terminal: { ...t.terminal, attention: a.attention },
      };
      return { ...s, tabs };
    }
    case 'repointTerminal': {
      const idx = s.tabs.findIndex(
        (t) => t.terminal?.ptyId === a.oldPtyId,
      );
      if (idx < 0) return s;
      const tabs = s.tabs.slice();
      const t = tabs[idx];
      // Preserve the source ('typebuild') + label; swap the ptyId/cwd and
      // clear attention. TerminalSplit keys its <Terminal> on ptyId, so the
      // changed key remounts xterm onto the fresh pty automatically.
      tabs[idx] = {
        ...t,
        terminal: {
          ...t.terminal!,
          ptyId: a.newPtyId,
          cwd: a.cwd,
          label: a.label ?? t.terminal!.label,
          attention: null,
        },
      };
      return { ...s, tabs };
    }
    case 'openChat': {
      const tabs = s.tabs.slice();
      const t = tabs[a.tabIndex];
      if (!t) return s;
      tabs[a.tabIndex] = {
        ...t,
        chat: {
          ptyId: a.ptyId,
          cwd: a.cwd,
          agentId: a.agentId,
          label: a.label,
          attention: null,
        },
      };
      return { ...s, tabs };
    }
    case 'closeChat': {
      const tabs = s.tabs.slice();
      const t = tabs[a.tabIndex];
      if (!t) return s;
      const { chat: _drop, ...rest } = t;
      void _drop;
      tabs[a.tabIndex] = rest as typeof t;
      return { ...s, tabs };
    }
    case 'setChatAttention': {
      const tabs = s.tabs.slice();
      const t = tabs[a.tabIndex];
      if (!t || !t.chat) return s;
      tabs[a.tabIndex] = {
        ...t,
        chat: { ...t.chat, attention: a.attention },
      };
      return { ...s, tabs };
    }
  }
}

type Ctx = {
  state: State;
  dispatch: React.Dispatch<Action>;
  activeTab: Tab | undefined;
  loadDir: (p: string) => Promise<Entry[]>;
  refreshActive: () => Promise<void>;
  setTab: (patch: Partial<Tab>) => void;
  /** fm-k9dg — apply a sticky patch to the active tab AND record those
   *  fields as the remembered preference for the tab's current leaf
   *  cwd. Call this from explicit user actions (verbs, sticky keybinds)
   *  for {sortKey, sortReverse, viewMode, showHidden, foldersFirst}. */
  setTabSticky: (patch: FolderPrefs) => void;
  openPath: (p: string) => Promise<void>;
  navigateTo: (p: string) => void;
  goBack: () => void;
  goForward: () => void;
  focusEntryByName: (name: string) => void;
};

const StoreCtx = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Gate the persist effect until hydration finishes. Without this, on
  // first render the persist effect closes over `initialState` and writes
  // useTmux=false / soundOnAttention=false / etc. to localStorage BEFORE
  // the hydrate dispatch settles — clobbering whatever the user had
  // saved. Using state (not a ref) here is intentional: the persist
  // effect's closure captures `hydrated` from render 1 (false) and skips,
  // and only runs for real on render 2 (after setHydrated(true) settles
  // alongside the hydrate dispatch). A ref wouldn't give us that gate
  // because refs mutate synchronously in the same effects pass, so the
  // persist effect would still see `true` while closing over render-1
  // state and clobber.
  const [hydrated, setHydrated] = useState(false);

  // Hydrate durable prefs + always open a fresh home tab.
  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<Persisted> & {
          tabs?: unknown;
          activeTab?: unknown;
        };
        // Drop any legacy `tabs`/`activeTab` fields from older builds.
        const {
          bookmarks,
          tags,
          keybinds,
          recents,
          recentFiles,
          pinned,
          customTags,
          tagPaths,
          taskManagementEnabled,
          typebuildEnabled,
          defaultAgentId,
          notifyOnAttention,
          soundOnAttention,
          taskNotifications,
          taskReminders,
          useTmux,
          folderPrefs,
        } = parsed as Partial<Persisted>;
        dispatch({
          type: 'hydrate',
          state: {
            ...(bookmarks ? { bookmarks } : {}),
            ...(tags ? { tags } : {}),
            ...(keybinds ? { keybinds } : {}),
            ...(recents ? { recents } : {}),
            ...(recentFiles ? { recentFiles } : {}),
            ...(pinned ? { pinned } : {}),
            ...(customTags ? { customTags } : {}),
            ...(tagPaths ? { tagPaths } : {}),
            ...(taskManagementEnabled !== undefined
              ? { taskManagementEnabled }
              : {}),
            ...(typeof typebuildEnabled === 'boolean'
              ? { typebuildEnabled }
              : {}),
            ...(typeof defaultAgentId === 'string' || defaultAgentId === null
              ? { defaultAgentId }
              : {}),
            ...(typeof notifyOnAttention === 'boolean' ? { notifyOnAttention } : {}),
            ...(typeof soundOnAttention === 'boolean' ? { soundOnAttention } : {}),
            ...(taskNotifications === 'all' ||
            taskNotifications === 'failures' ||
            taskNotifications === 'off'
              ? { taskNotifications }
              : {}),
            ...(taskReminders === 'off' ||
            taskReminders === 'start' ||
            taskReminders === 'start-near-due'
              ? { taskReminders }
              : {}),
            ...(typeof useTmux === 'boolean' ? { useTmux } : {}),
            ...(folderPrefs && typeof folderPrefs === 'object' ? { folderPrefs } : {}),
          } as Partial<Persisted>,
        });
      } catch {
        /* ignore */
      }
    }
    fm.homedir().then((home) => {
      dispatch({ type: 'setHome', home });
    });

    // fm-22o — migration: if the user has a pre-existing tasks DB but
    // localStorage doesn't carry the flag yet (older build), default
    // ON so their existing tasks don't disappear behind the new toggle.
    // Fresh installs see no DB and stay OFF.
    try {
      const parsedFlag = raw
        ? (JSON.parse(raw) as { taskManagementEnabled?: boolean }).taskManagementEnabled
        : undefined;
      if (parsedFlag === undefined) {
        void fm.tasksDbExists().then((exists) => {
          if (exists) {
            dispatch({ type: 'setTaskManagementEnabled', enabled: true });
          }
        });
      }
    } catch {
      /* ignore */
    }

    // Migration: if localStorage doesn't carry typebuildEnabled yet (older
    // build) but the user is already signed in to TypeBuild, default ON so
    // their backend doesn't vanish behind the new toggle. Fresh / signed-out
    // installs stay OFF (the opt-in default).
    try {
      const tbFlag = raw
        ? (JSON.parse(raw) as { typebuildEnabled?: boolean }).typebuildEnabled
        : undefined;
      if (tbFlag === undefined) {
        void fm.typebuild
          .authState()
          .then((s) => {
            if (s.signedIn) {
              dispatch({ type: 'setTypebuildEnabled', enabled: true });
            }
          })
          .catch(() => {});
      }
    } catch {
      /* ignore */
    }
    // Mark hydration complete so the persist effect can start writing.
    setHydrated(true);
  }, []);

  // Persist — only durable prefs, never tab trails.
  useEffect(() => {
    // Skip until hydrate has completed. Otherwise the very first run of
    // this effect (mount, render 1) closes over initialState and writes
    // defaults to localStorage, clobbering the saved values that hydrate
    // is about to read.
    if (!hydrated) return;
    const toPersist: Persisted = {
      bookmarks: state.bookmarks,
      tags: state.tags,
      keybinds: state.keybinds,
      recents: state.recents,
      recentFiles: state.recentFiles,
      pinned: state.pinned,
      customTags: state.customTags,
      tagPaths: state.tagPaths,
      taskManagementEnabled: state.taskManagementEnabled,
      typebuildEnabled: state.typebuildEnabled,
      defaultAgentId: state.defaultAgentId,
      notifyOnAttention: state.notifyOnAttention,
      soundOnAttention: state.soundOnAttention,
      taskNotifications: state.taskNotifications,
      taskReminders: state.taskReminders,
      useTmux: state.useTmux,
      folderPrefs: state.folderPrefs,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toPersist));
  }, [
    state.bookmarks,
    state.tags,
    state.keybinds,
    state.recents,
    state.recentFiles,
    state.pinned,
    state.customTags,
    state.tagPaths,
    state.taskManagementEnabled,
    state.typebuildEnabled,
    state.defaultAgentId,
    state.notifyOnAttention,
    state.soundOnAttention,
    state.taskNotifications,
    state.taskReminders,
    state.useTmux,
    state.folderPrefs,
    hydrated,
  ]);

  // task-eaa5e794f448 (Phase 3) — Home is the greeting surface. On launch we
  // keep the folder tab (setHome) but open + FOCUS the Home singleton beside it
  // (Q1 = beside + focused), so the tasks-first Home is what greets the user
  // while the file manager is one tab-click / :files away. Reversible: delete
  // this effect to fall back to the file-manager-as-landing behavior.
  //
  // Sequenced AFTER hydration so we read the persisted taskManagementEnabled
  // flag (Home is the task surface; if task management is off we leave the
  // folder tab as the landing). One-shot via the ref guard — later manual tab
  // changes are never overridden. openProjectsTab is a focus-or-spawn singleton,
  // so this is idempotent even if it somehow runs twice.
  const homeLandingDoneRef = useRef(false);
  useEffect(() => {
    if (!hydrated) return;
    if (homeLandingDoneRef.current) return;
    // Wait for setHome to have created the initial folder tab.
    if (state.tabs.length === 0) return;
    homeLandingDoneRef.current = true;
    if (!state.taskManagementEnabled) return;
    // Append + focus the Home singleton (kind='projects'); the folder tab stays
    // open at index 0, Home becomes the active tab.
    dispatch({ type: 'openProjectsTab' });
  }, [hydrated, state.tabs.length, state.taskManagementEnabled, dispatch]);

  // fm-h8g7 — mirror the task-notification verbosity to the main process so
  // the OS-notification gate (which runs in main) tracks the renderer's value.
  // Push on boot (after hydration) and on every change. Fire-and-forget; main
  // defaults to 'all' until the first push lands.
  useEffect(() => {
    if (!hydrated) return;
    fm.setTaskNotifications?.(state.taskNotifications);
  }, [state.taskNotifications, hydrated]);

  // fm-5xy — mirror the start-at / near-due reminder mode to main (the daily
  // 8am tick + startup catch-up run in main). Push on boot (after hydration)
  // and on every change. Fire-and-forget; main defaults to 'start' until the
  // first push lands.
  useEffect(() => {
    if (!hydrated) return;
    fm.setTaskReminders?.(state.taskReminders);
  }, [state.taskReminders, hydrated]);

  const activeTab = state.tabs[state.activeTab];

  async function loadDir(p: string): Promise<Entry[]> {
    try {
      const entries = await fm.readdir(p);
      dispatch({ type: 'setEntries', path: p, entries });
      return entries;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (isPermissionError(msg)) {
        dispatch({
          type: 'setStatus',
          msg: `macOS is blocking access to ${p}. Grant folder access and try again.`,
        });
        // Surface the dialog once per path per session — otherwise revisiting
        // a protected folder would re-open the modal every navigation.
        if (!shownPrivacyFor.has(p)) {
          shownPrivacyFor.add(p);
          window.dispatchEvent(new CustomEvent('fm:openPrivacyHelp'));
        }
      } else if (/^ENOENT\b/.test(msg)) {
        dispatch({ type: 'setStatus', msg: `folder deleted: ${p}` });
      } else {
        dispatch({ type: 'setStatus', msg: `error reading ${p}: ${msg}` });
      }
      dispatch({ type: 'setEntries', path: p, entries: [] });
      return [];
    }
  }

  // fm-mp1 — (re-)evaluate a filter-tab: recursively walk its scope, filter the
  // entries by its bound selector (resolving tag:name atoms via the DSL-tag
  // store), and cache the matches under the tab's synthetic key. Re-runs each
  // time the tab is opened so the smart folder reflects the live filesystem.
  async function loadFilterTab(tab: Tab): Promise<Entry[]> {
    const key = filterTabKey(tab.id);
    const selector = tab.boundSelector ?? '';
    const scope = tab.scopePath || (await fm.homedir());
    try {
      const entries = await fm.walkScope(scope);
      const tags = await fm.dslTags.list().catch(() => []);
      const matched = filterEntries(entries, selector, { tags }) as Entry[];
      dispatch({ type: 'setEntries', path: key, entries: matched });
      return matched;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      dispatch({ type: 'setStatus', msg: `filter “${selector}”: ${msg}` });
      dispatch({ type: 'setEntries', path: key, entries: [] });
      return [];
    }
  }

  async function refreshActive() {
    const tab = stateRef.current.tabs[stateRef.current.activeTab];
    if (!tab) return;
    if (tab.boundSelector) {
      await loadFilterTab(tab);
      return;
    }
    await Promise.all(tab.trail.map((p) => loadDir(p)));
  }

  function setTab(patch: Partial<Tab>) {
    dispatch({ type: 'updateTab', index: stateRef.current.activeTab, patch });
  }

  function setTabSticky(patch: FolderPrefs) {
    const tab = stateRef.current.tabs[stateRef.current.activeTab];
    if (!tab) return;
    dispatch({
      type: 'updateTab',
      index: stateRef.current.activeTab,
      patch: patch as Partial<Tab>,
    });
    // Only folder tabs have a meaningful leaf cwd. Task / tasks-overview
    // tabs are not browse surfaces, so don't persist a pref for them.
    if (tab.kind !== 'folder') return;
    const cwd = tab.trail[tab.trail.length - 1];
    if (cwd) dispatch({ type: 'setFolderPref', path: cwd, patch });
  }

  // Move the cursor to the entry matching `name` in the current cwd.
  // Used after mkdir/touch so the new thing is immediately actionable —
  // Enter opens the new folder, etc.
  //
  // Race note: when this is called right after `await refreshActive()`,
  // React may not have re-rendered yet, so stateRef can still hold the
  // pre-create entries. We retry across a couple of animation frames
  // before giving up.
  function focusEntryByName(name: string, retriesLeft = 5) {
    const tab = stateRef.current.tabs[stateRef.current.activeTab];
    if (!tab) return;
    const col = tab.trail.length - 1;
    const cwd = tab.trail[col];
    const entries = visibleEntries(stateRef.current.entriesByPath[cwd] ?? [], tab);
    const idx = entries.findIndex((e) => e.name === name);
    if (idx < 0) {
      if (retriesLeft > 0) {
        requestAnimationFrame(() => focusEntryByName(name, retriesLeft - 1));
      }
      return;
    }
    dispatch({
      type: 'updateTab',
      index: stateRef.current.activeTab,
      patch: { selected: { ...tab.selected, [col]: idx } },
    });
  }

  function navigateTo(p: string) {
    const tab = stateRef.current.tabs[stateRef.current.activeTab];
    if (!tab) return;
    // fm-dj5 — task and tasks-overview tabs aren't browse surfaces; their
    // trail is bound (to a task's folder) or unused. Mutating it via
    // sidebar clicks broke the task tab's identity. Route those clicks
    // to a folder tab instead so the task tab stays put.
    if (tab.kind !== 'folder') {
      dispatch({ type: 'openOrFocusFolderTab', path: p });
      dispatch({ type: 'pushRecent', path: p });
      return;
    }
    const history = [...tab.history, tab.trail];
    dispatch({
      type: 'updateTab',
      index: stateRef.current.activeTab,
      // marks are scoped to the cwd (fm-pcs) — wipe on any cwd change so
      // a later 'delete' doesn't pull in files the user can no longer see.
      // fm-mp1 — navigating into a real directory exits smart-folder mode:
      // clear the bound selector so the tab becomes an ordinary folder browse.
      patch: {
        trail: [p],
        selected: { 0: 0 },
        history,
        forward: [],
        marks: {},
        boundSelector: undefined,
        scopePath: undefined,
      },
    });
    dispatch({ type: 'pushRecent', path: p });
  }

  function goBack() {
    const tab = stateRef.current.tabs[stateRef.current.activeTab];
    if (!tab || tab.history.length === 0) return;
    const prev = tab.history[tab.history.length - 1];
    const history = tab.history.slice(0, -1);
    const forward = [tab.trail, ...tab.forward];
    dispatch({
      type: 'updateTab',
      index: stateRef.current.activeTab,
      patch: { trail: prev, selected: { 0: 0 }, history, forward, marks: {} },
    });
  }

  function goForward() {
    const tab = stateRef.current.tabs[stateRef.current.activeTab];
    if (!tab || tab.forward.length === 0) return;
    const [next, ...rest] = tab.forward;
    const history = [...tab.history, tab.trail];
    dispatch({
      type: 'updateTab',
      index: stateRef.current.activeTab,
      patch: { trail: next, selected: { 0: 0 }, history, forward: rest, marks: {} },
    });
  }

  async function openPath(p: string) {
    const st = await fm.stat(p);
    if (st.isDir) {
      const tab = stateRef.current.tabs[stateRef.current.activeTab];
      if (!tab) return;
      const trail = [...tab.trail, p];
      const history = [...tab.history, tab.trail];
      dispatch({
        type: 'updateTab',
        index: stateRef.current.activeTab,
        patch: {
          trail,
          selected: { ...tab.selected, [trail.length - 1]: 0 },
          marks: {},
          history,
          forward: [],
        },
      });
      dispatch({ type: 'pushRecent', path: p });
      await loadDir(p);
    } else if (isEditablePath(p)) {
      // Settings-driven editable types (md/mdx/txt/json/…) open in Breeze's
      // in-app editor on double-click; everything else routes to the OS
      // default app below (fm-o5z8).
      dispatch({ type: 'openEditTab', path: p, focus: true });
      dispatch({ type: 'pushRecentFile', path: p });
    } else {
      dispatch({ type: 'pushRecentFile', path: p });
      await fm.open(p);
    }
  }

  // fm-k9dg — when the active tab's leaf cwd changes, hydrate the tab
  // from the saved per-folder pref (if any). Folders the user never
  // customized leave the tab's current settings alone, so per-tab
  // overrides still feel sticky as you walk through new directories.
  useEffect(() => {
    if (!activeTab) return;
    if (activeTab.kind !== 'folder') return;
    const leaf = activeTab.trail[activeTab.trail.length - 1];
    if (!leaf) return;
    // Auto-attach: if this folder lives under an active sshfs mount, connect
    // its host as a task source so its tasks appear and creates route to it —
    // no manual :remote-attach needed. Idempotent + guarded in the main
    // process (once per host/session), and a no-op on platforms / paths
    // without a remote mount. Fire-and-forget; never blocks navigation.
    void fm.sourcesAutoAttach(leaf).catch(() => {});
    const pref = state.folderPrefs[leaf];
    if (!pref) return;
    const patch: Partial<Tab> = {};
    if (pref.sortKey !== undefined && pref.sortKey !== activeTab.sortKey) patch.sortKey = pref.sortKey;
    if (pref.sortReverse !== undefined && pref.sortReverse !== activeTab.sortReverse) patch.sortReverse = pref.sortReverse;
    if (pref.showHidden !== undefined && pref.showHidden !== activeTab.showHidden) patch.showHidden = pref.showHidden;
    if (pref.viewMode !== undefined && pref.viewMode !== activeTab.viewMode) patch.viewMode = pref.viewMode;
    if (pref.foldersFirst !== undefined && pref.foldersFirst !== activeTab.foldersFirst) patch.foldersFirst = pref.foldersFirst;
    if (Object.keys(patch).length > 0) {
      dispatch({ type: 'updateTab', index: stateRef.current.activeTab, patch });
    }
    // Deps: re-run on tab switch and on leaf change. Don't depend on
    // folderPrefs — writing a pref shouldn't re-fire and risk thrash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, activeTab?.trail.join('|')]);

  // Eagerly load trail entries for active tab.
  // Parent columns may use the cache (cheap, rarely changes between
  // hops). The leaf (the folder the user is actually looking at) is
  // always re-read so external writes — Claude auto-runs, downloads,
  // other processes — show up on a back-and-forth navigation. A real
  // folder watcher will obsolete this when it lands.
  useEffect(() => {
    if (!activeTab) return;
    // fm-vu55 — edit/tasks/task tabs don't browse the trail; skip the
    // eager dir-load that would refetch a parent folder we don't show.
    if (activeTab.kind === 'edit' || activeTab.kind === 'tasks') return;
    // fm-mp1 — a filter-tab re-evaluates its selector across its scope instead
    // of listing directories; its trail leaf is the synthetic cache key.
    if (activeTab.boundSelector) {
      void loadFilterTab(activeTab);
      return;
    }
    const trail = activeTab.trail;
    const leaf = trail[trail.length - 1];
    for (let i = 0; i < trail.length; i++) {
      const p = trail[i];
      const isLeaf = i === trail.length - 1;
      if (isLeaf || !state.entriesByPath[p]) loadDir(p);
    }
    // Reference leaf so the linter sees we read it.
    void leaf;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, activeTab?.trail.join('|'), activeTab?.boundSelector, activeTab?.scopePath]);

  const value = useMemo<Ctx>(
    () => ({
      state,
      dispatch,
      activeTab,
      loadDir,
      refreshActive,
      setTab,
      setTabSticky,
      openPath,
      navigateTo,
      goBack,
      goForward,
      focusEntryByName,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, activeTab],
  );

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error('useStore outside provider');
  return ctx;
}

export { DEFAULT_KEYBINDS };
