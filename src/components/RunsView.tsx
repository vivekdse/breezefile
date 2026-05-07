// fm-zf3m — Cross-task Runs view rendered inside the Tasks page when
// the user toggles into "Runs" mode. Lists every recent run across
// every auto task (regardless of task status — including done /
// cancelled tasks that still have history) so the user has one place
// to scan past auto-task activity and jump into any individual run.
//
// Each row exposes:
//   - status pill + when + duration + attempt
//   - parent task title (clickable — opens that task's RunHistoryDialog)
//   - "Open run" → spawns a new tab with an embedded terminal at the
//     task folder and auto-runs `claude --resume <conversation_id>`
//     so the user lands directly in the headless trace inside Breeze.

import { useMemo, useState } from 'react';
import { useAllRuns } from '../tasks';
import type { TaskRunWithTitle } from '../types';
import { useOpenResumeInTab } from '../openResumeInTab';
import './RunsView.css';

function homeRel(p: string): string {
  if (!p) return '';
  const home =
    typeof window !== 'undefined' &&
    (window as unknown as { fm?: { home?: string } }).fm?.home;
  if (home && p === home) return '~';
  if (home && p.startsWith(home + '/')) return '~' + p.slice(home.length);
  const trimmed = p.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) || '/' : trimmed;
}

type StatusFilter =
  | 'all'
  | 'succeeded'
  | 'failed'
  | 'running'
  | 'queued'
  | 'cancelled';

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: 'All',
  succeeded: 'Succeeded',
  failed: 'Failed',
  running: 'Running',
  queued: 'Queued',
  cancelled: 'Cancelled',
};

export function RunsView() {
  const runs = useAllRuns(200);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return runs.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (q) {
        const hay = `${r.task_title} ${r.task_folder}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [runs, statusFilter, search]);

  return (
    <div className="runs-view">
      <div className="runs-view__filters">
        <div className="runs-view__chips" role="group" aria-label="Status">
          {(Object.keys(STATUS_LABEL) as StatusFilter[]).map((s) => (
            <button
              key={s}
              type="button"
              className={[
                'runs-view__chip',
                statusFilter === s && 'runs-view__chip--on',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => setStatusFilter(s)}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <input
          className="runs-view__search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by task title or folder…"
          aria-label="Filter runs"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="runs-view__empty">
          {runs.length === 0
            ? 'No auto-task runs yet. Once an auto task fires, every attempt shows up here.'
            : 'No runs match the current filter.'}
        </div>
      ) : (
        <ul className="runs-view__list" role="list">
          {filtered.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RunRow({ run }: { run: TaskRunWithTitle }) {
  const openResumeInTab = useOpenResumeInTab();
  const start = run.started_at ?? run.scheduled_for;
  const dur =
    run.finished_at && run.started_at
      ? `${((run.finished_at - run.started_at) / 1000).toFixed(1)}s`
      : null;

  const openHistory = () => {
    window.dispatchEvent(
      new CustomEvent('fm:openRunHistory', { detail: { taskId: run.task_id } }),
    );
  };

  const onOpenRun = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!run.conversation_id) return;
    void openResumeInTab(run.task_folder, run.conversation_id, run.task_title);
  };

  return (
    <li
      className={`runs-view__row runs-view__row--${run.status}`}
      onClick={openHistory}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openHistory();
        }
      }}
      title="Open run history for this task"
    >
      <div className="runs-view__row-head">
        <span className={`runs-view__status runs-view__status--${run.status}`}>
          {run.status}
        </span>
        <span className="runs-view__title">{run.task_title}</span>
        {run.task_folder && (
          <span className="runs-view__folder" title={run.task_folder}>
            {homeRel(run.task_folder)}
          </span>
        )}
        <span className="runs-view__when">
          {new Date(start).toLocaleString()}
        </span>
        {run.attempt > 1 && (
          <span className="runs-view__attempt">attempt {run.attempt}</span>
        )}
        {dur && <span className="runs-view__duration">{dur}</span>}
        {run.conversation_id && (
          <button
            type="button"
            className="runs-view__copy"
            onClick={onOpenRun}
            title="Open this run's trace in a new tab terminal"
          >
            Open run
          </button>
        )}
      </div>
      {run.error_message && (
        <div className="runs-view__error">
          {run.error_class && (
            <span className="runs-view__error-class">{run.error_class}</span>
          )}
          {run.error_message}
        </div>
      )}
    </li>
  );
}
