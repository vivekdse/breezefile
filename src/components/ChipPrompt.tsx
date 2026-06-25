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
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import type { CustomTag, Entry, SortKey, TabKind, TagFilter, TagPaths } from '../types';
import { getAllTags } from '../tags';
import { summarizeNames as summarizeNamesNode } from './ConfirmDialog';
import { loadSideBySidePrefs, splitFraction } from '../sideBySidePrefs';
import { formatOpError } from '../errorMessages';
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
  recentFiles: string[];
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
  // ssh targets from active sshfs mounts — drives the remote-attach verb.
  remoteTargets: string[];
  // currently-connected remote sources — drives the :disconnect verb.
  connectedSources: string[];
  // fm-jtu — does the active tab already have an embedded terminal pane?
  activeTabHasTerminal: boolean;
  // fm-jtu — the active tab's terminal handle (when present), so verbs
  // like closeTab can kill the pty before the tab is removed.
  activeTabTerminal?: { ptyId: number };
  // fm-g6r — user-editable launcher list (claude/codex/gemini, …).
  launchers: import('../bridge').Launcher[];
  // fm-60k — tag state surfaced to the chip palette so the tag/untag/newtag
  // verbs can compose options without reaching back into the store.
  customTags: CustomTag[];
  tagPaths: TagPaths;
  // The active tab's combination filter — when on, tagTargets() falls back
  // to the filtered-visible set instead of just the focused row.
  tagFilter: TagFilter;
  // fm-yi85 — kind of the active tab. Drives the verb-availability gate
  // (file verbs hidden on tasks tab; tasks verbs hidden on folder tabs);
  // also lets the synthesized launcher verbs route into bulk-on-selection
  // mode when the user is on the Tasks tab.
  activeTabKind: TabKind;
  // fm-k9dg — current "directories first" state of the active tab,
  // surfaced so the foldersFirst verb's describe text reads true.
  activeTabFoldersFirst: boolean;
};

type Verb =
  | 'select'
  | 'move'
  | 'copy'
  | 'paste'
  | 'sort'
  | 'delete'
  | 'permanent-delete'
  | 'rename'
  | 'open'
  | 'goto'
  | 'view'
  | 'create'
  | 'reveal'
  | 'share'
  | 'showHidden'
  | 'foldersFirst'
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
  | 'edit'
  | 'open-editor'
  | 'editor-save'
  | 'editor-revert'
  | 'editor-close'
  | 'openTerminal'
  | 'term'
  | 'term-close'
  | 'chat'
  | 'remote-attach'
  | 'disconnect'
  | 'newtag'
  | 'tag'
  | 'untag'
  | 'run'
  | 'filter'
  | 'help'
  | 'secrets'
  | 'maximize'
  | 'fullscreen'
  | 'welcome'
  | 'task'
  | 'tasks'
  | 'sidebyside'
  | 'settings'
  | 'note'
  | 'notes';

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
  // In the verb-picker (verb=null) state, options can be either real verbs
  // OR live folder/file results merged in from Spotlight. We tag them so the
  // renderer can style them differently and pickOption can dispatch correctly
  // (verb → enter slots; find → navigate or open).
  kind?: 'verb' | 'find-folder' | 'find-file';
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
  // fm-yi85 — restrict a verb to specific tab kinds. Absent = visible on
  // folder tabs (subject to availableInTaskMode for task tabs); present =
  // verb is ONLY available when the active tab kind is in this set. Used
  // by the tasks-overview tab to keep file verbs out of the prompt and
  // gate the new task-bulk verbs (:done, :due, :open, …) on the right
  // surface.
  tabKinds?: TabKind[];
};

type SlotDef = {
  label: string; // "What", "Where", "How", "By", "Direction"
  getOptions: (ctx: Ctx, prev: string[]) => Option[];
  // fm-7d86 — multi-select slot (e.g. AI launcher flags). Space toggles
  // the highlighted option, Enter commits the joined ids (comma-separated)
  // as the slot value. Empty selection commits as ''. Single-pick stays
  // the default to keep destination/mode slots behaving as before.
  multi?: boolean;
};

type ExecApi = {
  setTab: (patch: any) => void;
  /** fm-k9dg — sticky setter: writes the patch to the tab AND records
   *  the chosen sort/view/hidden/foldersFirst as the per-folder pref. */
  setTabSticky: (patch: any) => void;
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
    // fm-958a — give move the full goto/find destination picker: ancestors
    // (parent folders), descendants, recents, bookmarks, common dirs, the
    // current folder, and live Spotlight folder hits. Previously this passed
    // no flags, so parent folders weren't first-class candidates and the
    // current folder couldn't be chosen. `includeFiles` stays off — a file
    // is never a valid move destination — but folder sourcing is now
    // identical to goto's `destinationOptions(c, true, true)`.
    slots: [{ label: 'Where', getOptions: (c) => destinationOptions(c, true) }],
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
    // fm-958a — match Move: full goto-style folder picker (parents included).
    slots: [{ label: 'Where', getOptions: (c) => destinationOptions(c, true) }],
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
      api.setTabSticky({ sortKey: key as SortKey, sortReverse: dir === 'desc' });
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
                  msg: formatOpError('trash', err),
                });
              }
            },
          },
        }),
      );
    },
  },
  {
    // fm-7klh — irreversible delete, no Trash. Deliberately harder to reach
    // than :delete: no chord, palette-only, and a typed "delete N" phrase
    // (GitHub repo-delete pattern) before the confirm button enables.
    id: 'permanent-delete',
    availableInTaskMode: false,
    label: 'Delete permanently',
    aliases: ['permanent-delete', 'delete-forever', 'destroy', 'shred'],
    icon: '⨯',
    describe: (c) =>
      c.markedPaths.length > 0
        ? `Permanently delete ${c.markedPaths.length} item${c.markedPaths.length === 1 ? '' : 's'} (no Trash)`
        : `Permanently delete ${c.cursor?.name ?? 'item'} (no Trash)`,
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
            title: 'Permanently delete?',
            body: (
              <>
                <div>
                  Permanently delete {noun}. This bypasses the Trash and{' '}
                  <strong>cannot be undone</strong>.
                </div>
                {sources.length > 1 && summarizeNamesNode(names)}
              </>
            ),
            confirmLabel: 'Delete permanently',
            destructive: true,
            requireType: `delete ${sources.length}`,
            onConfirm: async () => {
              try {
                await fm.permanentDelete(sources);
                api.setTab({ marks: {} });
                await api.refreshActive();
                api.dispatch({
                  type: 'setStatus',
                  msg: `permanently deleted ${sources.length} item${sources.length === 1 ? '' : 's'}`,
                });
              } catch (err) {
                api.dispatch({
                  type: 'setStatus',
                  msg: formatOpError('delete', err),
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
    describe: () => 'Go to or find a folder or file (file picks open the file)',
    isAvailable: () => ({ ok: true }),
    slots: [{ label: 'Where', getOptions: (c) => destinationOptions(c, true, true) }],
    execute: (c, [dest], api) => {
      // File pick: open the file with its default app. Previously this
      // navigated to the parent folder + applied a filter chip, but in
      // practice when the user finds a specific file they want it open,
      // not its enclosing folder narrowed.
      if (dest.startsWith('file:')) {
        const filePath = dest.slice('file:'.length);
        const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
        if (ext === 'md' || ext === 'mdx') {
          api.dispatch({ type: 'openEditTab', path: filePath, focus: true });
        } else {
          api.dispatch({ type: 'pushRecentFile', path: filePath });
          void fm.open(filePath);
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
          foldersFirst: true,
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
      if (!active) return;
      if (c.activeTabTerminal) {
        void fm.termKill(c.activeTabTerminal.ptyId).catch(() => {});
      }
      api.dispatch({ type: 'closeTab', index: active.index });
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
        api.dispatch({ type: 'pushRecentFile', path: c.cursor.path });
        void fm.open(c.cursor.path);
        api.closeOverlay();
      }
    },
  },
  {
    id: 'edit',
    availableInTaskMode: false,
    label: 'Edit',
    aliases: ['edit', 'e', 'edit-file'],
    icon: '✎',
    describe: (c) =>
      `Edit ${c.cursor?.name ?? 'item'} in a new tab (markdown formatted, others plain)`,
    isAvailable: (c) => {
      if (!c.cursor) return { ok: false, reason: 'Put the cursor on a file first' };
      if (c.cursor.kind === 'dir') return { ok: false, reason: 'Edit needs a file, not a folder' };
      return { ok: true };
    },
    slots: [],
    // fm-vu55 — open the cursor's file in a new in-app edit tab. Markdown
    // renders via Milkdown (WYSIWYM); other text uses a plain editor.
    execute: (c, _p, api) => {
      if (!c.cursor) return;
      api.dispatch({ type: 'openEditTab', path: c.cursor.path });
      api.closeOverlay();
    },
  },
  {
    // fm-xpk7 — explicit "open in the in-app editor" override. Same effect as
    // :edit, but framed as a deliberate bypass of default-app routing (e.g.
    // a .json you'd normally open in your IDE).
    id: 'open-editor',
    availableInTaskMode: false,
    label: 'Open in editor',
    aliases: ['open-editor', 'edit-here', 'edit-in-app'],
    icon: '✎',
    describe: (c) =>
      `Open ${c.cursor?.name ?? 'item'} in the in-app editor (override default app)`,
    isAvailable: (c) => {
      if (!c.cursor) return { ok: false, reason: 'Put the cursor on a file first' };
      if (c.cursor.kind === 'dir') return { ok: false, reason: 'Needs a file, not a folder' };
      return { ok: true };
    },
    slots: [],
    execute: (c, _p, api) => {
      if (!c.cursor) return;
      api.dispatch({ type: 'openEditTab', path: c.cursor.path });
      api.closeOverlay();
    },
  },
  {
    // fm-xpk7 — save the active edit tab (⌘S equivalent). The active
    // EditShell owns doSave; we signal it via a window event.
    id: 'editor-save',
    availableInTaskMode: false,
    label: 'Save',
    aliases: ['save', 'w', 'write'],
    icon: '💾',
    describe: () => 'Save the current file to disk',
    isAvailable: (c) =>
      c.activeTabKind === 'edit'
        ? { ok: true }
        : { ok: false, reason: 'Only on an edit tab — open one with :edit' },
    slots: [],
    execute: (_c, _p, api) => {
      window.dispatchEvent(new CustomEvent('fm:editor-save'));
      api.closeOverlay();
    },
  },
  {
    // fm-xpk7 — discard unsaved edits and re-read from disk. EditShell prompts
    // first when the buffer is dirty.
    id: 'editor-revert',
    availableInTaskMode: false,
    label: 'Revert to disk',
    aliases: ['revert', 'revert-to-disk', 'discard-changes'],
    icon: '↺',
    describe: () => 'Discard unsaved changes and reload from disk',
    isAvailable: (c) =>
      c.activeTabKind === 'edit'
        ? { ok: true }
        : { ok: false, reason: 'Only on an edit tab — open one with :edit' },
    slots: [],
    execute: (_c, _p, api) => {
      window.dispatchEvent(new CustomEvent('fm:editor-revert'));
      api.closeOverlay();
    },
  },
  {
    // fm-xpk7 — close the active edit tab. EditShell warns when dirty.
    id: 'editor-close',
    availableInTaskMode: false,
    label: 'Close edit tab',
    aliases: ['close', 'close-edit', 'close-tab'],
    icon: '✕',
    describe: () => 'Close the current edit tab (warns if unsaved)',
    isAvailable: (c) =>
      c.activeTabKind === 'edit'
        ? { ok: true }
        : { ok: false, reason: 'Only on an edit tab' },
    slots: [],
    execute: (_c, _p, api) => {
      window.dispatchEvent(new CustomEvent('fm:editor-close'));
      api.closeOverlay();
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
          msg: formatOpError('terminal', err),
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
          msg: formatOpError('terminal', err),
        });
      }
      api.closeOverlay();
    },
  },
  {
    // Connect a host from an active sshfs mount as a task source. The
    // app installs/starts breezed there (persistent systemd --user
    // service) and opens a forward ssh tunnel; that machine's tasks then
    // appear under their own "<host>" section. No terminal, no sync —
    // the host owns and runs its own tasks. Disconnect from the sidebar.
    id: 'remote-attach',
    label: 'Connect host (TypeBuild tasks from a remote)',
    aliases: ['remote-attach', 'attach', 'remote', 'connect', 'ssh-attach'],
    icon: '⇄',
    describe: (c) =>
      c.remoteTargets.length
        ? 'Connect a mounted host as a task source'
        : 'No active sshfs mounts — mount a remote first',
    isAvailable: (c) =>
      c.remoteTargets.length
        ? { ok: true }
        : { ok: false, reason: 'No active sshfs mounts to connect' },
    slots: [
      {
        label: 'Host',
        getOptions: (c) =>
          c.remoteTargets.map((t) => ({
            id: t,
            label: t,
            detail: 'ssh target from an active sshfs mount',
            available: true,
          })),
      },
    ],
    execute: async (_c, [target], api) => {
      if (!target) {
        api.dispatch({ type: 'setStatus', msg: 'no host selected' });
        api.closeOverlay();
        return;
      }
      api.dispatch({ type: 'setStatus', msg: `connecting ${target}…` });
      api.closeOverlay();
      // Fire-and-forget: install+tunnel can take a few seconds; the
      // sidebar shows a "connecting" entry and flips to connected via
      // the sources:changed broadcast.
      fm.sourcesConnect(target).catch((err: unknown) =>
        api.dispatch({
          type: 'setStatus',
          msg: formatOpError('connect', err),
        }),
      );
    },
  },
  {
    // Disconnect a connected remote task source. Host slot is the list
    // of currently-connected sources (mirrors the sidebar × action).
    id: 'disconnect',
    label: 'Disconnect host (remote task source)',
    aliases: ['disconnect', 'detach', 'unmount-source', 'drop-host'],
    icon: '⊘',
    describe: (c) =>
      c.connectedSources.length
        ? 'Disconnect a connected remote task source'
        : 'No connected remote hosts',
    isAvailable: (c) =>
      c.connectedSources.length
        ? { ok: true }
        : { ok: false, reason: 'No connected remote hosts to disconnect' },
    slots: [
      {
        label: 'Host',
        getOptions: (c) =>
          c.connectedSources.map((h) => ({
            id: h,
            label: h,
            detail: 'connected remote task source',
            available: true,
          })),
      },
    ],
    execute: async (_c, [host], api) => {
      if (!host) {
        api.dispatch({ type: 'setStatus', msg: 'no host selected' });
        api.closeOverlay();
        return;
      }
      api.dispatch({ type: 'setStatus', msg: `disconnecting ${host}…` });
      api.closeOverlay();
      fm.sourcesDisconnect(host).catch((err: unknown) =>
        api.dispatch({
          type: 'setStatus',
          msg: formatOpError('disconnect', err),
        }),
      );
    },
  },
  {
    // fm-dly3 — toggle the agent chat side-panel. App owns the open/close +
    // folder-vs-document target; we just fire the event. Available on folder
    // and edit tabs (where there's a folder or document to put in context).
    id: 'chat',
    label: 'Chat with this folder / document',
    aliases: ['chat', 'ask', 'agent', 'claude-chat', 'gemini'],
    icon: '💬',
    describe: (c) =>
      c.activeTabKind === 'edit'
        ? 'Open an agent chat with this document in context'
        : `Open an agent chat in ${basename(c.cwd) || '/'}`,
    isAvailable: (c) =>
      c.activeTabKind === 'folder' || c.activeTabKind === 'edit'
        ? { ok: true }
        : { ok: false, reason: 'Chat works on a folder or a document tab' },
    slots: [],
    execute: (_c, _p, api) => {
      window.dispatchEvent(new CustomEvent('fm:toggle-chat'));
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
      api.setTabSticky({ viewMode: mode as 'list' | 'grid' | 'preview' | 'tag' });
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
    // fm-b5at.6 — toggle the TypeBuild side-by-side layout: Chrome left,
    // Breezefile right (restores previous bounds on toggle-off). App-level
    // verb (no file/tab scope). Own-window arrangement always works; Chrome
    // moves opportunistically — degraded parity on Wayland / missing
    // Accessibility, so the verb stays usable rather than hidden.
    id: 'sidebyside',
    label: 'Side-by-side (Chrome left / here right)',
    aliases: ['sidebyside', 'side by side', 'split', 'chrome', 'typebuild layout', 'arrange'],
    icon: '◧',
    describe: () => 'Toggle Chrome-left / TypeBuild-right side-by-side layout',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (_c, _p, api) => {
      api.closeOverlay();
      const split = splitFraction(loadSideBySidePrefs());
      void fm.sideBySide.toggle(split).then(
        (res) => {
          if (!res.active) {
            api.dispatch({ type: 'setStatus', msg: 'side-by-side off · window restored' });
            return;
          }
          const c = res.chrome;
          if (c?.ok) {
            api.dispatch({ type: 'setStatus', msg: 'side-by-side on · Chrome left' });
          } else if (c?.reason === 'no-permission') {
            api.dispatch({ type: 'setStatus', msg: 'window snapped — grant Accessibility to also move Chrome (Settings → TypeBuild)' });
          } else {
            api.dispatch({ type: 'setStatus', msg: 'window snapped right — snap Chrome to the left manually' });
          }
        },
        (err: unknown) => api.dispatch({ type: 'setStatus', msg: formatOpError('arrange', err) }),
      );
    },
  },
  {
    id: 'run',
    label: 'Run a task',
    aliases: ['run', 'run task', 'run a task', 'play'],
    icon: '▸',
    describe: (c) => `Pick a task to run in ${basename(c.cwd) || '/'}`,
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (c, _p, api) => {
      api.closeOverlay();
      window.dispatchEvent(
        new CustomEvent('fm:openRunTask', { detail: { cwd: c.cwd } }),
      );
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
    aliases: [
      'create', 'new', 'mkdir', 'touch',
      'new file', 'new folder', 'create file', 'create folder',
      'add file', 'add folder', 'make file', 'make folder',
    ],
    icon: '+',
    describe: () => 'Create new…',
    isAvailable: () => ({ ok: true }),
    slots: [
      {
        label: 'Type',
        getOptions: () => [
          { id: 'folder', label: 'Folder', detail: 'new directory', available: true, aliases: ['new folder', 'mkdir', 'directory', 'dir'] },
          { id: 'file', label: 'File', detail: 'empty file', available: true, aliases: ['new file', 'touch', 'document', 'doc'] },
        ],
      },
    ],
    execute: (_c, [kind], api) => {
      if (kind === 'folder') api.openMkdir();
      if (kind === 'file') api.openTouch();
    },
  },
  // ── Notes (fm-notes) ──────────────────────────────────────────────
  // `:note` creates a new markdown file in ~/.breezefile/breeze notes/
  // named YYYY-MM-DD-N.md (N = next available for today) and opens it
  // for editing. The point is to capture the thought first; the file
  // gets a meaningful name later — either by typing into the title or
  // by the on-save heading-rename in EditShell. `:notes` jumps to the
  // notes folder so the user can browse everything they've jotted.
  {
    id: 'note',
    availableInTaskMode: true,
    label: 'New note',
    aliases: ['note', 'new note', 'newnote', 'jot', 'scratch'],
    icon: '✎',
    describe: () => 'Create a new note (markdown, date-named)',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: async (c, _picks, api) => {
      try {
        const dir = await ensureNotesDir(c.homedir);
        const filePath = await nextNotePath(dir);
        await fm.touch(filePath);
        // Seed the file with an empty `# ` so the editor opens on a title
        // line the user can fill in. EditShell uses the presence of the
        // heading on save to derive the filename — until the user types
        // something after `# `, the slug is empty and the rename is a
        // no-op, so this stays invisible.
        await fm.editorSave(filePath, '# \n', null);
        api.dispatch({ type: 'openEditTab', path: filePath, focus: true });
        api.dispatch({ type: 'pushRecentFile', path: filePath });
      } catch (err) {
        api.dispatch({
          type: 'setStatus',
          msg: `new note failed: ${(err as Error).message ?? String(err)}`,
        });
      }
    },
  },
  {
    id: 'notes',
    availableInTaskMode: true,
    label: 'Notes folder',
    aliases: ['notes', 'all notes', 'browse notes', 'goto notes', 'show notes', 'open notes'],
    icon: '📓',
    describe: () => 'Open the breeze notes folder',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: async (c, _picks, api) => {
      try {
        const dir = await ensureNotesDir(c.homedir);
        api.navigateTo(dir);
      } catch (err) {
        api.dispatch({
          type: 'setStatus',
          msg: `open notes failed: ${(err as Error).message ?? String(err)}`,
        });
      }
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
    // fm-k9dg — toggle "directories first". Default ON (traditional);
    // turning off lets newest-first really mean newest-first in folders
    // like Downloads where folders crowd the top. Choice is remembered
    // per folder along with sort/view/hidden.
    id: 'foldersFirst',
    availableInTaskMode: false,
    label: 'Folders first / Mixed',
    aliases: [
      'folders first', 'directories first', 'dirs first', 'group folders',
      'mixed', 'interleave', 'no group', 'unmix folders',
    ],
    icon: '◐',
    describe: (c) =>
      c.activeTabFoldersFirst
        ? 'Stop pinning folders to the top — sort by chosen key only'
        : 'Pin folders to the top of the listing (traditional)',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: () => {
      // Toggle handled at call site (needs current tab value).
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
    id: 'maximize',
    label: 'Maximize window',
    aliases: ['maximize', 'maximise', 'max', 'unmaximize', 'restore', 'window'],
    icon: '⛶',
    describe: () => 'Toggle window maximize (works around WM Alt+Space conflicts)',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (_c, _p, api) => {
      api.closeOverlay();
      void fm.windowToggleMaximize();
    },
  },
  {
    id: 'fullscreen',
    label: 'Fullscreen',
    aliases: ['fullscreen', 'full-screen', 'fs', 'full'],
    icon: '⤢',
    describe: () => 'Toggle fullscreen',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (_c, _p, api) => {
      api.closeOverlay();
      void fm.windowToggleFullscreen();
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
    id: 'secrets',
    label: 'Secrets',
    aliases: ['secrets', 'secret', 'vault', 'credentials', 'credential', 'npi', 'identifiers', 'me'],
    icon: '🔑',
    describe: () => 'Manage your saved credentials (NPI, Tax ID, login IDs) the agent fills into forms',
    isAvailable: () => ({ ok: true }),
    slots: [],
    execute: (_c, _p, api) => {
      api.closeOverlay();
      window.dispatchEvent(new CustomEvent('fm:openSecrets'));
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
        api.dispatch({ type: 'setStatus', msg: formatOpError('compress', err) });
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
        api.dispatch({ type: 'setStatus', msg: formatOpError('extract', err) });
      }
    },
  },
  // ──────────────────────────────────────────────────────────────────────
  // fm-yi85 — Tasks-tab verbs. All gated by tabKinds: ['tasks'] so they
  // appear only when the user is on the singleton Tasks overview tab.
  // The actual mutation runs in TasksPage's window-event listeners — these
  // verbs are thin dispatchers that fire fm:tasks:* events with a payload.
  // Why event-based rather than a shared store slice: TasksPage owns the
  // selection / cursor / filter state local to itself; verbs shouldn't
  // need to crawl that state to act, just say "do X to whatever's
  // selected" and let the page resolve it.
  // ──────────────────────────────────────────────────────────────────────
  ...buildTaskVerbs(),
];

function buildTaskVerbs(): VerbDef[] {
  const fire = (name: string, detail?: unknown) =>
    window.dispatchEvent(new CustomEvent(name, { detail }));

  function dateOptions(): Option[] {
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);
    const friday = new Date();
    friday.setDate(today.getDate() + ((5 - today.getDay() + 7) % 7 || 7));
    const nextWeek = new Date();
    nextWeek.setDate(today.getDate() + 7);
    const nextMonth = new Date();
    nextMonth.setMonth(today.getMonth() + 1);
    return [
      { id: iso(today), label: 'Today', detail: iso(today), available: true },
      { id: iso(tomorrow), label: 'Tomorrow', detail: iso(tomorrow), available: true },
      { id: iso(friday), label: 'Friday', detail: iso(friday), available: true },
      { id: iso(nextWeek), label: 'Next week', detail: iso(nextWeek), available: true },
      { id: iso(nextMonth), label: 'Next month', detail: iso(nextMonth), available: true },
      { id: '__pick__', label: 'Pick a date…', detail: 'opens inline date picker', available: true },
      { id: '', label: 'Clear', detail: 'unset', available: true },
    ];
  }

  return [
    {
      id: 'done' as Verb,
      label: 'Mark done',
      aliases: ['done', 'complete', 'finish', 'close'],
      icon: '✓',
      describe: () => 'Mark selected tasks as done',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [],
      execute: (_c, _p, api) => {
        fire('fm:tasks:done');
        api.closeOverlay();
      },
    },
    {
      id: 'reopen' as Verb,
      label: 'Reopen',
      aliases: ['reopen', 'pending', 'undone'],
      icon: '↺',
      describe: () => 'Set selected tasks back to pending',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [],
      execute: (_c, _p, api) => {
        fire('fm:tasks:reopen');
        api.closeOverlay();
      },
    },
    {
      id: 'in-progress' as Verb,
      label: 'In progress',
      aliases: ['in-progress', 'doing', 'start-work', 'wip', 'active'],
      icon: '◐',
      describe: () => 'Mark selected tasks in progress',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [],
      execute: (_c, _p, api) => {
        fire('fm:tasks:in-progress');
        api.closeOverlay();
      },
    },
    {
      id: 'cancel' as Verb,
      label: 'Cancel task',
      aliases: ['cancel', 'cancelled', 'abandon', 'drop'],
      icon: '⊘',
      describe: () => 'Mark selected tasks cancelled',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [],
      execute: (_c, _p, api) => {
        fire('fm:tasks:cancel');
        api.closeOverlay();
      },
    },
    {
      id: 'pin-task' as Verb,
      label: 'Pin task',
      aliases: ['pin', 'pin-task', 'star'],
      icon: '★',
      describe: () => 'Pin selected tasks',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [],
      execute: (_c, _p, api) => {
        fire('fm:tasks:pin');
        api.closeOverlay();
      },
    },
    {
      id: 'unpin-task' as Verb,
      label: 'Unpin task',
      aliases: ['unpin', 'unpin-task', 'unstar'],
      icon: '☆',
      describe: () => 'Unpin selected tasks',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [],
      execute: (_c, _p, api) => {
        fire('fm:tasks:unpin');
        api.closeOverlay();
      },
    },
    {
      id: 'due' as Verb,
      label: 'Set due',
      aliases: ['due', 'due-date', 'when'],
      icon: '⏰',
      describe: () => 'Set due date on selected tasks',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [{ label: 'When', getOptions: () => dateOptions() }],
      execute: (_c, [pick], api) => {
        if (pick === '__pick__') fire('fm:tasks:due');
        else fire('fm:tasks:due', { value: pick });
        api.closeOverlay();
      },
    },
    {
      id: 'start' as Verb,
      label: 'Set start',
      aliases: ['start', 'start-date', 'snooze'],
      icon: '▶',
      describe: () => 'Set start date on selected tasks',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [{ label: 'When', getOptions: () => dateOptions() }],
      execute: (_c, [pick], api) => {
        if (pick === '__pick__') fire('fm:tasks:start');
        else fire('fm:tasks:start', { value: pick });
        api.closeOverlay();
      },
    },
    {
      id: 'delete-task' as Verb,
      label: 'Delete task',
      aliases: ['delete', 'remove', 'rm', 'trash'],
      icon: '⌫',
      describe: () => 'Delete selected tasks (confirms)',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [],
      execute: (_c, _p, api) => {
        fire('fm:tasks:delete');
        api.closeOverlay();
      },
    },
    {
      id: 'open-task' as Verb,
      label: 'Open task',
      aliases: ['open', 'open-task', 'tab', 'go'],
      icon: '↗',
      describe: () => 'Open selected tasks in their own task tabs',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [],
      execute: (_c, _p, api) => {
        fire('fm:tasks:open');
        api.closeOverlay();
      },
    },
    {
      id: 'terminal-tasks' as Verb,
      label: 'Open terminal',
      aliases: ['terminal', 'term', 'shell'],
      icon: '$_',
      describe: () => 'Open a terminal in each selected task’s folder',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [],
      execute: (_c, _p, api) => {
        fire('fm:tasks:terminal');
        api.closeOverlay();
      },
    },
    // fm-7909 — the :group verb is retired. Tasks are organized by owner
    // (FOR YOU / FOR AGENTS / DONE) now; there's no grouping selector.
    {
      id: 'sort-tasks' as Verb,
      label: 'Sort tasks',
      aliases: ['sort', 'sortby', 'order'],
      icon: '⇅',
      describe: () => 'Sort the task list',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [
        {
          label: 'By',
          getOptions: () => [
            { id: 'due', label: 'Due ↑', detail: 'soonest first', available: true },
            { id: 'start', label: 'Start ↑', detail: 'soonest first', available: true },
            { id: 'created', label: 'Created ↓', detail: 'newest first', available: true },
            { id: 'alpha', label: 'Title A→Z', detail: 'alphabetical', available: true },
          ],
        },
      ],
      execute: (_c, [v], api) => {
        fire('fm:tasks:sort', { value: v });
        api.closeOverlay();
      },
    },
    {
      id: 'filter-tasks' as Verb,
      label: 'Filter tasks',
      aliases: ['filter', 'view', 'narrow'],
      icon: '⌖',
      describe: () => 'Narrow the task list to a derived view',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [
        {
          label: 'View',
          getOptions: () => [
            { id: 'all', label: 'All', detail: 'no derived filter', available: true },
            { id: 'this_week', label: 'Due this week', detail: 'due_at within 7 days', available: true },
            { id: 'overdue', label: 'Overdue', detail: 'past due, not done', available: true },
            { id: 'scheduled', label: 'Scheduled', detail: 'start_at in the future', available: true },
          ],
        },
      ],
      execute: (_c, [v], api) => {
        fire('fm:tasks:filter', { value: v });
        api.closeOverlay();
      },
    },
    {
      id: 'show-completed' as Verb,
      label: 'Show completed',
      aliases: ['show-completed', 'show-done', 'include-done'],
      icon: '👁',
      describe: () => 'Include done and cancelled tasks',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [],
      execute: (_c, _p, api) => {
        fire('fm:tasks:show-completed');
        api.closeOverlay();
      },
    },
    {
      id: 'hide-completed' as Verb,
      label: 'Hide completed',
      aliases: ['hide-completed', 'hide-done', 'exclude-done'],
      icon: '⊝',
      describe: () => 'Exclude done and cancelled tasks',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [],
      execute: (_c, _p, api) => {
        fire('fm:tasks:hide-completed');
        api.closeOverlay();
      },
    },
    {
      id: 'edit-task' as Verb,
      label: 'Edit task',
      aliases: ['edit', 'edit-task', 'rename', 'modify'],
      icon: '✎',
      describe: () => 'Edit the cursor task (or first selected)',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [],
      execute: (_c, _p, api) => {
        fire('fm:tasks:edit');
        api.closeOverlay();
      },
    },
    {
      id: 'goto-folder' as Verb,
      label: 'Go to folder',
      aliases: ['goto-folder', 'goto', 'cd', 'folder', 'browse'],
      icon: '📂',
      describe: () => 'Open each selected task’s folder in a new tab',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [],
      execute: (_c, _p, api) => {
        fire('fm:tasks:goto-folder');
        api.closeOverlay();
      },
    },
    {
      id: 'select-tasks' as Verb,
      label: 'Select',
      aliases: ['select', 'pick', 'mark'],
      icon: '☑',
      describe: () => 'Select a subset of visible tasks',
      isAvailable: () => ({ ok: true }),
      tabKinds: ['tasks'],
      slots: [
        {
          label: 'What',
          getOptions: () => [
            { id: 'all', label: 'All', detail: 'every visible task', available: true },
            { id: 'none', label: 'None', detail: 'clear selection', available: true },
            { id: 'invert', label: 'Invert', detail: 'flip every selection', available: true },
            { id: 'overdue', label: 'Overdue', detail: 'past due, not done', available: true },
            { id: 'pinned', label: 'Pinned', detail: 'starred only', available: true },
          ],
        },
      ],
      execute: (_c, [what], api) => {
        fire('fm:tasks:select', { what });
        api.closeOverlay();
      },
    },
  ];
}

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

    // fm-7d86 — variants are independent flags, not mutually-exclusive
    // modes. The "Flags" slot is multi-select: space toggles each flag,
    // Enter launches with the union (or bare if none selected). The old
    // synthesized "Bare" option is gone — empty selection IS bare.
    const modeOptions: Option[] = hasVariants
      ? variants.map<Option>((v) => {
          const fullCmd = [
            l.command,
            ...baseArgs,
            ...(v.args ?? []),
          ].join(' ');
          return {
            id: v.id,
            label: v.label,
            detail: v.description ?? fullCmd,
            available: true,
            aliases: v.args ?? [],
          };
        })
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
        ? [{ label: 'Flags', getOptions: () => modeOptions, multi: true }]
        : [],
      execute: async (c, picks, api) => {
        const variantId = hasVariants ? picks[0] : undefined;
        // fm-yi85 — on the tasks-overview tab, the active "target" is the
        // selected task list (or the cursor row) — not a single open
        // task. Hand off to TasksPage via fm:tasks:launcher so it can
        // open one task tab per target and invoke the launcher in each.
        if (c.activeTabKind === 'tasks') {
          window.dispatchEvent(
            new CustomEvent('fm:tasks:launcher', { detail: { launcherId: l.id, variantId } }),
          );
          api.closeOverlay();
          return;
        }
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

  // 1b) Ancestor chain — every parent folder up to root. Without this the
  //     picker could only ever go *down* (children + BFS descendants) or
  //     sideways (recents/bookmarks/Spotlight); the immediate parent of a
  //     deep folder often isn't a recent and may not be Spotlight-indexed,
  //     so "move/go up one folder" had no candidate to land on. Listing the
  //     ancestors makes parent folders first-class destinations for both
  //     goto and move/copy. Walk from cwd's parent up to '/'.
  // Normalize a trailing slash so dirnameOf walks to the real parent
  // ('/a/b/' → '/a/b' is the same folder, not its parent).
  const cwdNorm = c.cwd.length > 1 && c.cwd.endsWith('/') ? c.cwd.replace(/\/+$/, '') : c.cwd;
  let anc = dirnameOf(cwdNorm);
  let up = 1;
  // Guard against degenerate paths; dirnameOf('/') === '/'.
  while (anc && anc !== cwdNorm && up <= 64) {
    push({
      id: anc,
      label: basename(anc) || anc,
      detail: up === 1
        ? 'parent folder · ' + prettyPath(anc, c.homedir)
        : `${up} levels up · ${prettyPath(anc, c.homedir)}`,
      available: true,
    });
    const next = dirnameOf(anc);
    if (next === anc) break; // reached root
    anc = next;
    up++;
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
      detail: prettyPath(p, c.homedir) + '  ·  search',
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
    for (const p of c.recentFiles.slice(0, 8)) {
      const id = `file:${p}`;
      if (seen.has(id)) continue;
      seen.add(id);
      opts.push({
        id,
        label: basename(p) || p,
        detail: prettyPath(dirnameOf(p), c.homedir) + '  ·  recent file',
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

// fm-notes — the breeze notes folder lives under the user's home config
// dir (~/.breezefile/breeze notes). Exported helpers so the `:note` and
// `:notes` verbs share path logic and EditShell can recognize "this file
// was created by :note" when deciding whether to rename on save.
export const NOTES_SUBDIR = '.breezefile/breeze notes';

export function notesDirFor(home: string): string {
  return `${home}/${NOTES_SUBDIR}`;
}

export function isDefaultNoteName(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}-\d+\.md$/.test(name);
}

async function ensureNotesDir(home: string): Promise<string> {
  const dir = notesDirFor(home);
  try {
    const st = await fm.stat(dir);
    if (st.isDir) return dir;
  } catch {
    // not present — fall through and create it
  }
  try {
    await fm.mkdir(dir);
  } catch (err) {
    // Race / pre-existing: a second stat resolves the ambiguity. If the
    // folder is there now (some other code path created it between our
    // stat and mkdir), proceed; otherwise surface the original error.
    try {
      const st = await fm.stat(dir);
      if (st.isDir) return dir;
    } catch {
      /* ignore */
    }
    throw err;
  }
  return dir;
}

async function nextNotePath(dir: string): Promise<string> {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let names: string[] = [];
  try {
    const entries = await fm.readdir(dir);
    names = entries.map((e) => e.name);
  } catch {
    /* empty folder is fine */
  }
  const used = new Set(names);
  let n = 1;
  while (used.has(`${date}-${n}.md`)) n++;
  return `${dir}/${date}-${n}.md`;
}

function resolveDestination(c: Ctx, destId: string): string | null {
  if (destId === '~') return c.homedir;
  if (destId.startsWith('~/')) return c.homedir + destId.slice(1);
  return destId;
}

// Blended find-anywhere tuning. The verb picker doubles as a search box,
// but the disk walks behind it (Spotlight + recursive $HOME) are the
// expensive part — so we cap, debounce, and gate them.
const FIND_CAP = 30;
const FIND_DEBOUNCE_MS = 200;
// The recursive $HOME walk (findEntries) is the heaviest; demand one more
// character before paying for it.
const FILE_FIND_MIN_LEN = 3;

// True when the typed query is just a verb name being entered (term,
// claude, settings, …). In that case the verb picker has a local answer
// and must not kick off a Spotlight / $HOME search at all.
function queryMatchesVerb(q: string, verbs: VerbDef[]): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return false;
  return verbs.some(
    (v) =>
      v.id.toLowerCase().startsWith(s) ||
      v.label.toLowerCase().startsWith(s) ||
      v.aliases.some((a) => a.toLowerCase().startsWith(s)),
  );
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
  const { state, dispatch, activeTab, setTab, setTabSticky, refreshActive, navigateTo, goBack, goForward, focusEntryByName } = useStore();
  const [verb, setVerb] = useState<VerbDef | null>(
    () => VERBS.find((v) => v.id === initialVerbId) ?? null,
  );
  const [picks, setPicks] = useState<string[]>([]); // slot values
  // fm-7d86 — multi-select staging: ids the user has toggled on for the
  // current multi slot. Cleared on slot advance / verb change. Committed
  // into picks as a comma-joined string when Enter fires.
  const [multiSelected, setMultiSelected] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState(initialFilter);
  const [highlightIdx, setHighlightIdx] = useState(0);
  // fm — keep the highlighted option visible when arrow-keying past the
  // viewport edge of the options list.
  const highlightedRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    highlightedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [highlightIdx]);
  // Sticky highlight by option id — declared here so the keydown handler
  // can capture it; the matches-restore effect lives just below `matches`.
  const stickyHighlightIdRef = useRef<string | null>(null);
  const [homedir, setHomedir] = useState('');
  const [hoverReason, setHoverReason] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<string[]>([]);
  const [searchFiles, setSearchFiles] = useState<Array<{ path: string; name: string; isDir: boolean }>>([]);
  const [localSubdirs, setLocalSubdirs] = useState<string[]>([]);
  const [defaultTerminal, setDefaultTerminal] = useState<string | null>(null);
  const [installedTerminals, setInstalledTerminals] = useState<string[]>([]);
  const [remoteTargets, setRemoteTargets] = useState<string[]>([]);
  const [connectedSources, setConnectedSources] = useState<string[]>([]);
  const [launchers, setLaunchers] = useState<import('../bridge').Launcher[]>([]);
  const searchTokenRef = useRef(0); // guards against out-of-order resolves
  const subdirsTokenRef = useRef(0);
  // Last query actually sent to the filesystem (per source). Used to skip
  // a re-walk when the user is only *extending* a query we already ran —
  // narrowing then happens client-side in the scorer.
  const lastFolderQueryRef = useRef('');
  const lastFileQueryRef = useRef('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [openRename, setOpenRename] = useState<Entry | null>(null);

  useEffect(() => {
    void fm.homedir().then(setHomedir);
    // fm-2du: preload detected terminals + saved preference so the Open
    // Terminal verb can render its slot immediately without an async gap.
    void fm.getDefaultTerminal().then(setDefaultTerminal).catch(() => {});
    void fm.listTerminals().then(setInstalledTerminals).catch(() => {});
    // sshfs-mount ssh targets for the remote-attach verb's host slot.
    void fm.remoteListTargets().then(setRemoteTargets).catch(() => {});
    // Connected remote sources for the :disconnect verb's host slot.
    // Refresh on every connect/disconnect broadcast.
    const loadSources = () =>
      void fm
        .sourcesList()
        .then((ss) =>
          setConnectedSources(
            ss.filter((s) => s.kind === 'remote' && s.status === 'connected').map((s) => s.id),
          ),
        )
        .catch(() => {});
    loadSources();
    const offSources = fm.onSourcesChanged(loadSources);
    // fm-g6r — preload the user's launcher list so :claude/:codex/:gemini
    // surface in the verb picker without a per-frame async fetch.
    void fm.launchersList().then(setLaunchers).catch(() => {});
    return () => offSources();
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
    // Also fire when there's no verb yet — the verb picker now blends
    // Spotlight folder hits underneath the verb list so users don't need to
    // explicitly enter goto mode to search.
    const inVerbPicker = verb === null;
    const query = filter.trim();
    if ((!isDestinationSlot && !inVerbPicker) || query.length < 2) {
      lastFolderQueryRef.current = '';
      setSearchResults((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    // Verb-name typing (term, claude, settings…) is answered locally by
    // the verb picker — don't pay for a Spotlight walk for it.
    if (
      inVerbPicker &&
      queryMatchesVerb(query, [...VERBS, ...synthesizeLauncherVerbs(launchers)])
    ) {
      lastFolderQueryRef.current = '';
      setSearchResults((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    // Pure narrowing: the user is just extending a query we already
    // walked, and that walk wasn't truncated at the cap — so every
    // matching folder is already in `searchResults`. Let the scorer
    // filter them client-side instead of re-hitting the filesystem.
    const prevQ = lastFolderQueryRef.current;
    if (
      prevQ &&
      query.startsWith(prevQ) &&
      searchResults.length > 0 &&
      searchResults.length < FIND_CAP
    ) {
      return;
    }
    const token = ++searchTokenRef.current;
    const timer = window.setTimeout(() => {
      void fm.findFolders(query, FIND_CAP).then((hits) => {
        if (searchTokenRef.current !== token) return;
        lastFolderQueryRef.current = query;
        setSearchResults(hits);
      }).catch(() => {
        if (searchTokenRef.current !== token) return;
        lastFolderQueryRef.current = '';
        setSearchResults((prev) => (prev.length === 0 ? prev : []));
      });
    }, FIND_DEBOUNCE_MS);
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
    // Fire file search in the verb picker too (verb=null) so the merged
    // results panel can include file hits without forcing the user into goto.
    const inVerbPicker = verb === null;
    const query = filter.trim();
    // The recursive $HOME walk is the heaviest of the blended searches —
    // demand FILE_FIND_MIN_LEN chars before paying for it.
    if (
      (!isGotoSlot && !inVerbPicker) ||
      !homedir ||
      query.length < FILE_FIND_MIN_LEN
    ) {
      lastFileQueryRef.current = '';
      setSearchFiles((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    // Same verb-name gate as the folder search.
    if (
      inVerbPicker &&
      queryMatchesVerb(query, [...VERBS, ...synthesizeLauncherVerbs(launchers)])
    ) {
      lastFileQueryRef.current = '';
      setSearchFiles((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    // Pure narrowing — extend an already-walked, un-truncated query
    // client-side instead of re-walking $HOME.
    const prevQ = lastFileQueryRef.current;
    if (
      prevQ &&
      query.startsWith(prevQ) &&
      searchFiles.length > 0 &&
      searchFiles.length < FIND_CAP
    ) {
      return;
    }
    const token = ++fileSearchTokenRef.current;
    const timer = window.setTimeout(() => {
      void fm.findEntries([homedir], query, FIND_CAP).then((hits) => {
        if (fileSearchTokenRef.current !== token) return;
        // Files only — folders already come through findFolders / localSubdirs.
        const files = hits.filter((h) => !h.isDir);
        lastFileQueryRef.current = query;
        setSearchFiles(files);
      }).catch(() => {
        if (fileSearchTokenRef.current !== token) return;
        lastFileQueryRef.current = '';
        setSearchFiles((prev) => (prev.length === 0 ? prev : []));
      });
    }, FIND_DEBOUNCE_MS);
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
    // Verb picker also wants local-descendant context so name typing finds
    // subfolders without needing to switch into goto.
    const inVerbPicker = verb === null;
    if ((!isDestinationSlot && !inVerbPicker) || !activeTab) {
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

  // Focus the input and place the caret at the end of the pre-filled query,
  // synchronously on mount. A previous version used requestAnimationFrame,
  // which fired *after* the user's next 1–2 keystrokes were already in the
  // DOM and rewound the caret to initialFilter.length — causing typed
  // characters to be inserted in front of earlier ones (e.g. "tips" → "tpsi").
  // useLayoutEffect runs after commit but before the browser delivers further
  // input events, so there is no window for the caret reset to race typing.
  useLayoutEffect(() => {
    if (!initialFilter) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(initialFilter.length, initialFilter.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      recentFiles: state.recentFiles ?? [],
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
      remoteTargets,
      connectedSources,
      activeTabHasTerminal: !!activeTab.terminal,
      activeTabTerminal: activeTab.terminal ? { ptyId: activeTab.terminal.ptyId } : undefined,
      launchers,
      customTags: state.customTags,
      tagPaths: state.tagPaths,
      tagFilter: activeTab.tagFilter,
      activeTabKind: activeTab.kind,
      activeTabFoldersFirst: activeTab.foldersFirst ?? true,
    };
  }, [activeTab, state.entriesByPath, state.yank, state.bookmarks, state.recents, state.recentFiles, state.pinned, state.tabs, state.activeTab, state.lastClosedTab, homedir, searchResults, searchFiles, filter, localSubdirs, defaultTerminal, installedTerminals, remoteTargets, connectedSources, launchers, state.customTags, state.tagPaths]);

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
  const inTasksTab = activeTab.kind === 'tasks';
  const effectiveVerbs: VerbDef[] = useMemo(
    () => {
      let base = tasksEnabled
        ? VERBS
        : VERBS.filter((v) => v.id !== 'task' && v.id !== 'tasks' && v.id !== 'run');
      // fm-yi85 — tabKinds is an allowlist when present. When absent the
      // verb falls back to availableInTaskMode for tab-kind gating: a verb
      // okay-in-task-mode is also okay on the tasks-overview tab (settings,
      // help, switch-tab, etc.), and file-management verbs that opt out of
      // task mode also opt out of tasks mode.
      base = base.filter((v) => {
        if (v.tabKinds) return v.tabKinds.includes(activeTab.kind);
        if (inTasksTab || inTaskMode) return v.availableInTaskMode !== false;
        return true;
      });
      return [...base, ...synthesizeLauncherVerbs(launchers)];
    },
    [launchers, tasksEnabled, inTaskMode, inTasksTab, activeTab.kind],
  );

  // Build options for current state.
  //
  // Verb picker (verb=null): the catalog of verbs is shown unconditionally.
  // When the user has typed at least 2 chars we ALSO blend in folder + file
  // hits (immediate subdirs, descendants, recents, bookmarks, Spotlight, file
  // hits) so the palette doubles as a find-anywhere search without forcing
  // the user to commit to the goto verb. Verbs are tagged 'verb' and find
  // results are tagged 'find-folder' / 'find-file' so the renderer + scorer
  // can distinguish them.
  // Memoized: this used to be a per-render IIFE, so the `matches` scorer
  // (which lists allOptions in its deps) re-ranked the entire blended
  // list on every render — including a plain ArrowDown that only moves
  // the highlight. Stable identity here keeps arrow nav from re-scoring.
  const allOptions: Option[] = useMemo(() => {
    if (verb === null) {
      const verbOpts: Option[] = effectiveVerbs.map((v) => {
        const { ok, reason } = v.isAvailable(ctx);
        return {
          id: v.id,
          label: v.label,
          detail: v.describe(ctx),
          available: ok,
          reason,
          kind: 'verb',
        };
      });
      if (filter.trim().length < 2) return verbOpts;
      const findOpts: Option[] = destinationOptions(ctx, false, true).map((o) => ({
        ...o,
        kind: o.id.startsWith('file:') ? 'find-file' : 'find-folder',
      }));
      // De-dupe: a typed query like "settings" might surface both a Settings
      // verb and a Settings folder. Keep the verb (it's what the alias was
      // built for) and drop the find row that collides on id.
      const verbIds = new Set(verbOpts.map((o) => o.id));
      return [...verbOpts, ...findOpts.filter((o) => !verbIds.has(o.id))];
    }
    return activeSlot ? activeSlot.getOptions(ctx, picks) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verb, effectiveVerbs, ctx, filter, activeSlot, picks]);

  // Filter + rank. For single-token queries we prefer label-starts-with
  // matches; for multi-token queries ("webinar folder") ALL tokens must
  // appear somewhere in the label or detail (substring, any order). A
  // folder like "Webinar data shared folder" then matches even though
  // "webinar folder" isn't contiguous.
  const matches = useMemo(() => {
    if (!filter) return allOptions;
    const tokens = filter.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return allOptions;

    // Recency bonus: build a path→rank map from the LRU so the scorer can
    // boost folders the user actually opens. Without this, a Spotlight hit
    // with a stronger name match can outrank a folder visited five minutes
    // ago. Bonus decays linearly with position (rank 0 = +50, rank 8 ≈ +2),
    // and we look up by the absolute form of the option id so ~-prefixed
    // common subdirs (Desktop, Documents…) still hit when their absolute
    // counterpart is in recents.
    const recents = ctx?.recents ?? [];
    const recentFiles = ctx?.recentFiles ?? [];
    const home = ctx?.homedir ?? '';
    const recentRank = new Map<string, number>();
    for (let i = 0; i < recents.length; i++) recentRank.set(recents[i], i);
    for (let i = 0; i < recentFiles.length; i++) {
      if (!recentRank.has(recentFiles[i])) recentRank.set(recentFiles[i], i);
    }
    const absId = (id: string): string => {
      if (id === '~') return home;
      if (id.startsWith('~/') && home) return home + id.slice(1);
      if (id.startsWith('file:')) return id.slice(5);
      return id;
    };

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

        // Contiguity bonus: tokens appearing adjacent in the label (separated
        // only by space / `-` / `_` / `.`) score much higher than the same
        // tokens scattered across unrelated words. Without this, a query like
        // "publish and perish" treats "publish-and-perish.md" the same as
        // "validate_and_publish_artifact.go" — both have all tokens in the
        // label, but only the first matches the user's intent.
        if (tokens.length >= 2) {
          const contiguous = tokens.join('[\\s\\-_.]+');
          try {
            if (new RegExp(contiguous).test(label)) score += 60;
          } catch {
            // bad regex tokens — skip
          }
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
        else if (detail.includes('parent folder') || detail.includes('levels up')) score += 22;
        else if (detail.includes('· search')) score -= 15;

        // In the verb picker, verbs always rank above find results. Without
        // this a folder named "move" can outrank the Move verb on a typed
        // "move", which is the opposite of what the user wants.
        if (verb === null) {
          if (o.kind === 'verb') score += 1000;
        }

        // Recency boost: folders the user has actually opened beat
        // never-touched name-twins from Spotlight. Decays with position so
        // last-visited wins ties against an older recent.
        const rank = recentRank.get(absId(o.id));
        if (rank !== undefined) score += Math.max(0, 50 - rank * 6);

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

  // When async results re-rank `matches`, pull the cursor back to the row
  // the user was deliberately aiming at. Without this, arrow-keying to a
  // folder while Spotlight is still walking could land Enter on a
  // different row once results streamed in 200ms later. The sticky id is
  // only set on explicit user moves (Arrow / hover), so result arrivals
  // before the user has touched the list don't strand the highlight on a
  // stale row.
  useLayoutEffect(() => {
    const id = stickyHighlightIdRef.current;
    if (!id) return;
    const idx = matches.findIndex((m) => m.id === id);
    if (idx >= 0 && idx !== highlightIdx) setHighlightIdx(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  // (Removed) Natural-language auto-fallthrough into the goto verb. Find
  // results now blend into the verb picker directly, so the user doesn't
  // need to be silently transported into a different verb when a typed
  // query stops matching a verb. Verbs stay prioritized; find results
  // appear underneath. The user can still explicitly enter goto by
  // selecting the 'Go to / Find' verb or typing 'goto'.

  function pickOption(opt: Option) {
    if (!opt.available) {
      setHoverReason(opt.reason ?? 'Not available right now');
      return;
    }
    if (verb === null) {
      // Find result picked from the merged verb-picker list: behave like the
      // goto verb's execute — file picks open, folder picks navigate. Done
      // inline so the user never visibly enters goto mode.
      if (opt.kind === 'find-file') {
        const filePath = opt.id.slice('file:'.length);
        const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
        if (ext === 'md' || ext === 'mdx') {
          dispatch({ type: 'openEditTab', path: filePath, focus: true });
        } else {
          dispatch({ type: 'pushRecentFile', path: filePath });
          void fm.open(filePath);
        }
        onClose();
        return;
      }
      if (opt.kind === 'find-folder') {
        const target = ctx ? resolveDestination(ctx, opt.id) : null;
        if (target) navigateTo(target);
        onClose();
        return;
      }
      const v = effectiveVerbs.find((x) => x.id === opt.id);
      if (!v) return;
      setVerb(v);
      setPicks([]);
      setFilter('');
      setHighlightIdx(0);
      stickyHighlightIdRef.current = null;
      // If verb has zero slots — execute immediately
      if (v.slots.length === 0) {
        void executeWith(v, []);
      }
    } else {
      // fm-7d86 — in multi-select slots, "picking" toggles selection
      // rather than advancing. Enter / Tab on Enter handler is what
      // commits and advances.
      const slot = verb.slots[picks.length];
      if (slot?.multi) {
        setMultiSelected((prev) => {
          const next = new Set(prev);
          if (next.has(opt.id)) next.delete(opt.id);
          else next.add(opt.id);
          return next;
        });
        setFilter('');
        return;
      }
      const nextPicks = [...picks, opt.id];
      if (nextPicks.length >= verb.slots.length) {
        void executeWith(verb, nextPicks);
      } else {
        setPicks(nextPicks);
        setFilter('');
        setHighlightIdx(0);
        stickyHighlightIdRef.current = null;
      }
    }
  }

  // fm-7d86 — commit the current multi-select staging into picks and
  // either advance to the next slot or execute the verb.
  function commitMultiSlot() {
    if (!verb) return;
    const slot = verb.slots[picks.length];
    if (!slot?.multi) return;
    // Preserve the option order (not insertion order) so the command
    // line reads predictably regardless of toggle sequence.
    const opts = slot.getOptions(ctx!, picks);
    const ordered = opts
      .filter((o) => multiSelected.has(o.id))
      .map((o) => o.id);
    const value = ordered.join(',');
    const nextPicks = [...picks, value];
    setMultiSelected(new Set());
    if (nextPicks.length >= verb.slots.length) {
      void executeWith(verb, nextPicks);
    } else {
      setPicks(nextPicks);
      setFilter('');
      setHighlightIdx(0);
      stickyHighlightIdRef.current = null;
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
        setTabSticky({ showHidden: h });
        dispatch({ type: 'setStatus', msg: h ? 'showing hidden files' : 'hiding hidden files' });
        onClose();
        return;
      }
      // fm-k9dg — toggle "directories first" for the current folder.
      if (v.id === 'foldersFirst') {
        const ff = !(safeTab.foldersFirst ?? true);
        setTabSticky({ foldersFirst: ff });
        dispatch({ type: 'setStatus', msg: ff ? 'folders first' : 'mixed (sort by chosen key only)' });
        onClose();
        return;
      }
      let suppressClose = false;
      await v.execute(safeCtx, ps, {
        setTab,
        setTabSticky,
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
          stickyHighlightIdRef.current = null;
          if (status) dispatch({ type: 'setStatus', msg: status });
        },
      });
      if (suppressClose) return;
    } catch (err) {
      dispatch({ type: 'setStatus', msg: formatOpError(v.label, err) });
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

  // fm-7d86 — true when the currently active slot is a multi-select.
  const inMultiSlot =
    !!verb && verb.slots[picks.length]?.multi === true;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      if (filter) {
        setFilter('');
      } else if (inMultiSlot && multiSelected.size > 0) {
        // First Esc clears the multi staging; second Esc backs out of the slot.
        setMultiSelected(new Set());
      } else if (picks.length > 0) {
        setPicks(picks.slice(0, -1));
      } else if (verb) {
        setVerb(null);
      } else {
        onClose();
      }
      return;
    }
    // fm-7d86 — Space toggles selection on multi slots (only when the
    // filter is empty, so the user can still type "skip" to narrow).
    // After toggling, advance to the next option if one exists — keeps
    // the keyboard hand resting on Space for quick walk-through.
    if (e.key === ' ' && inMultiSlot && !filter) {
      e.preventDefault();
      const opt = matches[highlightIdx];
      if (opt) {
        pickOption(opt);
        if (highlightIdx < matches.length - 1) {
          setHighlightIdx(highlightIdx + 1);
        }
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      (e.nativeEvent as KeyboardEvent).stopImmediatePropagation?.();
      // fm-7d86 — Enter on a multi slot commits the staging (empty = bare).
      if (inMultiSlot) {
        commitMultiSlot();
        return;
      }
      const opt = matches[highlightIdx];
      if (opt) pickOption(opt);
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      if (inMultiSlot) {
        commitMultiSlot();
        return;
      }
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
      const next = Math.min(highlightIdx + 1, matches.length - 1);
      setHighlightIdx(next);
      stickyHighlightIdRef.current = matches[next]?.id ?? null;
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.max(highlightIdx - 1, 0);
      setHighlightIdx(next);
      stickyHighlightIdRef.current = matches[next]?.id ?? null;
      return;
    }
    if (e.key === 'Backspace' && !filter) {
      e.preventDefault();
      if (inMultiSlot && multiSelected.size > 0) {
        // First Backspace clears multi staging; next walks back a slot.
        setMultiSelected(new Set());
      } else if (picks.length > 0) {
        setPicks(picks.slice(0, -1));
        setMultiSelected(new Set());
      } else if (verb) {
        setVerb(null);
        setMultiSelected(new Set());
      }
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
            // fm-7d86 — on the active multi slot, show the live staging
            // (e.g. "continue + skip") so the chip stays informative
            // before the user commits with Enter.
            const isActiveMulti =
              slotState === 'active' && verb && (verb.slots[i] as SlotDef | undefined)?.multi;
            const activeMultiLabel = isActiveMulti
              ? multiSelected.size === 0
                ? `${s.label.toLowerCase()} (none)`
                : (verb!.slots[i].getOptions(ctx, picks.slice(0, i))
                    .filter((o) => multiSelected.has(o.id))
                    .map((o) => o.label)
                    .join(' + '))
              : null;
            const label =
              slotState === 'completed'
                ? previewSlotValue(verb!, picks, i, ctx)
                : activeMultiLabel ?? s.label.toLowerCase();
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
            onChange={(e) => { setFilter(e.target.value); setHighlightIdx(0); stickyHighlightIdRef.current = null; setHoverReason(null); }}
            onKeyDown={onKeyDown}
            placeholder={
              verb === null
                ? 'type an action, file, or folder…'
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
          {matches.map((opt, i) => {
            const checked = inMultiSlot && multiSelected.has(opt.id);
            const isFind = opt.kind === 'find-folder' || opt.kind === 'find-file';
            // Section divider before the first find row in the verb picker
            // so the eye reads "verbs first, then matching places & files."
            const prevKind = i > 0 ? matches[i - 1].kind : undefined;
            const showFindHeader =
              verb === null && isFind && prevKind !== 'find-folder' && prevKind !== 'find-file';
            return (
              <React.Fragment key={opt.id}>
              {showFindHeader && (
                <li className="chip-options__section" aria-hidden="true">
                  Places & files
                </li>
              )}
              <li
                ref={i === highlightIdx ? highlightedRef : undefined}
                className={[
                  'chip-option',
                  i === highlightIdx ? 'chip-option--highlighted' : '',
                  !opt.available ? 'chip-option--disabled' : '',
                  checked ? 'chip-option--checked' : '',
                  opt.kind === 'verb' ? 'chip-option--verb' : '',
                  opt.kind === 'find-folder' ? 'chip-option--find chip-option--find-folder' : '',
                  opt.kind === 'find-file' ? 'chip-option--find chip-option--find-file' : '',
                ].filter(Boolean).join(' ')}
                onMouseEnter={() => {
                  setHighlightIdx(i);
                  stickyHighlightIdRef.current = opt.id;
                  setHoverReason(opt.available ? null : opt.reason ?? null);
                }}
                onMouseLeave={() => setHoverReason(null)}
                onClick={() => pickOption(opt)}
              >
                <span
                  className={`chip-badge${inMultiSlot ? ' chip-badge--checkbox' : ''}`}
                >
                  {inMultiSlot ? (checked ? '✓' : '') : i < 9 ? i + 1 : '·'}
                </span>
                <span className="chip-option__body">
                  <span className="chip-option__label">{opt.label}</span>
                  {opt.detail && <span className="chip-option__detail">{opt.detail}</span>}
                </span>
                {!opt.available && (
                  <span className="chip-option__lock" title={opt.reason}>⊘</span>
                )}
              </li>
              </React.Fragment>
            );
          })}
        </ul>

        {/* fm-7d86 — explicit launch CTA on multi-select slots. Discovers
            the keyboard shortcut for keyboard users, and gives a clickable
            button for users who'd rather drive the picker with the mouse. */}
        {inMultiSlot && (() => {
          const slotOpts = activeSlot ? activeSlot.getOptions(ctx, picks) : [];
          const stagedLabels = slotOpts
            .filter((o) => multiSelected.has(o.id))
            .map((o) => o.label);
          const launcher = launchers.find(
            (l) => verb && verb.id === ('launcher:' + l.id),
          );
          const stagedIds = slotOpts
            .filter((o) => multiSelected.has(o.id))
            .map((o) => o.id);
          let cmdLine = '';
          if (launcher) {
            const baseArgs = launcher.args ?? [];
            const allVariants = launcher.variants ?? [];
            const variantArgs: string[] = [];
            const seen = new Set<string>();
            for (const id of stagedIds) {
              const v = allVariants.find((x) => x.id === id);
              for (const a of v?.args ?? []) {
                if (!seen.has(a)) { seen.add(a); variantArgs.push(a); }
              }
            }
            cmdLine = [launcher.command, ...baseArgs, ...variantArgs].join(' ');
          }
          const headline =
            stagedLabels.length === 0
              ? 'Launch with no flags (bare)'
              : `Launch with ${stagedLabels.join(' + ')}`;
          return (
            <div className="chip-multi-cta">
              <span className="chip-multi-cta__text">
                <span className="chip-multi-cta__primary">{headline}</span>
                {cmdLine && (
                  <span className="chip-multi-cta__secondary">$ {cmdLine}</span>
                )}
              </span>
              <button
                type="button"
                className="chip-multi-cta__btn"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  commitMultiSlot();
                }}
              >
                Launch <kbd>↵</kbd>
              </button>
            </div>
          );
        })()}

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
          {inMultiSlot ? (
            <>
              <span><kbd>Space</kbd> toggle</span>
              <span><kbd>Enter</kbd> launch</span>
            </>
          ) : (
            <>
              <span><kbd>Tab</kbd> or <kbd>Enter</kbd> pick</span>
              <span><kbd>1–9</kbd> direct pick</span>
            </>
          )}
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
  // fm-7d86 — multi slot values are comma-joined ids; render the union
  // of labels (or "bare" when nothing was picked).
  if (verb.slots[i].multi) {
    if (!val) return 'bare';
    const ids = val.split(',').filter(Boolean);
    const labels = ids
      .map((id) => opts.find((o) => o.id === id)?.label ?? id);
    return labels.length === 0 ? 'bare' : labels.join(' + ');
  }
  const match = opts.find((o) => o.id === val);
  return match?.label ?? val;
}

// Unused helpers kept for signature cohesion
void pathJoin;
void dirname;
