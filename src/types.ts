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
// fm-vu55 — 'edit' is an in-app text editor tab (markdown via Milkdown,
// other text via a plain textarea). The trail is a single-element array
// holding the file's parent dir (for breadcrumb consistency); `editPath`
// carries the actual file path and `dirty` tracks unsaved changes.
// SPIKE (spike/playwright-cdp): 'browser' is an embedded web view tab backed
// by a main-process WebContentsView (see BrowserPane / electron browser:*).
// task-83048f692491 — 'projects' is the singleton Projects-home tab (Project
// Atlas): the calm projects grid → drill-into a project's task tree. Like
// 'tasks' it ignores `trail` for rendering and gates its own scoped verbs.
// task-97c0800ff55d — 'home' is the singleton Home surface (the tasks-first
// landing: projects-as-folders, attention-ranked). It superseded the relabeled
// 'projects' tab — Home now rides its own dedicated kind so it is the launch
// surface and the file manager is one ability (`:files`) beside it. Renders the
// same ProjectsPage component; like 'projects'/'tasks' it ignores `trail` for
// rendering and gates its own scoped verbs. The bare file-manager folder tab
// stays 'folder'; the flat all-tasks page stays 'tasks'.
export type TabKind = 'folder' | 'task' | 'tasks' | 'edit' | 'browser' | 'projects' | 'home';

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
  /** fm-vu55 — when kind === 'edit', the absolute path of the file
   *  being edited. */
  editPath?: string | null;
  /** fm-vu55 — when kind === 'edit', true while the editor has
   *  unsaved changes (tab title shows '• modified', closing prompts). */
  dirty?: boolean;
  /** SPIKE (spike/playwright-cdp) — when kind === 'browser', the URL the
   *  embedded WebContentsView loads. */
  browserUrl?: string;
  /** fm-mp1 — filter-tab (a "smart folder"). When set, this folder tab does
   *  NOT list a directory; instead it lists the entries under `scopePath`
   *  (recursively, via fm.walkScope) that MATCH this tagDsl selector,
   *  re-evaluated each time the tab is opened. The tab stays kind 'folder' so
   *  it reuses the whole file-browser surface (sort, select, yank, verbs); the
   *  presence of boundSelector is what flips it into smart-folder mode. */
  boundSelector?: string;
  /** fm-mp1 — the root a filter-tab walks (default: home). Absolute path. */
  scopePath?: string;
  trail: string[]; // absolute paths
  selected: Record<number, number>; // per-column selection index
  marks: Record<string, true>; // paths marked for selection (multi-select)
  sortKey: SortKey;
  sortReverse: boolean;
  showHidden: boolean;
  viewMode: ViewMode;
  /** fm-k9dg — when true (traditional), directories pin to the top of the
   *  listing regardless of sortKey; when false, dirs and files interleave
   *  by the active sort. Per-folder via folderPrefs. */
  foldersFirst: boolean;
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
    // fm-b5at.5 — owning task source for terminals opened from an interactive
    // run ('typebuild' etc.). Drives PHI-aware tab behavior: the TypeBuild
    // OAuth hint, and (belt-and-suspenders) a marker that this terminal's
    // scrollback is PHI and must never be serialized to disk.
    source?: string;
    // fm-7909 — the task this terminal session is working on. Set when the
    // session was opened from a task Start / interactive run. Drives the
    // session-per-task map (useRunningSessions) so the Tasks page can offer
    // "Open session" (focus this tab) instead of starting a duplicate.
    taskId?: string;
    // When the session was launched from the Tasks tab, return there on exit
    // (Ctrl-C / the agent finishing) instead of leaving a bare folder listing
    // of the session's working dir. Closes this session tab and focuses the
    // Tasks tab (or converts in place if no Tasks tab survived).
    returnToTasksOnExit?: boolean;
  };
  // fm-dly3 — agent chat side-panel docked on the right of this tab. Hosts a
  // PTY running an agent CLI (claude/gemini/…) anchored to the folder (folder
  // tabs) or the open document's dir (edit tabs). Independent of `terminal`
  // (the full-bleed pane) — a tab can have both. `agentId` is the launcher id
  // that started it, for the panel header label/picker.
  chat?: {
    ptyId: number;
    cwd: string;
    agentId: string;
    label?: string;
    attention?: 'idle' | 'busy' | 'bell' | null;
  };
};

export type YankMode = 'copy' | 'move' | 'symlink' | 'symlinkRel' | 'hardlink';
export type YankEntry = { path: string; mode: YankMode };

// fm-s163 — the open document's text selection, passed as agent context when
// chatting from an edit tab. `start`/`end` are character offsets into the
// document; `text` is the selected substring. NOT PHI here — it's local
// document text the user is editing, not encrypted task body. Absent when the
// editor has no (or a collapsed) selection.
export type DocumentSelection = { start: number; end: number; text: string };

// fm-k9dg — per-folder remembered view preferences. Keyed by absolute
// folder path. Only fields the user has consciously set are present;
// missing fields fall back to the tab's current state (no clobber on
// folders the user hasn't customized).
export type FolderPrefs = Partial<{
  sortKey: SortKey;
  sortReverse: boolean;
  showHidden: boolean;
  viewMode: ViewMode;
  foldersFirst: boolean;
}>;
export type FolderPrefsMap = Record<string, FolderPrefs>;

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
  start_at: string | null; // 'YYYY-MM-DD'
  due_at: string | null;
  pinned: boolean;
  // fm-zf3m — auto-execute fields (epic).
  cron: string | null;
  next_run_at: number | null;
  auto_mode: boolean;
  auto_agent: string | null;
  auto_prompt: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  // breezed P4 — owning machine: 'local' or an ssh host. Tagged by the
  // aggregating IPC; absent on rows written/read directly.
  source?: string;
  // fm-b5at.1 — optional fields a remote TaskSource (TypeBuild) may carry.
  // Local rows leave these undefined.
  rawStatus?: string;
  priority?: number;
  claimedBy?: string | null;
  // task-b8306d2b85c2 — lifecycle timestamps for the task timeline + claim
  // freshness. RAW ISO strings (NON-PHI: time + email principals only, never
  // task text). `claimedAt` rides the detail endpoint; the create timestamps
  // are present only when the server returns them — the timeline derives the
  // rest from the audit trail rather than faking data.
  claimedAt?: string | null;
  createdAtIso?: string | null;
  updatedAtIso?: string | null;
  createdBy?: string | null;
  // fm-j7w0 (S4) — assignee principal/email (server `assigned_to`). Non-PHI
  // (a user identity, not patient data); safe to render. null/undefined when
  // unassigned.
  assignedTo?: string | null;
  attempts?: number;
  maxAttempts?: number;
  flags?: string[];
  // fm-lji6 (S2) — Task API v2 fields. `deferUntil` (ISO) drives the snooze
  // pill; `parentTaskId` is an opaque container id. Detail-only dependency
  // fields are memory-only (opaque non-PHI ids).
  deferUntil?: string | null;
  parentTaskId?: string | null;
  dependsOn?: string[];
  depsSatisfied?: boolean;
  blockedBy?: string[];
  // task-ab1d7955e23f — owning TypeBuild project container (opaque id,
  // non-PHI). Carried from the server `project_id`; absent on local rows.
  projectId?: string | null;
  // task-19ba9f7f43f1 — a STRUCTURED, type-dispatched task result (bespoke
  // rendering: a `table` first). The client renders it via the TaskResult
  // registry keyed on `type`; an unknown/missing/malformed result falls back to
  // the plain notes view (NON-REGRESSION). OPTIONAL so nothing breaks for tasks
  // that don't opt in — threaded through defensively (pass through if present),
  // like created_at/updated_at were. PHI: `payload` is TASK OUTPUT and could
  // contain PHI — carried in memory with the task (like title/notes), NEVER
  // persisted to the skeleton DB, logged, or written to notes/files.
  result?: { type: string; payload: unknown } | null;
};

// fm-b5at.1 — per-source capability flags. The UI gates row affordances
// on these (same pattern as PlatformContext capability gating).
export type TaskSourceCapabilities = {
  canSchedule: boolean;
  canClaim: boolean;
  canEdit: boolean;
  canDelete: boolean;
  // fm-r8vj (S5 plumbing) — source supports creating tasks. The composer
  // gates its target picker on this; local + typebuild both create.
  canCreate: boolean;
  phiSensitive: boolean;
  hasFolder: boolean;
};

export type TaskSourceInfo = {
  id: string;
  label: string;
  capabilities: TaskSourceCapabilities;
};

// fm-j7w0 (S4) — a row from the TypeBuild user registry (GET /chromeext/users).
// Non-PHI: identities, not patient data. `principal` is the audited identity
// (email or uid fallback); `email`/`display_name` may be blank.
export type TaskUser = {
  principal: string;
  email?: string | null;
  display_name?: string | null;
};

// fm-k6wz (S7) — a per-task audit row (GET /chromeext/audit?task_id=). Audit
// actions + actor are NON-PHI by design (the server never puts the body in
// `detail`). Rendered in the detail History section, memory-only.
export type TaskAuditEvent = {
  user: string;
  action: string;
  detail: string;
  at: string; // ISO timestamp
};

// fm-b5at.8 — a PHI-free local cron overlay for a remote-source task. Carries
// only opaque ids + a cron string; no titles/bodies. `nextRunAt` is the cached
// next fire (ms epoch).
export type RemoteSchedule = {
  sourceId: string;
  taskId: string;
  cron: string;
  nextRunAt: number;
  createdAt: number;
};

export type TaskCreate = {
  title: string;
  folder: string;
  notes?: string | null;
  status?: TaskStatus;
  start_at?: string | null;
  due_at?: string | null;
  pinned?: boolean;
  cron?: string | null;
  next_run_at?: number | null;
  auto_mode?: boolean;
  auto_agent?: string | null;
  auto_prompt?: string | null;
  // fm-r8vj (S5 plumbing) — optional fields the composer passes for a
  // TypeBuild create. `deferUntil` is an ISO timestamp (server `defer_until`);
  // `priority` an integer. The local source ignores both (its createTask
  // builds the row from its own field set and drops unknown keys).
  deferUntil?: string | null;
  priority?: number;
  // task-ab1d7955e23f — optional TypeBuild project container (opaque id,
  // non-PHI). The local source ignores it; TypeBuild maps it to `project_id`.
  projectId?: string;
};

// task-ab1d7955e23f — a TypeBuild Project as the renderer sees it (camelCase,
// mirrors electron/sources/typebuild.ts `Project`). NON-PHI: name/description/
// instructions/folders are containers + guidance, not patient data.
export type Project = {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  parentProjectId: string | null;
  folders: string[];
  createdBy: string | null;
  groupId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  effectiveInstructions?: string;
  /** task-2c5448be520a — archived projects are hidden from the default list. */
  archived?: boolean;
};

export type TaskUpdate = Partial<{
  title: string;
  notes: string | null;
  status: TaskStatus;
  folder: string;
  start_at: string | null;
  due_at: string | null;
  pinned: boolean;
  cron: string | null;
  next_run_at: number | null;
  auto_mode: boolean;
  auto_agent: string | null;
  auto_prompt: string | null;
}>;

// fm-zf3m — task run history (one row per agent-execution attempt).
export type TaskRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'retrying';

export type TaskRunErrorClass =
  | 'rate_limit'
  | 'usage'
  | 'auth'
  | 'transient'
  | 'fatal';

export type TaskRun = {
  id: string;
  task_id: string;
  agent: string;
  status: TaskRunStatus;
  attempt: number;
  scheduled_for: number;
  started_at: number | null;
  finished_at: number | null;
  conversation_id: string | null;
  output_path: string | null;
  error_class: TaskRunErrorClass | null;
  error_message: string | null;
  exit_code: number | null;
};

/** TaskRun augmented with its parent task's title + folder, for the
 *  cross-task Runs view (fm-zf3m). Joined in SQL so the renderer
 *  doesn't have to fetch each task individually. */
export type TaskRunWithTitle = TaskRun & {
  task_title: string;
  task_folder: string;
};

export type TaskFilter = {
  status?: TaskStatus | TaskStatus[];
  folder?: string;
  pinned?: boolean;
  search?: string;
  /** Show tasks with start_at <= today (or null) and not done/cancelled. */
  activeOnly?: boolean;
  includeDone?: boolean;
  /** fm-lji6 (S2) — "Mine" toggle. Only the typebuild source consumes this
   *  (server-backed via ?claimed_by=me); the local source ignores it. */
  claimedByMe?: boolean;
};
