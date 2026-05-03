import { useEffect, useRef } from 'react';
import { useStore } from './store';
import { fm } from './bridge';
import {
  basename,
  currentEntry,
  dirname,
  lastCol,
  pathJoin,
  visibleEntries,
} from './actions';
import type { Entry, SortKey, YankMode } from './types';
import { runPaste } from './clipboard';

// Canonical key name — Ctrl chords prefixed with C-, like ranger's <C-x>.
function keyName(e: KeyboardEvent): string {
  if (e.ctrlKey && e.key.length === 1) return `C-${e.key}`;
  if (e.key === 'Enter') return 'Enter';
  if (e.key === 'Escape') return 'Escape';
  if (e.key === 'Backspace') return 'Backspace';
  if (e.key === 'Tab') return 'Tab';
  if (e.key === ' ') return e.shiftKey ? 'S- ' : ' ';
  if (e.key === 'ArrowDown') return 'ArrowDown';
  if (e.key === 'ArrowUp') return 'ArrowUp';
  if (e.key === 'ArrowLeft') return 'ArrowLeft';
  if (e.key === 'ArrowRight') return 'ArrowRight';
  if (e.key === 'PageDown') return 'PageDown';
  if (e.key === 'PageUp') return 'PageUp';
  if (e.key === 'Home') return 'Home';
  if (e.key === 'End') return 'End';
  return e.key;
}

// <any>-consuming chords. When pending matches one of these, the next
// keystroke is the argument (bookmark letter, tag char, etc.), not a
// lookup into chordActions. Keep in sync with handler below.
// fm-60k — `t` and `T` no longer consume an arg; they open the keyboard
// TagPicker instead. Kept off ANY_PREFIXES so they fire as single-key
// actions in the actions table below.
const ANY_PREFIXES = ["'", '`', 'm', 'um'];

// Prefixes that aren't themselves actions but need to be reachable so the
// <any>-consuming handlers above can fire.
const EXTRA_PREFIXES = ['um'];

// Timeout (ms) for committing an ambiguous chord that is both a complete
// action and a prefix of a longer one. e.g. gd is "cd /dev" but also the
// start of gdoc/gdat/…; we wait this long before firing gd.
const AMBIGUOUS_COMMIT_MS = 500;

// Timeout for abandoning an unfinished chord.
const CHORD_TIMEOUT_MS = 1000;

// Single-letter nav keys (h j k l) double as the first letter of many file
// names. To let users type names starting with these letters into the chip
// prompt without losing the first letter, the FIRST press of one of these
// is buffered for NAV_DEFER_MS — if a second printable letter arrives within
// that window, the pair opens the chip prompt; otherwise the nav action
// fires. Held-down (auto-repeat) keystrokes set `event.repeat`, so scrolling
// with a held `j` runs at full speed.
const NAV_DEFER = new Set(['h', 'j', 'k', 'l']);
// Window between keystrokes during which a follow-up letter still hijacks
// h/j/k/l into the chip prompt instead of firing nav. 500ms covers casual
// typing; vim-style "tap l to enter" still feels responsive (one beat
// of perceived latency before the cursor jumps). Held keys bypass this
// entirely via event.repeat.
const NAV_DEFER_MS = 500;

export function useKeyboard(
  promptRename: (entry: Entry, mode: 'full' | 'beforeExt' | 'append' | 'prepend') => void,
  promptMkdir: () => void,
  promptQuickFind: () => void,
  promptShell: () => void,
) {
  const { state, dispatch, activeTab, setTab, openPath, refreshActive, navigateTo, goBack, goForward } =
    useStore();
  const stateRef = useRef(state);
  stateRef.current = state;

  // Chord pending is owned by a ref — React state updates are async and will
  // lose keystrokes when the user types a chord faster than a render commit.
  // Store.pending is mirrored for the modeline UI only.
  const pendingRef = useRef('');
  function setPending(value: string) {
    pendingRef.current = value;
    dispatch({ type: 'setPending', pending: value });
  }

  // Mirror state.mode synchronously so back-to-back keystrokes don't double-
  // dispatch setMode while React is still committing the previous update.
  // Without this, typing "lda" fast enough to outrun render fires two
  // setMode actions and the chip's modeBuffer becomes just "a".
  const modeRef = useRef<typeof state.mode>(state.mode);
  modeRef.current = state.mode;
  function openCommandMode(buffer: string) {
    modeRef.current = 'command';
    dispatch({ type: 'setMode', mode: 'command', buffer });
  }

  // Single outstanding timer for chord commit/clear.
  const timerRef = useRef<number | null>(null);
  function clearTimer() {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const cur = stateRef.current;
      const tab = cur.tabs[cur.activeTab];
      const pending = pendingRef.current;
      if (!tab) return;

      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        // Tab-management mod-chords must escape focused inputs (notably
        // xterm's hidden textarea on task tabs — otherwise ⌘1…9 / ⌘T / ⌘W
        // would only work when a folder tab had focus).
        const mod = e.metaKey || e.ctrlKey;
        const isTabChord =
          mod &&
          (/^[1-9]$/.test(e.key) ||
            e.key === 't' ||
            e.key === 'T' ||
            e.key === 'w' ||
            e.key === 'W' ||
            e.key === 'f' ||
            e.key === 'F');
        if (!isTabChord) return;
      }

      // Chip overlay is open but its <input> hasn't claimed focus yet (race
      // between dispatch → render → mount → autoFocus). Without this guard
      // the second keystroke runs through this handler and triggers another
      // setMode buffer=k, overwriting the first letter — typing "nda" with
      // the chip closed becomes "da" in the input. modeRef is updated
      // synchronously by openCommandMode so back-to-back keystrokes can't
      // outrace the React render that mounts ChipPrompt.
      if (modeRef.current === 'command' || cur.mode === 'command') {
        return;
      }

      // Esc clears an active text filter (set via `goto` file-pick or `zf`).
      // Mirrors the ✕ button on the FilterChip so users have a discoverable
      // affordance and a keyboard escape hatch.
      if (e.key === 'Escape' && tab.filter) {
        e.preventDefault();
        clearTimer();
        setTab({ filter: '' });
        dispatch({ type: 'setStatus', msg: 'filter cleared' });
        return;
      }

      // ⌘F / Ctrl+F → open the 'goto' verb (recursive find). Same surface
      // as `/` and the Find button in the Pathbar (fm-63l).
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        clearTimer();
        dispatch({ type: 'setMode', mode: 'command', verb: 'goto' });
        return;
      }

      // Tab management — platform-standard shortcuts.
      //   ⌘T / Ctrl+T        — new tab at current cwd
      //   ⌘W / Ctrl+W        — close active tab
      //   ⌘⇧T / Ctrl+⇧T      — restore last closed tab
      //   ⌘1…9 / Ctrl+1…9    — jump to tab N
      //   Ctrl+Tab / Ctrl+⇧+Tab  — cycle next/prev (works on macOS too)
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        clearTimer();
        if (e.shiftKey) {
          dispatch({ type: 'restoreTab' });
        } else {
          const cwd = tab.trail[lastCol(tab)];
          dispatch({
            type: 'newTab',
            tab: {
              id: crypto.randomUUID(),
              kind: 'folder',
              taskId: null,
              trail: [cwd],
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
        }
        return;
      }
      if (mod && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault();
        clearTimer();
        if (cur.tabs.length > 1) {
          // fm-jtu — kill the tab's pty (if any) so the shell doesn't
          // outlive the tab. Mirrors the close-button path in Tabbar.
          const t = cur.tabs[cur.activeTab];
          if (t?.terminal) {
            void fm.termKill(t.terminal.ptyId).catch(() => {});
          }
          dispatch({ type: 'closeTab', index: cur.activeTab });
        }
        return;
      }
      if (mod && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        clearTimer();
        // Match Tabbar's visual order: folder zone first, then task zone.
        // Numbering shown on each tab is 1-based across this combined order.
        const folderIdx: number[] = [];
        const taskIdx: number[] = [];
        cur.tabs.forEach((t, i) =>
          (t.kind === 'task' ? taskIdx : folderIdx).push(i),
        );
        const ordered = [...folderIdx, ...taskIdx];
        const target = ordered[Number(e.key) - 1];
        if (target !== undefined)
          dispatch({ type: 'selectTab', index: target });
        return;
      }
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        clearTimer();
        const n = cur.tabs.length;
        if (n > 1) {
          const next = e.shiftKey
            ? (cur.activeTab - 1 + n) % n
            : (cur.activeTab + 1) % n;
          dispatch({ type: 'selectTab', index: next });
        }
        return;
      }

      // Non-folder tabs (task / tasks-overview) own their own keyboard:
      // TaskShell wires its own handlers, TasksPage handles ↑↓/Enter/[/]/w
      // for the task list. The folder-browse actions below (j/k/l/Enter →
      // goRight, etc.) would fire in parallel and operate on the underlying
      // folder tab's selection — pressing Enter on a task row both opened
      // the edit dialog AND opened the file under the cursor on the folder
      // tab the tasks tab covered. Bail after tab-management chords so
      // ⌘T/⌘W/⌘1-9/⌘Tab still work, but before any browse actions.
      if (tab.kind !== 'folder') return;

      const k = keyName(e);

      // --- <any>-consuming pending chords ---
      if (pending === 'm') {
        e.preventDefault();
        clearTimer();
        const entries = visibleEntries(cur.entriesByPath[tab.trail[lastCol(tab)]], tab);
        const entry = currentEntry(tab, entries);
        const dir = entry?.kind === 'dir' ? entry.path : tab.trail[lastCol(tab)];
        dispatch({ type: 'setBookmark', key: k, path: dir });
        dispatch({ type: 'setStatus', msg: `bookmark '${k}' → ${dir}` });
        setPending('');
        return;
      }
      if (pending === "'" || pending === '`') {
        e.preventDefault();
        clearTimer();
        const dest = cur.bookmarks[k];
        if (dest) navigateTo(dest);
        else dispatch({ type: 'setStatus', msg: `no bookmark '${k}'` });
        setPending('');
        return;
      }
      if (pending === 'um') {
        e.preventDefault();
        clearTimer();
        dispatch({ type: 'unsetBookmark', key: k });
        dispatch({ type: 'setStatus', msg: `bookmark '${k}' cleared` });
        setPending('');
        return;
      }

      // --- Single-key (non-chord) actions ---
      const actions: Record<string, () => void | Promise<void>> = {
        j: () => moveSelection(+1),
        ArrowDown: () => gridArrowVert(+1),
        k: () => moveSelection(-1),
        ArrowUp: () => gridArrowVert(-1),
        h: () => goLeft(),
        ArrowLeft: () => gridArrowHoriz(-1),
        l: () => goRight(),
        ArrowRight: () => gridArrowHoriz(+1),
        Enter: () => goRight(),
        Backspace: () => goLeft(),
        G: () => moveSelectionAbs(+Infinity),
        Home: () => moveSelectionAbs(0),
        End: () => moveSelectionAbs(+Infinity),
        'C-d': () => movePage(0.5),
        'C-u': () => movePage(-0.5),
        'C-f': () => movePage(1),
        'C-b': () => movePage(-1),
        PageDown: () => movePage(1),
        PageUp: () => movePage(-1),
        H: () => goBack(),
        L: () => goForward(),
        // Verb-first interaction model (fm-zi2): single-letter *action* keys
        // were removed. Users drive actions via the chip-prompt palette (open
        // it by typing any letter that isn't motion/selection, or via `:`).
        // What remains here is pure motion + selection + modal launchers —
        // keys that are cognitively "where am I" not "what do I do".
        //   • j/k/h/l & arrows & Enter/Backspace — cursor motion
        //   • G / C-d / C-u / C-f / C-b / PageUp/Down — bulk motion
        //   • H / L — history back/forward (motion through time)
        //   • / — live find prompt (search-as-motion; documented exception)
        //   • Space — toggle mark on cursor item (selection)
        //   • S-Space — toggle select-all in active column (selection)
        //   • : — open command mode
        //   • ! — open shell prompt
        //   • F7 — mkdir (function key, not a letter — escape hatch)
        //   • C-r — refresh (modified, not single-letter)
        // Removed letter actions (now reachable via palette): v, f, s, R, a, A, I.
        // / opens the recursive find verb in the chip prompt (matches ⌘F).
        '/': () => dispatch({ type: 'setMode', mode: 'command', verb: 'goto' }),
        // n / N (repeat-find) were removed so typing names starting with
        // 'n' opens the chip prompt with that letter as initial filter.
        // Repeat-find still works inside the live find HUD opened by `/`.
        ':': () => dispatch({ type: 'setMode', mode: 'command', buffer: '' }),
        '!': () => promptShell(),
        ' ': () => toggleMark(),
        // fm-60k — `t` opens the apply HUD, but ONLY in tag view. Outside
        // tag view we let `t` fall through so users typing toward a folder
        // name like `tasks/` or `todo/` aren't intercepted, and so the
        // chip palette pre-fills "t" — surfacing the `tag` and `filter`
        // verbs so people can discover what tagging is.
        ...(tab.viewMode === 'tag'
          ? {
              t: () => {
                window.dispatchEvent(
                  new CustomEvent('fm:tagPicker', { detail: { mode: 'apply' } }),
                );
              },
            }
          : {}),
        'S- ': () => toggleSelectAllCol(),
        F7: () => promptMkdir(),
        'C-r': () => refreshActive(),
      };
      void invertMarks; // retained helper — palette's 'select' verb uses its logic
      void promptQuickFind;
      void revealCurrent; // reachable via 'reveal' verb; helper kept for parity
      void promptRenameCurrent;

      // --- Chord-string → action map (any length) ---
      const chordActions: Record<string, () => void | Promise<void>> = {
        // motion
        // Folder navigation, tab management, and "go to top of list" all
        // moved to the verb prompt (`goto`, `tab`, etc.) when the natural-
        // language fallback (typing any letter opens the chip prompt with
        // that letter as the filter) made every g-prefix chord
        // unreachable. The Home / End keys replace gg / G for top/bottom.
        uq: () => dispatch({ type: 'restoreTab' }),
        // file ops
        yy: () => yankSelection('copy'),
        dd: () => yankSelection('move'),
        dD: () => trashSelection(),
        dF: () => trashSelection(),
        // ph = paste here (renamed from pp). 'phl' (hardlink) is also a
        // valid chord — the engine waits AMBIGUOUS_COMMIT_MS to disambiguate.
        ph: () => paste(false),
        po: () => paste(true),
        pl: () => pasteLinks('symlink'),
        pL: () => pasteLinks('symlinkRel'),
        phl: () => pasteLinks('hardlink'),
        cw: () => promptRenameCurrent('full'),
        // clipboard-style yank variants (yp = yank path, yn = name, y. = stem)
        yp: () => yankPathText('full'),
        yn: () => yankPathText('name'),
        'y.': () => yankPathText('stem'),
        yd: () => yankPathText('dir'),
        // unmark
        uv: () => setTab({ marks: {} }),
        ut: () => clearTagOfCurrent(),
        // view / display
        zh: () => { const h = !tab.showHidden; setTab({ showHidden: h }); dispatch({ type: 'setStatus', msg: h ? 'showing hidden files' : 'hiding hidden files' }); },
        zT: () => void window.dispatchEvent(new Event('fm:openTheme')),
        zf: () => dispatch({ type: 'setMode', mode: 'find', buffer: '' }),
        wl: () => { setTab({ viewMode: 'list' }); dispatch({ type: 'setStatus', msg: 'view: list' }); },
        wg: () => { setTab({ viewMode: 'grid' }); dispatch({ type: 'setStatus', msg: 'view: grid' }); },
        wp: () => { setTab({ viewMode: 'preview' }); dispatch({ type: 'setStatus', msg: 'view: preview' }); },
        wt: () => { setTab({ viewMode: 'tag' }); dispatch({ type: 'setStatus', msg: 'view: tag' }); },
        // sort
        on: () => setSort('name', false),
        os: () => setSort('size', false),
        om: () => setSort('mtime', false),
        oc: () => setSort('ctime', false),
        ot: () => setSort('type', false),
        oe: () => setSort('ext', false),
        oN: () => setSort('name', true),
        oS: () => setSort('size', true),
        oM: () => setSort('mtime', true),
        oC: () => setSort('ctime', true),
        oT: () => setSort('type', true),
        oE: () => setSort('ext', true),
        or: () => { const rev = !tab.sortReverse; setTab({ sortReverse: rev }); dispatch({ type: 'setStatus', msg: `sort: ${tab.sortKey}${rev ? ' ↓' : ' ↑'}` }); },
        // quit
        ZZ: () => window.close(),
        ZQ: () => window.close(),
      };

      // Natural-language first: if the user presses a printable letter/digit
      // that is NOT a registered single-key action, and no chord is pending,
      // open the chip overlay with that key as initial filter. This lets
      // non-technical users just *start typing* ("move", "sort", "go to…")
      // without any `:` or modifier. Chord prefix letters (m, d, y, o, w, g,
      // c, p, u, z, t) used to start chord chains; now they open the chip
      // overlay where the same actions live as first-class verbs.
      //
      // Exception: when the user has staged files (state.yank), let 'p'
      // fall through to the chord engine so 'ph' (paste here) still works.
      // The PasteChip on screen advertises `ph` as the shortcut.
      const isStagedPasteKey = cur.yank.length > 0 && k === 'p';
      if (
        pending === '' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        k.length === 1 &&
        /^[A-Za-z0-9]$/.test(k) &&
        !actions[k] &&
        !isStagedPasteKey
      ) {
        e.preventDefault();
        clearTimer();
        openCommandMode(k);
        return;
      }

      // Build prefix set from all combos + static extras.
      const prefixes = new Set<string>([...ANY_PREFIXES, ...EXTRA_PREFIXES]);
      for (const combo of Object.keys(chordActions)) {
        for (let i = 1; i < combo.length; i++) prefixes.add(combo.slice(0, i));
      }

      const combo = pending + k;
      const isAction = combo in chordActions;
      const isPrefix = prefixes.has(combo);

      // Case: combo is a terminal action (no longer action starts with it)
      if (isAction && !isPrefix) {
        e.preventDefault();
        clearTimer();
        chordActions[combo]();
        setPending('');
        return;
      }

      // Case: combo is BOTH an action and prefix of a longer action.
      // Wait AMBIGUOUS_COMMIT_MS for more input, then commit.
      if (isAction && isPrefix) {
        e.preventDefault();
        clearTimer();
        setPending(combo);
        const action = chordActions[combo];
        timerRef.current = window.setTimeout(() => {
          if (pendingRef.current === combo) {
            action();
            setPending('');
          }
          timerRef.current = null;
        }, AMBIGUOUS_COMMIT_MS);
        return;
      }

      // Case: only a prefix. Extend pending and wait for completion.
      if (isPrefix) {
        e.preventDefault();
        clearTimer();
        setPending(combo);
        timerRef.current = window.setTimeout(() => {
          if (pendingRef.current === combo) {
            setPending('');
          }
          timerRef.current = null;
        }, CHORD_TIMEOUT_MS);
        return;
      }

      // Case: pending starts with a buffered nav letter (h/j/k/l). The
      // buffer accumulates taps as a string ("l", "ll", "lll" …) — on
      // timeout we fire that many actions. Until then:
      //   • same letter again → extend the buffer (defers nav).
      //   • different alphanumeric → open the chip prompt with the full
      //     buffer + new char (so "lda" → chip filter "lda", "lla" → "lla").
      //   • anything else (Esc, arrows…) → flush buffered nav actions and
      //     let the key fall through to normal handling.
      if (pending !== '' && NAV_DEFER.has(pending[0]) && pending.split('').every((c) => c === pending[0])) {
        const navLetter = pending[0];
        if (k === navLetter) {
          e.preventDefault();
          clearTimer();
          const next = pending + k;
          setPending(next);
          const action = actions[navLetter];
          timerRef.current = window.setTimeout(() => {
            if (pendingRef.current === next) {
              for (let i = 0; i < next.length; i++) action?.();
              setPending('');
            }
            timerRef.current = null;
          }, NAV_DEFER_MS);
          return;
        }
        if (/^[A-Za-z0-9]$/.test(k)) {
          e.preventDefault();
          clearTimer();
          const buffer = pending + k;
          setPending('');
          openCommandMode(buffer);
          return;
        }
        // Non-letter follow-up: flush buffered navs, then let `k` flow on.
        clearTimer();
        const action = actions[navLetter];
        for (let i = 0; i < pending.length; i++) action?.();
        setPending('');
      }

      // Case: no match. If pending was empty, try a single-key action.
      if (pending === '' && actions[k]) {
        // Defer the first press of h/j/k/l so a follow-up letter can open
        // the chip prompt instead. Held keys (event.repeat=true) bypass
        // the deferral so vim-style scrolling stays snappy.
        if (NAV_DEFER.has(k) && !e.repeat) {
          e.preventDefault();
          clearTimer();
          setPending(k);
          const action = actions[k];
          timerRef.current = window.setTimeout(() => {
            if (pendingRef.current === k) {
              action();
              setPending('');
            }
            timerRef.current = null;
          }, NAV_DEFER_MS);
          return;
        }
        e.preventDefault();
        actions[k]();
        return;
      }

      // Abandon any half-typed chord.
      clearTimer();
      if (pending !== '') {
        setPending('');
      }

      // --- helpers ---
      function colPath(): string {
        return tab.trail[lastCol(tab)];
      }
      function getEntries(): Entry[] {
        return visibleEntries(cur.entriesByPath[colPath()], tab);
      }
      function moveSelection(d: number) {
        const col = lastCol(tab);
        const entries = getEntries();
        if (entries.length === 0) return;
        const cur_ = tab.selected[col] ?? 0;
        const next = Math.max(0, Math.min(entries.length - 1, cur_ + d));
        setTab({ selected: { ...tab.selected, [col]: next } });
      }
      function moveSelectionAbs(t: number) {
        const col = lastCol(tab);
        const entries = getEntries();
        if (entries.length === 0) return;
        const next = Math.max(0, Math.min(entries.length - 1, t));
        setTab({ selected: { ...tab.selected, [col]: next } });
      }
      function movePage(mult: number) {
        const rows = Math.round(20 * Math.abs(mult)) * Math.sign(mult);
        moveSelection(rows);
      }
      // Count visible column tracks in the current grid view by reading
      // the computed grid-template-columns. Returns 1 if grid isn't mounted
      // (e.g. list view) so arrow keys fall back to linear motion.
      function gridCols(): number {
        if (tab.viewMode === 'list') return 1;
        const el = document.querySelector<HTMLElement>('.grid');
        if (!el) return 1;
        const tmpl = getComputedStyle(el).gridTemplateColumns;
        const n = tmpl.split(' ').filter((s) => s.trim().length > 0).length;
        return Math.max(1, n);
      }
      // Arrow keys always navigate the view (grid: prev/next tile in the
      // row; list: prev/next entry). Entering a folder is Enter / double-
      // click only; parent is Backspace (or h / ArrowUp on first grid row).
      function gridArrowHoriz(dir: 1 | -1) {
        moveSelection(dir);
      }
      // Arrow keys never OPEN files (Enter does that). But ArrowUp at the
      // topmost cursor position is treated as "go up a level" — natural
      // navigation when there's nowhere further to scroll. List view: row 0.
      // Grid view: any tile in the first row.
      function gridArrowVert(dir: 1 | -1) {
        const col = lastCol(tab);
        const cur_ = tab.selected[col] ?? 0;
        const cols = tab.viewMode === 'list' ? 1 : gridCols();
        if (dir < 0 && cur_ < cols) {
          goLeft();
          return;
        }
        moveSelection(dir * cols);
      }

      function goRight() {
        const entries = getEntries();
        const entry = entries[tab.selected[lastCol(tab)] ?? 0];
        if (!entry) return;
        if (entry.kind === 'dir') openPath(entry.path);
        else fm.open(entry.path);
      }
      function goLeft() {
        // marks are scoped to the cwd (fm-pcs) — wipe on any cwd change.
        // Every trail mutation pushes the prior trail onto history so the
        // Back button / H undoes it, and clears forward per standard
        // browser-style back-stack semantics.
        if (tab.trail.length === 1) {
          const parent = dirname(tab.trail[0]);
          if (parent !== tab.trail[0]) {
            setTab({
              trail: [parent],
              selected: { 0: 0 },
              marks: {},
              history: [...tab.history, tab.trail],
              forward: [],
            });
          }
          return;
        }
        const newTrail = tab.trail.slice(0, -1);
        const newSel = { ...tab.selected };
        delete newSel[tab.trail.length - 1];
        setTab({
          trail: newTrail,
          selected: newSel,
          marks: {},
          history: [...tab.history, tab.trail],
          forward: [],
        });
      }
      function toggleMark() {
        const col = lastCol(tab);
        const entries = getEntries();
        const entry = entries[tab.selected[col] ?? 0];
        if (!entry) return;
        const marks = { ...tab.marks };
        if (marks[entry.path]) delete marks[entry.path];
        else marks[entry.path] = true;
        setTab({ marks });
        moveSelection(+1);
      }
      function toggleSelectAllCol() {
        const entries = getEntries();
        if (entries.length === 0) return;
        const allMarked = entries.every((e) => tab.marks[e.path]);
        const marks = { ...tab.marks };
        if (allMarked) {
          for (const e of entries) delete marks[e.path];
        } else {
          for (const e of entries) marks[e.path] = true;
        }
        setTab({ marks });
      }
      function invertMarks() {
        const entries = getEntries();
        const marks = { ...tab.marks };
        for (const ent of entries) {
          if (marks[ent.path]) delete marks[ent.path];
          else marks[ent.path] = true;
        }
        setTab({ marks });
      }
      function selectedPaths(): string[] {
        const marked = Object.keys(tab.marks);
        if (marked.length > 0) return marked;
        const entries = getEntries();
        const entry = entries[tab.selected[lastCol(tab)] ?? 0];
        return entry ? [entry.path] : [];
      }
      function yankSelection(mode: YankMode) {
        const paths = selectedPaths();
        dispatch({ type: 'setYank', yank: paths.map((p) => ({ path: p, mode })) });
        const verb =
          mode === 'copy' ? 'yanked' : mode === 'move' ? 'cut' : `queued for ${mode}`;
        dispatch({
          type: 'setStatus',
          msg: `${verb} ${paths.length} item${paths.length === 1 ? '' : 's'}`,
        });
      }
      function yankPathText(kind: 'full' | 'name' | 'stem' | 'dir') {
        const paths = selectedPaths();
        if (paths.length === 0) return;
        const transform = (p: string) => {
          if (kind === 'name') return basename(p);
          if (kind === 'dir') return dirname(p);
          if (kind === 'stem') {
            const n = basename(p);
            const i = n.lastIndexOf('.');
            return i > 0 ? n.slice(0, i) : n;
          }
          return p;
        };
        const text = paths.map(transform).join('\n');
        fm.clipboardWrite(text);
        dispatch({ type: 'setStatus', msg: `copied ${kind} of ${paths.length} item${paths.length === 1 ? '' : 's'}` });
      }
      async function paste(overwrite: boolean) {
        const dst = colPath();
        const yank = cur.yank;
        // fm-294 — move is destructive (originals disappear from source).
        // Confirm before letting pp / po actually run the paste.
        if (yank.length > 0 && yank[0].mode === 'move') {
          const names = yank.map((y) => basename(y.path));
          const head = names.slice(0, 5);
          const more = names.length > 5 ? names.length - 5 : 0;
          const detail =
            head.join(', ') + (more > 0 ? ` and ${more} more` : '');
          const fromDir = dirname(yank[0].path);
          const body =
            `From  ${fromDir}\n  →   ${dst}\n\n${detail}`;
          window.dispatchEvent(
            new CustomEvent('fm:confirm', {
              detail: {
                title: `Move ${yank.length} item${yank.length === 1 ? '' : 's'}?`,
                body,
                confirmLabel: 'Move',
                destructive: false,
                confirmShortcuts: ['m'],
                onConfirm: async () => {
                  await runPaste({ yank, cwd: dst, overwrite, dispatch, refreshActive });
                },
              },
            }),
          );
          return;
        }
        await runPaste({
          yank,
          cwd: dst,
          overwrite,
          dispatch,
          refreshActive,
        });
      }
      async function pasteLinks(mode: 'symlink' | 'symlinkRel' | 'hardlink') {
        const dst = colPath();
        const sources = selectedPaths();
        if (sources.length === 0 && cur.yank.length === 0) {
          dispatch({ type: 'setStatus', msg: 'nothing to link' });
          return;
        }
        const picks = cur.yank.length > 0 ? cur.yank.map((y) => y.path) : sources;
        try {
          await fm.paste(picks.map((src) => ({ src, dst, mode })));
          await refreshActive();
          dispatch({ type: 'setStatus', msg: `${mode} × ${picks.length}` });
        } catch (err) {
          dispatch({ type: 'setStatus', msg: `link failed: ${(err as Error).message}` });
        }
      }
      function trashSelection() {
        const paths = selectedPaths();
        if (paths.length === 0) return;
        // fm-294 — never delete without confirm. Mirror ChipPrompt's
        // delete-verb payload so dD / dF show the same dialog as the
        // 'delete' verb in the chip prompt.
        const names = paths.map((p) => basename(p));
        const noun = paths.length === 1 ? `“${names[0]}”` : `${paths.length} items`;
        const head = names.slice(0, 5);
        const more = names.length > 5 ? names.length - 5 : 0;
        const detail =
          paths.length > 1
            ? head.join(', ') + (more > 0 ? ` and ${more} more` : '')
            : '';
        const body = detail
          ? `Move ${noun} to the trash. You can restore from Finder.\n${detail}`
          : `Move ${noun} to the trash. You can restore from Finder.`;
        window.dispatchEvent(
          new CustomEvent('fm:confirm', {
            detail: {
              title: 'Move to trash?',
              body,
              confirmLabel: 'Trash',
              destructive: true,
              confirmShortcuts: ['d'],
              onConfirm: async () => {
                try {
                  await fm.trash(paths);
                  setTab({ marks: {} });
                  await refreshActive();
                  dispatch({
                    type: 'setStatus',
                    msg: `trashed ${paths.length} item${paths.length === 1 ? '' : 's'}`,
                  });
                } catch (err) {
                  dispatch({
                    type: 'setStatus',
                    msg: `trash failed: ${(err as Error).message}`,
                  });
                }
              },
            },
          }),
        );
      }
      function promptRenameCurrent(mode: 'full' | 'beforeExt' | 'append' | 'prepend') {
        const entries = getEntries();
        const entry = currentEntry(tab, entries);
        if (entry) promptRename(entry, mode);
      }
      function clearTagOfCurrent() {
        const entry = currentEntry(tab, getEntries());
        if (entry) dispatch({ type: 'setTag', path: entry.path, tag: null });
      }
      async function revealCurrent() {
        const entry = currentEntry(tab, getEntries());
        if (entry) await fm.reveal(entry.path);
      }
      function setSort(key: SortKey, reverse: boolean) {
        setTab({ sortKey: key, sortReverse: reverse });
        dispatch({ type: 'setStatus', msg: `sort: ${key}${reverse ? ' ↓' : ' ↑'}` });
      }
      void pathJoin;
    }

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      clearTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id]);

  return null;
}
