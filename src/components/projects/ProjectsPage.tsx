// task-83048f692491 / task-4b0168979921 — Projects home, now an INBOX.
// A singleton tab (kind='projects') that lives in the existing shell alongside
// the Tasks page. It consumes the projects bridge (window.fm.typebuild.projects.*)
// and the pure foundation resolver (src/projects/) — it does NOT rebuild either.
//
// task-4b0168979921 reframes L1 from a calm CARD GRID to a dense, email-INBOX
// LIST aligned with epic task-3ff338f80de5's folder/file aesthetic: a project
// reads like a FOLDER row (a status glyph + the project NAME + a short
// DESCRIPTION underneath), its tasks (files) listed when you drill in. One
// project per line, minimal status-icon vocabulary, a folder-style breadcrumb.
//
// Three zoom levels, transitioned in-place (no new tabs):
//   L1 INBOX    every project as one dense row. The ONE bright thing is the
//               amber "needs you" count (only when > 0). Aggregate stats roll UP
//               from sub-projects. Ranked by the shared attention partition.
//   L1 SCOPED   a project with children shows the SAME list, scoped to its
//               children, with a breadcrumb back to all projects.
//   L2 DETAIL   drill into a project → its parent→child task tree with roll-up
//               SENTENCES on parents ("4 of 6 done · 1 needs you") and visible
//               blocked-by dependencies. Reuses the task partition helpers.
//
// Keyboard model (mirrors TasksPage's verb-first motion model):
//   j/k or ↑/↓   move cursor
//   gg / G       jump to top / bottom of the list
//   l / Enter    drill in (row → scoped list or project tree; tree row → task)
//   h / Esc      back up one zoom level
//   /            open the UNIFIED quick-switcher (projects AND tasks). Picking a
//                project drills into it; picking a task navigates to the Tasks
//                page focused on that row (no fork — it reuses fm:tasks:focus).
//   :            open the command palette (verbs act on the app)
//
// PHI: project name/description/instructions/folders are NON-PHI teaching
// context — safe to render. Task TITLES are PHI; in the L2 tree and the
// quick-switcher we render task titles for the human operating their own
// machine (same as TasksPage), never to disk/logs.

import { useEffect, useMemo, useRef, useState } from 'react';
import { fm } from '../../bridge';
import { useStore } from '../../store';
import { useTasks, useTypebuildAuth, signInTypebuildBrowser } from '../../tasks';
import type { Project, Task } from '../../types';
import {
  buildProjectTree,
  indexTree,
  ancestorChain,
  breadcrumbPath,
  rollUpTaskStats,
  computeProjectAttention,
  needsAttention,
  resolveEffectiveDescription,
  resolveEffectiveInstructions,
} from '../../projects/index.mjs';
import type { ProjectNode, TaskStats, ProjectAttention } from '../../projects/index.mjs';
import { resolveBlockedBy, partitionTasks } from '../tasks/sections.mjs';
import {
  loadProjectsViewPrefs,
  saveProjectsViewPrefs,
} from '../../projectsViewPrefs';
import { ProjectFolderBlock, ProjectRow } from './ProjectFolderBlock';
import type { ProjectFolderRow, ProjectTasksProvider } from './ProjectFolderBlock';
import { useProjectTaskRows } from './useProjectTaskRows';
// task-49b7b37c8a02 — type-to-command: the Home quick-switcher blends verbs
// (project/task + top-level) with project/task entity fallback, mirroring
// ChipPrompt's allOptions/pickOption pattern.
import { effectiveVerbsFor, useVerbCtx, type VerbDef } from '../ChipPrompt';
import { rankPaletteVerbs } from '../../verbPalette.mjs';
import type { PaletteVerb } from '../../verbPalette.mjs';
import { fm as bridgeFm } from '../../bridge';
import type { Launcher } from '../../bridge';
import './ProjectsPage.css';

const CTX_MARK = '◇ given to agents as context';

// task-2c9c2e6a7bca — sign in DIRECTLY: kick off the browser OAuth flow rather
// than opening Settings first. Signed-out CTAs call this so "Sign in" does the
// one thing it says, with status-bar feedback (and a Settings fallback only if
// the server handoff isn't live).
export function openTypebuildSignIn(): void {
  void signInTypebuildBrowser();
}

// Q4 — project-less tasks live in a synthetic "Inbox (no project)" block, always
// first on Home root. This id never collides with a real project id.
const INBOX_ID = '__inbox_no_project__';

// ── status mapping (mirrors the foundation resolver's classifyTask) ──────────
type RowStatus = 'working' | 'need' | 'blocked' | 'done' | 'passive';
function rowStatusOf(t: Task): RowStatus {
  const raw = (t.rawStatus ?? t.status ?? '').toLowerCase();
  if (raw === 'blocked' || raw === 'failed') return 'blocked';
  if (t.status === 'done' || t.status === 'cancelled') return 'done';
  if (t.status === 'in_progress') return 'working';
  return 'need'; // pending / open — wants a human
}

// ── minimal status-icon vocabulary (task-4b0168979921) ───────────────────────
// One glyph per project row, derived from the SHARED attention partition — we
// do NOT re-derive ranking here. Loudest signal wins: blocked/failed → recent
// activity → needs-you → working → quiet.
//   ⛔ blocked   ⚑ needs you   ◷ working   ◦ quiet
// task-875c6ad17f85 — the old `◦ idle` and `◌ clear` glyphs were visually
// indistinguishable and undocumented, so they read as noise. They're merged
// into a single `quiet` state, and every glyph now carries a `title=` tooltip
// (STATUS_LABEL) so the vocabulary is self-explaining instead of needing a
// separate legend.
type ProjStatus = 'blocked' | 'need' | 'working' | 'quiet';
function projStatusOf(
  att: ProjectAttention | undefined,
  rolled: TaskStats | undefined,
): ProjStatus {
  if (att) {
    if (att.blocked > 0 || att.failed > 0) return 'blocked';
    if (att.total > 0) return 'need';
  }
  if ((rolled?.inProgress ?? 0) > 0) return 'working';
  return 'quiet';
}
const STATUS_GLYPH: Record<ProjStatus, string> = {
  blocked: '⛔',
  need: '⚑',
  working: '◷',
  quiet: '◦',
};
const STATUS_LABEL: Record<ProjStatus, string> = {
  blocked: 'Blocked or failed',
  need: 'Needs you',
  working: 'Agents working',
  quiet: 'Nothing pending',
};

function ProjectsPageInner() {
  const { state, dispatch } = useStore();
  // task-97c0800ff55d — Home now rides kind:'home' (was the relabeled
  // 'projects'). Accept both so keyboard/event handling stays live on Home.
  const activeKind = state.tabs[state.activeTab]?.kind;
  const isActive = activeKind === 'home' || activeKind === 'projects';

  // ── verbs for type-to-command (task-49b7b37c8a02) ───────────────────────────
  // The Home quick-switcher blends VERBS (project/task + top-level, gated to the
  // 'home' tab kind via effectiveVerbsFor) with the project/task entity
  // fallback. Verbs run through the same path as the Cmd-K palette: hand the id
  // to ChipPrompt via setMode/command, which owns slot collection + execution.
  const verbCtx = useVerbCtx();
  const [launchers, setLaunchers] = useState<Launcher[]>([]);
  useEffect(() => {
    void bridgeFm.launchersList().then(setLaunchers).catch(() => {});
  }, []);
  const paletteVerbs: PaletteVerb[] = useMemo(() => {
    const defs: VerbDef[] = effectiveVerbsFor({
      tasksEnabled: state.taskManagementEnabled,
      tabKind: 'home',
      launchers,
    });
    return defs.map((v) => {
      // task-57542e3435af — a single verb's isAvailable / describe must NEVER
      // blank the whole palette. BOTH are guarded: if one verb throws (e.g. it
      // reaches for a Ctx field that's momentarily undefined on the Home tab),
      // it must not take the entire command list down with it. That throw was
      // exactly the "type 'file manager' → No matches" bug: a sibling verb's
      // isAvailable threw, the paletteVerbs map blew up, and the Files command
      // (and every other verb) silently vanished from the quick-switcher.
      let avail: { ok: boolean; reason?: string } = { ok: true };
      try {
        if (verbCtx) avail = v.isAvailable(verbCtx);
      } catch {
        avail = { ok: true };
      }
      let description = '';
      try {
        description = verbCtx ? v.describe(verbCtx) : '';
      } catch {
        description = '';
      }
      return {
        id: v.id,
        label: v.label,
        aliases: v.aliases,
        category: v.category,
        description,
        available: avail.ok,
        keybinding: v.keybinding,
      };
    });
  }, [state.taskManagementEnabled, launchers, verbCtx]);
  const runVerb = (verbId: string) => {
    dispatch({ type: 'setMode', mode: 'command', verb: verbId });
  };

  // ── data ──────────────────────────────────────────────────────────────────
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  // task-81b7ce77a30a — signed-out Home shouldn't offer a "+ New project" CTA
  // that can't succeed; gate the empty state to a sign-in prompt instead.
  const { signedIn: tbSignedIn } = useTypebuildAuth();

  // "Show all" reveals idle projects; "Show archived" includes archived ones
  // (re-fetched with ?archived=1). Both persisted in projectsViewPrefs.
  const [showAll, setShowAll] = useState<boolean>(
    () => loadProjectsViewPrefs().showAll,
  );
  const [showArchived, setShowArchived] = useState<boolean>(
    () => loadProjectsViewPrefs().showArchived,
  );
  // task-6050fee0efb1 — Projects-first ('projects') vs Tasks-first ('flat'),
  // persisted alongside the other view prefs.
  const [homeView, setHomeView] = useState<'projects' | 'flat'>(
    () => loadProjectsViewPrefs().homeView,
  );
  useEffect(() => {
    saveProjectsViewPrefs({ showAll, showArchived, homeView });
  }, [showAll, showArchived, homeView]);

  useEffect(() => {
    let cancelled = false;
    void fm.typebuild.projects
      .list(showArchived)
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        setLoadErr(null);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadErr(e instanceof Error ? e.message : String(e));
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick, showArchived]);

  // Pull all tasks (incl. done) once; roll up per-project client-side. The
  // partition is by project, not owner, so we want the whole set.
  const { tasks: allTasks } = useTasks({ includeDone: true });

  const roots = useMemo(() => buildProjectTree(projects), [projects]);
  const nodeById = useMemo(() => indexTree(roots), [roots]);
  const rollUp = useMemo(
    () => rollUpTaskStats(roots, allTasks),
    [roots, allTasks],
  );

  // task-6255239581b2 — "what needs my attention" reframe. We capture the
  // page's mount time once and feed it as the activity floor: the TypeBuild
  // list endpoint stamps now() onto every non-terminal task's created/updated
  // (it carries no real timestamps — see mapListRow), so any timestamp at/after
  // mount is a placeholder and must NOT count as "recent activity" (else idle
  // never fires). Anything below the floor is a real, older stamp.
  const mountMsRef = useRef<number>(Date.now());
  const attention = useMemo(
    () =>
      computeProjectAttention(roots, allTasks, {
        activityFloorMs: mountMsRef.current,
      }),
    [roots, allTasks],
  );

  // ── zoom state ─────────────────────────────────────────────────────────────
  // level 1 = grid; level 2 = a single project's task tree.
  const [level, setLevel] = useState<1 | 2>(1);
  // L1 scope: null = all roots; else a project id whose CHILDREN we show.
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  // task-18902d433658 — "Needs you" filter for the DRILLED-IN project list. When
  // set to the open project's id, ProjectFolderBlock shows ONLY the tasks the
  // attention classifier counts toward "N need you" (open/blocked/overdue/
  // failed) — the same predicate that drives the count, so the two can't drift.
  // null = show every task (the default folder view).
  const [needsYouFilter, setNeedsYouFilter] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showCreate, setShowCreate] = useState(false);
  // homeView (Projects-first / Tasks-first) is declared + persisted above with
  // the other view prefs (task-6050fee0efb1).
  const [flatDoneOpen, setFlatDoneOpen] = useState(false);
  // task-4b0168979921 — unified quick-switcher (projects AND tasks). '/' opens.
  // task-49b7b37c8a02 — it also opens by simply typing: the first printable key
  // seeds the search so type-to-command works without a leading '/'. The seed is
  // the character that opened it (empty when opened via '/').
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [switcherSeed, setSwitcherSeed] = useState('');
  // gg/G motion: remember a pending 'g' so the next 'g' jumps to the top.
  const gPendingRef = useRef(false);

  const gridRef = useRef<HTMLDivElement | null>(null);

  // The project nodes in scope for the current L1 grid (unranked).
  const scopeNodes: ProjectNode[] = useMemo(() => {
    if (scopeId == null) return roots;
    return nodeById.get(scopeId)?.children ?? [];
  }, [roots, scopeId, nodeById]);

  // task-6255239581b2 — partition + rank the scoped nodes by attention.
  //   attentionNodes  needs-you (score desc, then recency, then name) — above
  //   recentNodes     no attention but recent/unknown activity — below the fold
  //   idleNodes       no attention AND stale → hidden unless `showAll`
  // Recency is a tiebreaker, not the headline. Within "recent" we still order
  // by last activity desc so the freshest non-urgent project sits highest.
  const partitioned = useMemo(() => {
    const att = (id: string): ProjectAttention | undefined => attention.get(id);
    const lastAct = (id: string) => att(id)?.lastActivityMs ?? 0;
    const nameOf = (n: ProjectNode) => (n.project.name ?? '').toLowerCase();
    const byAttention = (a: ProjectNode, b: ProjectNode) => {
      const sa = att(a.project.id)?.score ?? 0;
      const sb = att(b.project.id)?.score ?? 0;
      if (sa !== sb) return sb - sa;
      const ra = lastAct(a.project.id);
      const rb = lastAct(b.project.id);
      if (ra !== rb) return rb - ra;
      return nameOf(a).localeCompare(nameOf(b));
    };
    const byRecency = (a: ProjectNode, b: ProjectNode) => {
      const ra = lastAct(a.project.id);
      const rb = lastAct(b.project.id);
      if (ra !== rb) return rb - ra;
      return nameOf(a).localeCompare(nameOf(b));
    };
    const attentionNodes: ProjectNode[] = [];
    const recentNodes: ProjectNode[] = [];
    const idleNodes: ProjectNode[] = [];
    for (const n of scopeNodes) {
      const a = att(n.project.id);
      if ((a?.total ?? 0) > 0) attentionNodes.push(n);
      else if (a?.idle) idleNodes.push(n);
      else recentNodes.push(n);
    }
    attentionNodes.sort(byAttention);
    recentNodes.sort(byRecency);
    idleNodes.sort(byRecency);
    return { attentionNodes, recentNodes, idleNodes };
  }, [scopeNodes, attention]);

  // The full ordered visible sequence (drives keyboard cursor indices). Hidden
  // idle nodes are appended only when `showAll` is on.
  const gridNodes: ProjectNode[] = useMemo(() => {
    const base = [...partitioned.attentionNodes, ...partitioned.recentNodes];
    return showAll ? [...base, ...partitioned.idleNodes] : base;
  }, [partitioned, showAll]);

  // ── L2 derived data ─────────────────────────────────────────────────────────
  // The Inbox stays an inline block (it's the project-less catch-all — there is
  // no real folder to "open"), so detail drill-in resolves real nodes only.
  const detailNode = detailId ? nodeById.get(detailId) ?? null : null;
  const detailProject = detailNode?.project ?? null;
  const detailChain = useMemo(
    () => (detailId ? ancestorChain(roots, detailId) : []),
    [roots, detailId],
  );
  const effectiveDesc = useMemo(
    () =>
      detailChain.length > 0 ? resolveEffectiveDescription(detailChain).text : '',
    [detailChain],
  );
  const effectiveInstructions = useMemo(() => {
    if (!detailProject) return null;
    return resolveEffectiveInstructions({
      project: {
        id: detailProject.id,
        instructions: detailProject.instructions,
        effectiveInstructions: detailProject.effectiveInstructions,
        label: 'project',
      },
    });
  }, [detailProject]);

  // ── folder-block task rows (task-1bf3a297c9f9) ──────────────────────────────
  // A project renders its tasks as FILES (real TaskRows). rowsForProject shapes
  // a project's own tasks into a (parent → child) folder list, honoring the
  // shared `expanded` set so a parent collapses its children — the same model as
  // the L2 tree, now reused by ProjectFolderBlock at any nesting level.
  const tasksByProject = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of allTasks) {
      // Q4 — project-less tasks bucket under the synthetic Inbox id.
      const key = t.projectId ?? INBOX_ID;
      const arr = m.get(key) ?? [];
      arr.push(t);
      m.set(key, arr);
    }
    return m;
  }, [allTasks]);

  // Q4 — non-terminal project-less tasks (drives the synthetic Inbox block; it
  // only appears when there is at least one open orphan task).
  const inboxOpenCount = useMemo(
    () =>
      (tasksByProject.get(INBOX_ID) ?? []).filter(
        (t) => t.status !== 'done' && t.status !== 'cancelled',
      ).length,
    [tasksByProject],
  );
  const inboxTotalCount = (tasksByProject.get(INBOX_ID) ?? []).length;

  // A synthetic ProjectNode for the Inbox block (NON-PHI; name is a label).
  const inboxNode = useMemo<ProjectNode>(
    () => ({
      project: {
        id: INBOX_ID,
        name: 'Inbox (no project)',
        description: 'Tasks not yet filed under a project.',
        instructions: null,
        parentProjectId: null,
        folders: [],
        createdBy: null,
        groupId: null,
        createdAt: null,
        updatedAt: null,
      },
      children: [],
      depth: 0,
      parentId: null,
    }),
    [],
  );

  // rollUp/attention for the synthetic Inbox so its header reads a real count.
  // We only surface counts the data backs (open total + a "needs you" tally for
  // pending/blocked orphans); no invented recency.
  const inboxRollUp = useMemo(() => {
    const own = tasksByProject.get(INBOX_ID) ?? [];
    const empty: TaskStats = {
      total: 0, open: 0, inProgress: 0, done: 0, cancelled: 0, blocked: 0, needsYou: 0,
    };
    const rolled: TaskStats = { ...empty };
    for (const t of own) {
      rolled.total += 1;
      const rs = rowStatusOf(t);
      if (rs === 'done') rolled.done += 1;
      else if (rs === 'working') rolled.inProgress += 1;
      else if (rs === 'blocked') { rolled.blocked += 1; rolled.needsYou += 1; rolled.open += 1; }
      else if (rs === 'need') { rolled.needsYou += 1; rolled.open += 1; }
    }
    const m = new Map<string, { own: TaskStats; rolled: TaskStats }>(rollUp);
    m.set(INBOX_ID, { own: rolled, rolled });
    return m;
  }, [tasksByProject, rollUp]);

  const inboxAttention = useMemo(() => {
    const r = inboxRollUp.get(INBOX_ID)?.rolled;
    const m = new Map<string, ProjectAttention>(attention);
    m.set(INBOX_ID, {
      open: r?.open ?? 0,
      blocked: r?.blocked ?? 0,
      overdue: 0,
      failed: 0,
      total: r?.needsYou ?? 0,
      score: r?.needsYou ?? 0,
      lastActivityMs: null,
      idle: false,
    });
    return m;
  }, [inboxRollUp, attention]);

  const rowsForProject = useMemo(
    () =>
      (projectId: string): ProjectFolderRow[] => {
        const all = tasksByProject.get(projectId) ?? [];
        if (all.length === 0) return [];
        // task-18902d433658 — when the "Needs you" filter targets THIS project,
        // narrow to exactly the tasks the attention classifier counts (the same
        // predicate behind "N need you"), so the filtered list and the count can
        // never disagree. A surviving child whose parent is filtered out simply
        // becomes a top-level row below (its parent isn't in `byId`).
        const own =
          needsYouFilter === projectId ? all.filter((t) => needsAttention(t)) : all;
        if (own.length === 0) return [];
        const byId = new Map(own.map((t) => [t.id, t]));
        const childrenOf = new Map<string, Task[]>();
        const parents: Task[] = [];
        for (const t of own) {
          const pid = t.parentTaskId;
          if (pid && byId.has(pid)) {
            const arr = childrenOf.get(pid) ?? [];
            arr.push(t);
            childrenOf.set(pid, arr);
          } else {
            parents.push(t);
          }
        }
        const out: ProjectFolderRow[] = [];
        for (const parent of parents) {
          const kids = childrenOf.get(parent.id) ?? [];
          const done = kids.filter(
            (k) => k.status === 'done' || k.status === 'cancelled',
          ).length;
          out.push({ task: parent, depth: 0, childCount: kids.length, doneChildCount: done });
          if (expanded.has(parent.id)) {
            for (const k of kids) {
              out.push({ task: k, depth: 1, childCount: 0, doneChildCount: 0 });
            }
          }
        }
        return out;
      },
    [tasksByProject, expanded, needsYouFilter],
  );

  // Selection + cursor for the folder-block surface. cursorKey is a task id OR a
  // project id (sub-project rows). Phase 1 keeps selection light; Phase 4 wires
  // the full flat keyboard model across headers + rows.
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [cursorKey, setCursorKey] = useState<string | null>(null);

  const taskRowState = useMemo(
    () => ({ selected: selectedTasks, cursorKey, expanded }),
    [selectedTasks, cursorKey, expanded],
  );
  const taskRowHandlers = useMemo(
    () => ({
      onRowClick: (_e: React.MouseEvent, task: Task) => setCursorKey(task.id),
      onToggleSelect: (taskId: string) =>
        setSelectedTasks((prev) => {
          const next = new Set(prev);
          if (next.has(taskId)) next.delete(taskId);
          else next.add(taskId);
          return next;
        }),
      onSetCursor: (taskId: string) => setCursorKey(taskId),
      onToggleExpand: (taskId: string) => toggleExpand(taskId),
      blockedByFor: undefined,
      blockedByTitles: (task: Task) => resolveBlockedBy(task.blockedBy, allTasks),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allTasks],
  );

  const { renderTaskRow, overlays: taskRowOverlays, bulkApply } = useProjectTaskRows(
    taskRowState,
    taskRowHandlers,
  );

  const tasksProvider: ProjectTasksProvider = useMemo(
    () => ({ rowsFor: rowsForProject, renderTaskRow }),
    [rowsForProject, renderTaskRow],
  );

  // ── flat view (task-9d54b7ab7972, Phase 5) ──────────────────────────────────
  // The all-tasks inbox folded into Home as a flat view. Reuses the shared
  // partition (FOR YOU / FOR AGENTS / DONE) and the SAME renderTaskRow engine,
  // so it reads identically to a folder list. Honors the shared `expanded` set
  // for FOR AGENTS parent rows.
  const flatPartition = useMemo(() => partitionTasks(allTasks, {}), [allTasks]);
  type FlatSection = { id: string; title: string; rows: ProjectFolderRow[] };
  const flatSections = useMemo<FlatSection[]>(() => {
    const forYouRows: ProjectFolderRow[] = flatPartition.forYou.map((t) => ({
      task: t,
      depth: 0,
      childCount: 0,
      doneChildCount: 0,
    }));
    // FOR AGENTS carries parent/child grouping; collapse child rows under
    // parents that aren't expanded (mirrors the flat TasksPage behavior).
    const agentRows: ProjectFolderRow[] = [];
    for (const r of flatPartition.forAgentsRows) {
      if (
        r.depth === 1 &&
        r.task.parentTaskId &&
        !expanded.has(r.task.parentTaskId)
      ) {
        continue;
      }
      agentRows.push({
        task: r.task,
        depth: r.depth,
        childCount: r.childCount ?? 0,
        doneChildCount: r.doneChildCount ?? 0,
      });
    }
    const doneRows: ProjectFolderRow[] = flatDoneOpen
      ? flatPartition.done.map((t) => ({
          task: t,
          depth: 0,
          childCount: 0,
          doneChildCount: 0,
        }))
      : [];
    const out: FlatSection[] = [];
    out.push({ id: 'for-you', title: 'For you', rows: forYouRows });
    out.push({ id: 'for-agents', title: 'For agents', rows: agentRows });
    if (flatPartition.doneTotal > 0) {
      out.push({ id: 'done', title: `Done (${flatPartition.doneTotal})`, rows: doneRows });
    }
    return out;
  }, [flatPartition, expanded, flatDoneOpen]);

  // ── flat keyboard order (task-1bf3a297c9f9, Phase 4) ────────────────────────
  // The visible cursor sequence, walked flat by j/k exactly like FolderList
  // walks entries. It interleaves, in RENDER ORDER, project HEADERS + their TASK
  // rows + SUB-PROJECT rows, matching the DOM so scrollIntoView + cursor classes
  // line up. `key` is a project id (header / sub-project) or a task id.
  type FlatRow =
    | { kind: 'header'; key: string; projectId: string }
    | { kind: 'task'; key: string; task: Task; isParent: boolean }
    | { kind: 'subproject'; key: string; projectId: string };

  const flatRows = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    // A project block: its header, its OWN task rows, then ONE collapsed row per
    // sub-project (file-manager model — a sub-project's tasks live behind its
    // own drill-in, never inline under the parent). Matches the DOM so the
    // cursor + scrollIntoView line up.
    const pushBlock = (node: ProjectNode) => {
      const pid = node.project.id;
      out.push({ kind: 'header', key: pid, projectId: pid });
      for (const row of rowsForProject(pid)) {
        out.push({
          kind: 'task',
          key: row.task.id,
          task: row.task,
          isParent: row.childCount > 0,
        });
      }
      for (const child of node.children) {
        out.push({
          kind: 'subproject',
          key: child.project.id,
          projectId: child.project.id,
        });
      }
    };

    // Flat view (Phase 5): cursor walks the visible task rows across sections.
    if (level === 1 && homeView === 'flat') {
      for (const sec of flatSections) {
        for (const row of sec.rows) {
          out.push({
            kind: 'task',
            key: row.task.id,
            task: row.task,
            isParent: row.childCount > 0,
          });
        }
      }
      return out;
    }
    if (level === 2 && detailNode) {
      pushBlock(detailNode);
      return out;
    }
    // root (task-6050fee0efb1): the Inbox keeps its inline block (header +
    // tasks), but every real project is now ONE compact row — no inline tasks,
    // no expanded sub-projects — so the cursor walks just the project ids.
    if (scopeId == null && inboxTotalCount > 0) pushBlock(inboxNode);
    for (const node of gridNodes) {
      out.push({ kind: 'header', key: node.project.id, projectId: node.project.id });
    }
    return out;
  }, [level, homeView, flatSections, detailNode, scopeId, inboxTotalCount, inboxNode, gridNodes, rowsForProject]);

  const flatIndexOf = (key: string | null) =>
    key == null ? -1 : flatRows.findIndex((r) => r.key === key);

  // Clamp / seed the cursor when the visible set changes.
  useEffect(() => {
    if (flatRows.length === 0) {
      if (cursorKey !== null) setCursorKey(null);
      return;
    }
    if (cursorKey == null || flatIndexOf(cursorKey) < 0) {
      setCursorKey(flatRows[0].key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatRows]);

  // ── navigation ──────────────────────────────────────────────────────────────
  // Drill into a project = its full folder view (level 2), where sub-projects
  // nest as nested blocks (Q5: full nesting only when drilled in). The old
  // "re-scope the grid to a parent's children" path is retired — every project,
  // with or without children, opens as a folder.
  function enterCard(node: ProjectNode) {
    setDetailId(node.project.id);
    setExpanded(new Set());
    setLevel(2);
    setCursorKey(node.project.id);
    setNeedsYouFilter(null);
    // task-54e9281f0986 — the create form is level-scoped; drop any open one so
    // it doesn't bleed across the root ↔ detail boundary.
    setShowCreate(false);
  }
  // task-18902d433658 — drill into a project AND filter its task list to exactly
  // the "needs you" tasks (the clickable count affordance). Reuses enterCard's
  // drill-in, then arms the filter for that project.
  function openProjectNeedsYou(projectId: string) {
    const node = nodeById.get(projectId);
    if (!node) return;
    enterCard(node);
    setNeedsYouFilter(projectId);
  }
  function backUp() {
    if (level === 2) {
      setLevel(1);
      setShowCreate(false);
      return;
    }
    if (scopeId != null) {
      const parentNode = nodeById.get(scopeId);
      setScopeId(parentNode?.parentId ?? null);
    }
  }
  function openTaskDetail(task: Task) {
    // Reuse the Tasks-tab focus path: open the Tasks tab and focus the row so
    // the detail panel / session are reachable (same as a sidebar click).
    dispatch({ type: 'openTasksTab' });
    requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent('fm:tasks:focus', { detail: { taskId: task.id } }),
      );
    });
  }
  // task-223d400ffc1a — project-scoped create now opens the SHARED TaskComposer
  // with the project pre-selected (replacing the retired ProjectTaskProposal
  // flow). The composer's project field handles inherited folders/instructions;
  // here we just hand it the project to land in.
  function newProjectTask(projectId: string) {
    window.dispatchEvent(
      new CustomEvent('fm:openTask', {
        detail: { mode: 'create', defaultFolder: '', projectId },
      }),
    );
  }
  // task-3ff338f80de5 — "open project's bound folder" routes through the existing
  // folder-tab path (cross-platform; the folder open is OS-agnostic). The bound
  // folder shown in the project header becomes a click target → a folder tab.
  function openProjectFolder(folder: string) {
    if (!folder) return;
    dispatch({
      type: 'newTab',
      tab: {
        id: crypto.randomUUID(),
        kind: 'folder',
        taskId: null,
        trail: [folder],
        selected: { 0: 0 },
        marks: {},
        sortKey: 'name',
        sortReverse: false,
        showHidden: false,
        viewMode: 'list',
        foldersFirst: true,
        filter: '',
        tagViz: [],
        tagFilter: { mode: 'off', ids: [] },
        history: [],
        forward: [],
      },
    });
  }
  // Drill into a (sub-)project from a folder block: reuse the detail-open path.
  function openProjectDetail(projectId: string) {
    if (!nodeById.has(projectId)) return;
    setDetailId(projectId);
    setExpanded(new Set());
    setLevel(2);
    setCursorKey(projectId);
    setNeedsYouFilter(null);
  }
  // task-2c5448be520a — archive/unarchive a project, then re-fetch so the row
  // appears/disappears per the current Show-archived toggle. NON-PHI.
  async function setProjectArchived(projectId: string, archived: boolean) {
    const proj = nodeById.get(projectId)?.project;
    try {
      if (archived) await fm.typebuild.projects.archive(projectId);
      else await fm.typebuild.projects.unarchive(projectId);
      setReloadTick((t) => t + 1);
      dispatch({
        type: 'setStatus',
        msg: `${archived ? 'archived' : 'unarchived'}${
          proj ? ` · ${proj.name}` : ''
        }`,
      });
    } catch (e) {
      dispatch({
        type: 'setStatus',
        msg: `couldn't ${archived ? 'archive' : 'unarchive'}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    }
  }
  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ── deep-link (fm:projects:focus) ───────────────────────────────────────────
  useEffect(() => {
    function onFocus(e: Event) {
      const id = (e as CustomEvent<{ projectId?: string }>).detail?.projectId;
      if (!id || !nodeById.has(id)) return;
      setDetailId(id);
      setExpanded(new Set());
      setLevel(2);
      setCursorKey(id);
      setNeedsYouFilter(null);
    }
    // apply a stashed deep-link on mount (the open event may have fired before
    // this page mounted)
    const w = window as unknown as { __fmProjectsDeepLink?: string };
    if (w.__fmProjectsDeepLink && nodeById.has(w.__fmProjectsDeepLink)) {
      const id = w.__fmProjectsDeepLink;
      w.__fmProjectsDeepLink = undefined;
      setDetailId(id);
      setLevel(2);
    }
    function onNew() {
      // :new-project verb — open the inline create form, parented to the
      // project in view: a sub-project when drilled in (level 2), else a
      // top-level project at the grid. task-75493d416ab5 / task-54e9281f0986.
      if (level === 2 && detailId) {
        setShowCreate(true);
      } else {
        setLevel(1);
        setShowCreate(true);
      }
    }
    function onNewTaskEvt() {
      // :new-task verb — create a task scoped to the project in view (the open
      // project when drilled in, else unscoped). task-75493d416ab5.
      const target = level === 2 && detailId ? detailId : scopeId ?? '';
      newProjectTask(target === INBOX_ID ? '' : target);
    }
    window.addEventListener('fm:projects:focus', onFocus);
    window.addEventListener('fm:projects:new', onNew);
    window.addEventListener('fm:projects:newtask', onNewTaskEvt);
    return () => {
      window.removeEventListener('fm:projects:focus', onFocus);
      window.removeEventListener('fm:projects:new', onNew);
      window.removeEventListener('fm:projects:newtask', onNewTaskEvt);
    };
  }, [nodeById, level, detailId, scopeId]);

  // ── keyboard ────────────────────────────────────────────────────────────────
  // ── `:` verbs act on the task selection (task-1bf3a297c9f9, Phase 4) ─────────
  // The Home/projects tab now answers the same fm:tasks:* bulk events the flat
  // Tasks page does (the verbs gained 'projects' in their tabKinds). Target =
  // selection ∪ cursor-task; routed through the shared bulkApply engine.
  const selectionTargets = (): Task[] => {
    const ids = new Set(selectedTasks);
    if (ids.size === 0 && cursorKey) {
      const cur = flatRows.find((r) => r.key === cursorKey);
      if (cur?.kind === 'task') ids.add(cur.task.id);
    }
    return allTasks.filter((t) => ids.has(t.id));
  };
  useEffect(() => {
    if (!isActive) return;
    const run = (verb: Parameters<typeof bulkApply>[0]) => () => {
      void bulkApply(verb, selectionTargets()).then(() => setSelectedTasks(new Set()));
    };
    const handlers: Array<[string, EventListener]> = [
      ['fm:tasks:done', run('done')],
      ['fm:tasks:reopen', run('reopen')],
      ['fm:tasks:cancel', run('cancel')],
      ['fm:tasks:in-progress', run('in-progress')],
      ['fm:tasks:pin', run('pin')],
      ['fm:tasks:unpin', run('unpin')],
      ['fm:tasks:delete', run('delete')],
    ];
    for (const [name, fn] of handlers) window.addEventListener(name, fn);
    return () => {
      for (const [name, fn] of handlers) window.removeEventListener(name, fn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, selectedTasks, cursorKey, flatRows, allTasks, bulkApply]);

  // Activate the cursor row: header → drill into project; sub-project → drill;
  // task parent → expand/collapse; task leaf → open detail drawer.
  function activateFlat(row: FlatRow | undefined) {
    if (!row) return;
    if (row.kind === 'header') {
      const node = nodeById.get(row.projectId);
      if (node) enterCard(node);
    } else if (row.kind === 'subproject') {
      openProjectDetail(row.projectId);
    } else {
      if (row.isParent) toggleExpand(row.task.id);
      else openTaskDetail(row.task);
    }
  }

  useEffect(() => {
    if (!isActive) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      if (inField) return;
      // While the quick-switcher overlay is open it owns the keyboard.
      if (showSwitcher) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const idx = flatIndexOf(cursorKey);
      const setIdx = (i: number) => {
        const clamped = Math.max(0, Math.min(flatRows.length - 1, i));
        const row = flatRows[clamped];
        if (row) setCursorKey(row.key);
      };

      // '/' — open the unified quick-switcher (the surface's search/filter over
      // projects AND tasks). The overlay owns its keys once open.
      if (e.key === '/') {
        e.preventDefault();
        gPendingRef.current = false;
        setSwitcherSeed('');
        setShowSwitcher(true);
        return;
      }
      if (e.key === ':') {
        // ':' opens the command palette to act on the current task selection.
        e.preventDefault();
        gPendingRef.current = false;
        dispatch({ type: 'setMode', mode: 'command', buffer: '' });
        return;
      }
      if (e.key === 'Escape' || e.key === 'h' || e.key === 'ArrowLeft') {
        gPendingRef.current = false;
        if (showCreate) {
          setShowCreate(false);
          e.preventDefault();
          return;
        }
        if (level === 2 || scopeId != null) {
          e.preventDefault();
          backUp();
        }
        return;
      }
      // task-49b7b37c8a02 — 'n'/'a' no longer create a task directly. Single
      // letters belong to type-to-command now: "new task" is reachable by just
      // typing it (the switcher ranks the verb), via the '＋ New task' button, or
      // via ':'/Cmd-K. Hard-binding 'n'/'a' shadowed the verbs and broke typing
      // any word that starts with them.
      // gg → top, G → bottom (flat motion across the whole visible order).
      if (e.key === 'g') {
        e.preventDefault();
        if (gPendingRef.current) {
          gPendingRef.current = false;
          setIdx(0);
        } else {
          gPendingRef.current = true;
        }
        return;
      }
      if (e.key === 'G') {
        e.preventDefault();
        gPendingRef.current = false;
        setIdx(flatRows.length - 1);
        return;
      }
      gPendingRef.current = false;
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setIdx((idx < 0 ? -1 : idx) + 1);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setIdx((idx < 0 ? 1 : idx) - 1);
      } else if (e.key === 'l' || e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        activateFlat(idx >= 0 ? flatRows[idx] : undefined);
      } else if (e.key === ' ') {
        // Space toggles selection on a task row (for bulk ops via : verbs).
        const cur = idx >= 0 ? flatRows[idx] : undefined;
        if (cur?.kind === 'task') {
          e.preventDefault();
          setSelectedTasks((prev) => {
            const next = new Set(prev);
            if (next.has(cur.task.id)) next.delete(cur.task.id);
            else next.add(cur.task.id);
            return next;
          });
        }
      } else if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) {
        // task-49b7b37c8a02 — type-to-command: any other printable alphanumeric
        // key opens the unified switcher seeded with that character (verbs +
        // project/task search), mirroring the file manager. Reserved vim motions
        // (j/k/l/h/g/G) are handled above and never reach here; everything else —
        // 'd', 'n', 'documents'… — starts a search.
        e.preventDefault();
        setSwitcherSeed(e.key);
        setShowSwitcher(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, level, scopeId, flatRows, cursorKey, showCreate, detailId, showSwitcher]);

  // Keep the cursor row in view across the multi-section render. Each cursor
  // target carries data-folder-key (header / sub-project) or data-task-id (task).
  useEffect(() => {
    if (!cursorKey) return;
    const el =
      document.querySelector(`.projects__page [data-task-id="${cursorKey}"]`) ??
      document.querySelector(`.projects__page [data-folder-key="${cursorKey}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursorKey]);

  // ── L1 hero ──────────────────────────────────────────────────────────────────
  // task-6255239581b2 — hero counts come from the attention partition (stable
  // regardless of the show-all toggle; idle projects contribute nothing).
  const heroNeed = useMemo(
    () =>
      partitioned.attentionNodes.reduce(
        (a, n) => a + (attention.get(n.project.id)?.total ?? 0),
        0,
      ),
    [partitioned, attention],
  );
  const heroBlocked = useMemo(
    () =>
      partitioned.attentionNodes.reduce(
        (a, n) => a + (attention.get(n.project.id)?.blocked ?? 0),
        0,
      ),
    [partitioned, attention],
  );
  // the project most needing attention = first in the ranked attention list.
  const heroTarget = useMemo(
    () => partitioned.attentionNodes[0] ?? null,
    [partitioned],
  );

  const scopeProject = scopeId != null ? nodeById.get(scopeId)?.project ?? null : null;

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className="projects">
      <div className="projects__page">
        {/* task-2b54dc05c949 — the redundant root "Home" crumb is gone; the
            titlebar Home button (task-6d0fd232d6c2) owns "go Home". The crumb
            only renders once you've drilled into a project. A clickable Home
            anchor heads the trail so you can climb back to root. */}
        {((scopeProject && level === 1) || (level === 2 && detailProject)) && (
          <div className="projects__crumb">
            <button
              type="button"
              className="projects__crumb-clk"
              onClick={() => {
                setLevel(1);
                setScopeId(null);
              }}
            >
              Home
            </button>
            {scopeProject && level === 1 && (
              <>
                <span className="projects__crumb-sep">›</span>
                <span className="projects__crumb-here">{scopeProject.name}</span>
              </>
            )}
            {level === 2 && detailProject && (
              <>
                <span className="projects__crumb-sep">›</span>
                <span className="projects__crumb-here">
                  {breadcrumbPath(roots, detailProject.id)}
                </span>
              </>
            )}
          </div>
        )}

        {level === 1 && homeView === 'flat' ? (
          <FlatView
            sections={flatSections}
            renderTaskRow={renderTaskRow}
            totalOpen={flatPartition.forYou.length + flatPartition.forAgents.length}
            doneTotal={flatPartition.doneTotal}
            doneOpen={flatDoneOpen}
            onToggleDone={() => setFlatDoneOpen((v) => !v)}
            homeView={homeView}
            onSetHomeView={setHomeView}
            onNewTask={() => newProjectTask('')}
          />
        ) : level === 1 ? (
          <HomeRoot
            gridRef={gridRef}
            attentionNodes={partitioned.attentionNodes}
            recentNodes={partitioned.recentNodes}
            idleNodes={partitioned.idleNodes}
            rollUp={rollUp}
            attention={attention}
            tasksProvider={tasksProvider}
            cursorKey={cursorKey}
            homeView={homeView}
            onSetHomeView={setHomeView}
            onOpenProject={openProjectDetail}
            onOpenFolder={openProjectFolder}
            onNewTask={(pid) => newProjectTask(pid)}
            inboxNode={inboxNode}
            inboxAttention={inboxAttention}
            inboxRollUp={inboxRollUp}
            inboxOpenCount={inboxOpenCount}
            inboxTotalCount={inboxTotalCount}
            showAll={showAll}
            onToggleShowAll={() => setShowAll((v) => !v)}
            showArchived={showArchived}
            onToggleShowArchived={() => setShowArchived((v) => !v)}
            onArchive={(id, next) => void setProjectArchived(id, next)}
            scopeProject={scopeProject}
            totalProjects={projects.length}
            heroNeed={heroNeed}
            heroBlocked={heroBlocked}
            heroTarget={heroTarget}
            loaded={loaded}
            loadErr={loadErr}
            signedIn={tbSignedIn}
            onRetry={() => setReloadTick((t) => t + 1)}
            showCreate={showCreate}
            onShowCreate={() => setShowCreate(true)}
            onCancelCreate={() => setShowCreate(false)}
            onCreated={(p) => {
              setShowCreate(false);
              setProjects((prev) => [...prev, p]);
              setReloadTick((t) => t + 1);
              dispatch({ type: 'setStatus', msg: `project created · ${p.name}` });
            }}
            onSetCursor={(pid) => setCursorKey(pid)}
            onEnter={enterCard}
            onHeroOpen={(n) => enterCard(n)}
            onHeroNeedsYou={(n) => openProjectNeedsYou(n.project.id)}
            onProjectNeedsYou={openProjectNeedsYou}
            allProjects={projects}
            scopeId={scopeId}
          />
        ) : detailProject && detailNode ? (
          <ProjectDetail
            node={detailNode}
            project={detailProject}
            effectiveDesc={effectiveDesc}
            instructionTotal={effectiveInstructions?.total ?? 0}
            instructionSummary={effectiveInstructions?.summary ?? ''}
            attention={attention}
            rollUp={rollUp}
            tasksProvider={tasksProvider}
            cursorKey={cursorKey}
            needsYouActive={needsYouFilter === detailProject.id}
            onToggleNeedsYou={(pid) =>
              setNeedsYouFilter((cur) => (cur === pid ? null : pid))
            }
            onBack={() => setLevel(1)}
            onOpenProject={openProjectDetail}
            onOpenFolder={openProjectFolder}
            onNewTask={(pid) => newProjectTask(pid)}
            onArchive={(next) => detailId && void setProjectArchived(detailId, next)}
            showCreate={showCreate}
            onShowCreate={() => setShowCreate(true)}
            onCancelCreate={() => setShowCreate(false)}
            onCreated={(p) => {
              setShowCreate(false);
              setProjects((prev) => [...prev, p]);
              setReloadTick((t) => t + 1);
              dispatch({ type: 'setStatus', msg: `project created · ${p.name}` });
            }}
            onUpdated={(p) => {
              // task-0ab7bbc30a11 — splice the patched project back into state so
              // the header/dek refresh immediately, then re-fetch to stay in
              // sync with the server.
              setProjects((prev) => prev.map((x) => (x.id === p.id ? p : x)));
              setReloadTick((t) => t + 1);
              dispatch({ type: 'setStatus', msg: `project updated · ${p.name}` });
            }}
            allProjects={projects}
          />
        ) : (
          <>
            <button type="button" className="projects__back" onClick={() => setLevel(1)}>
              ‹ h — back to all projects
            </button>
            <div className="ptree__empty">Project not found.</div>
          </>
        )}
      </div>
      {taskRowOverlays}
      {showSwitcher && (
        <QuickSwitcher
          roots={roots}
          nodeById={nodeById}
          attention={attention}
          tasks={allTasks}
          verbs={paletteVerbs}
          initialQuery={switcherSeed}
          onPickVerb={(id) => {
            setShowSwitcher(false);
            runVerb(id);
          }}
          onClose={() => setShowSwitcher(false)}
          onPickProject={(id) => {
            setShowSwitcher(false);
            const node = nodeById.get(id);
            if (node) enterCard(node);
          }}
          onPickTask={(t) => {
            setShowSwitcher(false);
            openTaskDetail(t);
          }}
        />
      )}
    </div>
  );
}

// ── flat / by-project toggle (task-9d54b7ab7972, Phase 5, Q3) ────────────────
function HomeViewToggle({
  view,
  onSet,
}: {
  view: 'projects' | 'flat';
  onSet: (v: 'projects' | 'flat') => void;
}) {
  return (
    <div className="home-viewtoggle" role="group" aria-label="Home view">
      <button
        type="button"
        className={['home-viewtoggle__btn', view === 'projects' ? 'is-on' : '']
          .filter(Boolean)
          .join(' ')}
        aria-pressed={view === 'projects'}
        onClick={() => onSet('projects')}
        title="Projects first — projects as folders; open one to see its tasks"
      >
        Projects first
      </button>
      <button
        type="button"
        className={['home-viewtoggle__btn', view === 'flat' ? 'is-on' : '']
          .filter(Boolean)
          .join(' ')}
        aria-pressed={view === 'flat'}
        onClick={() => onSet('flat')}
        title="Tasks first — a flat list of every task"
      >
        Tasks first
      </button>
    </div>
  );
}

// ── flat view: the all-tasks inbox folded into Home (task-9d54b7ab7972) ───────
// FOR YOU / FOR AGENTS / DONE sections, each a folder-list of real TaskRows via
// the shared renderTaskRow — one Home, "All tasks" is a flat view of it. The
// standalone :tasks tab is kept as a secondary surface (Q3).
function FlatView({
  sections,
  renderTaskRow,
  totalOpen,
  doneTotal,
  doneOpen,
  onToggleDone,
  homeView,
  onSetHomeView,
  onNewTask,
}: {
  sections: Array<{ id: string; title: string; rows: ProjectFolderRow[] }>;
  renderTaskRow: (row: ProjectFolderRow) => React.ReactNode;
  totalOpen: number;
  doneTotal: number;
  doneOpen: boolean;
  onToggleDone: () => void;
  homeView: 'projects' | 'flat';
  onSetHomeView: (v: 'projects' | 'flat') => void;
  onNewTask: () => void;
}) {
  return (
    <>
      <div className="projects__head">
        <div className="projects__head-text">
          {/* task-2b54dc05c949 — redundant "Home" heading removed; the caption
              subtitle carries the useful context on its own. */}
          <div className="projects__sub">
            {totalOpen} open task{totalOpen === 1 ? '' : 's'} · flat view ·{' '}
            <kbd className="projects__kbd">/</kbd> search projects &amp; tasks
          </div>
        </div>
        <div className="projects__head-actions">
          <HomeViewToggle view={homeView} onSet={onSetHomeView} />
          <button type="button" className="projects__btn" onClick={onNewTask} title="New task">
            ＋ New task
          </button>
        </div>
      </div>

      {sections.map((sec) => {
        const isDoneSec = sec.id === 'done';
        return (
          <section key={sec.id} className="pfolder home-flat__section">
            <header className="pfolder-header pfolder-header--inline">
              {isDoneSec ? (
                <button
                  type="button"
                  className="home-flat__sectionhead"
                  onClick={onToggleDone}
                  aria-expanded={doneOpen}
                >
                  <span aria-hidden="true">{doneOpen ? '▾' : '▸'}</span>{' '}
                  <span className="folder-header__title pfolder-header__title">{sec.title}</span>
                </button>
              ) : (
                <h1 className="folder-header__title pfolder-header__title">
                  {sec.title}
                  <span className="home-flat__count"> · {sec.rows.length}</span>
                </h1>
              )}
            </header>
            {sec.rows.length > 0 ? (
              <ul className="folder-list__list pfolder__list" role="list">
                {sec.rows.map((row) => renderTaskRow(row))}
              </ul>
            ) : !isDoneSec ? (
              <div className="pfolder__empty">
                {sec.id === 'for-you' ? 'Nothing on your plate.' : 'No agent work queued.'}
              </div>
            ) : null}
          </section>
        );
      })}
      {doneTotal === 0 && totalOpen === 0 && (
        <div className="projects__empty">
          <div className="projects__empty-glyph">✓</div>
          <div className="projects__empty-title">No tasks yet</div>
          <div className="projects__empty-body">
            Type <kbd>:task</kbd> to add one — or use <b>＋ New task</b>.
          </div>
        </div>
      )}
    </>
  );
}

// ── Home root: projects-as-folders inbox (task-9d54b7ab7972 + task-4b0168979921)
// Replaces the old .prow card/grid with a vertical LIST of ProjectFolderBlocks
// (PROJECT = FOLDER). It PRESERVES task-4b0168979921's attention partition +
// hero + "nothing needs you below" fold + show-all VERBATIM — only the row
// presentation changes (one folder block per project, scale='inline', subs
// collapsed per Q5). Q4: a synthetic "Inbox (no project)" block leads.
function HomeRoot({
  gridRef,
  attentionNodes,
  recentNodes,
  idleNodes,
  rollUp,
  attention,
  tasksProvider,
  cursorKey,
  homeView,
  onSetHomeView,
  onOpenProject,
  onOpenFolder,
  onNewTask,
  inboxNode,
  inboxAttention,
  inboxRollUp,
  inboxOpenCount,
  inboxTotalCount,
  showAll,
  onToggleShowAll,
  showArchived,
  onToggleShowArchived,
  onArchive,
  scopeProject,
  totalProjects,
  heroNeed,
  heroBlocked,
  heroTarget,
  loaded,
  loadErr,
  signedIn,
  onRetry,
  showCreate,
  onShowCreate,
  onCancelCreate,
  onCreated,
  onSetCursor,
  onEnter,
  onHeroOpen,
  onHeroNeedsYou,
  onProjectNeedsYou,
  allProjects,
  scopeId,
}: {
  gridRef: React.RefObject<HTMLDivElement | null>;
  attentionNodes: ProjectNode[];
  recentNodes: ProjectNode[];
  idleNodes: ProjectNode[];
  rollUp: Map<string, { own: TaskStats; rolled: TaskStats }>;
  attention: Map<string, ProjectAttention>;
  tasksProvider: ProjectTasksProvider;
  cursorKey: string | null;
  homeView: 'projects' | 'flat';
  onSetHomeView: (v: 'projects' | 'flat') => void;
  onOpenProject: (projectId: string) => void;
  onOpenFolder: (folder: string) => void;
  onNewTask: (projectId: string) => void;
  inboxNode: ProjectNode;
  inboxAttention: Map<string, ProjectAttention>;
  inboxRollUp: Map<string, { own: TaskStats; rolled: TaskStats }>;
  inboxOpenCount: number;
  inboxTotalCount: number;
  showAll: boolean;
  onToggleShowAll: () => void;
  showArchived: boolean;
  onToggleShowArchived: () => void;
  /** Archive (true) or unarchive (false) a project by id. */
  onArchive: (id: string, archived: boolean) => void;
  scopeProject: Project | null;
  totalProjects: number;
  heroNeed: number;
  heroBlocked: number;
  heroTarget: ProjectNode | null;
  loaded: boolean;
  loadErr: string | null;
  signedIn: boolean;
  onRetry: () => void;
  showCreate: boolean;
  onShowCreate: () => void;
  onCancelCreate: () => void;
  onCreated: (p: Project) => void;
  /** Move the keyboard cursor onto a project header (mouse → cursor sync). */
  onSetCursor: (projectId: string) => void;
  onEnter: (n: ProjectNode) => void;
  onHeroOpen: (n: ProjectNode) => void;
  /** Drill into a project AND filter its list to its "needs you" tasks. */
  onHeroNeedsYou: (n: ProjectNode) => void;
  onProjectNeedsYou: (projectId: string) => void;
  allProjects: Project[];
  scopeId: string | null;
}) {
  const totalScoped = attentionNodes.length + recentNodes.length + idleNodes.length;
  const empty = loaded && !loadErr && totalScoped === 0;
  const hiddenCount = idleNodes.length;

  // task-6050fee0efb1 — one project = ONE compact file/folder-style row. No
  // inline task list (the file manager doesn't show a folder's contents inline);
  // opening a row drills into the project to reveal its tasks + sub-projects.
  // The cursor (keyboard or mouse) keys off the project id; the row carries
  // data-folder-key for scroll-into-view.
  const renderBlock = (node: ProjectNode, quiet: boolean) => {
    const p = node.project;
    const archived = p.archived === true;
    const att = attention.get(p.id);
    const rolled = rollUp.get(p.id)?.rolled;
    const status = projStatusOf(att, rolled);
    return (
      <div
        key={p.id}
        className={['home-row-wrap', quiet ? 'home-row-wrap--quiet' : '']
          .filter(Boolean)
          .join(' ')}
      >
        <ProjectRow
          node={node}
          statusGlyph={STATUS_GLYPH[status]}
          statusKind={status}
          statusLabel={STATUS_LABEL[status]}
          total={rolled?.total ?? 0}
          need={att?.total ?? 0}
          subCount={node.children.length}
          archived={archived}
          cursor={cursorKey === p.id}
          onOpen={() => onEnter(node)}
          onHover={onSetCursor}
          onArchive={onArchive}
          onNeedsYou={() => onProjectNeedsYou(p.id)}
        />
      </div>
    );
  };

  return (
    <>
      <div className="projects__head">
        <div className="projects__head-text">
          {/* task-2b54dc05c949 — at root the redundant "Home" heading is gone;
              the subtitle stands alone. Once scoped into a project we keep the
              project name as the heading (that's drill-in context, not "Home"). */}
          {scopeProject && (
            <h1 className="projects__title">{scopeProject.name}</h1>
          )}
          <div className="projects__sub">
            {scopeProject
              ? `${totalScoped} sub-project${totalScoped === 1 ? '' : 's'} · scoped · ranked by what needs you · `
              : `${totalProjects} project${totalProjects === 1 ? '' : 's'} · your tasks, ranked by what needs you · `}
            <kbd className="projects__kbd">/</kbd> search projects &amp; tasks
          </div>
        </div>
        <div className="projects__head-actions">
          <HomeViewToggle view={homeView} onSet={onSetHomeView} />
          <button
            type="button"
            className="projects__btn"
            onClick={() => onNewTask('')}
            title="New task"
          >
            ＋ New task
          </button>
          <button type="button" className="projects__btn projects__btn--primary" onClick={onShowCreate}>
            ＋ New {scopeProject ? 'sub-project' : 'project'}
          </button>
        </div>
      </div>

      {showCreate && (
        <CreateForm
          parentId={scopeId}
          parentName={scopeProject?.name ?? null}
          allProjects={allProjects}
          onCancel={onCancelCreate}
          onCreated={onCreated}
        />
      )}

      {/* task-81b7ce77a30a — loading placeholder while the first fetch is in
          flight (the page used to render blank). */}
      {!loaded && !loadErr && (
        <div className="projects__hero" role="status">
          Loading your projects…
        </div>
      )}

      {/* task-81b7ce77a30a — humanized, recoverable error. The raw exception
          isn't shown to the user (it can leak internals); Retry re-fetches. */}
      {loaded && loadErr && (
        <div className="projects__hero" role="alert">
          {signedIn ? (
            <>
              Couldn’t load your projects. Check your connection and try again.{' '}
              <button
                type="button"
                className="projects__hero-open"
                onClick={onRetry}
              >
                Retry →
              </button>
            </>
          ) : (
            <>
              Sign in to TypeBuild to see your projects and tasks.{' '}
              <button
                type="button"
                className="projects__hero-open"
                onClick={openTypebuildSignIn}
              >
                Sign in →
              </button>
            </>
          )}
        </div>
      )}

      {!empty && !loadErr && totalScoped > 0 && (
        heroNeed === 0 && heroBlocked === 0 ? (
          <div className="projects__hero projects__hero--clear" role="status">
            Nothing needs you{scopeProject ? ' in these sub-projects' : ''} — agents are running.
          </div>
        ) : (
          <div className="projects__hero" role="status">
            {/* task-18902d433658 — the count is a clickable affordance: it drills
                into the most-needy project AND filters its task list to exactly
                those "needs you" tasks (same predicate as the count). */}
            {heroTarget ? (
              <button
                type="button"
                className="projects__hero-need"
                onClick={() => onHeroNeedsYou(heroTarget)}
                title={`Show the ${heroNeed} task${heroNeed === 1 ? '' : 's'} needing you in ${heroTarget.project.name}`}
              >
                <b>
                  {heroNeed} {heroNeed === 1 ? 'task needs' : 'tasks need'} you
                  {heroBlocked > 0 ? `, ${heroBlocked} blocked` : ''}.
                </b>
              </button>
            ) : (
              <b>
                {heroNeed} {heroNeed === 1 ? 'task needs' : 'tasks need'} you
                {heroBlocked > 0 ? `, ${heroBlocked} blocked` : ''}.
              </b>
            )}{' '}
            {heroTarget ? (
              <button
                type="button"
                className="projects__hero-open"
                onClick={() => onHeroOpen(heroTarget)}
              >
                Open {heroTarget.project.name} first →
              </button>
            ) : (
              'Pick the one with the amber pill.'
            )}
          </div>
        )
      )}

      {/* Q4 — the synthetic Inbox (no project) block, ALWAYS first at root. Only
          shown when there are project-less tasks. Not part of the attention
          partition (it isn't a real project); it leads as the catch-all. */}
      {!scopeProject && inboxTotalCount > 0 && (
        <div className="home-block home-block--inbox">
          <ProjectFolderBlock
            node={inboxNode}
            attention={inboxAttention}
            rollUp={inboxRollUp}
            effectiveDesc={inboxNode.project.description ?? ''}
            tasks={tasksProvider}
            scale="inline"
            onOpenProject={onOpenProject}
            onOpenFolder={onOpenFolder}
            onNewTask={onNewTask}
            cursorKey={cursorKey}
          />
          {inboxOpenCount === 0 && (
            <div className="home-block__note">
              All inbox tasks are filed or done.
            </div>
          )}
        </div>
      )}

      {/* task-81b7ce77a30a — a signed-out user hitting an empty list used to
          see "No projects yet" + a "+ New project" CTA that can't succeed.
          Point them to sign-in instead. */}
      {empty && !showCreate && inboxTotalCount === 0 && !signedIn && (
        <div className="projects__empty">
          <div className="projects__empty-glyph">◳</div>
          <div className="projects__empty-title">
            Sign in to see your projects
          </div>
          <div className="projects__empty-body">
            Sign in to TypeBuild to see your projects and tasks across your
            machines.
          </div>
          <button
            type="button"
            className="projects__btn projects__btn--primary"
            onClick={openTypebuildSignIn}
          >
            Sign in to TypeBuild
          </button>
        </div>
      )}

      {empty && !showCreate && inboxTotalCount === 0 && signedIn && (
        <div className="projects__empty">
          <div className="projects__empty-glyph">◳</div>
          <div className="projects__empty-title">
            {scopeProject ? 'No sub-projects yet' : 'No projects yet'}
          </div>
          <div className="projects__empty-body">
            Projects group tasks and give agents shared context — a description and
            instructions that cascade to every task inside.
          </div>
          <button type="button" className="projects__btn projects__btn--primary" onClick={onShowCreate}>
            ＋ New {scopeProject ? 'sub-project' : 'project'}
          </button>
        </div>
      )}

      {/* The inbox of project folders. Needs-attention leads; everything below
          the fold needs nothing right now. A vertical list of folder blocks. */}
      {(attentionNodes.length > 0 || recentNodes.length > 0) && (
        <div className="home-list" ref={gridRef} role="list">
          {attentionNodes.map((node) => renderBlock(node, false))}
          {attentionNodes.length > 0 && recentNodes.length > 0 && (
            <div className="projects__fold" aria-hidden="true">
              <span>nothing needs you below</span>
            </div>
          )}
          {recentNodes.map((node) => renderBlock(node, false))}
          {showAll &&
            idleNodes.length > 0 &&
            idleNodes.map((node) => renderBlock(node, true))}
        </div>
      )}

      {/* Idle/quiet + archived toggles — both hidden by default, revealed on
          their toggle. (task-2c5448be520a adds Show archived.) */}
      {!empty && (hiddenCount > 0 || showArchived) && (
        <div className="projects__showall">
          {hiddenCount > 0 && (
            <button
              type="button"
              className="projects__btn projects__showall-btn"
              aria-pressed={showAll}
              onClick={onToggleShowAll}
            >
              {showAll
                ? `Hide idle projects (${hiddenCount})`
                : `Show all projects (${hiddenCount} hidden)`}
            </button>
          )}
          <button
            type="button"
            className="projects__btn projects__showall-btn"
            aria-pressed={showArchived}
            onClick={onToggleShowArchived}
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
        </div>
      )}
      {empty && !showCreate && (
        <div className="projects__showall">
          <button
            type="button"
            className="projects__btn projects__showall-btn"
            aria-pressed={showArchived}
            onClick={onToggleShowArchived}
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
        </div>
      )}
    </>
  );
}

// ── L2: a single project rendered as a FOLDER (task-1bf3a297c9f9) ──────────────
// The drilled-in view: the project as a folder-hero header + its tasks as file
// rows (real TaskRows) + nested sub-projects as nested folder blocks. Replaces
// the bespoke ptree/projects__l2head markup with ProjectFolderBlock so the
// surface reads exactly like a folder at the file-manager density.
function ProjectDetail({
  node,
  project,
  effectiveDesc,
  instructionTotal,
  instructionSummary,
  attention,
  rollUp,
  tasksProvider,
  cursorKey,
  onBack,
  onOpenProject,
  onOpenFolder,
  onNewTask,
  onArchive,
  showCreate,
  onShowCreate,
  onCancelCreate,
  onCreated,
  onUpdated,
  allProjects,
  needsYouActive,
  onToggleNeedsYou,
}: {
  node: ProjectNode;
  project: Project;
  effectiveDesc: string;
  instructionTotal: number;
  instructionSummary: string;
  attention: Map<string, ProjectAttention>;
  rollUp: Map<string, { own: TaskStats; rolled: TaskStats }>;
  tasksProvider: ProjectTasksProvider;
  cursorKey: string | null;
  needsYouActive: boolean;
  onToggleNeedsYou: (projectId: string) => void;
  onBack: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenFolder: (folder: string) => void;
  onNewTask: (projectId: string) => void;
  /** Archive (true) or unarchive (false) THIS project. */
  onArchive: (archived: boolean) => void;
  // task-54e9281f0986 — Add task / Add project live in THIS header, scoped to
  // the opened project (not on each card).
  showCreate: boolean;
  onShowCreate: () => void;
  onCancelCreate: () => void;
  onCreated: (p: Project) => void;
  /** task-0ab7bbc30a11 — a name/description patch landed; splice it back. */
  onUpdated: (p: Project) => void;
  allProjects: Project[];
}) {
  // task-0ab7bbc30a11 — inline edit for THIS project's name + description, shown
  // in place of the folder header. Opened by the L2 "✎ Edit" button OR by the
  // header's "＋ Add description" affordance (which previously only drilled in).
  const [showEdit, setShowEdit] = useState(false);
  return (
    <>
      <div className="projects__l2bar">
        <button type="button" className="projects__back" onClick={onBack}>
          ‹ h — back to all projects
        </button>
        {/* task-54e9281f0986 — Add task + Add project (sub-project), scoped to
            the opened project. These replace the per-card add-task button. */}
        <button
          type="button"
          className="projects__newtask"
          onClick={() => onNewTask(project.id)}
          title="New task in this project"
        >
          ＋ New task
        </button>
        <button
          type="button"
          className="projects__newtask projects__btn--primary"
          onClick={onShowCreate}
          title="New sub-project"
        >
          ＋ New sub-project
        </button>
        {/* task-0ab7bbc30a11 — edit THIS project's name + description. */}
        <button
          type="button"
          className="projects__newtask"
          onClick={() => setShowEdit((v) => !v)}
          title="Edit name and description"
          aria-pressed={showEdit}
        >
          ✎ Edit
        </button>
        {/* task-2c5448be520a — archive/unarchive this project. */}
        <button
          type="button"
          className="projects__newtask projects__archive"
          onClick={() => onArchive(project.archived !== true)}
          title={project.archived === true ? 'Unarchive project' : 'Archive project'}
        >
          {project.archived === true ? '↺ Unarchive' : '⊟ Archive'}
        </button>
      </div>

      {showCreate && (
        <CreateForm
          parentId={project.id}
          parentName={project.name}
          allProjects={allProjects}
          onCancel={onCancelCreate}
          onCreated={onCreated}
        />
      )}

      {showEdit && (
        <EditProjectForm
          project={project}
          onCancel={() => setShowEdit(false)}
          onUpdated={(p) => {
            setShowEdit(false);
            onUpdated(p);
          }}
        />
      )}

      <ProjectFolderBlock
        node={node}
        attention={attention}
        rollUp={rollUp}
        effectiveDesc={effectiveDesc}
        instructionTotal={instructionTotal}
        instructionSummary={instructionSummary}
        tasks={tasksProvider}
        scale="hero"
        onOpenProject={onOpenProject}
        onOpenFolder={onOpenFolder}
        onNewTask={onNewTask}
        onEditDescription={() => setShowEdit(true)}
        cursorKey={cursorKey}
        needsYouActive={needsYouActive}
        onToggleNeedsYou={onToggleNeedsYou}
      />
    </>
  );
}

// ── inline create form (verb / ＋ button) ───────────────────────────────────────
function CreateForm({
  parentId,
  parentName,
  allProjects,
  onCancel,
  onCreated,
}: {
  parentId: string | null;
  parentName: string | null;
  allProjects: Project[];
  onCancel: () => void;
  onCreated: (p: Project) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [folder, setFolder] = useState('');
  const [parent, setParent] = useState<string>(parentId ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setErr('Name is required.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const p = await fm.typebuild.projects.create({
        name: trimmed,
        description: description.trim() || undefined,
        parentProjectId: parent || undefined,
        folders: folder.trim() ? [folder.trim()] : undefined,
      });
      onCreated(p);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="pcreate"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <div className="pcreate__title">
        ＋ New {parentName ? `sub-project of ${parentName}` : 'project'}
      </div>
      <div className="pcreate__field">
        <label htmlFor="pcreate-name">Name</label>
        <input
          id="pcreate-name"
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Insurance Authorization"
          spellCheck={false}
        />
      </div>
      <div className="pcreate__field">
        <label htmlFor="pcreate-desc">Description</label>
        <textarea
          id="pcreate-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One sentence on what this project is for — given to agents as context."
        />
        <div className="pcreate__hint">{CTX_MARK}</div>
      </div>
      <div className="pcreate__field">
        <label htmlFor="pcreate-parent">Parent project</label>
        <select
          id="pcreate-parent"
          value={parent}
          onChange={(e) => setParent(e.target.value)}
        >
          <option value="">— none (top-level) —</option>
          {allProjects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="pcreate__field">
        <label htmlFor="pcreate-folder">Folder / repo binding (optional)</label>
        <input
          id="pcreate-folder"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          placeholder="/abs/path or ~/git/repo"
          spellCheck={false}
        />
      </div>
      <div className="pcreate__row">
        {err && <span className="pcreate__err">{err}</span>}
        <button type="button" className="projects__btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="projects__btn projects__btn--primary"
          onClick={() => void submit()}
          disabled={busy}
        >
          {busy ? 'Creating…' : 'Create project'}
        </button>
      </div>
    </div>
  );
}

// ── inline edit form for an existing project (task-0ab7bbc30a11) ─────────────────
// Mirrors CreateForm's textarea/idiom so it reads native, but PATCHes an
// existing project's NAME + DESCRIPTION via the already-wired
// fm.typebuild.projects.patch(id, {name, description}). The mutation pipeline
// (IPC → updateProject → PATCH /chromeext/projects/{id}) existed and was only
// ever called for `instructions`; this is the missing UI. Structured failures
// are surfaced, not swallowed: 403 not_owner → "only the owner can edit"; 422
// phi_rejected → a clear PHI message; 404 not_visible → "project not found".
// NON-PHI: name/description are teaching context, never patient data.
function editReason(reason: string): string {
  switch (reason) {
    case 'not_owner':
      return 'Only the project owner can edit its name or description.';
    case 'phi_rejected':
      return 'That looks like it contains PHI — keep the name and description PHI-free.';
    case 'not_visible':
      return 'Project not found.';
    case 'empty':
      return 'Name is required.';
    default:
      return 'Couldn’t save your changes.';
  }
}

function EditProjectForm({
  project,
  onCancel,
  onUpdated,
}: {
  project: Project;
  onCancel: () => void;
  onUpdated: (p: Project) => void;
}) {
  const [name, setName] = useState(project.name ?? '');
  const [description, setDescription] = useState(project.description ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  async function submit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErr('Name is required.');
      return;
    }
    // Only send fields that actually changed (the backend accepts a partial
    // patch and a name-only or description-only edit is common).
    const patch: { name?: string; description?: string } = {};
    if (trimmedName !== (project.name ?? '')) patch.name = trimmedName;
    const trimmedDesc = description.trim();
    if (trimmedDesc !== (project.description ?? '')) patch.description = trimmedDesc;
    if (patch.name === undefined && patch.description === undefined) {
      onCancel();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fm.typebuild.projects.patch(project.id, patch);
      if (res.ok) {
        onUpdated(res.project);
        return;
      }
      setErr(editReason(res.reason));
      setBusy(false);
    } catch {
      setErr('Couldn’t reach TypeBuild to save.');
      setBusy(false);
    }
  }

  return (
    <div
      className="pcreate"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <div className="pcreate__title">✎ Edit project</div>
      <div className="pcreate__field">
        <label htmlFor="pedit-name">Name</label>
        <input
          id="pedit-name"
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Insurance Authorization"
          spellCheck={false}
        />
      </div>
      <div className="pcreate__field">
        <label htmlFor="pedit-desc">Description</label>
        <textarea
          id="pedit-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One sentence on what this project is for — given to agents as context."
        />
        <div className="pcreate__hint">{CTX_MARK}</div>
      </div>
      <div className="pcreate__row">
        {err && <span className="pcreate__err">{err}</span>}
        <button type="button" className="projects__btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="projects__btn projects__btn--primary"
          onClick={() => void submit()}
          disabled={busy}
        >
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

// ── unified quick-switcher (task-4b0168979921) ──────────────────────────────────
// '/' opens a single overlay over PROJECTS and TASKS. Picking a project drills
// into it (re-uses the page's enterCard); picking a task navigates to the Tasks
// page focused on that row via the existing fm:tasks:focus path — it does NOT
// fork the task. Task titles are PHI: rendered in-app for the operator only,
// never written to disk/logs (same contract as the L2 tree).
type SwitchItem =
  | { kind: 'verb'; id: string; label: string; sub: string }
  | { kind: 'project'; id: string; label: string; sub: string; status: ProjStatus }
  | { kind: 'task'; task: Task; label: string; sub: string; status: RowStatus };

function QuickSwitcher({
  roots,
  nodeById,
  attention,
  tasks,
  verbs,
  initialQuery,
  onPickVerb,
  onClose,
  onPickProject,
  onPickTask,
}: {
  roots: ProjectNode[];
  nodeById: Map<string, ProjectNode>;
  attention: Map<string, ProjectAttention>;
  tasks: Task[];
  /** task-49b7b37c8a02 — verbs available on Home (project/task + top-level). */
  verbs: PaletteVerb[];
  /** task-49b7b37c8a02 — the key that opened the switcher when triggered by
   *  typing (empty when opened via '/'), used to seed the search box. */
  initialQuery: string;
  onPickVerb: (id: string) => void;
  onClose: () => void;
  onPickProject: (id: string) => void;
  onPickTask: (t: Task) => void;
}) {
  const [q, setQ] = useState(initialQuery);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Caret to the end so a seed char (type-to-command) keeps appending.
    const n = el.value.length;
    el.setSelectionRange(n, n);
  }, []);

  // Flatten the project forest → searchable items (name + description), with a
  // folder-style path as the sub-line.
  const projectItems: SwitchItem[] = useMemo(() => {
    const out: SwitchItem[] = [];
    const walk = (node: ProjectNode) => {
      const p = node.project;
      const att = attention.get(p.id);
      out.push({
        kind: 'project',
        id: p.id,
        label: p.name,
        sub: breadcrumbPath(roots, p.id),
        status: projStatusOf(att, undefined),
      });
      node.children.forEach(walk);
    };
    roots.forEach(walk);
    return out;
  }, [roots, attention]);

  // Tasks → items (title + its project path). Skip terminal tasks to keep the
  // switcher actionable.
  const taskItems: SwitchItem[] = useMemo(() => {
    const out: SwitchItem[] = [];
    for (const t of tasks) {
      if (t.status === 'done' || t.status === 'cancelled') continue;
      const node = t.projectId ? nodeById.get(t.projectId) : undefined;
      out.push({
        kind: 'task',
        task: t,
        label: t.title,
        sub: node ? breadcrumbPath(roots, node.project.id) : 'no project',
        status: rowStatusOf(t),
      });
    }
    return out;
  }, [tasks, nodeById, roots]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (it: SwitchItem) =>
      needle === '' ||
      it.label.toLowerCase().includes(needle) ||
      it.sub.toLowerCase().includes(needle);
    // task-49b7b37c8a02 — VERBS first when the user is typing. Mirrors
    // ChipPrompt: the verb picker leads, and entity hits blend in for non-empty
    // queries. With an empty query we show only entities (no verb spam — the
    // ':'/Cmd-K palette is the place to browse all verbs).
    const verbItems: SwitchItem[] =
      needle === ''
        ? []
        : rankPaletteVerbs(verbs, q, [])
            .filter((v) => v.available)
            .slice(0, 8)
            .map((v) => ({
              kind: 'verb' as const,
              id: v.id,
              label: v.label,
              sub: v.description || (v.category ?? 'command'),
            }));
    const projects = projectItems.filter(match).slice(0, 30);
    const tasksF = taskItems.filter(match).slice(0, 30);
    return {
      verbItems,
      projects,
      tasksF,
      flat: [...verbItems, ...projects, ...tasksF],
    };
  }, [q, verbs, projectItems, taskItems]);

  useEffect(() => {
    if (cursor >= results.flat.length) setCursor(0);
  }, [results.flat.length, cursor]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-sw-i="${cursor}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  function pick(it: SwitchItem | undefined) {
    if (!it) return;
    if (it.kind === 'verb') onPickVerb(it.id);
    else if (it.kind === 'project') onPickProject(it.id);
    else onPickTask(it.task);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => Math.min(results.flat.length - 1, c + 1));
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(results.flat[cursor]);
    }
  }

  const renderItem = (it: SwitchItem, i: number) => {
    const glyph =
      it.kind === 'verb'
        ? '⌘'
        : it.kind === 'project'
          ? STATUS_GLYPH[it.status]
          : it.status === 'blocked'
            ? '⛔'
            : it.status === 'need'
              ? '⚑'
              : it.status === 'working'
                ? '◷'
                : '◌';
    const key =
      it.kind === 'verb'
        ? `verb:${it.id}`
        : it.kind === 'project'
          ? `project:${it.id}`
          : `task:${it.task.id}`;
    const kindLabel =
      it.kind === 'verb' ? 'command' : it.kind === 'project' ? 'project' : 'task';
    return (
      <button
        type="button"
        key={key}
        data-sw-i={i}
        className={['qsw__item', i === cursor ? 'cursor' : ''].filter(Boolean).join(' ')}
        onMouseMove={() => setCursor(i)}
        onClick={() => pick(it)}
      >
        <span className="qsw__glyph" aria-hidden="true">
          {glyph}
        </span>
        <span className="qsw__body">
          <span className="qsw__label">{it.label}</span>
          <span className="qsw__sub">
            {kindLabel} · {it.sub}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div className="qsw__scrim" onClick={onClose}>
      <div
        className="qsw"
        role="dialog"
        aria-label="Search projects and tasks"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <input
          ref={inputRef}
          className="qsw__input"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setCursor(0);
          }}
          placeholder="Type a command or search projects & tasks…"
          spellCheck={false}
        />
        <div className="qsw__list" ref={listRef}>
          {results.flat.length === 0 ? (
            <div className="qsw__empty">No matches.</div>
          ) : (
            <>
              {results.verbItems.length > 0 && (
                <div className="qsw__group">Commands</div>
              )}
              {results.verbItems.map((it, n) => renderItem(it, n))}
              {results.projects.length > 0 && (
                <div className="qsw__group">Projects</div>
              )}
              {results.projects.map((it, n) =>
                renderItem(it, results.verbItems.length + n),
              )}
              {results.tasksF.length > 0 && <div className="qsw__group">Tasks</div>}
              {results.tasksF.map((it, n) =>
                renderItem(
                  it,
                  results.verbItems.length + results.projects.length + n,
                ),
              )}
            </>
          )}
        </div>
        <div className="qsw__hint">
          <kbd>↑</kbd>
          <kbd>↓</kbd> move · <kbd>↵</kbd> open · <kbd>esc</kbd> close
        </div>
      </div>
    </div>
  );
}

export function ProjectsPage() {
  return <ProjectsPageInner />;
}

export default ProjectsPage;
