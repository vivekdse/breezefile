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
import { TaskRowHeader } from '../tasks/TaskRow';
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
  /** task-0ab7bbc30a11 — open the inline editor for THIS project's
   *  name/description. When provided, the header's "＋ Add description"
   *  affordance opens the editor instead of (or in addition to) drilling in. */
  onEditDescription?: () => void;
  /** Cursor target id (project id OR task id) for keyboard sync. */
  cursorKey?: string | null;
  /** task-18902d433658 — "needs you" filter state for THIS block's project. When
   *  active, `tasks.rowsFor` already returns only the attention tasks; this just
   *  drives the header toggle's pressed state + the filter chip. */
  needsYouActive?: boolean;
  /** Toggle the "needs you" filter (omit → no clickable filter affordance). */
  onToggleNeedsYou?: (projectId: string) => void;
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
  onEditDescription,
  needsYouActive = false,
  onToggleNeedsYou,
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
  onEditDescription?: () => void;
  /** task-18902d433658 — whether the "needs you" filter is on for THIS project. */
  needsYouActive?: boolean;
  /** Toggle the "needs you" filter (omit → the kicker count is static text). */
  onToggleNeedsYou?: (projectId: string) => void;
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
            {onToggleNeedsYou ? (
              // task-18902d433658 — clickable: toggles the project list down to
              // exactly these N tasks (same predicate that produced the count).
              <button
                type="button"
                className={[
                  'folder-header__kicker-item',
                  'pfolder-header__need',
                  'pfolder-header__need--clickable',
                  needsYouActive ? 'is-on' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-pressed={needsYouActive}
                onClick={() => onToggleNeedsYou(p.id)}
                title={
                  needsYouActive
                    ? 'Showing only the tasks that need you — click to show all'
                    : `Show only the ${need} task${need === 1 ? '' : 's'} that need you`
                }
              >
                {need} need{need === 1 ? 's' : ''} you
              </button>
            ) : (
              <span className="folder-header__kicker-item pfolder-header__need">
                {need} need{need === 1 ? 's' : ''} you
              </span>
            )}
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
        {/* task-875c6ad17f85 — "folder" was overloaded (project metaphor vs the
            bound disk path vs file tabs); the disk binding is named the
            "working folder" consistently. A project with no working folder is
            fine, so the old "no folder bound" scold is dropped (absence isn't
            an error to flag on every row). */}
        {bound &&
          (onOpenFolder ? (
            <button
              type="button"
              className="pfolder-header__bind"
              onClick={() => onOpenFolder(p.folders[0])}
              title={`Open working folder: ${bound}`}
            >
              <span aria-hidden="true">⛓</span> <span className="mono">{bound}</span>
            </button>
          ) : (
            <span className="pfolder-header__bind pfolder-header__bind--static">
              <span aria-hidden="true">⛓</span> <span className="mono">{bound}</span>
            </span>
          ))}
      </h1>

      <p className="folder-header__dek pfolder-header__dek">
        {desc ? (
          <>
            {desc} <span className="pcard__ctx">{CTX_MARK}</span>
            {/* task-0ab7bbc30a11 — when the drilled-in editor is available, the
                description is editable in place via a subtle "edit" affordance
                (the L2 "✎ Edit" button does the same). */}
            {onEditDescription && (
              <>
                {' '}
                <button
                  type="button"
                  className="pfolder-header__dek--edit"
                  onClick={onEditDescription}
                  title="Edit name and description"
                >
                  ✎ edit
                </button>
              </>
            )}
          </>
        ) : onEditDescription ? (
          // task-0ab7bbc30a11 — the "＋ Add description" affordance now OPENS the
          // inline editor (it previously only drilled in via onOpenSelf, with no
          // editor on the other side).
          <button
            type="button"
            className="pfolder-header__dek--add"
            onClick={onEditDescription}
            title="Add a description — shared context for agents working this project"
          >
            ＋ Add description
          </button>
        ) : onOpenSelf ? (
          // task-875c6ad17f85 — at Home root (no inline editor) the affordance
          // drills into the project, where the description IS now editable.
          <button
            type="button"
            className="pfolder-header__dek--add"
            onClick={() => onOpenSelf(p.id)}
            title="Add a description — shared context for agents working this project"
          >
            ＋ Add description
          </button>
        ) : (
          <span className="pfolder-header__dek--empty">＋ Add description</span>
        )}
      </p>

      {/* task-54e9281f0986 — the per-card "+ New task" button was removed; Add
          task / Add project now live in the opened-project header bar
          (ProjectDetail's projects__l2bar), scoped to the open project. */}
      <div className="pfolder-header__rule">
        {instructionTotal > 0 && (
          <span className="projects__ins" title={instructionSummary}>
            ⚖ Instruction scopes · {instructionTotal}
          </span>
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

// ── compact project row (task-6050fee0efb1) ───────────────────────────────────
// One project = ONE file/folder-style row at Home root. Name on the left, a
// minimal status glyph + counts on the right — mirrors FileRow's directory
// affordance (folder icon, name, trailing chevron). NO inline task list: the
// file manager doesn't show a folder's contents inline, and neither do we.
// Opening (click / Enter) drills into the project to reveal its tasks + subs.
//
// The status glyph + counts are passed in by the host (it owns the shared
// attention partition), so this row re-derives nothing.
export interface ProjectRowProps {
  node: ProjectNode;
  /** Loudest status glyph for the project (host derives from attention). */
  statusGlyph: string;
  statusKind: string;
  /** Human label for the glyph — used as a tooltip so the icon vocabulary is
   *  self-explaining (task-875c6ad17f85). */
  statusLabel?: string;
  /** Rolled-up task total + "needs you" count (host-derived). */
  total: number;
  need: number;
  /** Sub-project count (folder-has-subfolders affordance). */
  subCount: number;
  archived?: boolean;
  cursor?: boolean;
  onOpen?: (projectId: string) => void;
  /** Mouse → cursor sync. */
  onHover?: (projectId: string) => void;
  /** Archive / unarchive toggle (host owns the mutation). */
  onArchive?: (projectId: string, archived: boolean) => void;
  /** task-18902d433658 — click the "N need you" pill → drill in filtered to
   *  exactly those attention tasks. When omitted the pill is static text. */
  onNeedsYou?: (projectId: string) => void;
}

export function ProjectRow({
  node,
  statusGlyph,
  statusKind,
  statusLabel,
  total,
  need,
  subCount,
  archived = false,
  cursor = false,
  onOpen,
  onHover,
  onArchive,
  onNeedsYou,
}: ProjectRowProps) {
  const p = node.project;
  return (
    <div
      role="listitem"
      data-folder-key={p.id}
      className={[
        'pfolder-row',
        cursor ? 'pfolder-row--cursor' : '',
        archived ? 'pfolder-row--archived' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onMouseDown={() => onHover?.(p.id)}
      onClick={() => onOpen?.(p.id)}
      title={`Open ${p.name}`}
    >
      <span
        className={`pfolder-row__status pfolder-row__status--${statusKind}`}
        title={statusLabel}
        aria-label={statusLabel}
        role={statusLabel ? 'img' : undefined}
      >
        {statusGlyph}
      </span>
      <span className="pfolder-row__icon" aria-hidden="true">
        ▸
      </span>
      <span className="pfolder-row__name">{p.name}</span>
      <span className="pfolder-row__meta">
        {subCount > 0 && (
          <span className="pfolder-row__subs">
            {subCount} sub-project{subCount === 1 ? '' : 's'}
          </span>
        )}
        {total > 0 && (
          <span className="pfolder-row__count">
            {total} {total === 1 ? 'task' : 'tasks'}
          </span>
        )}
        {need > 0 &&
          (onNeedsYou ? (
            <button
              type="button"
              className="pfolder-row__need pfolder-row__need--clickable"
              title={`Show the ${need} task${need === 1 ? '' : 's'} needing you`}
              onClick={(e) => {
                e.stopPropagation();
                onNeedsYou(p.id);
              }}
            >
              ⚑ <span className="num">{need}</span> need you
            </button>
          ) : (
            <span className="pfolder-row__need">
              ⚑ <span className="num">{need}</span> need you
            </span>
          ))}
      </span>
      {onArchive && (
        <button
          type="button"
          className="pfolder-row__archive"
          title={archived ? 'Unarchive project' : 'Archive project'}
          aria-label={archived ? 'Unarchive project' : 'Archive project'}
          onClick={(e) => {
            e.stopPropagation();
            onArchive(p.id, !archived);
          }}
        >
          {archived ? '↺' : '⊟'}
        </button>
      )}
      <span className="pfolder-row__chev" aria-hidden="true">
        →
      </span>
    </div>
  );
}

/**
 * One project as a folder: header + its task rows + a single collapsed row per
 * sub-project — the file-manager model (PROJECT = FOLDER, TASK = FILE).
 *
 * Sub-projects ALWAYS collapse to one SubProjectRow (folder affordance: name +
 * counts, opened to reveal its own tasks). This holds at every level:
 * - `scale='hero'` (drilled-in project view): full folder-hero header; the
 *   opened project shows its OWN tasks, and each sub-project is one folder row.
 * - `scale='inline'` (Home root / recursion): tighter header; same one-row subs.
 * A project's tasks are never shown inline under a *parent* — you open the
 * sub-project to see them, exactly like opening a folder.
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
  onEditDescription,
  cursorKey,
  needsYouActive = false,
  onToggleNeedsYou,
}: ProjectFolderBlockProps) {
  const p = node.project;
  const rows = tasks.rowsFor(p.id);
  const desc = effectiveDesc ?? p.description ?? '';
  const att = attention.get(p.id);
  const needCount = att?.total ?? 0;

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
        onEditDescription={onEditDescription}
        needsYouActive={needsYouActive}
        onToggleNeedsYou={onToggleNeedsYou}
      />

      {/* task-18902d433658 — active filter chip: tells the user the list is
          narrowed to "needs you" and lets them clear it back to all tasks. */}
      {needsYouActive && onToggleNeedsYou && (
        <div className="pfolder__filterbar">
          <button
            type="button"
            className="pfolder__filterchip is-on"
            aria-pressed
            onClick={() => onToggleNeedsYou(p.id)}
            title="Clear the filter — show all tasks in this project"
          >
            ⚑ Needs you · {needCount}
            <span className="pfolder__filterchip-x" aria-hidden="true"> ✕</span>
          </button>
        </div>
      )}

      {rows.length === 0 && node.children.length === 0 ? (
        <div className="pfolder__empty">
          {needsYouActive
            ? 'Nothing needs you in this project right now.'
            : 'No tasks in this project yet.'}
        </div>
      ) : (
        <>
          <TaskRowHeader />
          <ul className="folder-list__list pfolder__list" role="list">
            {rows.map((row) => tasks.renderTaskRow(row))}
          </ul>
        </>
      )}

      {/* Sub-projects: one collapsed folder row each (name + counts). Opening a
          row drills into that sub-project to reveal its own tasks — the file
          manager never shows a folder's contents inline, and neither do we. */}
      {node.children.length > 0 && (
        <div className="pfolder__subs">
          {node.children.map((child) => (
            <SubProjectRow
              key={child.project.id}
              node={child}
              attention={attention}
              rollUp={rollUp}
              onOpen={onOpenProject}
              cursor={cursorKey === child.project.id}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default ProjectFolderBlock;
