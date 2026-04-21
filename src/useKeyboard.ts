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
const ANY_PREFIXES = ["'", '`', 'm', 'um', 't'];

// Prefixes that aren't themselves actions but need to be reachable so the
// <any>-consuming handlers above can fire.
const EXTRA_PREFIXES = ['um'];

// Timeout (ms) for committing an ambiguous chord that is both a complete
// action and a prefix of a longer one. e.g. gd is "cd /dev" but also the
// start of gdoc/gdat/…; we wait this long before firing gd.
const AMBIGUOUS_COMMIT_MS = 500;

// Timeout for abandoning an unfinished chord.
const CHORD_TIMEOUT_MS = 1000;

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
        return;
      }

      const k = keyName(e);

      // --- <any>-consuming pending chords ---
      if (pending === 'g' && /^[1-9]$/.test(k)) {
        e.preventDefault();
        clearTimer();
        dispatch({ type: 'selectTab', index: Number(k) - 1 });
        setPending('');
        return;
      }
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
      if (pending === 't') {
        e.preventDefault();
        clearTimer();
        const entries = visibleEntries(cur.entriesByPath[tab.trail[lastCol(tab)]], tab);
        const entry = currentEntry(tab, entries);
        if (entry) {
          dispatch({ type: 'setTag', path: entry.path, tag: k === ' ' ? null : k });
        }
        setPending('');
        return;
      }

      // --- Single-key (non-chord) actions ---
      const actions: Record<string, () => void | Promise<void>> = {
        j: () => moveSelection(+1),
        ArrowDown: () => moveSelection(+1),
        k: () => moveSelection(-1),
        ArrowUp: () => moveSelection(-1),
        h: () => goLeft(),
        ArrowLeft: () => goLeft(),
        l: () => goRight(),
        ArrowRight: () => goRight(),
        Enter: () => goRight(),
        Backspace: () => goLeft(),
        G: () => moveSelectionAbs(+Infinity),
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
        //   • n / N — repeat last find (motion)
        //   • / — live find prompt (search-as-motion; documented exception)
        //   • Space — toggle mark on cursor item (selection)
        //   • S-Space — toggle select-all in active column (selection)
        //   • : — open command mode
        //   • ! — open shell prompt
        //   • F7 — mkdir (function key, not a letter — escape hatch)
        //   • C-r — refresh (modified, not single-letter)
        // Removed letter actions (now reachable via palette): v, f, s, R, a, A, I.
        '/': () => dispatch({ type: 'setMode', mode: 'find', buffer: '' }),
        n: () => repeatFind(+1),
        N: () => repeatFind(-1),
        ':': () => dispatch({ type: 'setMode', mode: 'command', buffer: '' }),
        '!': () => promptShell(),
        ' ': () => toggleMark(),
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
        gg: () => moveSelectionAbs(0),
        // quick cd (ranger defaults)
        gh: () => fm.homedir().then(navigateTo),
        'g/': () => navigateTo('/'),
        gr: () => navigateTo('/'),
        ge: () => navigateTo('/etc'),
        gu: () => navigateTo('/usr'),
        gd: () => navigateTo('/dev'),
        go: () => navigateTo('/opt'),
        gv: () => navigateTo('/var'),
        gp: () => navigateTo('/tmp'),
        gs: () => navigateTo('/srv'),
        gm: () => navigateTo('/media'),
        gM: () => navigateTo('/mnt'),
        // user's custom goto (from ~/.config/ranger/rc.conf)
        gdoc: () => cdHome('Documents'),
        gdes: () => cdHome('Desktop'),
        gdow: () => cdHome('Downloads'),
        gcli: () => cdHome('Desktop/Prototypes/cline-starter-kit'),
        gdat: () => cdHome('Documents/Data'),
        gzid: () => cdHome('Documents/zi_data'),
        gpda: () => cdHome('Documents/zi_data/Product Data Analysis'),
        gscr: () => cdHome('Documents/Screenshots'),
        gacv: () => cdHome('Documents/zi_data/ACV Prediction'),
        // tabs
        gn: () => {
          fm.homedir().then((home) => {
            dispatch({
              type: 'newTab',
              tab: {
                id: crypto.randomUUID(),
                trail: [home],
                selected: { 0: 0 },
                marks: {},
                sortKey: 'name',
                sortReverse: false,
                showHidden: false,
                viewMode: 'list',
                filter: '',
                history: [],
                forward: [],
              },
            });
          });
        },
        gc: () => dispatch({ type: 'closeTab', index: cur.activeTab }),
        gw: () => dispatch({ type: 'closeTab', index: cur.activeTab }),
        gt: () =>
          dispatch({
            type: 'selectTab',
            index: (cur.activeTab + 1) % cur.tabs.length,
          }),
        gT: () =>
          dispatch({
            type: 'selectTab',
            index: (cur.activeTab - 1 + cur.tabs.length) % cur.tabs.length,
          }),
        ga: () => dispatch({ type: 'restoreTab' }),
        uq: () => dispatch({ type: 'restoreTab' }),
        // file ops
        yy: () => yankSelection('copy'),
        dd: () => yankSelection('move'),
        dD: () => trashSelection(),
        dF: () => trashSelection(),
        pp: () => paste(false),
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
        zT: () =>
          dispatch({ type: 'setTheme', theme: cur.theme === 'dark' ? 'light' : 'dark' }),
        zf: () => dispatch({ type: 'setMode', mode: 'find', buffer: '' }),
        wl: () => { setTab({ viewMode: 'list' }); dispatch({ type: 'setStatus', msg: 'view: list' }); },
        wg: () => { setTab({ viewMode: 'grid' }); dispatch({ type: 'setStatus', msg: 'view: grid' }); },
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
      if (
        pending === '' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        k.length === 1 &&
        /^[A-Za-z0-9]$/.test(k) &&
        !actions[k]
      ) {
        e.preventDefault();
        clearTimer();
        dispatch({ type: 'setMode', mode: 'command', buffer: k });
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

      // Case: no match. If pending was empty, try a single-key action.
      if (pending === '' && actions[k]) {
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
      function goRight() {
        const entries = getEntries();
        const entry = entries[tab.selected[lastCol(tab)] ?? 0];
        if (!entry) return;
        if (entry.kind === 'dir') openPath(entry.path);
        else fm.open(entry.path);
      }
      function goLeft() {
        if (tab.trail.length === 1) {
          const parent = dirname(tab.trail[0]);
          if (parent !== tab.trail[0]) {
            setTab({ trail: [parent], selected: { 0: 0 } });
          }
          return;
        }
        const newTrail = tab.trail.slice(0, -1);
        const newSel = { ...tab.selected };
        delete newSel[tab.trail.length - 1];
        setTab({ trail: newTrail, selected: newSel });
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
        dispatch({ type: 'setStatus', msg: `copied ${kind} of ${paths.length} item(s)` });
      }
      async function paste(overwrite: boolean) {
        const dst = colPath();
        if (cur.yank.length === 0) {
          dispatch({ type: 'setStatus', msg: 'nothing to paste' });
          return;
        }
        try {
          await fm.paste(
            cur.yank.map((y) => ({ src: y.path, dst, mode: y.mode, overwrite })),
          );
          if (cur.yank[0].mode === 'move') dispatch({ type: 'setYank', yank: [] });
          await refreshActive();
          dispatch({ type: 'setStatus', msg: `pasted ${cur.yank.length} item(s)` });
        } catch (err) {
          dispatch({ type: 'setStatus', msg: `paste failed: ${(err as Error).message}` });
        }
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
      async function trashSelection() {
        const paths = selectedPaths();
        if (paths.length === 0) return;
        try {
          await fm.trash(paths);
          setTab({ marks: {} });
          await refreshActive();
          dispatch({ type: 'setStatus', msg: `trashed ${paths.length} item(s)` });
        } catch (err) {
          dispatch({ type: 'setStatus', msg: `trash failed: ${(err as Error).message}` });
        }
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
      function repeatFind(dir: number) {
        const q = cur.lastFind;
        if (!q) return;
        const entries = getEntries();
        if (entries.length === 0) return;
        const cur_ = tab.selected[lastCol(tab)] ?? 0;
        const needle = q.toLowerCase();
        const n = entries.length;
        for (let step = 1; step <= n; step++) {
          const idx = (cur_ + dir * step + n * 2) % n;
          if (entries[idx].name.toLowerCase().includes(needle)) {
            setTab({ selected: { ...tab.selected, [lastCol(tab)]: idx } });
            return;
          }
        }
        dispatch({ type: 'setStatus', msg: `no match for "${q}"` });
      }
      function cdHome(rel: string) {
        fm.homedir().then((h) => navigateTo(`${h}/${rel}`));
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
