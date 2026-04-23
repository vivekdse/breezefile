export type EntryKind = 'dir' | 'file' | 'link' | 'exec';

export type Entry = {
  name: string;
  path: string;
  kind: EntryKind;
  ext?: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  isHidden: boolean;
};

export type SortKey = 'name' | 'size' | 'mtime' | 'ctime' | 'ext' | 'type';
export type ViewMode = 'list' | 'grid' | 'preview' | 'tag';

export type TagFilterMode = 'off' | 'all' | 'any';
export type TagFilter = { mode: TagFilterMode; ids: string[] };

export type Tab = {
  id: string;
  trail: string[]; // absolute paths
  selected: Record<number, number>; // per-column selection index
  marks: Record<string, true>; // paths marked for selection (multi-select)
  sortKey: SortKey;
  sortReverse: boolean;
  showHidden: boolean;
  viewMode: ViewMode;
  filter: string;
  // fm-uns — tag view: which tag rules color-code rows (visualization only)
  // and an optional tag-combination filter that narrows the visible list.
  tagViz: string[];
  tagFilter: TagFilter;
  history: string[][]; // back stack of previous trails
  forward: string[][]; // forward stack
};

export type YankMode = 'copy' | 'move' | 'symlink' | 'symlinkRel' | 'hardlink';
export type YankEntry = { path: string; mode: YankMode };

export type Bookmarks = Record<string, string>; // char -> path
export type Tags = Record<string, string>; // path -> tag char
export type Keybinds = Record<string, string>; // action -> key

// fm-60k — user-authored tags. Seeded tags live in src/tags.ts and are
// predicate-only; a CustomTag carries an optional structured Criterion
// (single clause v1) plus an optional manual path list. Multi-clause
// composition is intentionally absent — the user combines tags via the
// existing Match all / Match any filter in TagInspector instead, which
// keeps each tag's identity simple.
export type CustomTagCriterion =
  | { field: 'extIn'; values: string[] }
  | { field: 'sizeOver'; mb: number }
  | { field: 'sizeUnder'; mb: number }
  | { field: 'modifiedWithin'; days: number }
  | { field: 'modifiedBefore'; days: number }
  | { field: 'nameContains'; text: string }
  | { field: 'nameMatches'; pattern: string }
  | { field: 'kindIs'; value: 'dir' | 'file' };

export type CustomTag = {
  id: string;
  name: string;
  color: string;
  description?: string;
  /** Optional rule. When absent, the tag is manual-only. */
  criterion?: CustomTagCriterion;
  /** Single-letter access key for the keyboard tag picker (fm-60k). */
  key?: string;
  createdAt: number;
};

// Map of tag id → list of paths the user has explicitly applied that tag to.
// Covers both seeded and custom tags.
export type TagPaths = Record<string, string[]>;
