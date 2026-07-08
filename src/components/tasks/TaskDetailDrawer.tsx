// task-5e9d866a377f — Project-scoped task detail DRAWER.
//
// A slide-in sheet (right-docked) that makes EVERY task openable into a full
// view, borrowing the drawer pattern from variation-11 (command-console) and
// the live-status treatment from variation-12 (living-timeline), rendered in
// the app's real tokens + components.
//
// Segmented into three tabs — Trace · Config · Session — defaulting to TRACE
// for an in-flight/just-run task and CONFIG otherwise:
//
//   TRACE   — the live run timeline (steps of a running/completed run), driven
//             by useTaskRuns (local-auto) / the TypeBuild raw status. The
//             live status pulses while working/claimed.
//   CONFIG  — notes, schedule (recurring cron + next/last run), dependencies /
//             parent-child, and the EFFECTIVE INSTRUCTION SET with provenance
//             from the foundation resolver ("8 — 4 project · 2 payer:HMO · 1
//             task"). Teach-in-the-moment lives here: save a correction to a
//             chosen SCOPE (this task / a category / the project).
//   SESSION  — the terminal / "what happened": for in-progress tasks, focus the
//             live session tab; for completed runs, open the trace (resume).
//
// Header carries the live status + a STOP control (running tasks) and an
// ENTER-THREAD control (in_progress / waiting). PHI: the decrypted body is
// fetched lazily, held in component state ONLY, and dropped on task change /
// unmount — never persisted or logged.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOverlayExit } from '../../useOverlayExit';
import { useStore } from '../../store';
import { fm } from '../../bridge';
import {
  cancelTaskRun,
  getTask,
  taskSourceAction,
  useTaskRuns,
  useTaskSources,
  useTypebuildReadiness,
  postTaskMessage,
  formatMessageSendReason,
  injectMessageIntoSession,
} from '../../tasks';
import { useOpenResumeInTab } from '../../openResumeInTab';
import { useRunningSessions } from './useRunningSessions';
import { useTaskActions } from './useTaskActions';
import { useStartAction } from './useStartAction';
import { primaryActionFor } from './primaryAction.mjs';
import type { PrimaryAction } from './primaryAction.mjs';
import { PrimaryActionButton } from './PrimaryActionButton';
import { formatOpError, formatSourceReason } from '../../errorMessages';
import { TaskStatusDot } from '../TaskIndicators';
import { homeRel } from './helpers';
import { claimSummary } from './lifecycle.mjs';
import { TaskTimeline } from './TaskTimeline';
import { TaskResultView } from './TaskResult';
import {
  parseTaskFieldsBlock,
  parseTaskOutputsBlock,
  parseTaskTemplateBlock,
  replaceTaskFieldsBlock,
  resultFields,
  taskDefStatus,
  fieldRef,
} from '../newhome/taskSchema.mjs';
import { TaskDataInputs } from './TaskDataInputs';
import {
  runnableStepId,
  mergeChildStatus,
  childStatusMap,
  toChildStatus,
  resolveFieldedJob,
  fieldedSchemaSource,
} from '../newhome/pipelineRoster.mjs';
import type { ChildStatusLike } from '../newhome/pipelineRoster.mjs';
import type { MergedStepStatus } from '../newhome/taskSchema.mjs';
import type { TaskDef, TaskDefField } from '../newhome/types';
import '../TasksPage.css';
import { resolveEffectiveInstructions } from '../../projects/index.mjs';
import type {
  CategoryScopeSource,
  ResolvedInstructions,
} from '../../projects/index.mjs';
import { TaskComposer } from '../TaskComposer';
import { TaskAnswerBox } from './TaskAnswerBox';
import { isDone } from './sections.mjs';
import type { Project, Task, TaskRun } from '../../types';
import { CopyButton } from '../CopyButton';
import './TaskDetailDrawer.css';

// task-b30e546672db — the former 'config' tab IS the task itself. It's renamed
// "Task details", made the FIRST tab, and rendered by reusing the new-task
// composer form (prefilled + editable). The legacy 'config' id is accepted on
// the `initialTab` prop and mapped to 'details' for back-compat with callers
// (TasksPage's openDetail still passes 'config').
// task-75f0715aa3ee — "Teach" is now a top-level tab (a SCOPE PICKER: Project /
// Category / Task) sitting right after "Task details". The former inline
// "+ Teach" button inside the Details tab deep-links here so there is exactly
// ONE teach editor and ONE write-back (persistTeach) — no forked persistence.
// task-f60a8003efa9 — Trace + Session are CLUBBED into one "Activity" tab (the
// run timeline + the live/replay session surface together), and that tab is
// shown only when there's a run/session to show. The legacy 'trace'/'session'
// ids are accepted on `initialTab` and mapped onto 'activity' for back-compat.
type DrawerTab = 'details' | 'teach' | 'activity';
type InitialTab = DrawerTab | 'config' | 'trace' | 'session';
function normalizeTab(t: InitialTab | undefined): DrawerTab | undefined {
  if (t === 'config') return 'details';
  if (t === 'trace' || t === 'session') return 'activity';
  return t;
}

// task-a763ca5be676 — humanize an ISO "asked_at" for the pinned-question card's
// attribution line. Falls back to the raw string if it doesn't parse. NON-PHI.
function formatAskedAt(asked_at: string): string {
  const ms = Date.parse(asked_at);
  if (Number.isNaN(ms)) return asked_at;
  return `asked ${new Date(ms).toLocaleString()}`;
}

// task-69651204e222 — small local helpers for the ported task-template /
// attachments sections (mirrors TaskDetailDialog's local helpers).
function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) || p : trimmed;
}
function hasValue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}
// task-4045bcee23cb (U3a polish a) — 'pending' says "Queued" here too, matching
// the roster's own status vocabulary (STATUS_LABEL/META_PILL in RosterTable.tsx)
// so a step never says "Pending" in one place and "Queued" in another for the
// identical not-yet-started state.
const DEF_STATUS_LABEL: Record<MergedStepStatus, string> = {
  done: 'Done',
  active: 'In progress',
  pending: 'Queued',
  skip: 'Not needed',
  // task-f26e7745eda6 — merged-in from the child's server status.
  cancelled: 'Cancelled',
  failed: 'Failed',
};

// A live-status descriptor: the ONE colored signal per the design language
// (working=accent, needs-you=warn, blocked=err, neutral otherwise).
type LiveTone = 'working' | 'needs-you' | 'blocked' | 'done' | 'neutral';

// task-875c6ad17f85 — render every status in Title Case. The header used Title
// Case for the common states but let `cancelled`/`failed`/`pending`/unknown
// fall through to raw lowercase, and the Trace timeline printed the raw
// `{r.status}` — so casing was inconsistent across the drawer. This single map
// (+ statusLabel fallback) is the source of truth, reused by liveToneFor AND
// TraceTab.
const STATUS_LABELS: Record<string, string> = {
  running: 'Working',
  in_progress: 'Working',
  working: 'Working',
  claimed: 'Claimed',
  blocked: 'Blocked',
  waiting: 'Needs you',
  needs_input: 'Needs you',
  partial: 'Needs you',
  pending: 'Pending',
  open: 'Open',
  queued: 'Queued',
  done: 'Done',
  succeeded: 'Done',
  completed: 'Done',
  cancelled: 'Cancelled',
  canceled: 'Cancelled',
  failed: 'Failed',
  error: 'Failed',
};
function statusLabel(raw: string | null | undefined): string {
  const key = (raw ?? '').toLowerCase();
  if (STATUS_LABELS[key]) return STATUS_LABELS[key];
  if (!key) return '—';
  // Unknown status: Title-Case it (snake/kebab → spaces) rather than dumping raw.
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function liveToneFor(task: Task, running: boolean): { tone: LiveTone; label: string } {
  const raw = (task.rawStatus ?? task.status).toLowerCase();
  if (running || raw === 'running' || raw === 'in_progress' || raw === 'working' || raw === 'claimed')
    return { tone: 'working', label: running ? 'Working' : raw === 'claimed' ? 'Claimed' : 'Working' };
  if (raw === 'blocked') return { tone: 'blocked', label: 'Blocked' };
  if (raw === 'waiting' || raw === 'needs_input' || raw === 'partial')
    return { tone: 'needs-you', label: 'Needs you' };
  if (raw === 'done' || raw === 'succeeded' || raw === 'completed')
    return { tone: 'done', label: 'Done' };
  return { tone: 'neutral', label: statusLabel(raw) };
}

// task-fdf3dc6b3c5c — humanize a structured teach-persist failure reason into a
// clear one-liner for the teach UI. Covers the server's owner/PHI/claim/
// visibility vocabularies for both the project PATCH and the per-task note.
function teachReason(scope: 'project' | 'task', reason: string): string {
  switch (reason) {
    case 'not_owner':
      return 'Only the project owner can edit its instructions.';
    case 'phi_rejected':
      return 'That looks like it contains PHI — keep teaching text PHI-free.';
    case 'claim_conflict':
      return 'Claim this task first to add a note.';
    case 'empty':
      return 'Nothing to save.';
    case 'not_visible':
      return scope === 'project' ? 'Project not found.' : 'Task not found.';
    default:
      return 'Couldn’t save the correction.';
  }
}

export function TaskDetailDrawer({
  task,
  initialTab,
  roster,
  onOpenTask,
  onClose,
}: {
  task: Task;
  initialTab?: InitialTab;
  // task-69651204e222 — OPTIONAL roster snapshot + child-open callback, used
  // ONLY by the ported Pipeline rollup to resolve a meta-parent's children
  // (matched via `parentTaskId === task.id`) and jump between them. Omitted or
  // empty ⇒ the Pipeline section has nothing to resolve, exactly like a task
  // with no `task-template` block (NON-REGRESSION).
  roster?: Task[];
  onOpenTask?: (id: string) => void;
  onClose: () => void;
}) {
  const { exit, state } = useOverlayExit(onClose);
  const { dispatch } = useStore();
  const actions = useTaskActions();
  // task-48cd46a0e2da — shared start wrapper for the Pipeline rollup's ▶.
  const stepStartAction = useStartAction();
  const { byId: sourcesById } = useTaskSources();
  const tbReady = useTypebuildReadiness();
  const myEmail = (tbReady as { email?: string | null }).email ?? null;
  const sessions = useRunningSessions();
  const openResumeInTab = useOpenResumeInTab();

  const caps = task.source ? sourcesById[task.source]?.capabilities : undefined;
  const isTypebuild = task.source === 'typebuild';
  const isLocalAuto = (!task.source || task.source === 'local') && !!task.auto_mode;

  // Live runs (local-auto) — drives the Trace timeline + "running" signal.
  const runs = useTaskRuns(isLocalAuto || task.auto_mode ? task.id : null, 25);
  const latestRun = runs[0] ?? null;
  const session = sessions.get(task.id);
  const running =
    !!session ||
    latestRun?.status === 'running' ||
    latestRun?.status === 'queued' ||
    latestRun?.status === 'retrying';

  const { tone, label: liveLabel } = liveToneFor(task, running);

  // Attachments — run output_path values, deduped. (No `body` dependency.)
  const attachments = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ path: string; name: string }> = [];
    for (const r of runs) {
      if (r.output_path && !seen.has(r.output_path)) {
        seen.add(r.output_path);
        list.push({ path: r.output_path, name: basename(r.output_path) });
      }
    }
    return list;
  }, [runs]);

  // Talk-back (free-text message) — mirrors TaskDetailDialog.sendMessage's
  // exact call shape (postTaskMessage → inject into live session / resume).
  const [messageDraft, setMessageDraft] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [messageSent, setMessageSent] = useState<string | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setMessageDraft('');
    setSendingMessage(false);
    setMessageError(null);
    setMessageSent(null);
  }, [task.id]);

  const say = useCallback(
    (msg: string) => dispatch({ type: 'setStatus', msg }),
    [dispatch],
  );

  // ── PHI body (lazy, memory-only) ──────────────────────────────────────────
  const [body, setBody] = useState<string | null>(task.notes ?? null);
  // task-9ab05f87eda3 (p9 REOPENED, round-19) — the drawer is opened from a
  // LIST/roster row (via the `fm:openTaskDetail` event — App.tsx, NewHomePage,
  // TasksPage, ProjectsPage, copilot taskActions all pass the in-memory row
  // verbatim, never a freshly-fetched detail). `mapListRow` (electron/sources/
  // typebuild.ts) never populates `outputSchema`/`result` — only `mapDetail`
  // does. This drawer ALREADY fetches the full detail below (for `body`) but
  // used to keep only `full.notes` and throw away `full.outputSchema` /
  // `full.result` — so `fieldedJob` kept reading the stale, always-undefined
  // `task.outputSchema` from props. Same wire-threading gap the roster hit
  // (task-ce4b4c8ca955 round-18, fixed via `fieldedSchemaSource(detail,
  // listRow)`); fixed here the same way — reusing that SAME helper rather than
  // inventing a second schema-preference rule — plus threading `result` too.
  const [detailSchema, setDetailSchema] = useState<Task['outputSchema'] | null>(null);
  const [detailResult, setDetailResult] = useState<Task['result'] | null>(null);
  const reqRef = useRef(0);
  // task-b30e546672db — re-pull the decrypted body after an embedded-editor save
  // so the read-only surfaces (and the next edit's prefill) reflect the change.
  const refreshBody = useCallback(() => {
    if (!isTypebuild) {
      setBody(task.notes ?? null);
      setDetailSchema(null);
      setDetailResult(null);
      return;
    }
    const myReq = ++reqRef.current;
    void getTask(task.id, 'typebuild')
      .then((full) => {
        if (reqRef.current !== myReq) return;
        setBody(full?.notes ?? null);
        setDetailSchema(full?.outputSchema ?? null);
        setDetailResult(full?.result ?? null);
      })
      .catch(() => {
        if (reqRef.current === myReq) {
          setBody(null);
          setDetailSchema(null);
          setDetailResult(null);
        }
      });
  }, [isTypebuild, task.id, task.notes]);
  useEffect(() => {
    if (!isTypebuild) {
      setBody(task.notes ?? null);
      setDetailSchema(null);
      setDetailResult(null);
      return;
    }
    setBody(null);
    setDetailSchema(null);
    setDetailResult(null);
    refreshBody();
    return () => {
      // Drop the decrypted body the instant we leave this task.
      setBody(null);
      setDetailSchema(null);
      setDetailResult(null);
    };
  }, [task.id, isTypebuild, task.notes, refreshBody]);

  // The resolved output_schema SOURCE: the fetched detail first (reuses
  // fieldedSchemaSource verbatim — the SAME preference rule the roster uses),
  // the list-row's own outputSchema as a harmless fallback (undefined today
  // for a list row, per mapListRow, but still correct if a future list ever
  // carries it).
  const resolvedOutputSchema = useMemo(
    () => fieldedSchemaSource({ outputSchema: detailSchema }, { outputSchema: task.outputSchema }),
    [detailSchema, task.outputSchema],
  );
  // The resolved RESULT: prefer the freshly-fetched detail's result (a
  // list/roster row never carries one — same gap as outputSchema above); fall
  // back to whatever the props-level task already had (e.g. a task opened
  // from a surface that DID pass a full detail).
  const resolvedResult = detailResult ?? task.result ?? null;

  // ── task-69651204e222: ported task-template state (depends on decrypted body)
  // All fail-soft & conditional: a task with none of this data renders exactly
  // as before. `body` is the decrypted, memory-only task text.

  // Outputs (this task's own output DEFINITIONS + submitted VALUES).
  // task-9ab05f87eda3 (U2) — field-definition source preference, PER
  // resolveFieldedJob (task-ce4b4c8ca955): the server's first-class
  // `Task.outputSchema` FIRST, the legacy ```task-outputs body block only when
  // there's no schema. Reused verbatim (not reimplemented) so this drawer never
  // drifts from the New-Home roster's own single-task output resolution —
  // fixture parity: task-73384d8e26e1 (schema + flat result, widgets=42) and
  // task-7d65e61fb581 (schema + legacy-nested result, 3 fields).
  const fieldedJob = useMemo(
    () =>
      resolveFieldedJob({
        id: task.id,
        name: task.title,
        outputSchema: resolvedOutputSchema,
        notes: body ?? null,
        result: resolvedResult,
      }),
    [task.id, task.title, resolvedOutputSchema, body, resolvedResult],
  );
  const outputsBlock = useMemo(
    () => (fieldedJob ? { taskDefId: fieldedJob.defs[0].id, fields: fieldedJob.defs[0].outputs } : null),
    [fieldedJob],
  );
  const submittedByKey = useMemo(() => {
    if (!fieldedJob) return {} as Record<string, string | number | boolean>;
    const defId = fieldedJob.defs[0].id;
    const out: Record<string, string | number | boolean> = {};
    for (const f of fieldedJob.defs[0].outputs) {
      const v = fieldedJob.valuesByRef[fieldRef(defId, f.key)];
      if (v !== undefined) out[f.key] = v;
    }
    return out;
  }, [fieldedJob]);
  const requiredOutputs = useMemo(
    () => (outputsBlock?.fields ?? []).filter((f) => f.required),
    [outputsBlock],
  );
  const requiredSubmittedCount = useMemo(
    () => requiredOutputs.filter((f) => hasValue(submittedByKey[f.key])).length,
    [requiredOutputs, submittedByKey],
  );

  // task-4f1e8f45bf0e — a DONE single task's fielded result (outputsBlock, a
  // parsed output_schema + submitted values) or any other structured result
  // (resolvedResult, e.g. a `table` payload with no declared schema) is
  // "activity" too, even though it never produced a local run/session — a
  // plain TypeBuild task's server-side run history never populates `runs`
  // (useTaskRuns is local-auto-only, see the `runs` useTaskRuns call above),
  // so without this a completed single task's Activity tab (and its Result /
  // TaskResultView section) was PERMANENTLY hidden — the bug's "no result
  // VALUES anywhere" report. Reusing the SAME resolvedResult/outputsBlock this
  // tab already renders from, rather than inventing a second "has a result"
  // check.
  const hasResult = !!resolvedResult || (!!outputsBlock && outputsBlock.fields.length > 0);
  // task-f60a8003efa9 — the Activity tab (clubbed Trace + Session) only exists
  // when there's a run or session to show. "Has activity" = a live session, a
  // resumable conversation, any run in the timeline, or (task-4f1e8f45bf0e) a
  // finished task's structured result.
  const hasActivity =
    !!session || !!latestRun?.conversation_id || runs.length > 0 || hasResult;

  // The visible tabs, in keyboard/digit order. Activity is appended only when
  // there's something to show, so the digit map (1..N) stays contiguous.
  const visibleTabs = useMemo<DrawerTab[]>(
    () => (hasActivity ? ['details', 'teach', 'activity'] : ['details', 'teach']),
    [hasActivity],
  );

  // task-4f1e8f45bf0e — a DONE task defaults to a READ view (Activity, if it
  // has a result to show; else Details) rather than the edit composer. The
  // composer's own "Task details" tab is still one click away — this only
  // changes the DEFAULT so completing a task never silently drops the user
  // into "edit this task's definition" as if the row-click's purpose were to
  // revise a finished task's title/routing.
  const [tab, setTab] = useState<DrawerTab>(
    normalizeTab(initialTab) ??
      (isDone(task) && hasActivity
        ? 'activity'
        : hasActivity && (running || latestRun)
          ? 'activity'
          : 'details'),
  );
  // If the Activity tab disappears (e.g. a run is cleared) while it's selected,
  // fall back to Details so we never sit on a hidden tab.
  useEffect(() => {
    if (!visibleTabs.includes(tab)) setTab('details');
  }, [visibleTabs, tab]);

  // task-4a8d2c98f667 — this task's OWN legacy ```task-fields block (input
  // VALUES inline in the body), distinct from templateBlock/childByDefId
  // below which parse CHILDREN's blocks for the pipeline rollup. Feeds the
  // Inputs section's legacy path (spec item 4) — a task with no such block
  // (the common case: server-side `data` bag, or no inputs at all) parses to
  // null and the Inputs section falls through to the data_keys/resolve path.
  const ownFieldsBlock = useMemo(() => parseTaskFieldsBlock(body ?? null), [body]);
  const saveLegacyFields = useCallback(
    async (values: Record<string, unknown>) => {
      if (!ownFieldsBlock || !task.source) return;
      const nextBody = replaceTaskFieldsBlock(
        body ?? '',
        ownFieldsBlock.templateId,
        ownFieldsBlock.taskDefId,
        values,
      );
      await taskSourceAction(task.source, task.id, 'patch', { task: nextBody });
      refreshBody();
    },
    [ownFieldsBlock, body, task.source, task.id, refreshBody],
  );

  // Meta-parent PIPELINE rollup — needs the roster snapshot to resolve children.
  const templateBlock = useMemo(() => parseTaskTemplateBlock(body ?? null), [body]);
  const childTasks = useMemo(() => {
    if (!templateBlock?.defs || !roster || !roster.length) return [] as Task[];
    return roster.filter((t) => t.parentTaskId === task.id);
  }, [templateBlock, roster, task.id]);
  const childByDefId = useMemo(() => {
    const map = new Map<string, Task>();
    for (const c of childTasks) {
      const fb = parseTaskFieldsBlock(c.notes ?? null);
      if (fb) map.set(fb.taskDefId, c);
    }
    return map;
  }, [childTasks]);
  const pipelineValuesByRef = useMemo(() => {
    const out: Record<string, string | number> = {};
    for (const c of childTasks) {
      const fb = parseTaskFieldsBlock(c.notes ?? null);
      if (fb) {
        for (const [k, v] of Object.entries(fb.values)) {
          if (typeof v === 'string' || typeof v === 'number') out[fieldRef(fb.taskDefId, k)] = v;
        }
      }
      const rf = resultFields(c.result ?? null);
      if (rf) {
        // task-2638eeedd9ef: a canonical FLAT result carries no taskDefId —
        // fall back to the input block's def id (above), else this child's
        // own task-outputs block def id, so the values still land under the
        // right pipeline group.
        const rDefId = rf.taskDefId ?? fb?.taskDefId ?? parseTaskOutputsBlock(c.notes ?? null)?.taskDefId;
        if (rDefId) {
          for (const [k, v] of Object.entries(rf.fields)) {
            out[fieldRef(rDefId, k)] = typeof v === 'boolean' ? String(v) : v;
          }
        }
      }
    }
    return out;
  }, [childTasks]);
  const pipelineDefs = useMemo<TaskDef[]>(() => templateBlock?.defs ?? [], [templateBlock]);
  // task-e713f307c422 — data-key → its input TaskDefField, for the Inputs
  // editor to render a source-backed input as a live-query typeahead. A chain
  // is self-describing: the field DEFINITIONS (with `source`) live on the
  // PARENT (meta) task's v2 `task-template` block, keyed by def id; this child
  // knows its own def id from its `task-fields` block. So we resolve the parent
  // from the roster snapshot (already threaded for the pipeline rollup), parse
  // its v2 block, find this child's def, and map that def's INPUT field keys →
  // their defs. Only source-bearing fields need to be here (a plain key falls
  // through to the text path), but we map all inputs so labels/types are right.
  // Degrades to unset (plain text) when: no roster, no parent, the parent block
  // is legacy/absent, or this task carries no own `task-fields` def id.
  const sourceFieldDefs = useMemo<Record<string, TaskDefField> | undefined>(() => {
    const myDefId = ownFieldsBlock?.taskDefId;
    if (!myDefId || !task.parentTaskId || !roster || !roster.length) return undefined;
    const parent = roster.find((t) => t.id === task.parentTaskId);
    if (!parent) return undefined;
    const parentBlock = parseTaskTemplateBlock(parent.notes ?? null);
    const defs = parentBlock?.defs;
    if (!defs) return undefined;
    const myDef = defs.find((d) => d.id === myDefId);
    if (!myDef) return undefined;
    const map: Record<string, TaskDefField> = {};
    for (const f of myDef.inputs ?? []) map[f.key] = f;
    return Object.keys(map).length ? map : undefined;
  }, [ownFieldsBlock, task.parentTaskId, roster]);
  // task-f26e7745eda6 — def id → the child's LIVE server status, consulted by
  // the runnable walk + step chips (cancelled excluded/shown; failed shown).
  const pipelineChildStatus = useMemo<Record<string, ChildStatusLike>>(
    () => childStatusMap(childByDefId.entries(), (c) => c),
    [childByDefId],
  );
  // task-4045bcee23cb (U3a #3) — the SAME "which step is runnable next" rule
  // the roster's group-header chips and parent Start-chain use, so this
  // rollup's ▶ never drifts from the roster's.
  const pipelineRunnableId = useMemo(
    () => runnableStepId(pipelineDefs, pipelineValuesByRef, pipelineChildStatus),
    [pipelineDefs, pipelineValuesByRef, pipelineChildStatus],
  );

  // ── effective instruction set (foundation resolver) ───────────────────────
  // Resolve the project leg lazily (NON-PHI) and feed task notes as the task
  // scope. Category cohorts ride on task.flags (e.g. 'payer:HMO') when present.
  const [project, setProject] = useState<Project | null>(null);
  // task-fdf3dc6b3c5c — reusable project (re-)load so a successful PROJECT-scope
  // teach can pull the freshly-persisted instructions (effective=1) back in.
  const loadProject = useCallback(() => {
    if (!task.projectId) {
      setProject(null);
      return Promise.resolve();
    }
    return fm.typebuild.projects
      .get(task.projectId, true)
      .then((p) => setProject(p))
      .catch(() => setProject(null));
  }, [task.projectId]);
  useEffect(() => {
    let cancelled = false;
    if (!task.projectId) {
      setProject(null);
      return;
    }
    void fm.typebuild.projects
      .get(task.projectId, true)
      .then((p) => {
        if (!cancelled) setProject(p);
      })
      .catch(() => {
        if (!cancelled) setProject(null);
      });
    return () => {
      cancelled = true;
    };
  }, [task.projectId]);

  // task-fdf3dc6b3c5c — teach-in-the-moment write-back. Saves now PERSIST to
  // the server for PROJECT + TASK scopes (CATEGORY stays session-local until
  // its server store ships — task-7961735a4ab6). We still keep a local `taught`
  // list so every successful save shows IMMEDIATELY in the resolved set without
  // waiting for a project re-fetch, and so the CATEGORY fallback has somewhere
  // to live. Each entry records how it was persisted for the (optional) UI hint.
  const [taught, setTaught] = useState<
    Array<{
      scopeKind: 'task' | 'category' | 'project';
      scopeLabel: string;
      text: string;
      persisted: 'project' | 'task' | 'local-pending';
    }>
  >([]);

  const categories: CategoryScopeSource[] = useMemo(() => {
    const cohorts = (task.flags ?? []).filter((f) => f.includes(':'));
    const fromTags = cohorts.map((key) => ({ key, label: key, rules: [] as string[] }));
    // Layer any taught category rules onto matching/derived cohorts.
    for (const t of taught) {
      if (t.scopeKind !== 'category') continue;
      const existing = fromTags.find((c) => c.label === t.scopeLabel);
      if (existing) existing.rules.push(t.text);
      else fromTags.push({ key: t.scopeLabel, label: t.scopeLabel, rules: [t.text] });
    }
    return fromTags;
  }, [task.flags, taught]);

  const resolved = useMemo(() => {
    const taskRules = taught.filter((t) => t.scopeKind === 'task').map((t) => t.text);
    const projectRules = taught.filter((t) => t.scopeKind === 'project').map((t) => t.text);
    return resolveEffectiveInstructions({
      project: project
        ? {
            id: project.id,
            instructions: project.instructions,
            effectiveInstructions: project.effectiveInstructions,
            label: 'project',
            rules: projectRules,
          }
        : projectRules.length
          ? { id: 'project', label: 'project', rules: projectRules }
          : undefined,
      categories,
      task:
        taskRules.length || body
          ? { id: 'task', label: 'task', rules: taskRules }
          : undefined,
    });
  }, [project, categories, taught, body]);

  // task-fdf3dc6b3c5c — persist a teach correction to the chosen SCOPE.
  //   PROJECT  → PATCH /chromeext/projects/{id} `instructions` (append the new
  //              rule to the project's own instructions). OWNER-ONLY (403
  //              not_owner) and PHI-guarded (422). On a structured failure we
  //              surface a clear message and DO NOT add the rule locally (no
  //              fake persistence). On success we re-load the project so the
  //              freshly-persisted instructions flow through the resolver, and
  //              ALSO add it to local `taught` for an instant echo.
  //   TASK     → POST /chromeext/{id}/notes (per-task teach note). Claim-gated
  //              + PHI-guarded server-side. Same success/failure handling.
  //   CATEGORY → NO server store yet (task-7961735a4ab6: GET/PUT
  //              /chromeext/category-instructions). Until that ships we keep
  //              the category rule in the session-local `taught` fallback,
  //              clearly marked 'local-pending' — NOT faked as persisted.
  // Returns a result the teach UI renders (ok | a human reason). NON-PHI text.
  const persistTeach = useCallback(
    async (entry: {
      scopeKind: 'task' | 'category' | 'project';
      scopeLabel: string;
      text: string;
    }): Promise<{ ok: true; pending?: boolean } | { ok: false; message: string }> => {
      const text = entry.text.trim();
      if (!text) return { ok: false, message: 'Nothing to save.' };

      if (entry.scopeKind === 'category') {
        // task-7961735a4ab6 — pending server endpoint. Session-local only.
        setTaught((prev) => [...prev, { ...entry, text, persisted: 'local-pending' }]);
        return { ok: true, pending: true };
      }

      if (entry.scopeKind === 'project') {
        if (!task.projectId) return { ok: false, message: 'No project to teach.' };
        // Append the new rule to the project's OWN instructions (not the merged
        // effective block) so we don't re-persist inherited ancestor rules.
        const own = (project?.instructions ?? '').trim();
        const next = own ? `${own}\n${text}` : text;
        try {
          const res = await fm.typebuild.projects.patch(task.projectId, {
            instructions: next,
          });
          if (res.ok) {
            await loadProject();
            setTaught((prev) => [...prev, { ...entry, text, persisted: 'project' }]);
            return { ok: true };
          }
          return { ok: false, message: teachReason('project', res.reason) };
        } catch {
          return { ok: false, message: 'Couldn’t reach TypeBuild to save.' };
        }
      }

      // TASK scope → per-task teach note.
      try {
        const res = await fm.typebuild.taskNote(task.id, text);
        if (res.ok) {
          setTaught((prev) => [...prev, { ...entry, text, persisted: 'task' }]);
          return { ok: true };
        }
        return { ok: false, message: teachReason('task', res.reason) };
      } catch {
        return { ok: false, message: 'Couldn’t reach TypeBuild to save.' };
      }
    },
    [task.id, task.projectId, project, loadProject],
  );

  // task-a763ca5be676 — the PENDING QUESTION (ask_user), pinned at the top of the
  // drawer body as its OWN card (not buried in notes). Only a NON-terminal
  // question counts (a done/cancelled task's stale question is moot — mirrors
  // classify().asked + the row). PHI: `text` is rendered from memory only.
  const isTerminalStatus =
    task.status === 'done' || task.status === 'cancelled';
  const pendingQuestion =
    !isTerminalStatus && task.pending_question ? task.pending_question : null;

  // ── controls ──────────────────────────────────────────────────────────────
  const claimedBy = task.claimedBy ?? null;
  const claimedByMe = !!claimedBy && claimedBy === myEmail;
  const raw = (task.rawStatus ?? task.status).toLowerCase();
  const isTerminal = raw === 'done' || raw === 'partial' || raw === 'cancelled' || raw === 'succeeded';
  const canStop = running || (!isTerminal && (raw === 'in_progress' || raw === 'working' || raw === 'claimed'));
  // Enter-thread is offered when there's an agent thread to get into: a live
  // session tab, or an in_progress / waiting TypeBuild task, or a completed run
  // with a conversation to resume.
  const canEnterThread =
    !!session ||
    (isTypebuild && (raw === 'in_progress' || raw === 'working' || raw === 'claimed' || raw === 'waiting')) ||
    !!latestRun?.conversation_id;

  // task-31b382ab2e4c — the row's ONE primary affordance (Start/run, claim,
  // run-now, open-session, reopen, done-toggle) carried into the drawer header
  // via the SAME pure descriptor the row renders, so the detail view never
  // drifts from the row. We mirror TasksPage's primaryFor + invokePrimary.
  const primary = useMemo(
    () =>
      primaryActionFor(task, {
        caps,
        tbReady,
        myEmail,
        session,
        lastRunRunning: running,
      }),
    [task, caps, tbReady, myEmail, session, running],
  );

  function invokePrimary(action: PrimaryAction) {
    switch (action.kind) {
      case 'done-toggle':
        void actions.setStatus(task, 'done');
        break;
      case 'reopen':
        if (isTypebuild) void actions.sourceAction(task, 'reopen');
        else void actions.setStatus(task, 'pending');
        break;
      case 'retry':
        // task-457dd1cc6c8b — reopen→claim→launch, routed through the SAME
        // never-silent wrapper the subtable's per-step ▶ uses (keyed by this
        // task's own id so it can't collide with a child step's key). Never
        // silent: pendingFor/errorFor below render the in-flight/error state.
        void stepStartAction.run(task.id, {
          kind: 'start',
          run: () => actions.retry(task),
        });
        break;
      case 'start':
      case 'run-now':
        // Start auto-claims (TypeBuild) / runs-now (local auto), then lands the
        // user in the live session — same as Enter-thread's claim path.
        void actions.start(task);
        say(isTypebuild ? 'entering thread…' : 'running…');
        exit();
        break;
      case 'open-session':
        dispatch({ type: 'selectTab', index: action.tabIndex });
        exit();
        break;
      case 'view-run':
        openSession();
        break;
      case 'none':
        break;
    }
  }

  // Reconcile the two affordances so the header shows ONE coherent primary:
  // when the primary descriptor already enters the thread (start / open-session),
  // suppress the duplicate "Enter thread" button. Keep it only for the cases the
  // primary doesn't cover (e.g. a completed run with a conversation to resume).
  const primaryEnters = primary.kind === 'start' || primary.kind === 'open-session';
  const showPrimaryButton = primary.kind !== 'none';
  const showEnterThread = canEnterThread && !primaryEnters;

  async function stop() {
    if (running && latestRun && isLocalAuto) {
      try {
        const ok = await cancelTaskRun(latestRun.id);
        say(ok ? 'run stopped' : 'no active run to stop');
      } catch (e) {
        say(formatOpError('stop run', e));
      }
      return;
    }
    if (isTypebuild) {
      try {
        const res = (await taskSourceAction('typebuild', task.id, 'cancel')) as
          | { ok?: boolean; reason?: string; claimedBy?: string | null }
          | undefined;
        if (res && res.ok === false) {
          say(`couldn’t stop · ${formatSourceReason(res.reason, { claimedBy: res.claimedBy })}`);
          return;
        }
        say('task stopped');
      } catch (e) {
        say(formatOpError('stop', e));
      }
      return;
    }
    void actions.setStatus(task, 'pending');
  }

  function enterThread() {
    if (session) {
      dispatch({ type: 'selectTab', index: session.tabIndex });
      say('entered session');
      exit();
      return;
    }
    if (isTypebuild && (raw === 'in_progress' || raw === 'working' || raw === 'claimed' || raw === 'waiting')) {
      // Re-enter the agent thread by (re)starting the claim-then-launch path,
      // which lands the user in the live TypeBuild session.
      void actions.start(task);
      say('entering thread…');
      exit();
      return;
    }
    if (latestRun?.conversation_id) {
      void openResumeInTab(task.folder || null, latestRun.conversation_id, task.title);
      exit();
    }
  }

  function openSession() {
    if (session) {
      dispatch({ type: 'selectTab', index: session.tabIndex });
      exit();
      return;
    }
    if (latestRun?.conversation_id) {
      void openResumeInTab(task.folder || null, latestRun.conversation_id, task.title);
      exit();
      return;
    }
    say('no session yet — Start the task to open one');
  }

  // task-69651204e222 — free-text talk-back. Reuses the SAME bridge call the
  // New-Home dialog uses (postTaskMessage → fm.typebuild.taskMessage), then
  // injects into a live session tab / resumes the last conversation so the
  // agent picks it up promptly. Works on any status (server append is
  // visibility-gated only). PHI: the message text lives in memory only.
  async function sendMessage(alsoOpenSession = false) {
    const text = messageDraft.trim();
    if (!text || sendingMessage) {
      messageRef.current?.focus();
      return;
    }
    setSendingMessage(true);
    setMessageError(null);
    setMessageSent(null);
    try {
      const res = await postTaskMessage(task.id, text);
      if (res.ok) {
        setMessageDraft('');
        if (session) {
          injectMessageIntoSession(session.ptyId, text);
          setMessageSent('Sent — delivered to the open session');
        } else if (alsoOpenSession && task.folder && latestRun?.conversation_id) {
          setMessageSent('Sent — opening the session…');
          await openResumeInTab(task.folder, latestRun.conversation_id, task.title);
          exit();
          return;
        } else {
          setMessageSent('Sent — the agent will see this');
        }
      } else {
        setMessageError(formatMessageSendReason(res.reason));
      }
    } catch (e) {
      setMessageError(formatOpError('send message', e));
    } finally {
      setSendingMessage(false);
    }
  }

  // task-69651204e222 — Cancel / Retry footer controls, ported from the
  // New-Home dialog and routed through the SAME useTaskActions the dialog uses.
  // Cancel is offered only for a non-terminal task; Retry only for a failed one.
  const canCancel = !isTerminal && (caps?.canDelete || isTypebuild);
  const canRetry = raw === 'failed' || raw === 'error';
  function cancelTask() {
    window.dispatchEvent(
      new CustomEvent('fm:confirm', {
        detail: {
          title: `Cancel "${task.title}"?`,
          body: 'The agent will stop working on this task.',
          confirmLabel: 'Cancel task',
          destructive: true,
          onConfirm: async () => {
            if (isTypebuild) await actions.sourceAction(task, 'cancel');
            else await actions.remove(task);
            exit();
          },
        },
      }),
    );
  }
  function retry() {
    void actions.start(task);
  }

  // ── keyboard: Esc closes; 1/2/3 or h/l switch tabs ────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const inField =
        t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable;
      if (e.key === 'Escape') {
        e.preventDefault();
        exit();
        return;
      }
      if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
      // task-f26ea21017b1 — while the embedded composer is being edited it sets
      // body[data-composer-open]; suppress the PLAIN-digit→tab mapping AND the
      // h/l tab walk so number keys select composer OPTIONS (and h/l type into
      // text) instead of switching the drawer's tabs. (The global ⌘1-9 app-tab
      // switch in useKeyboard.ts already bails on the same flag.) Esc/Stop/Enter
      // -thread still work — only tab navigation is gated.
      const editing = document.body.dataset.composerOpen === 'true';
      if (editing) {
        if (e.key === 's' && canStop) void stop();
        else if (e.key === 'e' && canEnterThread) enterThread();
        return;
      }
      // task-f60a8003efa9 — digit/arrow navigation walks the CURRENTLY VISIBLE
      // tabs so numbering stays contiguous when Activity is hidden.
      const order = visibleTabs;
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= order.length) setTab(order[n - 1]);
      else if (e.key === 'l' || e.key === 'ArrowRight') {
        const i = order.indexOf(tab);
        setTab(order[Math.min(order.length - 1, i + 1)]);
      } else if (e.key === 'h' || e.key === 'ArrowLeft') {
        const i = order.indexOf(tab);
        setTab(order[Math.max(0, i - 1)]);
      } else if (e.key === 's' && canStop) {
        void stop();
      } else if (e.key === 'e' && canEnterThread) {
        enterThread();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, visibleTabs, canStop, canEnterThread, session, latestRun, raw]);

  return (
    <div
      className="overlay tdd-overlay"
      data-state={state}
      onMouseDown={(e) => e.target === e.currentTarget && exit()}
    >
      <aside
        className={`tdd tdd--${tone}`}
        role="dialog"
        aria-modal="true"
        aria-label={`Task detail: ${task.title}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="tdd__head">
          <div className="tdd__status">
            <span className={`tdd__pulse tdd__pulse--${tone}`} aria-hidden="true" />
            <TaskStatusDot status={task.status} rawStatus={task.rawStatus ?? null} />
            <span className={`tdd__live tdd__live--${tone}`}>{liveLabel}</span>
            {isTypebuild && <span className="tdd__badge">TypeBuild</span>}
            {task.auto_mode && !isTypebuild && <span className="tdd__badge">Auto</span>}
          </div>
          <button type="button" className="tdd__close" onClick={exit} aria-label="Close (Esc)">
            ×
          </button>
        </header>

        <div className="tdd__title-row">
          <h2 className="tdd__title">{task.title}</h2>
          <CopyButton getText={() => task.title} title="Copy title" />
          <CopyButton getText={() => task.id} label="Copy ID" title="Copy task ID" />
        </div>

        {/* live action row — the row's ONE primary affordance (Start/run, claim,
            run-now, …) + Enter thread + Stop (calm-by-default, only shown when
            actionable). task-31b382ab2e4c: the primary button is rendered from
            the SAME pure descriptor the row uses; Enter-thread is suppressed when
            the primary already enters the thread, so the header never shows two
            competing primaries. */}
        {(showPrimaryButton || showEnterThread || canStop) && (
          <div className="tdd__actionrow">
            {showPrimaryButton && (
              <PrimaryActionButton
                action={primary}
                onInvoke={invokePrimary}
                variant="detail"
              />
            )}
            {primary.kind === 'retry' && stepStartAction.pendingFor(task.id) && (
              <span className="tdd__action-pending">Reopening…</span>
            )}
            {showEnterThread && (
              <button type="button" className="tdd__action tdd__action--primary" onClick={enterThread}>
                ↳ Enter thread <kbd>e</kbd>
              </button>
            )}
            {canStop && (
              <button type="button" className="tdd__action tdd__action--stop" onClick={() => void stop()}>
                ◼ Stop <kbd>s</kbd>
              </button>
            )}
          </div>
        )}
        {/* task-457dd1cc6c8b — Retry's reopen→claim→launch chain routes
            through the never-silent wrapper; a failure (reopen rejected,
            claim contested, or launch failed) surfaces here as a human
            reason — never a bare token. */}
        {primary.kind === 'retry' && stepStartAction.errorFor(task.id) && (
          <div className="tdd__action-error" title={stepStartAction.errorFor(task.id) ?? undefined}>
            ⚠ {stepStartAction.errorFor(task.id)}
          </div>
        )}

        {/* segmented tabs — task-b30e546672db: "Task details" is now FIRST.
            task-f60a8003efa9: Trace + Session are clubbed into one "Activity"
            tab, rendered only when there's a run/session (visibleTabs). */}
        <nav className="tdd__tabs" role="tablist" aria-label="Detail sections">
          {visibleTabs.map((id, i) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={['tdd__tab', tab === id && 'tdd__tab--on'].filter(Boolean).join(' ')}
              onClick={() => setTab(id)}
            >
              {id === 'details'
                ? 'Task details'
                : id === 'teach'
                  ? 'Teach'
                  : 'Activity'}
              <kbd>{i + 1}</kbd>
            </button>
          ))}
        </nav>

        <div className="tdd__body">
          {/* task-a763ca5be676 — PINNED pending-question card. Sits at the TOP
              of the body, above the tab content + embedded composer, so the ONE
              thing blocking the task (a human answer) is impossible to miss.
              Renders NOTHING when there's no pending question (NON-REGRESSION).
              PHI: the question text is shown from memory only. */}
          {pendingQuestion && (
            <section className="tdd__ask" aria-label="Pending question">
              <div className="tdd__ask-head">
                <span className="tdd__ask-badge" aria-hidden="true">
                  ?
                </span>
                <span className="tdd__ask-title">Waiting on your answer</span>
              </div>
              <p className="tdd__ask-text">{pendingQuestion.text}</p>
              {(pendingQuestion.asked_by || pendingQuestion.asked_at) && (
                <div className="tdd__ask-meta">
                  {pendingQuestion.asked_by && (
                    <span>Asked by {pendingQuestion.asked_by}</span>
                  )}
                  {pendingQuestion.asked_at && (
                    <span title={pendingQuestion.asked_at}>
                      {formatAskedAt(pendingQuestion.asked_at)}
                    </span>
                  )}
                </div>
              )}
              <TaskAnswerBox
                taskId={task.id}
                pendingQuestion={pendingQuestion}
                onAnswered={refreshBody}
              />
            </section>
          )}
          {tab === 'activity' && (
            <>
              <ActivityTab
                runs={runs}
                running={running}
                liveLabel={liveLabel}
                tone={tone}
                hasLiveSession={!!session}
                latestRun={latestRun}
                onOpenSession={openSession}
                onEnterThread={canEnterThread ? enterThread : undefined}
              />
              {/* task-69651204e222 — ported from the New-Home dialog into the
                  Activity tab: the merged EVIDENCE log (run evidence),
                  ATTACHMENTS (run outputs), and OUTCOME (structured result).
                  Each is conditionally rendered so an activity tab with none of
                  this data renders as before. */}
              <EvidenceLog
                runs={runs}
                task={task}
                pendingQuestion={pendingQuestion}
                outputsBlock={outputsBlock}
                submittedByKey={submittedByKey}
                requiredOutputs={requiredOutputs}
                requiredSubmittedCount={requiredSubmittedCount}
              />
              {attachments.length > 0 && (
                <section className="tdd__sect tdd__attachments-sect">
                  <div className="tdd__sect-h">Attachments</div>
                  <div className="tdd__attachments">
                    {attachments.map((a) => (
                      <button
                        type="button"
                        key={a.path}
                        className="tdd__attachment"
                        onClick={() => void fm.open(a.path)}
                        title={a.path}
                      >
                        <span aria-hidden="true">📄</span>
                        <span className="tdd__attach-name">{a.name}</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {/* task-9ab05f87eda3 (U2) — "what came out" shouldn't wait for
                  terminal status: an in-progress task can already carry a
                  submitted structured result (e.g. a fielded step that reported
                  before the parent chain finished). Show the section whenever
                  EITHER the task is terminal OR a result already exists;
                  TaskResultView itself no-ops (renders null) for a malformed/
                  absent result, so this never shows a fake success block. */}
              {(isTerminal || !!resolvedResult) && (
                <section className="tdd__sect tdd__outcome-sect">
                  <div className="tdd__sect-h">Result</div>
                  <TaskResultView result={resolvedResult} />
                  {!resolvedResult && (
                    <p className="tdd__muted">No structured result recorded.</p>
                  )}
                </section>
              )}
              {/* Free-text talk-back — sits alongside the pinned pending-question
                  card + TaskAnswerBox (which handle the ask_user case). This is
                  the always-available message channel to the agent. */}
              <section className="tdd__sect tdd__talkback">
                <div className="tdd__sect-h">Talk back</div>
                {!session && (
                  <p className="tdd__muted">
                    No open session in this window — the message reaches the agent either way.
                  </p>
                )}
                <textarea
                  ref={messageRef}
                  className="tdd__teach-input"
                  placeholder="Send a message to the agent…"
                  value={messageDraft}
                  disabled={sendingMessage}
                  onChange={(e) => {
                    setMessageDraft(e.target.value);
                    setMessageSent(null);
                  }}
                />
                <div className="tdd__teach-actions">
                  <span className="tdd__teach-spacer" />
                  {messageSent && <span className="tdd__sent">{messageSent}</span>}
                  {!session && task.folder && latestRun?.conversation_id && (
                    <button
                      type="button"
                      className="tdd__btn"
                      disabled={sendingMessage || !messageDraft.trim()}
                      onClick={() => void sendMessage(true)}
                    >
                      Send &amp; open session
                    </button>
                  )}
                  <button
                    type="button"
                    className="tdd__btn"
                    disabled={sendingMessage || !messageDraft.trim()}
                    onClick={() => void sendMessage()}
                  >
                    {sendingMessage ? 'Sending…' : 'Send message'}
                  </button>
                </div>
                {messageError && (
                  <p className="tdd__teach-feedback tdd__teach-feedback--err" role="alert">
                    Couldn’t send · {messageError}
                  </p>
                )}
              </section>
            </>
          )}
          {tab === 'details' && (
            <div className="tdd__details">
              {/* task-b30e546672db — the task IS the config. Render the editor by
                  reusing the new-task composer form, prefilled with this task's
                  current values and fully editable; saves persist via the
                  composer's update path (TypeBuild PATCH / local updateTask). */}
              <TaskComposer
                key={task.id}
                mode="edit"
                task={task}
                embedded
                onClose={() => {
                  /* Cancel inside the embedded editor is a no-op — the dialog
                     stays open; Esc on the dialog closes it. */
                }}
                onSaved={refreshBody}
              />
              {/* Read-only context the composer doesn't surface: schedule,
                  dependency/containment relations, folder. */}
              <DetailsMeta
                task={task}
                claimedBy={claimedBy}
                claimedByMe={claimedByMe}
              />
              {/* task-4a8d2c98f667 — the task `data` bag Inputs section: LIST
                  (data_keys), RESOLVE-on-demand, EDIT/ADD, gated on claim/
                  creator. Shown for every TypeBuild task (not gated on
                  data_keys being non-empty) so: (a) a server that hasn't
                  shipped data_keys yet still lets the user discover/add a key
                  — the ONLY way a viewer can find an input the reporting bug
                  hid entirely; (b) a task with zero inputs today can still
                  gain one via "Add". A local/non-typebuild task has no `data`
                  bag at all, so it's excluded (NON-REGRESSION there). */}
              {isTypebuild && (
                <TaskDataInputs
                  taskId={task.id}
                  dataKeys={task.dataKeys}
                  claimedBy={claimedBy}
                  createdBy={task.createdBy}
                  viewerEmail={myEmail}
                  legacyFields={ownFieldsBlock}
                  fieldDefs={sourceFieldDefs}
                  onLegacyFieldsSave={saveLegacyFields}
                  onSaved={refreshBody}
                />
              )}
              {/* task-69651204e222 — ported from the New-Home dialog: this
                  task's own OUTPUT fields (definitions + submitted values) and,
                  for a meta-parent, the PIPELINE rollup over its children.
                  Both gated on a parsed template block so a non-template task
                  renders EXACTLY as before. */}
              {outputsBlock && outputsBlock.fields.length > 0 && (
                <section className="tdd__sect tdd__outputs">
                  <div className="tdd__sect-h">Outputs</div>
                  {outputsBlock.fields.map((f) => {
                    const v = submittedByKey[f.key];
                    const submitted = hasValue(v);
                    return (
                      <div className="tdd__output-item" key={f.key}>
                        <div className="tdd__output-k">
                          {f.label}
                          <span className="tdd__output-type">{f.type}</span>
                          {f.required && (
                            <span className="tdd__output-required">required — evidence</span>
                          )}
                        </div>
                        <div
                          className={`tdd__output-v${submitted ? '' : ' tdd__output-v--pending'}`}
                        >
                          {submitted ? String(v) : 'awaiting agent'}
                          {submitted && (
                            <CopyButton
                              getText={() => String(v)}
                              title={`Copy ${f.label}`}
                              className="tdd__output-copy"
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <div className="tdd__muted">
                    {requiredOutputs.length > 0
                      ? `${requiredSubmittedCount} of ${requiredOutputs.length} required outputs submitted`
                      : 'No required outputs for this step'}
                  </div>
                </section>
              )}
              {templateBlock && pipelineDefs.length > 0 && (
                <section className="tdd__sect tdd__pipeline-sect">
                  <div className="tdd__sect-h">Pipeline</div>
                  <ol className="tdd__pipeline">
                    {pipelineDefs.map((def, i) => {
                      const child = childByDefId.get(def.id);
                      // task-f26e7745eda6 — merge child server status (cancelled
                      // → grey; failed/blocked → 'Failed'; not "Queued").
                      const defStatus: MergedStepStatus = mergeChildStatus(
                        taskDefStatus(def, pipelineValuesByRef),
                        toChildStatus(child),
                      );
                      const firstOutput = def.outputs.find((f) =>
                        hasValue(pipelineValuesByRef[fieldRef(def.id, f.key)]),
                      );
                      const outcome = firstOutput
                        ? `${firstOutput.label}=${pipelineValuesByRef[fieldRef(def.id, firstOutput.key)]}`
                        : null;
                      const clickable = !!child && !!onOpenTask;
                      // task-4045bcee23cb (U3a #3) — same actionsFor
                      // (primaryActionFor) eligibility as the roster's row
                      // Start / step chips; this rollup just adds another
                      // entry point to the identical rule.
                      const runnable = def.id === pipelineRunnableId;
                      const stepStart =
                        runnable && child
                          ? (() => {
                              const pa = primaryActionFor(child, {
                                caps: child.source ? sourcesById[child.source]?.capabilities : undefined,
                                tbReady,
                                myEmail,
                                session: sessions.get(child.id),
                              });
                              return pa.kind === 'start' ? { enabled: pa.enabled, tooltip: pa.tooltip } : null;
                            })()
                          : null;
                      return (
                        <li
                          key={def.id}
                          className={`tdd__pipeline-row${clickable ? ' tdd__pipeline-row--clickable' : ''}`}
                          onClick={clickable ? () => onOpenTask!(child!.id) : undefined}
                          role={clickable ? 'button' : undefined}
                          tabIndex={clickable ? 0 : undefined}
                        >
                          <span className="tdd__pipeline-idx">{i + 1}</span>
                          <span className="tdd__pipeline-name">{def.name}</span>
                          <span
                            className={`tdd__pipeline-pill tdd__pipeline-pill--${defStatus}`}
                          >
                            {DEF_STATUS_LABEL[defStatus]}
                          </span>
                          <span className="tdd__pipeline-outcome">{outcome ?? '—'}</span>
                          {stepStart && child && (
                            <button
                              type="button"
                              className="tdd__pipeline-start"
                              disabled={!stepStart.enabled || stepStartAction.pendingFor(child.id)}
                              title={stepStart.tooltip ?? 'Start this step'}
                              onClick={(e) => {
                                e.stopPropagation();
                                // task-48cd46a0e2da — pending + inline error,
                                // never a silent no-op.
                                void stepStartAction.run(child.id, {
                                  kind: 'start',
                                  run: () => actions.start(child),
                                });
                              }}
                            >
                              {stepStartAction.pendingFor(child.id) ? 'Starting…' : '▶ Start'}
                            </button>
                          )}
                          {child && stepStartAction.errorFor(child.id) && (
                            <span
                              className="tdd__pipeline-error"
                              role="alert"
                              title={stepStartAction.errorFor(child.id) ?? undefined}
                            >
                              {`⚠ ${stepStartAction.errorFor(child.id)}`}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </section>
              )}
              {/* task-a784a424bd63 — the effective instruction set NO LONGER
                  appears here. It lives ONLY in the Teach tab (rendered as a
                  provenance document grouped by originating scope), so the
                  Details tab doesn't duplicate it. */}
            </div>
          )}
          {tab === 'teach' && (
            <TeachTab
              task={task}
              resolved={resolved}
              project={project}
              onTeach={persistTeach}
            />
          )}
        </div>

        <footer className="tdd__foot">
          {/* task-de98e1c6cd18 — "Open tab" only while the task is running, and
              it opens the LIVE terminal/session for that task. */}
          {running && (
            <button
              type="button"
              className="tdd__btn"
              onClick={openSession}
            >
              Open tab
            </button>
          )}
          {caps?.canEdit && (
            <button
              type="button"
              className="tdd__btn"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent('fm:openTask', { detail: { mode: 'edit', task } }),
                );
                exit();
              }}
            >
              Edit
            </button>
          )}
          {/* task-69651204e222 — Cancel / Retry, ported from the New-Home
              dialog's footer. Cancel confirms then routes via useTaskActions
              (cancel for TypeBuild / remove otherwise); Retry re-runs the same
              claim-then-launch path Start uses. Conditional so a task that's
              neither cancellable nor failed shows neither button (as before). */}
          {canRetry && (
            <button type="button" className="tdd__btn" onClick={retry}>
              Retry
            </button>
          )}
          {canCancel && (
            <button
              type="button"
              className="tdd__btn tdd__btn--danger"
              onClick={cancelTask}
            >
              Cancel task
            </button>
          )}
          <span className="tdd__foot-spacer" />
          {/* task-9ab05f87eda3 (U2) — the old "1/2 tabs" hint read as an
              unlabeled pager (as if page 1 of 2 content), not a keyboard-shortcut
              legend. Each tab already shows its own <kbd> digit in the nav
              above; this footer hint now names what the digits DO instead of
              repeating them ambiguously. */}
          <span className="tdd__hint">
            <kbd>1</kbd>-<kbd>{visibleTabs.length}</kbd> to switch tabs · <kbd>Esc</kbd> close
          </span>
        </footer>
      </aside>
    </div>
  );
}

// ── ACTIVITY (clubbed Trace + Session) ───────────────────────────────────────
// task-f60a8003efa9 — one tab for "what's happening / what happened": the live
// (or replayable) session surface up top, then the run timeline below. Rendered
// only when there's a run or session to show (gated by `hasActivity` in the
// host), so the user never lands on an empty tab.
function ActivityTab({
  runs,
  running,
  liveLabel,
  tone,
  hasLiveSession,
  latestRun,
  onOpenSession,
  onEnterThread,
}: {
  runs: TaskRun[];
  running: boolean;
  liveLabel: string;
  tone: LiveTone;
  hasLiveSession: boolean;
  latestRun: TaskRun | null;
  onOpenSession: () => void;
  onEnterThread?: () => void;
}) {
  return (
    <div className="tdd__activity">
      <SessionBlock
        hasLiveSession={hasLiveSession}
        latestRun={latestRun}
        onOpenSession={onOpenSession}
        onEnterThread={onEnterThread}
      />
      <div className="tdd__activity-trace">
        <div className="tdd__sect-h">Run timeline</div>
        <RunTimeline runs={runs} running={running} liveLabel={liveLabel} tone={tone} />
      </div>
    </div>
  );
}

// The run timeline (formerly the Trace tab body): the steps of a running /
// completed run, with a live pulse while working.
function RunTimeline({
  runs,
  running,
  liveLabel,
  tone,
}: {
  runs: TaskRun[];
  running: boolean;
  liveLabel: string;
  tone: LiveTone;
}) {
  if (runs.length === 0) {
    return (
      <div className="tdd__trace">
        <div className={`tdd__trace-live tdd__trace-live--${tone}`}>
          <span className={`tdd__pulse tdd__pulse--${tone}`} aria-hidden="true" />
          {running ? liveLabel + '…' : liveLabel}
        </div>
        <p className="tdd__muted">
          No run trace yet. Start the task (or wait for the schedule) and steps appear here live.
        </p>
      </div>
    );
  }
  return (
    <ol className="tdd__timeline">
      {runs.map((r) => {
        const start = r.started_at ?? r.scheduled_for;
        const dur =
          r.finished_at && r.started_at
            ? `${((r.finished_at - r.started_at) / 1000).toFixed(1)}s`
            : null;
        const live = r.status === 'running' || r.status === 'queued' || r.status === 'retrying';
        return (
          <li key={r.id} className={`tdd__step tdd__step--${r.status}`}>
            <span className={`tdd__step-dot${live ? ' tdd__step-dot--live' : ''}`} aria-hidden="true" />
            <div className="tdd__step-main">
              <div className="tdd__step-head">
                <span className={`tdd__run-status tdd__run-status--${r.status}`}>{statusLabel(r.status)}</span>
                <span className="tdd__mono">{new Date(start).toLocaleString()}</span>
                {r.attempt > 1 && <span className="tdd__muted">attempt {r.attempt}</span>}
                {dur && <span className="tdd__muted">{dur}</span>}
              </div>
              {r.error_message && (
                <div className="tdd__step-error">
                  {r.error_class && <b>{r.error_class}</b>} {r.error_message}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── EVIDENCE LOG (ported from TaskDetailDialog) ──────────────────────────────
// task-69651204e222 — the run/activity evidence trail, merged from runs +
// messages + notes/flags + the pending question + submitted required outputs,
// sorted chronologically. Lives in the Activity tab (it's run evidence). PHI:
// every text field renders from memory only; never logged/persisted.
type EvKind = 'ok' | 'flag' | 'pause' | 'progress';
const EV_MARKER: Record<EvKind, string> = {
  ok: '✓',
  flag: '⚠',
  pause: '⏸',
  progress: '◐',
};
const EV_RUN_KIND: Record<TaskRun['status'], EvKind> = {
  queued: 'progress',
  running: 'progress',
  retrying: 'progress',
  succeeded: 'ok',
  failed: 'flag',
  cancelled: 'pause',
};
function evRunMessage(run: TaskRun): string {
  switch (run.status) {
    case 'queued':
      return `Run queued (attempt ${run.attempt})`;
    case 'running':
      return `Run in progress (attempt ${run.attempt}, agent: ${run.agent})`;
    case 'retrying':
      return `Retrying (attempt ${run.attempt})`;
    case 'succeeded':
      return `Run succeeded (attempt ${run.attempt})`;
    case 'cancelled':
      return `Run cancelled (attempt ${run.attempt})`;
    case 'failed':
      return `Run failed (attempt ${run.attempt})${run.error_message ? ` — ${run.error_message}` : ''}`;
    default:
      return `Run ${run.status} (attempt ${run.attempt})`;
  }
}
function evTs(input: string | number | null | undefined): string {
  if (input == null) return '—';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
function evMs(iso: string | number | null | undefined): number | null {
  if (iso == null) return null;
  const n = typeof iso === 'number' ? iso : Date.parse(iso);
  return Number.isNaN(n) ? null : n;
}

function EvidenceLog({
  runs,
  task,
  pendingQuestion,
  outputsBlock,
  submittedByKey,
  requiredOutputs,
  requiredSubmittedCount,
}: {
  runs: TaskRun[];
  task: Task;
  pendingQuestion: Task['pending_question'] | null;
  outputsBlock: ReturnType<typeof parseTaskOutputsBlock>;
  submittedByKey: Record<string, string | number | boolean>;
  requiredOutputs: { key: string; label: string; required?: boolean }[];
  requiredSubmittedCount: number;
}) {
  const entries = useMemo(() => {
    const out: Array<{ ts: string; msg: string; kind: EvKind; who: 'agent' | 'human'; sortMs: number }> = [];
    const now = Date.now();
    for (const run of runs) {
      const ms = run.finished_at ?? run.started_at ?? run.scheduled_for ?? now;
      out.push({ ts: evTs(ms), msg: evRunMessage(run), kind: EV_RUN_KIND[run.status] ?? 'progress', who: 'agent', sortMs: ms });
    }
    if (task.notes && task.notes.trim()) {
      const ms = evMs(task.updated_at) ?? now;
      out.push({
        ts: evTs(ms),
        msg: task.notes.trim().split('\n')[0],
        kind: task.status === 'in_progress' ? 'progress' : 'ok',
        who: 'agent',
        sortMs: ms,
      });
    }
    if (pendingQuestion) {
      const ms = evMs(pendingQuestion.asked_at) ?? evMs(task.updated_at) ?? now;
      out.push({ ts: evTs(ms), msg: `Asked: ${pendingQuestion.text}`, kind: 'pause', who: 'agent', sortMs: ms });
    }
    if (outputsBlock) {
      const ms = evMs(task.updated_at) ?? now;
      for (const f of outputsBlock.fields) {
        if (f.required && hasValue(submittedByKey[f.key])) {
          out.push({ ts: evTs(ms), msg: `Evidence: ${f.label} submitted`, kind: 'ok', who: 'agent', sortMs: ms });
        }
      }
      const missing = requiredOutputs.length - requiredSubmittedCount;
      if (missing > 0) {
        out.push({
          ts: evTs(ms),
          msg: `Agent owes ${missing} required output${missing === 1 ? '' : 's'} — evidence incomplete`,
          kind: 'flag',
          who: 'agent',
          sortMs: ms,
        });
      }
    }
    out.sort((a, b) => a.sortMs - b.sortMs);
    return out;
  }, [runs, task, pendingQuestion, outputsBlock, submittedByKey, requiredOutputs, requiredSubmittedCount]);

  if (entries.length === 0) return null;
  return (
    <section className="tdd__sect tdd__evidence-sect">
      <div className="tdd__sect-h">Evidence log</div>
      <ol className="tdd__evidence">
        {entries.map((e, i) => (
          <li key={i} className={`tdd__ev tdd__ev--${e.kind}`}>
            <span className="tdd__ev-marker" aria-hidden="true">
              {EV_MARKER[e.kind]}
            </span>
            <span className="tdd__ev-ts">{e.ts}</span>
            <span className="tdd__ev-msg">
              {e.msg} <span aria-hidden="true">{e.who === 'agent' ? '🤖' : '👤'}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ── DETAILS META ──────────────────────────────────────────────────────────────
// task-b30e546672db — the editable fields now live in the embedded composer
// (the "Task details" tab). This read-only block carries the supplementary
// context the composer doesn't surface: dependency/containment relations and
// the folder. (task-de98e1c6cd18 dropped the "When it runs" schedule block.)
function DetailsMeta({
  task,
  claimedBy,
  claimedByMe,
}: {
  task: Task;
  claimedBy: string | null;
  claimedByMe: boolean;
}) {
  // task-875c6ad17f85 — resolve the parent's title instead of printing the raw
  // `task-…` id (which means nothing to a person). Falls back to "Open parent →"
  // if the lookup hasn't resolved a title. Title may be PHI — it lives only in
  // this in-memory UI (same as the current task's title), never persisted.
  const [parentTitle, setParentTitle] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!task.parentTaskId) {
      setParentTitle(null);
      return;
    }
    void getTask(task.parentTaskId, task.source)
      .then((p) => {
        if (!cancelled) setParentTitle(p?.title?.trim() || null);
      })
      .catch(() => {
        if (!cancelled) setParentTitle(null);
      });
    return () => {
      cancelled = true;
    };
  }, [task.parentTaskId, task.source]);

  const hasDeps =
    !!task.parentTaskId ||
    (!!task.dependsOn && task.dependsOn.length > 0) ||
    (!!task.blockedBy && task.blockedBy.length > 0) ||
    !!claimedBy;
  return (
    <div className="tdd__config">
      {/* dependencies / containment */}
      {hasDeps && (
        <section className="tdd__sect">
          <div className="tdd__sect-h">Dependencies</div>
          <dl className="tdd__meta">
            {task.parentTaskId && (
              <div>
                <dt>Parent</dt>
                <dd>{parentTitle ?? 'Open parent →'}</dd>
              </div>
            )}
            {task.dependsOn && task.dependsOn.length > 0 && (
              <div>
                <dt>Depends on</dt>
                <dd>{task.dependsOn.length} task{task.dependsOn.length === 1 ? '' : 's'}</dd>
              </div>
            )}
            {task.blockedBy && task.blockedBy.length > 0 && (
              <div>
                <dt>Blocked by</dt>
                <dd className="tdd__blocked">
                  {task.blockedBy.length} unmet
                </dd>
              </div>
            )}
            {claimedBy && (
              <div>
                <dt>Claimed</dt>
                {/* task-b8306d2b85c2 — claim freshness (who + relative age +
                    near-expiry against the 2h TTL), not just ownership. */}
                <dd>
                  {claimSummary(
                    claimedBy,
                    claimedByMe,
                    task.claimedAt ?? null,
                  ).replace(/^claimed by /, '')}
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}

      {/* task-b8306d2b85c2 — lifecycle timeline (Created → Claimed → status
          transitions), folded from the per-task audit trail. */}
      {task.source === 'typebuild' && (
        <section className="tdd__sect">
          {/* task-9ab05f87eda3 (U2) — expanded by default here (unlike the
              detail PANEL's collapsed default): lifecycle activity is part of
              the "what happened" story this drawer exists to surface, so it
              shouldn't need a click to see. Renders "No lifecycle events yet"
              harmlessly when there's nothing (NON-REGRESSION for empty tasks). */}
          <TaskTimeline task={task} defaultOpen />
        </section>
      )}

      {/* folder */}
      {task.folder && (
        <section className="tdd__sect">
          <div className="tdd__sect-h">Folder</div>
          <p className="tdd__mono tdd__folder" title={task.folder}>
            {homeRel(task.folder)}
          </p>
        </section>
      )}
    </div>
  );
}

// task-a784a424bd63 — the effective instruction set as a PROVENANCE DOCUMENT:
// instead of a flat list with a one-word scope badge, group the resolved rules
// by their originating scope (Project → Category/payer → Task, general→specific
// per the resolver's `scopes` order) and render each scope as a titled section
// that names the parent it comes from, with its rules underneath. This makes it
// obvious WHERE each instruction comes from. Lives in the Teach tab only.
function InstructionProvenance({ resolved }: { resolved: ResolvedInstructions }) {
  // Human label for a scope KIND (the heading prefix). The scope's own label
  // (e.g. a project name or "payer:HMO") names the specific parent.
  const kindTitle = (kind: string): string => {
    switch (kind) {
      case 'organization':
        return 'Organization';
      case 'project':
        return 'Project';
      case 'category':
        return 'Category';
      case 'parent-task':
        return 'Parent task';
      case 'task':
        return 'This task';
      default:
        return kind;
    }
  };

  if (resolved.total === 0) {
    return (
      <div className="tdd__sect">
        <div className="tdd__sect-h tdd__sect-h--row">
          <span>Effective instructions</span>
          <span className="tdd__prov" title="Effective instruction set across scopes">
            none
          </span>
        </div>
        <p className="tdd__muted">
          No instructions resolved for this task’s scopes yet — teach one below.
        </p>
      </div>
    );
  }

  // Only the scopes that contributed a surviving rule, in general→specific
  // order. Group the rules under each scope by matching scopeId.
  const groups = resolved.scopes.filter((s) => s.count > 0);
  return (
    <div className="tdd__sect">
      <div className="tdd__sect-h tdd__sect-h--row">
        <span>Effective instructions</span>
        <span className="tdd__prov" title="Where these come from">
          {resolved.summary}
        </span>
      </div>
      <div className="tdd__prov-doc">
        {groups.map((scope) => {
          const rules = resolved.rules.filter((r) => r.scopeId === scope.id);
          return (
            <section
              key={scope.id}
              className={`tdd__prov-group tdd__prov-group--${scope.kind}`}
            >
              <header className="tdd__prov-group-head">
                <span className="tdd__prov-group-kind">{kindTitle(scope.kind)}</span>
                <span className="tdd__prov-group-name" title={scope.label}>
                  {scope.label}
                </span>
                <span className="tdd__prov-group-count">
                  {scope.count} rule{scope.count === 1 ? '' : 's'}
                </span>
              </header>
              <ul className="tdd__prov-rules">
                {rules.map((r, i) => (
                  <li key={`${r.key}-${i}`} className="tdd__prov-rule">
                    {r.text}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ── TEACH ─────────────────────────────────────────────────────────────────────
// task-75f0715aa3ee — the dedicated Teach tab: a SCOPE PICKER (Project /
// Category / Task) plus a text area and a Save that routes to the EXISTING
// write-back (persistTeach) for the chosen scope. It shows the currently
// effective instruction context so the user sees what they're adding to.
//
//   • PROJECT  → project-instructions PATCH (owner-only 403, PHI-guard 422 are
//                surfaced as a clear message via persistTeach's structured fail).
//   • TASK     → per-task note (claim-gated + PHI-guarded server-side).
//   • CATEGORY → session-local fallback, clearly marked "server persistence
//                pending" (task-7961735a4ab6 — no server store yet).
//
// This is distinct from teach-by-recording (task-01facbf6b0bc), which records
// BROWSER actions — a different concept; this tab teaches text instructions.
function TeachTab({
  task,
  resolved,
  project,
  onTeach,
}: {
  task: Task;
  resolved: ResolvedInstructions;
  project: Project | null;
  onTeach: (entry: {
    scopeKind: 'task' | 'category' | 'project';
    scopeLabel: string;
    text: string;
  }) => Promise<{ ok: true; pending?: boolean } | { ok: false; message: string }>;
}) {
  const cohorts = (task.flags ?? []).filter((f) => f.includes(':'));
  // Default scope: PROJECT when the task has one (the most reusable place to
  // teach), else TASK. Documented in the header note above.
  const [scope, setScope] = useState<'task' | 'category' | 'project'>(
    task.projectId ? 'project' : 'task',
  );
  const [cohort, setCohort] = useState<string>(cohorts[0] ?? '');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<
    { kind: 'ok' | 'pending' | 'err'; msg: string } | null
  >(null);

  // The instruction context the chosen scope is ADDING TO, so the user sees the
  // before-state. PROJECT → the project's own instructions (the resolver's
  // project-scope rules); TASK/CATEGORY → the resolved rules for that scope.
  const contextRules = useMemo(() => {
    if (scope === 'project') {
      const own = (project?.instructions ?? '').trim();
      if (own) return own.split('\n').map((s) => s.trim()).filter(Boolean);
    }
    return resolved.rules
      .filter((r) =>
        scope === 'category'
          ? r.scopeKind === 'category' && (!cohort || r.scopeLabel === cohort)
          : r.scopeKind === scope,
      )
      .map((r) => r.text);
  }, [scope, cohort, project, resolved.rules]);

  const save = async () => {
    if (saving) return;
    const t = text.trim();
    if (!t) {
      setFeedback({ kind: 'err', msg: 'Nothing to save.' });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const res = await onTeach({
        scopeKind: scope,
        scopeLabel: scope === 'category' ? cohort || 'category' : scope,
        text: t,
      });
      if (res.ok) {
        setText('');
        setFeedback(
          res.pending
            ? {
                kind: 'pending',
                // task-7961735a4ab6 — category instructions have no server store
                // yet; the rule is kept only for this session.
                msg: 'Saved for this session — category instructions aren’t persisted yet (server endpoint pending).',
              }
            : { kind: 'ok', msg: 'Saved.' },
        );
      } else {
        // Keep the text intact so the user can adjust (e.g. PHI-guard 422 or
        // owner-only 403 on project scope).
        setFeedback({ kind: 'err', msg: res.message });
      }
    } finally {
      setSaving(false);
    }
  };

  const scopeBlurb =
    scope === 'project'
      ? 'Teaches the whole PROJECT — applies to every task in it. Owner-only; PHI is rejected.'
      : scope === 'category'
        ? 'Teaches a CATEGORY cohort — applies to tasks sharing that tag.'
        : 'Teaches just THIS task as a per-task note.';

  return (
    <div className="tdd__teachtab">
      {/* task-a784a424bd63 — the effective instruction set as a provenance
          DOCUMENT, grouped by originating scope (Project → Category → Task), so
          the user sees exactly where each instruction comes from. This is the
          ONLY place instructions render now (removed from the Details tab). */}
      <InstructionProvenance resolved={resolved} />

      <div className="tdd__sect">
        <div className="tdd__sect-h">Teach the agent</div>
        <p className="tdd__muted">
          Add an instruction or correction the agent should follow. Pick where it
          applies — the broader the scope, the more tasks it shapes.
        </p>
      </div>

      {/* SCOPE PICKER — segmented Project / Category / Task. */}
      <div className="tdd__sect">
        <div className="tdd__sect-h">Scope</div>
        <div className="tdd__teach-seg" role="radiogroup" aria-label="Teach scope">
          {task.projectId && (
            <button
              type="button"
              role="radio"
              aria-checked={scope === 'project'}
              className={['tdd__seg', scope === 'project' && 'tdd__seg--on'].filter(Boolean).join(' ')}
              onClick={() => setScope('project')}
            >
              Project
            </button>
          )}
          {cohorts.length > 0 && (
            <button
              type="button"
              role="radio"
              aria-checked={scope === 'category'}
              className={['tdd__seg', scope === 'category' && 'tdd__seg--on'].filter(Boolean).join(' ')}
              onClick={() => setScope('category')}
            >
              Category
            </button>
          )}
          <button
            type="button"
            role="radio"
            aria-checked={scope === 'task'}
            className={['tdd__seg', scope === 'task' && 'tdd__seg--on'].filter(Boolean).join(' ')}
            onClick={() => setScope('task')}
          >
            Task
          </button>
        </div>
        <p className="tdd__muted tdd__teach-blurb">{scopeBlurb}</p>
        {scope === 'category' && cohorts.length > 0 && (
          <select
            className="tdd__teach-select"
            value={cohort}
            onChange={(e) => setCohort(e.target.value)}
            aria-label="Category cohort"
          >
            {cohorts.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        {/* task-875c6ad17f85 — the "category instructions aren't persisted yet"
            caveat appeared here AND again as the save-time feedback message; the
            duplicate inline hint is dropped, keeping the save-time message which
            fires exactly when it's relevant. */}
      </div>

      {/* CURRENT CONTEXT — what the CHOSEN scope already carries, so the user
          sees what their new rule is adding to. (The full cross-scope picture is
          the provenance document at the top.) */}
      <div className="tdd__sect">
        <div className="tdd__sect-h">This {scope} already carries</div>
        {contextRules.length === 0 ? (
          <p className="tdd__muted">
            Nothing taught at this scope yet — your first rule starts the set.
          </p>
        ) : (
          <ul className="tdd__rules">
            {contextRules.map((r, i) => (
              <li key={i} className="tdd__rule">
                <span className="tdd__rule-text">{r}</span>
                <span className={`tdd__rule-scope tdd__rule-scope--${scope}`}>{scope}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* EDITOR + SAVE. */}
      <div className="tdd__sect">
        <div className="tdd__sect-h">New instruction</div>
        <textarea
          className="tdd__teach-input"
          placeholder="Add a correction or rule the agent should follow…"
          value={text}
          disabled={saving}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
          }}
        />
        {feedback && (
          <p
            className={`tdd__teach-feedback tdd__teach-feedback--${feedback.kind}`}
            role="status"
          >
            {feedback.msg}
          </p>
        )}
        <div className="tdd__teach-actions">
          <span className="tdd__teach-spacer" />
          <button
            type="button"
            className="tdd__btn"
            onClick={() => void save()}
            disabled={saving || !text.trim()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── SESSION block (lives inside the Activity tab) ────────────────────────────
// task-f60a8003efa9 — the live terminal / replay surface, now a block at the
// top of the Activity tab above the run timeline. When there's no live session
// and no resumable conversation, it renders nothing (the timeline carries the
// "what happened" story on its own) — except to keep the Enter-thread button
// reachable when offered.
function SessionBlock({
  hasLiveSession,
  latestRun,
  onOpenSession,
  onEnterThread,
}: {
  hasLiveSession: boolean;
  latestRun: TaskRun | null;
  onOpenSession: () => void;
  onEnterThread?: () => void;
}) {
  if (!hasLiveSession && !latestRun?.conversation_id && !onEnterThread) return null;
  return (
    <div className="tdd__session">
      {hasLiveSession ? (
        <>
          <div className="tdd__session-live">
            <span className="tdd__pulse tdd__pulse--working" aria-hidden="true" />
            Live session running
          </div>
          <p className="tdd__muted">
            The agent is working in an open terminal tab. Open it to watch what’s happening or steer.
          </p>
          <button type="button" className="tdd__btn" onClick={onOpenSession}>
            Open live session
          </button>
        </>
      ) : latestRun?.conversation_id ? (
        <>
          <p className="tdd__muted">
            The last run finished. Open its session to replay the terminal and see what happened.
          </p>
          <button type="button" className="tdd__btn" onClick={onOpenSession}>
            Open last session
          </button>
          {latestRun.output_path && (
            <div className="tdd__mono tdd__session-path" title="Logs directory">
              {latestRun.output_path}
            </div>
          )}
        </>
      ) : (
        <p className="tdd__muted">
          No session yet. Start the task to open a live terminal session you can watch and steer.
        </p>
      )}
      {onEnterThread && (
        <button type="button" className="tdd__btn tdd__btn--ghost" onClick={onEnterThread}>
          ↳ Enter thread
        </button>
      )}
    </div>
  );
}

export default TaskDetailDrawer;
