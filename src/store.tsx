import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type {
  Bookmarks,
  CustomTag,
  Entry,
  Keybinds,
  Tab,
  TagPaths,
  Tags,
  YankEntry,
} from './types';
import { fm } from './bridge';
import { visibleEntries } from './actions';

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

// Only durable preferences persist — tabs always start fresh at $HOME so a
// stale trail never greets you on launch.
type Persisted = {
  bookmarks: Bookmarks;
  tags: Tags;
  keybinds: Keybinds;
  theme: 'dark' | 'light';
  recents: string[]; // LRU of recently-visited folders, most recent first
  pinned: string[]; // user-pinned folder paths shown in sidebar Favorites
  // fm-60k — user-authored tags (manual-only v1) and the path lists they
  // were applied to. tagPaths is keyed by tag id; covers both custom and
  // seeded tags (a built-in like 'recent' can also receive manual pins).
  customTags: CustomTag[];
  tagPaths: TagPaths;
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
};

type Action =
  | { type: 'hydrate'; state: Partial<Persisted> }
  | { type: 'setHome'; home: string }
  | { type: 'setEntries'; path: string; entries: Entry[] }
  | { type: 'updateTab'; index: number; patch: Partial<Tab> }
  | { type: 'replaceTab'; index: number; tab: Tab }
  | { type: 'newTab'; tab: Tab }
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
  | { type: 'setTheme'; theme: 'dark' | 'light' }
  | { type: 'setLastFind'; query: string }
  | { type: 'restoreTab' }
  | { type: 'pushRecent'; path: string }
  | { type: 'pinFolder'; path: string }
  | { type: 'unpinFolder'; path: string }
  | { type: 'createCustomTag'; tag: CustomTag }
  | { type: 'deleteCustomTag'; id: string }
  | { type: 'applyTag'; id: string; paths: string[] }
  | { type: 'untagPaths'; id: string; paths: string[] }
  | { type: 'addTagViz'; id: string };

function makeTab(path: string): Tab {
  return {
    id: crypto.randomUUID(),
    trail: [path],
    selected: { 0: 0 },
    marks: {},
    sortKey: 'name',
    sortReverse: false,
    showHidden: false,
    viewMode: 'list',
    filter: '',
    tagViz: [],
    tagFilter: { mode: 'off', ids: [] },
    history: [],
    forward: [],
  };
}

const initialState: State = {
  tabs: [],
  activeTab: 0,
  bookmarks: {},
  tags: {},
  keybinds: DEFAULT_KEYBINDS,
  theme: 'dark',
  recents: [],
  pinned: [],
  customTags: [],
  tagPaths: {},
  entriesByPath: {},
  yank: [],
  statusMsg: '',
  mode: 'normal',
  modeBuffer: '',
  modeVerb: '',
  pending: '',
  lastFind: '',
  lastClosedTab: null,
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
    case 'setTheme':
      return { ...s, theme: a.theme };
    case 'setLastFind':
      return { ...s, lastFind: a.query };
    case 'pushRecent': {
      const clean = (s.recents ?? []).filter((p) => p !== a.path);
      clean.unshift(a.path);
      if (clean.length > RECENTS_CAP) clean.length = RECENTS_CAP;
      return { ...s, recents: clean };
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
    case 'addTagViz': {
      const tabs = s.tabs.slice();
      const t = tabs[s.activeTab];
      if (!t || t.tagViz.includes(a.id)) return s;
      tabs[s.activeTab] = { ...t, tagViz: [...t.tagViz, a.id] };
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
        const { bookmarks, tags, keybinds, theme, recents, pinned, customTags, tagPaths } =
          parsed as Partial<Persisted>;
        dispatch({
          type: 'hydrate',
          state: {
            ...(bookmarks ? { bookmarks } : {}),
            ...(tags ? { tags } : {}),
            ...(keybinds ? { keybinds } : {}),
            ...(theme ? { theme } : {}),
            ...(recents ? { recents } : {}),
            ...(pinned ? { pinned } : {}),
            ...(customTags ? { customTags } : {}),
            ...(tagPaths ? { tagPaths } : {}),
          } as Partial<Persisted>,
        });
      } catch {
        /* ignore */
      }
    }
    fm.homedir().then((home) => {
      dispatch({ type: 'setHome', home });
    });
  }, []);

  // Persist — only durable prefs, never tab trails.
  useEffect(() => {
    const toPersist: Persisted = {
      bookmarks: state.bookmarks,
      tags: state.tags,
      keybinds: state.keybinds,
      theme: state.theme,
      recents: state.recents,
      pinned: state.pinned,
      customTags: state.customTags,
      tagPaths: state.tagPaths,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toPersist));
  }, [
    state.bookmarks,
    state.tags,
    state.keybinds,
    state.theme,
    state.recents,
    state.pinned,
    state.customTags,
    state.tagPaths,
  ]);

  // Apply theme on html root
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', state.theme);
  }, [state.theme]);

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
      } else {
        dispatch({ type: 'setStatus', msg: `error reading ${p}: ${msg}` });
      }
      dispatch({ type: 'setEntries', path: p, entries: [] });
      return [];
    }
  }

  async function refreshActive() {
    const tab = stateRef.current.tabs[stateRef.current.activeTab];
    if (!tab) return;
    await Promise.all(tab.trail.map((p) => loadDir(p)));
  }

  function setTab(patch: Partial<Tab>) {
    dispatch({ type: 'updateTab', index: stateRef.current.activeTab, patch });
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
    const history = [...tab.history, tab.trail];
    dispatch({
      type: 'updateTab',
      index: stateRef.current.activeTab,
      // marks are scoped to the cwd (fm-pcs) — wipe on any cwd change so
      // a later 'delete' doesn't pull in files the user can no longer see.
      patch: { trail: [p], selected: { 0: 0 }, history, forward: [], marks: {} },
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
    } else {
      await fm.open(p);
    }
  }

  // Eagerly load trail entries for active tab
  useEffect(() => {
    if (!activeTab) return;
    for (const p of activeTab.trail) {
      if (!state.entriesByPath[p]) loadDir(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, activeTab?.trail.join('|')]);

  const value = useMemo<Ctx>(
    () => ({
      state,
      dispatch,
      activeTab,
      loadDir,
      refreshActive,
      setTab,
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
