// task-b9cdad64ab9c — New Home: shell for the agent-work-monitor surface.
// Full-screen singleton tab (kind:'newhome'), opened by the `:new-home`
// verb (aliases `:newhome` / `:nh`). Built from scratch alongside the
// existing Home (ProjectsPage, kind:'home'/'projects') — this file must never
// import from src/components/projects/ or otherwise couple to that surface.
//
// task-b1fa5098da3e (R3) — the inline Customize dialog (per-project stored
// TemplateConfig: fields/columns/approval rules/steps/chains/repeatables) and
// the amber ApprovalBar strip are REMOVED — see docs/task-templates-design.md
// "Removed/superseded". A project carries no editable configuration anymore;
// a chain is defined inline in the canonical Task composer ("New Chained
// Task") or copied from an existing chained task, never edited via a project
// panel. Pending-question tasks still surface via the roster's "needs" bucket
// + RowAction "Answer" and the TaskDetailDialog's answer form.
//
// Layout:
//   topbar (project picker · + New Task)
//   project hero (name + subtitle)
//   HeroStats
//   RosterTable (one unified table: template groups, chains, plain tasks —
//     with each finished row's outcome inline; the status filter lives on the
//     HeroStats cards)
//   conditional: TaskDetailDialog
//
// This component owns ALL cross-child state (selectedProjectId, filter,
// openTaskId) and passes it down as props.
//
// PHI: task titles/custom-field values render in-app only; never persisted
// to disk/logs (see docs/typebuild-data-field-contract.md).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { useNewHomeData } from './useNewHomeData';
import { compileTaskQuery, runTaskQuery } from './taskQuery';
import type { NewHomeStatus } from './types';
import { HeroStats } from './HeroStats';
import { RosterTable } from './RosterTable';
import { TaskDetailDialog } from './TaskDetailDialog';
import { ProjectDialog } from './ProjectDialog';
import { useTaskActions } from '../tasks/useTaskActions';
import type { StartOutcome } from '../tasks/useTaskActions';
import { setNewHomeContext, clearNewHomeContext } from '../../copilot/newHomeContext';
import { fm } from '../../bridge';
import { getTask, useOriginHealth } from '../../tasks';
import { relTime } from '../TaskIndicators';
import type { Project } from '../../types';
import { ancestorChain, buildProjectTree } from '../../projects/index.mjs';
import { buildSubprojectSections } from './subprojectSections.mjs';
import { sortByRecency, partitionByRecency, paginateGroupAware } from './rosterOrder.mjs';
import { groupKeyFor, isFieldBearing } from './rosterGroups.mjs';
import { nextSelectionAfterArchive, nextSelectionAfterDelete, projectDeleteDecision } from './projectCrud.mjs';
import { IconActionButton } from './IconActionButton';
import {
  loadSelectedProjectId,
  saveSelectedProjectId,
  isStaleProjectSelection,
  // Explicit `.ts` extension: a sibling `selectedProjectPrefs.mjs` (pure
  // helpers only) shadows this wrapper on Vite/esbuild's extensionless
  // resolution, so an unqualified import loads the .mjs — which lacks
  // load/save and blanks the whole app at runtime. Same discipline as the
  // fileTypes.ts / launcherPrefs.ts imports elsewhere.
} from './selectedProjectPrefs.ts';
import {
  loadSelectedGroupId,
  saveSelectedGroupId,
  isStaleGroupSelection,
  // Explicit `.ts` extension for the SAME shadow-import reason as
  // selectedProjectPrefs above: a sibling selectedGroupPrefs.mjs (pure helpers)
  // shadows this wrapper on Vite/esbuild's extensionless resolution.
} from './selectedGroupPrefs.ts';
import './NewHomePage.css';

// task-69651204e222 — CONVERGENCE FLAG. When true, New Home's task-open path
// routes to the app-wide unified TaskDetailDrawer (via the fm:openTaskDetail
// event App.tsx listens on) instead of this surface's own TaskDetailDialog.
// The dialog stays MOUNTED behind this flag; flip this to `false` to restore
// the old dialog for one release if the drawer regresses. Remove the dialog
// (and this flag) only after the drawer has proven out.
const USE_UNIFIED_DETAIL = true;

// Recency + pagination (local-first speed). Done tasks finished more than
// HOT_DAYS ago are hidden by default (behind a "show older" toggle) so Home
// leads with live work instead of a month of history. PAGE_SIZE bounds the
// first paint to a slice of roster UNITS (a group counts as one), with a
// "Load more" to extend.
const HOT_DAYS = 14;
const PAGE_SIZE = 50;

type FilterState = 'all' | NewHomeStatus;

const FILTER_STATES: FilterState[] = ['all', 'done', 'progress', 'scheduled', 'open', 'needs', 'failed'];
function isFilterState(v: unknown): v is FilterState {
  return typeof v === 'string' && (FILTER_STATES as string[]).includes(v);
}

// The filter is in-memory only (useState below — nothing persists it to the URL,
// localStorage, or settings), so a retired bucket name can only arrive from an
// EXTERNAL caller: the copilot's set_roster_filter, which reaches us through the
// 'fm:newhome:filter' event. 'queued' split into 'scheduled' + 'open', and a
// copilot working from a stale vocabulary would otherwise fail isFilterState
// and silently no-op. Map the legacy name onto 'open' — the bucket that
// inherited the old catch-all's meaning — instead of dropping the request.
const LEGACY_FILTER_ALIASES: Record<string, FilterState> = { queued: 'open' };
function coerceFilterState(v: unknown): FilterState | null {
  if (typeof v !== 'string') return null;
  if (isFilterState(v)) return v;
  return LEGACY_FILTER_ALIASES[v] ?? null;
}

// task-group-scope-picker — display label for a group in the picker / chip.
// The data layer surfaces an opaque group id (+ task count); the real name comes
// from GET /chromeext/groups (fetched into `groupNames` on mount). Fall back to
// the id when the name registry hasn't landed / a group isn't in it, so the
// picker is never blocked on the fetch.
function groupLabel(id: string, names: Map<string, string>): string {
  return names.get(id) || id;
}

// Human-readable label per status bucket for the active-filter chip.
// task-c0edffef25c6 — 'cancelled' has no HeroStats card of its own (it isn't
// a filter a user picks from that grid), but the Record must stay exhaustive
// over NewHomeStatus, and a cancelled row is still reachable via the "all"
// filter, so this label is here for completeness / any future entry point.
const FILTER_LABELS: Record<Exclude<FilterState, 'all'>, string> = {
  done: 'Done',
  progress: 'In Progress',
  scheduled: 'Scheduled',
  open: 'Open',
  needs: 'Needs You',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

// Heuristic: does this input look like a STRUCTURED query (vs. plain words)?
// True when it contains a comparison operator or a DSL keyword — used to decide
// whether a compile failure is a real query error worth surfacing, or just
// free-text the user typed. (A bare "insurance" is free-text, not a typo'd
// query.)
function looksLikeQuery(s: string): boolean {
  return /[=<>~]|(^|\s)(and|or|not|in|between|glob)(\s|$)/i.test(s);
}

// Free-text roster search. Every whitespace-separated token in the query must
// appear (case-insensitive substring) somewhere in the row's searchable text:
// title, status, who, last-action text, risk, and any custom-field VALUES. This
// is in-memory only (PHI never leaves the render) — the same rule the roster
// already follows. Empty/whitespace query => no filtering.
function applySearch(tasks: import('./types').NewHomeTask[], query: string): import('./types').NewHomeTask[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return tasks;
  return tasks.filter((t) => {
    const haystack = [
      t.title,
      t.status,
      t.who,
      t.lastAction,
      t.lastActionDetail,
      t.risk ?? '',
      ...Object.values(t.customValues),
    ]
      .join(' ')
      .toLowerCase();
    return tokens.every((tok) => haystack.includes(tok));
  });
}

export function NewHomePage() {
  // task-fd5b93809b1b — seed from the persisted pick rather than always
  // starting at null: the "+ New Task" / edit-and-save path swaps this whole
  // component out for the TaskComposer in App.tsx and remounts it on close,
  // so plain useState(null) reset the project picker to "All projects" every
  // time. Every setter call below is mirrored to storage (see the effect)
  // so the NEXT mount (post-save) rehydrates the same selection instead of
  // losing it.
  const [selectedProjectId, setSelectedProjectIdState] = useState<string | null>(
    () => loadSelectedProjectId(),
  );
  function setSelectedProjectId(id: string | null) {
    setSelectedProjectIdState(id);
    saveSelectedProjectId(id);
  }
  // task-group-scope-picker — the group scope, next to the project picker.
  // Seeded from (and mirrored to) storage the SAME way selectedProjectId is,
  // so the "+ New Task" remount doesn't reset it. null = "All groups".
  const [selectedGroupId, setSelectedGroupIdState] = useState<string | null>(
    () => loadSelectedGroupId(),
  );
  function setSelectedGroupId(id: string | null) {
    setSelectedGroupIdState(id);
    saveSelectedGroupId(id);
  }
  const [filter, setFilter] = useState<FilterState>('all');
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  // ":" opens command mode so the chip-prompt verbs work from Home. The global
  // useKeyboard handler bails out for non-folder tabs, so every page surface
  // wires its own ":" (TasksPage and ProjectsPage do the same) — without this,
  // no verb could be started from New Home. NewHomePage only mounts while its
  // tab is active (App.tsx renders it conditionally), so a window listener
  // here can't leak onto other surfaces.
  const { dispatch } = useStore();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ':') {
        e.preventDefault();
        dispatch({ type: 'setMode', mode: 'command', buffer: '' });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch]);
  // task-7ea59baaea6c — tracks the project id as of the last run of the
  // close-detail-pane effect below, so that effect can tell "the selection
  // just changed" (real project switch — close the pane) apart from "this is
  // the initial mount" (seeded from persisted prefs — don't close anything).
  const prevProjectIdRef = useRef(selectedProjectId);
  // task-7bdb94445321 follow-up — free-text roster search, ANDed with the
  // status filter. Empty string = no text filter (status filter still applies).
  const [search, setSearch] = useState('');

  // Recency + pagination (local-first speed). `showOlder` reveals done tasks
  // finished more than HOT_DAYS ago (hidden by default so Home shows live work,
  // not a month of history). `pageLimit` bounds how many roster UNITS render at
  // once; "Load more" bumps it. Both reset when the scope/filter/search changes.
  const [showOlder, setShowOlder] = useState(false);
  const [pageLimit, setPageLimit] = useState(PAGE_SIZE);

  // task-a9841cfc0e1b (spec §3) — "Show archived" reveals archived projects
  // in the picker (with an Unarchive action) so an archive is recoverable
  // from the same surface, not a one-way door into a settings page.
  const [showArchived, setShowArchived] = useState(false);
  // Group id → display name, from GET /chromeext/groups. Fetched once on mount so
  // the scope picker shows real names, not opaque ids. Empty until it lands (and
  // on failure) — groupLabel falls back to the id, so the picker never blocks.
  const [groupNames, setGroupNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void fm.typebuild.groups
      .list()
      .then((list) => {
        if (cancelled) return;
        setGroupNames(new Map(list.map((g) => [g.id, g.name])));
      })
      .catch(() => {
        /* signed out / transport — keep id-as-label */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // task-24cd55d8a607 — origin slow-episode state. When the breaker is open we
  // show a calm "responding slowly" banner AND (in useNewHomeData / the
  // enrichment hooks) retain cached groups/projects/tasks + defer enrichment,
  // so the surface degrades to slower, not to the stripped-down empty view.
  const { degraded: originDegraded, lastSyncedAt } = useOriginHealth();
  // task-6589ec3934a4 — "last synced Nm ago" / stale detector. The main-process
  // poll runs every 30s (POLL_INTERVAL_MS in electron/sources/typebuild.ts);
  // 3 missed cycles (90s) with no successful reconcile is well past normal
  // jitter and is the exact silent-freeze failure mode this task fixes (the
  // poll guard died and the cache was filled once at startup and never
  // again, with zero user-visible signal). `now` re-renders every 15s purely
  // to keep the relative-time label fresh without polling anything new.
  // A note on why this reading can be TRUSTED: `lastSyncedAt` only advances when
  // the main process pushes 'typebuild:health', and that push used to ride
  // onTasksChanged — which fires only when a poll finds a DIFF. So a quiet hour
  // with no server-side changes froze this clock and the banner declared a
  // perfectly healthy view stale (a false alarm that made the banner worth less
  // than nothing). Every successful pass now pushes a heartbeat (BreezeHost's
  // onSynced), so a stale reading here means a genuinely stale view.
  const STALE_AFTER_MS = 90_000;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const syncIsStale =
    lastSyncedAt != null && now - lastSyncedAt > STALE_AFTER_MS;
  // The banner's Sync-now action. `syncing` holds the button in a pending state
  // (and blocks a second click — the main side coalesces concurrent passes, but
  // the button shouldn't invite it). `syncFailed` is cleared on every fresh
  // attempt so a retry starts from a clean slate, and never outlives the banner:
  // a successful pass makes syncIsStale false and unmounts the whole thing.
  const [syncing, setSyncing] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);
  const doSyncNow = useCallback(async () => {
    setSyncing(true);
    setSyncFailed(false);
    try {
      const res = await fm.typebuildSyncNow();
      // A refused/failed pass leaves lastSyncedAt untouched, so the banner stays
      // up by itself — all this adds is naming what happened.
      setSyncFailed(!res?.ok);
    } catch {
      setSyncFailed(true);
    } finally {
      setSyncing(false);
    }
  }, []);
  const { tasks, counts, projects, groups, loading, refresh, refreshProjects } = useNewHomeData(
    selectedProjectId,
    // task-group-scope-picker — pass the group scope into the data layer so it
    // narrows `tasks` (and therefore counts / hero stats / subproject sections /
    // roster) consistently, mirroring how the project scope flows. `groups` is
    // derived off the project-scoped set BEFORE the group filter, so selecting a
    // group never shrinks the picker's own options.
    { includeArchived: showArchived, groupId: selectedGroupId },
  );
  // task-a9841cfc0e1b — project CRUD UI state: which dialog (create vs edit)
  // is open, if any. Edit passes the project being edited; create passes
  // `undefined` (ProjectDialog's own isEdit check).
  const [projectDialog, setProjectDialog] = useState<
    { mode: 'create' } | { mode: 'edit'; project: Project } | null
  >(null);
  const [projectActionError, setProjectActionError] = useState<string | null>(null);
  const [projectActionBusy, setProjectActionBusy] = useState(false);
  // Instructions are often long-form reference text (prior-auth policies,
  // entity lookups, etc.) — clamp to 2 lines inline and let "Read more" open
  // a full-text modal with roomier type, rather than pushing the hero tall.
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  // Nesting (spec §4): a project's indent in the picker reflects its depth in
  // the parent/child forest — the SAME pure, tested tree builder the
  // Projects attention rollup uses (src/projects/tree.mjs), not a re-derived
  // heuristic.
  const projectTree = useMemo(() => buildProjectTree(projects), [projects]);
  // Groups-first hierarchy: GROUP is the primary scope, PROJECTS nest under it.
  // The group picker options = the UNION of the fetched name registry
  // (groupNames, from GET /chromeext/groups — real names, every group you belong
  // to even with zero current tasks) AND the groups present in the current task
  // set (useNewHomeData.groups — the source of TASK COUNTS, and the fallback so
  // the picker still shows when the name fetch is empty/slow/unavailable, e.g.
  // signed out of the groups endpoint or a source that doesn't serve it). A
  // registry name wins for the label; a task-only group falls back to its id.
  // Sorted by label for a stable menu. This union is why the picker never
  // disappears just because the name fetch came back empty.
  const groupOptions = useMemo(() => {
    const countById = new Map(groups.map((g) => [g.id, g.count]));
    const ids = new Set<string>([...groupNames.keys(), ...groups.map((g) => g.id)]);
    return [...ids]
      .map((id) => ({ id, name: groupNames.get(id) || id, count: countById.get(id) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [groupNames, groups]);

  // The project picker lists only projects belonging to the SELECTED group (or
  // every project when "All groups"). A project is in a group when its own
  // groupId matches — walked over the same tree so nesting is preserved; a
  // matching child still appears at its depth even if a parent belongs elsewhere.
  const flatProjectOptions = useMemo(() => {
    const out: { project: Project; depth: number }[] = [];
    const walk = (nodes: ReturnType<typeof buildProjectTree>) => {
      for (const n of nodes) {
        if (!selectedGroupId || n.project.groupId === selectedGroupId) {
          out.push({ project: n.project, depth: n.depth });
        }
        walk(n.children);
      }
    };
    walk(projectTree);
    return out;
  }, [projectTree, selectedGroupId]);
  // task — the roster's ▶ Start button. Launches via the SAME mechanism the old
  // Tasks page's play button uses (useTaskActions().start → runTaskNow), then
  // refreshes the roster the SAME way onRetry does — this shell owns the action
  // + refresh so RosterTable stays presentational (mirrors the onRetry pattern).
  const actions = useTaskActions();

  // task-69651204e222 — the ONE open path all New-Home sources funnel
  // through (RosterTable rows, the copilot open_task listener,
  // and the Pipeline child jumps). When USE_UNIFIED_DETAIL is on it resolves
  // the underlying Task from the current roster snapshot and dispatches the
  // app-wide fm:openTaskDetail event (App.tsx → TaskDetailDrawer) — matching
  // the payload shape App.tsx expects: { task, roster, onOpenTask }. When off
  // it falls back to the old local dialog (setOpenTaskId).
  function openTaskDetail(id: string) {
    if (USE_UNIFIED_DETAIL) {
      const t = tasks.find((x) => x.id === id);
      if (!t) return;
      window.dispatchEvent(
        new CustomEvent('fm:openTaskDetail', {
          detail: {
            task: t.raw,
            // The full roster (as raw Tasks) so the drawer's Pipeline rollup
            // can resolve a meta-parent's children; onOpenTask re-enters this
            // same path so a child jump reopens the drawer on that child.
            roster: tasks.map((x) => x.raw),
            onOpenTask: openTaskDetail,
          },
        }),
      );
      return;
    }
    setOpenTaskId(id);
  }
  // task-c141c7765aa4 — returns the StartOutcome (never throws) so callers
  // that need to KNOW whether a session actually spawned (auto-continue) can
  // react; the manual ▶ Start / Retry callers ignore the resolved value
  // exactly as before (actions.start already surfaces failures via the
  // status line, and now also releases an orphaned claim on launch failure).
  async function startTask(id: string): Promise<StartOutcome> {
    // task-ecabeafa41e1 — resolve the raw Task. The roster's `tasks` is
    // project-scoped and omits chain STEP CHILDREN (a chain's "▶ Run all" and the
    // matrix's per-step "▶ Run" both target a child id), so fall back to a direct
    // getTask when the id isn't in the scoped list — otherwise start silently
    // failed with "task not found".
    let raw = tasks.find((x) => x.id === id)?.raw ?? null;
    if (!raw) {
      try {
        raw = await getTask(id);
      } catch {
        raw = null;
      }
    }
    if (!raw) return { ok: false, spawned: false, message: 'task not found', released: false };
    try {
      return await actions.start(raw);
    } finally {
      void refresh();
    }
  }
  // task-e7053415e88f — Cancel from the row ⋯ menu. Mirrors startTask's
  // resolve-raw-then-refresh pattern; backed by the SAME sourceAction(task,
  // 'cancel') verb the detail drawer/dialog already call (TaskDetailDrawer.tsx,
  // TaskDetailDialog.tsx), so the roster's Cancel is consistent with those
  // surfaces. sourceAction never throws — failures surface via its own status
  // line — so this just needs to resolve the raw Task and refresh after.
  async function cancelTask(id: string): Promise<void> {
    const raw = tasks.find((x) => x.id === id)?.raw ?? null;
    if (!raw) return;
    try {
      await actions.sourceAction(raw, 'cancel');
    } finally {
      void refresh();
    }
  }
  // task-ef961d60dc1b — "+ New Task" opens the CANONICAL Task form (the
  // globally-mounted TaskComposer, via fm:openTask — the same form the task
  // verb / Sidebar / copilot create_task open) AND pops the copilot chat, so
  // the human can fill it by hand or drive it conversationally — including
  // "New Chained Task" (docs/task-templates-design.md), which defines a chain
  // inline, right there, rather than through a project-level template.
  function openNewTask(kind?: 'chain' | 'template') {
    setOpenTaskId(null);
    window.dispatchEvent(
      new CustomEvent('fm:openTask', {
        detail: {
          mode: 'create',
          defaultFolder: '',
          // task-6d8e65ad34a7 — projectId is the only scope the create needs.
          // The GROUP scope (selectedGroupId) already narrows which project this
          // is (flatProjectOptions filters by group above), and a task's group is
          // derived server-side from its project — there is no separate group
          // field on create. Do not re-add a groupId here (see cb354's fix #3).
          projectId: selectedProjectId ?? undefined,
          initialKind: kind,
        },
      }),
    );
    window.dispatchEvent(new CustomEvent('fm:openCopilotChat'));
  }

  // task-a9841cfc0e1b — project CRUD. ProjectDialog performs the actual
  // create/patch/folder mutations itself (via fm.typebuild.projects.*, the
  // SAME bridge the copilot actions call); this callback just refreshes the
  // registry so the picker/hero update IN PLACE, and — for a fresh create —
  // selects the new project. Editing an already-selected project keeps the
  // selection untouched (same project, new fields).
  function onProjectSaved(project: Project, wasCreate: boolean) {
    void refreshProjects();
    if (wasCreate) setSelectedProjectId(project.id);
  }

  async function archiveSelectedProject() {
    if (!selectedProject) return;
    setProjectActionBusy(true);
    setProjectActionError(null);
    try {
      await fm.typebuild.projects.archive(selectedProject.id);
      await refreshProjects();
      // task-fd5b93809b1b — never let a CRUD op silently reset an UNRELATED
      // selection; only fall back to "All projects" when the archived
      // project WAS the current selection.
      setSelectedProjectId(nextSelectionAfterArchive(selectedProjectId, selectedProject.id));
    } catch (e) {
      setProjectActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjectActionBusy(false);
    }
  }

  async function unarchiveProject(id: string) {
    setProjectActionBusy(true);
    setProjectActionError(null);
    try {
      await fm.typebuild.projects.unarchive(id);
      await refreshProjects();
    } catch (e) {
      setProjectActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjectActionBusy(false);
    }
  }

  // Delete only ever runs for an EMPTY project (see projectDeleteDecision) —
  // the affordance that calls this checks the roster count first and offers
  // archive instead when the project has tasks. The server also enforces
  // this (a 409 { reason:'has_tasks' } surfaces here as a message rather than
  // a silent no-op) so a stale client-side count can't force a bad delete.
  async function deleteSelectedProject() {
    if (!selectedProject) return;
    setProjectActionBusy(true);
    setProjectActionError(null);
    try {
      const res = await fm.typebuild.projects.delete(selectedProject.id);
      if (!res.ok) {
        setProjectActionError(
          res.reason === 'has_tasks'
            ? 'This project still has tasks — archive it instead of deleting.'
            : res.reason === 'not_owner'
              ? "You don't own this project."
              : `Failed: ${res.reason}`,
        );
        return;
      }
      await refreshProjects();
      setSelectedProjectId(nextSelectionAfterDelete(selectedProjectId, selectedProject.id));
    } catch (e) {
      setProjectActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjectActionBusy(false);
    }
  }

  function confirmArchive() {
    if (!selectedProject) return;
    window.dispatchEvent(
      new CustomEvent('fm:confirm', {
        detail: {
          title: `Archive ${selectedProject.name}?`,
          body: 'Archived projects are hidden from the picker. You can unarchive them later from "Show archived".',
          confirmLabel: 'Archive',
          destructive: false,
          onConfirm: () => void archiveSelectedProject(),
        },
      }),
    );
  }

  function confirmDelete() {
    if (!selectedProject) return;
    const ownTaskCount = tasks.filter((t) => t.projectId === selectedProject.id).length;
    const decision = projectDeleteDecision(ownTaskCount);
    if (!decision.canDelete) {
      window.dispatchEvent(
        new CustomEvent('fm:confirm', {
          detail: {
            title: `${selectedProject.name} has tasks`,
            body: 'A project with tasks can only be archived, not deleted. Archive it instead?',
            confirmLabel: 'Archive instead',
            destructive: false,
            onConfirm: () => void archiveSelectedProject(),
          },
        }),
      );
      return;
    }
    window.dispatchEvent(
      new CustomEvent('fm:confirm', {
        detail: {
          title: `Delete ${selectedProject.name}?`,
          body: 'This project has no tasks and will be permanently deleted. This cannot be undone.',
          confirmLabel: 'Delete',
          destructive: true,
          onConfirm: () => void deleteSelectedProject(),
        },
      }),
    );
  }

  // Copilot action bridge (task-ce125a047c70): set_roster_filter and
  // open_task (src/copilot/actions.tsx) can't reach this component's state
  // directly since the copilot is mounted at the app root, so they dispatch
  // window CustomEvents instead.
  useEffect(() => {
    function onFilter(e: Event) {
      const detail = (e as CustomEvent<{ filter?: string; search?: string }>).detail;
      const coerced = coerceFilterState(detail?.filter);
      if (coerced) setFilter(coerced);
      // A search string of '' explicitly clears the text filter, so honor the
      // key's PRESENCE rather than truthiness.
      if (detail && typeof detail.search === 'string') setSearch(detail.search);
    }
    function onOpenTask(e: Event) {
      const detail = (e as CustomEvent<{ taskId?: string }>).detail;
      if (detail?.taskId) openTaskDetail(detail.taskId);
    }
    // Copilot select_home_project drives the project picker (detail.projectId,
    // or null/'' for "All projects"). Same setter the <select> onChange calls.
    function onSelectProject(e: Event) {
      const id = (e as CustomEvent<{ projectId?: string | null }>).detail?.projectId;
      setSelectedProjectId(id ? id : null);
    }
    window.addEventListener('fm:newhome:filter', onFilter);
    window.addEventListener('fm:newhome:openTask', onOpenTask);
    window.addEventListener('fm:newhome:selectProject', onSelectProject);
    return () => {
      window.removeEventListener('fm:newhome:filter', onFilter);
      window.removeEventListener('fm:newhome:openTask', onOpenTask);
      window.removeEventListener('fm:newhome:selectProject', onSelectProject);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The search box is dual-mode: if the text compiles as a structured query
  // (SQL-like DSL over task fields — see taskQuery.ts) we run that; otherwise
  // it's free-text. A query-shaped-but-invalid input surfaces its parse error
  // (kind 'invalid') instead of silently matching nothing. Projects declare no
  // extra queryable fields anymore (task-b1fa5098da3e) — just the base
  // task-field catalogue.
  const queryState = useMemo(() => {
    const q = search.trim();
    if (!q) return { kind: 'none' as const };
    const c = compileTaskQuery(q, []);
    if (c.ok) return { kind: 'query' as const, compiled: c.compiled };
    if (looksLikeQuery(q)) return { kind: 'invalid' as const, error: c.error };
    return { kind: 'text' as const };
  }, [search]);

  const filteredTasks = useMemo(() => {
    const byStatus = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);
    let out;
    if (queryState.kind === 'query') out = runTaskQuery(byStatus, queryState.compiled, Date.now());
    else if (queryState.kind === 'text') out = applySearch(byStatus, search);
    // 'invalid' → don't filter (the error hint tells the user why); 'none' → all.
    else out = byStatus;

    // Recency cutoff: hide done tasks finished more than HOT_DAYS ago so Home
    // leads with live work. Skipped when the user explicitly asks for the old
    // rows — filtering to 'done', toggling "show older", or searching (a search
    // should reach the whole history). `coldCount` (below) drives the toggle.
    const searching = queryState.kind === 'query' || queryState.kind === 'text';
    if (!showOlder && filter !== 'done' && !searching) {
      const { hot } = partitionByRecency(out, { now: Date.now(), hotDays: HOT_DAYS });
      out = hot;
    }
    // Newest activity first (then priority, then id) — a stable, recency-led order.
    return sortByRecency(out);
  }, [tasks, filter, search, queryState, showOlder]);

  // How many done tasks are currently hidden by the recency cutoff — powers the
  // "Show N older" affordance. Computed off the FULL (status-filtered) set so
  // the count is honest regardless of the cutoff applied above.
  const coldCount = useMemo(() => {
    if (filter === 'done' || queryState.kind === 'query' || queryState.kind === 'text') return 0;
    const base = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);
    return partitionByRecency(base, { now: Date.now(), hotDays: HOT_DAYS }).cold.length;
  }, [tasks, filter, queryState]);

  // Reset pagination whenever the visible set's shape changes, so "Load more"
  // never carries a stale offset across a scope/filter/search/toggle change.
  useEffect(() => {
    setPageLimit(PAGE_SIZE);
  }, [selectedProjectId, selectedGroupId, filter, search, showOlder]);

  // task-c82d8e0f4eae — split the (subtree-aggregated) roster into the selected
  // project's OWN tasks plus one navigable rollup section per direct child
  // subproject. The roster below shows own tasks; the sections let the user
  // drill parent → subproject → tasks. HeroStats/counts keep reflecting the
  // full subtree (useNewHomeData.counts) — the sections are the breakdown.
  const { ownTasks, subprojectSections } = useMemo(() => {
    const { ownTaskIds, sections } = buildSubprojectSections(
      filteredTasks.map((t) => ({ id: t.id, projectId: t.projectId, status: t.status })),
      projectTree,
      selectedProjectId,
    );
    const ownSet = new Set(ownTaskIds);
    return {
      ownTasks: filteredTasks.filter((t) => ownSet.has(t.id)),
      subprojectSections: sections.map((s) => ({
        id: s.id,
        name: s.name,
        statusCounts: s.statusCounts,
        taskCount: s.taskCount,
      })),
    };
  }, [filteredTasks, projectTree, selectedProjectId]);

  // Group-aware pagination of the roster rows: render only the first `pageLimit`
  // UNITS (a template/chain group counts as one unit and never splits across the
  // boundary), so the first paint is bounded. `rosterHasMore`/`rosterShown`/
  // `rosterTotal` drive the "Load more" affordance. The group key mirrors the
  // roster's own grouping (field-bearing template instances group by templateId/
  // name; everything else — plain tasks, chains — is its own unit).
  const { page: pagedOwnTasks, shown: rosterShown, total: rosterTotal, hasMore: rosterHasMore } =
    useMemo(() => {
      const groupKeyOf = (t: (typeof ownTasks)[number]): string | null => {
        const input = {
          id: t.id,
          title: t.title,
          projectId: t.projectId,
          templateId: t.templateId ?? null,
          dataKeys: t.raw.dataKeys ?? [],
          outputSchema: t.raw.outputSchema ?? [],
        };
        return isFieldBearing(input) ? groupKeyFor(input) : null;
      };
      return paginateGroupAware(ownTasks, groupKeyOf, { limit: pageLimit });
    }, [ownTasks, pageLimit]);

  const selectedProject = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId) ?? null
    : null;

  // task-c82d8e0f4eae — breadcrumb back up the subproject chain (general →
  // specific). Every crumb but the last scopes the picker to that ancestor;
  // "All projects" resets to the unscoped root. Only shown once a project is
  // selected (there's always a way back out of a drill-in).
  const breadcrumb = useMemo(
    () => (selectedProjectId ? ancestorChain(projectTree, selectedProjectId) : []),
    [selectedProjectId, projectTree],
  );

  // task-fd5b93809b1b — a persisted selection can outlive the project it
  // points at (deleted/archived elsewhere, or a stale value from another
  // machine). Once the registry has actually loaded, fall back to "All
  // projects" rather than silently wedging the roster on a filter that can
  // never match. isStaleProjectSelection treats an empty `projects` as
  // "not yet loaded" (never stale), so this never fires against the initial
  // pre-fetch render.
  useEffect(() => {
    if (isStaleProjectSelection(selectedProjectId, projects)) {
      setSelectedProjectId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, projects]);

  // task-group-scope-picker — a persisted group scope can outlive the group's
  // presence in the current project-scoped set (the last task in it finished
  // and aged out, or the project scope changed to one that has no such group).
  // Once groups have actually populated, fall back to "All groups" rather than
  // wedging the roster on a scope that can never match. Checked against
  // groupOptions (the fetched group REGISTRY — every group the user belongs to,
  // including ones with zero current tasks), NOT the task-derived `groups`, so a
  // valid empty group is never wrongly cleared. isStaleGroupSelection treats an
  // empty list as "not yet loaded" (never stale) so this doesn't fire on the
  // initial pre-fetch render.
  useEffect(() => {
    if (isStaleGroupSelection(selectedGroupId, groupOptions)) {
      setSelectedGroupId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupId, groupOptions]);

  const openTask = openTaskId ? tasks.find((t) => t.id === openTaskId) : undefined;

  // Publish grounding for the globally-mounted Copilot (src/copilot/
  // actions.tsx's useCopilotReadable) — titles + ids + counts only, never
  // task notes/custom field values (see newHomeContext.ts's PHI contract).
  // Cleared on unmount so the copilot doesn't keep grounding on a stale New
  // Home snapshot once the user navigates away.
  useEffect(() => {
    setNewHomeContext({
      surface: 'new-home',
      project: selectedProject ? { id: selectedProject.id, name: selectedProject.name } : null,
      // task-a9841cfc0e1b — archived projects can be included in `projects`
      // when "Show archived" is on; keep the copilot's grounding scoped to
      // non-archived ones (matching its docstring: "the FULL list the picker
      // offers"'s intent — a project a human hid shouldn't casually surface
      // as a copilot select_home_project/update_project/etc. target).
      availableProjects: projects.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name })),
      counts,
      needsYou: tasks
        .filter((t) => t.status === 'needs')
        .map((t) => ({ id: t.id, title: t.title })),
      rosterFilter: { status: filter, search },
    });
  }, [selectedProject, projects, counts, tasks, filter, search]);

  useEffect(() => clearNewHomeContext, []);

  // task-7ea59baaea6c — switching the selected project must close any
  // already-open task-detail pane. Without this, the header counts and
  // Outcomes list update to the new project (both keyed off
  // useNewHomeData(selectedProjectId)) while a still-mounted detail
  // pane/drawer keeps showing the OLD project's task. This covers every path
  // that changes selectedProjectId — the dropdown's onChange, the copilot's
  // select_home_project bridge, and the stale-selection fallback — since they
  // all funnel through this one piece of state.
  //
  // Closes both possible detail surfaces: the legacy local dialog
  // (setOpenTaskId(null)) and — since USE_UNIFIED_DETAIL routes opens to the
  // app-wide drawer in App.tsx — the fm:closeTaskDetail event that drawer
  // listens for. Skips the very first render (prevProjectId ref starts
  // unset) so mounting New Home doesn't spuriously fire a close.
  //
  // task-9b7a342d0a60 — same reset point, extended: also close the Level-2
  // matrix drill-in (RosterTable's local matrixParentId/matrixGroupKey
  // state), which 7ea59baaea6c's fix missed. Without this, switching
  // projects while a template group's matrix view is open leaves it
  // rendering the PREVIOUS project's task until the user clicks ← Back. The
  // drill-in selection lives inside RosterTable (not lifted here), so it's
  // reset the same way the detail drawer is — via a dedicated window event
  // RosterTable listens for — rather than lifting/duplicating that state.
  useEffect(() => {
    if (prevProjectIdRef.current === selectedProjectId) return;
    prevProjectIdRef.current = selectedProjectId;
    setOpenTaskId(null);
    window.dispatchEvent(new CustomEvent('fm:closeTaskDetail'));
    window.dispatchEvent(new CustomEvent('fm:closeMatrixDrillIn'));
  }, [selectedProjectId]);

  return (
    <div className="nh">
      {/* task-24cd55d8a607 — slow-episode banner. The origin circuit breaker is
          open (N consecutive timeouts): the roster keeps its CACHED groups /
          projects / tasks and enrichment waves are paused, so this is a calm
          status note, not an error — nothing was lost, the server is just slow.
          It clears itself the moment a request succeeds (breaker closes). */}
      {originDegraded && (
        <div className="nh__slow-banner" role="status" aria-live="polite">
          <span className="nh__slow-banner-dot" aria-hidden="true" />
          TypeBuild is responding slowly — showing your last-loaded work; details
          will refresh once it recovers.
        </div>
      )}
      {/* task-6589ec3934a4 — stale-sync banner. Distinct from the slow-episode
          banner above: the origin breaker only trips on TIMEOUTS, so a poll
          that silently stops running entirely (this task's root cause) never
          set `degraded` — the roster just froze with no signal at all. This
          reads the main-process poll's own success timestamp, so it catches
          that class of failure too, not just a slow-but-alive origin. Shown
          only once we've actually synced at least once, to avoid a false
          "stale" flash during normal startup before the first poll lands. */}
      {/* The banner carries its own SYNC NOW action: reporting a frozen view
          without offering a way to unfreeze it just tells the user they're
          stuck. It forces one immediate reconcile pass in the main process — so
          it repairs the dead-poll case the banner exists for, rather than only
          re-reading the same frozen cache. On success the pass stamps a new sync
          time and the banner clears itself; on failure we say so in place and
          leave the banner up, since the view really is still stale. */}
      {!originDegraded && syncIsStale && (
        <div className="nh__slow-banner" role="status" aria-live="polite">
          <span className="nh__slow-banner-dot" aria-hidden="true" />
          {syncFailed
            ? `Sync failed — still showing work from ${relTime(lastSyncedAt as number)}.`
            : `Last synced ${relTime(lastSyncedAt as number)} — this view may be out of date.`}
          <button
            type="button"
            className="nh__slow-banner-action"
            onClick={() => void doSyncNow()}
            disabled={syncing}
          >
            {syncing ? 'Syncing…' : syncFailed ? 'Retry' : 'Sync now'}
          </button>
        </div>
      )}
      <div className="nh__topbar">
        <div className="nh__topbar-left">
          {/* task-group-scope-picker — compact GROUP scope, mirroring the
              project picker. "All groups" = no scoping (default); selecting one
              narrows the roster, hero stats, and subproject sections to tasks
              owned by that group (via useNewHomeData's groupId seam). Only shown
              when the current set actually spans one or more groups, so a
              single-group / no-group deployment isn't cluttered. */}
          {groupOptions.length > 0 && (
            <select
              className="nh__project-picker nh__group-picker"
              value={selectedGroupId ?? ''}
              onChange={(e) => {
                const next = e.target.value || null;
                setSelectedGroupId(next);
                // Groups-first: a project outside the new group no longer
                // belongs; clear it so the project picker + roster stay coherent.
                if (
                  selectedProjectId &&
                  next &&
                  projects.find((p) => p.id === selectedProjectId)?.groupId !== next
                ) {
                  setSelectedProjectId(null);
                }
              }}
              title="Scope to one group"
            >
              <option value="">All groups</option>
              {groupOptions.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                  {g.count > 0 ? ` (${g.count})` : ''}
                </option>
              ))}
            </select>
          )}
          {/* Entry point into the Groups management surface (its own singleton
              tab) — a small quiet affordance beside the group scope picker. */}
          <button
            type="button"
            className="nh__manage-groups"
            title="Manage groups — members, roles, invites"
            onClick={() =>
              window.dispatchEvent(new CustomEvent('fm:openGroups'))
            }
          >
            Manage groups
          </button>
          <select
            className="nh__project-picker"
            value={selectedProjectId ?? ''}
            onChange={(e) => setSelectedProjectId(e.target.value || null)}
          >
            <option value="">
              {selectedGroupId ? 'All projects in group' : 'All projects'}
            </option>
            {/* task-a9841cfc0e1b (spec §4) — indent reflects each project's
                depth in the parent/child forest (buildProjectTree), so
                nesting is visible right in the picker without a separate
                breadcrumb UI. Non-breaking-space repeated per depth level
                keeps the indent inside a <select>'s plain-text options. */}
            {flatProjectOptions.map(({ project: p, depth }) => (
              <option key={p.id} value={p.id}>
                {'  '.repeat(depth)}
                {depth > 0 ? '↳ ' : ''}
                {p.name}
                {p.archived ? ' (archived)' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="nh__btn"
            onClick={() => setProjectDialog({ mode: 'create' })}
            title="Create a new project — a named category for tasks"
          >
            + New project
          </button>
          <label className="nh__show-archived">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
          {showArchived && selectedProject?.archived && (
            <button
              type="button"
              className="nh__btn"
              onClick={() => void unarchiveProject(selectedProject.id)}
              disabled={projectActionBusy}
            >
              Unarchive
            </button>
          )}
        </div>
        <div className="nh__topbar-right">
          <button
            type="button"
            className="nh__btn"
            onClick={() => openNewTask('template')}
            title="Pick a prior fielded task or chain and fill just its input values — everything else (project, notes, output schema, agent) is inherited"
          >
            + New from Template
          </button>
          <button
            type="button"
            className="nh__btn"
            onClick={() => openNewTask('chain')}
            title="Create a multi-step chained task — steps, inputs, and evidence defined inline"
          >
            + New Chained Task
          </button>
          <button
            type="button"
            className="nh__btn nh__btn--primary"
            onClick={() => openNewTask()}
          >
            + New Task
          </button>
        </div>
      </div>

      <div className="nh__content">
        <div className="nh__hero">
          <div className="nh__hero-text">
            {selectedProjectId && (
              <nav className="nh__breadcrumb" aria-label="Project path">
                <button
                  type="button"
                  className="nh__breadcrumb-crumb"
                  onClick={() => setSelectedProjectId(null)}
                >
                  All projects
                </button>
                {breadcrumb.map((p, i) => {
                  const isLast = i === breadcrumb.length - 1;
                  return (
                    <span key={p.id} className="nh__breadcrumb-seg">
                      <span className="nh__breadcrumb-sep" aria-hidden="true">
                        ›
                      </span>
                      {isLast ? (
                        <span className="nh__breadcrumb-current">{p.name}</span>
                      ) : (
                        <button
                          type="button"
                          className="nh__breadcrumb-crumb"
                          onClick={() => setSelectedProjectId(p.id)}
                        >
                          {p.name}
                        </button>
                      )}
                    </span>
                  );
                })}
              </nav>
            )}
            {/* Hover-to-edit (task-5c8ca16e8e46): hovering the title or
                description reveals an inline ✎ affordance; clicking it opens the
                existing project edit dialog (scoped to this project). No inline
                editing engine — just the discoverable hover+click into the edit
                flow already used by the header's Edit action. */}
            {selectedProject ? (
              <button
                type="button"
                className="nh__hero-editable"
                onClick={() => setProjectDialog({ mode: 'edit', project: selectedProject })}
                disabled={projectActionBusy}
                title="Edit project"
              >
                <span className="nh__hero-title nh__hero-editable-text">
                  {selectedProject.name}
                </span>
                <span className="nh__hero-editable-pencil" aria-hidden="true">✎</span>
              </button>
            ) : (
              <div className="nh__hero-title">New Home</div>
            )}
            {selectedProject && !loading ? (
              <button
                type="button"
                className="nh__hero-editable"
                onClick={() => setProjectDialog({ mode: 'edit', project: selectedProject })}
                disabled={projectActionBusy}
                title="Edit project description"
              >
                <span className="nh__hero-sub nh__hero-editable-text">
                  {selectedProject.description || 'Agent work monitor for this project'}
                </span>
                <span className="nh__hero-editable-pencil" aria-hidden="true">✎</span>
              </button>
            ) : (
              <div className="nh__hero-sub">
                {loading
                  ? 'Loading…'
                  : 'Agent work monitor — every project, ranked by what needs you'}
              </div>
            )}
            {selectedProject?.instructions && (
              <div className="nh__hero-instructions">
                <span className="nh__hero-instructions-label">Agent instructions:</span>{' '}
                <span className="nh__hero-instructions-text">{selectedProject.instructions}</span>{' '}
                <button
                  type="button"
                  className="nh__hero-instructions-more"
                  onClick={() => setInstructionsExpanded(true)}
                >
                  Read more
                </button>
              </div>
            )}
            {instructionsExpanded && selectedProject?.instructions && (
              <div
                className="nh-dialog-backdrop"
                onClick={() => setInstructionsExpanded(false)}
              >
                <div
                  className="nh-dialog nh__instructions-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="nh-instructions-dialog-title"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="nh-dialog__head">
                    <div id="nh-instructions-dialog-title" className="nh-dialog__title">
                      Agent instructions
                    </div>
                    <button
                      type="button"
                      className="nh__icon-btn"
                      onClick={() => setInstructionsExpanded(false)}
                      title="Close"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="nh-dialog__body nh__instructions-dialog-body">
                    {selectedProject.instructions}
                  </div>
                </div>
              </div>
            )}
          </div>
          {/* task-a9841cfc0e1b (spec §2/§3) — edit/archive/delete live on the
              selected project's hero, not a separate settings page: rename,
              edit description/instructions/folders, or archive/delete it,
              all without leaving New Home. task-5c8ca16e8e46 — compact icon
              buttons via the SHARED IconActionButton, not oversized text. */}
          {selectedProject && (
            <div className="nh__hero-actions">
              <IconActionButton
                icon="✎"
                label="Edit project"
                onClick={() => setProjectDialog({ mode: 'edit', project: selectedProject })}
                disabled={projectActionBusy}
              />
              <IconActionButton
                icon="🗄"
                label="Archive project (hides it from the picker; reversible)"
                onClick={confirmArchive}
                disabled={projectActionBusy}
              />
              <IconActionButton
                icon="🗑"
                label="Delete project (permanent; only if it has no tasks)"
                onClick={confirmDelete}
                disabled={projectActionBusy}
                variant="danger"
              />
            </div>
          )}
        </div>

        {projectActionError && (
          <div className="nh__project-action-error">
            {projectActionError}
            <button
              type="button"
              className="nh-filter-chip__x"
              aria-label="Dismiss"
              onClick={() => setProjectActionError(null)}
            >
              ×
            </button>
          </div>
        )}

        <HeroStats counts={counts} activeFilter={filter} onFilter={setFilter} />

        {(filter !== 'all' || search.trim() || selectedGroupId) && (
          <div className="nh-filter-chip-bar">
            <span className="nh-filter-chip-bar__label">Filtering:</span>
            {/* task-group-scope-picker — the active group scope renders as a
                chip in the SAME bar as the status/search filters, so every
                applied narrowing is visible and clearable by hand. */}
            {selectedGroupId && (
              <span className="nh-filter-chip nh-filter-chip--group">
                <span className="nh-filter-chip__text">Group: {groupLabel(selectedGroupId, groupNames)}</span>
                <button
                  type="button"
                  className="nh-filter-chip__x"
                  aria-label="Clear group scope"
                  title="Clear group scope"
                  onClick={() => setSelectedGroupId(null)}
                >
                  ×
                </button>
              </span>
            )}
            {filter !== 'all' && (
              <span className={`nh-filter-chip nh-filter-chip--status nh-filter-chip--${filter}`}>
                <span className="nh-filter-chip__text">{FILTER_LABELS[filter]}</span>
                <button
                  type="button"
                  className="nh-filter-chip__x"
                  aria-label="Clear status filter"
                  title="Clear status filter"
                  onClick={() => setFilter('all')}
                >
                  ×
                </button>
              </span>
            )}
            {search.trim() && (
              <span
                className={
                  'nh-filter-chip' +
                  (queryState.kind === 'query' ? ' nh-filter-chip--query' : '') +
                  (queryState.kind === 'invalid' ? ' nh-filter-chip--invalid' : '')
                }
                title={
                  queryState.kind === 'invalid'
                    ? `Invalid query: ${queryState.error}`
                    : queryState.kind === 'query'
                      ? 'Structured query'
                      : 'Text search'
                }
              >
                <span className="nh-filter-chip__kind">
                  {queryState.kind === 'query' ? '⚡' : queryState.kind === 'invalid' ? '⚠' : '🔍'}
                </span>
                <span className="nh-filter-chip__text">{search.trim()}</span>
                <button
                  type="button"
                  className="nh-filter-chip__x"
                  aria-label="Clear search / query"
                  title="Clear search / query"
                  onClick={() => setSearch('')}
                >
                  ×
                </button>
              </span>
            )}
            <button
              type="button"
              className="nh-filter-chip-bar__clear-all"
              onClick={() => {
                setFilter('all');
                setSearch('');
                setSelectedGroupId(null);
              }}
            >
              Clear all
            </button>
          </div>
        )}

        <RosterTable
          tasks={pagedOwnTasks}
          subprojectSections={subprojectSections}
          onNavigateProject={setSelectedProjectId}
          filter={filter}
          search={search}
          queryMode={queryState.kind}
          queryError={queryState.kind === 'invalid' ? queryState.error : undefined}
          loading={loading}
          onOpenTask={openTaskDetail}
          onFilter={setFilter}
          onSearch={setSearch}
          onRetry={startTask}
          onStart={startTask}
          onCancel={cancelTask}
        />

        {/* Roster footer: pagination + the recency cutoff toggle. Only rendered
            when there's something more to reveal, so it stays out of the way. */}
        {(rosterHasMore || coldCount > 0 || (showOlder && coldCount === 0)) && (
          <div className="nh-roster-more">
            {rosterHasMore && (
              <button
                type="button"
                className="nh-roster-more__btn"
                onClick={() => setPageLimit((n) => n + PAGE_SIZE)}
              >
                Load more <span className="nh-roster-more__count">({rosterShown} of {rosterTotal})</span>
              </button>
            )}
            {coldCount > 0 && !showOlder && (
              <button
                type="button"
                className="nh-roster-more__link"
                onClick={() => setShowOlder(true)}
              >
                Show {coldCount} older {coldCount === 1 ? 'task' : 'tasks'}
              </button>
            )}
            {showOlder && (
              <button
                type="button"
                className="nh-roster-more__link"
                onClick={() => setShowOlder(false)}
              >
                Hide older tasks
              </button>
            )}
          </div>
        )}
      </div>

      {openTaskId && (
        <TaskDetailDialog
          taskId={openTaskId}
          task={openTask}
          tasks={tasks}
          onOpenTask={openTaskDetail}
          onClose={() => setOpenTaskId(null)}
          onResolved={() => {
            // Resolve/cancel/retry all flow through here so stats and the
            // roster row update in place from the same refreshed
            // useNewHomeData snapshot, rather than each surface tracking its
            // own optimistic patch.
            void refresh();
            setOpenTaskId(null);
          }}
        />
      )}

      {projectDialog && (
        <ProjectDialog
          project={projectDialog.mode === 'edit' ? projectDialog.project : null}
          projects={projects}
          // task-group-select-dialog — preselect the new project's group from
          // the group currently scoped in New Home (null = "All groups").
          defaultGroupId={selectedGroupId}
          onClose={() => setProjectDialog(null)}
          onSaved={(project) => onProjectSaved(project, projectDialog.mode === 'create')}
        />
      )}

    </div>
  );
}
