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
  { id: 'rename', label: 'Rename', category: 'Files', keybinding: 'F2', menuLabel: 'Rename…' },
  { id: 'edit', label: 'Edit', category: 'Files', menuLabel: 'Edit File' },
  { id: 'open', label: 'Open', category: 'Files' },
  { id: 'open-editor', label: 'Open in editor', category: 'Files', inMenu: false },
  { id: 'editor-save', label: 'Save', category: 'Files', inMenu: false },
  { id: 'editor-revert', label: 'Revert to disk', category: 'Files', inMenu: false },
  { id: 'editor-close', label: 'Close edit tab', category: 'Files', inMenu: false },
  { id: 'open-with', label: 'Open With…', category: 'Files' },
  { id: 'reveal', label: 'Reveal in Finder', category: 'Files', menuLabel: 'Reveal in File Manager' },
  { id: 'create', label: 'Create', category: 'Files', inMenu: false },
  { id: 'note', label: 'New note', category: 'Files', menuLabel: 'New Note' },
  { id: 'notes', label: 'Notes folder', category: 'Files', menuLabel: 'Notes Folder' },
  { id: 'compress', label: 'Compress', category: 'Files', menuLabel: 'Compress…' },
  { id: 'extract', label: 'Extract', category: 'Files' },

  // ── Selection ──────────────────────────────────────────────────────────
  { id: 'select', label: 'Select', category: 'Selection', menuLabel: 'Select…' },
  { id: 'select-expr', label: 'Select by expression', category: 'Selection', inMenu: false },
  { id: 'copy', label: 'Copy', category: 'Selection', keybinding: '⌘C' },
  { id: 'move', label: 'Move', category: 'Selection', keybinding: '⌘X', menuLabel: 'Move (cut)' },
  { id: 'paste', label: 'Paste here', category: 'Selection', keybinding: '⌘V', menuLabel: 'Paste' },
  { id: 'delete', label: 'Delete', category: 'Selection', menuLabel: 'Move to Trash' },
  { id: 'permanent-delete', label: 'Delete permanently', category: 'Selection', inMenu: false },
  { id: 'copy-path', label: 'Copy path', category: 'Selection', menuLabel: 'Copy Path' },
  { id: 'export-list', label: 'Export list…', category: 'Selection', inMenu: false },
  { id: 'drag-out', label: 'Drag out', category: 'Selection', inMenu: false },
  { id: 'share', label: 'Share', category: 'Selection', menuLabel: 'Share…' },

  // ── Navigate ───────────────────────────────────────────────────────────
  { id: 'back', label: 'Back', category: 'Navigate' },
  { id: 'forward', label: 'Forward', category: 'Navigate' },
  { id: 'up', label: 'Up', category: 'Navigate' },
  { id: 'goto', label: 'Go to / Find', category: 'Navigate', keybinding: '⌘F', menuLabel: 'Go to…' },
  { id: 'switchTab', label: 'Switch tab', category: 'Navigate', menuLabel: 'Switch Tab…' },
  { id: 'newTab', label: 'New tab', category: 'Navigate', keybinding: '⌘T', menuLabel: 'New Tab' },
  { id: 'closeTab', label: 'Close tab', category: 'Navigate', keybinding: '⌘W', menuLabel: 'Close Tab' },
  { id: 'restoreTab', label: 'Restore closed tab', category: 'Navigate', keybinding: '⌘⇧T', menuLabel: 'Reopen Closed Tab' },
  { id: 'pin', label: 'Pin to sidebar', category: 'Navigate', menuLabel: 'Pin Folder' },
  { id: 'unpin', label: 'Unpin from sidebar', category: 'Navigate', menuLabel: 'Unpin Folder' },

  // ── View ───────────────────────────────────────────────────────────────
  { id: 'view', label: 'View as', category: 'View', menuLabel: 'Change View…' },
  { id: 'sort', label: 'Sort', category: 'View', menuLabel: 'Sort…' },
  { id: 'showHidden', label: 'Show / Hide hidden files', category: 'View', keybinding: '⌘⇧.', menuLabel: 'Toggle Hidden Files' },
  { id: 'foldersFirst', label: 'Folders first / Mixed', category: 'View', inMenu: false },
  { id: 'theme', label: 'Theme', category: 'View', menuLabel: 'Theme…' },
  { id: 'tag', label: 'Tag', category: 'View', menuLabel: 'Tag…' },
  { id: 'untag', label: 'Untag', category: 'View', menuLabel: 'Untag…' },
  { id: 'newtag', label: 'New tag', category: 'View', menuLabel: 'New Tag…' },
  { id: 'dsltag', label: 'New DSL tag', category: 'View', inMenu: false },
  { id: 'filter', label: 'Filter by tag', category: 'View', menuLabel: 'Filter by Tag…' },
  { id: 'sidebyside', label: 'Side-by-side', category: 'View', inMenu: false },
  { id: 'maximize', label: 'Maximize window', category: 'View', keybinding: '⌘⇧M', inMenu: false },
  { id: 'fullscreen', label: 'Fullscreen', category: 'View', inMenu: false },

  // ── Tools ──────────────────────────────────────────────────────────────
  { id: 'term', label: 'Open terminal pane', category: 'Tools', menuLabel: 'Terminal in this Folder' },
  { id: 'openTerminal', label: 'Open external terminal here', category: 'Tools', menuLabel: 'Open External Terminal' },
  { id: 'term-close', label: 'Close terminal pane', category: 'Tools', menuLabel: 'Close Terminal' },
  { id: 'remote-attach', label: 'Connect host', category: 'Tools', menuLabel: 'Attach Remote (SSH)…' },
  { id: 'disconnect', label: 'Disconnect host', category: 'Tools', menuLabel: 'Disconnect Remote' },
  { id: 'chat', label: 'Chat with this folder / document', category: 'Tools', inMenu: false },
  { id: 'run', label: 'Run a task', category: 'Tools', menuLabel: 'Run…' },
  { id: 'task', label: 'New task', category: 'Tools', menuLabel: 'New Task' },
  { id: 'tasks', label: 'All tasks', category: 'Tools', menuLabel: 'Tasks View' },
  { id: 'projects', label: 'Projects', category: 'Tools', inMenu: false },
  { id: 'new-project', label: 'New project', category: 'Tools', inMenu: false },
  { id: 'settings', label: 'Settings', category: 'Tools' },
  { id: 'secrets', label: 'Secrets', category: 'Tools', inMenu: false },
  { id: 'permissions', label: 'Permissions', category: 'Tools' },
  { id: 'upgrade', label: 'Upgrade', category: 'Tools', menuLabel: 'Check for Update' },

  // ── Help / app ─────────────────────────────────────────────────────────
  { id: 'help', label: 'Help', category: 'Help', keybinding: '?', accelerator: 'F1' },
  { id: 'tutorial', label: 'Tutorial', category: 'Help' },
  { id: 'tips', label: 'Tips', category: 'Help' },
  { id: 'welcome', label: 'Welcome', category: 'Help' },
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
