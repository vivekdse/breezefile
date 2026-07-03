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
import type { NewHomeTask, TemplateConfig, EvidenceEntry } from './types';
import type { Task, TaskRun } from '../../types';
import { useTaskCustomValues } from './useNewHomeData';
import {
  useTaskRuns,
  useLastRun,
  answerTaskQuestion,
  markQuestionAnswered,
  postTaskMessage,
  formatMessageSendReason,
  injectMessageIntoSession,
} from '../../tasks';
import { fm } from '../../bridge';
import { useStore } from '../../store';
import { useTaskActions } from '../tasks/useTaskActions';
import { useRunningSessions } from '../tasks/useRunningSessions';
import { useOpenResumeInTab } from '../../openResumeInTab';
import {
  answerOptions,
  canSubmitAnswer,
  normalizeAnswer,
} from '../tasks/taskAnswer.mjs';
import { formatOpError, formatSourceReason } from '../../errorMessages';
import { TaskResultView } from '../tasks/TaskResult';
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
  template,
  onClose,
  onResolved,
}: {
  taskId: string;
  task?: NewHomeTask;
  template: TemplateConfig;
  onClose: () => void;
  onResolved: (id: string) => void;
}) {
  const raw = task?.raw;
  const { dispatch } = useStore();
  const actions = useTaskActions();
  const sessions = useRunningSessions();
  const session = sessions.get(taskId);

  // ── evidence sources ──────────────────────────────────────────────────────
  const runs = useTaskRuns(taskId, 50);
  const lastRun = useLastRun(taskId);

  // task-1af4f59428eb (Item 1) — resolve this task's real `data`-backed
  // custom-field values on demand (one ref per template field key, via
  // fm.typebuild.taskData.resolve), the same lazy-on-open pattern as
  // runs/lastRun above. Merged over task.customValues (today always {}, see
  // useNewHomeData) below so a field resolves from the server when present
  // and simply falls back to the existing (currently empty) view-model value
  // otherwise — additive, never regresses the no-data case.
  const resolvedCustomValues = useTaskCustomValues(taskId, template.fields);

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
  }, [runs, raw, pendingQuestion, task]);

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

  const hasCustomFields = template.fields.length > 0 && task;
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

          {(hasCustomFields || hasStandardMeta) && (
            <div className="nh-dialog__section">
              <div className="nh-dialog__section-title">Details</div>
              <div className="nh-dialog__meta-grid">
                {template.fields.map((f) => {
                  // task-1af4f59428eb (Item 1) — prefer the LIVE resolved
                  // value (fetched from the task's `data` bag on open) and
                  // fall back to the view-model's customValues (today always
                  // empty, see useNewHomeData) so a field with no server-side
                  // data entry — or a signed-out/offline resolve — degrades to
                  // exactly today's "omit the row" behavior (NON-REGRESSION).
                  const v = resolvedCustomValues[f.key] ?? task?.customValues[f.key];
                  if (!v) return null;
                  return (
                    <div className="nh-dialog__meta-item" key={f.key}>
                      <div className="nh-dialog__meta-k">{f.label}</div>
                      <div className="nh-dialog__meta-v">{v}</div>
                    </div>
                  );
                })}
                {raw && <StandardMeta task={raw} />}
              </div>
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
