// fm-zf3m — Run history dialog for an auto-executed task.
//
// Lists every run attempt with status, attempt number, timing, and
// (when present) the conversation id + a "Copy resume" button so the
// user can drop into the trace in their own terminal. Live: subscribes
// via useTaskRuns so a fresh run from the scheduler appears without a
// reopen.

import { useEffect, useState } from 'react';
import { useOverlayExit } from '../useOverlayExit';
import { useTaskRuns, getTask } from '../tasks';
import type { Task, TaskRun } from '../types';
import './RunHistoryDialog.css';

type Props = { taskId: string; onClose: () => void };

export function RunHistoryDialog({ taskId, onClose }: Props) {
  const { exit, state } = useOverlayExit(onClose);
  const runs = useTaskRuns(taskId);
  const [task, setTask] = useState<Task | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getTask(taskId).then((t) => {
      if (!cancelled) setTask(t);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  return (
    <div
      className="overlay run-history-overlay"
      data-state={state}
      onClick={exit}
      onKeyDown={(e) => e.key === 'Escape' && exit()}
    >
      <div
        className="overlay__box run-history"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-history-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="run-history__close"
          onClick={exit}
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>
        <div id="run-history-title" className="run-history__title">
          Run history
        </div>
        {task && <div className="run-history__subtitle">{task.title}</div>}

        {runs.length === 0 && (
          <div className="run-history__empty">
            No runs yet. The scheduler will create one on the next fire,
            or right-click the task to "Run now".
          </div>
        )}

        {runs.length > 0 && (
          <ul className="run-history__list">
            {runs.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RunRow({ run }: { run: TaskRun }) {
  const start = run.started_at ?? run.scheduled_for;
  const dur =
    run.finished_at && run.started_at
      ? `${((run.finished_at - run.started_at) / 1000).toFixed(1)}s`
      : null;

  const copyResume = async () => {
    if (!run.conversation_id) return;
    const cmd = `claude --resume ${run.conversation_id}`;
    try {
      await navigator.clipboard.writeText(cmd);
      window.dispatchEvent(
        new CustomEvent('fm:setStatus', { detail: { msg: `copied: ${cmd}` } }),
      );
    } catch {
      /* clipboard blocked — silent */
    }
  };

  return (
    <li className={`run-history__row run-history__row--${run.status}`}>
      <div className="run-history__row-head">
        <span className={`run-history__status run-history__status--${run.status}`}>
          {run.status}
        </span>
        <span className="run-history__when">
          {new Date(start).toLocaleString()}
        </span>
        {run.attempt > 1 && (
          <span className="run-history__attempt">attempt {run.attempt}</span>
        )}
        {dur && <span className="run-history__duration">{dur}</span>}
        {run.conversation_id && (
          <button
            type="button"
            className="run-history__copy"
            onClick={() => void copyResume()}
            title="Copy `claude --resume <id>` to clipboard"
          >
            Copy resume
          </button>
        )}
      </div>
      {run.error_message && (
        <div className="run-history__error">
          {run.error_class && (
            <span className="run-history__error-class">{run.error_class}</span>
          )}
          {run.error_message}
        </div>
      )}
      {run.output_path && (
        <div className="run-history__output-path" title="Logs directory">
          {run.output_path}
        </div>
      )}
    </li>
  );
}
