// fm-zf3m — Reusable task-state indicators used by Sidebar, TasksPage,
// and TaskShell so a task's status + auto-execute run state look the
// same wherever it appears. Two components:
//
//   <TaskStatusDot> — a colored circle keyed off task.status:
//     pending     → red    ●
//     in_progress → amber  ●
//     done        → green  ●
//     cancelled   → grey   ●
//
//   <TaskRunIndicator> — the auto-execute glyph + a short text pill
//     showing the most recent run's state (running/succeeded/failed/
//     queued/idle). Renders nothing when task.auto_mode is false.

import { useLastRun } from '../tasks';
import type { Task, TaskRun, TaskStatus } from '../types';
import './TaskIndicators.css';

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function TaskStatusDot({
  status,
  className = '',
}: {
  status: TaskStatus;
  className?: string;
}) {
  return (
    <span
      className={['task-dot', `task-dot--${status}`, className]
        .filter(Boolean)
        .join(' ')}
      role="img"
      aria-label={STATUS_LABEL[status]}
      title={STATUS_LABEL[status]}
    />
  );
}

/** Inline run-state for an auto-executable task. Returns null when
 *  task.auto_mode is false so callers can drop it next to other meta
 *  with no surrounding conditionals. When `onClick` is set, renders as
 *  a button so users can click straight into the run-history dialog. */
export function TaskRunIndicator({
  task,
  showPill = true,
  onClick,
}: {
  task: Task;
  showPill?: boolean;
  onClick?: () => void;
}) {
  // Subscribe only when auto is on; null subscriptions are inert.
  const lastRun = useLastRun(task.auto_mode ? task.id : null);
  if (!task.auto_mode) return null;
  const state = deriveRunState(task, lastRun);

  const className = `task-run-indicator task-run-indicator--${state.kind}${
    onClick ? ' task-run-indicator--clickable' : ''
  }`;
  const title = onClick ? `${state.label} · click for run history` : state.label;
  const inner = (
    <>
      <span
        className={`task-run-indicator__glyph task-run-indicator__glyph--${state.kind}`}
        aria-hidden="true"
      >
        {state.kind === 'running' ? '◴' : '⚡'}
      </span>
      {showPill && (
        <span className="task-run-indicator__pill">{state.short}</span>
      )}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        {inner}
      </button>
    );
  }
  return (
    <span className={className} title={title}>
      {inner}
    </span>
  );
}

export type RunStateKind =
  | 'running'
  | 'failed'
  | 'succeeded'
  | 'queued'
  | 'idle';

export type RunState = {
  kind: RunStateKind;
  short: string;
  label: string;
};

export function deriveRunState(task: Task, run: TaskRun | null): RunState {
  if (run?.status === 'running') {
    return { kind: 'running', short: 'running', label: 'Running now…' };
  }
  if (run?.status === 'queued' || run?.status === 'retrying') {
    return { kind: 'queued', short: 'queued', label: 'Queued for retry' };
  }
  if (run?.status === 'failed') {
    const summary = run.error_message ? run.error_message.slice(0, 80) : 'Run failed';
    return {
      kind: 'failed',
      short: `failed${run.attempt > 1 ? ` ×${run.attempt}` : ''}`,
      label: `${run.error_class ?? 'error'}: ${summary}`,
    };
  }
  // For recurring tasks, the user cares more about "when does it fire
  // next" than "when did it last run" — show next_run_at first if set.
  // For one-shot tasks (cron unset) we keep the "Xm ago" framing since
  // there is no next fire.
  if (run?.status === 'succeeded') {
    if (task.cron && task.next_run_at && task.next_run_at > Date.now()) {
      return {
        kind: 'idle',
        short: `next ${relTime(task.next_run_at)}`,
        label: `Last run succeeded ${relTime(
          run.finished_at ?? run.started_at ?? Date.now(),
        )} · next ${new Date(task.next_run_at).toLocaleString()}`,
      };
    }
    const when = run.finished_at ?? run.started_at ?? Date.now();
    return {
      kind: 'succeeded',
      short: relTime(when),
      label: `Last run succeeded ${relTime(when)}`,
    };
  }
  if (task.next_run_at && task.next_run_at > Date.now()) {
    return {
      kind: 'idle',
      short: `next ${relTime(task.next_run_at)}`,
      label: `Next run ${new Date(task.next_run_at).toLocaleString()}`,
    };
  }
  return { kind: 'idle', short: 'auto', label: 'Auto-execute enabled' };
}

export function relTime(ms: number): string {
  const delta = ms - Date.now();
  const abs = Math.abs(delta);
  const future = delta > 0;
  if (abs < 60_000) return future ? 'in <1m' : 'just now';
  if (abs < 3600_000) {
    const m = Math.round(abs / 60_000);
    return future ? `in ${m}m` : `${m}m ago`;
  }
  if (abs < 86_400_000) {
    const h = Math.round(abs / 3600_000);
    return future ? `in ${h}h` : `${h}h ago`;
  }
  const d = Math.round(abs / 86_400_000);
  return future ? `in ${d}d` : `${d}d ago`;
}
