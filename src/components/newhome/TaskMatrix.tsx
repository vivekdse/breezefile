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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { JSX } from 'react';
import type { Task, TaskStatus } from '../../types';
import { fm } from '../../bridge';
import { getTask, useOriginHealth } from '../../tasks';
import { useTaskDataValues } from './useNewHomeData';
import { resultFields } from './taskSchema.mjs';
import { pillForStatus } from './rosterGroups.mjs';
import type { StatusBucket } from './rosterGroups.mjs';
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

// Bounded fan-out for the per-step getTask wave. Matches useNewHomeData's
// TASK_DATA_CONCURRENCY — same origin, same reason to not stampede it.
const DETAIL_CONCURRENCY = 4;

type OutputField = NonNullable<Task['outputSchema']>[number];
// task-ea465f2c5964 — PillKind IS the shared StatusBucket axis (rosterGroups.mjs
// / useNewHomeData.ts); no longer a fourth hand-maintained enum of the same
// seven values.
type PillKind = StatusBucket;
// The schedule-bearing slice of a Task — enough to tell 'scheduled' from 'open'.
type Schedulable = Pick<Task, 'cron' | 'next_run_at'>;

// task-run-order — a run's created stamp, as "5 minutes ago", so a reviewer
// knows when a run happened (and thus when it's worth reviewing) instead of a
// meaningless "Run N" alone. Returns '' when we have no usable stamp.
function relativeTime(createdAt: number | undefined, now: number): string {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) return '';
  const secs = Math.round((now - createdAt) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.round(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

// ── Status → pill mapping ────────────────────────────────────────────────
// task-ea465f2c5964 — this used to be a full THIRD re-implementation of the
// same raw-status ladder rosterGroups.statusBucket and useNewHomeData's
// deriveStatus already encoded (the copy that shipped the task-c0edffef25c6
// cancelled-vs-waiting bug the longest, since it was the last of the three to
// get the fix). It now DELEGATES entirely to rosterGroups.pillForStatus — the
// one exported {kind,label} mapper — which prefers the server rawStatus's
// full vocabulary and falls back to the coarser local TaskStatus exactly the
// way this function used to inline.
function pillFor(
  status?: TaskStatus,
  rawStatus?: string,
  sched?: Schedulable | null,
): { kind: PillKind; label: string } {
  return pillForStatus(status, rawStatus, sched);
}

// Layout-cleanup round 2: the lead column shows status as a colored ICON
// (tooltip + aria-label carry the word) instead of a text pill — one glyph per
// roster status kind. Cancelled's ⊘ now rides its own kind rather than a label
// special-case, so the glyph and the color agree.
function statusGlyph(kind: PillKind): string {
  switch (kind) {
    case 'done':
      return '✓';
    case 'progress':
      return '◐';
    case 'needs':
      return '!';
    case 'failed':
      return '✕';
    case 'cancelled':
      return '⊘';
    case 'scheduled':
      return '◷';
    default:
      return '○';
  }
}

function StatusIcon({ task }: { task: Task }): JSX.Element {
  const { kind, label } = pillFor(task.status, task.rawStatus, task);
  return (
    <span className={`tm-status tm-status--${kind}`} title={label} aria-label={label} role="img">
      {statusGlyph(kind)}
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
  // This value is still in flight. `value === undefined` alone can't say
  // whether the field is empty or unfetched, and rendering '—' for the latter
  // claims "no value" about something we simply haven't heard back on yet.
  loading?: boolean;
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
  loading,
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
  // task-hover-menu — the menu is portaled to <body> so it can't be clipped by
  // the scroll container or slip under the sticky column. We keep it open while
  // the cursor is over the cell OR the menu, with a short grace period so
  // crossing between them never flickers it shut. `menuPos` is the fixed-
  // viewport rect we anchor to; recomputed on open (and on scroll while open).
  const cellRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; drop: boolean } | null>(null);

  const openMenu = (): void => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setHovered(true);
  };
  const scheduleClose = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHovered(false), 120);
  };
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const menuOpen = hovered && !editing;

  // Position the portaled menu from the cell's viewport rect. Prefer dropping
  // BELOW; flip ABOVE when there isn't room (the last-row case). Recompute while
  // open in case the matrix scrolls under it.
  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuPos(null);
      return;
    }
    const place = (): void => {
      const el = cellRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const menuH = menuRef.current?.offsetHeight ?? 120;
      const spaceBelow = window.innerHeight - r.bottom;
      const drop = spaceBelow >= menuH + 8 || spaceBelow >= r.top;
      setMenuPos({
        top: drop ? r.bottom + 4 : r.top - 4 - menuH,
        left: r.left,
        drop,
      });
    };
    place();
    // Re-place after the menu has measured its real height, then on scroll.
    const raf = requestAnimationFrame(place);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [menuOpen]);

  const display = override ?? value ?? '';
  const isEmpty = display === '';
  // A locally-committed override, or a value that's already landed, outranks
  // the loading flag — we know what this cell says regardless of the wave.
  const isLoading = !!loading && override === null && value === undefined && !editing;

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
      ref={cellRef}
      className={`tm-cell${isLoading ? ' tm-cell--loading' : ''}${
        isEmpty && !editing && !isLoading ? ' tm-cell--empty' : ''
      }`}
      onMouseEnter={openMenu}
      onMouseLeave={scheduleClose}
    >
      {editing ? (
        <InlineEditor initial={display} onCommit={commit} onCancel={() => setEditing(false)} />
      ) : isLoading ? (
        <span className="tm-skel-bar tm-skel-bar--cell" aria-label="Loading value" role="img" />
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
      {menuOpen &&
        createPortal(
          <div
            ref={menuRef}
            className={`tm-menu${menuPos && !menuPos.drop ? ' tm-menu--up' : ''}`}
            role="menu"
            style={{
              // Hidden (off-screen) for the first frame until we've measured a
              // real position, so it never flashes at 0,0.
              top: menuPos ? menuPos.top : -9999,
              left: menuPos ? menuPos.left : -9999,
              visibility: menuPos ? 'visible' : 'hidden',
            }}
            onMouseEnter={openMenu}
            onMouseLeave={scheduleClose}
          >
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
          </div>,
          document.body,
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

  // task-run-order — the caller hands runs oldest-first. Show them NEWEST-first
  // (latest run to review is at the top), but keep each run's "Run N" number
  // stable in CHRONOLOGICAL order (Run 1 = the first run ever), so a run's
  // number never shifts as new runs arrive. We also stamp each with a relative
  // time for the left column.
  //   `now` ticks once a minute so "5 minutes ago" stays honest without a
  //   per-render churn.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const orderedRuns = useMemo(() => {
    // Chronological index (oldest = 1), assigned before reversing for display.
    const chrono = [...runs].sort(
      (a, b) => (a.created_at ?? 0) - (b.created_at ?? 0),
    );
    const numberOf = new Map<string, number>();
    chrono.forEach((r, i) => numberOf.set(r.id, i + 1));
    // Display newest-first.
    return [...chrono].reverse().map((run) => ({
      run,
      runNumber: numberOf.get(run.id) ?? 0,
    }));
  }, [runs]);

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
  // Ids whose detail fetch has SETTLED — resolved or failed. `detail` alone
  // can't answer "is this still loading?": a 404/offline id never lands there,
  // so gating on `detail.has(id)` would skeleton forever. This is the honest
  // "we asked and heard back" set, and it's what every loading check reads.
  const [detailSettled, setDetailSettled] = useState<Set<string>>(new Set());
  // task-24cd55d8a607 — defer this matrix enrichment wave while the origin
  // breaker is open; already-fetched details persist so the matrix keeps
  // rendering last-known cells.
  const { degraded } = useOriginHealth();
  useEffect(() => {
    let cancelled = false;
    if (degraded) return; // origin slow — defer matrix child-detail enrichment
    const ids = idKey ? idKey.split(',') : [];
    const missing = ids.filter((id) => !detailSettled.has(id));
    if (missing.length === 0) return;
    void (async () => {
      // Fan out over a bounded worker pool rather than awaiting each getTask in
      // turn: the columns can't render until the LAST of these lands, so a
      // serial loop made the whole schema wait on the sum of every round-trip.
      // Same shape/limit as useTaskDataValues' resolve pool.
      //
      // task-06b39e952c4e — STREAM each result into state as it lands instead
      // of batching every worker's output behind one Promise.all and a single
      // setDetail/setDetailSettled at the very end. Batching meant the
      // dataRequests memo (built from `detail`) — and thus the value fan-out —
      // couldn't start for step A's fields even once step A's getTask resolved,
      // if step D's getTask (same wave) was still in flight. Streaming lets
      // useTaskDataValues begin resolving a step's inputs the instant that
      // step's detail settles, so the detail→dataRequests barrier only holds
      // per-task, not for the whole matrix.
      let idx = 0;
      async function worker(): Promise<void> {
        while (idx < missing.length) {
          const id = missing[idx++];
          try {
            const t = await getTask(id);
            if (cancelled) return;
            if (t) {
              setDetail((prev) => {
                const next = new Map(prev);
                next.set(id, t);
                return next;
              });
            }
          } catch {
            // Offline / no access — leave undetailed; columns fall back to list rows.
          }
          if (cancelled) return;
          // Every id we asked about is settled the moment ITS OWN fetch
          // returns, including a throw — otherwise a permanently-failing id
          // would hold the skeleton open. Marking it per-id (not after the
          // whole wave) is what lets schemaReady/dataRequests progress
          // per-step instead of waiting on the slowest sibling.
          setDetailSettled((prev) => {
            if (prev.has(id)) return prev;
            const next = new Set(prev);
            next.add(id);
            return next;
          });
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(DETAIL_CONCURRENCY, missing.length) }, () => worker()),
      );
    })();
    return () => {
      cancelled = true;
    };
    // idKey encodes the child set; re-run when it moves OR when the origin
    // breaker clears so a deferred fetch resumes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey, degraded]);

  // INPUT values (data bag) — lazy/bounded/cached; one call at top level.
  const dataRequests = useMemo(() => {
    const reqs: { taskId: string; keys: string[] }[] = [];
    for (const id of idKey ? idKey.split(',') : []) {
      const keys = detail.get(id)?.dataKeys ?? [];
      if (keys.length > 0) reqs.push({ taskId: id, keys });
    }
    return reqs;
  }, [idKey, detail]);
  // `values` is the resolved bag (empty/absent refs are dropped from it, so it
  // can't double as a loading signal); `isPending` is the hook's own explicit
  // per-(taskId,key) in-flight answer, and already reports `false` for pairs it
  // has deferred behind the origin breaker (task-24cd55d8a607).
  const { values: dataValues, isPending: inputPending } = useTaskDataValues(dataRequests);

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

  // The matrix's data lands in two serial waves — the per-step detail (which
  // DEFINES the columns) and then the per-key values that fill them. Rendering
  // between them made the user watch the table change SHAPE twice: first a lone
  // Run column, then every field column popping in empty, then the widths
  // re-measuring as values arrived. Instead we hold the final shape back until
  // the column schema is known and say, plainly, that it's loading; the widths
  // are then pinned (table-layout: fixed + colgroup) so wave two can only fill
  // cells, never move them.
  //
  // The schema comes from the FIRST run's steps, so those are the ids that
  // gate. `detailSettled` (not `detail`) is the test, so a step whose fetch
  // failed resolves to "known, no fields" instead of an eternal skeleton — and
  // a matrix with no runs at all has nothing to wait for and renders empty.
  const schemaReady = steps.every((s) => detailSettled.has(s.id));
  // While the origin breaker is open both waves are deliberately deferred
  // (task-24cd55d8a607), so nothing is in flight and nothing will land. Saying
  // "loading" then would be a spinner that never resolves: report the defer
  // instead, and let already-fetched cells render as last-known rather than
  // shimmering.
  const deferred = degraded && !schemaReady;

  // A cell is LOADING when its value is still in flight — distinct from known-
  // absent, which is the '—' the cell has always shown. An unsettled step means
  // we don't even know its fields yet; a settled one means only the pairs we
  // requested and haven't heard back on are pending.
  const inputLoading = (childId: string, key: string): boolean => {
    if (degraded) return false;
    if (!detailSettled.has(childId)) return true;
    return inputPending(childId, key);
  };
  // Outputs ride the step's own detail (`result`), so they're pending exactly
  // while that detail is.
  const outputLoading = (childId: string): boolean => !degraded && !detailSettled.has(childId);
  const inputValue = (childId: string, key: string): string | undefined =>
    dataValues.get(childId)?.[key];
  const outputValue = (childId: string, key: string): string | undefined => {
    const parsed = resultFields(detail.get(childId)?.result);
    const raw = parsed?.fields?.[key];
    return raw == null ? undefined : String(raw);
  };

  // One <col> per rendered column, matching the header's colSpan arithmetic: a
  // fieldless step still renders its single "—" column, which is why both use
  // g.span. See TaskMatrix.css — the widths live there, and they're what makes
  // table-layout: fixed hold the columns still across the value wave.
  const colGroup = (
    <colgroup>
      <col className="tm-col-lead" />
      {stepGroups.flatMap((g) =>
        Array.from({ length: g.span }, (_, i) => (
          <col key={`c${g.index}-${i}`} className="tm-col-field" />
        )),
      )}
    </colgroup>
  );

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

      {/* The header above renders immediately and never moves; only this region
          waits. */}
      {!schemaReady ? (
        <div className="tm-scroll">
          {deferred ? (
            <div className="tm-notice" role="status">
              ⏳ The task service is slow right now — this matrix will fill in as soon as it
              responds.
            </div>
          ) : (
            <div className="tm-skel" role="status" aria-live="polite" aria-busy="true">
              {/* The Run column is already known (runs come in as props), so the
                  skeleton shows the real run identities and shimmers only what
                  we're actually still waiting on: the step columns. */}
              <div className="tm-skel-row tm-skel-row--head">
                <span className="tm-skel-lead">Run</span>
                <span className="tm-skel-bar" />
                <span className="tm-skel-bar" />
                <span className="tm-skel-bar" />
              </div>
              {orderedRuns.slice(0, 6).map(({ run, runNumber }) => (
                <div className="tm-skel-row" key={run.id}>
                  <span className="tm-skel-lead">
                    <StatusIcon task={run} />
                    Run {runNumber}
                  </span>
                  <span className="tm-skel-bar" />
                  <span className="tm-skel-bar" />
                  <span className="tm-skel-bar" />
                </div>
              ))}
              <div className="tm-skel-note">Loading run data…</div>
            </div>
          )}
        </div>
      ) : (
      <div className="tm-scroll">
        <table className="tm-table">
          {colGroup}
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
            {orderedRuns.map(({ run, runNumber }) => {
              const rowChildren = stepsOf(run.id);
              // Layout-cleanup (QA round): every run of a template shares the
              // template's name, so repeating the title per row said nothing.
              // Identify a run by its NUMBER; a custom title (differs from the
              // panel title) is real information and still shows.
              const runLabel =
                run.title && run.title.trim() && run.title.trim() !== chainTitle.trim()
                  ? run.title
                  : `Run ${runNumber}`;
              // task-run-order — when this run ran, so a reviewer knows what's
              // fresh. Sits under the run label as a muted second line.
              const runWhen = relativeTime(run.created_at, now);
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
                      const p = pillFor(run.status, run.rawStatus, run);
                      const retryable =
                        !next && props.onRetryRun && (p.kind === 'cancelled' || p.kind === 'failed');
                      // task-reenter — a DONE/PARTIAL run has no runnable next
                      // step and isn't retryable, so it used to offer only
                      // "↗ Open". Give it a launch-first ▶ that re-opens the
                      // operator on the run itself (inspect / ask / edit the
                      // result) WITHOUT disturbing its terminal status — the
                      // same play button the roster rows now show for a
                      // finished task.
                      const rs = run.rawStatus;
                      const isTerminalRun =
                        run.status === 'done' ||
                        run.status === 'cancelled' ||
                        rs === 'done' ||
                        rs === 'partial' ||
                        rs === 'cancelled';
                      const canReenter = isTerminalRun && !next && !retryable;
                      // task-1b3eeb1aae1f — the row's ▶ targets the run's NEXT
                      // runnable step; its pending/error drive the immediate
                      // "starting" state and the visible failure line. A ↻
                      // retry (and the re-entry ▶) are keyed on the RUN itself.
                      const runKeyed = retryable || canReenter;
                      const pending = next ? pendingFor(next.id) : runKeyed ? pendingFor(run.id) : false;
                      const err = next ? errorFor(next.id) : runKeyed ? errorFor(run.id) : null;
                      return (
                        <>
                          <div className="tm-lead-inner">
                            <StatusIcon task={run} />
                            <span className="tm-run-id">
                              <span className="tm-run-title">{runLabel}</span>
                              {runWhen && <span className="tm-run-when">{runWhen}</span>}
                            </span>
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
                              {canReenter && (
                                <button
                                  type="button"
                                  className="tm-icon-btn tm-icon-btn--run"
                                  title={
                                    pending
                                      ? 'Opening…'
                                      : 'Open the operator — inspect, ask, or edit the result'
                                  }
                                  aria-label="Open operator"
                                  onClick={() => onStartChild(run.id)}
                                  disabled={pending}
                                >
                                  {pending ? '…' : '▶'}
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
                            loading={inputLoading(child.id, key)}
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
                            loading={outputLoading(child.id)}
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
                      const p = pillFor(
                        childDetail?.status ?? child.status,
                        childDetail?.rawStatus ?? child.rawStatus,
                        childDetail ?? child,
                      );
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
      )}
    </div>
  );
}
