// fm-m7q / task-1bf3ce50575a — single, build-safe source of truth for verb
// METADATA (id, label, keybinding, category, and the native-menu display
// overrides).
//
// This module is PLAIN ESM DATA: NO React, NO store/bridge imports, NO verb
// closures (execute / isAvailable / describe / icon). That is deliberate — it
// must be importable by BOTH:
//   • the renderer registry (src/components/ChipPrompt.tsx), which merges these
//     fields onto its VerbDef literals (so keybinding/category have one home),
//     and
//   • the Electron MAIN process (electron/main.ts buildAppMenu), which cannot
//     import the renderer registry (that pulls in React/store/bridge) but CAN
//     import this pure module under the electron-main Rollup build.
//
// The ACTUAL key handling still lives in src/useKeyboard.ts; `keybinding` here
// is a DISPLAY string for the palette/menu/help, not the authority. Keep them
// in sync with useKeyboard's mod-chord handlers.
//
// Category names mirror the native menu sections so the Cmd-K palette, the menu
// bar, and the help catalog all group verbs the same way.

/**
 * @typedef {Object} VerbMeta
 * @property {string} id        Verb id (matches VerbDef.id in ChipPrompt).
 * @property {string} label     Canonical palette label.
 * @property {string} [keybinding]  Human-readable accelerator for the palette
 *   (e.g. '⌘F', 'F2', '⌘⇧.'). Single-chord glyphs only — multi-key chords
 *   (gg/G/dD…) live in useKeyboard + the help catalog, not here.
 * @property {string} [category]    Grouping bucket: Files / Selection /
 *   Navigate / View / Tools / Help.
 * @property {string} [menuLabel]   Native-menu display override when the menu
 *   wants a shorter/clearer label than the palette (e.g. 'Move to Trash' for
 *   the 'delete' verb). Defaults to `label`.
 * @property {string} [accelerator] Electron-syntax accelerator for the native
 *   menu (e.g. 'CmdOrCtrl+F', 'F2'). When omitted it is derived from
 *   `keybinding` via keybindingToAccelerator(); set it explicitly only when the
 *   menu wants a DIFFERENT accelerator than the palette glyph (e.g. help shows
 *   'F1' in the menu but '?' in the palette).
 * @property {boolean} [inMenu]  When false, the verb is kept OUT of the native
 *   menu even though it has a category (e.g. niche/duplicate verbs). Defaults
 *   to true for any verb carrying a category.
 * @property {string} [help]  One-line description used as the fallback `what`
 *   text for an AUTO-DERIVED HelpTour catalog row (task-b79d10308ffd). The
 *   hand-curated help rows still carry richer prose; this only feeds a verb
 *   that isn't otherwise covered by a curated row, so a newly added verb shows
 *   up in help without a hand edit.
 */

/**
 * The verb metadata catalog. Order within a category drives the native-menu
 * item order (and is a reasonable palette default too).
 *
 * NOTE: this is metadata ONLY — the executable VerbDef catalog lives in
 * ChipPrompt.tsx and merges these fields in by id.
 *
 * @type {VerbMeta[]}
 */
export const VERB_CATALOG = [
  // ── Files ──────────────────────────────────────────────────────────────
  { id: 'rename', label: 'Rename', category: 'Files', keybinding: 'F2', menuLabel: 'Rename…', help: 'rename the cursor file or folder' },
  { id: 'edit', label: 'Edit', category: 'Files', menuLabel: 'Edit File', help: 'open the cursor file in a new in-app edit tab' },
  { id: 'open', label: 'Open', category: 'Files', help: 'open with the default app' },
  { id: 'open-editor', label: 'Open in editor', category: 'Files', inMenu: false, help: 'force-open the focused file in the in-app editor' },
  { id: 'editor-save', label: 'Save', category: 'Files', inMenu: false, help: 'save the current edit tab to disk' },
  { id: 'editor-revert', label: 'Revert to disk', category: 'Files', inMenu: false, help: 'reload the file from disk, discarding unsaved changes' },
  { id: 'editor-close', label: 'Close edit tab', category: 'Files', inMenu: false, help: 'close the current edit tab' },
  { id: 'open-with', label: 'Open With…', category: 'Files', help: 'pick an app; optionally bind it as default for that extension' },
  { id: 'reveal', label: 'Reveal in Finder', category: 'Files', menuLabel: 'Reveal in File Manager', help: 'reveal in the system file manager' },
  { id: 'create', label: 'Create', category: 'Files', inMenu: false, help: 'new folder / new file' },
  { id: 'note', label: 'New note', category: 'Files', menuLabel: 'New Note', help: 'new date-named markdown note in the breeze notes folder' },
  { id: 'notes', label: 'Notes folder', category: 'Files', menuLabel: 'Notes Folder', help: 'jump to the breeze notes folder' },
  { id: 'compress', label: 'Compress', category: 'Files', menuLabel: 'Compress…', help: 'zip a selection' },
  { id: 'extract', label: 'Extract', category: 'Files', help: 'expand an archive' },

  // ── Selection ──────────────────────────────────────────────────────────
  { id: 'select', label: 'Select', category: 'Selection', menuLabel: 'Select…', help: 'smart filters: images, videos, by extension, folders only…' },
  { id: 'select-expr', label: 'Select by expression', category: 'Selection', inMenu: false, help: 'mark rows matching a tag-algebra selector' },
  { id: 'copy', label: 'Copy', category: 'Selection', keybinding: '⌘C', help: 'stage files for copy' },
  { id: 'move', label: 'Move', category: 'Selection', keybinding: '⌘X', menuLabel: 'Move (cut)', help: 'stage files for move' },
  { id: 'paste', label: 'Paste here', category: 'Selection', keybinding: '⌘V', menuLabel: 'Paste', help: 'commit the staged copy/move here' },
  { id: 'delete', label: 'Delete', category: 'Selection', menuLabel: 'Move to Trash', help: 'send to Trash' },
  { id: 'permanent-delete', label: 'Delete permanently', category: 'Selection', inMenu: false, help: 'irreversible delete, bypasses the Trash' },
  { id: 'copy-path', label: 'Copy path', category: 'Selection', menuLabel: 'Copy Path', help: 'copy the path(s) to the clipboard' },
  { id: 'export-list', label: 'Export list…', category: 'Selection', inMenu: false, help: 'write the selected paths to a .txt or .json file' },
  { id: 'drag-out', label: 'Drag out', category: 'Selection', inMenu: false, help: 'drag the selection out to another app' },
  { id: 'share', label: 'Share', category: 'Selection', menuLabel: 'Share…', help: 'native share sheet' },

  // ── Navigate ───────────────────────────────────────────────────────────
  { id: 'back', label: 'Back', category: 'Navigate', help: 'go back in tab history' },
  { id: 'forward', label: 'Forward', category: 'Navigate', help: 'go forward in tab history' },
  { id: 'up', label: 'Up', category: 'Navigate', help: 'go to the parent folder' },
  { id: 'goto', label: 'Go to / Find', category: 'Navigate', keybinding: '⌘F', menuLabel: 'Go to…', help: 'type a folder OR file name; folders navigate, files open' },
  { id: 'switchTab', label: 'Switch tab', category: 'Navigate', menuLabel: 'Switch Tab…', help: 'jump to another open tab' },
  { id: 'newTab', label: 'New tab', category: 'Navigate', keybinding: '⌘T', menuLabel: 'New Tab', help: 'open the current folder in a new tab' },
  { id: 'closeTab', label: 'Close tab', category: 'Navigate', keybinding: '⌘W', menuLabel: 'Close Tab', help: 'close the active tab' },
  { id: 'restoreTab', label: 'Restore closed tab', category: 'Navigate', keybinding: '⌘⇧T', menuLabel: 'Reopen Closed Tab', help: 're-open the most recently closed tab' },
  { id: 'pin', label: 'Pin to sidebar', category: 'Navigate', menuLabel: 'Pin Folder', help: 'pin a folder to the sidebar Favorites' },
  { id: 'unpin', label: 'Unpin from sidebar', category: 'Navigate', menuLabel: 'Unpin Folder', help: 'remove a pinned folder from the sidebar' },

  // ── View ───────────────────────────────────────────────────────────────
  { id: 'view', label: 'View as', category: 'View', menuLabel: 'Change View…', help: 'list / grid / preview / tag' },
  { id: 'sort', label: 'Sort', category: 'View', menuLabel: 'Sort…', help: 'name / size / mtime / ctime / type / ext' },
  { id: 'showHidden', label: 'Show / Hide hidden files', category: 'View', keybinding: '⌘⇧.', menuLabel: 'Toggle Hidden Files', help: 'show / hide dotfiles (sticks per folder)' },
  { id: 'foldersFirst', label: 'Folders first / Mixed', category: 'View', inMenu: false, help: 'pin folders to the top or interleave with files' },
  { id: 'theme', label: 'Theme', category: 'View', menuLabel: 'Theme…', help: 'cycle dark/light or open the full theme picker' },
  { id: 'tag', label: 'Tag', category: 'View', menuLabel: 'Tag…', help: 'add a tag to every file in this folder' },
  { id: 'untag', label: 'Untag', category: 'View', menuLabel: 'Untag…', help: 'remove a tag from every file in this folder' },
  { id: 'newtag', label: 'New tag', category: 'View', menuLabel: 'New Tag…', help: 'create a tag with a rule (extension / size / modified / name)' },
  { id: 'dsltag', label: 'New DSL tag', category: 'View', inMenu: false, help: 'create/edit a tag from a selector query' },
  { id: 'filter', label: 'Filter by tag', category: 'View', menuLabel: 'Filter by Tag…', help: 'narrow the folder to files carrying selected tags' },
  { id: 'sidebyside', label: 'Side-by-side', category: 'View', inMenu: false, help: 'toggle the TypeBuild side-by-side (Chrome left / here right) layout' },
  { id: 'maximize', label: 'Maximize window', category: 'View', keybinding: '⌘⇧M', inMenu: false, help: 'toggle window maximize from inside TypeBuild' },
  { id: 'fullscreen', label: 'Fullscreen', category: 'View', inMenu: false, help: 'toggle fullscreen from inside TypeBuild' },

  // ── Tools ──────────────────────────────────────────────────────────────
  { id: 'term', label: 'Open terminal pane', category: 'Tools', menuLabel: 'Terminal in this Folder', help: 'open an embedded terminal pane rooted at this folder' },
  { id: 'openTerminal', label: 'Open external terminal here', category: 'Tools', menuLabel: 'Open External Terminal', help: 'launch your default external terminal in this folder' },
  { id: 'term-close', label: 'Close terminal pane', category: 'Tools', menuLabel: 'Close Terminal', help: 'dismiss the embedded terminal pane' },
  { id: 'remote-attach', label: 'Connect host', category: 'Tools', menuLabel: 'Attach Remote (SSH)…', help: 'connect a host from your sshfs mounts as a task source' },
  { id: 'disconnect', label: 'Disconnect host', category: 'Tools', menuLabel: 'Disconnect Remote', help: 'disconnect a connected remote task source' },
  { id: 'chat', label: 'Chat with this folder / document', category: 'Tools', inMenu: false, help: 'dock an agent chat panel rooted at this folder or document' },
  { id: 'run', label: 'Run a task', category: 'Tools', menuLabel: 'Run…', help: 'run a task with the active folder as cwd' },
  { id: 'task', label: 'New task', category: 'Tools', menuLabel: 'New Task', help: 'open the inline task composer' },
  { id: 'tasks', label: 'All tasks', category: 'Tools', menuLabel: 'Tasks View', help: 'open the singleton Tasks tab' },
  { id: 'projects', label: 'Projects', category: 'Tools', inMenu: false, help: 'open the singleton Projects tab (Project Atlas)' },
  { id: 'new-project', label: 'New project', category: 'Tools', inMenu: false, help: 'create a project via TypeBuild' },
  { id: 'settings', label: 'Settings', category: 'Tools', help: 'view & rebind keys · per-launcher settings · notifications' },
  { id: 'secrets', label: 'Secrets', category: 'Tools', inMenu: false, help: 'manage saved credentials the agent fills into forms' },
  { id: 'permissions', label: 'Permissions', category: 'Tools', help: 'see and grant access to protected folders' },
  { id: 'upgrade', label: 'Upgrade', category: 'Tools', menuLabel: 'Check for Update', help: 'upgrade TypeBuild and relaunch' },

  // ── Help / app ─────────────────────────────────────────────────────────
  { id: 'help', label: 'Help', category: 'Help', keybinding: '?', accelerator: 'F1', help: 'open this help tour' },
  { id: 'tutorial', label: 'Tutorial', category: 'Help', help: 'run the interactive walkthrough' },
  { id: 'tips', label: 'Tips', category: 'Help', help: 'show quick tips' },
  { id: 'welcome', label: 'Welcome', category: 'Help', help: 'show the welcome screen' },
];

/**
 * The category order used when grouping verbs into menu submenus / palette
 * sections. Mirrors the native menu bar's left-to-right ordering.
 * @type {string[]}
 */
export const CATEGORY_ORDER = ['Files', 'Selection', 'Navigate', 'View', 'Tools', 'Help'];

/** id → keybinding (display glyph), for the catalog entries that carry one. */
export const VERB_KEYBINDINGS = Object.fromEntries(
  VERB_CATALOG.filter((v) => v.keybinding !== undefined).map((v) => [v.id, v.keybinding]),
);

/** id → category, for every catalog entry that carries one. */
export const VERB_CATEGORIES = Object.fromEntries(
  VERB_CATALOG.filter((v) => v.category !== undefined).map((v) => [v.id, v.category]),
);

/**
 * Convert a palette display keybinding (e.g. '⌘⇧.') into an Electron menu
 * accelerator (e.g. 'CmdOrCtrl+Shift+.'). Returns undefined for an empty input
 * OR for any MULTI-CHORD binding (one containing more than a single key press,
 * such as 'gg' or 'g h') — Electron menu accelerators only support a single
 * chord, so those are display-only in the palette/help and never shown on a
 * menu item.
 *
 * @param {string | undefined} kb
 * @returns {string | undefined}
 */
export function keybindingToAccelerator(kb) {
  if (!kb) return undefined;
  const glyphs = { '⌘': 'CmdOrCtrl', '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' };
  // Split off the modifier glyphs from the front; whatever remains is the key.
  const parts = [];
  let rest = kb;
  while (rest.length && glyphs[rest[0]] !== undefined) {
    parts.push(glyphs[rest[0]]);
    rest = rest.slice(1);
  }
  const key = rest.trim();
  // No bare key after the modifiers, or a multi-character key that is NOT a
  // recognised single named key (function keys etc.) → treat as multi-chord /
  // unrepresentable and skip.
  if (key.length === 0) return undefined;
  const namedKey = /^(F\d{1,2}|Esc|Tab|Space|Enter|Up|Down|Left|Right|Delete|Backspace|Home|End|PageUp|PageDown)$/i;
  if (key.length > 1 && !namedKey.test(key)) return undefined;
  parts.push(key);
  return parts.join('+');
}

/**
 * Build the native-menu accelerator for a catalog entry: an explicit
 * `accelerator` override wins; otherwise it's derived from `keybinding`.
 * @param {VerbMeta} meta
 * @returns {string | undefined}
 */
export function menuAcceleratorFor(meta) {
  if (meta.accelerator !== undefined) return meta.accelerator;
  return keybindingToAccelerator(meta.keybinding);
}

/**
 * task-b79d10308ffd — derive HelpTour catalog rows ({ name, chord?, what })
 * from the registry for the given categories, SKIPPING any verb id already
 * covered by a curated row. This is what lets a newly added verb appear in help
 * without a hand edit while the curated prose/chord/non-verb rows are preserved.
 *
 * @param {string[]} categories  catalog categories to pull verbs from
 * @param {Iterable<string>} [covered]  verb ids already represented by a
 *   curated row (so we don't duplicate them)
 * @returns {Array<{ name: string, chord?: string, what: string }>}
 */
export function helpRowsForCategories(categories, covered = []) {
  const cats = new Set(categories);
  const skip = new Set(covered);
  const rows = [];
  for (const v of VERB_CATALOG) {
    if (!v.category || !cats.has(v.category)) continue;
    if (skip.has(v.id)) continue;
    rows.push({
      name: v.label,
      ...(v.keybinding ? { chord: v.keybinding } : {}),
      what: v.help ?? v.label,
    });
  }
  return rows;
}

/**
 * The menu-eligible verbs grouped by category, in CATEGORY_ORDER, each group in
 * its catalog order. Drives electron/main.ts buildAppMenu so adding a verb with
 * a category here surfaces it in the menu WITHOUT editing main.ts.
 *
 * @returns {Array<{ category: string, items: VerbMeta[] }>}
 */
export function menuVerbsByCategory() {
  const byCat = new Map();
  for (const meta of VERB_CATALOG) {
    if (!meta.category) continue;
    if (meta.inMenu === false) continue;
    if (!byCat.has(meta.category)) byCat.set(meta.category, []);
    byCat.get(meta.category).push(meta);
  }
  const out = [];
  const seen = new Set();
  for (const cat of CATEGORY_ORDER) {
    if (byCat.has(cat)) {
      out.push({ category: cat, items: byCat.get(cat) });
      seen.add(cat);
    }
  }
  // Any category not in CATEGORY_ORDER still surfaces (appended at the end) so
  // a new category can't silently drop verbs from the menu.
  for (const [cat, items] of byCat) {
    if (!seen.has(cat)) out.push({ category: cat, items });
  }
  return out;
}
