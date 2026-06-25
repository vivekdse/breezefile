// task-83048f692491 — Projects home (Project Atlas). A new singleton tab
// (kind='projects') that lives in the existing shell alongside the Tasks page.
// It consumes the projects bridge (window.fm.typebuild.projects.*) and the
// pure foundation resolver (src/projects/) — it does NOT rebuild either.
//
// Three zoom levels, transitioned in-place (no new tabs):
//   L1 GRID     every project as a calm card. The ONE bright thing is the
//               amber "needs you" pill (only when > 0). Aggregate stats roll UP
//               from sub-projects (rollUpTaskStats). Strict column alignment.
//   L1 SCOPED   a project with children shows the SAME grid, scoped to its
//               children, with a breadcrumb back to all projects.
//   L2 DETAIL   drill into a project → its parent→child task tree with roll-up
//               SENTENCES on parents ("4 of 6 done · 1 needs you") and visible
//               blocked-by dependencies. Reuses the task partition helpers.
//
// Keyboard model (mirrors TasksPage's verb-first motion model):
//   j/k or ↑/↓   move cursor
//   l / Enter    drill in (card → scoped grid or project tree; tree row → task)
//   h / Esc      back up one zoom level
//   :            open the command palette (verbs act on the app)
//
// PHI: project name/description/instructions/folders are NON-PHI teaching
// context — safe to render. Task TITLES are PHI; in the L2 tree we render task
// titles for the human operating their own machine (same as TasksPage), never
// to disk/logs.

import { useEffect, useMemo, useRef, useState } from 'react';
import { fm } from '../../bridge';
import { useStore } from '../../store';
import { useTasks } from '../../tasks';
import type { Project, Task } from '../../types';
import {
  buildProjectTree,
  indexTree,
  ancestorChain,
  breadcrumbPath,
  rollUpTaskStats,
  resolveEffectiveDescription,
  resolveEffectiveInstructions,
} from '../../projects/index.mjs';
import type { ProjectNode, TaskStats } from '../../projects/index.mjs';
import { resolveBlockedBy } from '../tasks/sections.mjs';
import './ProjectsPage.css';

const CTX_MARK = '◇ given to agents as context';

// ── status mapping (mirrors the foundation resolver's classifyTask) ──────────
type RowStatus = 'working' | 'need' | 'blocked' | 'done' | 'passive';
function rowStatusOf(t: Task): RowStatus {
  const raw = (t.rawStatus ?? t.status ?? '').toLowerCase();
  if (raw === 'blocked' || raw === 'failed') return 'blocked';
  if (t.status === 'done' || t.status === 'cancelled') return 'done';
  if (t.status === 'in_progress') return 'working';
  return 'need'; // pending / open — wants a human
}

function statsRollUpSentence(s: TaskStats): string {
  const parts: string[] = [];
  if (s.total > 0) parts.push(`${s.done} of ${s.total} done`);
  if (s.inProgress > 0) parts.push(`${s.inProgress} working`);
  if (s.needsYou > 0) parts.push(`${s.needsYou} needs you`);
  if (s.blocked > 0) parts.push(`${s.blocked} blocked`);
  return parts.join(' · ');
}

// One proportion segment bar from a TaskStats roll-up.
function SegBar({ stats }: { stats: TaskStats }) {
  const working = stats.inProgress;
  const need = stats.needsYou - stats.blocked > 0 ? stats.needsYou - stats.blocked : 0;
  const blocked = stats.blocked;
  const done = stats.done + stats.cancelled;
  const total = working + need + blocked + done;
  if (total === 0) {
    return <div className="segbar" aria-hidden="true" />;
  }
  const seg = (cls: string, n: number) =>
    n > 0 ? <i key={cls} className={cls} style={{ flex: n }} /> : null;
  return (
    <div className="segbar" aria-hidden="true">
      {seg('seg-working', working)}
      {seg('seg-need', need)}
      {seg('seg-blocked', blocked)}
      {seg('seg-done', done)}
    </div>
  );
}

function ProjectsPageInner() {
  const { state, dispatch } = useStore();
  const isActive = state.tabs[state.activeTab]?.kind === 'projects';

  // ── data ──────────────────────────────────────────────────────────────────
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fm.typebuild.projects
      .list()
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
  }, [reloadTick]);

  // Pull all tasks (incl. done) once; roll up per-project client-side. The
  // partition is by project, not owner, so we want the whole set.
  const { tasks: allTasks } = useTasks({ includeDone: true });

  const roots = useMemo(() => buildProjectTree(projects), [projects]);
  const nodeById = useMemo(() => indexTree(roots), [roots]);
  const rollUp = useMemo(
    () => rollUpTaskStats(roots, allTasks),
    [roots, allTasks],
  );

  // ── zoom state ─────────────────────────────────────────────────────────────
  // level 1 = grid; level 2 = a single project's task tree.
  const [level, setLevel] = useState<1 | 2>(1);
  // L1 scope: null = all roots; else a project id whose CHILDREN we show.
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const [gridCursor, setGridCursor] = useState(0);
  const [treeCursor, setTreeCursor] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showCreate, setShowCreate] = useState(false);

  const gridRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);

  // The project nodes shown in the current L1 grid.
  const gridNodes: ProjectNode[] = useMemo(() => {
    if (scopeId == null) return roots;
    return nodeById.get(scopeId)?.children ?? [];
  }, [roots, scopeId, nodeById]);

  // Clamp the grid cursor when the visible set changes.
  useEffect(() => {
    if (gridCursor >= gridNodes.length) setGridCursor(0);
  }, [gridNodes, gridCursor]);

  // ── L2 derived data ─────────────────────────────────────────────────────────
  const detailProject = detailId ? nodeById.get(detailId)?.project ?? null : null;
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

  // Tasks belonging to the drilled project (own only), shaped into a
  // parent→child tree for the L2 view.
  type TreeRow = { task: Task; depth: 0 | 1; childCount: number; doneChildCount: number };
  const detailTasks = useMemo(
    () => (detailId ? allTasks.filter((t) => t.projectId === detailId) : []),
    [allTasks, detailId],
  );
  const treeRows: TreeRow[] = useMemo(() => {
    if (detailTasks.length === 0) return [];
    const byId = new Map(detailTasks.map((t) => [t.id, t]));
    const childrenOf = new Map<string, Task[]>();
    const roots2: Task[] = [];
    for (const t of detailTasks) {
      const pid = t.parentTaskId;
      if (pid && byId.has(pid)) {
        const arr = childrenOf.get(pid) ?? [];
        arr.push(t);
        childrenOf.set(pid, arr);
      } else {
        roots2.push(t);
      }
    }
    const out: TreeRow[] = [];
    for (const parent of roots2) {
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
  }, [detailTasks, expanded]);

  // Per-parent roll-up of child statuses → the muted sentence on the row.
  const childStatsByParent = useMemo(() => {
    const m = new Map<string, TaskStats>();
    const empty = (): TaskStats => ({
      total: 0,
      open: 0,
      inProgress: 0,
      done: 0,
      cancelled: 0,
      blocked: 0,
      needsYou: 0,
    });
    for (const t of detailTasks) {
      const pid = t.parentTaskId;
      if (!pid) continue;
      const s = m.get(pid) ?? empty();
      s.total += 1;
      const rs = rowStatusOf(t);
      if (rs === 'done') s.done += 1;
      else if (rs === 'working') s.inProgress += 1;
      else if (rs === 'blocked') {
        s.blocked += 1;
        s.needsYou += 1;
      } else if (rs === 'need') s.needsYou += 1;
      m.set(pid, s);
    }
    return m;
  }, [detailTasks]);

  useEffect(() => {
    if (treeCursor >= treeRows.length) setTreeCursor(0);
  }, [treeRows, treeCursor]);

  // ── navigation ──────────────────────────────────────────────────────────────
  function enterCard(node: ProjectNode) {
    if (node.children.length > 0) {
      // a project whose children are projects → re-scope the grid
      setScopeId(node.project.id);
      setGridCursor(0);
      dispatch({
        type: 'setStatus',
        msg: `zoom → ${node.project.name} · ${node.children.length} sub-projects`,
      });
    } else {
      // drill into the project's task tree
      setDetailId(node.project.id);
      setTreeCursor(0);
      setExpanded(new Set());
      setLevel(2);
    }
  }
  function backUp() {
    if (level === 2) {
      setLevel(1);
      return;
    }
    if (scopeId != null) {
      const parentNode = nodeById.get(scopeId);
      setScopeId(parentNode?.parentId ?? null);
      setGridCursor(0);
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
      setTreeCursor(0);
      setExpanded(new Set());
      setLevel(2);
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
      // :new-project verb — surface the inline create form at the grid level.
      setLevel(1);
      setShowCreate(true);
    }
    window.addEventListener('fm:projects:focus', onFocus);
    window.addEventListener('fm:projects:new', onNew);
    return () => {
      window.removeEventListener('fm:projects:focus', onFocus);
      window.removeEventListener('fm:projects:new', onNew);
    };
  }, [nodeById]);

  // ── keyboard ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isActive) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      if (inField) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ':') {
        e.preventDefault();
        dispatch({ type: 'setMode', mode: 'command', buffer: '' });
        return;
      }
      if (e.key === 'Escape' || e.key === 'h' || e.key === 'ArrowLeft') {
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
      if (level === 1) {
        if (e.key === 'ArrowDown' || e.key === 'j') {
          e.preventDefault();
          setGridCursor((c) => Math.min(gridNodes.length - 1, c + 1));
        } else if (e.key === 'ArrowUp' || e.key === 'k') {
          e.preventDefault();
          setGridCursor((c) => Math.max(0, c - 1));
        } else if (e.key === 'l' || e.key === 'ArrowRight' || e.key === 'Enter') {
          e.preventDefault();
          const node = gridNodes[gridCursor];
          if (node) enterCard(node);
        }
      } else {
        // level 2 — task tree
        if (e.key === 'ArrowDown' || e.key === 'j') {
          e.preventDefault();
          setTreeCursor((c) => Math.min(treeRows.length - 1, c + 1));
        } else if (e.key === 'ArrowUp' || e.key === 'k') {
          e.preventDefault();
          setTreeCursor((c) => Math.max(0, c - 1));
        } else if (e.key === 'l' || e.key === 'ArrowRight' || e.key === 'Enter') {
          e.preventDefault();
          const row = treeRows[treeCursor];
          if (!row) return;
          if (row.childCount > 0) toggleExpand(row.task.id);
          else openTaskDetail(row.task);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, level, scopeId, gridNodes, gridCursor, treeRows, treeCursor, showCreate]);

  // keep the cursor row in view
  useEffect(() => {
    if (level !== 1) return;
    gridRef.current
      ?.querySelector(`[data-grid-i="${gridCursor}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [gridCursor, level]);
  useEffect(() => {
    if (level !== 2) return;
    treeRef.current
      ?.querySelector(`[data-tree-i="${treeCursor}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [treeCursor, level]);

  // ── L1 hero ──────────────────────────────────────────────────────────────────
  const heroNeed = useMemo(
    () => gridNodes.reduce((a, n) => a + (rollUp.get(n.project.id)?.rolled.needsYou ?? 0), 0),
    [gridNodes, rollUp],
  );
  const heroBlocked = useMemo(
    () => gridNodes.reduce((a, n) => a + (rollUp.get(n.project.id)?.rolled.blocked ?? 0), 0),
    [gridNodes, rollUp],
  );
  // the project most needing attention (drives the hero "open it first")
  const heroTarget = useMemo(() => {
    let best: ProjectNode | null = null;
    let bestNeed = 0;
    for (const n of gridNodes) {
      const need = rollUp.get(n.project.id)?.rolled.needsYou ?? 0;
      if (need > bestNeed) {
        bestNeed = need;
        best = n;
      }
    }
    return best;
  }, [gridNodes, rollUp]);

  const scopeProject = scopeId != null ? nodeById.get(scopeId)?.project ?? null : null;

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className="projects">
      <div className="projects__page">
        <div className="projects__crumb">
          <button
            type="button"
            className={scopeId == null && level === 1 ? 'projects__crumb-here' : 'projects__crumb-clk'}
            onClick={() => {
              setLevel(1);
              setScopeId(null);
              setGridCursor(0);
            }}
          >
            Atlas
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
          <span className="projects__zoom" aria-hidden="true">
            <i className="on" />
            <i className={level >= 2 ? 'on' : ''} />
          </span>
        </div>

        {level === 1 ? (
          <ProjectsGrid
            gridRef={gridRef}
            nodes={gridNodes}
            rollUp={rollUp}
            scopeProject={scopeProject}
            totalProjects={projects.length}
            gridCursor={gridCursor}
            heroNeed={heroNeed}
            heroBlocked={heroBlocked}
            heroTarget={heroTarget}
            loaded={loaded}
            loadErr={loadErr}
            showCreate={showCreate}
            onShowCreate={() => setShowCreate(true)}
            onCancelCreate={() => setShowCreate(false)}
            onCreated={(p) => {
              setShowCreate(false);
              setProjects((prev) => [...prev, p]);
              setReloadTick((t) => t + 1);
              dispatch({ type: 'setStatus', msg: `project created · ${p.name}` });
            }}
            onSetCursor={setGridCursor}
            onEnter={enterCard}
            onHeroOpen={(n) => enterCard(n)}
            allProjects={projects}
            scopeId={scopeId}
          />
        ) : (
          <ProjectDetail
            treeRef={treeRef}
            project={detailProject}
            effectiveDesc={effectiveDesc}
            instructionTotal={effectiveInstructions?.total ?? 0}
            instructionSummary={effectiveInstructions?.summary ?? ''}
            rows={treeRows}
            childStatsByParent={childStatsByParent}
            expanded={expanded}
            treeCursor={treeCursor}
            allTasks={allTasks}
            onBack={() => setLevel(1)}
            onSetCursor={setTreeCursor}
            onToggleExpand={toggleExpand}
            onOpenTask={openTaskDetail}
          />
        )}
      </div>
    </div>
  );
}

// ── L1: the projects grid ──────────────────────────────────────────────────────
function ProjectsGrid({
  gridRef,
  nodes,
  rollUp,
  scopeProject,
  totalProjects,
  gridCursor,
  heroNeed,
  heroBlocked,
  heroTarget,
  loaded,
  loadErr,
  showCreate,
  onShowCreate,
  onCancelCreate,
  onCreated,
  onSetCursor,
  onEnter,
  onHeroOpen,
  allProjects,
  scopeId,
}: {
  gridRef: React.RefObject<HTMLDivElement | null>;
  nodes: ProjectNode[];
  rollUp: Map<string, { own: TaskStats; rolled: TaskStats }>;
  scopeProject: Project | null;
  totalProjects: number;
  gridCursor: number;
  heroNeed: number;
  heroBlocked: number;
  heroTarget: ProjectNode | null;
  loaded: boolean;
  loadErr: string | null;
  showCreate: boolean;
  onShowCreate: () => void;
  onCancelCreate: () => void;
  onCreated: (p: Project) => void;
  onSetCursor: (i: number) => void;
  onEnter: (n: ProjectNode) => void;
  onHeroOpen: (n: ProjectNode) => void;
  allProjects: Project[];
  scopeId: string | null;
}) {
  const empty = loaded && !loadErr && nodes.length === 0;
  return (
    <>
      <div className="projects__head">
        <div className="projects__head-text">
          <h1 className="projects__title">
            {scopeProject ? scopeProject.name : 'Your projects'}
          </h1>
          <div className="projects__sub">
            {scopeProject
              ? `${nodes.length} sub-project${nodes.length === 1 ? '' : 's'} · same view, scoped`
              : `${totalProjects} project${totalProjects === 1 ? '' : 's'} · zoom into any one to see its task tree`}
          </div>
        </div>
        <div className="projects__head-actions">
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

      {loadErr && (
        <div className="projects__hero" role="alert">
          Couldn’t load projects: {loadErr}
        </div>
      )}

      {!empty && !loadErr && nodes.length > 0 && (
        heroNeed === 0 && heroBlocked === 0 ? (
          <div className="projects__hero projects__hero--clear" role="status">
            Nothing needs you{scopeProject ? ' in these sub-projects' : ''} — agents are running.
          </div>
        ) : (
          <div className="projects__hero" role="status">
            <b>
              {heroNeed} {heroNeed === 1 ? 'thing needs' : 'things need'} you
              {heroBlocked > 0 ? `, ${heroBlocked} blocked` : ''}.
            </b>{' '}
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

      {empty && !showCreate && (
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

      <div className="projects__grid" ref={gridRef} role="list">
        {nodes.map((node, i) => {
          const p = node.project;
          const rolled = rollUp.get(p.id)?.rolled;
          const need = rolled?.needsYou ?? 0;
          const stats: TaskStats = rolled ?? {
            total: 0,
            open: 0,
            inProgress: 0,
            done: 0,
            cancelled: 0,
            blocked: 0,
            needsYou: 0,
          };
          const bind = p.folders.length > 0 ? p.folders.join(' · ') : 'no folder bound';
          return (
            <button
              type="button"
              key={p.id}
              data-grid-i={i}
              role="listitem"
              className={['pcard', i === gridCursor ? 'cursor' : ''].filter(Boolean).join(' ')}
              onClick={() => {
                onSetCursor(i);
                onEnter(node);
              }}
            >
              <div className="pcard__top">
                <span className="pcard__name">{p.name}</span>
                {need > 0 && (
                  <span className="pcard__need">
                    ⚑ <span className="num">{need}</span> need you
                  </span>
                )}
              </div>
              {p.description ? (
                <div className="pcard__desc">
                  {p.description}{' '}
                  <span className="pcard__ctx">{CTX_MARK}</span>
                </div>
              ) : (
                <div className="pcard__desc pcard__desc--empty">
                  No description yet — agents have no shared context for this project.
                </div>
              )}
              {node.children.length > 0 && (
                <div className="pcard__subs">
                  ▸ {node.children.length} sub-project{node.children.length === 1 ? '' : 's'}
                </div>
              )}
              <div className="pcard__bind">
                <span aria-hidden="true">⛓</span>
                <span className="mono">{bind}</span>
              </div>
              <SegBar stats={stats} />
              <div className="segcap">
                <span>
                  <span className="num">{stats.inProgress}</span> working
                </span>
                <span>
                  <span className="num">{stats.done}</span> done
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

// ── L2: a single project's task tree ────────────────────────────────────────────
function ProjectDetail({
  treeRef,
  project,
  effectiveDesc,
  instructionTotal,
  instructionSummary,
  rows,
  childStatsByParent,
  expanded,
  treeCursor,
  allTasks,
  onBack,
  onSetCursor,
  onToggleExpand,
  onOpenTask,
}: {
  treeRef: React.RefObject<HTMLDivElement | null>;
  project: Project | null;
  effectiveDesc: string;
  instructionTotal: number;
  instructionSummary: string;
  rows: Array<{ task: Task; depth: 0 | 1; childCount: number; doneChildCount: number }>;
  childStatsByParent: Map<string, TaskStats>;
  expanded: Set<string>;
  treeCursor: number;
  allTasks: Task[];
  onBack: () => void;
  onSetCursor: (i: number) => void;
  onToggleExpand: (id: string) => void;
  onOpenTask: (t: Task) => void;
}) {
  if (!project) {
    return (
      <>
        <button type="button" className="projects__back" onClick={onBack}>
          ‹ h — back to all projects
        </button>
        <div className="ptree__empty">Project not found.</div>
      </>
    );
  }
  const bind = project.folders.length > 0 ? project.folders.join(' · ') : 'no folder bound';
  return (
    <>
      <button type="button" className="projects__back" onClick={onBack}>
        ‹ h — back to all projects
      </button>
      <div className="projects__l2head">
        <div className="projects__l2top">
          <h2 className="projects__l2name">{project.name}</h2>
          <div className="projects__l2bind">
            <span aria-hidden="true">⛓</span>
            <span className="mono">{bind}</span>
          </div>
        </div>
        {effectiveDesc && (
          <div className="projects__desc">
            {effectiveDesc} <span className="pcard__ctx">{CTX_MARK}</span>
          </div>
        )}
        {instructionTotal > 0 && (
          <div className="projects__ins" title={instructionSummary}>
            ⚖ Instruction scopes · {instructionTotal}
          </div>
        )}
      </div>

      <div className="ptree" ref={treeRef} role="list">
        {rows.length === 0 ? (
          <div className="ptree__empty">No tasks in this project yet.</div>
        ) : (
          rows.map((row, i) => {
            const t = row.task;
            const rs = rowStatusOf(t);
            const dotCls =
              rs === 'working'
                ? 'working'
                : rs === 'blocked'
                  ? 'blocked'
                  : rs === 'need'
                    ? 'need'
                    : '';
            const isParent = row.childCount > 0;
            const childStats = isParent ? childStatsByParent.get(t.id) : undefined;
            const rollSentence = childStats ? statsRollUpSentence(childStats) : '';
            const blockedTitles =
              rs === 'blocked' ? resolveBlockedBy(t.blockedBy, allTasks) : [];
            return (
              <div
                key={t.id}
                data-tree-i={i}
                role="listitem"
                className={[
                  'trow',
                  isParent ? 'parent' : 'leaf',
                  row.depth === 1 ? 'child' : '',
                  i === treeCursor ? 'cursor' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => {
                  onSetCursor(i);
                  if (isParent) onToggleExpand(t.id);
                  else onOpenTask(t);
                }}
              >
                {isParent ? (
                  <button
                    type="button"
                    className="trow__twist"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSetCursor(i);
                      onToggleExpand(t.id);
                    }}
                    aria-label={expanded.has(t.id) ? 'Collapse' : 'Expand'}
                  >
                    {expanded.has(t.id) ? '▾' : '▸'}
                  </button>
                ) : (
                  <span className="trow__twist" aria-hidden="true" />
                )}
                <span className={['trow__dot', dotCls].filter(Boolean).join(' ')} aria-hidden="true" />
                <div className="trow__body">
                  <div className="trow__nm">
                    {t.title}
                    {rollSentence && <span className="trow__roll">{rollSentence}</span>}
                  </div>
                  {blockedTitles.length > 0 && (
                    <div className="trow__meta">
                      <span className="trow__dep">⛔ blocked by {blockedTitles.join(', ')}</span>
                    </div>
                  )}
                </div>
                <div className="trow__right">
                  {rs === 'blocked' ? (
                    <span className="pbadge blocked">blocked</span>
                  ) : rs === 'need' ? (
                    <span className="pbadge need">needs you</span>
                  ) : rs === 'working' ? (
                    <span className="pbadge working">working</span>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
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

export function ProjectsPage() {
  return <ProjectsPageInner />;
}

export default ProjectsPage;
