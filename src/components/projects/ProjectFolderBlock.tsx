// task-1bf3a297c9f9 — folder-aesthetic projects. Renders ONE project as a
// FOLDER: a FolderHeader-style header (kicker · serif title · italic dek ·
// bound-folder kicker · ❦ ornament — reusing the `folder-header__*` CSS
// classes verbatim) followed by a `folder-list__list`-style list of its tasks
// (PROJECT = FOLDER, TASK = FILE), plus nested ProjectFolderBlocks for
// sub-projects (sub-folders).
//
// This is purely PRESENTATIONAL. It does NOT own task data / actions: the host
// (HomeSurface / ProjectsPageInner) supplies a `renderTaskRow` callback that
// resolves the full TaskRow plumbing (primary action, kebab, schedule, …) so
// this block stays a thin composition of existing pieces. It invents no new
// visual language — every pixel rides existing tokens + FolderHeader classes.
//
// PHI: project name/description/folders are NON-PHI teaching context (safe).
// Task TITLES are PHI but rendered in-app for the operator only (via the
// host's renderTaskRow → TaskRow), never to disk/logs.

import type { ReactNode } from 'react';
import type { Project, Task } from '../../types';
import type { ProjectNode, ProjectAttention, TaskStats } from '../../projects/index.mjs';
import { attentionSummary } from '../../projects/index.mjs';
import './ProjectFolderBlock.css';

const CTX_MARK = '◇ given to agents as context';

export interface ProjectFolderRow {
  task: Task;
  depth: 0 | 1;
  childCount: number;
  doneChildCount: number;
}

/** Per-project task data + the host's row renderer, keyed by project id. */
export interface ProjectTasksProvider {
  /** Tasks for a project shaped into a (parent → child) folder list. */
  rowsFor: (projectId: string) => ProjectFolderRow[];
  /** Render one task row (host owns the full TaskRow plumbing). */
  renderTaskRow: (row: ProjectFolderRow) => ReactNode;
}

export interface ProjectFolderBlockProps {
  node: ProjectNode;
  attention: Map<string, ProjectAttention>;
  rollUp: Map<string, { own: TaskStats; rolled: TaskStats }>;
  /** Effective (inherited) description for the header dek. Root block only;
   *  nested blocks fall back to their own project.description. */
  effectiveDesc?: string;
  /** Instruction-scope count for the header (root block only). */
  instructionTotal?: number;
  instructionSummary?: string;
  tasks: ProjectTasksProvider;
  /** Header scale: 'hero' (drilled-in, folder-hero serif) vs 'inline' (a
   *  folder-inside-a-list, tighter). */
  scale: 'hero' | 'inline';
  /** Nesting depth (drives sub-folder indentation). 0 = top of this view. */
  nest?: number;
  /** Drill into a sub-project (folder open). */
  onOpenProject?: (projectId: string) => void;
  /** Drill into THIS block's own project (the inline header title is a drill
   *  target at Home root; omitted in the drilled-in hero view). */
  onOpenSelf?: (projectId: string) => void;
  /** Open the project's bound folder as a folder tab. */
  onOpenFolder?: (folder: string) => void;
  /** New task scoped to this project. */
  onNewTask?: (projectId: string) => void;
  /** Cursor target id (project id OR task id) for keyboard sync. */
  cursorKey?: string | null;
}

function bindLabel(project: Project): string {
  return project.folders.length > 0 ? project.folders.join(' · ') : '';
}

/** A folder-style header for a project, reusing folder-header__* classes so
 *  themes/paper palettes apply unchanged. kicker (parent · Project · N tasks ·
 *  M need you · last activity) / serif title (name) / italic dek (description)
 *  / ❦ ornament. The bound folder rides as a click target on the right. */
export function ProjectHeader({
  node,
  attention,
  rollUp,
  desc,
  instructionTotal,
  instructionSummary,
  scale,
  onOpenSelf,
  onOpenFolder,
  onNewTask,
}: {
  node: ProjectNode;
  attention: Map<string, ProjectAttention>;
  rollUp: Map<string, { own: TaskStats; rolled: TaskStats }>;
  desc: string;
  instructionTotal: number;
  instructionSummary: string;
  scale: 'hero' | 'inline';
  onOpenSelf?: (projectId: string) => void;
  onOpenFolder?: (folder: string) => void;
  onNewTask?: (projectId: string) => void;
}) {
  const p = node.project;
  const att = attention.get(p.id);
  const rolled = rollUp.get(p.id)?.rolled;
  const total = rolled?.total ?? 0;
  const need = att?.total ?? 0;
  const summary = att ? attentionSummary(att) : '';
  // The list endpoint stamps now() onto tasks (no real per-task stamps), so we
  // do NOT invent a "last activity" line the data can't back — the kicker stays
  // count-led (attentionSummary already carries any real, above-floor signal).
  const bound = bindLabel(p);
  const archived = p.archived === true;

  return (
    <header
      className={[
        'folder-header',
        'pfolder-header',
        scale === 'inline' ? 'pfolder-header--inline' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="folder-header__kicker">
        <span className="folder-header__kicker-item">Project</span>
        {total > 0 && (
          <>
            <span className="folder-header__sep" aria-hidden />
            <span className="folder-header__kicker-item">
              {total} {total === 1 ? 'task' : 'tasks'}
            </span>
          </>
        )}
        {need > 0 && (
          <>
            <span className="folder-header__sep" aria-hidden />
            <span className="folder-header__kicker-item pfolder-header__need">
              {need} need{need === 1 ? 's' : ''} you
            </span>
          </>
        )}
        {summary && (
          <>
            <span className="folder-header__sep" aria-hidden />
            <span className="folder-header__kicker-item">{summary}</span>
          </>
        )}
      </div>

      <h1 className="folder-header__title pfolder-header__title" title={p.name}>
        {onOpenSelf ? (
          <button
            type="button"
            className="pfolder-header__open"
            onClick={() => onOpenSelf(p.id)}
            title={`Open ${p.name}`}
          >
            {p.name}
          </button>
        ) : (
          p.name
        )}
        {archived && <span className="pfolder-header__tag"> · archived</span>}
        {bound &&
          (onOpenFolder ? (
            <button
              type="button"
              className="pfolder-header__bind"
              onClick={() => onOpenFolder(p.folders[0])}
              title={`Open bound folder: ${bound}`}
            >
              <span aria-hidden="true">⛓</span> <span className="mono">{bound}</span>
            </button>
          ) : (
            <span className="pfolder-header__bind pfolder-header__bind--static">
              <span aria-hidden="true">⛓</span> <span className="mono">{bound}</span>
            </span>
          ))}
        {!bound && (
          <span className="pfolder-header__bind pfolder-header__bind--static pfolder-header__bind--none">
            no folder bound
          </span>
        )}
      </h1>

      <p className="folder-header__dek pfolder-header__dek">
        {desc ? (
          <>
            {desc} <span className="pcard__ctx">{CTX_MARK}</span>
          </>
        ) : (
          <span className="pfolder-header__dek--empty">
            no description — no shared context for agents
          </span>
        )}
      </p>

      <div className="pfolder-header__rule">
        {instructionTotal > 0 && (
          <span className="projects__ins" title={instructionSummary}>
            ⚖ Instruction scopes · {instructionTotal}
          </span>
        )}
        {onNewTask && (
          <button
            type="button"
            className="projects__newtask pfolder-header__newtask"
            onClick={() => onNewTask(p.id)}
            title="New task in this project (n)"
          >
            + New task <kbd>n</kbd>
          </button>
        )}
        <span className="ornament pfolder-header__ornament" role="presentation">
          <span className="mark">❦</span>
        </span>
      </div>
    </header>
  );
}

/** A collapsed sub-project, rendered as a single folder-like row (mirrors a
 *  FileRow's directory affordance). Click drills in. Used at Home ROOT (Q5). */
export function SubProjectRow({
  node,
  attention,
  rollUp,
  onOpen,
  cursor,
}: {
  node: ProjectNode;
  attention: Map<string, ProjectAttention>;
  rollUp: Map<string, { own: TaskStats; rolled: TaskStats }>;
  onOpen?: (projectId: string) => void;
  cursor?: boolean;
}) {
  const p = node.project;
  const att = attention.get(p.id);
  const rolled = rollUp.get(p.id)?.rolled;
  const total = rolled?.total ?? 0;
  const need = att?.total ?? 0;
  const kids = node.children.length;
  return (
    <div
      role="listitem"
      data-folder-key={p.id}
      className={['pfolder-subrow', cursor ? 'cursor' : ''].filter(Boolean).join(' ')}
      onClick={() => onOpen?.(p.id)}
    >
      <span className="pfolder-subrow__glyph" aria-hidden="true">
        ▸
      </span>
      <span className="pfolder-subrow__name">{p.name}</span>
      <span className="pfolder-subrow__meta">
        {kids > 0 && (
          <span className="pfolder-subrow__subs">
            {kids} sub-project{kids === 1 ? '' : 's'}
          </span>
        )}
        {total > 0 && (
          <span className="pfolder-subrow__count">
            {total} {total === 1 ? 'task' : 'tasks'}
          </span>
        )}
        {need > 0 && (
          <span className="pfolder-subrow__need">
            ⚑ <span className="num">{need}</span> need you
          </span>
        )}
        <span className="pfolder-subrow__chev" aria-hidden="true">
          →
        </span>
      </span>
    </div>
  );
}

/**
 * One project as a folder: header + its task rows + nested sub-project blocks.
 *
 * - `scale='hero'` (drilled-in project view): full folder-hero header, nested
 *   sub-projects rendered as full nested ProjectFolderBlocks (collapsed=false).
 * - `scale='inline'` (Home root): tighter header; sub-projects collapse to a
 *   single SubProjectRow (Q5) so the root stays scannable.
 */
export function ProjectFolderBlock({
  node,
  attention,
  rollUp,
  effectiveDesc,
  instructionTotal = 0,
  instructionSummary = '',
  tasks,
  scale,
  nest = 0,
  onOpenProject,
  onOpenSelf,
  onOpenFolder,
  onNewTask,
  cursorKey,
}: ProjectFolderBlockProps) {
  const p = node.project;
  const rows = tasks.rowsFor(p.id);
  const desc = effectiveDesc ?? p.description ?? '';
  const collapseSubs = scale === 'inline';

  return (
    <section
      className={['pfolder', `pfolder--nest-${Math.min(nest, 3)}`]
        .filter(Boolean)
        .join(' ')}
      data-folder-key={p.id}
    >
      <ProjectHeader
        node={node}
        attention={attention}
        rollUp={rollUp}
        desc={desc}
        instructionTotal={instructionTotal}
        instructionSummary={instructionSummary}
        scale={scale}
        onOpenSelf={onOpenSelf}
        onOpenFolder={onOpenFolder}
        onNewTask={onNewTask}
      />

      {rows.length === 0 && node.children.length === 0 ? (
        <div className="pfolder__empty">No tasks in this project yet.</div>
      ) : (
        <ul className="folder-list__list pfolder__list" role="list">
          {rows.map((row) => tasks.renderTaskRow(row))}
        </ul>
      )}

      {/* Sub-projects: collapsed to one row at root (Q5), full nested blocks
          when drilled in. */}
      {node.children.length > 0 && (
        <div className="pfolder__subs">
          {collapseSubs
            ? node.children.map((child) => (
                <SubProjectRow
                  key={child.project.id}
                  node={child}
                  attention={attention}
                  rollUp={rollUp}
                  onOpen={onOpenProject}
                  cursor={cursorKey === child.project.id}
                />
              ))
            : node.children.map((child) => (
                <ProjectFolderBlock
                  key={child.project.id}
                  node={child}
                  attention={attention}
                  rollUp={rollUp}
                  effectiveDesc={child.project.description ?? ''}
                  tasks={tasks}
                  scale="inline"
                  nest={nest + 1}
                  onOpenProject={onOpenProject}
                  onOpenFolder={onOpenFolder}
                  onNewTask={onNewTask}
                  cursorKey={cursorKey}
                />
              ))}
        </div>
      )}
    </section>
  );
}

export default ProjectFolderBlock;
