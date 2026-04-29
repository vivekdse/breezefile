// ────────────────────────────────────────────────────────────────────────────
// Verb-first command model (fm-zi2)
//
// The chip prompt is the *one* way users invoke actions. Every action is
// a verb (Move, Copy, Sort, Select, Delete, Rename, Go to, View as, …).
// Verbs have zero-or-more slots, each of which resolves to a pick-list. The
// sentence chip reads left-to-right: VERB [· SLOT1 · SLOT2 · …] , composed
// like a natural-language command ("move these → Desktop").
//
// Keyboard is motion + selection only (see src/useKeyboard.ts):
//   • Space / Shift+Space — mark cursor / mark-all (the only single-letter
//     selection shortcuts)
//   • j/k/h/l, arrows, n/N — motion
// Everything else opens this palette (typing any letter pre-fills its filter).
//
// Selection is visually expressed via a checkbox on every row and a master
// select-all checkbox in the column header. The 'Select' verb offers smart
// filters (all, none, images, documents, by extension, …). Executing 'Select'
// does NOT close the palette — it resets to the verb picker with the new
// selection applied, so flows like "select → images → copy → Desktop" chain
// without extra keystrokes.
// ────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { fm } from '../bridge';
import { runPaste } from '../clipboard';
import { invokeLauncher } from '../launchers';
import { spawnTerminal } from '../terminalSpawn';
import {
  basename,
  currentEntry,
  dirname,
  lastCol,
  pathJoin,
  visibleEntries,
} from '../actions';
import type { CustomTag, Entry, SortKey, TagFilter, TagPaths } from '../types';
import { getAllTags } from '../tags';
import { summarizeNames as summarizeNamesNode } from './ConfirmDialog';
import './ChipPrompt.css';

// One-shot lazy probe for the native Share helper binary. Verbs'
// isAvailable() runs synchronously, but shareHelperAvailable() is async, so
// on first invocation we kick off the probe and optimistically show the
// verb; subsequent calls read the resolved value. The worst case is a
// single "share failed: helper not found" status message on the very first
// activation in dev.
let shareHelperProbed = false;
let shareHelperAvailable: boolean | null = null;

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
  pinned: string[];
  tabs: Array<{ index: number; id: string; cwd: string; label: string; active: boolean }>;
  canRestoreTab: boolean;
  searchResults: string[]; // async Spotlight folder hits for current query
  searchFiles: Array<{ path: string; name: string; isDir: boolean }>; // file hits for goto
  searchQuery: string; // raw text in the destination slot — used by goto file pick
  localSubdirs: string[]; // BFS subdirectories under cwd (depth ~3)
  historyLen: number; // tab back-history depth
  forwardLen: number; // tab forward-history depth
  // Terminal selection state (fm-2du). Loaded lazily on mount; drives the
  // Open Terminal verb's conditional 'Which terminal' slot.
  defaultTerminal: string | null;
  installedTerminals: string[];
  // fm-jtu — does the active tab already have an embedded terminal pane?
  activeTabHasTerminal: boolean;
  // fm-g6r — user-editable launcher list (claude/codex/gemini, …).
  launchers: import('../bridge').Launcher[];
  // fm-60k — tag state surfaced to the chip palette so the tag/untag/newtag
  // verbs can compose options without reaching back into the store.
  customTags: CustomTag[];
  tagPaths: TagPaths;
  // The active tab's combination filter — when on, tagTargets() falls back
  // to the filtered-visible set instead of just the focused row.
  tagFilter: TagFilter;
};

type Verb =
  | 'select'
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
  | 'share'
  | 'showHidden'
  | 'theme'
  | 'tutorial'
  | 'tips'
  | 'permissions'
  | 'upgrade'
  | 'back'
  | 'forward'
  | 'up'
  | 'pin'
  | 'unpin'
  | 'switchTab'
  | 'newTab'
  | 'closeTab'
  | 'restoreTab'
  | 'compress'
  | 'extract'
  | 'copy-path'
  | 'open-with'
  | 'openTerminal'
  | 'term'
  | 'term-close'
  | 'newtag'
  | 'tag'
  | 'untag'
  | 'filter'
  | 'help'
  | 'welcome'
  | 'task'
  | 'tasks'
  | 'settings';

type Option = {
  id: string;
  label: string;
  detail?: string;
  available: boolean;
  reason?: string; // shown on hover when unavailable
  // Extra strings that should match the filter but aren't shown as the label.
  // Used for natural synonyms: e.g. the "By extension" sort option aliases
  // 'type', 'kind', 'filetype' so users who think "sort by file type" find it.
  aliases?: string[];
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
  // fm-a9j — when the active tab is a task tab, only verbs that opt in
  // (or omit this flag) are surfaced. File-management verbs explicitly
  // set this to false so the prompt in task mode reads as "operate on
  // the task," not "operate on a folder."
  availableInTaskMode?: boolean;
};

type SlotDef = {
  label: string; // "What", "Where", "How", "By", "Direction"
  getOptions: (ctx: Ctx, prev: string[]) => Option[];
};

type ExecApi = {
  setTab: (patch: any) => void;
  refreshActive: () => Promise<void>;
  navigateTo: (p: string) => void;
  goBack: () => void;
  goForward: () => void;
  dispatch: (a: any) => void;
  openRename: (e: Entry) => void;
  openMkdir: () => void;
  openTouch: () => void;
  focusEntryByName: (name: string) => void;
  closeOverlay: () => void;
  // Reset palette to the verb picker without closing — used by the 'Select'
  // verb to auto-advance into "now what?" for chain flows like select→copy.
  resetToVerbPick: (status?: string) => void;
  // fm-jtu — index of the active tab when the verb fires. Lets terminal
  // verbs dispatch tab-scoped openTerminal/closeTerminal actions.
  activeTabIndex: number;
  // fm-jtu — current terminal state on the active tab, if any.
  activeTabTerminal?: { ptyId: number };
  // fm-mph — when the active tab is a task tab, expose its task id so
  // launcher verbs can inject task context (env + sidecar + pre-typed
  // prompt) into AI launches the same way TaskShell's action cards do.
  activeTabTaskId?: string | null;
};

// ────────────────────────────────────────────────────────────────────────────
// Verb catalog. Order matters — it's the default suggestion order.
// ────────────────────────────────────────────────────────────────────────────
// Smart selection filters — mapped to predicates on Entry.
// 'byExt:<ext>' is a dynamic id resolved at execute-time from the live ext list.
type SelectorId =
  | 'all'
  | 'none'
  | 'invert'
  | 'images'
  | 'videos'
  | 'audio'
  | 'documents'
  | 'archives'
  | 'code'
  | 'folders'
  | 'files'
  | string; // byExt:<ext>

const EXT_GROUPS: Record<string, string[]> = {
  images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'heic', 'svg'],
  videos: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'],
  documents: ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'pages', 'key', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'numbers'],
  archives: ['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'dmg'],
  code: ['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'rs', 'go', 'sh', 'rb', 'java', 'c', 'cpp', 'h', 'hpp', 'css', 'html'],
};

function entryMatchesSelector(e: Entry, sel: SelectorId): boolean {
  if (sel === 'all') return true;
  if (sel === 'none') return false;
  if (sel === 'folders') return e.kind === 'dir';
  if (sel === 'files') return e.kind !== 'dir';
  if (sel.startsWith('byExt:')) return (e.ext ?? '').toLowerCase() === sel.slice(6).toLowerCase();
  const group = EXT_GROUPS[sel];
  if (group) return e.kind !== 'dir' && !!e.ext && group.includes(e.ext.toLowerCase());
  return false;
}

const VERBS: VerbDef[] = [
  {
    id: 'select',
    availableInTaskMode: false,
    label: 'Select',
    aliases: ['select', 'pick', 'mark', 'choose'],
    icon: '☑',
    describe: (c) => `Select files in ${basename(c.cwd) || '/'}`,
    isAvailable: () => ({ ok: true }),
    slots: [
      {
        label: 'What',
        getOptions: (c) => {
          const opts: Option[] = [
            { id: 'all', label: 'All', detail: `every item in this folder (${c.entries.length})`, available: true },
            { id: 'none', label: 'None', detail: 'clear current selection', available: true },
            { id: 'invert', label: 'Invert', detail: 'flip every mark', available: true },
            { id: 'folders', label: 'Folders', detail: 'directories only', available: true },
            { id: 'files', label: 'Files', detail: 'non-directories', available: true },
          ];
          for (const key of Object.keys(EXT_GROUPS)) {
            const count = c.entries.filter((e) => entryMatchesSelector(e, key)).length;
            if (count > 0) {
              opts.push({
                id: key,
                label: key[0].toUpperCase() + key.slice(1),
                detail: `${count} match${count === 1 ? '' : 'es'}`,
                available: true,
              });
            }
          }
          // Dynamic "by extension" options — one per unique ext in this folder.
          const extCounts = new Map<string, number>();
          for (const e of c.entries) {
            if (e.kind !== 'dir' && e.ext) {
              const k = e.ext.toLowerCase();
              extCounts.set(k, (extCounts.get(k) ?? 0) + 1);
            }
          }
          const byExt = Array.from(extCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12);
          for (const [ext, n] of byExt) {
            opts.push({
              id: `byExt:${ext}`,
              label: `.${ext}`,
              detail: `${n} file${n === 1 ? '' : 's'}`,
              available: true,
            });
          }
          return opts;
        },
      },
    ],
    execute: (c, [selector], api) => {
      // Compute new marks. 'invert' is relative to current state; others are absolute.
      const currentMarks = c.markedPaths.reduce<Record<string, true>>((acc, p) => {
        acc[p] = true;
        return acc;
      }, {});
      let newMarks: Record<string, true> = {};
      if (selector === 'invert') {
        newMarks = { ...currentMarks };
        for (const e of c.entries) {
          if (newMarks[e.path]) delete newMarks[e.path];
          else newMarks[e.path] = true;
        }
      } else if (selector === 'none') {
        newMarks = {};
      } else {
        for (const e of c.entries) {
          if (entryMatchesSelector(e, selector)) newMarks[e.path] = true;
        }
      }
      api.setTab({ marks: newMarks });
      const count = Object.keys(newMarks).length;
      api.dispatch({
        type: 'setStatus',
        msg:
          count === 0
            ? 'selection cleared'
            : `selected ${count} — space to add, d to drag, y to yank`,
      });
      api.closeOverlay();
    },
  },
  {
    id: 'move',
    availableInTaskMode: false,
    label: 'Move',
    aliases: ['move', 'mv', 'cut'],
    icon: '→',
    describe: (c) =>
      c.markedPaths.length > 0
        ? `Move ${c.markedPaths.length} item${c.markedPaths.length === 1 ? '' : 's'} to…`
        : `Move ${c.cursor?.name ?? 'item'} to…`,
    isAvailable: (c) => {
      if (c.markedPaths.length === 0 && !c.cursor) {
        return { ok: false, reason: 'Select files first (press space) or put the cursor on one' };
      }
      return { ok: true };
    },
    slots: [{ label: 'Where', getOptions: (c) => destinationOptions(c) }],
    // fm-3km: stage + navigate. The user lands at the destination and a
    // floating PasteChip prompts them to confirm — they can also keep
    // navigating into a sub-folder before pasting.
    execute: (c, [dest], api) => {
      const sources = implicitSources(c);
      const dst = resolveDestination(c, dest);
      if (!dst || sources.length === 0) return;
      api.dispatch({
        type: 'setYank',
        yank: sources.map((p) => ({ path: p, mode: 'move' as const })),
      });
      api.setTab({ marks: {} });
      api.navigateTo(dst);
      api.dispatch({
        type: 'setStatus',
        msg: `staged ${sources.length} to move → ${basename(dst)} · press ph or click Paste`,
      });
      api.closeOverlay();
    },
  },
  {
    id: 'copy',
    availableInTaskMode: false,
    label: 'Copy',
    aliases: ['copy', 'cp', 'duplicate'],
    icon: '⧉',
    describe: (c) =>
      c.markedPaths.length > 0
        ? `Copy ${c.markedPaths.length} item${c.markedPaths.length === 1 ? '' : 's'} to…`
        : `Copy ${c.cursor?.name ?? 'item'} to…`,
    isAvailable: (c) => {
      if (c.markedPaths.length === 0 && !c.cursor) {
        return { ok: false, reason: 'Select files first (space) or put the cursor on one' };
      }
      return { ok: true };
    },
    slots: [{ label: 'Where', getOptions: (c) => destinationOptions(c) }],
    // fm-3km: stage + navigate. Same pattern as Move — the user lands at
    // the destination, the PasteChip floats above the statusbar, and they
    // confirm with pp / click. Yank persists across copy paste so they can
    // drop the same selection in multiple places.
    execute: (c, [dest], api) => {
      const sources = implicitSources(c);
      const dst = resolveDestination(c, dest);
      if (!dst || sources.length === 0) return;
      api.dispatch({
        type: 'setYank',
        yank: sources.map((p) => ({ path: p, mode: 'copy' as const })),
      });
      api.navigateTo(dst);
      api.dispatch({
        type: 'setStatus',
        msg: `staged ${sources.length} to copy → ${basename(dst)} · press ph or click Paste`,
      });
      api.closeOverlay();
    },
  },
  {
    id: 'paste',
    availableInTaskMode: false,
    label: 'Paste here',
    aliases: ['paste', 'paste here', 'put', 'drop', 'place'],
    icon: '↓',
    describe: (c) =>
      c.yankCount === 0
        ? 'Paste (clipboard is empty)'
        : `Paste ${c.yankCount} item${c.yankCount === 1 ? '' : 's'} here · ph`,
    isAvailable: (c) => {
      if (c.yankCount === 0) {
        return { ok: false, reason: 'Clipboard is empty — copy or cut some files first' };
      }
      return { ok: true };
    },
    slots: [],
    // Real implementation lives in executeWith()'s special-case for 'paste'
    // (it needs live yank from the store, which the Ctx snapshot lacks).
    execute: () => {},
  },
  {
    id: 'sort',
    availableInTaskMode: false,
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
          { id: 'type|asc', label: 'Folders first', detail: 'group folders, links, files', available: true },
          {
            id: 'ext|asc',
            label: 'By extension',
            detail: '.pdf, .jpg… — also: type, kind, filetype',
            available: true,
            // Synonyms: most users say "sort by type" or "by file type" when
            // they mean by extension. Accept all of those as matches.
            aliases: ['type', 'file type', 'filetype', 'kind', 'extension', 'ext'],
          },
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
    availableInTaskMode: false,
    label: 'Delete',
    aliases: ['delete', 'trash', 'rm', 'remove'],
    icon: '🗑',
    describe: (c) =>
      c.markedPaths.length > 0
        ? `Move ${c.markedPaths.length} item${c.markedPaths.length === 1 ? '' : 's'} to trash`
        : `Move ${c.cursor?.name ?? 'item'} to trash`,
    isAvailable: (c) => {
      if (c.markedPaths.length === 0 && !c.cursor) {
        return { ok: false, reason: 'Select files first or put cursor on one' };
      }
      return { ok: true };
    },
    slots: [],
    execute: (c, _picks, api) => {
      const sources = implicitSources(c);
      if (sources.length === 0) return;
      const names = sources.map((p) => basename(p));
      const noun = sources.length === 1 ? `“${names[0]}”` : `${sources.length} items`;
      window.dispatchEvent(
        new CustomEvent('fm:confirm', {
          detail: {
            title: 'Move to trash?',
            body: (
              <>
                <div>Move {noun} to the trash. You can restore from Finder.</div>
                {sources.length > 1 && summarizeNamesNode(names)}
              </>
            ),
            confirmLabel: 'Trash',
            destructive: true,
            confirmShortcuts: ['d'],
            onConfirm: async () => {
              try {
                await fm.trash(sources);
                api.setTab({ marks: {} });
                await api.refreshActive();
                api.dispatch({
                  type: 'setStatus',
                  msg: `trashed ${sources.length} item${sources.length === 1 ? '' : 's'}`,
                });
              } catch (err) {
                api.dispatch({
                  type: 'setStatus',
                  msg: `trash failed: ${(err as Error).message}`,
                });
              }
            },
          },
        }),
      );
    },
  },
  {
    id: 'rename',
    availableInTaskMode: false,
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
    availableInTaskMode: false,
    label: 'Go to / Find',
    aliases: ['go', 'goto', 'cd', 'navigate', 'open folder', 'find', 'search', 'locate', 'jump'],
    icon: '→',
    describe: () => 'Go to or find a folder or file (file picks open its parent, filtered)',
    isAvailable: () => ({ ok: true }),
    slots: [{ label: 'Where', getOptions: (c) => destinationOptions(c, true, true) }],
    execute: (c, [dest], api) => {
      // File pick: navigate to parent, then apply the typed query as a substring
      // filter on the folder. Surfaces a clearable filter chip so the user sees
      // and can undo the narrowing.
      if (dest.startsWith('file:')) {
        const filePath = dest.slice('file:'.length);
        const parent = dirnameOf(filePath);
        const q = c.searchQuery.trim();
        api.navigateTo(parent);
        if (q) {
          api.setTab({ filter: q });
          api.dispatch({ type: 'setStatus', msg: `filtered to "${q}" — Esc to clear` });
        }
        return;
      }
      const target = resolveDestination(c, dest);
      if (target) api.navigateTo(target);
    },
  },
  {
    id: 'pin',
    availableInTaskMode: false,
    label: 'Pin to sidebar',
    aliases: ['pin', 'favorite', 'bookmark sidebar', 'add to sidebar'],
    icon: '★',
    describe: (c) => {
      const cursorIsDir = c.cursor?.kind === 'dir';
      const defaultLabel = cursorIsDir ? c.cursor!.name : basename(c.cwd) || '/';
      return `Pin ${defaultLabel} to sidebar Favorites`;
    },
    isAvailable: () => ({ ok: true }),
    slots: [
      {
        label: 'Which folder',
        getOptions: (c) => {
          const opts = destinationOptions(c, true);
          const pinnedSet = new Set(c.pinned);
          return opts
            .filter((o) => {
              const p = resolveDestination(c, o.id);
              return p ? !pinnedSet.has(p) : true;
            });
        },
      },
    ],
    execute: (c, [dest], api) => {
      const target = resolveDestination(c, dest);
      if (!target) return;
      api.dispatch({ type: 'pinFolder', path: target });
      api.dispatch({ type: 'setStatus', msg: `pinned ${basename(target) || target}` });
    },
  },
  {
    id: 'unpin',
    availableInTaskMode: false,
    label: 'Unpin from sidebar',
    aliases: ['unpin', 'remove pin', 'remove favorite'],
    icon: '☆',
    describe: () => 'Remove a pinned folder from the sidebar',
    isAvailable: (c) => {
      if ((c.pinned?.length ?? 0) === 0) return { ok: false, reason: 'No pinned folders yet' };
      return { ok: true };
    },
    slots: [
      {
        label: 'Which pin',
        getOptions: (c) =>
          (c.pinned ?? []).map((p) => ({
            id: p,
            label: basename(p) || p,
            detail: prettyPath(p, c.homedir),
            available: true,
          })),
      },
    ],
    execute: (_c, [path], api) => {
      api.dispatch({ type: 'unpinFolder', path });
      api.dispatch({ type: 'setStatus', msg: `unpinned ${basename(path) || path}` });
    },
  },
  {
    id: 'switchTab',
    label: 'Switch tab',
    aliases: ['switch tab', 'go to tab', 'tab', 'jump to tab'],
    icon: '⇄',
    describe: () => 'Jump to another open tab',
    isAvailable: (c) =>
      c.tabs.length > 1 ? { ok: true } : { ok: false, reason: 'Only one tab open' },
    slots: [
      {
        label: 'Tab',
        getOptions: (c) =>
          c.tabs
            .filter((t) => !t.active)
            .map((t) => ({
              id: String(t.index),
              label: t.label,
              detail: prettyPath(t.cwd, c.homedir),
              available: true,
            })),
      },
    ],
    execute: (_c, [idx], api) => {
      api.dispatch({ type: 'selectTab', index: Number(idx) });
    },
  },
  {
    id: 'newTab',
    label: 'New tab',
    aliases: ['new tab', 'open tab', 'add tab'],
    icon: '+',
    describe: (c) => `Open a new tab at ${basename(c.cwd) || '/'}`,
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (c, _p, api) => {
      api.dispatch({
        type: 'newTab',
        tab: {
          id: crypto.randomUUID(),
          kind: 'folder',
          taskId: null,
          trail: [c.cwd],
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
        },
      });
    },
  },
  {
    id: 'closeTab',
    label: 'Close tab',
    aliases: ['close tab', 'remove tab', 'kill tab'],
    icon: '×',
    describe: (c) => `Close ${c.tabs.find((t) => t.active)?.label ?? 'this tab'}`,
    isAvailable: (c) =>
      c.tabs.length > 1 ? { ok: true } : { ok: false, reason: "Can't close the last tab" },
    slots: [],
    execute: (c, _p, api) => {
      const active = c.tabs.find((t) => t.active);
      if (active) api.dispatch({ type: 'closeTab', index: active.index });
    },
  },
  {
    id: 'restoreTab',
    label: 'Restore closed tab',
    aliases: ['restore tab', 'reopen tab', 'undo close'],
    icon: '↺',
    describe: () => 'Re-open the most recently closed tab',
    isAvailable: (c) =>
      c.canRestoreTab ? { ok: true } : { ok: false, reason: 'No recently closed tab' },
    slots: [],
    execute: (_c, _p, api) => {
      api.dispatch({ type: 'restoreTab' });
    },
  },
  {
    id: 'open',
    availableInTaskMode: false,
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
    id: 'copy-path',
    availableInTaskMode: false,
    label: 'Copy path',
    aliases: ['copy-path', 'copypath', 'path', 'cpp'],
    icon: '⧉',
    describe: (c) => {
      const count = c.markedPaths.length;
      if (count > 1) return `Copy ${count} paths to clipboard`;
      const name = count === 1 ? basename(c.markedPaths[0]) : c.cursor?.name ?? 'item';
      return `Copy path of ${name} to clipboard`;
    },
    isAvailable: (c) => {
      if (c.markedPaths.length === 0 && !c.cursor) {
        return { ok: false, reason: 'Put cursor on a file or select some first' };
      }
      return { ok: true };
    },
    slots: [],
    // Plain-text path(s) on the system clipboard — newline-joined when
    // there's more than one marked item. Complements the drag-out path
    // (native FS drag) and the context-menu "Copy path" entry: a single
    // discoverable verb works when users don't know the right modifier
    // or are already in the chip flow for another action.
    execute: (c, _p, api) => {
      const sources = implicitSources(c);
      if (sources.length === 0) return;
      const payload = sources.join('\n');
      void fm.clipboardWrite(payload);
      api.dispatch({
        type: 'setStatus',
        msg: sources.length === 1 ? 'copied 1 path' : `copied ${sources.length} paths`,
      });
      api.closeOverlay();
    },
  },
  {
    id: 'open-with',
    availableInTaskMode: false,
    label: 'Open With…',
    aliases: ['open-with', 'openwith', 'ow'],
    icon: '⎋',
    describe: (c) => `Open ${c.cursor?.name ?? 'item'} with another app…`,
    isAvailable: (c) => {
      if (!c.cursor) return { ok: false, reason: 'Put the cursor on a file first' };
      return { ok: true };
    },
    slots: [],
    // Surfaces the existing OpenWithDialog (the confirm-and-remember
    // modal from Preview) from the chip prompt. Always targets the
    // cursor — multi-item "open with" makes little sense since the user
    // picks a single app. If a selection exists, the cursor still wins
    // so the action is predictable.
    execute: (c, _p, api) => {
      if (!c.cursor) return;
      const { path, ext } = c.cursor;
      api.closeOverlay();
      window.dispatchEvent(
        new CustomEvent('fm:openWith', { detail: { path, ext } }),
      );
    },
  },
  {
    id: 'reveal',
    availableInTaskMode: false,
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
    // fm-2du: Open Terminal here. Two-layer selection — on first use we
    // detect installed terminals and ask the user to pick one; after that
    // the pref is persisted so subsequent invocations skip the chooser.
    // The slot only materializes when there's no saved pref and more than
    // one terminal is installed. One-terminal installs auto-select.
    id: 'openTerminal',
    label: 'Open external terminal here',
    aliases: ['open-terminal', 'open-external-terminal', 'cli', 'iterm', 'external-terminal'],
    icon: '$_',
    describe: (c) => {
      if (c.defaultTerminal) {
        const nice = c.defaultTerminal.replace(/\.app$/, '');
        return `Open ${nice} at ${basename(c.cwd) || '/'}`;
      }
      return `Open a terminal at ${basename(c.cwd) || '/'}`;
    },
    isAvailable: () => ({ ok: true }),
    slots: [
      {
        label: 'Which terminal',
        getOptions: (c) => {
          // If the user already picked a default, skip straight to execute:
          // returning an empty option list would block, so we synthesize a
          // single 'use-default' option that the execute branch recognises.
          // Auto-select the single installed terminal the first time too.
          if (c.defaultTerminal) {
            const nice = c.defaultTerminal.replace(/\.app$/, '');
            return [
              {
                id: `use:${c.defaultTerminal}`,
                label: nice,
                detail: 'your default — change in Settings',
                available: true,
              },
            ];
          }
          if (c.installedTerminals.length === 0) {
            return [
              {
                id: 'none',
                label: 'No supported terminal found',
                detail: 'install iTerm, WezTerm, Warp, Ghostty, Alacritty, or kitty',
                available: false,
                reason: 'No supported terminal detected in /Applications',
              },
            ];
          }
          if (c.installedTerminals.length === 1) {
            const only = c.installedTerminals[0];
            const nice = only.replace(/\.app$/, '');
            return [
              {
                id: `pickAndRemember:${only}`,
                label: nice,
                detail: 'only one installed — will remember as default',
                available: true,
              },
            ];
          }
          return c.installedTerminals.map((bundle) => ({
            id: `pickAndRemember:${bundle}`,
            label: bundle.replace(/\.app$/, ''),
            detail: 'set as default (change later in Settings)',
            available: true,
          }));
        },
      },
    ],
    execute: async (c, [choice], api) => {
      let bundle: string | null = null;
      let remember = false;
      if (choice?.startsWith('use:')) {
        bundle = choice.slice(4);
      } else if (choice?.startsWith('pickAndRemember:')) {
        bundle = choice.slice('pickAndRemember:'.length);
        remember = true;
      }
      if (!bundle) return;
      if (remember) {
        try {
          await fm.setDefaultTerminal(bundle);
        } catch {
          // Non-fatal: launch still proceeds even if we fail to persist.
        }
      }
      try {
        await fm.openTerminal(c.cwd);
        api.dispatch({
          type: 'setStatus',
          msg: remember
            ? `opened ${bundle.replace(/\.app$/, '')} (saved as default)`
            : `opened ${bundle.replace(/\.app$/, '')}`,
        });
      } catch (err) {
        api.dispatch({
          type: 'setStatus',
          msg: `terminal failed: ${(err as Error).message}`,
        });
      }
    },
  },
  {
    // fm-jtu — embedded terminal pane. Splits the active tab and spawns a
    // shell rooted at the tab's cwd. Re-running on a tab that already has
    // a terminal is a no-op (focus is moved to the existing pane via the
    // mount effect on isActive). Use :term-close to dismiss.
    id: 'term',
    label: 'Open terminal pane',
    aliases: ['term', 'terminal', 'shell', 'pty'],
    icon: '$_',
    describe: (c) => {
      if (c.activeTabHasTerminal) return 'Focus the terminal pane in this tab';
      return `Open a terminal pane at ${basename(c.cwd) || '/'}`;
    },
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: async (c, _p, api) => {
      if (api.activeTabTerminal) {
        api.dispatch({ type: 'setStatus', msg: 'terminal already open' });
        api.closeOverlay();
        return;
      }
      try {
        const ptyId = await spawnTerminal({
          cwd: c.cwd,
          sessionLabel: basename(c.cwd) || c.cwd,
        });
        api.dispatch({
          type: 'openTerminal',
          tabIndex: api.activeTabIndex,
          ptyId,
          cwd: c.cwd,
        });
        api.dispatch({ type: 'setStatus', msg: 'terminal opened' });
      } catch (err) {
        api.dispatch({
          type: 'setStatus',
          msg: `terminal failed: ${(err as Error).message}`,
        });
      }
      api.closeOverlay();
    },
  },
  {
    // fm-8qf — close the embedded terminal in the active tab. Confirms if
    // the shell still has a foreground process (or anyway, since we don't
    // peek into the pty's child tree, we always confirm to be safe).
    id: 'term-close',
    label: 'Close terminal pane',
    aliases: ['term-close', 'close-term', 'close-terminal', 'killterm', 'qterm'],
    icon: '✕',
    describe: () => 'Close the terminal pane in this tab',
    isAvailable: (c) => {
      if (!c.activeTabHasTerminal) {
        return { ok: false, reason: 'No terminal pane open in this tab — :term to open' };
      }
      return { ok: true };
    },
    slots: [],
    execute: (_c, _p, api) => {
      const term = api.activeTabTerminal;
      if (!term) return;
      // Surface a confirm — running shells often hold work (interactive
      // CLIs, partially typed commands, in-progress builds). Yes/no via
      // the shared ConfirmDialog event so we look like the rest of the
      // app rather than a one-off window.confirm.
      api.closeOverlay();
      window.dispatchEvent(
        new CustomEvent('fm:confirm', {
          detail: {
            title: 'Close terminal?',
            body:
              'Any running process in this terminal will be terminated. Continue?',
            confirmLabel: 'Close',
            destructive: true,
            onConfirm: async () => {
              try { await fm.termKill(term.ptyId); } catch { /* noop */ }
              api.dispatch({
                type: 'closeTerminal',
                tabIndex: api.activeTabIndex,
              });
              api.dispatch({ type: 'setStatus', msg: 'terminal closed' });
            },
          },
        }),
      );
    },
  },
  {
    // fm-wvf — native macOS share sheet (NSSharingServicePicker). Covers
    // AirDrop, Messages, Mail, Notes, Reminders, and third-party share
    // extensions. AppleScript can't reach AirDrop or extensions, so we
    // ship a tiny Swift helper binary (see native/sharer/) and shell out
    // to it. If the binary isn't present (dev mode where `make -C
    // native/sharer` hasn't been run), the verb disables with a reason
    // rather than silently failing.
    id: 'share',
    availableInTaskMode: false,
    label: 'Share',
    aliases: ['share', 'send'],
    icon: '↗',
    describe: (c) => {
      const n = c.markedPaths.length || (c.cursor ? 1 : 0);
      if (n === 0) return 'Share files via macOS share sheet';
      const name = c.markedPaths.length > 0
        ? `${n} item${n === 1 ? '' : 's'}`
        : c.cursor!.name;
      return `Share ${name} (AirDrop, Mail, Messages, …)`;
    },
    isAvailable: (c) => {
      if (c.markedPaths.length === 0 && !c.cursor) {
        return { ok: false, reason: 'Select files first (press space) or put the cursor on one' };
      }
      // Kick off a lazy one-shot probe so subsequent calls see the result.
      if (!shareHelperProbed) {
        shareHelperProbed = true;
        void fm.shareHelperAvailable().then((v) => { shareHelperAvailable = v; });
      }
      if (shareHelperAvailable === false) {
        return { ok: false, reason: 'Run `make -C native/sharer` to enable Share' };
      }
      return { ok: true };
    },
    slots: [],
    execute: (c, _p, api) => {
      const sources = implicitSources(c);
      if (sources.length === 0) return;
      // v1 anchor: center of the viewport, upper third. The chip prompt
      // doesn't have a DOM handle to the originating FileRow or Pathbar
      // button, so we punt on precise anchoring until we plumb an anchor
      // rect through the palette context. Follow-up: pass the triggering
      // element's bounding rect via ExecApi.
      const cx = Math.round(window.outerWidth / 2) + (window.screenX || 0);
      const cy = Math.round(window.outerHeight / 3) + (window.screenY || 0);
      const anchor = { x: cx - 8, y: cy - 8, w: 16, h: 16 };
      void fm.share(sources, anchor).then(
        () => {
          // The native helper exits cleanly on both "service completed" and
          // "picker dismissed without a pick". We can't distinguish the two
          // without extending the helper's stdout protocol, so settle for a
          // neutral confirmation that at minimum tells the user the picker
          // has closed and we're back to idle.
          api.dispatch({ type: 'setStatus', msg: 'share closed' });
        },
        (err: unknown) => {
          const msg = (err as Error)?.message ?? String(err);
          api.dispatch({ type: 'setStatus', msg: `share failed: ${msg}` });
        },
      );
      api.dispatch({ type: 'setStatus', msg: `sharing ${sources.length} item${sources.length === 1 ? '' : 's'}…` });
      api.closeOverlay();
    },
  },
  {
    id: 'view',
    availableInTaskMode: false,
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
          { id: 'preview', label: 'Preview', detail: 'large thumbnails', available: true },
          { id: 'tag', label: 'Tags', detail: 'color-code & filter', available: true },
        ],
      },
    ],
    execute: (_c, [mode], api) => {
      api.setTab({ viewMode: mode as 'list' | 'grid' | 'preview' | 'tag' });
      api.dispatch({ type: 'setStatus', msg: `view: ${mode}` });
    },
  },
  // Tag verbs share this target-resolution policy: marks > filtered visible
  // set (when a tag-combination filter is active) > cursor. This lets the
  // user narrow the list with the inspector's filter and tag the whole
  // visible result without manually marking every row.
  // (Defined as a const so verb closures below can reach it.)
  // Note: declared inline at the call site via the helper below.
  {
    id: 'newtag',
    label: 'New tag',
    aliases: ['newtag', 'create tag', 'new tag', 'tag new', 'mktag'],
    icon: '⊕',
    describe: () => 'Create a new tag (name + color)',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (_c, _p, api) => {
      window.dispatchEvent(new CustomEvent('fm:newTag'));
      api.closeOverlay();
    },
  },
  {
    // fm-nmt — task create/edit. Quick-add defaults to the current tab's
    // cwd; the dialog itself accepts an explicit folder override.
    id: 'task',
    label: 'New task',
    aliases: ['task', 'todo', 'new task', 'add task', 'mktask'],
    icon: '✓',
    describe: (c) => `Create a task in ${basename(c.cwd) || '/'}`,
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (c, _p, api) => {
      window.dispatchEvent(
        new CustomEvent('fm:openTask', {
          detail: { mode: 'create', defaultFolder: c.cwd },
        }),
      );
      api.closeOverlay();
    },
  },
  {
    // fm-kaa — full-screen tasks page. Distinct from `task` (singular,
    // create) so the chip prompt disambiguates intent: "task" makes one,
    // "tasks" shows all of them with filter/search/bulk-ops. The verb is
    // the entry point until the sidebar's "See all" link lands.
    id: 'tasks',
    label: 'All tasks',
    aliases: ['tasks', 'all tasks', 'task list', 'tasklist'],
    icon: '☰',
    describe: () => 'Open the full task list with filters, search, bulk ops',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (_c, _p, api) => {
      api.closeOverlay();
      window.dispatchEvent(new CustomEvent('fm:openTasksPage'));
    },
  },
  {
    id: 'tag',
    availableInTaskMode: false,
    label: 'Tag',
    aliases: ['tag', 'apply tag', 'add tag', 'pin'],
    icon: '◉',
    describe: (c) => {
      const n = folderTargets(c).length;
      return n === 0 ? 'Open a folder first' : `Apply a tag to ${n} files in this folder`;
    },
    isAvailable: (c) => {
      if (folderTargets(c).length === 0) {
        return { ok: false, reason: 'Open a folder first' };
      }
      if (getAllTags(c.customTags).length === 0) {
        return { ok: false, reason: 'No tags exist — run “new tag” first' };
      }
      return { ok: true };
    },
    slots: [
      {
        label: 'Tag',
        getOptions: (c) => {
          const targets = folderTargets(c);
          return getAllTags(c.customTags).map((t) => {
            const applied = c.tagPaths[t.id] ?? [];
            const already = targets.length > 0 && targets.every((p) => applied.includes(p));
            const hits = targets.filter((p) => applied.includes(p)).length;
            return {
              id: t.id,
              label: t.name,
              detail: already
                ? 'every file already carries this tag'
                : hits > 0
                  ? `${hits}/${targets.length} already tagged · will tag the rest`
                  : t.builtin === false
                    ? `manual — will add ${targets.length} to its list`
                    : t.description ?? 'built-in rule',
              available: !already,
              reason: already ? 'every file already carries this tag' : undefined,
            };
          });
        },
      },
    ],
    execute: (c, [tagId], api) => {
      const paths = folderTargets(c);
      if (paths.length === 0 || !tagId) return;
      api.dispatch({ type: 'applyTag', id: tagId, paths });
      const tag = getAllTags(c.customTags).find((t) => t.id === tagId);
      api.dispatch({
        type: 'setStatus',
        msg: `tagged ${paths.length} files → ${tag?.name ?? tagId}`,
      });
      api.dispatch({ type: 'addTagViz', id: tagId });
      api.closeOverlay();
    },
  },
  {
    id: 'filter',
    availableInTaskMode: false,
    label: 'Filter by tag',
    aliases: ['filter', 'tag filter', 'narrow', 'show only', 'show files', 'limit'],
    icon: '⌖',
    describe: (c) => {
      const f = c.tagFilter;
      if (f.mode === 'off' || f.ids.length === 0) {
        return 'Narrow this folder to files matching specific tags';
      }
      return `Filter (${f.mode === 'all' ? 'match all' : 'match any'}) of ${f.ids.length} tag${f.ids.length === 1 ? '' : 's'}`;
    },
    isAvailable: (c) => {
      if (getAllTags(c.customTags).length === 0) {
        return { ok: false, reason: 'No tags exist — run “new tag” first' };
      }
      return { ok: true };
    },
    slots: [
      {
        label: 'Action',
        getOptions: (c) => {
          const f = c.tagFilter;
          const inFilterCount = f.ids.length;
          const opts: Option[] = [
            {
              id: 'add',
              label: 'Add a tag',
              detail: 'narrow the list to files carrying this tag',
              available: true,
            },
          ];
          if (inFilterCount > 0) {
            opts.push({
              id: 'remove',
              label: 'Remove a tag',
              detail: `${inFilterCount} tag${inFilterCount === 1 ? '' : 's'} currently in filter`,
              available: true,
            });
            opts.push({
              id: 'mode',
              label: `Switch match mode (now: ${f.mode === 'all' ? 'match all' : f.mode === 'any' ? 'match any' : 'off'})`,
              detail: 'all = AND, any = OR',
              available: true,
            });
            opts.push({
              id: 'clear',
              label: 'Clear filter',
              detail: 'show every file again',
              available: true,
            });
          }
          return opts;
        },
      },
      {
        label: 'Pick',
        getOptions: (c, prev) => {
          const action = prev[0];
          if (action === 'add') {
            return getAllTags(c.customTags)
              .map((t) => ({
                id: t.id,
                label: t.name,
                detail: c.tagFilter.ids.includes(t.id) ? 'already in filter' : t.description ?? '',
                available: !c.tagFilter.ids.includes(t.id),
                reason: c.tagFilter.ids.includes(t.id) ? 'already in filter' : undefined,
              }));
          }
          if (action === 'remove') {
            return c.tagFilter.ids
              .map((id) => getAllTags(c.customTags).find((t) => t.id === id))
              .filter((t): t is NonNullable<typeof t> => !!t)
              .map((t) => ({ id: t.id, label: t.name, detail: 'remove from filter', available: true }));
          }
          if (action === 'mode') {
            return [
              { id: 'all', label: 'Match all', detail: 'a file must carry every selected tag (AND)', available: true },
              { id: 'any', label: 'Match any', detail: 'a file must carry at least one selected tag (OR)', available: true },
              { id: 'off', label: 'Off', detail: 'show every file', available: true },
            ];
          }
          // clear: no second slot needed; surface a confirm-style single option
          return [{ id: 'confirm', label: 'Clear all filter tags', available: true }];
        },
      },
    ],
    execute: (c, [action, value], api) => {
      const f = c.tagFilter;
      if (action === 'add' && value) {
        const ids = [...f.ids, value];
        api.setTab({
          tagFilter: { mode: f.mode === 'off' ? 'all' : f.mode, ids },
          // Auto-toggle viz so the user sees the colored band on matching rows.
        });
        api.dispatch({ type: 'addTagViz', id: value });
        const tag = getAllTags(c.customTags).find((t) => t.id === value);
        api.dispatch({ type: 'setStatus', msg: `filter +${tag?.name ?? value}` });
      } else if (action === 'remove' && value) {
        const ids = f.ids.filter((x) => x !== value);
        api.setTab({
          tagFilter: { mode: ids.length === 0 ? 'off' : f.mode, ids },
        });
        const tag = getAllTags(c.customTags).find((t) => t.id === value);
        api.dispatch({ type: 'setStatus', msg: `filter −${tag?.name ?? value}` });
      } else if (action === 'mode' && value) {
        api.setTab({ tagFilter: { ...f, mode: value as 'all' | 'any' | 'off' } });
        api.dispatch({ type: 'setStatus', msg: `filter mode: ${value}` });
      } else if (action === 'clear') {
        api.setTab({ tagFilter: { mode: 'off', ids: [] } });
        api.dispatch({ type: 'setStatus', msg: 'filter cleared' });
      }
      api.closeOverlay();
    },
  },
  {
    id: 'untag',
    availableInTaskMode: false,
    label: 'Untag',
    aliases: ['untag', 'remove tag', 'unpin', 'clear tag'],
    icon: '⊖',
    describe: (c) => {
      const n = folderTargets(c).length;
      return n === 0 ? 'Nothing to untag' : `Remove a tag from ${n} files in this folder`;
    },
    isAvailable: (c) => {
      const targets = folderTargets(c);
      if (targets.length === 0) return { ok: false, reason: 'Open a folder first' };
      const anyTagged = Object.values(c.tagPaths).some((paths) =>
        paths.some((p) => targets.includes(p)),
      );
      if (!anyTagged) return { ok: false, reason: 'No manual tags in this folder' };
      return { ok: true };
    },
    slots: [
      {
        label: 'Tag',
        getOptions: (c) => {
          const targets = folderTargets(c);
          return getAllTags(c.customTags)
            .map((t) => {
              const applied = c.tagPaths[t.id] ?? [];
              const hits = targets.filter((p) => applied.includes(p)).length;
              return {
                id: t.id,
                label: t.name,
                detail: `${hits} of ${targets.length} carry this tag`,
                available: hits > 0,
                reason: hits === 0 ? 'no files in this folder carry this tag' : undefined,
              };
            })
            .filter((o) => o.available);
        },
      },
    ],
    execute: (c, [tagId], api) => {
      const paths = folderTargets(c);
      if (paths.length === 0 || !tagId) return;
      api.dispatch({ type: 'untagPaths', id: tagId, paths });
      const tag = getAllTags(c.customTags).find((t) => t.id === tagId);
      api.dispatch({
        type: 'setStatus',
        msg: `untagged ${paths.length} files from ${tag?.name ?? tagId}`,
      });
      api.closeOverlay();
    },
  },
  {
    id: 'create',
    availableInTaskMode: false,
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
      if (kind === 'file') api.openTouch();
    },
  },
  {
    id: 'showHidden',
    availableInTaskMode: false,
    label: 'Show / Hide hidden files',
    aliases: ['hidden', 'dotfiles', 'show hidden', 'hide hidden', 'toggle hidden'],
    icon: '◐',
    describe: () => 'Toggle dotfile visibility (.DS_Store, .git, …)',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: () => {
      // No-op: toggle needs the current tab value, so the wrapper at the
      // call site handles it directly (see special case for showHidden).
    },
  },
  {
    id: 'theme',
    label: 'Theme',
    aliases: ['theme', 'palette', 'color', 'colour', 'restyle', 'skin', 'appearance'],
    icon: '◐',
    describe: () => 'Pick a palette',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (_c, _p, api) => {
      api.closeOverlay();
      window.dispatchEvent(new CustomEvent('fm:openTheme'));
    },
  },
  {
    id: 'welcome',
    label: 'Welcome',
    aliases: ['welcome', 'hello', 'intro-card', 'first-run', 'splash'],
    icon: '✦',
    describe: () => 'Re-open the welcome card (dismissed on first run)',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (_c, _p, api) => {
      api.closeOverlay();
      window.dispatchEvent(new CustomEvent('fm:openWelcome'));
    },
  },
  {
    id: 'settings',
    label: 'Settings',
    aliases: [
      'settings',
      'preferences',
      'prefs',
      'config',
      'options',
      'configure',
    ],
    icon: '⚙',
    describe: () => 'Open the settings dialog (keybinds, terminal, theme…)',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (_c, _p, api) => {
      api.closeOverlay();
      window.dispatchEvent(new CustomEvent('fm:openSettings'));
    },
  },
  {
    id: 'help',
    label: 'Help',
    aliases: ['help', 'tour', 'guide', 'how', 'how to', 'cheatsheet', 'verbs', 'docs', 'manual'],
    icon: '?',
    describe: () => 'Slide tour: value, verbs, and the full verb catalog',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (_c, _p, api) => {
      api.closeOverlay();
      window.dispatchEvent(new CustomEvent('fm:openHelp'));
    },
  },
  {
    id: 'tutorial',
    label: 'Tutorial',
    aliases: [
      'tutorial',
      'walkthrough',
      'practice',
      'learn',
      'teach',
      'lessons',
      'intro',
      'onboarding',
    ],
    icon: '◎',
    describe: () => 'Interactive walkthrough — try the basics step by step',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (_c, _p, api) => {
      api.closeOverlay();
      window.dispatchEvent(new CustomEvent('fm:openTutorial'));
    },
  },
  {
    id: 'tips',
    label: 'Tips',
    aliases: ['tips', 'tip', 'hints', 'hint'],
    icon: '✦',
    describe: () => 'Toggle the rotating tips chip',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (_c, _p, api) => {
      api.closeOverlay();
      window.dispatchEvent(new CustomEvent('fm:toggleTips'));
    },
  },
  {
    id: 'back',
    availableInTaskMode: false,
    label: 'Back',
    aliases: ['back', 'previous', 'undo navigation', 'history back', 'go back'],
    icon: '←',
    describe: () => 'Go to the previous folder in this tab',
    isAvailable: (c) =>
      c.historyLen > 0
        ? { ok: true }
        : { ok: false, reason: 'No previous folder in this tab' },
    slots: [],
    execute: (_c, _p, api) => {
      api.goBack();
      api.closeOverlay();
    },
  },
  {
    id: 'up',
    availableInTaskMode: false,
    label: 'Up',
    aliases: ['up', 'parent', 'go up', 'parent folder', 'enclosing folder', '..'],
    icon: '↑',
    describe: (c) => {
      const parent = dirname(c.cwd);
      return parent === c.cwd
        ? 'Already at the filesystem root'
        : `Go to ${basename(parent) || '/'}`;
    },
    isAvailable: (c) =>
      dirname(c.cwd) !== c.cwd
        ? { ok: true }
        : { ok: false, reason: 'Already at the filesystem root' },
    slots: [],
    execute: (c, _p, api) => {
      api.navigateTo(dirname(c.cwd));
      api.closeOverlay();
    },
  },
  {
    id: 'forward',
    availableInTaskMode: false,
    label: 'Forward',
    aliases: ['forward', 'redo navigation', 'history forward', 'go forward'],
    icon: '→',
    describe: () => 'Replay a back-step in this tab',
    isAvailable: (c) =>
      c.forwardLen > 0
        ? { ok: true }
        : { ok: false, reason: 'No forward step to replay' },
    slots: [],
    execute: (_c, _p, api) => {
      api.goForward();
      api.closeOverlay();
    },
  },
  {
    id: 'permissions',
    label: 'Permissions',
    aliases: ['permissions', 'permission', 'access', 'privacy', 'tcc', 'allow', 'grant'],
    icon: '⎕',
    describe: () => 'How to grant folder access in System Settings',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (_c, _p, api) => {
      api.closeOverlay();
      window.dispatchEvent(new CustomEvent('fm:openPrivacyHelp'));
    },
  },
  {
    id: 'upgrade',
    label: 'Upgrade',
    aliases: ['upgrade', 'update', 'brew upgrade', 'check for updates', 'new version'],
    icon: '↑',
    describe: () => 'Run brew upgrade --cask breezefile and relaunch',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (_c, _p, api) => {
      api.closeOverlay();
      api.dispatch({ type: 'setStatus', msg: 'Upgrading — the app will relaunch when done…' });
      void fm.upgrade();
    },
  },
  {
    id: 'compress',
    availableInTaskMode: false,
    label: 'Compress',
    aliases: ['compress', 'zip', 'archive'],
    icon: '🗜',
    describe: (c) => {
      const sources = implicitSources(c);
      if (sources.length === 0) return 'Zip selection or cursor item';
      if (sources.length === 1) return `Zip ${basename(sources[0])} → .zip`;
      return `Zip ${sources.length} items → Archive.zip`;
    },
    isAvailable: (c) => {
      if (c.markedPaths.length === 0 && !c.cursor) {
        return { ok: false, reason: 'Select files first or put the cursor on one' };
      }
      return { ok: true };
    },
    slots: [],
    execute: async (c, _p, api) => {
      const sources = implicitSources(c);
      if (sources.length === 0) return;
      api.dispatch({ type: 'setStatus', msg: `compressing ${sources.length} item${sources.length === 1 ? '' : 's'}…` });
      try {
        const dest = await fm.compress(sources, c.cwd);
        api.setTab({ marks: {} });
        await api.refreshActive();
        api.focusEntryByName(basename(dest));
        api.dispatch({
          type: 'setStatus',
          msg: `Compressed ${sources.length} item${sources.length === 1 ? '' : 's'} → ${basename(dest)}`,
        });
      } catch (err) {
        api.dispatch({ type: 'setStatus', msg: `compress failed: ${(err as Error).message}` });
      }
    },
  },
  {
    id: 'extract',
    availableInTaskMode: false,
    label: 'Extract',
    aliases: ['extract', 'unzip', 'unarchive'],
    icon: '📂',
    describe: (c) => {
      const sources = implicitSources(c);
      if (sources.length === 0) return 'Extract archive to sibling folder';
      if (sources.length === 1) return `Extract ${basename(sources[0])}`;
      return `Extract ${sources.length} archives`;
    },
    isAvailable: (c) => {
      const sources = implicitSources(c);
      if (sources.length === 0) return { ok: false, reason: 'Cursor on an archive first' };
      for (const p of sources) {
        if (!isArchivePath(p)) return { ok: false, reason: 'Cursor on an archive first' };
      }
      return { ok: true };
    },
    slots: [],
    execute: async (c, _p, api) => {
      const sources = implicitSources(c);
      if (sources.length === 0) return;
      api.dispatch({
        type: 'setStatus',
        msg: `extracting ${sources.length} archive${sources.length === 1 ? '' : 's'}…`,
      });
      try {
        const dests = await fm.extract(sources, c.cwd);
        api.setTab({ marks: {} });
        await api.refreshActive();
        // If the (first) destination is in this cwd, focus it. For multi-
        // select extracts the first hit is good enough; user can press 'n'
        // to cycle if needed. dmg mount points live under /Volumes and
        // won't match this cwd — that's fine, the status bar surfaces them.
        const first = dests[0];
        if (first && dirname(first) === c.cwd) {
          api.focusEntryByName(basename(first));
        }
        if (sources.length === 1) {
          // For .dmg the dest is the mount point under /Volumes.
          const single = dests[0] ?? '';
          const isMount = single.startsWith('/Volumes/');
          api.dispatch({
            type: 'setStatus',
            msg: isMount
              ? `Mounted → ${single}`
              : `Extracted → ${basename(single)}`,
          });
        } else {
          api.dispatch({
            type: 'setStatus',
            msg: `Extracted ${sources.length} archives`,
          });
        }
      } catch (err) {
        api.dispatch({ type: 'setStatus', msg: `extract failed: ${(err as Error).message}` });
      }
    },
  },
];

// Recognized archive extensions for the Extract verb's availability guard.
// Mirrors the format table in electron/ipc.ts `archiveKind` — keep in sync.
const ARCHIVE_EXTS = [
  '.zip',
  '.tar',
  '.tar.gz',
  '.tgz',
  '.tar.bz2',
  '.tbz2',
  '.tar.xz',
  '.txz',
  '.7z',
  '.rar',
  '.dmg',
];
// fm-g6r — turn each user launcher into a chip-prompt verb. Selecting it
// opens the embedded terminal pane (or focuses the existing one) and types
// the launcher's command + args, terminated with Enter so it runs in the
// user's current shell. We pipe through the shell rather than spawning the
// launcher directly so the user's PATH and aliases apply (e.g. `claude`
// installed via `npm i -g` resolves through nvm-shimmed PATH).
function synthesizeLauncherVerbs(
  launchers: import('../bridge').Launcher[],
): VerbDef[] {
  return launchers.map((l) => {
    const baseArgs = l.args ?? [];
    const baseCmdLine = [l.command, ...baseArgs].join(' ');
    const variants = l.variants ?? [];
    const hasVariants = variants.length > 0;

    // fm-e66 — when a launcher declares variants, the verb gains a "Mode"
    // slot. Bare is always first (so Enter at the picker = unmodified
    // command). Each option's detail surfaces a single-character shortcut
    // (the first letter of the label) — the chip-prompt's typing-to-filter
    // narrows on it, so "B / C / S"-style hints map to one keystroke.
    const modeOptions: Option[] = hasVariants
      ? [
          {
            id: '__bare__',
            label: 'Bare',
            detail: 'B · ' + baseCmdLine,
            available: true,
          },
          ...variants.map<Option>((v) => {
            const shortcut = (v.label[0] ?? v.id[0] ?? '?').toUpperCase();
            const fullCmd = [
              l.command,
              ...baseArgs,
              ...(v.args ?? []),
            ].join(' ');
            return {
              id: v.id,
              label: v.label,
              detail: `${shortcut} · ${v.description ?? fullCmd}`,
              available: true,
              aliases: v.args ?? [],
            };
          }),
        ]
      : [];

    return {
      id: ('launcher:' + l.id) as Verb,
      label: `Open ${l.label}`,
      aliases: l.aliases,
      icon: '⚡',
      describe: (c) =>
        c.activeTabHasTerminal
          ? `Run "${baseCmdLine}" in the terminal`
          : `Open terminal at ${basename(c.cwd) || '/'} and run "${baseCmdLine}"`,
      isAvailable: () => ({ ok: true }),
      slots: hasVariants
        ? [{ label: 'Mode', getOptions: () => modeOptions }]
        : [],
      execute: async (c, picks, api) => {
        const variantId = hasVariants ? picks[0] : undefined;
        // fm-mph — when active tab is a task tab, fetch its task and
        // pass through to invokeLauncher so the verb path matches the
        // TaskShell card path (env + sidecar + pre-typed context).
        // Folder tabs: task is null, no injection.
        const task = api.activeTabTaskId
          ? await fm.tasksGet(api.activeTabTaskId)
          : null;
        await invokeLauncher({
          launcher: l,
          variantId,
          task,
          cwd: c.cwd,
          sessionLabel: task?.title || basename(c.cwd) || c.cwd,
          existingPty: api.activeTabTerminal,
          onStatus: (msg) => api.dispatch({ type: 'setStatus', msg }),
          onPtyOpened: ({ ptyId, label, cwd }) =>
            api.dispatch({
              type: 'openTerminal',
              tabIndex: api.activeTabIndex,
              ptyId,
              cwd,
              label,
            }),
        });
        api.closeOverlay();
      },
    };
  });
}

function isArchivePath(p: string): boolean {
  const lower = p.toLowerCase();
  return ARCHIVE_EXTS.some((ext) => lower.endsWith(ext));
}

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

// fm-60k — tag/untag verbs always target every visible row in the current
// folder. We deliberately don't infer from marks / cursor / filter; the
// user's mental model is "this folder" and one consistent answer beats
// three with hidden precedence rules.
function folderTargets(c: Ctx): string[] {
  return c.entries.map((e) => e.path);
}

function destinationOptions(c: Ctx, includeCurrent = false, includeFiles = false): Option[] {
  const opts: Option[] = [];
  const seen = new Set<string>();
  const push = (o: Option) => {
    if (seen.has(o.id)) return;
    seen.add(o.id);
    opts.push(o);
  };

  // 1) Immediate subdirectories of cwd — most relevant for "go to a folder
  //    I can already see". `into X/` framing carries over from the move/copy
  //    flows where the action is "drop these into X".
  const cwdPrefix = c.cwd.endsWith('/') ? c.cwd : c.cwd + '/';
  const immediate = c.entries.filter((e) => e.kind === 'dir');
  for (const d of immediate) {
    push({
      id: d.path,
      label: d.name,
      detail: 'in this folder',
      available: true,
    });
  }

  // 2) Deeper descendants found via BFS (depth ~3). Calculate how many
  //    levels down each path is from cwd to give the user a rough sense of
  //    where they're going. Skip any that are already in the immediate set.
  for (const p of c.localSubdirs) {
    if (seen.has(p)) continue;
    const rel = p.startsWith(cwdPrefix) ? p.slice(cwdPrefix.length) : p;
    const depth = rel.split('/').length;
    push({
      id: p,
      label: basename(p) || p,
      detail: depth <= 1
        ? 'in this folder'
        : `${depth} levels down · ${rel}`,
      available: true,
    });
  }

  // 3) Recents
  for (const p of c.recents.slice(0, 8)) {
    push({
      id: p,
      label: basename(p) || p,
      detail: prettyPath(p, c.homedir) + '  ·  recent',
      available: true,
    });
  }

  // 4) Home-relative common folders
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

  // 5) Bookmarks
  for (const [key, path] of Object.entries(c.bookmarks)) {
    push({
      id: path,
      label: `'${key}  ${basename(path) || path}`,
      detail: prettyPath(path, c.homedir),
      available: true,
    });
  }

  // 6) Async Spotlight search results — last; demoted so a downstream `docs`
  //    folder beats a Spotlight hit on `Documentation`. The scorer preserves
  //    this order when scores tie.
  for (const p of c.searchResults) {
    push({
      id: p,
      label: basename(p) || p,
      detail: prettyPath(p, c.homedir) + '  ·  spotlight',
      available: true,
    });
  }
  // 7) File hits (goto only). Encoded with a `file:` prefix so resolveDestination
  //    and the goto execute can distinguish them from folder paths and route the
  //    pick to "navigate to parent + filter to query". Demoted below folder hits
  //    because in goto a folder match is usually the intent.
  if (includeFiles) {
    for (const f of c.searchFiles) {
      const id = `file:${f.path}`;
      if (seen.has(id)) continue;
      seen.add(id);
      opts.push({
        id,
        label: f.name,
        detail: prettyPath(dirnameOf(f.path), c.homedir) + '  ·  file',
        available: true,
      });
    }
  }
  return opts;
}

function dirnameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
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
export function ChipPrompt({
  onClose,
  initialFilter = '',
  initialVerbId = '',
}: {
  onClose: () => void;
  initialFilter?: string;
  initialVerbId?: string;
}) {
  const { state, dispatch, activeTab, setTab, refreshActive, navigateTo, goBack, goForward, focusEntryByName } = useStore();
  const [verb, setVerb] = useState<VerbDef | null>(
    () => VERBS.find((v) => v.id === initialVerbId) ?? null,
  );
  const [picks, setPicks] = useState<string[]>([]); // slot values
  const [filter, setFilter] = useState(initialFilter);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [homedir, setHomedir] = useState('');
  const [hoverReason, setHoverReason] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<string[]>([]);
  const [searchFiles, setSearchFiles] = useState<Array<{ path: string; name: string; isDir: boolean }>>([]);
  const [localSubdirs, setLocalSubdirs] = useState<string[]>([]);
  const [defaultTerminal, setDefaultTerminal] = useState<string | null>(null);
  const [installedTerminals, setInstalledTerminals] = useState<string[]>([]);
  const [launchers, setLaunchers] = useState<import('../bridge').Launcher[]>([]);
  const searchTokenRef = useRef(0); // guards against out-of-order resolves
  const subdirsTokenRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [openRename, setOpenRename] = useState<Entry | null>(null);

  useEffect(() => {
    void fm.homedir().then(setHomedir);
    // fm-2du: preload detected terminals + saved preference so the Open
    // Terminal verb can render its slot immediately without an async gap.
    void fm.getDefaultTerminal().then(setDefaultTerminal).catch(() => {});
    void fm.listTerminals().then(setInstalledTerminals).catch(() => {});
    // fm-g6r — preload the user's launcher list so :claude/:codex/:gemini
    // surface in the verb picker without a per-frame async fetch.
    void fm.launchersList().then(setLaunchers).catch(() => {});
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
      activeSlot?.label === 'Where' ||
      activeSlot?.label === 'Destination' ||
      activeSlot?.label === 'Which folder';
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

  // File search for the goto verb — surfaces files anywhere under $HOME so a
  // typed name jumps to the file's parent folder + filtered to it. Only fires
  // for the goto verb (move/copy/pin shouldn't accept a file as destination).
  const fileSearchTokenRef = useRef(0);
  useEffect(() => {
    const slotIdx = verb ? picks.length : -1;
    const activeSlot = verb && slotIdx < verb.slots.length ? verb.slots[slotIdx] : null;
    const isGotoSlot = verb?.id === 'goto' && activeSlot?.label === 'Where';
    if (!isGotoSlot || !homedir || filter.trim().length < 2) {
      setSearchFiles((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const token = ++fileSearchTokenRef.current;
    const query = filter.trim();
    const timer = window.setTimeout(() => {
      void fm.findEntries([homedir], query, 30).then((hits) => {
        if (fileSearchTokenRef.current !== token) return;
        // Files only — folders already come through findFolders / localSubdirs.
        const files = hits.filter((h) => !h.isDir);
        setSearchFiles(files);
      }).catch(() => {
        if (fileSearchTokenRef.current !== token) return;
        setSearchFiles((prev) => (prev.length === 0 ? prev : []));
      });
    }, 150);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, verb, picks.length, homedir]);

  // Load local descendants (BFS, depth ~3) when a destination slot is active.
  // Fires once per (verb, slot, cwd) — independent of the typed filter, so
  // the user sees deep folders the moment the slot opens. Out-of-order
  // resolves are dropped via a token guard.
  useEffect(() => {
    const slotIdx = verb ? picks.length : -1;
    const activeSlot = verb && slotIdx < verb.slots.length ? verb.slots[slotIdx] : null;
    const isDestinationSlot =
      activeSlot?.label === 'Where' ||
      activeSlot?.label === 'Destination' ||
      activeSlot?.label === 'Which folder';
    if (!isDestinationSlot || !activeTab) {
      setLocalSubdirs((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const cwd = activeTab.trail[lastCol(activeTab)];
    const token = ++subdirsTokenRef.current;
    void fm.listSubdirs(cwd, 3, 120).then((paths) => {
      if (subdirsTokenRef.current !== token) return;
      setLocalSubdirs(paths);
    }).catch(() => {
      if (subdirsTokenRef.current !== token) return;
      setLocalSubdirs((prev) => (prev.length === 0 ? prev : []));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verb, picks.length, activeTab]);

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
      pinned: state.pinned ?? [],
      tabs: state.tabs.map((t, i) => ({
        index: i,
        id: t.id,
        cwd: t.trail[t.trail.length - 1],
        label: basename(t.trail[t.trail.length - 1]) || '/',
        active: i === state.activeTab,
      })),
      canRestoreTab: !!state.lastClosedTab,
      searchResults,
      searchFiles,
      searchQuery: filter,
      localSubdirs,
      historyLen: activeTab.history.length,
      forwardLen: activeTab.forward.length,
      defaultTerminal,
      installedTerminals,
      activeTabHasTerminal: !!activeTab.terminal,
      launchers,
      customTags: state.customTags,
      tagPaths: state.tagPaths,
      tagFilter: activeTab.tagFilter,
    };
  }, [activeTab, state.entriesByPath, state.yank, state.bookmarks, state.recents, state.pinned, state.tabs, state.activeTab, state.lastClosedTab, homedir, searchResults, searchFiles, filter, localSubdirs, defaultTerminal, installedTerminals, launchers, state.customTags, state.tagPaths]);

  if (!activeTab || !ctx) return null;

  // Which slot is active: 0..slots.length = verb, slot1, slot2… ; length+1 = done
  const slotIdx = verb ? picks.length : -1;
  const activeSlot = verb && slotIdx < verb.slots.length ? verb.slots[slotIdx] : null;

  // fm-g6r — synthesize one VerbDef per user-configured launcher so they
  // surface alongside the static catalog. Each launcher opens (or focuses)
  // the embedded terminal pane and pipes the configured command in.
  // fm-22o — when task management is disabled, drop task-related verbs
  // from the catalog so they don't appear in the chip prompt.
  const tasksEnabled = state.taskManagementEnabled;
  // fm-a9j — when the active tab is a task tab, hide file-management
  // verbs so the prompt's verb list matches the shell's intent. The
  // `availableInTaskMode` flag defaults to true (omitted = visible);
  // file-management verbs opt out by setting it false.
  const inTaskMode = activeTab.kind === 'task';
  const effectiveVerbs: VerbDef[] = useMemo(
    () => {
      let base = tasksEnabled
        ? VERBS
        : VERBS.filter((v) => v.id !== 'task' && v.id !== 'tasks');
      if (inTaskMode) {
        base = base.filter((v) => v.availableInTaskMode !== false);
      }
      return [...base, ...synthesizeLauncherVerbs(launchers)];
    },
    [launchers, tasksEnabled, inTaskMode],
  );

  // Build options for current state
  const allOptions: Option[] =
    verb === null
      ? effectiveVerbs.map((v) => {
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
        // Verb-picker aliases come from the verb catalog; slot-option aliases
        // come from the option itself (e.g. 'type'/'kind'/'filetype' on the
        // 'By extension' sort option).
        const aliases = verb === null
          ? (effectiveVerbs.find((v) => v.id === o.id)?.aliases ?? []).map((a) => a.toLowerCase())
          : (o.aliases ?? []).map((a) => a.toLowerCase());
        const haystack = label + ' ' + detail + ' ' + aliases.join(' ');

        // Multi-token: require every token to appear in label, detail, or aliases.
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

        // Source tier bias: local children/descendants outrank recents,
        // bookmarks, and especially Spotlight when scores are otherwise
        // close. Read off the detail string we already author in
        // destinationOptions — keeps the scorer source-agnostic.
        if (detail.includes('in this folder')) score += 25;
        else if (detail.includes('levels down')) score += 20;
        else if (detail.includes('· spotlight')) score -= 15;

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

  // Natural-language fallthrough: when the user types something that doesn't
  // match any verb, drop into the 'Go to / Find' verb and treat the typed
  // text as the find query. This means typing a folder name (or any phrase)
  // from the normal view "just searches" — no verb needed.
  useEffect(() => {
    if (verb !== null) return;
    if (!filter) return;
    if (matches.length > 0) return;
    const goto = VERBS.find((v) => v.id === 'goto');
    if (!goto) return;
    setVerb(goto);
    setPicks([]);
    setHighlightIdx(0);
    // keep filter — it becomes the destination search query
  }, [filter, matches.length, verb]);

  function pickOption(opt: Option) {
    if (!opt.available) {
      setHoverReason(opt.reason ?? 'Not available right now');
      return;
    }
    if (verb === null) {
      const v = effectiveVerbs.find((x) => x.id === opt.id);
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
      // Special-case paste: need live yank from store. Mirrors PasteChip's
      // doPaste so the verb and the floating chip behave identically:
      // confirm before a destructive move; clear yank on copy success too,
      // since the user explicitly invoked Paste here.
      if (v.id === 'paste') {
        const cwd = safeCtx.cwd;
        const yank = state.yank;
        if (yank.length === 0) {
          dispatch({ type: 'setStatus', msg: 'nothing to paste' });
          onClose();
          return;
        }
        const finish = async () => {
          await runPaste({ yank, cwd, dispatch, refreshActive });
          if (yank[0].mode !== 'move') dispatch({ type: 'setYank', yank: [] });
          onClose();
        };
        if (yank[0].mode === 'move') {
          const names = yank.map((y) => basename(y.path));
          const head = names.slice(0, 5);
          const more = names.length > 5 ? names.length - 5 : 0;
          const detail = head.join(', ') + (more > 0 ? ` and ${more} more` : '');
          const fromDir = dirname(yank[0].path);
          const body = `From  ${fromDir}\n  →   ${cwd}\n\n${detail}`;
          window.dispatchEvent(
            new CustomEvent('fm:confirm', {
              detail: {
                title: `Move ${yank.length} item${yank.length === 1 ? '' : 's'}?`,
                body,
                confirmLabel: 'Move',
                destructive: false,
                confirmShortcuts: ['m'],
                onConfirm: finish,
              },
            }),
          );
          onClose();
          return;
        }
        await finish();
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
      let suppressClose = false;
      await v.execute(safeCtx, ps, {
        setTab,
        refreshActive,
        navigateTo,
        goBack,
        goForward,
        dispatch,
        activeTabIndex: state.activeTab,
        activeTabTerminal: safeTab.terminal
          ? { ptyId: safeTab.terminal.ptyId }
          : undefined,
        activeTabTaskId: safeTab.kind === 'task' ? (safeTab.taskId ?? null) : null,
        openRename: (e) => setOpenRename(e),
        openMkdir: () => {
          // Fire status and close; App.tsx owns the mkdir overlay — emit an event
          window.dispatchEvent(new CustomEvent('fm:openMkdir'));
          onClose();
        },
        openTouch: () => {
          window.dispatchEvent(new CustomEvent('fm:openTouch'));
          onClose();
        },
        focusEntryByName,
        closeOverlay: onClose,
        resetToVerbPick: (status) => {
          suppressClose = true;
          setVerb(null);
          setPicks([]);
          setFilter('');
          setHighlightIdx(0);
          if (status) dispatch({ type: 'setStatus', msg: status });
        },
      });
      if (suppressClose) return;
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
      e.stopPropagation();
      // Native event would otherwise keep bubbling to window after we
      // unmount and the next overlay (ThemePicker, etc.) mounts —
      // catching its freshly-attached listener and immediately
      // re-triggering an action there.
      (e.nativeEvent as KeyboardEvent).stopImmediatePropagation?.();
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
            {verb === null ? 'SELECT ACTION' : activeSlot?.label.toUpperCase() ?? ''}
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
