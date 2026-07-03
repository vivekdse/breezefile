/*
 * HelpTour — slide-based help. Click "Help" in the status bar, run
 * the `:help` verb, or dispatch `fm:openHelp` with an optional
 * { slide: <id> } payload to land on a specific slide.
 *
 * Slide IDs are stable strings (see SLIDE_INDEX). Use them when wiring
 * deep-links from empty states or other surfaces:
 *
 *   window.dispatchEvent(new CustomEvent('fm:openHelp', { detail: { slide: 'tasks-intro' } }));
 *
 * MAINTENANCE: every time we add a new feature or verb, this file gets
 * an update. Add a row to the right slide's verbs array (or add a new
 * slide if it's a new category). See CLAUDE.md.
 */

import { useEffect, useState } from 'react';
import { useOverlayExit } from '../useOverlayExit';
import { useIsMac, fmtKeys } from '../platform';
import { fm } from '../bridge';
// task-b79d10308ffd — registry-backed catalog rows. The curated rows below
// keep their hand-written prose, chords (gg/G, dD/dF…), and non-verb rows
// (cursor motion, mark/all); helpRowsForCategories() derives the *remaining*
// verbs from the SAME verbCatalog.mjs the palette + native menu use, so a newly
// added verb shows up in help without a hand edit and can't silently drift.
import { helpRowsForCategories } from '../verbCatalog.mjs';
import './HelpTour.css';

export type HelpSlideId =
  | 'value'
  | 'verbs'
  | 'navigate'
  | 'select'
  | 'share'
  | 'editor'
  | 'view-sort'
  | 'tags'
  | 'tasks-intro'
  | 'tasks'
  | 'tasks-auto'
  | 'remote'
  | 'tabs';

declare const __APP_VERSION__: string;

function cmpVersion(a: string, b: string): number {
  const norm = (v: string) =>
    v.replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const A = norm(a);
  const B = norm(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const da = A[i] ?? 0;
    const db = B[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

type VerbItem = { name: string; chord?: string; what: string };
type CatalogSlide = {
  kind: 'catalog';
  id: HelpSlideId;
  section: string;
  glyph: string;
  title: string;
  lede: string;
  verbs: VerbItem[];
  // task-b79d10308ffd — when present, registry-backed rows for these catalog
  // categories are auto-appended from verbCatalog.mjs, SKIPPING the verb ids in
  // `covers` (already represented by a curated row above). A new verb in one of
  // these categories — not in `covers` — auto-surfaces here without a hand edit.
  derive?: { categories: string[]; covers: string[] };
};
type NarrativeSlide = {
  kind: 'narrative';
  id: HelpSlideId;
  section: string;
  glyph: string;
  title: string;
  body: React.ReactNode;
};
type Slide = CatalogSlide | NarrativeSlide;

const SLIDES: Slide[] = [
  {
    kind: 'narrative',
    id: 'value',
    section: 'Welcome',
    glyph: '✦',
    title: 'Find files. Move them. Send them.',
    body: (
      <>
        Get anywhere in your files by typing. Then drag any file straight into
        a Slack message, a Gmail draft, or a web upload field —{' '}
        <b>no saving, no re-uploading</b>.
      </>
    ),
  },
  {
    kind: 'narrative',
    id: 'verbs',
    section: 'Welcome',
    glyph: '⌘',
    title: 'Type the action you want.',
    body: (
      <>
        Type <kbd>copy</kbd>, <kbd>move</kbd>, <kbd>tag</kbd>, or{' '}
        <kbd>share</kbd>. A small panel shows your choices. Pick one, hit{' '}
        <kbd>↵</kbd>. Every action works the same way — nothing to memorize.
        Prefer to browse? Press <kbd>⌘K</kbd> to open the{' '}
        <b>command palette</b> — every action in one searchable list, with its
        keyboard shortcut and category shown.
      </>
    ),
  },
  {
    kind: 'catalog',
    id: 'navigate',
    section: 'Files',
    glyph: '↕',
    title: 'Navigate & find',
    lede: 'Move the cursor; jump anywhere; search across folders.',
    verbs: [
      { name: 'cursor', chord: 'h j k l', what: 'left / down / up / right (or arrows)' },
      { name: 'open / parent', chord: '↵ / ⌫', what: 'enter folder / go up' },
      { name: 'top / bottom', chord: 'gg / G', what: 'first or last row' },
      { name: 'history', chord: 'H / L', what: 'back / forward' },
      { name: 'command palette', chord: '⌘K', what: 'browse / search every action in one list — shows each verb’s shortcut + category, ordered by what you use most' },
      { name: 'find', chord: '⌘F or /', what: 'recursive search across folders' },
      { name: 'go to / find', what: 'type a folder OR file name in the chip prompt — folder picks navigate, file picks open the file in its default app' },
      { name: 'goto home', chord: 'gh', what: 'jump to ~ (also g/, ge, gu, gd, gp…)' },
      { name: 'quick find', chord: 'f', what: 'jump to a row by typed prefix' },
    ],
  },
  {
    kind: 'catalog',
    id: 'select',
    section: 'Files',
    glyph: '☐',
    title: 'Select & manage files',
    lede: 'Mark with space, then act. Or run a verb directly on the cursor row.',
    verbs: [
      { name: 'mark / all', chord: 'space / ⇧space / ⌘A', what: 'toggle one / select every visible row' },
      { name: 'select', what: 'smart filters: images, videos, by extension, folders only…' },
      { name: 'select by expression', what: 'tag-algebra selector — mark rows matching e.g. `tag:cleanup and not tag:keep` or `ext = pdf and size > 1MB`; untick rows to spare them, then run a bulk verb' },
      { name: 'export list…', what: 'write the selected paths to a .txt (one per line) or .json file' },
      { name: 'trash (bulk)', what: 'a multi-row trash/move shows an aggregate confirm: "Will trash N files, X GB, oldest YYYY" before it runs' },
      { name: 'copy / cut', chord: '⌘C / ⌘X', what: 'stage files for copy / move; floating chip follows you to the destination' },
      { name: 'paste here', chord: '⌘V or ph', what: 'commit the staged copy/move (po, pl, phl variants)' },
      { name: 'rename', chord: 'F2 or cw / a / A / I', what: 'whole / before-ext / append / prepend' },
      { name: 'trash / delete', chord: 'dD / dF', what: 'send to Trash / permanent delete' },
      { name: 'create', chord: 'F7 or :touch', what: 'new folder / new file' },
      { name: 'note', chord: ':note', what: 'new date-named markdown note in ~/.breezefile/breeze notes — first `# heading` becomes the filename on save' },
      { name: 'notes', chord: ':notes', what: 'jump to the breeze notes folder' },
      { name: 'duplicate', what: 'right-click → Duplicate' },
    ],
    // Registry-backed Selection verbs. The curated rows above already cover
    // these (note: copy-path/drag-out/share are curated on the Share slide); a
    // NEW Selection verb auto-appends here.
    derive: {
      categories: ['Selection'],
      covers: [
        'select', 'select-expr', 'export-list', 'copy', 'move', 'paste',
        'delete', 'permanent-delete', 'copy-path', 'drag-out', 'share',
      ],
    },
  },
  {
    kind: 'catalog',
    id: 'share',
    section: 'Files',
    glyph: '↗',
    title: 'Open, share, drag out',
    lede: 'The drag-out is the whole reason this app exists.',
    verbs: [
      { name: 'open', chord: '↵', what: 'open with default app' },
      { name: 'open with…', what: 'pick an app; optionally bind it as default for that extension' },
      { name: 'drag out', chord: 'drag a row', what: 'grab any row with the mouse and drag it to Slack, Gmail, Finder, anywhere — drag-out is a pointer gesture, not a command (an OS-native drag can only begin from a real mouse drag). For a keyboard hand-off, use Export list… or Copy path instead.' },
      { name: 'share', what: 'native macOS share sheet (Mail, Messages, AirDrop, …)' },
      { name: 'copy path', chord: 'yp / yn / yd', what: 'full path / name / parent dir to clipboard' },
      { name: 'reveal', chord: 'R', what: 'reveal in Finder' },
      { name: 'open terminal', what: 'launch your default terminal in this folder' },
      { name: 'edit / :e', what: 'open the cursor file in a new in-app edit tab — markdown renders WYSIWYM via Milkdown (h1/strong/list styled by your theme; markers disappear as you type), other text gets a plain editor · ⌘S saves atomically · the tab title shows • when there are unsaved changes' },
      { name: 'open-editor', what: 'force-open the focused file in the in-app editor, even if another app is its default' },
      { name: 'save / :w', chord: '⌘S', what: 'save the current edit tab to disk' },
      { name: 'revert / reload', chord: '⌘R / Ctrl+R / F5 · ↻', what: 'reload the file from disk — discards unsaved changes (prompts if dirty). An edit tab also auto-refreshes when the file changes on disk underneath you (e.g. an agent editing it from the chat panel); your cursor and scroll position are kept approximately' },
      { name: 'close', what: 'close the current edit tab (prompts before discarding unsaved changes)' },
    ],
    // Registry-backed Files verbs. Curated rows here + on the Select/Editor
    // slides cover the current set; a NEW Files verb auto-appends here.
    derive: {
      categories: ['Files'],
      covers: [
        'open', 'open-with', 'edit', 'open-editor', 'editor-save',
        'editor-revert', 'editor-close', 'reveal', 'rename', 'create',
        'note', 'notes', 'compress', 'extract',
      ],
    },
  },
  {
    kind: 'catalog',
    id: 'editor',
    section: 'Files',
    glyph: '✎',
    title: 'Edit files in the app',
    lede: 'A themed in-app editor — markdown reads as a clean document, everything else gets a plain editor with a line-number gutter. The whole surface follows your theme (gutter, line numbers, selection, the current-line highlight all shift with light/dark and every palette).',
    verbs: [
      { name: 'open / edit', chord: '↵ / :e', what: 'open the cursor file in a new in-app edit tab — markdown (.md / .mdx) renders WYSIWYM via Milkdown (headings, bold, lists styled by your theme; the markup disappears as you type), any other text file gets a plain editor with a line-number gutter and a current-line highlight' },
      { name: 'open-editor', what: 'force-open the focused file in the in-app editor even when another app is its default' },
      { name: 'editable file types', what: 'which extensions open in the in-app editor (vs. the OS default app) is a settings-driven list — Settings → Editor seeds md/mdx/txt/json/yaml/code/etc. and lets you add or remove extensions · double-clicking (or ↵ on) an editable file opens an edit tab; anything not on the list opens in your default app · right-click a file for Open in Breeze Editor / Open in Default App' },
      { name: 'source-mode markdown', what: 'a markdown file Milkdown can\'t render (e.g. a malformed GFM table) automatically falls back to the plain source editor so the raw markdown is always editable instead of a blank pane' },
      { name: 'save / :w', chord: '⌘S', what: 'save the current edit tab to disk · saves are atomic (tmp-file + rename) and refuse to clobber a file changed on disk since you opened it · edits also autosave a beat after you stop typing' },
      { name: 'revert / reload', chord: '⌘R / Ctrl+R / F5 · ↻', what: 'reload the file from disk, discarding unsaved changes (prompts first if the buffer is dirty) · an edit tab also auto-refreshes when the file changes on disk underneath you (e.g. an agent editing it from the chat panel), keeping your cursor and scroll roughly in place' },
      { name: 'dirty indicator', what: 'unsaved changes show a • dot next to the filename (and on the tab) plus an "Editing… / Saving…" note in the header; the dot clears once the save lands' },
      { name: 'close', what: 'close the current edit tab — prompts before discarding unsaved changes' },
    ],
  },
  {
    kind: 'catalog',
    id: 'view-sort',
    section: 'Files',
    glyph: '▦',
    title: 'View & sort',
    lede: 'Switch how the folder reads, sort by anything, change the look. Choices stick — the next time you open this folder, your sort/view/hidden/folders-first settle back to what you last picked here.',
    verbs: [
      { name: 'view', chord: 'wl / wg / wp / wt', what: 'list / grid / preview / tag' },
      { name: 'sort', chord: 'on / os / om / oc / ot / oe', what: 'name / size / mtime / ctime / type / ext (caps for desc, or for reverse)' },
      { name: 'hidden', chord: '⌘⇧.', what: 'show / hide dotfiles (sticks per folder)' },
      { name: 'folders first', chord: 'zd', what: 'pin folders to the top (default) or interleave with files — turn off in Downloads to see newest items without folders crowding the top' },
      { name: 'theme', chord: 'zT', what: 'cycle dark/light; or :theme for the full picker' },
    ],
    // Registry-backed View verbs. The tag verbs live on the Tags slide and the
    // window verbs on the Tabs slide; a NEW View verb auto-appends here.
    derive: {
      categories: ['View'],
      covers: [
        'view', 'sort', 'showHidden', 'foldersFirst', 'theme',
        'tag', 'untag', 'newtag', 'dsltag', 'filter',
        'sidebyside', 'maximize', 'fullscreen',
      ],
    },
  },
  {
    kind: 'catalog',
    id: 'tags',
    section: 'Tags',
    glyph: '◐',
    title: 'Tags — color, group, filter',
    lede: 'Press wt to enter Tag view. Tags are rules over file metadata.',
    verbs: [
      { name: 'tag view', chord: 'wt', what: 'replaces preview with the tag inspector' },
      { name: 'apply HUD', chord: 't', what: 'in tag view: type to find a tag, ↵ to add or remove on the whole folder' },
      { name: 'newtag', what: 'create a tag with a rule (extension / size / modified / name) or manual-only' },
      { name: 'dsltag', what: 'create/edit a tag from a selector query (e.g. ext = pdf and size > 4MB; supports and/or/not, comparisons, tag:other) — validated live; toggle Live ↔ Frozen (Frozen pins a snapshot of the matching paths at save time) and re-snapshot on demand' },
      { name: 'describe (AI)', chord: '⌘↵ in the box', what: "in the DSL-tag editor, type a plain-English description (e.g. “old screenshots taking up space”) and Generate — an in-app, metadata-only LLM compiles it into a selector plus a suggested name and color, which you inspect (with a live match count) before applying. Nothing is tagged until you save. Needs an Anthropic API key (set it in Settings → AI, or via the ANTHROPIC_API_KEY env var); without one the box is disabled. Only file metadata (names/sizes/dates) is sent — never file contents." },
      { name: 'refine (AI)', what: 'in the generated match list, tick the files that should NOT be tagged and press Refine — those rejections are sent back as negative examples and the LLM rewrites the rule to exclude them while keeping the rest. The tag stays a single clean rule; rejections are never stored as per-file exceptions.' },
      { name: 'AI API key', what: 'Settings → AI holds the Anthropic API key that powers Describe (AI)/Refine (AI). The field is masked (Show toggles reveal) and the key is stored only on this machine (userData/llm.json) — Save enables the Describe box immediately, Clear removes it. An ANTHROPIC_API_KEY env var, if set, takes precedence over the saved key.' },
      { name: 'filter-tab', what: 'open a selector as a live smart-folder tab — lists every file matching it across your home (recursively), re-evaluated each time you open the tab' },
      { name: 'tag / untag', what: 'add or remove a tag from every file in this folder (verb form)' },
      { name: 'filter', what: 'narrow the folder to files carrying selected tags · Match all / Match any' },
      { name: 'access keys', what: 'each tag gets a single letter (r=Recent, l=Large, i=Images…) shown in the inspector' },
    ],
  },
  {
    kind: 'narrative',
    id: 'tasks-intro',
    section: 'Tasks',
    glyph: '✓',
    title: 'Tasks: a list, or an agent that runs it.',
    body: (
      <>
        Tasks are the point. <b>Home</b> is what greets you on launch — your
        tasks, ranked by what needs you, with each project shown as a{' '}
        <b>folder</b> (the file manager is one ability beside it, a tab-click /{' '}
        <kbd>files</kbd> away). Type <kbd>task</kbd> anywhere to add one; type{' '}
        <kbd>home</kbd> to return. Two ways to use tasks:
        <br /><br />
        <b>By hand</b> — keep a list of what you owe. Navigate Home with the
        arrow keys, or open the flat list with <kbd>tasks</kbd>; mark
        them done as you go.
        <br /><br />
        <b>On a schedule</b> — flip <b>⚡ Auto</b> on a task and an AI agent
        (Claude Code today; Codex / Gemini coming) runs it for you when it's
        due. Every run is logged with status, duration, and a resumable trace.
        <br /><br />
        Next two slides: everyday use, then automation.
      </>
    ),
  },
  {
    kind: 'catalog',
    id: 'tasks',
    section: 'Tasks',
    glyph: '✓',
    title: 'Everyday tasks',
    lede: 'Create, view, and act on tasks. Most days you live in the Tasks tab.',
    verbs: [
      { name: 'task', what: 'open the inline composer · type a title and ↵ to save · ⇥ walks into the detail pills (folder · when · executor · auto), ↑/↓/↵ pick within a pill, ⌘. skips a pill, esc cancels · same composer handles edit, pre-filled with all current values · a Details panel below the four questions exposes status, start date, pin, notes, and (for Claude tasks) an agent-prompt override' },
      { name: 'composer keys', what: 'inside the New/Edit task composer: ↑/↓ walk the questions, digits pick an option, ↵ pick+advance, ⌘↵ create at any time · the focused field shows a clear label at its top-left (Who runs this · Project · Folder · Notes · …) and scrolls to the top of the view when you activate it, so its options are in sight without scrolling · start date defaults to today on new tasks · the due question shows quick-pick chips — 1 week (W) · this Friday (F) · Monday (M) — for manual tasks · in the notes field plain ↵ adds a newline and ⌘↵ jumps to the next field instead of creating · for a TypeBuild task the second question is Project — the task’s CURRENT project comes first and focused (↵ confirms it), then your top 3 busiest other projects, then None, then “Other…” which opens a type-ahead over every project (↑↓/↵, Esc back); digits pick the short list. Opening + New task from a folder that belongs to a project AUTO-ATTACHES that project — it shows as a chip (“auto-attached from <folder>”) so it’s visible, not magic, and you can override or pick None; the chosen project rides the create and editing a TypeBuild task can change it too · after Priority a TypeBuild task offers an AGENT picker — assign the task to ONE agent (or None): each option shows the agent’s name + its launch mode (chrome / auto / resume / manual); ↑/↓ + ↵ or digits pick, None clears the assignment · agents with no group still list; the chosen agent rides the create and editing a TypeBuild task can change it too. The assigned agent (name + launch mode) then shows as a read-only Agent line in the task’s detail panel' },
      { name: 'project task', what: 'creating a task scoped to a project now uses the SAME composer as everything else — there is no separate flow. On Home, drill into a project (→/Enter) and use the ＋ New task button in its folder header (or type “new task”) to open the composer with that project PRE-SELECTED; the project rides the create and carries its folder + cascading instructions as agent context. Opening + New task from a folder that belongs to a project also auto-attaches that project. Either way you can override the project or pick None.' },
      { name: 'tasks (flat view)', what: 'Home shows your tasks BY PROJECT (as folders); :tasks (aliases all tasks / task list) opens the FLAT view — every task in one inbox, kept as a secondary surface. Split layout (list + detail panel) organized by OWNER: FOR YOU (manual tasks you act on by hand) · FOR AGENTS (tasks an agent runs for you) · DONE (collapsed, most-recent first) · one filter row: search, Show done, Mine (only TypeBuild tasks you’ve claimed — local tasks unaffected), source dropdown (All / TypeBuild), + New task · checkbox + arrow-key selection, all bulk actions via verbs · the header digest also carries a clickable “⚠ N stalled” chip when any task is STRANDED (in progress with no active worker) — click it to filter the list to exactly those, click again to clear' },
      { name: 'home', what: 'Home is the tasks-first landing — it OPENS FOCUSED when the app launches (the file manager is still there beside it, one tab-click / :files away; the file surface is now ONE ability, not the point). The chrome is one collapsed row: a “Type.Build” wordmark + a permanent Home button on the left, tabs right-aligned on the same row. Your work is shown as FOLDERS: each project is now a COMPACT ONE-LINE ROW — name on the left, a status glyph + counts (sub-projects · tasks · ⚑ N need you) on the right — exactly like a folder row in the file manager, with NO task list shown inline. Opening a project (→/Enter/click) drills in to reveal its tasks and sub-projects, just like opening a folder. Projects are attention-ranked: the ones needing a human/agent lead, with the hero line up top (“7 tasks need you, 2 blocked — Open X first →”), and — whenever any task is waiting on YOUR answer — a dedicated “⁇ N questions waiting on you →” hero sits ABOVE it (only when N > 0): click it to drop in a CROSS-PROJECT list of every task an agent has asked you about (ask_user), so you can answer them all in ONE place — click a row’s “?” (or its question line) and reply inline (text + ↵, or an option chip) without opening each project (a pending question is the loudest signal — a human-only unblock — so it outranks blocked/failed in the ranking); projects that need nothing right now sit below a “nothing needs you below” fold, and quiet ones hide behind “Show all projects (N hidden)”. Each project row’s status glyph (⛔ blocked · ⚑ needs you · ◷ working · ◦ quiet) carries a hover tooltip naming the state. The “⚑ N need you” count is CLICKABLE — on a project row, in the hero line, and in a drilled-in project’s folder header — and drills into that project with its task list FILTERED to exactly those N tasks (open / blocked / overdue / failed, the same tally that produced the count, so the list and the number can never disagree). A “⚑ Needs you · N” chip then sits above the list; click it (the ✕) to clear the filter and show every task again. Project-less tasks gather in a synthetic “Inbox (no project)” block, always first. A “Projects first / Tasks first” toggle switches the root between the project-folder list and the flat all-tasks inbox, and is remembered across sessions. The surface wears the same gradient-blob plate look as the files view.' },
      { name: 'home keys', what: 'Home navigates with the ARROW KEYS — one flat cursor walks the project rows: ↑/↓ move · Home / End jump to first / last · → (or Enter) open a project (drills in to its tasks + sub-projects) · ← (or Esc) back one level. The vim single-key motions are GONE on Home: EVERY printable letter/number type-to-commands — just START TYPING any word (groceries, logs, help, kanban) opens the unified quick-switcher seeded with what you typed (so no letter is reserved) · / opens it empty · : opens the command palette (verbs: New task, New project, and bulk task actions on a selection). Inside a drilled-in project the cursor also walks task rows: Enter (or double-click) on a task row opens its EDIT FORM — the SAME shared composer as New task, with full keyboard (↑/↓ walk questions, digits pick, ↵ advance, ⌘↵ save) · Space selects a task and : acts on the selection (:done :reopen :in-progress :cancel :pin :unpin :delete). The breadcrumb (shown only once drilled in) is the project ancestor chain (Home › Acme › Onboarding); the permanent Home button in the titlebar always returns you to the root.' },
      { name: 'type-to-command', what: 'on Home just START TYPING — any letter or number opens the UNIFIED quick-switcher seeded with that character (press ⌘F / Ctrl+F to open it empty — / now opens the AI copilot chat). It is VERB-AWARE, exactly like the file manager, and blends, top-to-bottom: COMMANDS (matching verbs — New task, New project, and top-level verbs like Secrets / Open, ranked the same way the ⌘K palette ranks them) then PROJECTS (name/description) then TASKS (title). ↑/↓ (or ⌃n/⌃p) move · ↵ runs the highlighted thing — a command runs the verb (handed to the prompt for any follow-up slots), a project drills into it, a task NAVIGATES to the Tasks tab focused on that row (it does NOT fork or start the task) · esc closes. An empty query shows just projects + tasks (browse all verbs from : / ⌘K). Each entity result shows its status glyph and folder-style project path.' },
      { name: 'archive a project', what: 'each compact project row on Home carries an archive action (⊟) on hover — and an ⊟ Archive / ↺ Unarchive button in the project’s drilled-in header bar — that moves it out of the way without deleting it. Archived projects are HIDDEN by default (the server omits them); a “Show archived” toggle below the list reveals them (the row reads struck-through and the action flips to ↺ Unarchive). The toggle is remembered across sessions.' },
      { name: 'add task / add project', what: 'creating things on Home is scoped to where you are. At the root, the header carries ＋ New task and ＋ New project. Drill INTO a project and its header bar carries ＋ New task (scoped to that project) and ＋ New sub-project (parented under it) — there is no per-row add button anymore. Typing “new task” / “new project” (type-to-command) and the :new-task / :new-project verbs do the same scoped thing.' },
      { name: 'new-task', what: 'verb (aliases new task / add task / create task / mktask): creates a task scoped to the project in view on Home — the open project when you have drilled in, otherwise unscoped — opening the shared composer with that project pre-selected · reachable by typing it on Home, from :, and from ⌘K.' },
      { name: 'new-project', what: 'verb (aliases add project / create project / mkproject / new sub-project): open Home and expand the inline create form — capture a name, an agent-facing description sentence, an optional parent project (making it a sub-project; auto-set to the open project when you have drilled in), and an optional folder/repo binding → creates the project via TypeBuild · ⌘↵ submits, Esc cancels · also reachable as the ＋ New project / ＋ New sub-project button on Home · surfaces on Home/Projects and folder tabs via : and ⌘K.' },
      { name: 'one primary action', what: 'every row shows exactly ONE primary button for what to do next — ✓ Done (manual) · ↺ Reopen · ▸ Start (TypeBuild) · ▸ Run now (auto) · ⧉ Open session (when a live session tab exists) · ◷ View run — everything else (pin, edit, open tab, status, due presets, go to folder, release, mark complete, cancel, reopen, delete) lives in the ⋮ kebab · a task someone else holds shows ◆ claimed by {who} (hover for who + how long ago, tinted when the claim is near expiry) and no action' },
      { name: 'row vocabulary', what: 'how to read a task row at a glance — DIMMED (dull) rows are CLOSED: done or cancelled (still open ones stay bright); hover a dimmed row for a tooltip telling you which (“Done — completed” vs “Cancelled — closed without completing”) · the colored STATUS DOT is the status signal — red ● pending · amber ● in progress · green ● done · grey ● cancelled (hover it for the label, the source-native status like failed/partial, AND how long it has held that status, e.g. “In progress for 6d”) · a RED RING on the dot + a “⚠ stalled” badge mark a STRANDED task — in progress but with no active worker (the worker crashed/quit or the 2h claim lapsed); open it to reset · a “?” in the ASK column marks a task WAITING ON YOUR ANSWER — an agent asked a question (ask_user) and nothing but your reply can unblock it; hover for a preview, and in list view the question TEXT replaces the folder line under the title (⁇ …) so you can read it without opening the row · CLICK the “?” badge OR the question line to expand a reply box RIGHT IN THE ROW — type your answer + ↵, or click an option chip when the agent offered choices; sending clears the question (the row drops out of “needs you”), and if you open the task the same reply lives in a pinned card at the top of the detail panel with who asked + when · ◆ = claimed (accent-colored when it’s yours; hover for who) · ★ = pinned · pills carry the rest: a “deferred until <date>” snooze, “⛓ waits on N” (deps unsatisfied), an overdue-red due date, ⏰ a local cron schedule, and “N runs” past auto-runs' },
      { name: 'tasks-tab verbs', what: 'chip prompt swaps in: :done :reopen :in-progress :cancel · :pin :unpin · :due / :start (Today / Tomorrow / Friday / Next week / Pick…) · :open task tab · :open-detail (task drawer) · :terminal · :claude / :codex / :gemini · :edit · :goto-folder · :delete · :sort · :show-completed · :select all/none/invert/overdue/pinned · (:group is gone — tasks are grouped by owner now)' },
      { name: 'tasks-tab keys', what: '↑/↓ or j/k move cursor · Shift+↑/↓ extend selection · Space toggle select · Enter edit (manual) / open the detail drawer (agent) · / focus search · [ / ] snooze due ∓1 day · w snooze due +7 days (snooze only acts on editable rows)' },
      { name: ':open-detail', what: 'verb (aliases inspect · detail · activity, or press Enter on a TypeBuild row / Open ↗ in the detail panel) — distinct from :open-task, which opens a TAB: opens the full task DIALOG — now FULL-SCREEN, segmented into Task details · Teach · Activity (number keys or h/l switch, Esc closes; task text is selectable/copyable) — the Activity tab only appears when there’s a run or session to show · TASK DETAILS is the FIRST tab and IS the task: it reuses the new-task composer form, pre-filled with the task’s current values (title, notes, who, when/due, defer, priority, project, status, pin) and fully EDITABLE — Save changes persists title, notes/body, AND routing-field edits (status · priority · due · defer · project) back via the TypeBuild PATCH (title + body are re-encrypted at rest; held in memory only, never logged); below the form sit the read-only schedule (recurring ↻ cron + next run), dependencies/parent-child, folder (instructions are NOT here any more — they live only in the Teach tab) · TEACH shows the EFFECTIVE INSTRUCTION SET as a provenance DOCUMENT — the resolved rules grouped by where they come from (Project → Category → This task, each titled with the originating parent) above a one-line summary (“8 — 4 project · 2 payer:HMO · 1 task”) — and below it a SCOPE PICKER (Project / Category / Task) where you write an instruction or correction and Save it to the scope you pick — defaults to the PROJECT when the task has one (the most reusable place to teach), else the TASK: THE PROJECT persists into the project’s instructions (owner-only — a project you don’t own declines, and PHI-shaped text is refused), THIS TASK persists as a per-task note (claim the task first; PHI-shaped text is refused), and A CATEGORY is kept for the current session only until its server store ships (the picker says so) · the tab shows what each scope ALREADY carries so you see what you’re adding to (this is text teaching — distinct from “teach by recording”, which captures BROWSER actions) · ACTIVITY clubs the run trace and the session together: the live (or replayable) terminal session up top — open the live session while in progress, or replay the last run — over the run timeline below (steps of a running/completed run, the in-flight step pulses); it’s shown only when there’s a run or session · the header shows the live status (working / needs-you / blocked) with a ◼ Stop control (s) for a running task and an ↳ Enter thread control (e) to get into the agent thread when a task is in progress or waiting on you' },
      { name: 'detail panel', what: 'the right pane shows the cursor task: manual tasks get dates, status chips, and notes that COLLAPSE past ~8 lines with a Show more expand + inner scroll (long notes are finally readable) · TypeBuild tasks lazy-load their decrypted body on focus (held in memory only, never logged) plus a VITALS block right under the title — TIME-IN-CURRENT-STATUS as a first-class line (“In progress · 6d (since Jun 22)”, tinted amber then red when it overstays with no live worker) and a “Last update 6d ago — released by vivek” line drawn from the task’s lifecycle audit (the real event times, NOT the list’s placeholder timestamps) · when a task is STRANDED (in progress, no active worker — crashed/quit or the 2h claim lapsed) a red “No active worker — looks stranded” banner appears with one-click Reset to open / Release claim · then a lifecycle block (status, Claimed — who + how long ago, flagged when the claim is near its 2h expiry — attempts/maxAttempts) with an editable Assignee (pick a teammate from the registry, or Unassigned) and a − N + Priority stepper, and the lifecycle verbs: Release (when you hold the claim) · Mark complete + Cancel (while the task is still open) · Reopen (for a done/partial/cancelled/failed/blocked task — reopening resets attempts and clears the last error) · Delete… (creator-only — a task you don’t own, or one in progress elsewhere, declines with a reason) · a MESSAGES feed — a shared, USER-facing status channel DISTINCT from the agent-progress notes/Details: an append-only, newest-last list of short updates (each showing who + how long ago), with a compose box to add your own — posting is NOT claim-gated (anyone who can see the task may chime in) and after you post the detail re-fetches so your message appears (⌘/Ctrl+↵ sends) · a Timeline section showing an always-visible “Last: …” one-liner even when collapsed, that lazy-loads the full lifecycle trace (Created → Claimed → status transitions, with who + when) as a clean vertical timeline on expand' },
      { name: 'remote sources', what: 'first turn on Settings → TypeBuild → “Enable TypeBuild” (off by default; the choice persists) — that reveals the sign-in, onboarding checklist, and side-by-side settings, and lights up a sign-in indicator in the left sidebar (a “TypeBuild · signed out” banner near the top whenever you’re signed out, plus a green/red TB status chip on the Active Tasks header) so you always know your session state · then one “Sign in” button opens your browser to the TypeBuild page, where you sign in with Google or email & password; the session comes back into the app automatically — and its tasks appear under FOR AGENTS · while signed in, + New task shows a “Save to” picker (TypeBuild + any connected hosts) and defaults to TypeBuild — the form drops Folder and adds Priority + a Defer-until date to match the TypeBuild fields; signed out, the picker is hidden and tasks save locally · titles/bodies stay in memory, never written to disk (PHI-safe); you can reassign, set priority, and delete a TypeBuild task you created · a failed/partial/blocked source status shows as a badge next to the title · the due-date pill shows for TypeBuild tasks too, and a deferred (snoozed) task shows a “deferred until <date>” pill · the ⋮ kebab carries Release (when you hold the claim), Mark complete, Cancel, Reopen, and Delete… · if a source can’t be reached the status line shows “tasks from TypeBuild unavailable: …” rather than silently emptying the list' },
      { name: 'Start a TypeBuild task', what: '▸ Start claims the task for you AND opens a Claude session in a new tab, pre-wired to the task — there is no separate Claim button anymore · you never type a command and the session starts already authenticated (no /mcp sign-in prompt), in Chrome mode (--chrome, so claude can drive the browser), and in a dedicated workspace (~/.breezefile/tasks/) whose .claude/settings.json pre-approves the TypeBuild + Chrome tools so /work runs end-to-end without stalling on a per-tool permission prompt — edit that file to grant more · enabled only when you’re signed in and the onboarding prerequisites pass (Settings → TypeBuild: Claude Code + Chrome); the disabled tooltip says what’s missing · Start on a task someone else grabbed shows an inline “couldn’t start · claimed by X” and spawns nothing · if TypeBuild can’t mint the session token, Start says why (sign in again / can’t reach TypeBuild / access changed) and no tab opens · once a session is open, that row’s primary action becomes ⧉ Open session (focus the tab) instead of a second Start · when the session ends (Ctrl-C / the agent finishing), a session you started from the Tasks tab returns you there rather than dropping you in the workspace folder · Release lives in the ⋮ kebab and when the session ends while you still hold the claim a prompt offers Release · the secure session token lasts ~8h and can’t refresh mid-session — TypeBuild warns before it expires and offers a one-click “Restart task” at expiry · PHI-safe — the tab is labelled generically and terminal scrollback is never written to disk' },
      { name: ':sidebyside', what: 'verb (aliases split/chrome/arrange): toggle the TypeBuild side-by-side layout — Google Chrome snaps to the left (default 67% of the work area, configurable in Settings → TypeBuild), TypeBuild to the right remainder, so you watch Claude drive the browser while you approve here · toggling off restores TypeBuild’s previous bounds · auto-enters when a TypeBuild session starts (Settings toggle, on by default) and exits when the session’s tab closes · Chrome positioning needs Accessibility on macOS / wmctrl or xdotool on X11; on Wayland or without a grant it degrades to snapping only TypeBuild’s window (snap Chrome yourself)' },
      { name: 'Schedule a remote task', what: 'TypeBuild has no scheduler, so TypeBuild can fire a remote task on a LOCAL cron · the ⋮ kebab on a TypeBuild row offers Schedule… — pick Daily 9am / Weekdays 9am / Hourly or type a custom 5-field cron (validated inline); an active schedule shows as a ⏰ pill on the row · when it fires, TypeBuild runs the task interactively (same as ▸ Start) — so the app must be open and signed in; if it can’t (signed out / app closed / token mint fails) the schedule rolls forward and a notification nudges you to open TypeBuild and sign in (PHI-safe — only an opaque short id is shown, never the title) · the overlay is PHI-free: it stores only the opaque task id + cron, never the title/body · caveat: a session left at the approval gate past TypeBuild’s 2h claim TTL can lose its claim to a teammate · stale schedules (task done/deleted server-side) prune themselves' },
      { name: 'task tab', what: 'tabs bound to a task swap to a focused shell: prominent header, Open Terminal + Claude/Codex/Gemini + Rerun buttons · launching an AI pre-types the task context into the prompt, sets BREEZE_TASK_ID, drops a sidecar at ~/.breezefile/active-tasks/<id>.md' },
      { name: 'task action zone', what: 'Settings → Task action zone tailors the launcher buttons in a task tab — uncheck a launcher to hide it from the action zone (it stays available everywhere else: the chip prompt, :claude/:codex verbs), and pick one as the Default to surface it as the full-width primary action (★ badge) with the rest below · no prefs = every launcher visible in normal order, no forced default · Reset clears both' },
      { name: 'run anywhere', what: 'every folder tab has a Run a task ▾ button in its pathbar (next to sort/find), or type :run in the chip prompt · tasks for this folder appear first, then folder-agnostic ones · runs use the active folder as cwd' },
      { name: 'folder task count', what: 'the folder header’s summary line (“N folders · M files…”) appends a “Z tasks” count when this folder has active tasks anchored to it — click it to open the Tasks tab pre-filtered to that folder' },
    ],
  },
  {
    kind: 'catalog',
    id: 'tasks-auto',
    section: 'Tasks',
    glyph: '⚡',
    title: 'Automation & runs',
    lede: 'Schedule a task, an agent runs it, every run is logged and resumable.',
    verbs: [
      { name: 'auto-execute', what: 'flip ⚡ Auto on a task and a registered agent (Claude Code first) runs it headlessly when due · scheduler retries on rate / usage errors and notifies on terminal failure · concurrent runs for the same task are refused server-side' },
      { name: 'recurrence', what: 'pick Daily 9am / Weekly Mon 9am / Custom cron… (raw 5-field expression) in the task composer · next_run_at recomputes after every successful run and clears when you mark the series done' },
      { name: 'run on save', what: 'agent-only When option that fires the task immediately after you create it · no cron, no schedule — one-shot kickoff' },
      { name: 'agent flags', what: 'on a Claude task the composer offers flags: Interactive (run opens in a new tab with an embedded claude session you converse and approve in, instead of headless), Chrome (let claude drive a browser, --chrome), Playwright (drive a side-by-side Breeze browser window over CDP — see “browser tool repository” below), Auto-accept (permissive edits, still human-gated) · an interactive cron fire opens a tab and pings you at the approval gate when the GUI is running; headless breezed falls back to a headless run' },
      { name: 'browser tool repository', what: 'a Playwright task drives a live side-by-side browser window AND consults a reusable-tool repository at ~/.breezefile/tools/ before writing one-off automation · the agent runs `breeze-tools available <url>` to find a matching tool, `help <id>` for its params, `run <id> --p v` to execute it (structured JSON + a 0–8 exit code: 0 ok · 4 auth · 5 page-changed · 7 precondition), falling back to raw page-driving only when no tool fits · ships with seed tools (gmail-prefill-send, web-form-login, extract-table); drop a `<id>/tool.json` + `tool.mjs` folder in to add your own · per-tool runs.jsonl tracks success rate · THE API SHORTCUT: the agent can read/replay the page’s own XHR/fetch and skip the rendered UI entirely — `net-observe [urlFilter]` watches the page’s requests (NON-PHI metadata: method/url/status, never bodies) to find which one carries the data, then `net-replay <url> [--method M]` re-issues it through your signed-in session (no clicks, no re-auth); a GET is a safe read, a mutating POST/PUT stays human-gated (refused without --allow-mutation) · SITE API RECALL: a discovered endpoint is remembered as a keys-only `api-spec` note keyed by domain (NON-PHI: method/path/header+param KEY names/me.* auth ref, never a value) — a successful `net-replay` auto-records it, `breeze-tools available <url>` auto-recalls it (surfaced as `api_specs` with `prefer_api:true` so the next task net-replays instead of re-driving), and `breeze-tools api-spec recall <url>` / `api-spec record --url … [--header n] [--param k] [--auth me.key]` are the first-class verbs · AUTO-PROMOTION: after the slow full-agent path solves a NEW page it auto-emits a reusable step-structured tool — `breeze-tools promote-from <id> --match <url> --actions <captured.json>` (or `--recording`) scaffolds a `status:candidate` tool (param/KEY refs only, never a value) that syncs to every runner and promotes itself to `active` after it passes a run or two; “support a new platform” = “run it once, keep the tool it leaves behind” · the agent also keeps durable NON-PHI memory via `breeze-tools memory` — `--site` notes (selectors, fast paths, gotchas for a domain) are now SHARED ONLINE, so a learning on one machine helps every machine + teammate, with a local cache for offline; `--task` notes stay local to this machine · the standing browser playbook (the operator instructions every session runs by) is now fetched from the server at session start — edit it once and every machine picks it up, with the bundled default + a cached copy as the offline fallback · the operator session is one window split into two panes — the browser page on the LEFT, the Claude-Code terminal on the RIGHT, with ONE divider you drag to resize both · before the agent’s first navigation the browser pane shows a calm “Starting your task…” splash (styled in your current theme) instead of a blank page, replaced the moment the agent opens its first real page · the — minimize button collapses the Claude pane (1/3 ↔ 0) and ✦ Claude re-shows it; the divider position + collapsed state persist across sessions · the ✕ close button ends the WHOLE session at once (it tears down the browser window AND the Claude PTY together, then offers to release the task if you still hold the claim)' },
      { name: 'teach by recording', what: 'in any embedded browser surface (an in-app tab OR the operator session pane — they share one toolbar now), click ● Rec to RECORD your own clicks/typing/navigation — the recorder captures every selector candidate for each element (role+accessible-name from the accessibility tree, data-testid, aria-label, visible text, a stable #id, an :nth fallback, and a full CSS path) plus a uniqueness count, then hands Claude Code each step as {action, url, candidates} so it can pick the MOST STABLE selector and save it as a reusable site skill · click ◼ Rec to stop and save · it records STRUCTURE only — your typed values never leave the page (a field is stored by its name/label as a placeholder key, never its content), so it’s PHI-safe · while recording, the human drives (the agent’s Playwright session pauses — the browser allows only one automation client at a time)' },
      { name: 'full-page screenshot → PDF', what: 'in any embedded browser surface (an in-app tab OR the operator session pane — they share one toolbar now), click ⇩ PDF next to ● Rec to auto-scroll the current page and save it as a multi-page PDF (one page per screen-height, in original resolution) · saved silently to ~/.breezefile/screenshots/ and revealed in your file manager when done · agents can trigger the same capture over HTTP (POST /app/browser/screenshot-pdf on the local api-server, no id needed while the operator pane is open — it defaults to the agent’s own browser) — handy for handing a Claude Code session a full-page reference of what it’s driving' },
      { name: 'save passwords', what: 'when you sign in to a site inside an embedded browser tab — or in the operator session window an agent drives — a Chrome-style “Save password for <user>@<site>?” prompt appears under the address bar · Save stores it encrypted on TypeBuild keyed by (site, username), Not now dismisses it, Never for this site stops asking for that origin this session · the password is masked with an eye-toggle and never written to disk, logs, or the agent’s view until you accept · saved logins live alongside your :secrets · on a return visit a 🔑 key button appears in the embedded browser toolbar (the same toolbar in an in-app tab OR the operator session pane) whenever the current site has a saved login — click it to fill (it never auto-pops a prompt in either surface); the password is resolved and injected in the background and never reaches the page UI or the agent' },
      { name: 'address-bar autocomplete', what: 'in any embedded browser surface (an in-app tab OR the operator session pane — they share one address bar now), typing in the URL field shows a ranked suggestion dropdown drawn from your VISITED-PAGE HISTORY plus a small list of common sites (🕘 history · 🌐 known) — prefix host matches first, then substring, more-visited + more-recent ranked higher · the most-likely host is also completed INLINE as a muted “ghost” after what you typed — press → or Tab (caret at the end) to accept it · keyboard: ↓/↑ move through the list (the bar fills with the highlighted URL), Enter navigates to the highlighted suggestion or to what you typed, Esc dismisses the dropdown · click a row to go there · PHI-safe — the history store keeps only plain http(s) URLs you navigated to (host/path + a visit count), never task text, form values, or credentials, and never anything but real page loads' },
      { name: 'sidebar indicators', what: 'Active Tasks sidebar shows per-task glyphs: due-now dot, running spinner, last-run-failed dot, ⚡ for auto · tasks anchored to the folder you’re browsing float to the top with a distinct folder icon + accent rail · an unseen-update badge on the Active Tasks header counts run completions + remote task changes you haven’t looked at, clearing when you open the Tasks page · right-click for Edit / Mark done / Pin / Snooze / Run now / View run history / Open last run in new tab / Delete' },
      { name: 'task notifications', what: 'Settings → Notifications → Task notifications picks how loud task events are: All (run successes/failures + remote TypeBuild changes), Failures only, or Off · a manual Run now stays quiet while a TypeBuild window is focused (you’re watching) but notifies if you tabbed away · remote-task notifications are PHI-safe — only an opaque short id, never the title' },
      { name: 'task start reminders', what: 'Settings → Notifications → Task start reminders surfaces a grouped notification on launch and daily (~8am) for tasks coming into play today: Off, Tasks starting today (default), or Starting today + due tomorrow · always grouped + PHI-safe — a generic count like “3 tasks start today”, never a task title · each task is reminded at most once per day, and that’s remembered across restarts (so a relaunch doesn’t re-ping you) · remote TypeBuild rows have no start date, so for those this fires on the due-tomorrow leg' },
      { name: 'run history', what: 'every auto run lands in a per-task history dialog: status, duration, attempt, conversation_id · Rerun button starts a fresh run · "Open run" spawns a new tab with an embedded terminal and auto-runs `claude --resume <id>` so you land directly in the trace' },
      { name: 'runs view', what: 'on the Tasks tab toggle from Tasks → Runs to see every recent run across every auto task in one feed · filter by status, search by title or folder, click a row to jump into that task’s history' },
      { name: ':remote-attach', what: 'verb (palette / chip prompt; aliases connect/attach): pick a host from your active sshfs mounts to connect it as a task SOURCE · the app installs + starts a persistent breezed daemon there (systemd --user, survives disconnect + reboot) and opens a forward ssh tunnel · that machine’s tasks appear under their own "<host>" section (group Tasks by Source) · creating a task in a folder under that host’s mount auto-routes it to that machine’s store with the real remote path · each machine owns + runs its own tasks (no sync) · "Connected hosts" in the sidebar lists them with a × to disconnect · AUTO-ATTACH: just navigating into a folder under an sshfs mount connects that host automatically (once per host per session) — you usually never need to run this verb manually' },
      { name: ':disconnect', what: 'verb (aliases detach/drop-host): pick a connected remote host to disconnect it — tears down the forward tunnel and removes its task section (the host’s breezed keeps running there). Same as the sidebar × · the row flashes red briefly so you see it go' },
    ],
  },
  {
    kind: 'narrative',
    id: 'remote',
    section: 'More',
    glyph: '⇄',
    title: 'Remote machines',
    body: (
      <>
        Browse remote files locally via an <b>sshfs / macFUSE</b> mount, and
        TypeBuild will automatically run terminals, Claude, and other launchers
        on the <b>remote host</b> — not through the slow FUSE layer. Status
        hooks (busy / idle / needs-input) tunnel back so tab indicators and
        notifications work just like local sessions.
        <br /><br />
        <b>Prereqs.</b> Passwordless ssh to the host (a key in your agent,
        an entry in <code>~/.ssh/config</code> so <code>ssh &lt;alias&gt;</code>
        just works) plus an sshfs/macFUSE mount. Then anything under that
        mount is "remote-aware".
        <br /><br />
        <b>Linux quick setup.</b>
        <br />
        <code>sudo apt install sshfs</code> · add to{' '}
        <code>~/.ssh/config</code>:
        <br />
        <code>Host myserver</code><br />
        <code>&nbsp;&nbsp;HostName example.com</code><br />
        <code>&nbsp;&nbsp;User vivek</code><br />
        <code>&nbsp;&nbsp;IdentityFile ~/.ssh/id_ed25519</code><br />
        <code>&nbsp;&nbsp;ServerAliveInterval 15</code><br />
        Then mount:{' '}
        <code>mkdir -p ~/remotes/myserver &amp;&amp; sshfs myserver:/home/vivek
        ~/remotes/myserver -o reconnect,ServerAliveInterval=15</code>
        <br /><br />
        <b>macOS quick setup.</b>
        <br />
        Install <code>brew install --cask macfuse</code> and{' '}
        <code>brew install gromgit/fuse/sshfs-mac</code> (or use FUSE-T as an
        alternative). Approve the macFUSE kernel extension in System
        Settings → Privacy & Security on first install. The{' '}
        <code>~/.ssh/config</code> + mount commands are identical to Linux.
        <br /><br />
        <b>How TypeBuild uses it.</b> When you open a terminal or launch Claude
        in a folder under a remote mount, TypeBuild rewrites the spawn into{' '}
        <code>ssh -t &lt;target&gt; …</code> and translates the path to the
        remote root. On first connection per host, TypeBuild installs a small
        status-hook script on the remote (needs <code>python3</code> — present
        on every modern Linux/macOS by default). After that, hooks run
        on every Claude turn.
        <br /><br />
        <b>Escape hatches.</b> Set <code>BREEZE_REMOTE_DISABLE=1</code> in
        the environment to force local spawns everywhere. Drop a{' '}
        <code>.breeze-remote-skip</code> file at a specific mountpoint to
        opt out per-mount (useful if a mount is read-only or you want to
        edit locally on purpose).
        <br /><br />
        <b>Tasks per machine.</b> Run <code>:remote-attach</code> (alias{' '}
        <code>connect</code>) and pick a host from your active sshfs
        mounts. The app installs and starts a persistent{' '}
        <code>breezed</code> daemon there (a <code>systemd --user</code>{' '}
        service that survives disconnect and reboot) and opens a forward
        ssh tunnel. That machine <b>owns and runs its own tasks</b> — its
        task list shows under its own <b>"{'<host>'}"</b> section (group
        the Tasks page by <b>Source</b>); there is no sync or merge. A
        task you create in a folder under that host's mount is
        auto-routed to that machine's store, anchored to the real remote
        path. The host's own breezed fires its scheduled / auto tasks
        24/7 even when your laptop is closed. The sidebar's{' '}
        <b>Connected hosts</b> lists each connection with a × to
        disconnect; connected hosts reconnect automatically on next
        launch. Local recurring / auto tasks still need no launchd or
        systemd — the scheduler runs in-process, identical on Linux and
        macOS while TypeBuild is open.
        <br /><br />
        <b>Troubleshooting.</b> Check{' '}
        <code>~/.breezefile/claude-hook.log</code> on the remote: if posts
        show <code>http=000</code> the reverse tunnel didn't come up — run{' '}
        <code>ssh -v &lt;alias&gt;</code> to debug auth. If hook installation
        fails, ensure <code>python3</code> is on the remote's login{' '}
        <code>$PATH</code>.
      </>
    ),
  },
  {
    kind: 'catalog',
    id: 'tabs',
    section: 'More',
    glyph: '⊞',
    title: 'Tabs, terminals, the rest',
    lede: 'Live across many folders at once; mark places to return to.',
    verbs: [
      { name: 'new tab', chord: 'gn', what: 'open current folder in a new tab' },
      { name: 'switch / close', chord: 'gt / gT / gw', what: 'next / prev / close · ga restores last closed' },
      { name: 'jump to tab N', chord: '⌘1 … ⌘9', what: 'each tab shows its number — folder zone numbered first, then task zone' },
      { name: 'bookmark', chord: 'm<k> / \'<k>', what: 'set / jump (m a then \'a)' },
      { name: 'pin', what: 'pin a folder to the sidebar Favorites' },
      { name: 'shell', chord: '! / s', what: 'run a one-off command in this folder' },
      { name: 'term', what: 'open an embedded terminal pane rooted at this folder · :term-close to dismiss · drop files (from Finder, web pages, or TypeBuild rows) onto the pane to paste their absolute paths into the running shell / Claude Code prompt · select text and right-click → Copy, or use the platform copy shortcut (Cmd+C on macOS, Ctrl+Shift+C on Linux since plain Ctrl+C is SIGINT) · right-click the pane: with text selected → Copy (+ Open URL when the selection is a link); with nothing selected → Open ▸ Open folder / Open With… on the pane\'s working directory · theme-aware ANSI palette with a minimum contrast floor so colors stay readable on every theme' },
      { name: 'claude / codex / gemini', what: 'open the terminal pane and launch the AI CLI · when the launcher has variants the verb gains a Flags slot — Space toggles each flag (e.g. Continue, Skip-permissions), Enter launches with the union (no flags = bare) · backgrounded tabs badge red when the agent is waiting for you (turn end OR mid-turn permission prompt) · dock badge + Ping sound + system notification when TypeBuild is in the background (per-channel toggles in Settings → Notifications)' },
      { name: 'chat / ask', what: 'dock an agent chat panel on the right (aliases ask/agent/claude-chat) rooted at this folder or the open document · the panel survives tab switches (the session lives in the main process) · drag its LEFT edge to resize — the app window grows so your file list keeps its width, then the file area yields once you hit the screen edge; the width persists across tabs and restarts · the small × in its corner closes it' },
      { name: 'open-terminal', chord: 'cli', what: 'open an external terminal app (iTerm, Warp, …) at this folder' },
      { name: 'compress / extract', what: 'zip a selection · expand an archive' },
      { name: 'maximize / fullscreen', chord: 'Ctrl+Shift+M / F11', what: 'toggle window maximize or fullscreen from inside TypeBuild — bypasses WM shortcuts (e.g. Alt+Space) that may collide with TypeBuild\'s own bindings on Linux' },
      { name: ':secrets', what: 'a searchable, file-manager-style secrets surface with TWO sections — aliases vault/credentials · YOUR IDENTITY: your own identifiers (NPI, Tax ID, login IDs, the me.* fields the agent fills into forms); write-only secret fields (SSN, DOB, bank account) are shown but cannot be revealed (the server refuses to read them back) · SAVED LOGINS: website logins captured when you sign in (or added here), grouped by site, with username rows and reveal-on-demand passwords · type in the search box to filter both; rows are keyboard-navigable and Enter reveals the focused row · masked by default, reveal one value at a time on click/Enter, re-masked on blur/close · create + delete in either section · server-backed, encrypted, no plaintext stored on this machine' },
      { name: 'new-home', chord: ':new-home / :nh', what: 'agent work monitor for a project — an amber Approval Bar surfaces every task blocked on you first, Hero Stats (Done / In Progress / Needs You / Failed) double as filter toggles, the Roster table lists every task with per-project custom columns, who acted last (🤖 / 👤 / 🤖+👤), and one-click Answer/Retry, and an Outcomes rollup below groups finished work (Done vs Failed) with a one-line result per task · click any row to open the detail dialog: full evidence log, structured outcome, cancel/retry, and a talk-back box to message the agent · Customize opens the per-project Template Editor (custom fields, roster columns, approval rules, steps, and reusable multi-step Chains) · + New Task opens a conversational composer that turns chat answers into a structured task' },
      { name: 'data-source fields', what: 'a New Task template field can be backed by a live external data source (an approved SavedQuery) instead of a free-text answer — set it in the Template Editor (the per-field "source" picker, next to agent-fetchable) · that field then renders as a TYPEAHEAD in the + New Task modal: type to search the source, pick a row, and the task remembers the underlying resource reference (not just the text) so the agent working it has durable access · the same lookup is available to the New Task copilot interview via its lookup_record action — one lookup, two UIs · display values are treated as sensitive (memory-only); only the opaque reference is stored on the task' },
      { name: 'settings', chord: '?', what: 'view & rebind keys · per-launcher settings · notification channels · Reset to defaults' },
      { name: 'permissions', what: 'see which protected folders TypeBuild can read; grant any still missing' },
      { name: 'upgrade', what: ':upgrade runs brew upgrade --cask breezefile and relaunches · the help dialog also surfaces an "Update available" banner when a newer release is out' },
      { name: 'copilot', chord: '⌘/ or Ctrl+/', what: 'a persistent AI chat sidebar available on every surface — ask it to navigate the app (e.g. open New Home), create tasks or projects, customize a project\'s New Home columns/fields, filter the roster, or open a specific task · click the ✨ launcher bottom-right, or use the shortcut · in New Home\'s + New Task modal, the same agent conducts the interview one question at a time and fills the form live · needs an Anthropic API key configured (ANTHROPIC_API_KEY or the same key store the tag-assist NL box uses); shows a quiet setup hint instead when none is set · chat text is not persisted to disk' },
    ],
    // Registry-backed Navigate + Tools verbs. Most are curated above (and on the
    // Tasks slides for the task/project/remote verbs); rows NOT in `covers`
    // (e.g. unpin, term-close) auto-append here, as does any NEW verb in these
    // categories — so the catalog can't drift from the registry.
    derive: {
      categories: ['Navigate', 'Tools'],
      covers: [
        // Navigate
        'newTab', 'switchTab', 'closeTab', 'restoreTab', 'pin',
        'goto', 'back', 'forward', 'up',
        // Tools
        'term', 'openTerminal', 'settings', 'permissions', 'upgrade',
        'secrets', 'chat', 'remote-attach', 'disconnect', 'run',
        'task', 'tasks', 'projects', 'new-task', 'new-project', 'new-home',
      ],
    },
  },
];

// task-b79d10308ffd — append the registry-derived rows to each catalog slide
// that declares a `derive` block. Curated rows stay first (and authoritative
// for any id in `covers`); verbs in the listed categories that aren't covered
// are pulled straight from verbCatalog.mjs. Done once at module load.
for (const slide of SLIDES) {
  if (slide.kind !== 'catalog' || !slide.derive) continue;
  const derived = helpRowsForCategories(slide.derive.categories, slide.derive.covers);
  if (derived.length) slide.verbs = [...slide.verbs, ...derived];
}

function indexOfSlide(id: HelpSlideId | undefined): number {
  if (!id) return 0;
  const idx = SLIDES.findIndex((s) => s.id === id);
  return idx >= 0 ? idx : 0;
}

export function HelpTour({
  onClose,
  initialSlide,
}: {
  onClose: () => void;
  initialSlide?: HelpSlideId;
}) {
  const { exit, state } = useOverlayExit(onClose);
  const isMac = useIsMac();
  const [i, setI] = useState(() => indexOfSlide(initialSlide));
  const [pendingUpdate, setPendingUpdate] = useState<{ tag: string } | null>(null);
  const [upgrading, setUpgrading] = useState(false);

  const isLast = i === SLIDES.length - 1;

  // Second-chance nudge: if a newer release exists on GitHub, surface it
  // at the top of the help dialog. UpdateChip also shows this, but users
  // who dismissed it (or haven't seen it yet) land here when they open
  // Help — a natural place to discover the :upgrade verb too.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fm.checkUpdate();
        if (cancelled || !r) return;
        if (cmpVersion(r.version, __APP_VERSION__) > 0) {
          setPendingUpdate({ tag: r.tag });
        }
      } catch {
        /* network blip — no banner */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function runUpgrade() {
    if (upgrading) return;
    setUpgrading(true);
    void fm.upgrade();
  }

  function next() {
    if (isLast) exit();
    else setI((n) => Math.min(SLIDES.length - 1, n + 1));
  }
  function prev() {
    setI((n) => Math.max(0, n - 1));
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        exit();
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        next();
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
        return;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  const slide = SLIDES[i];

  return (
    <div className="overlay help-overlay" data-state={state} onClick={exit}>
      <div
        className="help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="help__close"
          onClick={exit}
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>

        {pendingUpdate && (
          <div className="help__update" role="status">
            <span className="help__update-icon" aria-hidden>↑</span>
            <span className="help__update-text">
              Update <b>{pendingUpdate.tag}</b> available
            </span>
            <button
              type="button"
              className="help__update-btn"
              onClick={runUpgrade}
              disabled={upgrading}
            >
              {upgrading ? 'Upgrading…' : 'Update now'}
            </button>
          </div>
        )}

        <div className="help__eyebrow">
          Help · {slide.section} · {i + 1} of {SLIDES.length}
        </div>

        <div className="help__glyph" aria-hidden>
          {slide.glyph}
        </div>
        <h1 id="help-title" className="help__title">
          {slide.title}
        </h1>

        {slide.kind === 'narrative' ? (
          <p className="help__body">{slide.body}</p>
        ) : (
          <>
            <p className="help__lede">{slide.lede}</p>
            <ul className="help__verbs">
              {slide.verbs.map((v) => (
                <li key={v.name + (v.chord ?? '')} className="help__verb">
                  <span className="help__verb-name">{v.name}</span>
                  {v.chord && (
                    <kbd className="help__verb-chord">{fmtKeys(v.chord, isMac)}</kbd>
                  )}
                  <span className="help__verb-what">{fmtKeys(v.what, isMac)}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="help__dots" role="tablist" aria-label="Slide">
          {SLIDES.map((_, idx) => (
            <button
              key={idx}
              type="button"
              role="tab"
              aria-selected={idx === i}
              aria-label={`Slide ${idx + 1}`}
              className={'help__dot' + (idx === i ? ' help__dot--on' : '')}
              onClick={() => setI(idx)}
            />
          ))}
        </div>

        <div className="help__footer">
          <button
            type="button"
            className="help__btn help__btn--ghost"
            onClick={prev}
            disabled={i === 0}
          >
            ← Back
          </button>
          <button
            type="button"
            className="help__btn"
            onClick={next}
            autoFocus
          >
            {isLast ? 'Done' : 'Next →'}
            <kbd className="help__btn-kbd">↵</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
