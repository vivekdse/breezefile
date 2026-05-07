// fm-femh — Inline progress + cancel UI for runs initiated from the
// active folder tab. Renders as a thin banner directly above
// FolderList so the user sees progress at the click site, not just a
// toast in the corner.

import { useEffect, useState } from 'react';
import { fm } from '../bridge';
import {
  attachRunId,
  findUnlinkedByTaskId,
  useRunsForCwd,
  type RunEntry,
} from '../runProgress';
import { cancelTaskRun } from '../tasks';
import { formatOpError } from '../errorMessages';
import './RunProgressBanner.css';

export function RunProgressBanner({ cwd }: { cwd: string }) {
  // Pair backend-created run rows with our renderer-side placeholders.
  // One subscription is enough — every task-runs:changed event for any
  // taskId comes through here, and we look up our (single) unlinked
  // entry for that taskId. Mounting once at the banner is fine because
  // the banner is rendered for the active folder tab.
  useEffect(() => {
    const unsub = fm.onTaskRunsChanged(async (taskId: string) => {
      const entry = findUnlinkedByTaskId(taskId);
      if (!entry) return;
      try {
        const lastRun = await fm.tasksLastRun(taskId);
        if (
          lastRun &&
          lastRun.started_at &&
          lastRun.started_at >= entry.startedAt - 5000
        ) {
          attachRunId(entry.id, lastRun.id);
        }
      } catch {
        // best-effort linking; cancel button just stays disabled until
        // the next run-row event lets us try again.
      }
    });
    return unsub;
  }, []);

  const entries = useRunsForCwd(cwd);
  if (!entries.length) return null;
  return (
    <div className="run-progress" role="status" aria-live="polite">
      {entries.map((e) => (
        <RunProgressItem key={e.id} entry={e} />
      ))}
    </div>
  );
}

function RunProgressItem({ entry }: { entry: RunEntry }) {
  const [busy, setBusy] = useState(false);
  const onCancel = async () => {
    if (!entry.runId || busy) return;
    setBusy(true);
    try {
      await cancelTaskRun(entry.runId);
    } catch (e) {
      window.dispatchEvent(
        new CustomEvent('fm:setStatus', {
          detail: { msg: formatOpError('cancel', e) },
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="run-progress__item">
      <span className="run-progress__spinner" aria-hidden="true" />
      <span className="run-progress__title" title={entry.taskTitle}>
        Running: {entry.taskTitle}
      </span>
      <button
        type="button"
        className="run-progress__cancel"
        onClick={() => void onCancel()}
        disabled={!entry.runId || busy}
        title={
          !entry.runId
            ? 'Linking to run…'
            : busy
              ? 'Cancelling…'
              : 'Stop this run'
        }
      >
        {busy ? 'Cancelling…' : 'Cancel'}
      </button>
    </div>
  );
}
