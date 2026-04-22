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
export type ViewMode = 'list' | 'grid' | 'preview';

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
  history: string[][]; // back stack of previous trails
  forward: string[][]; // forward stack
};

export type YankMode = 'copy' | 'move' | 'symlink' | 'symlinkRel' | 'hardlink';
export type YankEntry = { path: string; mode: YankMode };

export type Bookmarks = Record<string, string>; // char -> path
export type Tags = Record<string, string>; // path -> tag char
export type Keybinds = Record<string, string>; // action -> key
