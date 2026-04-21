import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { fm } from '../bridge';
import {
  basename,
  currentEntry,
  dirname,
  lastCol,
  pathJoin,
  visibleEntries,
} from '../actions';
import type { Entry, SortKey } from '../types';
import './ChipPrompt.css';

// ────────────────────────────────────────────────────────────────────────────
// Context gathered once per overlay render — drives verb availability and
// the object/destination options.
// ────────────────────────────────────────────────────────────────────────────
type Ctx = {
  cwd: string;
  entries: Entry[];
  cursor: Entry | undefined;
  markedPaths: string[];
  yankCount: number;
  bookmarks: Record<string, string>;
  homedir: string;
  recents: string[];
  searchResults: string[]; // async Spotlight hits for current query
};

type Verb =
  | 'move'
  | 'copy'
  | 'paste'
  | 'sort'
  | 'delete'
  | 'rename'
  | 'open'
  | 'goto'
  | 'view'
  | 'create'
  | 'reveal'
  | 'showHidden';

type Option = {
  id: string;
  label: string;
  detail?: string;
  available: boolean;
  reason?: string; // shown on hover when unavailable
};

type VerbDef = {
  id: Verb;
  label: string;
  aliases: string[]; // typed filter matches
  icon: string;
  describe: (ctx: Ctx) => string; // preview sentence
  isAvailable: (ctx: Ctx) => { ok: boolean; reason?: string };
  // slots after the verb; empty = execute immediately
  slots: SlotDef[];
  execute: (ctx: Ctx, picks: string[], api: ExecApi) => Promise<void> | void;
};

type SlotDef = {
  label: string; // "What", "Where", "How", "By", "Direction"
  getOptions: (ctx: Ctx, prev: string[]) => Option[];
};

type ExecApi = {
  setTab: (patch: any) => void;
  refreshActive: () => Promise<void>;
  navigateTo: (p: string) => void;
  dispatch: (a: any) => void;
  openRename: (e: Entry) => void;
  openMkdir: () => void;
  closeOverlay: () => void;
};

// ────────────────────────────────────────────────────────────────────────────
// Verb catalog. Order matters — it's the default suggestion order.
// ────────────────────────────────────────────────────────────────────────────
const VERBS: VerbDef[] = [
  {
    id: 'move',
    label: 'Move',
    aliases: ['move', 'mv', 'cut'],
    icon: '→',
    describe: (c) =>
      c.markedPaths.length > 0
        ? `Move ${c.markedPaths.length} file(s) to…`
        : `Move ${c.cursor?.name ?? 'item'} to…`,
    isAvailable: (c) => {
      if (c.markedPaths.length === 0 && !c.cursor) {
        return { ok: false, reason: 'Select files first (press space) or put the cursor on one' };
      }
      return { ok: true };
    },
    slots: [{ label: 'Where', getOptions: (c) => destinationOptions(c) }],
    execute: async (c, [dest], api) => {
      const sources = implicitSources(c);
      const dst = resolveDestination(c, dest);
      if (!dst || sources.length === 0) return;
      await fm.paste(sources.map((src) => ({ src, dst, mode: 'move' as const })));
      api.setTab({ marks: {} });
      await api.refreshActive();
      api.dispatch({ type: 'setStatus', msg: `moved ${sources.length} → ${basename(dst)}` });
    },
  },
  {
    id: 'copy',
    label: 'Copy',
    aliases: ['copy', 'cp', 'duplicate'],
    icon: '⧉',
    describe: (c) =>
      c.markedPaths.length > 0
        ? `Copy ${c.markedPaths.length} file(s) to…`
        : `Copy ${c.cursor?.name ?? 'item'} to…`,
    isAvailable: (c) => {
      if (c.markedPaths.length === 0 && !c.cursor) {
        return { ok: false, reason: 'Select files first (space) or put the cursor on one' };
      }
      return { ok: true };
    },
    slots: [{ label: 'Where', getOptions: (c) => destinationOptions(c) }],
    execute: async (c, [dest], api) => {
      const sources = implicitSources(c);
      const dst = resolveDestination(c, dest);
      if (!dst || sources.length === 0) return;
      await fm.paste(sources.map((src) => ({ src, dst, mode: 'copy' as const })));
      await api.refreshActive();
      api.dispatch({ type: 'setStatus', msg: `copied ${sources.length} → ${basename(dst)}` });
    },
  },
  {
    id: 'paste',
    label: 'Paste',
    aliases: ['paste', 'put'],
    icon: '↓',
    describe: (c) => `Paste ${c.yankCount} item(s) here`,
    isAvailable: (c) => {
      if (c.yankCount === 0) {
        return { ok: false, reason: 'Clipboard is empty — copy or cut some files first' };
      }
      return { ok: true };
    },
    slots: [],
    execute: async (_c, _picks, api) => {
      api.dispatch({ type: 'setStatus', msg: 'pasting…' });
      // Delegate to existing paste helper by dispatching a status and letting
      // user invoke pp chord — actually wire directly:
      // We can't access yank in this closure cleanly; just invoke via keyboard equiv.
      // Simpler: fire a custom event the store listens for, or just ask user.
      // For now: call fm.paste with current state.
      await api.refreshActive();
    },
  },
  {
    id: 'sort',
    label: 'Sort',
    aliases: ['sort', 'order', 'arrange'],
    icon: '↕',
    describe: () => 'Sort this folder by…',
    isAvailable: () => ({ ok: true }),
    slots: [
      {
        label: 'By',
        getOptions: () => [
          { id: 'name|asc', label: 'Name (A → Z)', available: true },
          { id: 'name|desc', label: 'Name (Z → A)', available: true },
          { id: 'mtime|desc', label: 'Newest first', detail: 'date modified', available: true },
          { id: 'mtime|asc', label: 'Oldest first', detail: 'date modified', available: true },
          { id: 'size|desc', label: 'Biggest first', detail: 'file size', available: true },
          { id: 'size|asc', label: 'Smallest first', available: true },
          { id: 'ctime|desc', label: 'Recently created', available: true },
          { id: 'type|asc', label: 'Folders first', detail: 'group by type', available: true },
          { id: 'ext|asc', label: 'By extension', detail: '.pdf, .jpg…', available: true },
        ],
      },
    ],
    execute: (_c, [combined], api) => {
      const [key, dir] = combined.split('|');
      api.setTab({ sortKey: key as SortKey, sortReverse: dir === 'desc' });
      api.dispatch({ type: 'setStatus', msg: `sorted: ${key} ${dir === 'desc' ? '↓' : '↑'}` });
    },
  },
  {
    id: 'delete',
    label: 'Delete',
    aliases: ['delete', 'trash', 'rm', 'remove'],
    icon: '🗑',
    describe: (c) =>
      c.markedPaths.length > 0
        ? `Move ${c.markedPaths.length} file(s) to trash`
        : `Move ${c.cursor?.name ?? 'item'} to trash`,
    isAvailable: (c) => {
      if (c.markedPaths.length === 0 && !c.cursor) {
        return { ok: false, reason: 'Select files first or put cursor on one' };
      }
      return { ok: true };
    },
    slots: [],
    execute: async (c, _picks, api) => {
      const sources = implicitSources(c);
      if (sources.length === 0) return;
      await fm.trash(sources);
      api.setTab({ marks: {} });
      await api.refreshActive();
      api.dispatch({ type: 'setStatus', msg: `trashed ${sources.length} item(s)` });
    },
  },
  {
    id: 'rename',
    label: 'Rename',
    aliases: ['rename', 'rn'],
    icon: '✎',
    describe: (c) => `Rename ${c.cursor?.name ?? 'item'}`,
    isAvailable: (c) => {
      if (!c.cursor) return { ok: false, reason: 'Put the cursor on a file first' };
      return { ok: true };
    },
    slots: [],
    execute: (c, _p, api) => {
      if (c.cursor) api.openRename(c.cursor);
    },
  },
  {
    id: 'goto',
    label: 'Go to',
    aliases: ['go', 'goto', 'cd', 'navigate', 'open folder'],
    icon: '→',
    describe: () => 'Go to a folder',
    isAvailable: () => ({ ok: true }),
    slots: [{ label: 'Where', getOptions: (c) => destinationOptions(c, true) }],
    execute: (c, [dest], api) => {
      const target = resolveDestination(c, dest);
      if (target) api.navigateTo(target);
    },
  },
  {
    id: 'open',
    label: 'Open',
    aliases: ['open', 'launch'],
    icon: '↗',
    describe: (c) => `Open ${c.cursor?.name ?? 'item'}`,
    isAvailable: (c) => {
      if (!c.cursor) return { ok: false, reason: 'Put the cursor on a file first' };
      return { ok: true };
    },
    slots: [],
    execute: (c, _p, api) => {
      if (c.cursor) {
        void fm.open(c.cursor.path);
        api.closeOverlay();
      }
    },
  },
  {
    id: 'reveal',
    label: 'Reveal in Finder',
    aliases: ['reveal', 'finder', 'show in finder'],
    icon: '⎋',
    describe: (c) => `Show ${c.cursor?.name ?? 'current folder'} in Finder`,
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (c, _p, api) => {
      const target = c.cursor?.path ?? c.cwd;
      void fm.reveal(target);
      api.dispatch({ type: 'setStatus', msg: `revealed ${basename(target)}` });
    },
  },
  {
    id: 'view',
    label: 'View as',
    aliases: ['view', 'display', 'layout'],
    icon: '▦',
    describe: () => 'Change view mode',
    isAvailable: () => ({ ok: true }),
    slots: [
      {
        label: 'Mode',
        getOptions: () => [
          { id: 'list', label: 'List', detail: 'compact rows', available: true },
          { id: 'grid', label: 'Grid', detail: 'thumbnails', available: true },
        ],
      },
    ],
    execute: (_c, [mode], api) => {
      api.setTab({ viewMode: mode as 'list' | 'grid' });
      api.dispatch({ type: 'setStatus', msg: `view: ${mode}` });
    },
  },
  {
    id: 'create',
    label: 'Create',
    aliases: ['create', 'new', 'mkdir', 'touch'],
    icon: '+',
    describe: () => 'Create new…',
    isAvailable: () => ({ ok: true }),
    slots: [
      {
        label: 'Type',
        getOptions: () => [
          { id: 'folder', label: 'Folder', detail: 'new directory', available: true },
          { id: 'file', label: 'File', detail: 'empty file', available: true },
        ],
      },
    ],
    execute: (_c, [kind], api) => {
      if (kind === 'folder') api.openMkdir();
      // 'file' intentionally no-op — wire to a touch overlay if/when it exists
    },
  },
  {
    id: 'showHidden',
    label: 'Show hidden files',
    aliases: ['hidden', 'dotfiles', 'show hidden'],
    icon: '◐',
    describe: () => 'Toggle hidden files',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (_c, _p, api) => {
      // toggle via state read — setTab patch uses functional update pattern via dispatch
      // Since setTab only takes a plain patch, we need the current value; pass it through.
      api.dispatch({ type: 'setStatus', msg: 'toggled hidden files' });
      // Actual toggle is handled at call-site by inspecting current tab in execute wrapper.
    },
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Option resolvers shared across verbs
// ────────────────────────────────────────────────────────────────────────────

// For verbs that used to have a "What" slot (Move/Copy/Delete): the target
// is implicit — marked files if any are marked, otherwise the cursor item.
function implicitSources(c: Ctx): string[] {
  if (c.markedPaths.length > 0) return c.markedPaths;
  if (c.cursor) return [c.cursor.path];
  return [];
}

function destinationOptions(c: Ctx, includeCurrent = false): Option[] {
  const opts: Option[] = [];
  const seen = new Set<string>();
  const push = (o: Option) => {
    if (seen.has(o.id)) return;
    seen.add(o.id);
    opts.push(o);
  };

  // 1) Recents — highest priority, shown first when filter is empty.
  for (const p of c.recents.slice(0, 8)) {
    push({
      id: p,
      label: basename(p) || p,
      detail: prettyPath(p, c.homedir) + '  ·  recent',
      available: true,
    });
  }

  // 2) Home-relative common folders
  const commonSubdirs = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Projects'];
  for (const d of commonSubdirs) {
    push({
      id: `~/${d}`,
      label: d,
      detail: `~/${d}`,
      available: true,
    });
  }
  push({ id: '~', label: 'Home', detail: c.homedir, available: true });
  if (includeCurrent) {
    push({ id: c.cwd, label: `current folder`, detail: prettyPath(c.cwd, c.homedir), available: true });
  }

  // 3) Bookmarks
  for (const [key, path] of Object.entries(c.bookmarks)) {
    push({
      id: path,
      label: `'${key}  ${basename(path) || path}`,
      detail: prettyPath(path, c.homedir),
      available: true,
    });
  }

  // 4) Immediate subdirectories (for "move into X")
  const subdirs = c.entries.filter((e) => e.kind === 'dir').slice(0, 6);
  for (const d of subdirs) {
    push({
      id: d.path,
      label: `into ${d.name}/`,
      detail: 'subfolder here',
      available: true,
    });
  }

  // 5) Async Spotlight search results — appended last; the match scorer
  //    will pull relevant ones up when the user is filtering.
  for (const p of c.searchResults) {
    push({
      id: p,
      label: basename(p) || p,
      detail: prettyPath(p, c.homedir) + '  ·  spotlight',
      available: true,
    });
  }
  return opts;
}

function prettyPath(p: string, home: string): string {
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

function resolveDestination(c: Ctx, destId: string): string | null {
  if (destId === '~') return c.homedir;
  if (destId.startsWith('~/')) return c.homedir + destId.slice(1);
  return destId;
}

// ────────────────────────────────────────────────────────────────────────────
// The overlay component
// ────────────────────────────────────────────────────────────────────────────
export function ChipPrompt({ onClose, initialFilter = '' }: { onClose: () => void; initialFilter?: string }) {
  const { state, dispatch, activeTab, setTab, refreshActive, navigateTo } = useStore();
  const [verb, setVerb] = useState<VerbDef | null>(null);
  const [picks, setPicks] = useState<string[]>([]); // slot values
  const [filter, setFilter] = useState(initialFilter);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [homedir, setHomedir] = useState('');
  const [hoverReason, setHoverReason] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<string[]>([]);
  const searchTokenRef = useRef(0); // guards against out-of-order resolves
  const inputRef = useRef<HTMLInputElement>(null);
  const [openRename, setOpenRename] = useState<Entry | null>(null);

  useEffect(() => {
    void fm.homedir().then(setHomedir);
  }, []);

  // Fire Spotlight folder search when a destination slot is active and the
  // user has typed a query. Debounced (150ms); in-flight results are
  // discarded if a newer query has started. Important: only call setState
  // when the value actually changes, otherwise we loop (new [] reference
  // every render triggers the effect, which sets [] again, etc.).
  useEffect(() => {
    const slotIdx = verb ? picks.length : -1;
    const activeSlot = verb && slotIdx < verb.slots.length ? verb.slots[slotIdx] : null;
    const isDestinationSlot =
      activeSlot?.label === 'Where' || activeSlot?.label === 'Destination';
    if (!isDestinationSlot || filter.trim().length < 2) {
      setSearchResults((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const token = ++searchTokenRef.current;
    const query = filter.trim();
    const timer = window.setTimeout(() => {
      void fm.findFolders(query, 30).then((hits) => {
        if (searchTokenRef.current !== token) return;
        setSearchResults(hits);
      }).catch(() => {
        if (searchTokenRef.current !== token) return;
        setSearchResults((prev) => (prev.length === 0 ? prev : []));
      });
    }, 150);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, verb, picks.length]);

  // Sync with initialFilter whenever the overlay is (re)opened with a new
  // pre-filled query. StrictMode's double-mount and any React timing weirdness
  // can otherwise leave the filter state at '' even though we passed 'g'.
  useEffect(() => {
    if (initialFilter) {
      setFilter(initialFilter);
      setHighlightIdx(0);
      // Move cursor to end of input so continued typing appends.
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(initialFilter.length, initialFilter.length);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFilter]);

  const ctx = useMemo<Ctx | null>(() => {
    if (!activeTab) return null;
    const cwd = activeTab.trail[lastCol(activeTab)];
    const entries = visibleEntries(state.entriesByPath[cwd], activeTab);
    const cursor = currentEntry(activeTab, entries);
    const markedPaths = Object.keys(activeTab.marks);
    return {
      cwd,
      entries,
      cursor,
      markedPaths,
      yankCount: state.yank.length,
      bookmarks: state.bookmarks,
      homedir,
      recents: state.recents ?? [],
      searchResults,
    };
  }, [activeTab, state.entriesByPath, state.yank, state.bookmarks, state.recents, homedir, searchResults]);

  if (!activeTab || !ctx) return null;

  // Which slot is active: 0..slots.length = verb, slot1, slot2… ; length+1 = done
  const slotIdx = verb ? picks.length : -1;
  const activeSlot = verb && slotIdx < verb.slots.length ? verb.slots[slotIdx] : null;

  // Build options for current state
  const allOptions: Option[] =
    verb === null
      ? VERBS.map((v) => {
          const { ok, reason } = v.isAvailable(ctx);
          return {
            id: v.id,
            label: v.label,
            detail: v.describe(ctx),
            available: ok,
            reason,
          };
        })
      : activeSlot
        ? activeSlot.getOptions(ctx, picks)
        : [];

  // Filter + rank. For single-token queries we prefer label-starts-with
  // matches; for multi-token queries ("webinar folder") ALL tokens must
  // appear somewhere in the label or detail (substring, any order). A
  // folder like "Webinar data shared folder" then matches even though
  // "webinar folder" isn't contiguous.
  const matches = useMemo(() => {
    if (!filter) return allOptions;
    const tokens = filter.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return allOptions;

    const scored = allOptions
      .map((o) => {
        const label = o.label.toLowerCase();
        const detail = (o.detail ?? '').toLowerCase();
        const aliases = verb === null
          ? (VERBS.find((v) => v.id === o.id)?.aliases ?? []).map((a) => a.toLowerCase())
          : [];
        const haystack = label + ' ' + detail;

        // Multi-token: require every token to appear in label or detail.
        const everyTokenHits = tokens.every((t) => haystack.includes(t));
        if (!everyTokenHits) return { opt: o, score: -1 };

        // Score: the better the FIRST token lands in the label, the higher
        // the rank. This preserves the single-letter behavior from before
        // while being fair to multi-token queries.
        const first = tokens[0];
        let score = 0;
        if (label.startsWith(first)) score += 100;
        else if (aliases.some((a) => a.startsWith(first))) score += 80;
        else if (label.split(/[\s_\-./]+/).some((w) => w.startsWith(first))) score += 60;
        else if (label.includes(first)) score += 40;
        else if (aliases.some((a) => a.includes(first))) score += 30;
        else score += 10; // token only in detail

        // Bonus: each extra token that hits the LABEL (not just detail)
        // adds to the score — a folder where more words are in the name
        // itself ranks higher than one where the match depends on path.
        for (let i = 1; i < tokens.length; i++) {
          if (label.includes(tokens[i])) score += 5;
        }

        // Small penalty for very long labels (so "Webinar data shared
        // folder" doesn't beat "Webinars" on a "webinar" query).
        score -= Math.min(10, Math.floor(label.length / 20));

        return { opt: o, score };
      })
      .filter((s) => s.score >= 0);

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.opt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, allOptions, verb]);

  // Keep highlightIdx in range
  useEffect(() => {
    if (highlightIdx >= matches.length) setHighlightIdx(0);
  }, [matches.length, highlightIdx]);

  function pickOption(opt: Option) {
    if (!opt.available) {
      setHoverReason(opt.reason ?? 'Not available right now');
      return;
    }
    if (verb === null) {
      const v = VERBS.find((x) => x.id === opt.id);
      if (!v) return;
      setVerb(v);
      setPicks([]);
      setFilter('');
      setHighlightIdx(0);
      // If verb has zero slots — execute immediately
      if (v.slots.length === 0) {
        void executeWith(v, []);
      }
    } else {
      const nextPicks = [...picks, opt.id];
      if (nextPicks.length >= verb.slots.length) {
        void executeWith(verb, nextPicks);
      } else {
        setPicks(nextPicks);
        setFilter('');
        setHighlightIdx(0);
      }
    }
  }

  async function executeWith(v: VerbDef, ps: string[]) {
    if (!ctx || !activeTab) return;
    const safeCtx = ctx;
    const safeTab = activeTab;
    try {
      // Special-case paste: need live yank from store
      if (v.id === 'paste') {
        const dst = safeCtx.cwd;
        if (state.yank.length === 0) {
          dispatch({ type: 'setStatus', msg: 'nothing to paste' });
          onClose();
          return;
        }
        await fm.paste(state.yank.map((y) => ({ src: y.path, dst, mode: y.mode })));
        if (state.yank[0].mode === 'move') dispatch({ type: 'setYank', yank: [] });
        await refreshActive();
        dispatch({ type: 'setStatus', msg: `pasted ${state.yank.length} item(s)` });
        onClose();
        return;
      }
      // Special-case showHidden (needs current value)
      if (v.id === 'showHidden') {
        const h = !safeTab.showHidden;
        setTab({ showHidden: h });
        dispatch({ type: 'setStatus', msg: h ? 'showing hidden files' : 'hiding hidden files' });
        onClose();
        return;
      }
      await v.execute(safeCtx, ps, {
        setTab,
        refreshActive,
        navigateTo,
        dispatch,
        openRename: (e) => setOpenRename(e),
        openMkdir: () => {
          // Fire status and close; App.tsx owns the mkdir overlay — emit an event
          window.dispatchEvent(new CustomEvent('fm:openMkdir'));
          onClose();
        },
        closeOverlay: onClose,
      });
    } catch (err) {
      dispatch({ type: 'setStatus', msg: `${v.label}: ${(err as Error).message}` });
    }
    if (v.id !== 'rename') onClose();
  }

  // Wire the deferred rename open (to parent overlay)
  useEffect(() => {
    if (openRename) {
      window.dispatchEvent(
        new CustomEvent('fm:openRename', { detail: { path: openRename.path } }),
      );
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRename]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      if (filter) {
        setFilter('');
      } else if (picks.length > 0) {
        setPicks(picks.slice(0, -1));
      } else if (verb) {
        setVerb(null);
      } else {
        onClose();
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const opt = matches[highlightIdx];
      if (opt) pickOption(opt);
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const opt = matches[highlightIdx];
      if (opt) pickOption(opt);
      return;
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      if (filter) setFilter('');
      else if (picks.length > 0) setPicks(picks.slice(0, -1));
      else if (verb) setVerb(null);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, matches.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Backspace' && !filter) {
      e.preventDefault();
      if (picks.length > 0) setPicks(picks.slice(0, -1));
      else if (verb) setVerb(null);
      return;
    }
    // Number keys 1-9 pick directly
    if (/^[1-9]$/.test(e.key) && !filter) {
      const n = parseInt(e.key, 10) - 1;
      if (n < matches.length) {
        e.preventDefault();
        pickOption(matches[n]);
      }
    }
  }

  const sentencePreview = buildPreview(verb, picks, ctx, matches, highlightIdx);

  return (
    <div className="chip-overlay" onClick={onClose}>
      <div className="chip-overlay__box" onClick={(e) => e.stopPropagation()}>
        {/* Sentence row */}
        <div className="chip-sentence">
          <Chip
            state={verb ? 'completed' : 'active'}
            label={verb ? verb.label : 'choose action'}
            placeholder={!verb}
          />
          {(verb ? verb.slots : [{ label: 'What' }, { label: 'Where' }]).map((s, i) => {
            const slotState =
              !verb ? 'placeholder'
                : i < picks.length ? 'completed'
                  : i === picks.length ? 'active' : 'placeholder';
            const label =
              slotState === 'completed'
                ? previewSlotValue(verb!, picks, i, ctx)
                : s.label.toLowerCase();
            return (
              <Chip
                key={i}
                state={slotState}
                label={label}
                placeholder={slotState === 'placeholder'}
              />
            );
          })}
        </div>

        {/* Filter input */}
        <div className="chip-input-row">
          <input
            ref={inputRef}
            autoFocus
            className="chip-input"
            value={filter}
            onChange={(e) => { setFilter(e.target.value); setHighlightIdx(0); setHoverReason(null); }}
            onKeyDown={onKeyDown}
            placeholder={
              verb === null
                ? 'type an action (move, sort, go to…) or a number'
                : activeSlot
                  ? `pick ${activeSlot.label.toLowerCase()}…`
                  : ''
            }
            spellCheck={false}
          />
          <span className="chip-slot-label">
            {verb === null ? 'ACTION' : activeSlot?.label.toUpperCase() ?? ''}
          </span>
        </div>

        {/* Options */}
        <ul className="chip-options">
          {matches.length === 0 && (
            <li className="chip-option chip-option--empty">no matches</li>
          )}
          {matches.map((opt, i) => (
            <li
              key={opt.id}
              className={[
                'chip-option',
                i === highlightIdx ? 'chip-option--highlighted' : '',
                !opt.available ? 'chip-option--disabled' : '',
              ].filter(Boolean).join(' ')}
              onMouseEnter={() => {
                setHighlightIdx(i);
                setHoverReason(opt.available ? null : opt.reason ?? null);
              }}
              onMouseLeave={() => setHoverReason(null)}
              onClick={() => pickOption(opt)}
            >
              <span className="chip-badge">{i < 9 ? i + 1 : '·'}</span>
              <span className="chip-option__body">
                <span className="chip-option__label">{opt.label}</span>
                {opt.detail && <span className="chip-option__detail">{opt.detail}</span>}
              </span>
              {!opt.available && (
                <span className="chip-option__lock" title={opt.reason}>⊘</span>
              )}
            </li>
          ))}
        </ul>

        {/* Preview + hover reason */}
        <div className="chip-preview">
          {hoverReason ? (
            <span className="chip-preview__reason">
              <span className="chip-preview__icon">⊘</span> {hoverReason}
            </span>
          ) : (
            <span className="chip-preview__text">{sentencePreview}</span>
          )}
        </div>

        {/* Hint bar */}
        <div className="chip-hints">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>Tab</kbd> or <kbd>Enter</kbd> pick</span>
          <span><kbd>1–9</kbd> direct pick</span>
          <span><kbd>⌫</kbd> back</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

function Chip({
  state,
  label,
  placeholder,
}: {
  state: 'active' | 'placeholder' | 'completed';
  label: string;
  placeholder?: boolean;
}) {
  return (
    <span className={`chip chip--${state}`}>
      {placeholder && <span className="chip__placeholder-caret">+</span>}
      <span className="chip__label">{label}</span>
    </span>
  );
}

function buildPreview(
  verb: VerbDef | null,
  picks: string[],
  ctx: Ctx,
  matches: Option[],
  highlightIdx: number,
): string {
  if (!verb) {
    const hov = matches[highlightIdx];
    return hov?.detail ?? 'Start typing to see what you can do';
  }
  const parts: string[] = [verb.label];
  verb.slots.forEach((_s, i) => {
    if (i < picks.length) parts.push(previewSlotValue(verb, picks, i, ctx));
    else if (i === picks.length) {
      const h = matches[highlightIdx];
      if (h) parts.push(`[${h.label}]`);
    }
  });
  return parts.join(' · ');
}

function previewSlotValue(
  verb: VerbDef,
  picks: string[],
  i: number,
  ctx: Ctx,
): string {
  const val = picks[i];
  const opts = verb.slots[i].getOptions(ctx, picks.slice(0, i));
  const match = opts.find((o) => o.id === val);
  return match?.label ?? val;
}

// Unused helpers kept for signature cohesion
void pathJoin;
void dirname;
