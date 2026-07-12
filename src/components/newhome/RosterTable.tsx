// task-cc9a4ef6f38a — RosterTable: the Project View table (spec §1) + the
// escalation layer on top of it (spec §7). Renders the tasks NewHomePage
// already scoped/filtered by project + status.
//
// UNIFIED ROSTER (2026-07-05 redesign): ONE table renders every kind of work
// with the SAME columns — Title · Status · Last Run · Who · Runs · Actions:
//   • a TEMPLATE GROUP row (rosterGroups.mjs) aggregates a template's run
//     instances: Status shows a per-bucket breakdown ("3 done · 2 queued"),
//     Runs = instance count, Actions = View → (Level-2 matrix) / ▶ Run all /
//     + New run.
//   • a CHAINED row (a v2-chained job OR a thin parent container with step
//     children) aggregates its STEPS the same way: Status breakdown over the
//     children, Runs = step count, Actions = View → / ▶ Run all /
//     Auto-continue. The old inline per-step subtable is gone — step detail
//     lives in the Level-2 matrix (View →); the auto-continue + chain-parent
//     resolution machinery it carried survives in the headless
//     <ChainAutomation> below.
//   • a PLAIN task row: single status pill, Runs = 1, the usual primary
//     action (Answer/Retry/▶ Start/View →). A DONE/FAILED row shows its
//     one-line outcome under the title (the old OutcomesPanel, folded in).
// Every row also gets a ⋮ actions menu listing all its applicable actions.
//
// The status filter lives ONLY on the HeroStats cards now (the old pill bar
// duplicated them and was removed); the toolbar keeps the search/query box.
//
// PHI: `title`, `lastAction`, `customValues` values, `risk`, and outcome
// summaries may carry task text — render in memory only, never persist/log
// (see docs/typebuild-data-field-contract.md).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { NewHomeStatus, NewHomeTask } from './types';
import type { Task } from '../../types';
import { claimFreshness } from '../tasks/lifecycle.mjs';
import { resultFields, taskDefStatus } from './taskSchema.mjs';
import {
  nextAutoContinueChildId,
  chainStartTarget,
  thinChainStartTarget,
  childStatusMap,
  fieldedSchemaSource,
} from './pipelineRoster.mjs';
import { isAutoContinueOn, setAutoContinue } from './chainAutoContinuePrefs';
import {
  buildChainAggregateResult,
  parentStatusFromChildren,
  shouldResolveParent,
} from './chainParentResolve.mjs';
import type { ChildStatusLike } from './pipelineRoster.mjs';
import { buildRosterGroups, summarizeGroupRows, statusBucket, STATUS_BUCKETS } from './rosterGroups.mjs';
import type {
  RosterGroup,
  RosterGroupInput,
  GroupSummary,
  StatusBucket,
} from './rosterGroups.mjs';
import { useChainedRoster } from './useNewHomeData';
import { TaskMatrix } from './TaskMatrix';
import type { ChainedJobResolution } from './useNewHomeData';
// task — the "▶ Start" row action reuses the OLD Tasks page's exact launch
// path: primaryActionFor (the single source of truth for which primary action a
// row offers) decides eligibility, and useTaskActions().start (→ runTaskNow) is
// the same claim-then-launch IPC the old play button fires. No new launch path.
import { getTask, taskSourceAction, useTasks, useTypebuildReadiness } from '../../tasks';
import { useTaskActions } from '../tasks/useTaskActions';
import type { StartOutcome } from '../tasks/useTaskActions';
import { useStartAction } from '../tasks/useStartAction';
import { useRunningSessions } from '../tasks/useRunningSessions';
import { primaryActionFor } from '../tasks/primaryAction.mjs';
import { isDone } from '../tasks/sections.mjs';
import { normalizeTablePayload, coerceCell } from '../tasks/taskResult.mjs';
import './RosterTable.css';

const WHO_GLYPH: Record<NewHomeTask['who'], string> = {
  agent: '\u{1F916}', // 🤖
  human: '\u{1F464}', // 👤
  both: '\u{1F916}+\u{1F464}', // 🤖+👤
};

const STATUS_LABEL: Record<NewHomeStatus, string> = {
  done: 'Done',
  progress: 'In Progress',
  queued: 'Queued',
  needs: 'Needs You',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_SUMMARY_LABEL: Record<StatusBucket, string> = {
  done: 'done',
  progress: 'in progress',
  queued: 'queued',
  needs: 'needs you',
  failed: 'failed',
  cancelled: 'cancelled',
};

const BASE_COLUMN_COUNT = 6; // Title, Status, Last Run, Who, Runs, Actions

/** task-6c62e6f0905e — tooltip for the live pulse: "Agent active · claim
 *  renewed 12m ago" when we have a claim timestamp to describe (the common
 *  case for a 'progress' row); a generic fallback when we don't (e.g. a
 *  locally-open session whose row hasn't picked up claimedAt yet). Reuses the
 *  SAME claim-freshness math the task-detail claim badge already uses
 *  (src/components/tasks/lifecycle.mjs) rather than re-deriving relative time. */
function liveTooltip(task: NewHomeTask): string {
  const fresh = claimFreshness(task.raw.claimedAt ?? null);
  return fresh ? `Agent active · claim renewed ${fresh.relative}` : 'Agent active';
}

/** Aggregate status cell — one small pill per non-zero bucket ("3 done ·
 *  2 queued"). Used for any row that summarizes several tasks (a template
 *  group's runs, a chained row's steps). */
function StatusBreakdown({ counts }: { counts: Record<StatusBucket, number> }) {
  const active = STATUS_BUCKETS.filter((b) => counts[b] > 0);
  if (active.length === 0) return <span className="nh-roster__action-empty">—</span>;
  return (
    <span className="nh-roster__breakdown">
      {active.map((b) => (
        <span
          key={b}
          className={`nh-roster__pill nh-roster__pill--${b}`}
          title={`${counts[b]} ${STATUS_SUMMARY_LABEL[b]}`}
        >
          {counts[b]} {STATUS_SUMMARY_LABEL[b]}
        </span>
      ))}
    </span>
  );
}

// ─── ⋮ actions menu ─────────────────────────────────────────────────────────
// Every unified row carries one: the full list of the row's applicable actions
// (View / ▶ Run all / + New run / ↗ Open / Auto-continue), so the primary
// button never has to cram in secondary verbs.
type MenuItem =
  | { label: string; onClick: () => void; disabled?: boolean; title?: string }
  | { label: string; checkbox: true; checked: boolean; onToggle: () => void; title?: string };

function ActionsMenu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  if (items.length === 0) return null;
  return (
    <span className="nh-roster__menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="nh-roster__menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title="Actions"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⋮
      </button>
      {open && (
        <div className="nh-roster__menu" role="menu" onClick={(e) => e.stopPropagation()}>
          {items.map((it, i) =>
            'checkbox' in it ? (
              <label key={i} className="nh-roster__menu-item nh-roster__menu-item--check" title={it.title}>
                <input type="checkbox" checked={it.checked} onChange={it.onToggle} />
                {it.label}
              </label>
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                className="nh-roster__menu-item"
                disabled={it.disabled}
                title={it.title}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </span>
  );
}

// ─── outcome one-liner (the old OutcomesPanel, folded into the table) ───────

/** One-line best-effort outcome summary for a finished row: prefer a
 *  structured `table` result (first row's cells, joined), then a
 *  `{type:'fields'}` result labeled via the output schema, then the task's
 *  last-action text. Same extraction TaskDetailDialog/TaskDetailDrawer use —
 *  the two surfaces never drift on "what counts as the outcome".
 *  PHI: the returned string may carry task content — render only. */
function summarizeOutcome(task: NewHomeTask, detailTask: Task | null | undefined): string {
  // The LIST row never carries `result` (mapListRow gap — same as the
  // outputSchema gap task-6b1136a8ff77 fixed for labels): the fetched DETAIL
  // is the source of truth for the payload, with the raw row as a fallback
  // for a source that does inline it.
  const result = detailTask?.result ?? task.raw?.result;
  if (result && typeof result === 'object' && (result as { type?: unknown }).type === 'table') {
    const table = normalizeTablePayload((result as { payload?: unknown }).payload);
    if (table) {
      const firstRow = table.rows[0];
      if (firstRow && firstRow.length > 0) {
        return firstRow.map((c) => coerceCell(c)).filter(Boolean).join(' · ');
      }
      if (table.headers.length > 0) {
        return table.headers.join(' · ');
      }
    }
  }
  const fields = resultFields(result ?? null);
  if (fields && Object.keys(fields.fields).length > 0) {
    // task-6b1136a8ff77 — the list row never carries `outputSchema`
    // (mapListRow gap); combine the fetched detail's schema with the raw row's
    // via fieldedSchemaSource, exactly like TaskDetailDrawer.
    const schema = fieldedSchemaSource(
      { outputSchema: detailTask?.outputSchema },
      { outputSchema: task.raw?.outputSchema },
    );
    const labelByKey = new Map((schema ?? []).map((f) => [f.key, f.label]));
    return Object.entries(fields.fields)
      .map(([k, v]) => `${labelByKey.get(k) ?? k}=${String(v)}`)
      .join(' · ');
  }
  // No structured result → nothing to say. (The old OutcomesPanel fell back to
  // lastAction here, but in the unified table that's just the age string the
  // Last Run column already shows — rendering it again is noise.)
  return '';
}

/** Lazy per-row detail for finished PLAIN rows (getTask), so the outcome
 *  one-liner can label `{type:'fields'}` results via the server output schema.
 *  Same lazy/cached fetch-and-merge pattern TaskMatrix uses. */
function useOutcomeDetails(finishedIds: string[]): Map<string, Task> {
  const idKey = useMemo(() => [...finishedIds].sort().join(','), [finishedIds]);
  const [detailById, setDetailById] = useState<Map<string, Task>>(new Map());
  useEffect(() => {
    let cancelled = false;
    const ids = idKey ? idKey.split(',') : [];
    const missing = ids.filter((id) => !detailById.has(id));
    if (missing.length === 0) return;
    void (async () => {
      const fetched: [string, Task][] = [];
      for (const id of missing) {
        try {
          const t = await getTask(id);
          if (t) fetched.push([id, t]);
        } catch {
          // Offline / no access — summary falls back to the list row.
        }
      }
      if (cancelled || fetched.length === 0) return;
      setDetailById((prev) => {
        const next = new Map(prev);
        for (const [id, t] of fetched) next.set(id, t);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // idKey encodes the finished-task id set; re-run only when it moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey]);
  return detailById;
}

// ─── headless chain automation ──────────────────────────────────────────────
// The auto-continue + chain-parent-resolution machinery that used to live on
// the inline ChainedJobSubtable. The subtable is gone (step detail moved to
// the Level-2 matrix), but a chain must still self-advance and self-resolve
// while its row is on screen — so the effects survive here, rendering nothing.
function ChainAutomation({
  jobId,
  agentRun,
  autoOn,
  clearNonce,
  resolution,
  allTasksById,
  onStartChild,
  onErrorChange,
}: {
  /** task-6a14190fb2f7 — the job's own top-level task id. Auto-continue's
   *  localStorage pref and its claim-guard bookkeeping are keyed off this. */
  jobId: string;
  /** task-6a14190fb2f7 — auto-continue's DEFAULT-ON only ever applies to an
   *  agent-run chain — a human-run chain is never force-advanced. */
  agentRun: boolean;
  /** The per-job auto-continue pref (owned by RosterTable's menu toggle). */
  autoOn: boolean;
  /** Bumped on a manual ▶ Run all / re-enable — clears the back-off errors so
   *  an explicit human retry gets one clean attempt per step again
   *  (task-6fc9e503623e's "uncheck to freeze, re-check to retry"). */
  clearNonce: number;
  resolution: Extract<ChainedJobResolution, { status: 'chained' }>;
  allTasksById: Map<string, Task>;
  /** task-c141c7765aa4 — returns the StartOutcome (never throws) so the
   *  auto-continue effect can verify a session actually spawned instead of
   *  firing-and-forgetting the launch. */
  onStartChild: (childId: string) => Promise<StartOutcome>;
  /** Surface the current auto-start failure (or null) on the parent row. */
  onErrorChange: (jobId: string, message: string | null) => void;
}) {
  const { valuesByRef, childIdByDefId, childrenLoading, defs } = resolution;
  const tbReady = useTypebuildReadiness();
  const actions = useTaskActions();
  const sessions = useRunningSessions();
  // task-f26e7745eda6 — def id → the child's LIVE server status, so a
  // cancelled child is excluded from runnable/next-step.
  const childByDefId = useMemo<Record<string, ChildStatusLike>>(
    () => childStatusMap(Object.entries(childIdByDefId), (id) => allTasksById.get(id)),
    [childIdByDefId, allTasksById],
  );

  const nextChildId = useMemo(
    () => nextAutoContinueChildId(defs, valuesByRef, childIdByDefId, childByDefId),
    [defs, valuesByRef, childIdByDefId, childByDefId],
  );
  // Guard against double-start WHILE A LAUNCH IS IN FLIGHT (see the long
  // history on task-c141c7765aa4: only a genuinely SPAWNED session keeps the
  // guard set; any failure clears it and records a visible back-off error).
  const autoStartInFlightRef = useRef<string | null>(null);
  const [autoStartErrors, setAutoStartErrors] = useState<Record<string, string>>({});

  // task-6fc9e503623e — a manual retry (Run all) or re-enabling auto-continue
  // clears the back-off errors so the chain gets one clean attempt per step.
  const prevClearRef = useRef(clearNonce);
  const prevAutoOnRef = useRef(autoOn);
  useEffect(() => {
    const cleared =
      clearNonce !== prevClearRef.current || (autoOn && !prevAutoOnRef.current);
    prevClearRef.current = clearNonce;
    prevAutoOnRef.current = autoOn;
    if (cleared) setAutoStartErrors({});
  }, [clearNonce, autoOn]);

  // Report the current failure (if any) up to the row's actions cell.
  useEffect(() => {
    const first = Object.values(autoStartErrors)[0] ?? null;
    onErrorChange(jobId, first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartErrors, jobId]);

  useEffect(() => {
    if (!autoOn || !agentRun || !nextChildId) return;
    if (childrenLoading) return; // don't act on a partially-loaded job
    if (autoStartInFlightRef.current === nextChildId) return; // already in flight
    // task-6fc9e503623e (BACK-OFF) — never re-attempt a step that just failed
    // to stay alive: one auto attempt per step per enablement, never an
    // infinite claim/release cycle.
    if (autoStartErrors[nextChildId]) return;
    const child = allTasksById.get(nextChildId);
    if (!child) return;
    const pa = primaryActionFor(child, {
      caps: actions.caps(child),
      tbReady,
      myEmail: tbReady.email,
      session: sessions.get(nextChildId),
    });
    // Only ever auto-start when primaryActionFor itself says this exact
    // child is start-eligible right now.
    if (pa.kind !== 'start' || !pa.enabled) return;
    autoStartInFlightRef.current = nextChildId;
    void onStartChild(nextChildId).then((outcome: StartOutcome) => {
      if (outcome.ok && outcome.spawned) return; // live session — never double-fire
      // Launch failed OR the child exited within the liveness window. The
      // claim was already released by useTaskActions().start; record the
      // reason so the row surfaces it AND the back-off stops the churn loop.
      autoStartInFlightRef.current = null;
      const message = outcome.ok ? 'auto-start did not spawn a session' : outcome.message;
      setAutoStartErrors((prev) => ({ ...prev, [nextChildId]: message }));
    });
  }, [
    autoOn,
    agentRun,
    nextChildId,
    childrenLoading,
    allTasksById,
    actions,
    tbReady,
    sessions,
    onStartChild,
    autoStartErrors,
  ]);

  // ── chain-parent resolution (client-side interim) ─────────────────────────
  // When the LAST non-skipped child of a chain reaches a terminal state,
  // resolve the PARENT container server-side (complete/cancel via the existing
  // source verbs) so claim_next stops handing out a finished empty container.
  // IDEMPOTENT + SAFE: shouldResolveParent gates on the parent's CURRENT
  // server rawStatus; the in-flight ref stops a concurrent double-fire.
  const parentResolveInFlightRef = useRef(false);
  useEffect(() => {
    if (childrenLoading) return; // don't act on a partially-loaded job
    if (parentResolveInFlightRef.current) return;

    const childStates: { rawStatus?: string | null }[] = [];
    for (const def of defs) {
      if (taskDefStatus(def, valuesByRef) === 'skip') continue;
      const childId = childIdByDefId[def.id];
      const child = childId ? allTasksById.get(childId) : undefined;
      childStates.push({ rawStatus: child?.rawStatus ?? null });
    }

    const resolutionStatus = parentStatusFromChildren(childStates);
    const parent = allTasksById.get(jobId);
    if (!shouldResolveParent(parent?.rawStatus ?? null, resolutionStatus)) return;
    if (!resolutionStatus) return; // (shouldResolveParent already ensures this)

    // Build the aggregate chain evidence for the parent's submission. Held in
    // memory ONLY for the payload — never logged/persisted (PHI).
    const aggregate = buildChainAggregateResult({ defs, valuesByRef });
    void aggregate; // consumed by a result-carrying submit when the source supports it

    const parentSource = parent?.source ?? 'typebuild';
    parentResolveInFlightRef.current = true;
    const verb = resolutionStatus.status === 'done' ? 'complete' : 'cancel';
    void taskSourceAction(parentSource, jobId, verb)
      .then(() => {
        // Leave the guard SET on success — the next render's
        // shouldResolveParent sees the terminal rawStatus and short-circuits.
      })
      .catch(() => {
        // Failed to resolve (offline / contested) — clear the guard so a
        // later render retries once.
        parentResolveInFlightRef.current = false;
      });
  }, [childrenLoading, defs, valuesByRef, childIdByDefId, allTasksById, jobId]);

  return null;
}

// ─── primary row action (plain tasks) ───────────────────────────────────────
function RowAction({
  task,
  onOpenTask,
  onRetry,
  onStart,
  startEligible,
  viewableDetail,
  pending,
  error,
}: {
  task: NewHomeTask;
  onOpenTask: (id: string) => void;
  onRetry: (id: string) => void;
  onStart: (id: string) => void;
  /** When non-null, this row is start-eligible per primaryActionFor (the OLD
   *  Tasks page's state machine). `enabled` gates on TypeBuild readiness;
   *  `tooltip` is the same hover text the old play button shows. */
  startEligible: { enabled: boolean; tooltip?: string } | null;
  /** task-4f1e8f45bf0e — a DONE, non-chain, childless single task carrying a
   *  fielded result: "View →" opens the task-detail drawer (which defaults a
   *  done task to its Activity/Outputs read view). */
  viewableDetail: boolean;
  /** task-48cd46a0e2da — the shared wrapper's pending/error for THIS row's id. */
  pending: boolean;
  error: string | null;
}) {
  if (task.status === 'needs') {
    return (
      <button
        type="button"
        className="nh-roster__action nh-roster__action--answer"
        onClick={(e) => {
          e.stopPropagation();
          onOpenTask(task.id);
        }}
      >
        Answer
      </button>
    );
  }
  if (task.status === 'failed') {
    return (
      <span className="nh-roster__action-wrap">
        <button
          type="button"
          className="nh-roster__action nh-roster__action--retry"
          onClick={(e) => {
            e.stopPropagation();
            onRetry(task.id);
          }}
        >
          Retry
        </button>
        {error && <span className="nh-roster__action-error" role="alert" title={error}>{`⚠ ${error}`}</span>}
      </span>
    );
  }
  // task-c0edffef25c6 — a cancelled task was deliberately withdrawn, not a
  // failure: no Retry (that would invite re-running work someone cancelled
  // on purpose). "View →" still opens it when there's something to see;
  // otherwise a plain em-dash, same as any other row with no action.
  if (task.status === 'cancelled') {
    return viewableDetail ? (
      <button
        type="button"
        className="nh-roster__action nh-roster__action--view"
        onClick={(e) => {
          e.stopPropagation();
          onOpenTask(task.id);
        }}
      >
        View →
      </button>
    ) : (
      <span className="nh-roster__action-empty">{'—'}</span>
    );
  }
  // ▶ Start — the SAME claim-then-launch path the old Tasks page's play button
  // fires. Shown only for rows primaryActionFor deems start-eligible.
  if (startEligible) {
    return (
      <span className="nh-roster__action-wrap">
        <button
          type="button"
          className="nh-roster__action nh-roster__action--start"
          disabled={!startEligible.enabled || pending}
          title={startEligible.tooltip}
          onClick={(e) => {
            e.stopPropagation();
            onStart(task.id);
          }}
        >
          {pending ? 'Starting…' : '▶ Start'}
        </button>
        {error && <span className="nh-roster__action-error" role="alert" title={error}>{`⚠ ${error}`}</span>}
      </span>
    );
  }
  if (viewableDetail) {
    return (
      <button
        type="button"
        className="nh-roster__action nh-roster__action--view"
        onClick={(e) => {
          e.stopPropagation();
          onOpenTask(task.id);
        }}
      >
        View →
      </button>
    );
  }
  return <span className="nh-roster__action-empty">{'—'}</span>;
}

/** task-c82d8e0f4eae — one direct child subproject rolled up into a navigable
 *  roster section (name + per-bucket status chips + task count). The pure
 *  partition lives in subprojectSections.mjs; NewHomePage maps it to this. */
type SubprojectSectionRow = {
  id: string;
  name: string;
  statusCounts: Record<StatusBucket, number>;
  taskCount: number;
};

export function RosterTable({
  tasks,
  subprojectSections = [],
  onNavigateProject,
  filter,
  search = '',
  queryMode = 'none',
  queryError,
  onOpenTask,
  onRetry,
  onStart,
  onFilter,
  onSearch,
  loading,
}: {
  tasks: NewHomeTask[];
  /** task-c82d8e0f4eae — direct child subprojects of the selected project (or,
   *  for "All projects", each top-level project), each a navigable rollup
   *  section. Empty when the selection has no task-bearing subprojects. */
  subprojectSections?: SubprojectSectionRow[];
  /** Scope the whole surface to a subproject (drill parent → subproject →
   *  tasks). Same setter the picker/breadcrumb call. */
  onNavigateProject?: (id: string) => void;
  filter: 'all' | NewHomeStatus;
  /** Free-text search query, ANDed with the status filter. NewHomePage owns
   *  the actual filtering (it pre-filters `tasks`); this component just renders
   *  the box + reflects the current value. */
  search?: string;
  /** How NewHomePage interpreted the search box: 'none' (empty), 'text'
   *  (free-text), 'query' (structured DSL matched), 'invalid' (query-shaped but
   *  didn't parse). Drives the hint under the box. */
  queryMode?: 'none' | 'text' | 'query' | 'invalid';
  /** Parse error to show when queryMode === 'invalid'. */
  queryError?: string;
  onOpenTask: (id: string) => void;
  /** task-48cd46a0e2da — Retry now resolves the StartOutcome too (NewHomePage's
   *  startTask feeds both), so the shared start wrapper can show pending/error
   *  for a Retry click instead of a silent no-op (QA round 2). */
  onRetry: (id: string) => Promise<StartOutcome>;
  /** Launch a start-eligible task. Threaded from NewHomePage, which owns the
   *  useTaskActions().start (→ runTaskNow) call and the post-action roster
   *  refresh — the SAME mechanism the old Tasks page's play button uses.
   *  Resolves with the StartOutcome (never throws) so the chain auto-continue
   *  effect can verify a session actually spawned (task-c141c7765aa4). */
  onStart: (id: string) => Promise<StartOutcome>;
  /** Used by the empty state's "Clear filter" (the status filter itself now
   *  lives only on the HeroStats cards — the redundant pill bar is gone). */
  onFilter?: (f: 'all' | NewHomeStatus) => void;
  /** Set the free-text search query. Optional so older call sites still
   *  compile; when absent the search box is hidden. */
  onSearch?: (query: string) => void;
  loading?: boolean;
}) {
  // Defensive: filter locally too, in case a future caller passes an
  // unfiltered `tasks` array alongside a real `filter` value.
  const rows = useMemo(
    () => (filter === 'all' ? tasks : tasks.filter((t) => t.status === filter)),
    [tasks, filter],
  );

  // ── ▶ Start eligibility (reuses the OLD Tasks page's exact rule) ───────────
  // primaryActionFor is the single source of truth for a row's primary action.
  // `allTasks` is the FULL, UNFILTERED roster so a status filter that hides a
  // parent's open children can't make it falsely look start-eligible. PHI: no
  // task text is read here — only ids/status/claim/parent metadata.
  const tbReady = useTypebuildReadiness();
  const sessions = useRunningSessions();
  const actions = useTaskActions();
  // task-48cd46a0e2da — the SHARED start wrapper: EVERY start affordance in
  // this component routes through it, so none can be silent. It owns
  // pending/error UI keyed by the row/parent id.
  const startAction = useStartAction();
  const { tasks: allTasks } = useTasks({ includeDone: true });
  const openChildParentIds = useMemo(() => {
    const set = new Set<string>();
    for (const t of allTasks) {
      if (t.parentTaskId && !isDone(t)) set.add(t.parentTaskId);
    }
    return set;
  }, [allTasks]);
  const allTasksById = useMemo(() => new Map(allTasks.map((t) => [t.id, t])), [allTasks]);
  // task-ecabeafa41e1 — Level-2 matrix: which chain parent's matrix is open (null = roster).
  const [matrixParentId, setMatrixParentId] = useState<string | null>(null);
  const startActionFor = (
    t: NewHomeTask,
  ): { enabled: boolean; tooltip?: string } | null => {
    const pa = primaryActionFor(t.raw, {
      caps: actions.caps(t.raw),
      tbReady,
      myEmail: tbReady.email,
      session: sessions.get(t.id),
      hasOpenChildren: openChildParentIds.has(t.id),
    });
    return pa.kind === 'start' ? { enabled: pa.enabled, tooltip: pa.tooltip } : null;
  };

  // task-f26e7745eda6 — def id → the runnable child's LIVE server status, so
  // the chain-start walk (chainStartTarget) skips a cancelled child instead of
  // targeting it (the round-8 silent no-op).
  const childStatusMapFor = (
    chainedRes: Extract<ChainedJobResolution, { status: 'chained' }>,
  ): Record<string, ChildStatusLike> =>
    childStatusMap(Object.entries(chainedRes.childIdByDefId), (id) => allTasksById.get(id));

  // task-4045bcee23cb (U3a #1) / task-48cd46a0e2da — "▶ Run all" for a v2
  // chained row: resolve the first RUNNABLE child (chainStartTarget, which
  // skips cancelled steps and, when nothing is runnable, returns an explicit
  // REASON so the click is never silent).
  const chainStartFor = (
    chainedRes: Extract<ChainedJobResolution, { status: 'chained' }>,
  ):
    | { childId: string; enabled: boolean; tooltip?: string }
    | { disabled: true; reason: string }
    | null => {
    const childStatus = childStatusMapFor(chainedRes);
    const target = chainStartTarget(
      chainedRes.defs,
      chainedRes.valuesByRef,
      chainedRes.childIdByDefId,
      childStatus,
    );
    if (target.childId === null) {
      // A genuinely COMPLETE chain is the calm terminal state — no action. A
      // chain stuck on a CANCELLED (or still-loading) step IS actionable news.
      if (/complete/i.test(target.reason)) return null;
      return { disabled: true, reason: target.reason };
    }
    const child = allTasksById.get(target.childId);
    if (!child) return { disabled: true, reason: 'the next step is still loading' };
    const pa = primaryActionFor(child, {
      caps: actions.caps(child),
      tbReady,
      myEmail: tbReady.email,
      session: sessions.get(target.childId),
    });
    if (pa.kind === 'start') {
      return { childId: target.childId, enabled: pa.enabled, tooltip: pa.tooltip };
    }
    // Already running/claimed → the normal in-flight state; stay calm.
    if (pa.kind === 'open-session') return null;
    // task-48cd46a0e2da (A#1) — a BLOCKED next step resolves to 'reopen'.
    if (pa.kind === 'reopen') {
      return { disabled: true, reason: `${target.stepName} is blocked — open it to reopen/continue` };
    }
    const note = pa.kind === 'none' ? pa.note ?? '' : '';
    if (/in progress|claimed/i.test(note)) return null;
    const reason = note ? `${target.stepName}: ${note}` : `${target.stepName}: can’t be started right now`;
    return { disabled: true, reason };
  };

  // task-d1164f534605 — "▶ Run all" for a THIN-PARENT chain: a body-less
  // parent container whose CHILD rows ARE the steps. Target the FIRST
  // non-terminal child and run it through primaryActionFor for eligibility —
  // identical shape + feedback to chainStartFor.
  const childrenByParentId = useMemo(() => {
    const m = new Map<string, typeof allTasks>();
    for (const c of allTasks) {
      const p = c.parentTaskId;
      if (!p) continue;
      const arr = m.get(p);
      if (arr) arr.push(c);
      else m.set(p, [c]);
    }
    return m;
  }, [allTasks]);
  const plainChainStartFor = (
    parentId: string,
  ):
    | { childId: string; enabled: boolean; tooltip?: string }
    | { disabled: true; reason: string }
    | null => {
    const kids = childrenByParentId.get(parentId);
    if (!kids || kids.length === 0) return null; // not a container → not a chain
    const target = thinChainStartTarget(
      kids.map((c) => ({ id: c.id, rawStatus: c.rawStatus ?? null })),
    );
    if (target.childId === null) {
      if (/complete/i.test(target.reason)) return null;
      return { disabled: true, reason: target.reason };
    }
    const child = allTasksById.get(target.childId);
    if (!child) return { disabled: true, reason: 'the next step is still loading' };
    const pa = primaryActionFor(child, {
      caps: actions.caps(child),
      tbReady,
      myEmail: tbReady.email,
      session: sessions.get(target.childId),
    });
    if (pa.kind === 'start') {
      return { childId: target.childId, enabled: pa.enabled, tooltip: pa.tooltip };
    }
    // A failed head step is the retryable current step — offer it as a start.
    if (pa.kind === 'retry') {
      return { childId: target.childId, enabled: true, tooltip: 'retry the failed step' };
    }
    if (pa.kind === 'open-session') return null;
    if (pa.kind === 'reopen') {
      return { disabled: true, reason: 'the next step is blocked — open it to reopen/continue' };
    }
    const note = pa.kind === 'none' ? pa.note ?? '' : '';
    if (/in progress|claimed/i.test(note)) return null;
    return {
      disabled: true,
      reason: note ? `next step: ${note}` : 'the next step can’t be started right now',
    };
  };

  // ── chained-job detection (task-b1fa5098da3e, R3) ─────────────────────────
  // Candidate jobs: EVERY top-level row (no parentTaskId) — useChainedRoster
  // resolves each candidate's own body lazily to learn which of
  // plain/fielded/chained it is.
  const candidateJobIds = useMemo(() => {
    const ids: string[] = [];
    for (const t of rows) {
      if (!(t.raw.parentTaskId ?? null)) ids.push(t.id);
    }
    return ids;
  }, [rows]);
  const chained = useChainedRoster({ jobIds: candidateJobIds });
  const resolutions = useMemo(() => {
    const map = new Map<string, ChainedJobResolution>();
    for (const id of candidateJobIds) map.set(id, chained.resolveJob(id));
    return map;
  }, [candidateJobIds, chained]);

  // A chained job's children are folded into its aggregate row — don't ALSO
  // give them their own top-level row. This now covers THIN-parent chains too:
  // since every parent-with-children renders as an aggregate chain row
  // (Status breakdown + Runs), letting its steps also render as top-level rows
  // double-counted them (QA round: the scaffold chain showed its parent AND
  // both failed steps). A child only folds while its parent row is actually
  // in the current (filtered) list — filter to "failed" and the failed steps
  // surface as rows because their queued parent is filtered out.
  const hiddenChildIds = useMemo(() => {
    const set = new Set<string>();
    for (const res of resolutions.values()) {
      if (res.status === 'chained') {
        for (const cid of Object.values(res.childIdByDefId)) set.add(cid);
      }
    }
    for (const t of rows) {
      if (t.raw.parentTaskId ?? null) continue; // only top-level parents fold
      const kids = childrenByParentId.get(t.id);
      if (kids) for (const c of kids) set.add(c.id);
    }
    return set;
  }, [resolutions, rows, childrenByParentId]);

  const visibleRows = useMemo(
    () => rows.filter((t) => !hiddenChildIds.has(t.id)),
    [rows, hiddenChildIds],
  );

  // ── template-grouped rows (task-b8fa34a80a34) ──────────────────────────────
  // A SINGLE fielded-task template instance (a childless task that declares
  // input data-keys and/or an output schema) groups under its template; chains
  // keep their own aggregate row (never grouped).
  const groupableInputs = useMemo<RosterGroupInput[]>(() => {
    const out: RosterGroupInput[] = [];
    for (const t of visibleRows) {
      const res = resolutions.get(t.id);
      if (res && res.status === 'chained') continue;
      const fieldedOutputs =
        res && res.status === 'fielded' ? res.defs[0]?.outputs ?? [] : [];
      const rawOutputs = t.raw.outputSchema ?? [];
      const outputSchema = fieldedOutputs.length > 0 ? fieldedOutputs : rawOutputs;
      const dataKeys = t.raw.dataKeys ?? [];
      // Not field-bearing → a plain row.
      if (outputSchema.length === 0 && dataKeys.length === 0) continue;
      out.push({
        id: t.id,
        title: t.title,
        projectId: t.projectId,
        templateId: t.templateId ?? null,
        templateName: null,
        dataKeys,
        outputSchema,
        status: t.status,
        createdAt: t.raw.created_at ?? null,
      });
    }
    return out;
  }, [visibleRows, resolutions]);

  const { groups: templateGroups } = useMemo(
    () => buildRosterGroups(groupableInputs),
    [groupableInputs],
  );

  // Grouped instances are lifted OUT of the plain rows (no double render).
  const groupedTaskIds = useMemo(() => {
    const set = new Set<string>();
    for (const g of templateGroups) for (const r of g.rows) set.add(r.taskId);
    return set;
  }, [templateGroups]);

  const flatRows = useMemo(
    () => visibleRows.filter((t) => !groupedTaskIds.has(t.id)),
    [visibleRows, groupedTaskIds],
  );

  const rowsById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const onNewRun = (_group: RosterGroup) => {
    // task-b8fa34a80a34 — open the canonical New-from-Template flow.
    // Pre-picking THIS template isn't wired yet; this opens the picker.
    window.dispatchEvent(
      new CustomEvent('fm:openTask', { detail: { mode: 'create', initialKind: 'template' } }),
    );
    window.dispatchEvent(new CustomEvent('fm:openCopilotChat'));
  };

  // task-ecabeafa41e1 — group summaries: per-bucket status counts + distinct
  // assignees (assignee = assigned_to, falling back to the current claimer).
  const groupSummaries = useMemo(() => {
    const m = new Map<string, GroupSummary>();
    for (const g of templateGroups) {
      const runs = g.rows.map((r) => {
        const t = allTasksById.get(r.taskId);
        return {
          status: r.status,
          assignee: t?.assignedTo ?? t?.claimedBy ?? null,
        };
      });
      m.set(g.key, summarizeGroupRows(runs));
    }
    return m;
  }, [templateGroups, allTasksById]);

  // A group's Last Run = the most recent activity across its runs.
  const groupLastRun = (g: RosterGroup): { label: string; detail: string } => {
    let best: NewHomeTask | null = null;
    for (const r of g.rows) {
      const t = rowsById.get(r.taskId);
      if (!t) continue;
      if (!best || (t.lastActionAt ?? 0) > (best.lastActionAt ?? 0)) best = t;
    }
    return best
      ? { label: best.lastAction, detail: best.lastActionDetail }
      : { label: '—', detail: '' };
  };

  // task-ecabeafa41e1 — "View →" on a group opens the Level-2 matrix over ALL
  // the group's runs (multi-run).
  const [matrixGroupKey, setMatrixGroupKey] = useState<string | null>(null);
  const onViewGroup = (group: RosterGroup) => setMatrixGroupKey(group.key);

  // task-ecabeafa41e1 — "▶ Run all": start every runnable run in the group
  // through the shared start wrapper (optimistic + de-duped).
  const runAllGroup = (group: RosterGroup) => {
    for (const r of group.rows) {
      const bucket = r.status ?? '';
      const done = bucket === 'done' || bucket === 'cancelled';
      if (done) continue;
      void startAction.run(r.taskId, { kind: 'start', run: () => onStart(r.taskId) });
    }
  };
  const runAllPendingFor = (group: RosterGroup): boolean =>
    group.rows.some((r) => startAction.pendingFor(r.taskId));

  // ── chained-row aggregates ─────────────────────────────────────────────────
  // A chain's STEPS, as ids: the v2 block's children when resolved, else the
  // container's child rows. Order matches the chain.
  const chainChildIds = (t: NewHomeTask): string[] => {
    const res = resolutions.get(t.id);
    if (res && res.status === 'chained') {
      const ids: string[] = [];
      for (const def of res.defs) {
        // A conditionally-skipped step isn't part of this job's work — leave
        // it out of the Runs count and the status breakdown.
        if (taskDefStatus(def, res.valuesByRef) === 'skip') continue;
        const cid = res.childIdByDefId[def.id];
        if (cid) ids.push(cid);
      }
      return ids;
    }
    return (childrenByParentId.get(t.id) ?? []).map((c) => c.id);
  };
  const chainCounts = (childIds: string[]): Record<StatusBucket, number> => {
    // task-c0edffef25c6 — `cancelled` counted separately so a chain of
    // deliberately-cancelled steps reads "2 cancelled", not "2 failed".
    const counts: Record<StatusBucket, number> = {
      done: 0,
      progress: 0,
      queued: 0,
      needs: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const cid of childIds) {
      // Prefer the DERIVED New Home status (rowsById) — it already folds in
      // attempts-exhausted → failed, stalled → needs, etc., so the parent's
      // breakdown can never disagree with the pill the child's own row would
      // show (QA round: raw 'open' children with exhausted attempts read
      // "2 queued" on the parent while rendering as Failed rows). Fall back
      // to the raw status for a child outside the scoped roster.
      const row = rowsById.get(cid);
      if (row) {
        counts[statusBucket(row.status)] += 1;
        continue;
      }
      const child = allTasksById.get(cid);
      counts[statusBucket(child?.rawStatus ?? child?.status)] += 1;
    }
    return counts;
  };

  // Auto-continue prefs (localStorage-backed) + the manual-retry clear nonce
  // the headless ChainAutomation watches (task-6fc9e503623e).
  const [autoPrefs, setAutoPrefs] = useState<Record<string, boolean>>({});
  const autoOnFor = (jobId: string): boolean => autoPrefs[jobId] ?? isAutoContinueOn(jobId);
  const [clearNonces, setClearNonces] = useState<Record<string, number>>({});
  const bumpClearNonce = (jobId: string) =>
    setClearNonces((prev) => ({ ...prev, [jobId]: (prev[jobId] ?? 0) + 1 }));
  const toggleAuto = (jobId: string) => {
    const next = !autoOnFor(jobId);
    setAutoContinue(jobId, next);
    setAutoPrefs((prev) => ({ ...prev, [jobId]: next }));
  };
  // Per-chain auto-start failure surfaced on the row (from ChainAutomation).
  const [chainErrors, setChainErrors] = useState<Record<string, string | null>>({});
  const onChainErrorChange = (jobId: string, message: string | null) =>
    setChainErrors((prev) => (prev[jobId] === message ? prev : { ...prev, [jobId]: message }));

  // "Any content" includes navigable subproject sections — a parent project
  // with no direct tasks but task-bearing subprojects is NOT empty.
  const hasAnyTasks = tasks.length > 0 || subprojectSections.length > 0;
  const isFiltered = filter !== 'all' || !!search.trim();
  // "Clear" resets BOTH dimensions so one click always gets you back to the
  // full roster, regardless of which filter emptied it.
  const clearFilter = () => {
    onFilter?.('all');
    onSearch?.('');
  };

  // task-1af4f59428eb (Item 4) — j/k + arrow-key row navigation, SCOPED to
  // this table: fires only while a row has DOM focus, stopPropagation so the
  // key never reaches src/useKeyboard.ts's window-level listener.
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());

  const focusRow = (id: string) => {
    rowRefs.current.get(id)?.focus();
  };

  const onBodyKeyDown = (e: ReactKeyboardEvent<HTMLTableSectionElement>) => {
    const target = e.target as HTMLElement;
    if (!target.dataset || target.dataset.rosterRow == null) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return; // don't shadow any chord

    const ids = flatRows.map((t) => t.id);
    const currentId = target.dataset.rosterRow;
    const idx = ids.indexOf(currentId);
    if (idx === -1) return;

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      const next = ids[Math.min(idx + 1, ids.length - 1)];
      focusRow(next);
      return;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const prev = ids[Math.max(idx - 1, 0)];
      focusRow(prev);
      return;
    }
    if (e.key === 'Enter') {
      e.stopPropagation();
      onOpenTask(currentId);
    }
  };

  // Outcome one-liners for finished PLAIN rows (the old OutcomesPanel, folded
  // into the title cell). Only plain childless rows carry one — group/chain
  // outcomes live in their Level-2 matrix.
  const finishedPlainIds = useMemo(
    () =>
      flatRows
        .filter(
          (t) =>
            (t.status === 'done' || t.status === 'failed') && !childrenByParentId.has(t.id),
        )
        .map((t) => t.id),
    [flatRows, childrenByParentId],
  );
  const outcomeDetails = useOutcomeDetails(finishedPlainIds);
  const finishedPlainIdSet = useMemo(() => new Set(finishedPlainIds), [finishedPlainIds]);

  // task-ecabeafa41e1 — Level-2 matrix takes over the roster surface when a
  // "View →" is clicked; Back (onClose) returns to the list. Two entry points:
  //   • matrixParentId — a single CHAIN parent (runs=[parent], columns grouped
  //     by its step-children).
  //   • matrixGroupKey — a template GROUP (runs = all the group's instances).
  const matrixView = (() => {
    if (matrixParentId) {
      const parent = allTasksById.get(matrixParentId);
      if (!parent) return null;
      return {
        title: parent.title,
        runs: [parent],
        childrenOf: (pid: string) => childrenByParentId.get(pid) ?? [],
        // task-57e1470fad6f — a chain parent; chain templates have no server
        // update endpoint yet (task-a19115192233), so no Edit affordance.
        templateId: null as string | null,
        close: () => setMatrixParentId(null),
      };
    }
    if (matrixGroupKey) {
      const group = templateGroups.find((g) => g.key === matrixGroupKey);
      if (!group) return null;
      const runs = group.rows
        .map((r) => allTasksById.get(r.taskId))
        .filter((t): t is Task => !!t);
      if (runs.length === 0) return null;
      const templateId = runs.find((r) => r.templateId)?.templateId ?? null;
      return {
        title: group.name,
        runs,
        childrenOf: (pid: string) => childrenByParentId.get(pid) ?? [],
        templateId,
        close: () => setMatrixGroupKey(null),
      };
    }
    return null;
  })();

  // The headless chain automation must stay mounted even while the matrix
  // covers the roster (a chain should keep advancing while you inspect it).
  const chainAutomations = (
    <>
      {flatRows.map((t) => {
        const res = resolutions.get(t.id);
        if (!res || res.status !== 'chained') return null;
        return (
          <ChainAutomation
            key={`auto-${t.id}`}
            jobId={t.id}
            // task-6a14190fb2f7 — t.who is never purely 'human' for a row
            // whose ball a human currently holds (deriveWho routes any open
            // pending_question to 'human'), so excluding 'human' is exactly
            // "don't force-advance a chain the human is actively driving".
            agentRun={t.who !== 'human'}
            autoOn={autoOnFor(t.id)}
            clearNonce={clearNonces[t.id] ?? 0}
            resolution={res}
            allTasksById={allTasksById}
            onStartChild={onStart}
            onErrorChange={onChainErrorChange}
          />
        );
      })}
    </>
  );

  if (matrixView) {
    return (
      <div className="nh-roster">
        {chainAutomations}
        <TaskMatrix
          chainTitle={matrixView.title}
          runs={matrixView.runs}
          childrenOf={matrixView.childrenOf}
          templateId={matrixView.templateId}
          onClose={matrixView.close}
          onOpenTask={onOpenTask}
          onStartChild={(cid) => {
            void startAction.run(cid, { kind: 'start', run: () => onStart(cid) });
          }}
          // task-1b3eeb1aae1f — OPTIMISTIC LAUNCH. Feed the SAME useStartAction
          // wrapper's per-child pending/error into the matrix so its ▶ Run /
          // ▶ Start step show an instant "Starting…" (disabled) on click and a
          // visible failure.
          pendingFor={startAction.pendingFor}
          errorFor={startAction.errorFor}
        />
      </div>
    );
  }

  const nothingToShow =
    flatRows.length === 0 && templateGroups.length === 0 && subprojectSections.length === 0;

  return (
    <div className="nh-roster">
      {chainAutomations}
      {onSearch && (
        <div className="nh-roster__toolbar">
          <div className="nh-roster__search">
            <input
              type="search"
              className={
                'nh-roster__search-input' +
                (queryMode === 'query' ? ' nh-roster__search-input--query' : '') +
                (queryMode === 'invalid' ? ' nh-roster__search-input--invalid' : '')
              }
              placeholder="Search, or query e.g. status=needs and repeatable"
              aria-label="Search or query tasks"
              title="Type words to search, or a query like: status in (needs, failed) and due < now+7d"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
            />
            {queryMode === 'query' && (
              <span className="nh-roster__search-hint nh-roster__search-hint--query">⚡ query</span>
            )}
            {queryMode === 'invalid' && (
              <span className="nh-roster__search-hint nh-roster__search-hint--invalid" title={queryError}>
                ⚠ {queryError}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="nh-roster__table-wrap">
        <table className="nh-roster__table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Last Run</th>
              <th>Who</th>
              <th className="nh-roster__th-runs">Runs</th>
              <th className="nh-roster__th-action" />
            </tr>
          </thead>
          <tbody onKeyDown={onBodyKeyDown}>
            {loading && !hasAnyTasks && (
              <>
                {[0, 1, 2].map((i) => (
                  <tr key={`skeleton-${i}`} className="nh-roster__row--skeleton" aria-hidden="true">
                    <td colSpan={BASE_COLUMN_COUNT}>
                      <div className="nh-roster__skeleton-bar" />
                    </td>
                  </tr>
                ))}
              </>
            )}
            {!loading && !hasAnyTasks && !isFiltered && (
              <tr>
                <td colSpan={BASE_COLUMN_COUNT} className="nh-roster__empty">
                  No tasks yet for this project.
                </td>
              </tr>
            )}
            {!loading && nothingToShow && isFiltered && (
              <tr>
                <td colSpan={BASE_COLUMN_COUNT} className="nh-roster__empty">
                  No tasks match {search.trim() ? <>“{search.trim()}”</> : 'this filter'}.{' '}
                  <button type="button" className="nh-roster__clear-filter" onClick={clearFilter}>
                    Clear filter
                  </button>
                </td>
              </tr>
            )}

            {/* task-c82d8e0f4eae — subproject rollup sections first: a parent's
                direct child subprojects, each a navigable row (same columns —
                hero-stat-style status chips, a task count) that drills into
                that subproject. */}
            {subprojectSections.map((s) => (
              <tr
                key={`subproject-${s.id}`}
                className="nh-roster__row--group nh-roster__row--subproject"
                onClick={() => onNavigateProject?.(s.id)}
                title="A subproject — click to open its tasks"
              >
                <td className="nh-roster__title-cell">
                  <div
                    className="nh-roster__title nh-roster__title--group nh-roster__title--subproject"
                    title="A subproject — click to open its tasks"
                  >
                    <span className="nh-roster__subproject-glyph" aria-hidden="true">
                      {'\u{1F5C2}'}
                    </span>
                    {s.name}
                  </div>
                </td>
                <td>
                  <StatusBreakdown counts={s.statusCounts} />
                </td>
                <td className="nh-roster__last-action">—</td>
                <td className="nh-roster__who">—</td>
                <td className="nh-roster__runs">{s.taskCount}</td>
                <td className="nh-roster__action-cell">
                  <span className="nh-roster__action-wrap">
                    <button
                      type="button"
                      className="nh-roster__action nh-roster__action--view"
                      onClick={(e) => {
                        e.stopPropagation();
                        onNavigateProject?.(s.id);
                      }}
                      title={`Open ${s.name}`}
                    >
                      Open →
                    </button>
                  </span>
                </td>
              </tr>
            ))}

            {/* Template-group rows first, then chained + plain rows — all the
                SAME columns. */}
            {templateGroups.map((g) => {
              const summary = groupSummaries.get(g.key) ?? summarizeGroupRows([]);
              const { runCount, statusCounts, assignees } = summary;
              const last = groupLastRun(g);
              const hasRunnable =
                statusCounts.queued + statusCounts.needs + statusCounts.failed + statusCounts.progress > 0;
              const runAllPending = runAllPendingFor(g);
              const assigneeTitle = assignees.length > 0 ? assignees.join(', ') : 'Unassigned';
              return (
                <tr
                  key={`group-${g.key}`}
                  className="nh-roster__row--group"
                  onClick={() => onViewGroup(g)}
                >
                  <td className="nh-roster__title-cell">
                    <div className="nh-roster__title nh-roster__title--group" title="A template — each run is one instance">
                      {g.name}
                    </div>
                  </td>
                  <td>
                    <StatusBreakdown counts={statusCounts} />
                  </td>
                  <td className="nh-roster__last-action" title={last.detail}>
                    {last.label}
                  </td>
                  <td className="nh-roster__who nh-roster__who--group" title={assigneeTitle}>
                    {assignees.length === 0
                      ? 'Unassigned'
                      : assignees.length === 1
                        ? assignees[0]
                        : `${assignees.length} people`}
                  </td>
                  <td className="nh-roster__runs">{runCount}</td>
                  <td className="nh-roster__action-cell">
                    <span className="nh-roster__action-wrap">
                      <button
                        type="button"
                        className="nh-roster__action nh-roster__action--view"
                        onClick={(e) => {
                          e.stopPropagation();
                          onViewGroup(g);
                        }}
                        title="View each run's status, inputs and outputs"
                      >
                        View →
                      </button>
                      <ActionsMenu
                        label={`Actions for ${g.name}`}
                        items={[
                          { label: 'View runs →', onClick: () => onViewGroup(g) },
                          ...(hasRunnable
                            ? [
                                {
                                  label: runAllPending ? 'Starting…' : '▶ Run all',
                                  onClick: () => runAllGroup(g),
                                  disabled: runAllPending,
                                  title: 'Start every runnable run in this group',
                                },
                              ]
                            : []),
                          { label: '+ New run', onClick: () => onNewRun(g) },
                        ]}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}

            {flatRows.map((t) => {
              const resolution = resolutions.get(t.id);
              const chainedRes =
                resolution && resolution.status === 'chained' ? resolution : null;
              const childIds = chainChildIds(t);
              const isChain = childIds.length > 0;
              const rowTint =
                t.status === 'needs'
                  ? 'nh-roster__row--needs'
                  : t.status === 'failed'
                    ? 'nh-roster__row--failed'
                    : '';
              const outcome = finishedPlainIdSet.has(t.id)
                ? summarizeOutcome(t, outcomeDetails.get(t.id))
                : '';

              // ── chained / container row: aggregate status + View/Run-all ──
              if (isChain) {
                const counts = chainCounts(childIds);
                const runAll = chainedRes ? chainStartFor(chainedRes) : plainChainStartFor(t.id);
                const runAllReason = runAll && 'disabled' in runAll ? runAll.reason : undefined;
                const pending = startAction.pendingFor(t.id);
                const rowError = startAction.errorFor(t.id) ?? chainErrors[t.id] ?? null;
                return (
                  <tr
                    key={t.id}
                    ref={(el) => {
                      if (el) rowRefs.current.set(t.id, el);
                      else rowRefs.current.delete(t.id);
                    }}
                    data-roster-row={t.id}
                    className={rowTint}
                    tabIndex={0}
                    onClick={() => setMatrixParentId(t.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        // stopPropagation: the tbody-level Enter handler opens
                        // the task DETAIL — a chain row's Enter opens its matrix.
                        e.stopPropagation();
                        setMatrixParentId(t.id);
                      }
                    }}
                  >
                    <td className="nh-roster__title-cell">
                      <div className="nh-roster__title">{t.title}</div>
                      {t.risk && (t.status === 'needs' || t.status === 'failed') && (
                        <div className="nh-roster__risk">{t.risk}</div>
                      )}
                    </td>
                    <td>
                      {t.live && (
                        <span className="nh-roster__live-dot" aria-hidden="true" title={liveTooltip(t)} />
                      )}
                      <StatusBreakdown counts={counts} />
                    </td>
                    <td className="nh-roster__last-action" title={t.lastActionDetail}>
                      {t.lastAction}
                    </td>
                    <td className="nh-roster__who" title={t.who}>
                      {WHO_GLYPH[t.who]}
                    </td>
                    <td className="nh-roster__runs">{childIds.length}</td>
                    <td className="nh-roster__action-cell">
                      <span className="nh-roster__action-wrap">
                        <button
                          type="button"
                          className="nh-roster__action nh-roster__action--view"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMatrixParentId(t.id);
                          }}
                          title="View each step's status, inputs and outputs"
                        >
                          View →
                        </button>
                        <ActionsMenu
                          label={`Actions for ${t.title}`}
                          items={[
                            { label: 'View steps →', onClick: () => setMatrixParentId(t.id) },
                            ...(runAll
                              ? [
                                  {
                                    label: pending ? 'Starting…' : '▶ Run all',
                                    onClick: () => {
                                      if ('childId' in runAll) {
                                        bumpClearNonce(t.id);
                                        // Key pending/error on the PARENT row id,
                                        // but launch the CHILD.
                                        void startAction.run(t.id, {
                                          kind: 'start',
                                          run: () => onStart(runAll.childId),
                                        });
                                      }
                                    },
                                    disabled:
                                      'disabled' in runAll ||
                                      ('enabled' in runAll && !runAll.enabled) ||
                                      pending,
                                    title:
                                      'disabled' in runAll
                                        ? runAll.reason
                                        : runAll.tooltip ?? 'Run every runnable step',
                                  },
                                ]
                              : []),
                            ...(chainedRes
                              ? [
                                  {
                                    label: 'Auto-continue',
                                    checkbox: true as const,
                                    checked: autoOnFor(t.id),
                                    onToggle: () => toggleAuto(t.id),
                                    title:
                                      'Automatically start the next step when the previous one finishes',
                                  },
                                ]
                              : []),
                            { label: '↗ Open task', onClick: () => onOpenTask(t.id) },
                          ]}
                        />
                        {(rowError || runAllReason) && (
                          <span
                            className="nh-roster__action-error"
                            role="alert"
                            title={rowError ?? runAllReason}
                          >
                            {`⚠ ${rowError ?? runAllReason}`}
                          </span>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              }

              // ── plain task row ─────────────────────────────────────────────
              return (
                <tr
                  key={t.id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(t.id, el);
                    else rowRefs.current.delete(t.id);
                  }}
                  data-roster-row={t.id}
                  className={rowTint}
                  tabIndex={0}
                  onClick={() => onOpenTask(t.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onOpenTask(t.id);
                  }}
                >
                  <td className="nh-roster__title-cell">
                    <div className="nh-roster__title">{t.title}</div>
                    {t.risk && (t.status === 'needs' || t.status === 'failed') && (
                      <div className="nh-roster__risk">{t.risk}</div>
                    )}
                    {outcome && (
                      <div className="nh-roster__outcome" title={outcome}>
                        {outcome}
                      </div>
                    )}
                  </td>
                  <td>
                    {t.live && (
                      <span className="nh-roster__live-dot" aria-hidden="true" title={liveTooltip(t)} />
                    )}
                    <span className={`nh-roster__pill nh-roster__pill--${t.status}`}>
                      {STATUS_LABEL[t.status]}
                    </span>
                  </td>
                  <td className="nh-roster__last-action" title={t.lastActionDetail}>
                    {t.lastAction}
                  </td>
                  <td className="nh-roster__who" title={t.who}>
                    {WHO_GLYPH[t.who]}
                  </td>
                  <td className="nh-roster__runs">1</td>
                  <td className="nh-roster__action-cell">
                    <span className="nh-roster__action-wrap">
                      <RowAction
                        task={t}
                        onOpenTask={onOpenTask}
                        onRetry={(id) => {
                          // Route Retry through the shared wrapper too — a Retry
                          // that silently no-ops was QA round-2's defect.
                          void startAction.run(id, { kind: 'start', run: () => onRetry(id) });
                        }}
                        onStart={(id) => {
                          void startAction.run(id, { kind: 'start', run: () => onStart(id) });
                        }}
                        startEligible={startActionFor(t)}
                        // task-4f1e8f45bf0e — a DONE, non-chain, CHILDLESS single
                        // task whose lazy resolution found a fielded result gets
                        // "View →" into the detail drawer's read view.
                        viewableDetail={
                          t.status === 'done' && resolution?.status === 'fielded'
                        }
                        pending={startAction.pendingFor(t.id)}
                        error={startAction.errorFor(t.id)}
                      />
                      <ActionsMenu
                        label={`Actions for ${t.title}`}
                        items={[{ label: '↗ Open task', onClick: () => onOpenTask(t.id) }]}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
