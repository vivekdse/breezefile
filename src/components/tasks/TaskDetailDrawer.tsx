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
} from '../../tasks';
import { useOpenResumeInTab } from '../../openResumeInTab';
import { useRunningSessions } from './useRunningSessions';
import { useTaskActions } from './useTaskActions';
import { primaryActionFor } from './primaryAction.mjs';
import type { PrimaryAction } from './primaryAction.mjs';
import { PrimaryActionButton } from './PrimaryActionButton';
import { formatOpError, formatSourceReason } from '../../errorMessages';
import { TaskStatusDot } from '../TaskIndicators';
import { homeRel } from './helpers';
import '../TasksPage.css';
import { resolveEffectiveInstructions } from '../../projects/index.mjs';
import type {
  CategoryScopeSource,
  ResolvedInstructions,
} from '../../projects/index.mjs';
import { TaskComposer } from '../TaskComposer';
import type { Project, Task, TaskRun } from '../../types';
import './TaskDetailDrawer.css';

// task-b30e546672db — the former 'config' tab IS the task itself. It's renamed
// "Task details", made the FIRST tab, and rendered by reusing the new-task
// composer form (prefilled + editable). The legacy 'config' id is accepted on
// the `initialTab` prop and mapped to 'details' for back-compat with callers
// (TasksPage's openDetail still passes 'config').
type DrawerTab = 'details' | 'trace' | 'session';
type InitialTab = DrawerTab | 'config';
function normalizeTab(t: InitialTab | undefined): DrawerTab | undefined {
  if (t === 'config') return 'details';
  return t;
}

// A live-status descriptor: the ONE colored signal per the design language
// (working=accent, needs-you=warn, blocked=err, neutral otherwise).
type LiveTone = 'working' | 'needs-you' | 'blocked' | 'done' | 'neutral';

function liveToneFor(task: Task, running: boolean): { tone: LiveTone; label: string } {
  const raw = (task.rawStatus ?? task.status).toLowerCase();
  if (running || raw === 'running' || raw === 'in_progress' || raw === 'working' || raw === 'claimed')
    return { tone: 'working', label: running ? 'Working' : raw === 'claimed' ? 'Claimed' : 'Working' };
  if (raw === 'blocked') return { tone: 'blocked', label: 'Blocked' };
  if (raw === 'waiting' || raw === 'needs_input' || raw === 'partial')
    return { tone: 'needs-you', label: 'Needs you' };
  if (raw === 'done' || raw === 'succeeded' || raw === 'completed')
    return { tone: 'done', label: 'Done' };
  if (raw === 'cancelled' || raw === 'failed') return { tone: 'neutral', label: raw };
  return { tone: 'neutral', label: raw === 'pending' ? 'Pending' : raw };
}

export function TaskDetailDrawer({
  task,
  initialTab,
  onClose,
}: {
  task: Task;
  initialTab?: InitialTab;
  onClose: () => void;
}) {
  const { exit, state } = useOverlayExit(onClose);
  const { dispatch } = useStore();
  const actions = useTaskActions();
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

  const [tab, setTab] = useState<DrawerTab>(
    normalizeTab(initialTab) ?? (running || latestRun ? 'trace' : 'details'),
  );

  const say = useCallback(
    (msg: string) => dispatch({ type: 'setStatus', msg }),
    [dispatch],
  );

  // ── PHI body (lazy, memory-only) ──────────────────────────────────────────
  const [body, setBody] = useState<string | null>(task.notes ?? null);
  const reqRef = useRef(0);
  // task-b30e546672db — re-pull the decrypted body after an embedded-editor save
  // so the read-only surfaces (and the next edit's prefill) reflect the change.
  const refreshBody = useCallback(() => {
    if (!isTypebuild) {
      setBody(task.notes ?? null);
      return;
    }
    const myReq = ++reqRef.current;
    void getTask(task.id, 'typebuild')
      .then((full) => {
        if (reqRef.current === myReq) setBody(full?.notes ?? null);
      })
      .catch(() => {
        if (reqRef.current === myReq) setBody(null);
      });
  }, [isTypebuild, task.id, task.notes]);
  useEffect(() => {
    if (!isTypebuild) {
      setBody(task.notes ?? null);
      return;
    }
    setBody(null);
    refreshBody();
    return () => {
      // Drop the decrypted body the instant we leave this task.
      setBody(null);
    };
  }, [task.id, isTypebuild, task.notes, refreshBody]);

  // ── effective instruction set (foundation resolver) ───────────────────────
  // Resolve the project leg lazily (NON-PHI) and feed task notes as the task
  // scope. Category cohorts ride on task.flags (e.g. 'payer:HMO') when present.
  const [project, setProject] = useState<Project | null>(null);
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

  // Local teach-in-the-moment additions, keyed by scope, applied on top of the
  // resolved set this session (the real persistence is a follow-up — the scope
  // model + provenance is wired now).
  const [taught, setTaught] = useState<
    Array<{ scopeKind: 'task' | 'category' | 'project'; scopeLabel: string; text: string }>
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
      const order: DrawerTab[] = ['details', 'trace', 'session'];
      if (e.key === '1') setTab('details');
      else if (e.key === '2') setTab('trace');
      else if (e.key === '3') setTab('session');
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
  }, [tab, canStop, canEnterThread, session, latestRun, raw]);

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

        <h2 className="tdd__title">{task.title}</h2>

        {/* live action row — the row's ONE primary affordance (Start/run, claim,
            run-now, …) + Enter thread + Stop (calm-by-default, only shown when
            actionable). task-31b382ab2e4c: the primary button is rendered from
            the SAME pure descriptor the row uses; Enter-thread is suppressed when
            the primary already enters the thread, so the header never shows two
            competing primaries. */}
        {(showPrimaryButton || showEnterThread || canStop) && (
          <div className="tdd__actionrow">
            {showPrimaryButton && (
              <PrimaryActionButton action={primary} onInvoke={invokePrimary} variant="detail" />
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

        {/* segmented tabs — task-b30e546672db: "Task details" is now FIRST. */}
        <nav className="tdd__tabs" role="tablist" aria-label="Detail sections">
          {(['details', 'trace', 'session'] as DrawerTab[]).map((id, i) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={['tdd__tab', tab === id && 'tdd__tab--on'].filter(Boolean).join(' ')}
              onClick={() => setTab(id)}
            >
              {id === 'details' ? 'Task details' : id === 'trace' ? 'Trace' : 'Session'}
              <kbd>{i + 1}</kbd>
            </button>
          ))}
        </nav>

        <div className="tdd__body">
          {tab === 'trace' && (
            <TraceTab runs={runs} running={running} liveLabel={liveLabel} tone={tone} />
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
              {/* The effective instruction set + teach-in-the-moment is unique to
                  the detail view (not part of create), so it lives below the
                  editable form. */}
              <InstructionSet
                resolved={resolved}
                task={task}
                onTeach={(entry) => setTaught((prev) => [...prev, entry])}
              />
            </div>
          )}
          {tab === 'session' && (
            <SessionTab
              hasLiveSession={!!session}
              latestRun={latestRun}
              onOpenSession={openSession}
              onEnterThread={canEnterThread ? enterThread : undefined}
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
          <span className="tdd__foot-spacer" />
          <span className="tdd__hint">
            <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> tabs · <kbd>Esc</kbd> close
          </span>
        </footer>
      </aside>
    </div>
  );
}

// ── TRACE ────────────────────────────────────────────────────────────────────
function TraceTab({
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
                <span className={`tdd__run-status tdd__run-status--${r.status}`}>{r.status}</span>
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
                <dd className="tdd__mono">{task.parentTaskId}</dd>
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
                <dt>Claimed by</dt>
                <dd>{claimedByMe ? 'you' : claimedBy}</dd>
              </div>
            )}
          </dl>
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

// The cascading instruction set, with provenance summary + a teach control that
// lets the user pick the SCOPE (this task / a category / the project) to save a
// correction to — wired to the foundation resolver's scope model.
function InstructionSet({
  resolved,
  task,
  onTeach,
}: {
  resolved: ResolvedInstructions;
  task: Task;
  onTeach: (entry: {
    scopeKind: 'task' | 'category' | 'project';
    scopeLabel: string;
    text: string;
  }) => void;
}) {
  const [teaching, setTeaching] = useState(false);
  const [text, setText] = useState('');
  const cohorts = (task.flags ?? []).filter((f) => f.includes(':'));
  const [scope, setScope] = useState<'task' | 'category' | 'project'>('task');
  const [cohort, setCohort] = useState<string>(cohorts[0] ?? '');

  const save = () => {
    const t = text.trim();
    if (!t) {
      setTeaching(false);
      return;
    }
    onTeach({
      scopeKind: scope,
      scopeLabel: scope === 'category' ? cohort || 'category' : scope,
      text: t,
    });
    setText('');
    setTeaching(false);
  };

  return (
    <section className="tdd__sect">
      <div className="tdd__sect-h tdd__sect-h--row">
        <span>Instructions</span>
        <span className="tdd__prov" title="Effective instruction set across scopes">
          {resolved.total > 0 ? resolved.summary : 'none'}
        </span>
      </div>
      {resolved.rules.length === 0 ? (
        <p className="tdd__muted">No instructions resolved for this task’s scopes yet.</p>
      ) : (
        <ul className="tdd__rules">
          {resolved.rules.map((r, i) => (
            <li key={`${r.key}-${i}`} className="tdd__rule">
              <span className="tdd__rule-text">{r.text}</span>
              <span className={`tdd__rule-scope tdd__rule-scope--${r.scopeKind}`}>
                {r.scopeLabel}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!teaching ? (
        <button type="button" className="tdd__teach-open" onClick={() => setTeaching(true)}>
          + Teach
        </button>
      ) : (
        <div className="tdd__teach">
          <textarea
            className="tdd__teach-input"
            placeholder="Add a correction or rule the agent should follow…"
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setTeaching(false);
              }
            }}
          />
          <div className="tdd__teach-scope">
            <span className="tdd__teach-label">Save to</span>
            <select
              className="tdd__teach-select"
              value={scope}
              onChange={(e) => setScope(e.target.value as typeof scope)}
            >
              <option value="task">This task</option>
              {cohorts.length > 0 && <option value="category">A category</option>}
              {task.projectId && <option value="project">The project</option>}
            </select>
            {scope === 'category' && cohorts.length > 0 && (
              <select
                className="tdd__teach-select"
                value={cohort}
                onChange={(e) => setCohort(e.target.value)}
              >
                {cohorts.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
            <span className="tdd__teach-spacer" />
            <button type="button" className="tdd__btn tdd__btn--ghost" onClick={() => setTeaching(false)}>
              Cancel
            </button>
            <button type="button" className="tdd__btn" onClick={save}>
              Save
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ── SESSION ──────────────────────────────────────────────────────────────────
function SessionTab({
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
