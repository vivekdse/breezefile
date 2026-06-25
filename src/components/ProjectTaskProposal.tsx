/*
 * ProjectTaskProposal — the project-scoped "intent → proposal" create flow.
 *
 * Opened by the `:project-task` verb (App listens for `fm:openProjectTask`).
 * Distinct from TaskComposer (the generic guided create): THIS is the richer
 * project-scoped flow the user asked for — lead with RECIPES, take a free-form
 * INTENT, then show a PROPOSED-task card that opens into a detailed proposal
 * carrying the inherited project folder + cascading instructions + effective
 * description (with provenance, from the foundation resolver). Confirm creates
 * the task with `projectId` set.
 *
 * DEDUP WITH THE COMPOSER: we do NOT fork the whole composer. The only field
 * the composer ever needed from us is `projectId` on TaskCreate (already in the
 * type); we create directly through `createTask({ ..., projectId }, 'typebuild')`
 * — the shared create path — rather than re-implementing scheduling/who/etc.
 * The proposal intentionally keeps the inferred config calm and minimal (agent,
 * inherited folder, on-demand); deeper scheduling stays the composer's job.
 *
 * PHI: project name/description/instructions/folders are NON-PHI teaching
 * context (safe to display). The task title the user types is PHI — it lives in
 * component state only and is sent straight to the encrypted create, never
 * written to disk/logs.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useOverlayExit } from '../useOverlayExit';
import { fm } from '../bridge';
import { createTask, useTypebuildAuth } from '../tasks';
import { humanizeError } from '../errorMessages';
import {
  buildProjectTree,
  indexTree,
  ancestorChain,
  breadcrumbPath,
  resolveEffectiveDescription,
  resolveEffectiveInstructions,
} from '../projects/index.mjs';
import type {
  ResolvedInstructions,
  ResolvedDescription,
} from '../projects/index.mjs';
import type { Project } from '../types';
import './ProjectTaskProposal.css';

export type ProjectTaskProposalRequest = {
  /** Pre-scope to a project (skips the picker). Optional. */
  projectId?: string;
  /** The active folder — used to auto-suggest the owning project. */
  folder?: string;
};

type Props = ProjectTaskProposalRequest & { onClose: () => void };

const TYPEBUILD_SOURCE = 'typebuild';

// Common project task templates. These lead the compose step ("lead with
// recipes"): a recipe pre-fills the intent line (kept editable) so the user
// starts from a known-good shape rather than a blank box. Generic + reusable
// across project kinds; the project's own instructions specialize them at run
// time via the cascade.
type Recipe = { id: string; ic: string; name: string; sub: string; fill: string };
const RECIPES: Recipe[] = [
  { id: 'process-queue', ic: '⛓', name: 'Work the queue', sub: 'pick up the next item', fill: 'Work the next item in this project end-to-end, following the project instructions' },
  { id: 'daily-sweep', ic: '↻', name: 'Daily sweep', sub: 'recurring check', fill: 'Do a daily sweep of this project and flag anything that needs me' },
  { id: 'draft-followup', ic: '✎', name: 'Draft a follow-up', sub: 'prep, review before send', fill: 'Draft a follow-up for ' },
  { id: 'summarize', ic: '∑', name: 'Summarize status', sub: 'digest for the team', fill: 'Summarize the current status of this project and post a digest' },
];

type Step = 'pick' | 'compose' | 'propose';

export function ProjectTaskProposal(props: Props) {
  const { exit, state } = useOverlayExit(props.onClose);
  const { signedIn } = useTypebuildAuth();

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [projectId, setProjectId] = useState<string | null>(props.projectId ?? null);
  const [pickCursor, setPickCursor] = useState(0);

  const [intent, setIntent] = useState('');
  const [recipeCursor, setRecipeCursor] = useState(0);

  const [contextOpen, setContextOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  const intentRef = useRef<HTMLInputElement>(null);

  // Load the project list once. NON-PHI; safe to hold in state.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await fm.typebuild.projects.list();
        if (!alive) return;
        setProjects(list);
        // If we were handed a folder but no projectId, try to resolve the
        // owning project so the picker pre-selects the right one.
        if (!props.projectId && props.folder) {
          try {
            const owner = await fm.typebuild.projects.resolve(props.folder);
            if (alive && owner) setProjectId(owner.id);
          } catch { /* resolve is best-effort */ }
        }
      } catch (err) {
        if (alive) setLoadError(humanizeError(err).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [props.projectId, props.folder]);

  // The project forest + index, rebuilt when the list changes. Drives the
  // breadcrumb, ancestor chain, and the cascade.
  const roots = useMemo(() => buildProjectTree(projects), [projects]);
  const index = useMemo(() => indexTree(roots), [roots]);

  const project = projectId ? index.get(projectId)?.project ?? null : null;
  const step: Step = !project ? 'pick' : !created && intent.trim() === '' ? 'compose' : !created ? 'propose' : 'propose';

  // Sorted picker list (roots flattened, name-stable already by the tree).
  const pickList = useMemo<{ p: Project; crumb: string }[]>(() => {
    const out: { p: Project; crumb: string }[] = [];
    const walk = (nodes: typeof roots) => {
      for (const n of nodes) {
        out.push({ p: n.project, crumb: breadcrumbPath(roots, n.project.id) });
        walk(n.children);
      }
    };
    walk(roots);
    return out;
  }, [roots]);

  // The inherited context for the chosen project: ancestor description cascade
  // + the instruction cascade (org+project reused from the bridge's
  // effectiveInstructions, layered general→specific by the resolver).
  const chain = useMemo<Project[]>(
    () => (project ? ancestorChain(roots, project.id) : []),
    [roots, project],
  );
  const desc = useMemo<ResolvedDescription | null>(
    () => (chain.length ? resolveEffectiveDescription(chain) : null),
    [chain],
  );
  const instructions = useMemo<ResolvedInstructions | null>(() => {
    if (!project) return null;
    // Project leg reuses the server-computed cascade; parent projects layer in
    // via the description chain already, and the project's own effective set
    // covers org+project. Category/task cohorts aren't modeled here yet (the
    // remote Task has no tag field — see the resolver header), so we pass the
    // project leg only; the resolver still attributes + de-dupes.
    return resolveEffectiveInstructions({
      project: {
        id: project.id,
        label: project.name,
        instructions: project.instructions,
        effectiveInstructions: project.effectiveInstructions,
      },
    });
  }, [project]);

  const folders = project?.folders ?? [];
  const primaryFolder = folders[0] ?? '';

  // ── keyboard ──────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); exit(); return; }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        if (step === 'propose') { e.preventDefault(); void confirm(); }
        return;
      }
      if (step === 'pick') {
        if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); setPickCursor((i) => Math.min(i + 1, pickList.length - 1)); return; }
        if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); setPickCursor((i) => Math.max(i - 1, 0)); return; }
        if (e.key === 'Enter' || e.key === 'l') { e.preventDefault(); const sel = pickList[pickCursor]; if (sel) setProjectId(sel.p.id); return; }
        const n = parseInt(e.key, 10);
        if (!Number.isNaN(n) && n >= 1 && n <= Math.min(9, pickList.length)) {
          e.preventDefault(); setProjectId(pickList[n - 1].p.id); return;
        }
        return;
      }
      if (step === 'compose') {
        const inText = document.activeElement?.tagName === 'INPUT';
        // Digit picks a recipe (only when not typing into the intent box).
        if (!inText) {
          const n = parseInt(e.key, 10);
          if (!Number.isNaN(n) && n >= 1 && n <= RECIPES.length) {
            e.preventDefault(); pickRecipe(n - 1); return;
          }
          if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); setRecipeCursor((i) => Math.min(i + 1, RECIPES.length - 1)); return; }
          if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); setRecipeCursor((i) => Math.max(i - 1, 0)); return; }
          if (e.key === 'Enter') { e.preventDefault(); pickRecipe(recipeCursor); return; }
          // h steps back to the project picker (only when this surface owns
          // the picker — i.e. we weren't pre-scoped to a project).
          if (e.key === 'h' && !props.projectId) { e.preventDefault(); setProjectId(null); return; }
        }
        return;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Focus the intent box when we land on the compose step.
  useEffect(() => {
    if (step === 'compose') setTimeout(() => intentRef.current?.focus(), 0);
  }, [step]);

  function pickRecipe(i: number) {
    const r = RECIPES[i];
    if (!r) return;
    setRecipeCursor(i);
    setIntent(r.fill);
    setTimeout(() => {
      intentRef.current?.focus();
      // Park the caret at the end so "Draft a follow-up for " continues naturally.
      const el = intentRef.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
  }

  async function confirm() {
    if (busy || !project) return;
    const title = intent.trim();
    if (!title) return;
    if (!signedIn) {
      setCreateError('Sign in to TypeBuild to create a project task.');
      return;
    }
    setBusy(true);
    setCreateError(null);
    try {
      // Create through the shared path with projectId set. The TypeBuild source
      // maps projectId → project_id; the inherited folder anchors the agent.
      // We keep config minimal/inferred (manual no-due to-do under the project);
      // scheduling/who specialization stays in the generic composer.
      await createTask(
        {
          title,
          folder: '',
          notes: null,
          status: 'pending',
          due_at: null,
          projectId: project.id,
        },
        TYPEBUILD_SOURCE,
      );
      setCreated(true);
      setTimeout(() => exit(), 900);
    } catch (err) {
      setCreateError(humanizeError(err).message);
      setBusy(false);
    }
  }

  // ── render ──────────────────────────────────────────────────────────────
  const crumb = project ? breadcrumbPath(roots, project.id) : '';

  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div
        className="ptp-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ptp-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="ptp-panel__close" onClick={exit} aria-label="Close">×</button>

        {/* ── STEP 1: PICK ─────────────────────────────────────────────── */}
        {step === 'pick' && (
          <>
            <div className="ptp-panel__eyebrow">Project task</div>
            <h2 className="ptp-panel__title" id="ptp-title">Which project is this for?</h2>
            <p className="ptp-panel__lede">
              Pick a project — the new task inherits its folder, instructions, and
              description as agent context.
            </p>
            {loadError && <p className="ptp-panel__error" role="alert">{loadError}</p>}
            {loading ? (
              <p className="ptp-panel__status" aria-live="polite">Loading projects…</p>
            ) : pickList.length === 0 ? (
              <p className="ptp-panel__status">
                No projects yet. Create one first, then come back to add a
                project-scoped task.
              </p>
            ) : (
              <ul className="ptp-projects" role="listbox" aria-label="Projects">
                {pickList.map(({ p, crumb: c }, i) => {
                  const own = index.get(p.id);
                  const childCount = own?.children.length ?? 0;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === pickCursor}
                        className={'ptp-project' + (i === pickCursor ? ' is-cursor' : '')}
                        onMouseEnter={() => setPickCursor(i)}
                        onClick={() => setProjectId(p.id)}
                      >
                        {i < 9 && <span className="ptp-project__key">{i + 1}</span>}
                        <span className="ptp-project__body">
                          {c.includes('›') && <span className="ptp-project__crumb">{c.replace(/\s*›\s*[^›]+$/, '')} › </span>}
                          <span className="ptp-project__name">{p.name}</span>
                          {p.description && <span className="ptp-project__desc">{p.description}</span>}
                        </span>
                        {childCount > 0 && (
                          <span className="ptp-project__meta">▸ {childCount} sub</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        {/* ── STEP 2: COMPOSE (recipes → intent) ───────────────────────── */}
        {step === 'compose' && project && (
          <>
            <div className="ptp-panel__crumb">{crumb}</div>
            <h2 className="ptp-panel__title" id="ptp-title">What should this task do?</h2>
            <p className="ptp-panel__lede">
              Start from a recipe, or describe the work. We propose a task scoped
              to <b>{project.name}</b> for you to review.
            </p>

            <div className="ptp-section-lbl">Start from a recipe</div>
            <div className="ptp-recipes">
              {RECIPES.map((r, i) => (
                <button
                  key={r.id}
                  type="button"
                  className={'ptp-recipe' + (i === recipeCursor ? ' is-cursor' : '')}
                  onMouseEnter={() => setRecipeCursor(i)}
                  onClick={() => pickRecipe(i)}
                >
                  <span className="ptp-recipe__ic" aria-hidden="true">{r.ic}</span>
                  <span>
                    <span className="ptp-recipe__name">
                      <span className="ptp-project__key ptp-project__key--inline">{i + 1}</span>
                      {r.name}
                    </span>
                    <span className="ptp-recipe__sub">{r.sub}</span>
                  </span>
                </button>
              ))}
            </div>

            <div className="ptp-section-lbl">Or describe the work</div>
            <div className="ptp-intent">
              <input
                ref={intentRef}
                className="ptp-intent__input"
                type="text"
                placeholder="e.g. Work the next prior-auth in this project"
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    // Advancing to the proposal happens automatically once
                    // intent is non-empty (step derives from it); blur so the
                    // proposal's ⌘↵ confirm reads cleanly.
                    if (intent.trim()) intentRef.current?.blur();
                  }
                }}
                spellCheck
                autoComplete="off"
              />
              <div className="ptp-intent__hint">
                Press <kbd>↵</kbd> to propose · <kbd>j</kbd>/<kbd>k</kbd> move · digits <kbd>1</kbd>–<kbd>{RECIPES.length}</kbd> pick a recipe
              </div>
            </div>
          </>
        )}

        {/* ── STEP 3: PROPOSE ──────────────────────────────────────────── */}
        {step === 'propose' && project && (
          <>
            <div className="ptp-panel__crumb">{crumb}</div>
            <div className="ptp-proposal__tag">Proposed task — review before it runs</div>

            <div className="ptp-proposal__card">
              <div className="ptp-proposal__title">{intent.trim()}</div>
              <div className="ptp-proposal__why">
                Scoped to <b>{project.name}</b>. Inherits the project's folder and
                cascading instructions below — adjust the intent or context, then
                confirm.
              </div>
            </div>

            <div className="ptp-facts">
              <div className="ptp-fact">
                <div className="k">Project</div>
                <div className="v">{project.name}<span className="inferred">scope</span></div>
              </div>
              <div className="ptp-fact">
                <div className="k">Folder</div>
                <div className="v">
                  {primaryFolder
                    ? <><span className="mono">{primaryFolder}</span><span className="inferred">from project</span></>
                    : <span className="ptp-empty ptp-empty--inline">none bound</span>}
                </div>
              </div>
              <div className="ptp-fact">
                <div className="k">Who</div>
                <div className="v">TypeBuild agent<span className="inferred">inferred</span></div>
              </div>
              <div className="ptp-fact">
                <div className="k">When</div>
                <div className="v">On demand<span className="inferred">default</span></div>
              </div>
            </div>

            {/* Inherited context — folder, the instruction cascade, the
                description lineage. One disclosure; open by default so the
                provenance is visible, collapsible to stay calm. */}
            <div className={'ptp-disc' + (contextOpen ? ' is-open' : '')}>
              <div
                className="ptp-disc__dt"
                role="button"
                tabIndex={0}
                onClick={() => setContextOpen((o) => !o)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setContextOpen((o) => !o); } }}
              >
                <span className="ptp-disc__tw">▸</span>
                Inherited context
                <span className="ptp-disc__hint">
                  {instructions ? `${instructions.total} instruction${instructions.total === 1 ? '' : 's'}` : ''}
                  {folders.length > 1 ? ` · ${folders.length} folders` : ''}
                </span>
              </div>
              <div className="ptp-disc__dc">
                {/* folders */}
                {folders.length > 1 && (
                  <div className="ptp-scope">
                    <div className="ptp-scope__gh"><span className="ptp-scope__pill">Folders</span></div>
                    <div className="ptp-folder ptp-folder--many">
                      {folders.map((f) => <span key={f}>{f}</span>)}
                    </div>
                  </div>
                )}

                {/* instruction cascade */}
                {instructions && instructions.total > 0 ? (
                  <>
                    {instructions.scopes.map((sc) => {
                      const rules = instructions.rules.filter((r) => r.scopeKind === sc.kind && r.scopeId === sc.id);
                      if (rules.length === 0) return null;
                      return (
                        <div key={`${sc.kind}:${sc.id}`} className={'ptp-scope ptp-scope--' + sc.kind}>
                          <div className="ptp-scope__gh">
                            <span className="ptp-scope__pill">{sc.kind}</span>
                            <span className="ptp-scope__nm">{sc.label}</span>
                            <span className="ptp-scope__gc">{rules.length} rule{rules.length === 1 ? '' : 's'}</span>
                          </div>
                          <div className="ptp-scope__card">
                            {rules.map((r, ri) => (
                              <div key={ri} className="ptp-rule">
                                <span className="ptp-rule__q" aria-hidden="true">“</span>
                                <span className="ptp-rule__t">{r.text}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    <div className="ptp-casc-summary">{instructions.summary}</div>
                  </>
                ) : (
                  <div className="ptp-empty">No instructions taught for this project yet.</div>
                )}

                {/* effective description lineage */}
                <div className="ptp-scope">
                  <div className="ptp-scope__gh"><span className="ptp-scope__pill">Description</span></div>
                  {desc && desc.segments.length > 0 ? (
                    <div className="ptp-desc">
                      {desc.segments.map((s) => (
                        <div key={s.projectId} className="ptp-desc__seg">
                          {!s.own && <span className="ptp-desc__from">inherited from {s.projectName}</span>}
                          {s.text}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="ptp-empty">No description yet.</div>
                  )}
                </div>
              </div>
            </div>

            {createError && <p className="ptp-panel__error" role="alert">{createError}</p>}

            <div className="ptp-footer">
              {created ? (
                <div className="ptp-flash" role="status">✓ Task created in {project.name}</div>
              ) : (
                <>
                  <button
                    type="button"
                    className="ptp-btn"
                    onClick={() => { setIntent(''); }}
                  >
                    ‹ Back
                  </button>
                  <div className="ptp-footer__spacer" />
                  <button type="button" className="ptp-btn" onClick={exit}>Cancel</button>
                  <button
                    type="button"
                    className="ptp-btn ptp-btn--primary"
                    onClick={() => void confirm()}
                    disabled={busy || !intent.trim() || !signedIn}
                    title={!signedIn ? 'Sign in to TypeBuild to create a task' : undefined}
                  >
                    {busy ? 'Creating…' : !signedIn ? 'Sign in to TypeBuild' : 'Create task'}
                    <span className="ptp-btn__kbd">⌘↵</span>
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
