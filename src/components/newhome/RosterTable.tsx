// task-cc9a4ef6f38a — RosterTable: the Project View table (spec §1) + the
// escalation layer on top of it (spec §7). Renders the tasks NewHomePage
// already scoped/filtered by project + status.
//
// task-b1fa5098da3e (R3) — a project no longer carries configured columns
// (TemplateConfig/TemplateField removed, docs/task-templates-design.md
// "Removed/superseded"). Every row renders the SAME fixed built-in columns
// (Title/Status/Last Action/Who/Action). A CHAINED task — a top-level task
// with children whose OWN body parses a v2 ```task-template block (see
// useChainedRoster) — additionally renders a SUBTABLE beneath its summary
// row, with grouped per-task-def IN/OUT columns aggregated from THAT job's
// own defs (never a project pref). A plain task (no chain, or a
// non-chained parent with children) renders as a normal row. Mixed projects
// (some chained, some plain) render both kinds side by side.
//
// PHI: `title`, `lastAction`, `customValues` values, and `risk` may carry
// task text — render in memory only, never persist/log (see
// docs/typebuild-data-field-contract.md).
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { NewHomeStatus, NewHomeTask } from './types';
import type { Task } from '../../types';
import { claimFreshness } from '../tasks/lifecycle.mjs';
import { evalCondition, fieldRef, metaStatus, taskDefStatus } from './taskSchema.mjs';
import type { MergedStepStatus } from './taskSchema.mjs';
import {
  nextAutoContinueChildId,
  pipelineColumns,
  partitionJobs,
  runnableStepId,
  mergeChildStatus,
  chainStartTarget,
  childStatusMap,
  toChildStatus,
} from './pipelineRoster.mjs';
import { isAutoContinueOn, setAutoContinue } from './chainAutoContinuePrefs';
import type { PipelineColumn, PipelineGroup, ChildStatusLike } from './pipelineRoster.mjs';
import { useChainedRoster } from './useNewHomeData';
import type { ChainedJobResolution } from './useNewHomeData';
// task — the "▶ Start" row action reuses the OLD Tasks page's exact launch
// path: primaryActionFor (the single source of truth for which primary action a
// row offers) decides eligibility, and useTaskActions().start (→ runTaskNow) is
// the same claim-then-launch IPC the old play button fires. No new launch path.
import { useTasks, useTypebuildReadiness } from '../../tasks';
import { useTaskActions } from '../tasks/useTaskActions';
import type { StartOutcome } from '../tasks/useTaskActions';
import { useStartAction } from '../tasks/useStartAction';
import { useRunningSessions } from '../tasks/useRunningSessions';
import { primaryActionFor, isInProgress } from '../tasks/primaryAction.mjs';
import { isDone } from '../tasks/sections.mjs';
import './RosterTable.css';

const FILTER_PILLS: { id: 'all' | NewHomeStatus; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs', label: 'Needs Me' },
  { id: 'progress', label: 'In Progress' },
  { id: 'queued', label: 'Queued' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' },
];

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
};

const BASE_COLUMN_COUNT = 5; // Title, Status, Last Action, Who, Action

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

function RowAction({
  task,
  onOpenTask,
  onRetry,
  onStart,
  startEligible,
  chainStart,
  onChainStart,
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
  /** task-4045bcee23cb (U3a #1) / task-48cd46a0e2da — the parent-row chain
   *  action. `{childId,...}` → an eligible ▶ Start chain; `{disabled,reason}` →
   *  render a DISABLED ▶ Start chain with the reason as tooltip (never a bare —
   *  with no explanation — the round-8 silent no-op); null → not a chain row. */
  chainStart:
    | { childId: string; enabled: boolean; tooltip?: string }
    | { disabled: true; reason: string }
    | null;
  /** Route the chain-start click through the shared wrapper (owns pending/error). */
  onChainStart: (childId: string) => void;
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
  // ▶ Start — the SAME claim-then-launch path the old Tasks page's play button
  // fires (onStart → NewHomePage → useTaskActions().start → runTaskNow). Shown
  // only for rows primaryActionFor deems start-eligible (typebuild, open/queued,
  // unclaimed-or-mine-and-idle) — never a claimed-by-other, in-progress, blocked,
  // terminal, or parent-with-open-children row. stopPropagation so the click
  // launches instead of opening the detail dialog (mirrors Answer/Retry).
  // task-48cd46a0e2da — a pending state ("starting…") and an inline error make
  // the click's outcome always visible.
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
  // ▶ Start chain — task-4045bcee23cb (U3a #1) / task-48cd46a0e2da. The parent
  // itself has nothing startable (a container with open children — fm-bq86),
  // but the CHAIN may: launch the first runnable child. When the chain has
  // nothing runnable (all done/cancelled) or the next step isn't eligible, we
  // render a DISABLED button with the REASON as tooltip + inline — never a
  // silent — (the round-8 regression).
  if (chainStart) {
    const isDisabled = 'disabled' in chainStart;
    // Narrow explicitly so we never read `.enabled`/`.childId` off the disabled
    // arm (or `.reason` off the enabled arm).
    const reason = 'disabled' in chainStart ? chainStart.reason : undefined;
    const btnDisabled = isDisabled || ('enabled' in chainStart && !chainStart.enabled) || pending;
    return (
      <span className="nh-roster__action-wrap">
        <button
          type="button"
          className="nh-roster__action nh-roster__action--start"
          disabled={btnDisabled}
          title={'disabled' in chainStart ? chainStart.reason : chainStart.tooltip}
          onClick={(e) => {
            e.stopPropagation();
            if ('childId' in chainStart) onChainStart(chainStart.childId);
          }}
        >
          {pending ? 'Starting…' : '▶ Start chain'}
        </button>
        {(error || reason) && (
          <span className="nh-roster__action-error" role="alert" title={error ?? reason}>
            {`⚠ ${error ?? reason}`}
          </span>
        )}
      </span>
    );
  }
  return <span className="nh-roster__action-empty">{'—'}</span>;
}

// ─── chained-job subtable (task-a4397184def4, reworked task-b1fa5098da3e) ──
// A chained job's grouped per-task-def columns, derived from THAT job's own
// v2 ```task-template block (useChainedRoster) — never a project pref.
// Rendered as a nested subtable beneath the job's summary row.

/** metaStatus ('done'|'active'|'pending') → the roster pill class + label the
 *  built-in status column already ships. task-4045bcee23cb (U3a polish a) —
 *  the 'pending' bucket now says "Queued", matching STATUS_LABEL/FILTER_PILLS
 *  above (same `queued` pill class, same state, one token everywhere on the
 *  roster — a chained job row no longer says "Pending" while the stats card
 *  and every plain row for the identical state say "Queued"). */
const META_PILL: Record<ReturnType<typeof metaStatus>, { cls: NewHomeStatus; label: string }> = {
  done: { cls: 'done', label: 'Done' },
  active: { cls: 'progress', label: 'In Progress' },
  pending: { cls: 'queued', label: 'Queued' },
};

// task-4045bcee23cb (U3a) — per-step status chip label, rendered on a
// subtable GROUP HEADER (one per task-def). 'queued' — not 'pending' — to
// match the unified vocabulary above; 'n/a' for a conditionally-skipped step.
// task-f26e7745eda6 — 'cancelled' (grey, ≠ n/a) and 'failed' (retry) are the
// MERGED-in child server statuses.
const STEP_CHIP_LABEL: Record<MergedStepStatus, string> = {
  done: 'done',
  active: 'running',
  pending: 'queued',
  skip: 'n/a',
  cancelled: 'cancelled',
  failed: 'failed',
};

/** One subtable group-header's status chip — "done"/"running"/"queued"/"n/a",
 *  plus a ▶ affordance when this step is THE runnable one (task-4045bcee23cb
 *  U3a #2). Eligibility for the ▶ still goes through `startAction` (built by
 *  the caller from `primaryActionFor`, the U3 single source of truth) — this
 *  component only decides WHERE to show it (the runnable step's own header),
 *  never whether starting is allowed. */
function StepChip({
  status,
  runnable,
  startAction,
  onStart,
  running,
  autoStartError,
  pending,
}: {
  status: MergedStepStatus;
  runnable: boolean;
  /** null when there's no child to start yet, or primaryActionFor doesn't
   *  offer 'start' for it (e.g. claimed by someone else, already running). */
  startAction: { enabled: boolean; tooltip?: string } | null;
  onStart: () => void;
  /** task-48cd46a0e2da (A#3) — a manual per-step ▶ is in flight; show
   *  "Starting…" and disable so the click's outcome is visible, never silent. */
  pending?: boolean;
  /** task-c141c7765aa4 (#3) — true when the child is claimed/in_progress
   *  RIGHT NOW (isInProgress), regardless of whether any output has landed
   *  yet. Drives a "running headless" watch affordance so a claimed step is
   *  never just a silent "queued" chip while a session is (or should be)
   *  live somewhere. Ties to task-c14137435369 (session-start visibility) —
   *  this is only the minimal "it's running, here's where to look" surface,
   *  not that task's full solution. */
  running?: boolean;
  /** task-c141c7765aa4 (#1) — set when THIS step's auto-continue attempt just
   *  failed to spawn a session. Rendered inline so the failure is visible on
   *  the roster, not just a status-bar line that scrolls away. */
  autoStartError?: string | null;
}) {
  // task-3f0c6a6abe41 (#2) — OPTIMISTIC ROLLBACK. A recorded auto-start
  // failure for this step MUST win over any lingering "running" signal: the
  // launch promise rejected (or the claim was released), so the step is NOT
  // running regardless of a stale in_progress the source cache may still hold
  // for up to one system-poll interval. Force the running indicator off and
  // show the failure + ▶ instead, so the UI never says RUNNING while the
  // server says OPEN.
  const showRunning = !!running && !autoStartError && status === 'active';
  return (
    <span className="nh-pipe__step-chip-wrap">
      {/* task-3f0c6a6abe41 (#4) — the pill ALREADY reads "running" for an
          active step (STEP_CHIP_LABEL.active === 'running'); the live-session
          signal is just a pulsing dot ON the pill, not a second "running"
          word (which rendered the duplicated "RUNNING ● RUNNING"). */}
      <span
        className={
          `nh-pipe__step-chip nh-pipe__step-chip--${status}` +
          (showRunning ? ' nh-pipe__step-chip--live' : '')
        }
        title={
          showRunning
            ? 'A session is running for this step (headless — no visible tab yet)'
            : undefined
        }
      >
        {showRunning && <span className="nh-pipe__step-live-dot" aria-hidden="true" />}
        {STEP_CHIP_LABEL[status]}
      </span>
      {runnable && startAction && (
        <button
          type="button"
          className="nh-pipe__step-start"
          disabled={!startAction.enabled || !!pending}
          title={startAction.tooltip ?? 'Start this step'}
          onClick={(e) => {
            e.stopPropagation();
            onStart();
          }}
        >
          {pending ? '…' : '▶'}
        </button>
      )}
      {autoStartError && (
        <span className="nh-pipe__step-error" role="alert" title={autoStartError}>
          {`⚠ ${autoStartError}`}
        </span>
      )}
    </span>
  );
}

function hasCellValue(v: string | number | undefined): boolean {
  return v !== undefined && v !== null && v !== '';
}

/** Inline INPUT editor — the approved-prototype dashed-input pattern. Commits
 *  on blur (text/number/date) or on change (select/bool). Stops click/keydown
 *  from bubbling so focusing/typing never opens the child or triggers row
 *  keyboard-nav. PHI: the value lives in local state only, never logged. */
function PipelineInput({
  col,
  value,
  disabled,
  onCommit,
}: {
  col: PipelineColumn;
  value: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Keep the draft in sync when the resolved value changes underneath us
  // (e.g. a lazy detail fetch lands, or another client edits the child).
  useEffect(() => setDraft(value), [value]);

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };

  if (col.type === 'select' && col.options && col.options.length > 0) {
    return (
      <select
        className="nh-pipe__input nh-pipe__input--select"
        value={draft}
        disabled={disabled}
        onClick={stop}
        onKeyDown={stop}
        onChange={(e) => {
          setDraft(e.target.value);
          onCommit(e.target.value);
        }}
      >
        <option value="">—</option>
        {col.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (col.type === 'bool') {
    return (
      <select
        className="nh-pipe__input nh-pipe__input--select"
        value={draft}
        disabled={disabled}
        onClick={stop}
        onKeyDown={stop}
        onChange={(e) => {
          setDraft(e.target.value);
          onCommit(e.target.value);
        }}
      >
        <option value="">—</option>
        <option value="Yes">Yes</option>
        <option value="No">No</option>
      </select>
    );
  }
  const inputType = col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : 'text';
  return (
    <input
      className="nh-pipe__input"
      type={inputType}
      value={draft}
      disabled={disabled}
      placeholder="—"
      onClick={stop}
      onKeyDown={(e) => {
        stop(e);
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          // task-4045bcee23cb (U3a polish c) — Escape reverts the draft to the
          // last-committed value AND blurs, instead of merely stopping
          // propagation (which left the cursor/focus sitting in the input with
          // whatever half-typed text was there). Blur fires after the draft
          // reset below, so `commit`'s draft!==value check sees the reverted
          // draft and correctly no-ops (nothing to save).
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
    />
  );
}

/** One pipeline cell. INPUT cells are editable (dashed input); OUTPUT cells are
 *  read-only. A conditional-skipped def's cells render hatched `n/a`. Clicking
 *  the cell (outside the input) opens THAT def's child task. */
function PipelineCell({
  col,
  valuesByRef,
  childId,
  skipped,
  loading,
  onOpenChild,
  onSaveInput,
}: {
  col: PipelineColumn;
  valuesByRef: Record<string, string | number>;
  childId: string | undefined;
  skipped: boolean;
  loading: boolean;
  onOpenChild: (id: string) => void;
  onSaveInput: (childId: string, key: string, value: string) => void;
}) {
  const openChild = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    if (childId) onOpenChild(childId);
  };

  if (skipped) {
    return (
      <td
        className="nh-pipe__cell nh-pipe__cell--na"
        title="Not needed for this job"
        onClick={openChild}
      >
        <span className="nh-pipe__na">n/a</span>
      </td>
    );
  }

  const value = valuesByRef[fieldRef(col.taskDefId, col.key)];
  const has = hasCellValue(value);

  if (col.io === 'out') {
    const missing = col.required && !has;
    return (
      <td
        className={`nh-pipe__cell nh-pipe__cell--out${missing ? ' nh-pipe__cell--missing' : ''}`}
        onClick={openChild}
        title={missing ? undefined : col.label}
      >
        {has ? (
          <span className="nh-pipe__val">{String(value)}</span>
        ) : missing && !loading ? (
          // task-4045bcee23cb (U3a polish b) — a required-but-unsubmitted
          // output is no longer a plain "—*"; the dashed underline + tooltip
          // is the affordance (mirrors the dashed-input pattern PipelineInput
          // already uses for editable cells), so a missing required output
          // reads as "there's something here to notice", not stray punctuation.
          <span className="nh-pipe__empty nh-pipe__empty--missing" title="required — awaiting agent">
            —
          </span>
        ) : (
          <span className="nh-pipe__empty">{loading ? '·' : '—'}</span>
        )}
      </td>
    );
  }

  // INPUT cell — editable.
  return (
    <td className="nh-pipe__cell nh-pipe__cell--in" onClick={openChild} title={col.label}>
      <PipelineInput
        col={col}
        value={has ? String(value) : ''}
        disabled={!childId || loading}
        onCommit={(v) => {
          if (childId) onSaveInput(childId, col.key, v);
        }}
      />
    </td>
  );
}

/** A chained job's own grouped subtable — ONE data row of that job's
 *  aggregated valuesByRef, with its own header (built from that job's own
 *  defs, so heterogeneous chains across jobs render independently). */
function ChainedJobSubtable({
  jobId,
  agentRun,
  groups,
  resolution,
  onOpenTask,
  onSaveInput,
  allTasksById,
  onStartChild,
}: {
  /** task-6a14190fb2f7 — the job's own top-level task id. Auto-continue's
   *  localStorage pref and its claim-guard bookkeeping are keyed off this. */
  jobId: string;
  /** task-6a14190fb2f7 — "is this chain agent-run" (the parent row's `who` is
   *  not purely human). Auto-continue's DEFAULT-ON only ever applies to an
   *  agent-run chain — a human-run chain is never force-advanced against the
   *  user's will, regardless of the per-job pref. */
  agentRun: boolean;
  groups: PipelineGroup[];
  resolution: Extract<ChainedJobResolution, { status: 'chained' }>;
  onOpenTask: (id: string) => void;
  onSaveInput: (childId: string, key: string, value: string) => void;
  /** task-4045bcee23cb (U3a #2) — full-roster id→Task lookup, so the runnable
   *  group header can resolve its child's raw Task and run it through
   *  primaryActionFor (start-eligibility must never be guessed from the
   *  view-model alone). */
  allTasksById: Map<string, Task>;
  /** task-c141c7765aa4 — returns the StartOutcome (never throws) so the
   *  auto-continue effect can verify a session actually spawned instead of
   *  firing-and-forgetting the launch. */
  onStartChild: (childId: string) => Promise<StartOutcome>;
}) {
  const { valuesByRef, childIdByDefId, childrenLoading, defs } = resolution;
  const tbReady = useTypebuildReadiness();
  const actions = useTaskActions();
  // task-48cd46a0e2da (A#3) — the per-step ▶ Start also routes through the
  // shared wrapper so a MANUAL step start shows pending/error, never a silent
  // no-op (the auto-continue path keeps its own back-off error state below).
  const manualStart = useStartAction();
  const sessions = useRunningSessions();
  // task-f26e7745eda6 — def id → the child's LIVE server status (from the
  // full-roster raw Task, which is NOT stale — it tracks the system poll). The
  // pure status-derivation now consults this so a cancelled child is excluded
  // from runnable/next-step and rendered as 'cancelled', never 'queued'.
  const childByDefId = useMemo<Record<string, ChildStatusLike>>(
    () => childStatusMap(Object.entries(childIdByDefId), (id) => allTasksById.get(id)),
    [childIdByDefId, allTasksById],
  );
  const runnableId = useMemo(
    () => runnableStepId(defs, valuesByRef, childByDefId),
    [defs, valuesByRef, childByDefId],
  );

  // task-6a14190fb2f7 (#3) — terminal state. The SERVER already flips the
  // parent to 'done' once every child resolves (the chain "reads done" per
  // the live E2E report) — metaStatus here just mirrors that in the UI; this
  // component never double-writes the parent's status itself.
  const meta = useMemo(() => metaStatus(defs, valuesByRef), [defs, valuesByRef]);
  const justCompletedRef = useRef(false);
  const wasDoneRef = useRef(meta === 'done');
  if (meta === 'done' && !wasDoneRef.current) justCompletedRef.current = true;
  wasDoneRef.current = meta === 'done';

  // ── auto-continue (#2) ────────────────────────────────────────────────────
  // A per-job toggle (chainAutoContinuePrefs, default ON for an agent-run
  // chain) that automatically starts the next runnable child the instant it
  // becomes runnable, instead of waiting for a human to notice the "ready ▶"
  // chip and click it. Durable home for this is server-side dispatch/breezed
  // (the client shouldn't need to be open for a chain to advance) — this is
  // the client-side implementation until that lands.
  const [autoOn, setAutoOnState] = useState(() => isAutoContinueOn(jobId));
  useEffect(() => setAutoOnState(isAutoContinueOn(jobId)), [jobId]);
  const toggleAuto = () => {
    const next = !autoOn;
    setAutoOnState(next);
    setAutoContinue(jobId, next);
  };

  const nextChildId = useMemo(
    () => nextAutoContinueChildId(defs, valuesByRef, childIdByDefId, childByDefId),
    [defs, valuesByRef, childIdByDefId, childByDefId],
  );
  // Guard against double-start WHILE A LAUNCH IS IN FLIGHT: track the child id
  // we're currently awaiting a start for so a re-render (or the fast poll's
  // next tick, before the child's own status has caught up) never calls start
  // twice concurrently for the same step. This is belt-and-suspenders on top
  // of primaryActionFor + the server's claim (a claimed/in_progress child's
  // primaryActionFor is never 'start', so a second start simply isn't
  // attempted; and even if it raced through, the server's claim rejects a
  // contested start with {ok:false}).
  //
  // task-c141c7765aa4 (ROOT CAUSE FIX #1) — this guard used to be a
  // fire-and-forget PERMANENT mark (autoStartedForRef never cleared), so once
  // onStartChild's underlying claim-then-launch succeeded at the CLAIM half
  // but failed at the LAUNCH half (no focused/open window — the common case
  // for a background auto-continue tick with no user gesture), the effect
  // never tried again: the step sat claimed with no session and no retry,
  // invisible until the 2h TTL. Now we AWAIT the full outcome; only a
  // genuinely SPAWNED session (outcome.spawned) keeps the guard set. Any
  // failure clears the guard (so the effect retries once the step is
  // re-runnable — e.g. after the claim-release below) and records a visible
  // per-step error the chip renders inline instead of a silent stall.
  const autoStartInFlightRef = useRef<string | null>(null);
  const [autoStartErrors, setAutoStartErrors] = useState<Record<string, string>>({});

  // task-6fc9e503623e — when auto-continue is toggled back ON, clear the
  // back-off errors so a freshly re-enabled chain gets one clean attempt per
  // step again (matches the tester's "uncheck to freeze, re-check to retry"
  // workflow). Keyed off `autoOn` flipping true.
  const prevAutoOnRef = useRef(autoOn);
  useEffect(() => {
    if (autoOn && !prevAutoOnRef.current) setAutoStartErrors({});
    prevAutoOnRef.current = autoOn;
  }, [autoOn]);

  // Manual ▶ from a step chip: clear the auto-continue back-off error for that
  // child (an explicit human retry) AND route through the shared wrapper so the
  // click shows pending/error and can never be silent (task-48cd46a0e2da A#3).
  const startChildManually = (childId: string) => {
    setAutoStartErrors((prev) => {
      if (!(childId in prev)) return prev;
      const next = { ...prev };
      delete next[childId];
      return next;
    });
    void manualStart.run(childId, { kind: 'start', run: () => onStartChild(childId) });
  };

  useEffect(() => {
    if (!autoOn || !agentRun || !nextChildId) return;
    if (childrenLoading) return; // don't act on a partially-loaded job
    if (autoStartInFlightRef.current === nextChildId) return; // already in flight
    // task-6fc9e503623e (BACK-OFF) — do NOT re-attempt a step that just failed
    // to STAY ALIVE. Without this, auto-continue re-claims the same step on
    // every poll (claim → early-exit → release → runnable again → claim …),
    // the observed churn loop. A recorded error freezes auto-retry for that
    // child until it's manually retried (clears the error) or auto-continue is
    // re-toggled (clears all). This is the regression guard: one auto attempt
    // per step per enablement, never an infinite claim/release cycle.
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
    // child is start-eligible right now — never claimed/in_progress/done
    // (those all resolve to a non-'start' kind, see primaryAction.mjs).
    if (pa.kind !== 'start' || !pa.enabled) return;
    autoStartInFlightRef.current = nextChildId;
    void onStartChild(nextChildId).then((outcome: StartOutcome) => {
      if (outcome.ok && outcome.spawned) {
        // A real, LIVE session came up (useTaskActions gates `spawned` on the
        // liveness verdict now) — keep the guard set so we never double-fire.
        return;
      }
      // Launch failed OR the child exited within the liveness window. The
      // claim was already released by useTaskActions().start; record the
      // reason (which now includes the exit code for an early exit) so the
      // chip surfaces it AND the BACK-OFF above stops the churn loop.
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

  return (
    <>
      <div className="nh-pipe__chain-bar">
        {meta === 'done' ? (
          <span className="nh-pipe__chain-celebration" role="status">
            {'✓ Chain complete'}
            {justCompletedRef.current && <span className="nh-pipe__chain-celebration-badge">just now</span>}
          </span>
        ) : (
          <label className="nh-pipe__auto-continue" title="Automatically start the next step when the previous one finishes">
            <input type="checkbox" checked={autoOn} onChange={toggleAuto} />
            <span>Auto-continue</span>
          </label>
        )}
      </div>
      <table className="nh-pipe__table nh-pipe__subtable">
      <thead>
        <tr>
          {groups.map((g) => {
            const def = defs.find((d) => d.id === g.taskDefId);
            const baseStatus = def ? taskDefStatus(def, valuesByRef) : 'pending';
            const childId = childIdByDefId[g.taskDefId];
            const child = childId ? allTasksById.get(childId) : undefined;
            // task-48cd46a0e2da (A#3) — surface EITHER the auto-continue
            // back-off error OR the manual per-step wrapper error (whichever is
            // set) so a failed manual ▶ is never silent.
            const stepError = childId
              ? autoStartErrors[childId] ?? manualStart.errorFor(childId)
              : null;
            const stepPending = childId ? manualStart.pendingFor(childId) : false;
            const liveSession = child ? sessions.get(child.id) : undefined;
            // task-c141c7765aa4 / task-3f0c6a6abe41 / task-6fc9e503623e —
            // "Is this step's session actually live right now?" RE-DERIVED FROM
            // SERVER TRUTH every render: server says in_progress OR we hold a
            // live local session — AND no recorded auto-start failure. The
            // `!stepError` gate is the optimistic rollback: the instant a launch
            // rejects/early-exits, this goes false so the chip never lies
            // RUNNING while the server says OPEN, even before the next poll.
            const childRunning =
              !stepError && !!child && (isInProgress(child) || !!liveSession);
            // task-f26e7745eda6 — merge the child's AUTHORITATIVE server status:
            // cancelled → grey 'cancelled' (excluded from runnable); failed/
            // blocked → 'failed'; in_progress → 'active'. A cancelled/failed
            // child reads that way regardless of output values or run signal.
            const merged = mergeChildStatus(baseStatus, toChildStatus(child));
            // The chip's final status. Only a still-runnable step (pending or
            // output-partial 'active') reflects the LIVE run signal: shown as
            // 'active' when childRunning, else demoted to the pure output-
            // derived base (so a step with a recorded failure or no live session
            // reads its real output progress — 'pending'/'active' — not a stale
            // server 'in_progress'). Terminal/frozen states (done/skip/
            // cancelled/failed) are authoritative and pass through untouched —
            // listed POSITIVELY so a future status can't silently fall into the
            // run-signal branch (reviewer Angle-E #3).
            const status: MergedStepStatus =
              merged === 'pending' || merged === 'active'
                ? childRunning
                  ? 'active'
                  : baseStatus
                : merged;
            const runnable = g.taskDefId === runnableId;
            // task-4045bcee23cb (U3a) — same actionsFor eligibility rule as the
            // row-level ▶ Start and the parent's Start-chain: never invent a
            // second rule for "can this step be started".
            const startAction =
              child &&
              (() => {
                const pa = primaryActionFor(child, {
                  caps: actions.caps(child),
                  tbReady,
                  myEmail: tbReady.email,
                  session: sessions.get(child.id),
                });
                return pa.kind === 'start' ? { enabled: pa.enabled, tooltip: pa.tooltip } : null;
              })();
            return (
              <th key={g.taskDefId} colSpan={g.columns.length} className="nh-pipe__group-th" title={g.name}>
                <span className="nh-pipe__group-name">{g.name}</span>
                <StepChip
                  status={status}
                  runnable={runnable}
                  startAction={startAction ?? null}
                  onStart={() => childId && startChildManually(childId)}
                  running={childRunning}
                  autoStartError={stepError}
                  pending={stepPending}
                />
              </th>
            );
          })}
        </tr>
        <tr>
          {groups.flatMap((g) =>
            g.columns.map((col) => (
              <th
                key={`${g.taskDefId}.${col.key}.${col.io}`}
                className={`nh-pipe__field-th nh-pipe__field-th--${col.io}`}
                title={`${g.name} · ${col.label} · ${col.io === 'in' ? 'input' : 'output'}${col.required ? ' · required' : ''}`}
              >
                <span className="nh-pipe__field-label">{col.label}</span>
                <span className={`nh-pipe__io nh-pipe__io--${col.io}`}>
                  {col.io === 'in' ? 'IN' : 'OUT'}
                </span>
                {col.required && <span className="nh-pipe__req">REQ</span>}
              </th>
            )),
          )}
        </tr>
      </thead>
      <tbody>
        <tr>
          {groups.map((g) => {
            const skipped = !!g.neededWhen && !evalCondition(g.neededWhen, valuesByRef);
            const childId = childIdByDefId[g.taskDefId];
            return g.columns.map((col) => (
              <PipelineCell
                key={`${g.taskDefId}.${col.key}.${col.io}`}
                col={col}
                valuesByRef={valuesByRef}
                childId={childId}
                skipped={skipped}
                loading={childrenLoading}
                onOpenChild={onOpenTask}
                onSaveInput={onSaveInput}
              />
            ));
          })}
        </tr>
      </tbody>
      </table>
    </>
  );
}

export function RosterTable({
  tasks,
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
   *  Resolves with the StartOutcome (never throws) so the chained subtable's
   *  auto-continue effect can verify a session actually spawned before it
   *  treats the step as "handled" (task-c141c7765aa4). Manual callers (the
   *  row ▶ Start / Retry buttons) ignore the resolved value. */
  onStart: (id: string) => Promise<StartOutcome>;
  /** Optional — NewHomePage today drives filtering via HeroStats cards and
   *  pre-filters `tasks` before passing them down, so this pill bar is not
   *  yet wired to a live callback from the shell. Kept optional so this
   *  component still compiles/renders correctly against the current
   *  NewHomePage call site; wire this up from NewHomePage in a follow-up so
   *  the pills become the second, always-visible way to change `filter`
   *  (matching the V11 reference's toolbar). Until then the pills reflect
   *  the current `filter` and are a no-op if clicked without a handler. */
  onFilter?: (f: 'all' | NewHomeStatus) => void;
  /** Set the free-text search query. Optional so older call sites still
   *  compile; when absent the search box is hidden. */
  onSearch?: (query: string) => void;
  /** Optional — NewHomePage doesn't thread its `loading` flag down to this
   *  component yet; wire it in a follow-up so the table can show a skeleton
   *  during the initial fetch instead of a bare "No tasks" flash. */
  loading?: boolean;
}) {
  // Defensive: filter locally too, in case a future caller passes an
  // unfiltered `tasks` array alongside a real `filter` value.
  const rows = useMemo(
    () => (filter === 'all' ? tasks : tasks.filter((t) => t.status === filter)),
    [tasks, filter],
  );

  // ── ▶ Start eligibility (reuses the OLD Tasks page's exact rule) ───────────
  // primaryActionFor is the single source of truth for a row's primary action;
  // we render Start exactly when it returns kind:'start'. Its ctx is the same
  // the old page assembles: source capabilities, TypeBuild readiness + my email
  // (claimed-by-me vs claimed-by-other), any live local session tab, and whether
  // this row is a container parent with still-open children (a parent can't be
  // Started until its children resolve — fm-bq86). `allTasks` is the FULL,
  // UNFILTERED roster so a status filter that hides a parent's open children
  // can't make it falsely look start-eligible. PHI: no task text is read here —
  // only ids/status/claim/parent metadata.
  const tbReady = useTypebuildReadiness();
  const sessions = useRunningSessions();
  const actions = useTaskActions();
  // task-48cd46a0e2da — the SHARED start wrapper: EVERY start affordance in
  // this component (row ▶ Start, parent ▶ Start-chain, per-step ▶, Retry)
  // routes through it, so none can be silent. It owns pending/error UI keyed by
  // the row/parent id; the RowAction renders errorFor(id) inline.
  const startAction = useStartAction();
  const { tasks: allTasks } = useTasks({ includeDone: true });
  const openChildParentIds = useMemo(() => {
    const set = new Set<string>();
    for (const t of allTasks) {
      if (t.parentTaskId && !isDone(t)) set.add(t.parentTaskId);
    }
    return set;
  }, [allTasks]);
  // task-4045bcee23cb (U3a) — id → raw Task lookup so a chained job's step
  // chips / parent Start-chain can resolve a CHILD's full Task (primaryActionFor
  // needs the whole object, not just an id) without each subtable re-fetching.
  const allTasksById = useMemo(() => new Map(allTasks.map((t) => [t.id, t])), [allTasks]);
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

  // task-4045bcee23cb (U3a #1) / task-48cd46a0e2da — "▶ Start chain": for a
  // chained-job parent row, resolve the first RUNNABLE child (chainStartTarget,
  // which now SKIPS cancelled steps and, when nothing is runnable, returns an
  // explicit REASON so the click is never silent). Returns one of:
  //   - { childId, enabled, tooltip }         → a real, eligible start
  //   - { disabled:true, reason }             → nothing to start / not eligible,
  //                                             with a human reason to surface
  //   - null                                  → not a chain-start row at all
  //                                             (the parent's own Start applies)
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
      // A genuinely COMPLETE chain is the calm terminal state — show no action
      // (—), not a disabled button + warning on every finished row. But a chain
      // that's stuck because its remaining step is CANCELLED (or still loading)
      // IS actionable news: surface the disabled button + reason so the click
      // isn't silent and the user knows to reopen the step.
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
    // The runnable child exists but isn't a fresh Start right now. If it's
    // already RUNNING/claimed (open-session, or an in-progress note), that's the
    // normal in-flight state — the subtable's own step chip conveys it, so the
    // parent row stays calm (no button).
    if (pa.kind === 'open-session') return null;
    // task-48cd46a0e2da (A#1) — a BLOCKED next step resolves to 'reopen', not
    // 'start'. That's actionable: tell the user to open the step and reopen it,
    // rather than the generic (and wrong) "can't be started right now".
    if (pa.kind === 'reopen') {
      return { disabled: true, reason: `${target.stepName} is blocked — open it to reopen/continue` };
    }
    const note = pa.kind === 'none' ? pa.note ?? '' : '';
    if (/in progress|claimed/i.test(note)) return null;
    const reason = note ? `${target.stepName}: ${note}` : `${target.stepName}: can’t be started right now`;
    return { disabled: true, reason };
  };

  // ── chained-job detection (task-b1fa5098da3e, R3) ─────────────────────────
  // Candidate jobs: top-level rows (no parentTaskId) with at least one child
  // — the only rows that could possibly be a chained task (a childless task
  // has nothing to aggregate). useChainedRoster resolves each candidate's OWN
  // body lazily to learn whether it's actually chained (v2 task-template
  // block) and, if so, its per-def values.
  const candidateJobIds = useMemo(
    () => partitionJobs(rows.map((t) => ({ id: t.id, parentTaskId: t.raw.parentTaskId ?? null }))).jobIds,
    [rows],
  );
  const chained = useChainedRoster({ jobIds: candidateJobIds });
  const resolutions = useMemo(() => {
    const map = new Map<string, ChainedJobResolution>();
    for (const id of candidateJobIds) map.set(id, chained.resolveJob(id));
    return map;
  }, [candidateJobIds, chained]);

  // A chained job's children are folded into its subtable — don't ALSO give
  // them their own top-level row (a non-chained parent's children still
  // render as plain rows, matching classic behavior).
  const hiddenChildIds = useMemo(() => {
    const set = new Set<string>();
    for (const res of resolutions.values()) {
      if (res.status === 'chained') {
        for (const cid of Object.values(res.childIdByDefId)) set.add(cid);
      }
    }
    return set;
  }, [resolutions]);

  const visibleRows = useMemo(
    () => rows.filter((t) => !hiddenChildIds.has(t.id)),
    [rows, hiddenChildIds],
  );

  const hasAnyTasks = tasks.length > 0;
  const isFiltered = filter !== 'all' || !!search.trim();
  // "Clear" resets BOTH dimensions so one click always gets you back to the
  // full roster, regardless of which filter emptied it.
  const clearFilter = () => {
    onFilter?.('all');
    onSearch?.('');
  };

  // task-1af4f59428eb (Item 4) — j/k + arrow-key row navigation, SCOPED to
  // this table: the handler lives on <tbody>'s onKeyDown (React's synthetic
  // bubble phase), fires only while focus is already inside the roster (a
  // row has tabIndex=0 and DOM focus), and calls stopPropagation so the key
  // never reaches src/useKeyboard.ts's window-level listener — the SAME
  // scoping pattern BrowserSurface uses for its Chromium shortcuts
  // (`.browser-pane`'s onKeyDown, never a document/window listener). This is
  // additive: it only handles j/k/ArrowUp/ArrowDown/Enter while a <tr> has
  // focus; clicking a row (onOpenTask) and the existing per-row Enter handler
  // are untouched, so nothing that worked today changes.
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());

  const focusRow = (id: string) => {
    rowRefs.current.get(id)?.focus();
  };

  const onBodyKeyDown = (e: ReactKeyboardEvent<HTMLTableSectionElement>) => {
    // Only handle when a ROW itself has focus (not e.g. the search input or
    // a row's Answer/Retry button) — mirrors BrowserSurface's "only fires
    // when focus is inside the surface" scoping, one level tighter.
    const target = e.target as HTMLElement;
    if (!target.dataset || target.dataset.rosterRow == null) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return; // don't shadow any chord

    const ids = visibleRows.map((t) => t.id);
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
      // Already handled per-row below; stop it here too so a future refactor
      // that removes the per-row handler doesn't silently lose Enter-to-open.
      e.stopPropagation();
      onOpenTask(currentId);
    }
  };

  return (
    <div className="nh-roster">
      <div className="nh-roster__toolbar">
        <div className="nh-roster__pills" role="tablist" aria-label="Filter tasks by status">
          {FILTER_PILLS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={filter === p.id}
              className={`nh-roster__pill-btn${filter === p.id ? ' nh-roster__pill-btn--active' : ''}`}
              onClick={() => onFilter?.(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        {onSearch && (
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
        )}
      </div>

      <div className="nh-roster__table-wrap">
        <table className="nh-roster__table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Last Action</th>
              <th>Who</th>
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
            {!loading && visibleRows.length === 0 && isFiltered && (
              <tr>
                <td colSpan={BASE_COLUMN_COUNT} className="nh-roster__empty">
                  No tasks match {search.trim() ? <>“{search.trim()}”</> : 'this filter'}.{' '}
                  <button type="button" className="nh-roster__clear-filter" onClick={clearFilter}>
                    Clear filter
                  </button>
                </td>
              </tr>
            )}
            {visibleRows.map((t) => {
              const resolution = resolutions.get(t.id);
              const chainedRes = resolution && resolution.status === 'chained' ? resolution : null;
              const isChained = !!chainedRes;
              const groups = chainedRes ? pipelineColumns(chainedRes.defs) : [];
              const meta = chainedRes ? META_PILL[metaStatus(chainedRes.defs, chainedRes.valuesByRef)] : null;
              const rowTint =
                t.status === 'needs'
                  ? 'nh-roster__row--needs'
                  : t.status === 'failed'
                    ? 'nh-roster__row--failed'
                    : '';
              return (
                <Fragment key={t.id}>
                  <tr
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
                    </td>
                    <td>
                      {t.live && (
                        <span
                          className="nh-roster__live-dot"
                          aria-hidden="true"
                          title={liveTooltip(t)}
                        />
                      )}
                      <span
                        className={`nh-roster__pill nh-roster__pill--${meta ? meta.cls : t.status}`}
                      >
                        {meta ? meta.label : STATUS_LABEL[t.status]}
                      </span>
                    </td>
                    <td className="nh-roster__last-action" title={t.lastActionDetail}>
                      {t.lastAction}
                    </td>
                    <td className="nh-roster__who" title={t.who}>
                      {WHO_GLYPH[t.who]}
                    </td>
                    <td className="nh-roster__action-cell">
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
                        chainStart={chainedRes ? chainStartFor(chainedRes) : null}
                        onChainStart={(childId) => {
                          // Key the pending/error on the PARENT row id (t.id),
                          // but launch the CHILD — so the parent row shows the
                          // pending/error for its own ▶ Start chain click.
                          void startAction.run(t.id, { kind: 'start', run: () => onStart(childId) });
                        }}
                        pending={startAction.pendingFor(t.id)}
                        error={startAction.errorFor(t.id)}
                      />
                    </td>
                  </tr>
                  {isChained && chainedRes && (
                    <tr className="nh-roster__subrow">
                      <td colSpan={BASE_COLUMN_COUNT} className="nh-roster__subrow-cell">
                        <ChainedJobSubtable
                          jobId={t.id}
                          // task-6a14190fb2f7 — "agent-run chain" gate for
                          // auto-continue's default-ON: t.who is never purely
                          // 'human' for a row whose ball a human currently
                          // holds (deriveWho routes any open pending_question
                          // to 'human' — see useNewHomeData.ts), so excluding
                          // 'human' here is exactly "don't force-advance a
                          // chain the human is actively driving/waiting on".
                          agentRun={t.who !== 'human'}
                          groups={groups}
                          resolution={chainedRes}
                          onOpenTask={onOpenTask}
                          onSaveInput={(childId, key, value) => {
                            void chained.saveInput(childId, key, value);
                          }}
                          allTasksById={allTasksById}
                          onStartChild={onStart}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
