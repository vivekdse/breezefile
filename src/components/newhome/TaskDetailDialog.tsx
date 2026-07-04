// task-10da7557a12a — New Home Task Detail Dialog (spec §3). Centered dialog +
// backdrop (NOT the app's existing slide-in drawer — src/components/tasks/
// TaskDetailDrawer.tsx is untouched). Layout/interactions adapted from the V11
// unified-prototype design reference's detail-panel/dialog block, recolored
// onto app tokens + the shared --nh-* status vars (see NewHomePage.css).
//
// This file owns ALL its own derivations from `task.raw` + the hooks below —
// per the task brief, other newhome/*.tsx files are being edited concurrently
// by other agents and must not be touched (including types.ts/useNewHomeData.ts,
// which are the FINAL prop contract this dialog is built against).
//
// The evidence log is composed from three independent, best-effort sources —
// task runs (useTaskRuns/useLastRun), status transitions/notes/flags already
// carried on task.raw, and the pending-question event — merged and sorted
// chronologically. It renders even when sparse ("Latest activity" style); it
// must NEVER be hidden entirely (see task brief: "this dialog's evidence log
// is the product's trust backbone").
//
// PHI: title / lastAction / customValues VALUES / message text / question text
// / notes / run error text may all carry task content — memory-only, never
// logged or persisted (docs/typebuild-data-field-contract.md).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { NewHomeTask, EvidenceEntry, TaskDef } from './types';
import type { Task, TaskRun } from '../../types';
import {
  useTaskRuns,
  useLastRun,
  answerTaskQuestion,
  markQuestionAnswered,
  postTaskMessage,
  formatMessageSendReason,
  injectMessageIntoSession,
  useTypebuildReadiness,
} from '../../tasks';
import { fm } from '../../bridge';
import { useStore } from '../../store';
import { useTaskActions } from '../tasks/useTaskActions';
import { useRunningSessions } from '../tasks/useRunningSessions';
// task — the "▶ Start" footer button reuses the OLD Tasks page's exact launch
// path: primaryActionFor decides eligibility, useTaskActions().start (→
// runTaskNow) is the same claim-then-launch this dialog's Retry already calls.
import { primaryActionFor } from '../tasks/primaryAction.mjs';
import { isDone } from '../tasks/sections.mjs';
import { useOpenResumeInTab } from '../../openResumeInTab';
import {
  answerOptions,
  canSubmitAnswer,
  normalizeAnswer,
} from '../tasks/taskAnswer.mjs';
import { formatOpError, formatSourceReason } from '../../errorMessages';
import { TaskResultView } from '../tasks/TaskResult';
import {
  parseTaskFieldsBlock,
  parseTaskOutputsBlock,
  parseTaskTemplateBlock,
  resultFields,
  taskDefStatus,
  fieldRef,
} from './taskSchema.mjs';
import { runnableStepId } from './pipelineRoster.mjs';
import './TaskDetailDialog.css';

// ─── small formatting helpers (local — no shared-file dependency) ──────────

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) || p : trimmed;
}

function fmtTs(input: string | number | null | undefined): string {
  if (input == null) return '—';
  const d = typeof input === 'number' ? new Date(input) : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** ms → a short "waiting since" duration, e.g. "1d 3h", "42m". */
function elapsedLabel(sinceMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - sinceMs);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function toMs(iso: string | number | null | undefined): number | null {
  if (iso == null) return null;
  const n = typeof iso === 'number' ? iso : Date.parse(iso);
  return Number.isNaN(n) ? null : n;
}

const RUN_STATUS_KIND: Record<TaskRun['status'], EvidenceEntry['kind']> = {
  queued: 'progress',
  running: 'progress',
  retrying: 'progress',
  succeeded: 'ok',
  failed: 'flag',
  cancelled: 'pause',
};

function runMessage(run: TaskRun): string {
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
      return `Run failed (attempt ${run.attempt})${
        run.error_message ? ` — ${run.error_message}` : ''
      }`;
    default:
      return `Run ${run.status} (attempt ${run.attempt})`;
  }
}

const MARKER: Record<EvidenceEntry['kind'], string> = {
  ok: '✓',
  flag: '⚠',
  pause: '⏸',
  progress: '◐',
};

// ─── task-templates (docs/task-templates-design.md) — Outputs + Pipeline ───
// A child task's body carries a `task-outputs` block (its output field
// DEFINITIONS) and, once the agent submits, a `{type:'fields'}` result (the
// VALUES). A meta-parent's body carries a `task-template` block (the ordered
// task-def id list); its Pipeline section resolves each task-def's status
// from its children. Both degrade to nothing when the body carries neither
// block — see the file-header non-regression note.

// task-4045bcee23cb (U3a polish a) — 'pending' says "Queued" here too, matching
// the roster's own status vocabulary (STATUS_LABEL/META_PILL in RosterTable.tsx)
// so a step never says "Pending" in one place and "Queued" in another for the
// identical not-yet-started state.
const DEF_STATUS_LABEL: Record<ReturnType<typeof taskDefStatus>, string> = {
  done: 'Done',
  active: 'In progress',
  pending: 'Queued',
  skip: 'Not needed',
};

function hasValue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

// ─── metadata grid ──────────────────────────────────────────────────────────

function StandardMeta({ task }: { task: Task }) {
  const items: Array<{ k: string; v: string }> = [];
  if (task.agent?.name) items.push({ k: 'Agent', v: task.agent.name });
  const created = task.createdAtIso ?? (task.created_at ? new Date(task.created_at).toISOString() : null);
  if (created) items.push({ k: 'Created', v: fmtTs(created) });
  if (typeof task.priority === 'number') items.push({ k: 'Priority', v: String(task.priority) });
  if (task.dependsOn && task.dependsOn.length > 0) {
    items.push({ k: 'Depends on', v: `${task.dependsOn.length} task${task.dependsOn.length === 1 ? '' : 's'}` });
  }
  if (items.length === 0) return null;
  return (
    <>
      {items.map((it) => (
        <div className="nh-dialog__meta-item" key={it.k}>
          <div className="nh-dialog__meta-k">{it.k}</div>
          <div className="nh-dialog__meta-v">{it.v}</div>
        </div>
      ))}
    </>
  );
}

export function TaskDetailDialog({
  taskId,
  task,
  tasks,
  onClose,
  onResolved,
  onOpenTask,
}: {
  taskId: string;
  task?: NewHomeTask;
  /** task-d83c6ada2d18 — the full (unfiltered) roster snapshot, used ONLY to
   *  resolve a meta-parent's children for the Pipeline rollup (matched via
   *  `raw.parentTaskId === taskId`). Optional/additive: omitted or empty ⇒
   *  the Pipeline section simply has nothing to resolve, same as a task with
   *  no `task-template` block (NON-REGRESSION). */
  tasks?: NewHomeTask[];
  onClose: () => void;
  onResolved: (id: string) => void;
  /** task-d83c6ada2d18 — opens another task in this same dialog (used by the
   *  Pipeline section's rows to jump to a child). Optional: when absent,
   *  Pipeline rows render without a click affordance. */
  onOpenTask?: (id: string) => void;
}) {
  const raw = task?.raw;
  const { dispatch } = useStore();
  const actions = useTaskActions();
  const sessions = useRunningSessions();
  const session = sessions.get(taskId);

  // ── evidence sources ──────────────────────────────────────────────────────
  const runs = useTaskRuns(taskId, 50);
  const lastRun = useLastRun(taskId);

  // ── project name (best-effort; NewHomePage's prop contract doesn't carry
  //    the projects list down to this dialog, so we resolve it ourselves —
  //    non-blocking, never throws, absent = context line just omits it). ──
  const [projectName, setProjectName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const pid = raw?.projectId;
    if (!pid) {
      setProjectName(null);
      return;
    }
    void fm.typebuild.projects
      .get(pid)
      .then((p) => {
        if (!cancelled) setProjectName(p?.name ?? null);
      })
      .catch(() => {
        if (!cancelled) setProjectName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [raw?.projectId]);

  // ── answer form (mirrors TaskAnswerBox's call shape — not the component) ──
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [freeText, setFreeText] = useState('');
  const [answering, setAnswering] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);

  // ── talk-back (message) ───────────────────────────────────────────────────
  // `messageSent` is the confirmation line shown after a successful send —
  // null = nothing to confirm; otherwise the exact human-facing text (differs
  // when the message was ALSO piped into an open session tab).
  const [messageDraft, setMessageDraft] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [messageSent, setMessageSent] = useState<string | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const openResumeInTab = useOpenResumeInTab();

  // Reset per-task local state when the open task changes.
  useEffect(() => {
    setSelectedOption(null);
    setFreeText('');
    setAnswering(false);
    setAnswerError(null);
    setMessageDraft('');
    setSendingMessage(false);
    setMessageError(null);
    setMessageSent(null);
  }, [taskId]);

  // Escape closes; backdrop click closes (via onClick below).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pendingQuestion = task?.pendingQuestion ?? null;
  const options = useMemo(() => answerOptions(pendingQuestion), [pendingQuestion]);
  const draftAnswer = selectedOption ?? freeText;

  async function submitAnswer(raw_: string) {
    const answer = normalizeAnswer(raw_);
    if (!answer || answering) return;
    setAnswering(true);
    setAnswerError(null);
    try {
      const res = await answerTaskQuestion(taskId, answer);
      if (res.ok) {
        markQuestionAnswered(taskId);
        onResolved(taskId);
        onClose();
      } else {
        setAnswerError(formatSourceReason(res.reason));
      }
    } catch (e) {
      setAnswerError(formatOpError('send answer', e));
    } finally {
      setAnswering(false);
    }
  }

  // Works on a task in ANY status (open/in_progress/blocked/failed/done/
  // cancelled) — the server's /messages append is visibility-gated only. When
  // `alsoOpenSession` is set (the "Send & open session" button) a successful
  // API append is followed by an openResumeInTab resume of the task's last
  // recorded conversation, so the agent picks the message up promptly.
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
      const res = await postTaskMessage(taskId, text);
      if (res.ok) {
        setMessageDraft('');
        if (session) {
          // A live session tab exists in THIS window: also type the message
          // into its pty (same channel openResumeInTab uses for the resume
          // command) so the running agent sees it immediately, not on its next
          // task poll.
          injectMessageIntoSession(session.ptyId, text);
          setMessageSent('Sent — delivered to the open session');
        } else if (alsoOpenSession && raw?.folder && lastRun?.conversation_id) {
          setMessageSent('Sent — opening the session…');
          await openResumeInTab(raw.folder, lastRun.conversation_id, raw.title);
          onClose();
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

  function openSession() {
    if (!session) return;
    dispatch({ type: 'selectTab', index: session.tabIndex });
    onClose();
  }

  function cancelTask() {
    if (!raw) return;
    const req = {
      title: `Cancel "${raw.title}"?`,
      body: 'The agent will stop working on this task.',
      confirmLabel: 'Cancel task',
      destructive: true,
      onConfirm: async () => {
        if (raw.source === 'typebuild') {
          await actions.sourceAction(raw, 'cancel');
        } else {
          await actions.remove(raw);
        }
        onResolved(taskId);
        onClose();
      },
    };
    window.dispatchEvent(new CustomEvent('fm:confirm', { detail: req }));
  }

  function retry() {
    if (!raw) return;
    void actions.start(raw);
  }

  // ▶ Start — the SAME claim-then-launch path the old Tasks page's play button
  // (and this dialog's Retry) uses: useTaskActions().start → runTaskNow. No new
  // launch path.
  function startTask() {
    if (!raw) return;
    void actions.start(raw);
  }

  // Start eligibility: reuse primaryActionFor — the OLD Tasks page's single
  // source of truth — with the same ctx it assembles (source caps, TypeBuild
  // readiness + my email, any live local session, and whether this is a
  // container parent with still-open children, which can't be Started yet).
  // hasOpenChildren is derived from the roster snapshot passed down (`tasks`),
  // matching the parent-vs-child rule the roster already uses. PHI: only
  // ids/status/claim/parent metadata are read — never task text.
  const tbReady = useTypebuildReadiness();
  const hasOpenChildren = useMemo(() => {
    if (!raw || !tasks) return false;
    return tasks.some((t) => t.raw.parentTaskId === taskId && !isDone(t.raw));
  }, [raw, tasks, taskId]);
  const startAction = useMemo(() => {
    if (!raw) return null;
    const pa = primaryActionFor(raw, {
      caps: actions.caps(raw),
      tbReady,
      myEmail: tbReady.email,
      session,
      hasOpenChildren,
    });
    return pa.kind === 'start' ? { enabled: pa.enabled, tooltip: pa.tooltip } : null;
  }, [raw, actions, tbReady, session, hasOpenChildren]);

  // ── task-templates: this task's own output DEFINITIONS + submitted VALUES ─
  // A CHILD task's body carries `task-outputs` (definitions); once the agent
  // submits, `raw.result` carries `{type:'fields', payload:{taskDefId,
  // fields}}` (values) — see docs/task-templates-design.md. Both parse
  // fail-soft to null so a task with neither block/result degrades to
  // exactly today's rendering.
  const outputsBlock = useMemo(() => parseTaskOutputsBlock(raw?.notes ?? null), [raw?.notes]);
  const submittedOutputs = useMemo(() => resultFields(raw?.result ?? null), [raw?.result]);
  // Only trust the submitted result against THIS task's declared outputs when
  // the taskDefIds actually match (defensive against a stray/mismatched
  // result on the same task).
  const submittedByKey = useMemo(() => {
    if (!outputsBlock || !submittedOutputs) return {};
    if (submittedOutputs.taskDefId !== outputsBlock.taskDefId) return {};
    return submittedOutputs.fields;
  }, [outputsBlock, submittedOutputs]);
  const requiredOutputs = useMemo(
    () => (outputsBlock?.fields ?? []).filter((f) => f.required),
    [outputsBlock],
  );
  const requiredSubmittedCount = useMemo(
    () => requiredOutputs.filter((f) => hasValue(submittedByKey[f.key])).length,
    [requiredOutputs, submittedByKey],
  );
  const requiredMissingCount = requiredOutputs.length - requiredSubmittedCount;

  // ── task-templates: META PARENT pipeline rollup ───────────────────────────
  // A meta-parent's body carries `task-template` (ordered task-def ids); its
  // children each carry `task-fields` (input VALUES, keyed by taskDefId) and,
  // once worked, a `{type:'fields'}` result (output VALUES). Resolve the
  // ordered TaskDef definitions from the project's template config, match
  // children to task-defs by parsing each child's body, merge every value
  // into one `valuesByRef` map, and derive each step's status/outcome from
  // it — same helpers (`taskDefStatus`, `fieldRef`) the design doc specifies.
  const templateBlock = useMemo(() => parseTaskTemplateBlock(raw?.notes ?? null), [raw?.notes]);
  const childTasks = useMemo(() => {
    if (!templateBlock || !tasks || !tasks.length) return [];
    return tasks.filter((t) => t.raw.parentTaskId === taskId);
  }, [templateBlock, tasks, taskId]);
  const childByDefId = useMemo(() => {
    const map = new Map<string, NewHomeTask>();
    for (const c of childTasks) {
      const fb = parseTaskFieldsBlock(c.raw.notes ?? null);
      if (fb) map.set(fb.taskDefId, c);
    }
    return map;
  }, [childTasks]);
  const pipelineValuesByRef = useMemo(() => {
    const out: Record<string, string | number> = {};
    for (const c of childTasks) {
      const fb = parseTaskFieldsBlock(c.raw.notes ?? null);
      if (fb) {
        for (const [k, v] of Object.entries(fb.values)) {
          if (typeof v === 'string' || typeof v === 'number') out[fieldRef(fb.taskDefId, k)] = v;
        }
      }
      const rf = resultFields(c.raw.result ?? null);
      if (rf) {
        // task-2638eeedd9ef: a canonical FLAT result carries no taskDefId —
        // fall back to the input block's def id (above), else this child's
        // own task-outputs block def id, so the values still land under the
        // right pipeline group.
        const rDefId = rf.taskDefId ?? fb?.taskDefId ?? parseTaskOutputsBlock(c.raw.notes ?? null)?.taskDefId;
        if (rDefId) {
          for (const [k, v] of Object.entries(rf.fields)) {
            out[fieldRef(rDefId, k)] = typeof v === 'boolean' ? String(v) : v;
          }
        }
      }
    }
    return out;
  }, [childTasks]);
  // task-2fd63b922beb / task-b1fa5098da3e (R3) — v2 blocks are self-describing
  // (full TaskDefs on the parent itself, docs/task-templates-design.md); a v1
  // legacy block only carried id refs into a project-level TemplateConfig
  // that no longer exists (removed R3) — it degrades to no pipeline section
  // rather than trying to resolve anything.
  const pipelineDefs = useMemo<TaskDef[]>(() => templateBlock?.defs ?? [], [templateBlock]);
  // task-4045bcee23cb (U3a #3) — the SAME "which step is runnable next" rule
  // the roster's group-header chips and parent Start-chain use, so this
  // rollup's ▶ never drifts from the roster's.
  const pipelineRunnableId = useMemo(
    () => runnableStepId(pipelineDefs, pipelineValuesByRef),
    [pipelineDefs, pipelineValuesByRef],
  );

  // ── evidence log: merge runs + messages + pending question + notes/flags ──
  const evidence = useMemo<EvidenceEntry[]>(() => {
    const entries: Array<EvidenceEntry & { sortMs: number }> = [];
    const now = Date.now();

    for (const run of runs) {
      const ms = run.finished_at ?? run.started_at ?? run.scheduled_for ?? now;
      entries.push({
        ts: fmtTs(ms),
        msg: runMessage(run),
        kind: RUN_STATUS_KIND[run.status] ?? 'progress',
        who: 'agent',
        sortMs: ms,
      });
    }

    if (raw?.messages) {
      for (const m of raw.messages) {
        const ms = toMs(m.at) ?? now;
        const who: EvidenceEntry['who'] =
          raw.agent?.name && m.by === raw.agent.name ? 'agent' : 'human';
        entries.push({ ts: fmtTs(ms), msg: m.text, kind: 'ok', who, sortMs: ms });
      }
    }

    if (raw?.notes && raw.notes.trim()) {
      const ms = toMs(raw.updatedAtIso) ?? raw.updated_at ?? now;
      entries.push({
        ts: fmtTs(ms),
        msg: raw.notes.trim().split('\n')[0],
        kind: raw.status === 'in_progress' ? 'progress' : 'ok',
        who: 'agent',
        sortMs: ms,
      });
    }

    if (raw?.flags) {
      for (const f of raw.flags) {
        const ms = toMs(raw.updatedAtIso) ?? raw.updated_at ?? now;
        entries.push({ ts: fmtTs(ms), msg: `Flag: ${f}`, kind: 'flag', who: 'agent', sortMs: ms });
      }
    }

    if (pendingQuestion) {
      const ms = toMs(pendingQuestion.asked_at) ?? toMs(raw?.updatedAtIso) ?? now;
      entries.push({
        ts: fmtTs(ms),
        msg: `Asked: ${pendingQuestion.text}`,
        kind: 'pause',
        who: 'agent',
        sortMs: ms,
      });
    }

    // task-d83c6ada2d18 — submitted required outputs become first-class
    // evidence entries (design doc: "Evidence log: submitted required outputs
    // appear as first-class entries"); a shortfall becomes ONE synthetic flag
    // entry rather than one-per-missing-field, so the log stays skimmable.
    if (outputsBlock) {
      const ms = toMs(raw?.updatedAtIso) ?? raw?.updated_at ?? now;
      for (const f of outputsBlock.fields) {
        if (f.required && hasValue(submittedByKey[f.key])) {
          entries.push({
            ts: fmtTs(ms),
            msg: `Evidence: ${f.label} submitted`,
            kind: 'ok',
            who: 'agent',
            sortMs: ms,
          });
        }
      }
      if (requiredMissingCount > 0) {
        entries.push({
          ts: fmtTs(ms),
          msg: `Agent owes ${requiredMissingCount} required output${requiredMissingCount === 1 ? '' : 's'} — evidence incomplete`,
          kind: 'flag',
          who: 'agent',
          sortMs: ms,
        });
      }
    }

    if (entries.length === 0 && task) {
      const ms = toMs(raw?.updatedAtIso) ?? raw?.updated_at ?? now;
      entries.push({
        ts: fmtTs(ms),
        msg: task.lastAction || `status: ${task.status}`,
        kind: task.status === 'failed' ? 'flag' : task.status === 'done' ? 'ok' : 'progress',
        who: task.who === 'human' ? 'human' : 'agent',
        sortMs: ms,
      });
    }

    entries.sort((a, b) => a.sortMs - b.sortMs);
    return entries.map(({ sortMs: _sortMs, ...e }) => e);
  }, [runs, raw, pendingQuestion, task, outputsBlock, submittedByKey, requiredMissingCount]);

  // ── attachments: run output_path values, deduped ──────────────────────────
  const attachments = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ path: string; name: string }> = [];
    for (const run of runs) {
      if (run.output_path && !seen.has(run.output_path)) {
        seen.add(run.output_path);
        list.push({ path: run.output_path, name: basename(run.output_path) });
      }
    }
    return list;
  }, [runs]);

  const status = task?.status;
  const now = Date.now();
  const waitingSinceMs =
    status === 'needs'
      ? toMs(pendingQuestion?.asked_at) ?? toMs(raw?.updatedAtIso) ?? raw?.updated_at ?? null
      : null;

  const failureRun = status === 'failed' ? runs.find((r) => r.status === 'failed') ?? lastRun : null;

  const hasStandardMeta =
    !!raw &&
    (!!raw.agent?.name ||
      !!(raw.createdAtIso ?? raw.created_at) ||
      typeof raw.priority === 'number' ||
      (!!raw.dependsOn && raw.dependsOn.length > 0));

  return (
    <div className="nh-dialog-backdrop" onClick={onClose}>
      <div
        className="nh-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nh-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="nh-dialog__head">
          <div>
            <div id="nh-dialog-title" className="nh-dialog__title">
              {task?.title ?? taskId}
            </div>
            <div className="nh-dialog__sub">
              {[projectName, raw?.agent?.name].filter(Boolean).join(' · ') || 'No project/agent context'}
            </div>
            <div className="nh-dialog__badges">
              {status && (
                <span className={`nh-dialog__pill nh-dialog__pill--${status}`}>{status}</span>
              )}
              {waitingSinceMs != null && (
                <span className="nh-dialog__waiting">
                  ⏱ waiting since {fmtTs(waitingSinceMs)} · {elapsedLabel(waitingSinceMs, now)}
                </span>
              )}
            </div>
          </div>
          <button type="button" className="nh-dialog__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="nh-dialog__body">
          {status === 'needs' && pendingQuestion && (
            <div className="nh-dialog__section">
              <div className="nh-dialog__question-box">
                <div className="nh-dialog__question-label">Agent question</div>
                <div className="nh-dialog__question-text">{pendingQuestion.text}</div>
              </div>
              {options.length > 0 && (
                <div className="nh-dialog__radio-group">
                  {options.map((opt) => (
                    <label
                      key={opt}
                      className={`nh-dialog__radio-opt${selectedOption === opt ? ' nh-dialog__radio-opt--checked' : ''}`}
                    >
                      <input
                        type="radio"
                        name="nh-answer"
                        checked={selectedOption === opt}
                        onChange={() => setSelectedOption(opt)}
                      />
                      {opt}
                    </label>
                  ))}
                </div>
              )}
              <textarea
                className="nh-dialog__textarea"
                placeholder={
                  options.length > 0
                    ? 'Additional message to the agent (optional)…'
                    : 'Type your answer…'
                }
                value={freeText}
                disabled={answering}
                onChange={(e) => {
                  setFreeText(e.target.value);
                  if (options.length === 0) setSelectedOption(null);
                }}
              />
              {answerError && (
                <div className="nh-dialog__error" role="alert">
                  Couldn’t send · {answerError}
                </div>
              )}
            </div>
          )}

          {status === 'failed' && (
            <div className="nh-dialog__section">
              <div className="nh-dialog__failure-box">
                <div className="nh-dialog__question-label nh-dialog__question-label--danger">Failure</div>
                <div className="nh-dialog__question-text nh-dialog__question-text--danger">
                  {failureRun?.error_message ??
                    task?.risk ??
                    'This task failed and needs attention.'}
                </div>
                {raw?.attempts != null && raw?.maxAttempts != null && (
                  <div className="nh-dialog__failure-attempts">
                    {raw.attempts}/{raw.maxAttempts} attempts
                  </div>
                )}
              </div>
            </div>
          )}

          {hasStandardMeta && (
            <div className="nh-dialog__section">
              <div className="nh-dialog__section-title">Details</div>
              <div className="nh-dialog__meta-grid">{raw && <StandardMeta task={raw} />}</div>
            </div>
          )}

          {outputsBlock && outputsBlock.fields.length > 0 && (
            <div className="nh-dialog__section">
              <div className="nh-dialog__section-title">Outputs</div>
              <div className="nh-dialog__outputs">
                {outputsBlock.fields.map((f) => {
                  const v = submittedByKey[f.key];
                  const submitted = hasValue(v);
                  return (
                    <div className="nh-dialog__output-item" key={f.key}>
                      <div className="nh-dialog__output-k">
                        {f.label}
                        <span className="nh-dialog__output-type">{f.type}</span>
                        {f.required && (
                          <span className="nh-dialog__output-required">required — evidence</span>
                        )}
                      </div>
                      <div
                        className={`nh-dialog__output-v${submitted ? '' : ' nh-dialog__output-v--pending'}`}
                      >
                        {submitted ? String(v) : 'awaiting agent'}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="nh-dialog__completion-line">
                {requiredOutputs.length > 0
                  ? `${requiredSubmittedCount} of ${requiredOutputs.length} required outputs submitted`
                  : 'No required outputs for this step'}
              </div>
            </div>
          )}

          {templateBlock && pipelineDefs.length > 0 && (
            <div className="nh-dialog__section">
              <div className="nh-dialog__section-title">Pipeline</div>
              <ol className="nh-dialog__pipeline">
                {pipelineDefs.map((def, i) => {
                  const defStatus = taskDefStatus(def, pipelineValuesByRef);
                  const child = childByDefId.get(def.id);
                  const firstOutput = def.outputs.find((f) =>
                    hasValue(pipelineValuesByRef[fieldRef(def.id, f.key)]),
                  );
                  const outcome = firstOutput
                    ? `${firstOutput.label}=${pipelineValuesByRef[fieldRef(def.id, firstOutput.key)]}`
                    : null;
                  const clickable = !!child && !!onOpenTask;
                  // task-4045bcee23cb (U3a #3) — same actionsFor
                  // (primaryActionFor) eligibility as the roster's row
                  // Start / step chips; this rollup just adds another entry
                  // point to the identical rule.
                  const runnable = def.id === pipelineRunnableId;
                  const stepStart =
                    runnable && child
                      ? (() => {
                          const pa = primaryActionFor(child.raw, {
                            caps: actions.caps(child.raw),
                            tbReady,
                            myEmail: tbReady.email,
                            session: sessions.get(child.id),
                          });
                          return pa.kind === 'start' ? { enabled: pa.enabled, tooltip: pa.tooltip } : null;
                        })()
                      : null;
                  return (
                    <li
                      key={def.id}
                      className={`nh-dialog__pipeline-row${clickable ? ' nh-dialog__pipeline-row--clickable' : ''}`}
                      onClick={clickable ? () => onOpenTask!(child!.id) : undefined}
                      role={clickable ? 'button' : undefined}
                      tabIndex={clickable ? 0 : undefined}
                    >
                      <span className="nh-dialog__pipeline-idx">{i + 1}</span>
                      <span className="nh-dialog__pipeline-name">{def.name}</span>
                      <span
                        className={`nh-dialog__pipeline-pill nh-dialog__pipeline-pill--${defStatus}`}
                      >
                        {DEF_STATUS_LABEL[defStatus]}
                      </span>
                      <span className="nh-dialog__pipeline-outcome">{outcome ?? '—'}</span>
                      {stepStart && (
                        <button
                          type="button"
                          className="nh-dialog__pipeline-start"
                          disabled={!stepStart.enabled}
                          title={stepStart.tooltip ?? 'Start this step'}
                          onClick={(e) => {
                            e.stopPropagation();
                            void actions.start(child!.raw);
                          }}
                        >
                          {'▶ Start'}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          <div className="nh-dialog__section">
            <div className="nh-dialog__section-title">Evidence log</div>
            <ol className="nh-dialog__evidence">
              {evidence.map((e, i) => (
                <li key={i} className={`nh-dialog__evidence-item nh-dialog__evidence-item--${e.kind}`}>
                  <span className="nh-dialog__evidence-marker" aria-hidden="true">
                    {MARKER[e.kind]}
                  </span>
                  <div className="nh-dialog__evidence-ts">{e.ts}</div>
                  <div className="nh-dialog__evidence-msg">
                    {e.msg} <span className="nh-dialog__evidence-who">{e.who === 'agent' ? '🤖' : '👤'}</span>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {attachments.length > 0 && (
            <div className="nh-dialog__section">
              <div className="nh-dialog__section-title">Attachments</div>
              <div className="nh-dialog__attachments">
                {attachments.map((a) => (
                  <button
                    type="button"
                    key={a.path}
                    className="nh-dialog__attachment"
                    onClick={() => void fm.open(a.path)}
                    title={a.path}
                  >
                    <span className="nh-dialog__attach-icon" aria-hidden="true">📄</span>
                    <span className="nh-dialog__attach-name">{a.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {(status === 'done' || status === 'failed') && (
            <div className="nh-dialog__section">
              <div className="nh-dialog__section-title">Outcome</div>
              <TaskResultView result={raw?.result} />
              {!raw?.result && (
                <div className="nh-dialog__outcome-fallback">
                  {task?.lastAction || 'No structured result recorded.'}
                </div>
              )}
            </div>
          )}

          <div className="nh-dialog__section">
            <div className="nh-dialog__section-title">Talk back</div>
            <div className="nh-dialog__talkback">
              {session ? (
                <button type="button" className="nh-dialog__btn" onClick={openSession}>
                  Open session
                </button>
              ) : (
                // TODO(New Home follow-up) — headed-session detection only covers
                // sessions open as a tab IN THIS window (useRunningSessions walks
                // local tab state). A headed session running in another window/
                // machine has no cheap signal here; the message path below always
                // works regardless (headless resume is existing plumbing).
                <div className="nh-dialog__hint">No open session in this window — message reaches the agent either way.</div>
              )}
              <textarea
                ref={messageRef}
                className="nh-dialog__textarea"
                placeholder="Send a message to the agent…"
                value={messageDraft}
                disabled={sendingMessage}
                onChange={(e) => {
                  setMessageDraft(e.target.value);
                  setMessageSent(null);
                }}
              />
              <div className="nh-dialog__talkback-row">
                <button
                  type="button"
                  className="nh-dialog__btn"
                  disabled={sendingMessage || !messageDraft.trim()}
                  onClick={() => void sendMessage()}
                >
                  {sendingMessage ? 'Sending…' : 'Send message'}
                </button>
                {!session && raw?.folder && lastRun?.conversation_id && (
                  // No live tab, but the last run recorded a resumable
                  // conversation: offer send + resume in one step. Plain
                  // "Send message" stays the default (API append only —
                  // headless resume-on-answer plumbing wakes daemons).
                  <button
                    type="button"
                    className="nh-dialog__btn"
                    disabled={sendingMessage || !messageDraft.trim()}
                    onClick={() => void sendMessage(true)}
                  >
                    Send &amp; open session
                  </button>
                )}
                {messageSent && <span className="nh-dialog__sent">{messageSent}</span>}
              </div>
              {messageError && (
                <div className="nh-dialog__error" role="alert">
                  Couldn’t send · {messageError}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="nh-dialog__footer">
          <button type="button" className="nh-dialog__btn nh-dialog__btn--danger" onClick={cancelTask}>
            Cancel Task
          </button>
          <button
            type="button"
            className="nh-dialog__btn"
            disabled={sendingMessage || !messageDraft.trim()}
            onClick={() => void sendMessage()}
          >
            Send Message
          </button>
          {/* ▶ Start — shown for a start-eligible task that isn't the
              answer/retry case (a 'failed' row already gets Retry, which is the
              same start mechanism). Disabled + tooltip mirror the old play
              button when TypeBuild isn't ready yet. */}
          {startAction && status !== 'needs' && status !== 'failed' && (
            <button
              type="button"
              className="nh-dialog__btn nh-dialog__btn--start"
              disabled={!startAction.enabled}
              title={startAction.tooltip}
              onClick={startTask}
            >
              {'▶ Start'}
            </button>
          )}
          {status === 'needs' && pendingQuestion ? (
            <button
              type="button"
              className="nh-dialog__btn nh-dialog__btn--primary"
              disabled={!canSubmitAnswer(draftAnswer, answering)}
              onClick={() => void submitAnswer(draftAnswer)}
            >
              {answering ? 'Submitting…' : 'Submit Answer'}
            </button>
          ) : status === 'failed' ? (
            <button type="button" className="nh-dialog__btn nh-dialog__btn--warn" onClick={retry}>
              Retry
            </button>
          ) : (
            <button type="button" className="nh-dialog__btn nh-dialog__btn--primary" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
