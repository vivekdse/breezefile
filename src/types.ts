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

// fm-1y1 — tabs come in two kinds. 'folder' is the classic file-browser
// tab (the only kind before this commit; existing tabs migrate to it).
// 'task' is bound to a Breeze task and renders a different shell layout
// (task header prominent, folder de-emphasized, file-management verbs
// hidden). Both kinds can have a terminal pane attached via tab.terminal.
// fm-yi85 — added 'tasks' kind for the singleton Tasks-overview tab. Replaces
// the modal All-tasks dialog: inline page that participates in the chip
// prompt and side-panel ecosystem like any other tab. Tasks-tab-scoped verbs
// (done, due, claude, etc.) gate on this kind.
export type TabKind = 'folder' | 'task' | 'tasks';

export type Tab = {
  id: string;
  /** fm-1y1 — distinguishes folder tabs from task tabs at every render
   *  decision point. Defaults to 'folder' on hydrate for back-compat. */
  kind: TabKind;
  /** fm-1y1 — set when kind === 'task'. The bound Breeze task id;
   *  drives the task header, context injection, and the sidebar's
   *  "active in tab N" indicator. Stable across navigation within
   *  the tab — clearing means the tab is no longer working on a task. */
  taskId?: string | null;
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
  // fm-jtu — embedded terminal pane state. When `ptyId` is set the tab
  // is in full-bleed terminal mode (sidebar/preview/status hidden, main
  // area given over to xterm). `attention` carries the cross-tab
  // attention signal (fm-fux): 'idle' = waiting for input, 'busy' =
  // generating, 'bell' = BEL/OSC fired since last focus.
  terminal?: {
    ptyId: number;
    cwd: string;
    label?: string;
    attention?: 'idle' | 'busy' | 'bell' | null;
  };
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

// fm-dhc — task store types. Tasks live in ~/.breezefile/tasks.db and are
// folder-anchored to-dos with optional date-only start/due. Status
// progresses pending → in_progress → done|cancelled.
export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';

export type Task = {
  id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  folder: string;
  ref_folder: string | null;
  start_at: string | null; // 'YYYY-MM-DD'
  due_at: string | null;
  pinned: boolean;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

export type TaskCreate = {
  title: string;
  folder: string;
  notes?: string | null;
  status?: TaskStatus;
  ref_folder?: string | null;
  start_at?: string | null;
  due_at?: string | null;
  pinned?: boolean;
};

export type TaskUpdate = Partial<{
  title: string;
  notes: string | null;
  status: TaskStatus;
  folder: string;
  ref_folder: string | null;
  start_at: string | null;
  due_at: string | null;
  pinned: boolean;
}>;

export type TaskFilter = {
  status?: TaskStatus | TaskStatus[];
  folder?: string;
  pinned?: boolean;
  search?: string;
  /** Show tasks with start_at <= today (or null) and not done/cancelled. */
  activeOnly?: boolean;
  includeDone?: boolean;
};
