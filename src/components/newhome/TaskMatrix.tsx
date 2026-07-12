// TaskMatrix — a "Level-2" matrix view for a CHAIN task (task-ecabeafa41e1 /
// task-2bcdd6c237bd).
//
// A chain = a thin parent container + one child task per STEP (children linked
// by parent_task_id, ordered by creation). This view renders:
//   - ROWS = runs (instances of the chain). One row per run-parent Task.
//   - COLUMNS = grouped BY STEP. Each step contributes its INPUT columns (its
//     `dataKeys`) then its OUTPUT columns (its `outputSchema`), under a numbered
//     step-group header (①②③ …) showing the step's title. Two header rows:
//     (1) group headers spanning each step's field columns; (2) field headers
//     naming each input/output field (a required output shows a small ✳).
//   - The FIRST column is the run identity: the run-parent's title + status chip.
//   - Each data cell shows the field's value or a fillable "—" when empty, with a
//     single hover popup (Enter value / Start step / Open run) per cell.
//
// PHI: input/output VALUES (dataValues, result payloads, titles) may carry
// patient data — render in memory only, never persist/log. Only field key/label
// DEFINITIONS are non-PHI.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { Task, TaskStatus } from '../../types';
import { fm } from '../../bridge';
import { getTask } from '../../tasks';
import { useTaskDataValues } from './useNewHomeData';
import { resultFields } from './taskSchema.mjs';
import { TemplateEditPanel } from './TemplateEditPanel';
import './TaskMatrix.css';

export interface TaskMatrixProps {
  chainTitle: string; // header title
  runs: Task[]; // run-parent tasks; one row each (>=1)
  childrenOf: (parentId: string) => Task[]; // ordered step-children (LIST rows) of a parent
  // task-57e1470fad6f — the TEMPLATE this group's runs came from, when known
  // (the server emits template_id on the row). Enables "Edit template" in the
  // header. Absent → the button is hidden (nothing to edit against). Chains have
  // no server update endpoint yet, so chain groups pass null (see the task).
  templateId?: string | null;
  onClose: () => void;
  onOpenTask: (taskId: string) => void; // open a task's detail
  onStartChild: (childId: string) => void; // start a step (caller already wraps feedback)
  // QA round 3 — a CANCELLED/FAILED run has no runnable step (every child is
  // terminal), which left the row with no action at all: no way to run it
  // again. onRetryRun routes to the composite retry (reopen → claim → launch,
  // useTaskActions().retry) the roster rows already use. Optional so older
  // call sites compile; absent → the ↻ affordance is simply not shown.
  onRetryRun?: (runId: string) => void;
  // task-1b3eeb1aae1f — OPTIMISTIC LAUNCH feedback for the matrix's ▶ Run / ▶
  // Start step. The caller routes onStartChild through the shared useStartAction
  // wrapper (RosterTable); these read that wrapper's per-child pending/error so a
  // clicked step shows an IMMEDIATE "Starting…" (disabled) and, on failure, a
  // visible reason — matching the row/parent affordances the roster already has.
  pendingFor?: (childId: string) => boolean;
  errorFor?: (childId: string) => string | null;
}

type OutputField = NonNullable<Task['outputSchema']>[number];
type PillKind = 'done' | 'progress' | 'queued' | 'needs' | 'failed';

// ── Status → pill mapping ────────────────────────────────────────────────
// Prefer the server rawStatus (richer) and fall back to the coarse local
// TaskStatus. Everything routes to one of the five roster pill kinds so both
// themes resolve via the shared --nh-* tokens.
function pillFor(status?: TaskStatus, rawStatus?: string): { kind: PillKind; label: string } {
  const raw = (rawStatus ?? '').toLowerCase();
  if (raw) {
    if (raw === 'done' || raw === 'completed' || raw === 'succeeded')
      return { kind: 'done', label: 'Done' };
    if (raw === 'in_progress' || raw === 'running' || raw === 'claimed')
      return { kind: 'progress', label: 'In Progress' };
    if (raw === 'failed' || raw === 'error') return { kind: 'failed', label: 'Failed' };
    if (raw === 'needs_review' || raw === 'blocked' || raw === 'asked' || raw === 'review')
      return { kind: 'needs', label: 'Needs You' };
    if (raw === 'cancelled' || raw === 'canceled')
      return { kind: 'queued', label: 'Cancelled' };
    if (raw === 'pending' || raw === 'queued' || raw === 'todo' || raw === 'deferred')
      return { kind: 'queued', label: 'Queued' };
  }
  switch (status) {
    case 'done':
      return { kind: 'done', label: 'Done' };
    case 'in_progress':
      return { kind: 'progress', label: 'In Progress' };
    case 'cancelled':
      return { kind: 'queued', label: 'Cancelled' };
    default:
      return { kind: 'queued', label: 'Queued' };
  }
}

// Layout-cleanup round 2: the lead column shows status as a colored ICON
// (tooltip + aria-label carry the word) instead of a text pill — one glyph
// per roster status kind, plus a distinct ⊘ for Cancelled (which shares the
// 'queued' color kind but must not read as "waiting").
function statusGlyph(kind: PillKind, label: string): string {
  if (label === 'Cancelled') return '⊘';
  switch (kind) {
    case 'done':
      return '✓';
    case 'progress':
      return '◐';
    case 'needs':
      return '!';
    case 'failed':
      return '✕';
    default:
      return '○';
  }
}

function StatusIcon({ status, rawStatus }: { status?: TaskStatus; rawStatus?: string }): JSX.Element {
  const { kind, label } = pillFor(status, rawStatus);
  return (
    <span
      className={`tm-status tm-status--${kind}${label === 'Cancelled' ? ' tm-status--cancelled' : ''}`}
      title={label}
      aria-label={label}
      role="img"
    >
      {statusGlyph(kind, label)}
    </span>
  );
}

// ①②③ … circled step markers; falls back to "(n)" past the circled range.
function stepMarker(index: number): string {
  return index < 20 ? String.fromCodePoint(0x2460 + index) : `(${index + 1})`;
}

// A step that won't run again (won't be the chain's next runnable step).
const TERMINAL_RAW = new Set(['done', 'completed', 'succeeded', 'cancelled', 'canceled', 'partial']);
// The run's NEXT runnable step = the first child (in chain order) that isn't
// terminal. Drives the row-level "▶ Run" action; null when the run is complete.
function firstRunnableChild(children: Task[]): Task | null {
  for (const c of children) {
    const raw = (c.rawStatus ?? '').toLowerCase();
    if (TERMINAL_RAW.has(raw)) continue;
    if (!raw && (c.status === 'done' || c.status === 'cancelled')) continue;
    return c;
  }
  return null;
}

// ── One data cell: single hover popup + inline edit for inputs ────────────
interface CellProps {
  io: 'in' | 'out';
  childId: string;
  fieldKey: string;
  siblingKeys: string[]; // full data bag keys, so a patch preserves siblings
  value?: string; // resolved (dataValues / result) value
  required?: boolean; // OUTPUT only — drives the "—✳" empty state
  onStart: () => void;
  onOpen: () => void;
  // task-1b3eeb1aae1f — a start for THIS child is in flight / last failed.
  startPending?: boolean;
  startError?: string | null;
}

function MatrixCell({
  io,
  childId,
  fieldKey,
  siblingKeys,
  value,
  required,
  onStart,
  onOpen,
  startPending,
  startError,
}: CellProps): JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [override, setOverride] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const display = override ?? value ?? '';
  const isEmpty = display === '';

  async function commit(next: string): Promise<void> {
    const trimmed = next.trim();
    setEditing(false);
    if (trimmed === (override ?? value ?? '')) return; // no change
    setSaving(true);
    setError(null);
    const res = await fm.typebuild.taskData.patch(childId, { [fieldKey]: trimmed }, [], siblingKeys);
    setSaving(false);
    if (res.ok) {
      setOverride(trimmed); // optimistic — show immediately
    } else {
      setError(res.error || 'save failed');
    }
  }

  return (
    <div
      className={`tm-cell${isEmpty && !editing ? ' tm-cell--empty' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
      }}
    >
      {editing ? (
        <InlineEditor initial={display} onCommit={commit} onCancel={() => setEditing(false)} />
      ) : (
        <span className={`tm-val${isEmpty ? ' tm-val--empty' : ''}`}>
          {isEmpty ? (io === 'out' && required ? '—✳' : '—') : display}
        </span>
      )}
      {saving && <span className="tm-cell-note">saving…</span>}
      {/* task-1b3eeb1aae1f — optimistic start feedback for the ▶ Start step
          action. `startPending` shows the instant the step is clicked (before
          any network); `startError` surfaces a launch failure so it never hangs
          silently. Kept distinct from the input-save error above. */}
      {startPending && <span className="tm-cell-note">starting…</span>}
      {(error || startError) && (
        <span className="tm-cell-error" title={error ?? startError ?? undefined}>
          {error ?? startError}
        </span>
      )}
      {hovered && !editing && (
        <div className="tm-menu" role="menu">
          {io === 'in' && (
            <button
              type="button"
              className="tm-menu-item"
              role="menuitem"
              onClick={() => {
                setError(null);
                setEditing(true);
              }}
            >
              ✎ Enter value
            </button>
          )}
          <button
            type="button"
            className="tm-menu-item"
            role="menuitem"
            onClick={onStart}
            disabled={startPending}
          >
            {startPending ? 'Starting…' : '▶ Start step'}
          </button>
          <button type="button" className="tm-menu-item" role="menuitem" onClick={onOpen}>
            ↗ Open run
          </button>
        </div>
      )}
    </div>
  );
}

function InlineEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [v, setV] = useState(initial);
  const committedRef = useRef(false);
  return (
    <input
      className="tm-input"
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (!committedRef.current) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          committedRef.current = true;
          onCommit(v);
        } else if (e.key === 'Escape') {
          committedRef.current = true;
          onCancel();
        }
      }}
    />
  );
}

export function TaskMatrix(props: TaskMatrixProps): JSX.Element {
  const { chainTitle, runs, childrenOf, templateId, onClose, onOpenTask, onStartChild } = props;
  // task-1b3eeb1aae1f — default the optimistic-feedback readers to inert
  // functions so the matrix renders unchanged when a caller doesn't wire them.
  const pendingFor = props.pendingFor ?? (() => false);
  const errorFor = props.errorFor ?? (() => null);

  // task-57e1470fad6f — "Edit template" opens the definition editor overlay.
  // Only offered when we know the template id (server emits template_id on the
  // row); chains don't have a server update endpoint yet, so callers pass null.
  const [editing, setEditing] = useState(false);

  // task-ecabeafa41e1 — a run's STEPS. A chain run has step-children; a SIMPLE
  // (non-chain) template run is CHILDLESS, so the run itself is the single
  // implicit step (its own dataKeys/outputSchema/result become the row's one
  // step-group). One helper so every steps/columns/cells path agrees.
  const stepsOf = useMemo(() => {
    return (parentId: string): Task[] => {
      const kids = childrenOf(parentId);
      if (kids.length > 0) return kids;
      const self = runs.find((r) => r.id === parentId);
      return self ? [self] : [];
    };
  }, [childrenOf, runs]);

  // Every step id across every run (primitive key so effects re-run only when
  // the SET of steps actually changes, not on each parent render). For a simple
  // template the "step" IS the run, so its own id joins the set.
  const idKey = useMemo(() => {
    const ids: string[] = [];
    for (const run of runs) for (const c of stepsOf(run.id)) ids.push(c.id);
    return Array.from(new Set(ids)).sort().join(',');
  }, [runs, stepsOf]);

  // DETAIL for every child (getTask): outputSchema / dataKeys / result / status.
  const [detail, setDetail] = useState<Map<string, Task>>(new Map());
  useEffect(() => {
    let cancelled = false;
    const ids = idKey ? idKey.split(',') : [];
    const missing = ids.filter((id) => !detail.has(id));
    if (missing.length === 0) return;
    void (async () => {
      const fetched: [string, Task][] = [];
      for (const id of missing) {
        try {
          const t = await getTask(id);
          if (t) fetched.push([id, t]);
        } catch {
          // Offline / no access — leave undetailed; columns fall back to list rows.
        }
      }
      if (cancelled || fetched.length === 0) return;
      setDetail((prev) => {
        const next = new Map(prev);
        for (const [id, t] of fetched) next.set(id, t);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // idKey encodes the child set; re-run only when it moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey]);

  // INPUT values (data bag) — lazy/bounded/cached; one call at top level.
  const dataRequests = useMemo(() => {
    const reqs: { taskId: string; keys: string[] }[] = [];
    for (const id of idKey ? idKey.split(',') : []) {
      const keys = detail.get(id)?.dataKeys ?? [];
      if (keys.length > 0) reqs.push({ taskId: id, keys });
    }
    return reqs;
  }, [idKey, detail]);
  const dataValues = useTaskDataValues(dataRequests);

  // COLUMNS come from the FIRST run's ordered steps (its step-children, or the
  // run itself when it's a childless simple-template run).
  const steps = runs[0] ? stepsOf(runs[0].id) : [];
  const stepGroups = useMemo(
    () =>
      steps.map((step, index) => {
        const d = detail.get(step.id);
        // Dotted subkeys (a pick's full-record snapshot — `.ref`, `.insurance`,
        // `.picked_at`, …) don't get a column each; the detail drawer lists
        // them. Mirrors rosterGroups.mjs's input-column rule.
        const inputs = (d?.dataKeys ?? []).filter((k) => !k.includes('.'));
        const outputs: OutputField[] = d?.outputSchema ?? [];
        return {
          index,
          title: d?.title ?? step.title,
          inputs,
          outputs,
          span: Math.max(1, inputs.length + outputs.length),
        };
      }),
    // steps is derived from runs[0]/childrenOf which are captured by idKey; detail
    // supplies the field defs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idKey, detail],
  );

  // Layout-cleanup (QA round): a SINGLE-step matrix (every simple-template
  // group, plus one-step chains whose step just repeats the panel title) gets
  // no step-group header row — the panel header already names the template, so
  // "① <same name>" was pure noise. Multi-step chains keep the numbered bands.
  const showGroupHeader =
    stepGroups.length > 1 ||
    (stepGroups.length === 1 && stepGroups[0].title !== chainTitle && runs.some((r) => childrenOf(r.id).length > 0));

  const inputValue = (childId: string, key: string): string | undefined =>
    dataValues.get(childId)?.[key];
  const outputValue = (childId: string, key: string): string | undefined => {
    const parsed = resultFields(detail.get(childId)?.result);
    const raw = parsed?.fields?.[key];
    return raw == null ? undefined : String(raw);
  };

  return (
    <div className="tm">
      <div className="tm-header">
        <button type="button" className="tm-back" onClick={onClose}>
          ← Back
        </button>
        <div className="tm-heading">
          <div className="tm-title">{chainTitle}</div>
          <div className="tm-subtitle">
            {runs.length} {runs.length === 1 ? 'run' : 'runs'}
          </div>
        </div>
        {/* task-57e1470fad6f — edit the template DEFINITION (rename, fields,
            body). Only when the template id is known; chains hidden until the
            server chain-update endpoint ships (task-a19115192233). */}
        {templateId && (
          <button
            type="button"
            className="tm-edit-tmpl"
            onClick={() => setEditing(true)}
            title="Edit this template's definition (does not change existing runs)"
          >
            ✎ Edit template
          </button>
        )}
      </div>

      {editing && templateId && (
        <TemplateEditPanel templateId={templateId} onClose={() => setEditing(false)} />
      )}

      <div className="tm-scroll">
        <table className="tm-table">
          <thead>
            {/* Group header: each step title spans its field columns. Skipped
                for single-step matrices — the panel header already names it. */}
            {showGroupHeader && (
              <tr className="tm-group-row">
                <th className="tm-lead-th" rowSpan={2}>
                  Run
                </th>
                {stepGroups.map((g) => (
                  <th
                    key={`g${g.index}`}
                    className={`tm-group-th${g.index % 2 ? ' tm-band' : ''}`}
                    colSpan={g.span}
                  >
                    <span className="tm-group-marker">{stepMarker(g.index)}</span>
                    <span className="tm-group-name">{g.title}</span>
                  </th>
                ))}
              </tr>
            )}
            {/* Field header: input keys (IN) then output fields (OUT + ✳). */}
            <tr className="tm-field-row">
              {!showGroupHeader && <th className="tm-lead-th">Run</th>}
              {stepGroups.map((g) => {
                // task-dc5ad168cd3a — mild per-step-group banding: alternating
                // groups carry a --surface-band tint so each step's columns read
                // as one group. Applied on BOTH header rows and the data cells.
                const band = g.index % 2 ? ' tm-band' : '';
                if (g.inputs.length + g.outputs.length === 0) {
                  return (
                    <th key={`fe${g.index}`} className={`tm-field-th tm-field-th--empty${band}`}>
                      —
                    </th>
                  );
                }
                return [
                  ...g.inputs.map((key) => (
                    <th key={`fi${g.index}-${key}`} className={`tm-field-th${band}`}>
                      <span className="tm-io tm-io--in">IN</span>
                      <span className="tm-field-label">{key}</span>
                    </th>
                  )),
                  ...g.outputs.map((o) => (
                    <th key={`fo${g.index}-${o.key}`} className={`tm-field-th${band}`}>
                      <span className="tm-io tm-io--out">OUT</span>
                      <span className="tm-field-label">{o.label || o.key}</span>
                      {o.required && (
                        <span className="tm-req" title="required output">
                          ✳
                        </span>
                      )}
                    </th>
                  )),
                ];
              })}
            </tr>
          </thead>
          <tbody>
            {runs.map((run, runIndex) => {
              const rowChildren = stepsOf(run.id);
              // Layout-cleanup (QA round): every run of a template shares the
              // template's name, so repeating the title per row said nothing.
              // Identify a run by its NUMBER; a custom title (differs from the
              // panel title) is real information and still shows.
              const runLabel =
                run.title && run.title.trim() && run.title.trim() !== chainTitle.trim()
                  ? run.title
                  : `Run ${runIndex + 1}`;
              return (
                <tr key={run.id}>
                  <td className="tm-lead-td">
                    {(() => {
                      // Layout-cleanup round 2: ONE line per run — colored
                      // status icon + "Run N" + compact icon actions. The
                      // status word rides the icon's tooltip; '✓ Complete' is
                      // simply the done icon now, not a separate note. Errors
                      // (the only thing worth a second line) drop below.
                      const next = firstRunnableChild(rowChildren);
                      // QA round 3 — a run whose steps are all terminal but
                      // that ISN'T done (cancelled/failed) gets ↻ Retry
                      // (reopen → claim → launch) so it's never action-less.
                      const p = pillFor(run.status, run.rawStatus);
                      const retryable =
                        !next && props.onRetryRun && (p.label === 'Cancelled' || p.kind === 'failed');
                      // task-1b3eeb1aae1f — the row's ▶ targets the run's NEXT
                      // runnable step; its pending/error drive the immediate
                      // "starting" state and the visible failure line. A ↻
                      // retry is keyed on the RUN itself.
                      const pending = next ? pendingFor(next.id) : retryable ? pendingFor(run.id) : false;
                      const err = next ? errorFor(next.id) : retryable ? errorFor(run.id) : null;
                      return (
                        <>
                          <div className="tm-lead-inner">
                            <StatusIcon status={run.status} rawStatus={run.rawStatus} />
                            <span className="tm-run-title">{runLabel}</span>
                            <span className="tm-lead-actions">
                              {next && (
                                <button
                                  type="button"
                                  className="tm-icon-btn tm-icon-btn--run"
                                  title={pending ? 'Starting…' : 'Run the next step of this run'}
                                  aria-label="Run"
                                  onClick={() => onStartChild(next.id)}
                                  disabled={pending}
                                >
                                  {pending ? '…' : '▶'}
                                </button>
                              )}
                              {retryable && (
                                <button
                                  type="button"
                                  className="tm-icon-btn tm-icon-btn--retry"
                                  title={
                                    pending
                                      ? 'Retrying…'
                                      : `${p.label} — Retry will reopen and run this again`
                                  }
                                  aria-label="Retry"
                                  onClick={() => props.onRetryRun?.(run.id)}
                                  disabled={pending}
                                >
                                  {pending ? '…' : '↻'}
                                </button>
                              )}
                              <button
                                type="button"
                                className="tm-icon-btn tm-icon-btn--open"
                                title="Open this run"
                                aria-label="Open"
                                onClick={() => onOpenTask(run.id)}
                              >
                                ↗
                              </button>
                            </span>
                          </div>
                          {err && (
                            <div className="tm-run-error" title={err}>
                              ⚠ {err}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </td>
                  {stepGroups.map((g) => {
                    // task-dc5ad168cd3a — same alternating band as the headers so
                    // a step's data cells read as one group with its column titles.
                    const band = g.index % 2 ? ' tm-band' : '';
                    const child = rowChildren[g.index];
                    if (!child) {
                      // This run has no child for this step — hatch the whole group.
                      return (
                        <td
                          key={`na${g.index}`}
                          className={`tm-cell-td tm-cell-td--na${band}`}
                          colSpan={g.span}
                        >
                          <span className="tm-na">n/a</span>
                        </td>
                      );
                    }
                    const childDetail = detail.get(child.id);
                    const sibling = childDetail?.dataKeys ?? [];
                    const cells: JSX.Element[] = [];
                    for (const key of g.inputs) {
                      cells.push(
                        <td key={`ci${g.index}-${key}`} className={`tm-cell-td tm-cell-td--in${band}`}>
                          <MatrixCell
                            io="in"
                            childId={child.id}
                            fieldKey={key}
                            siblingKeys={sibling}
                            value={inputValue(child.id, key)}
                            onStart={() => onStartChild(child.id)}
                            onOpen={() => onOpenTask(child.id)}
                            startPending={pendingFor(child.id)}
                            startError={errorFor(child.id)}
                          />
                        </td>,
                      );
                    }
                    for (const o of g.outputs) {
                      cells.push(
                        <td key={`co${g.index}-${o.key}`} className={`tm-cell-td tm-cell-td--out${band}`}>
                          <MatrixCell
                            io="out"
                            childId={child.id}
                            fieldKey={o.key}
                            siblingKeys={sibling}
                            value={outputValue(child.id, o.key)}
                            required={o.required}
                            onStart={() => onStartChild(child.id)}
                            onOpen={() => onOpenTask(child.id)}
                            startPending={pendingFor(child.id)}
                            startError={errorFor(child.id)}
                          />
                        </td>,
                      );
                    }
                    if (cells.length === 0) {
                      // Step with no declared fields yet — a single placeholder cell
                      // that still carries the step's status + hover actions.
                      const p = pillFor(childDetail?.status ?? child.status, childDetail?.rawStatus ?? child.rawStatus);
                      cells.push(
                        <td key={`cp${g.index}`} className={`tm-cell-td${band}`}>
                          <div className="tm-cell tm-cell--placeholder">
                            <span className={`tm-pill tm-pill--${p.kind}`}>{p.label}</span>
                          </div>
                        </td>,
                      );
                    }
                    return cells;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
