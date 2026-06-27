// fm-m7q / task-1bf3ce50575a — type surface for the pure verbCatalog.mjs
// metadata module (consumed by ChipPrompt.tsx and electron/main.ts).

/** Plain-data metadata for one verb. NO React / store / closures. */
export interface VerbMeta {
  /** Verb id (matches VerbDef.id in ChipPrompt). */
  id: string;
  /** Canonical palette label. */
  label: string;
  /** Human-readable accelerator for the palette (e.g. '⌘F', 'F2'). */
  keybinding?: string;
  /** Grouping bucket: Files / Selection / Navigate / View / Tools / Help. */
  category?: string;
  /** Native-menu display override (defaults to `label`). */
  menuLabel?: string;
  /** Electron-syntax accelerator override for the native menu. */
  accelerator?: string;
  /** When false, kept out of the native menu (defaults to true if category). */
  inMenu?: boolean;
  /** One-line fallback `what` text for an auto-derived HelpTour catalog row. */
  help?: string;
}

/** The verb metadata catalog. */
export const VERB_CATALOG: VerbMeta[];

/** Category order for grouping into submenus / palette sections. */
export const CATEGORY_ORDER: string[];

/** id → display keybinding, for catalog entries that carry one. */
export const VERB_KEYBINDINGS: Record<string, string>;

/** id → category, for every catalog entry that carries one. */
export const VERB_CATEGORIES: Record<string, string>;

/** Convert a palette display keybinding to an Electron menu accelerator. */
export function keybindingToAccelerator(kb: string | undefined): string | undefined;

/** Native-menu accelerator for a catalog entry (override or derived). */
export function menuAcceleratorFor(meta: VerbMeta): string | undefined;

/** Menu-eligible verbs grouped by category, in CATEGORY_ORDER. */
export function menuVerbsByCategory(): Array<{ category: string; items: VerbMeta[] }>;

/** Derive HelpTour catalog rows from the registry, skipping covered ids. */
export function helpRowsForCategories(
  categories: string[],
  covered?: Iterable<string>,
): Array<{ name: string; chord?: string; what: string }>;
