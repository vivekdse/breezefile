// fm-b5at.8 — minimal cron picker for a remote task's LOCAL schedule overlay.
// Moved verbatim from the old TasksPage.tsx (fm-7909 split). A few presets
// cover the common cases; "Custom" exposes the raw 5-field cron. The cron
// validates main-process side on save (setOverlaySchedule throws on a bad
// expression); we surface that inline. PHI-free: only the opaque id + cron
// ever leave this modal. The body surfaces the important caveat: a cron-fired
// interactive session needs Breezefile open + signed in, and TypeBuild's 2h
// claim TTL means a session left at the approval gate too long can lose its
// claim.

import { useEffect, useState } from 'react';
import { formatOpError } from '../../errorMessages';
import type { RemoteSchedule, Task } from '../../types';

const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Daily · 9:00am', cron: '0 9 * * *' },
  { label: 'Weekdays · 9:00am', cron: '0 9 * * 1-5' },
  { label: 'Hourly', cron: '0 * * * *' },
];

export function ScheduleModal({
  task,
  current,
  onClose,
  onSave,
  onClear,
}: {
  task: Task;
  current?: RemoteSchedule;
  onClose: () => void;
  onSave: (cron: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const matchPreset = current
    ? CRON_PRESETS.find((p) => p.cron === current.cron)
    : undefined;
  const [mode, setMode] = useState<'preset' | 'custom'>(
    current && !matchPreset ? 'custom' : 'preset',
  );
  const [preset, setPreset] = useState<string>(
    matchPreset?.cron ?? CRON_PRESETS[0].cron,
  );
  const [custom, setCustom] = useState<string>(
    current && !matchPreset ? current.cron : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const cron = mode === 'preset' ? preset : custom.trim();

  async function save() {
    if (!cron) {
      setError('Enter a cron expression');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(cron);
    } catch (e) {
      setError(formatOpError('schedule', e));
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      await onClear();
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="tasks__modal-backdrop" onClick={onClose}>
      <div
        className="tasks__modal tasks__schedule-modal"
        role="dialog"
        aria-label="Schedule task"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tasks__modal-title">Schedule on a local cron</div>
        <div className="tasks__modal-body">
          This source has no scheduler, so TypeBuild fires it locally on the
          cron below. The run is interactive — TypeBuild must be open and
          signed in when it fires. Note: a session left at the approval gate
          past the 2h claim TTL can lose its claim.
        </div>

        <label className="tasks__schedule-row">
          <input
            type="radio"
            name="schedule-mode"
            checked={mode === 'preset'}
            onChange={() => setMode('preset')}
          />
          <select
            value={preset}
            disabled={mode !== 'preset'}
            onChange={(e) => setPreset(e.target.value)}
          >
            {CRON_PRESETS.map((p) => (
              <option key={p.cron} value={p.cron}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className="tasks__schedule-row">
          <input
            type="radio"
            name="schedule-mode"
            checked={mode === 'custom'}
            onChange={() => setMode('custom')}
          />
          <input
            type="text"
            className="tasks__schedule-cron"
            placeholder="Custom cron · e.g. 30 8 * * 1"
            value={custom}
            disabled={mode !== 'custom'}
            onChange={(e) => setCustom(e.target.value)}
            onFocus={() => setMode('custom')}
          />
        </label>

        {error && <div className="tasks__modal-error">{error}</div>}

        <div className="tasks__modal-actions">
          {current && (
            <button
              type="button"
              className="tasks__row-btn tasks__row-btn--text"
              onClick={() => void clear()}
              disabled={busy}
            >
              Clear schedule
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="tasks__row-btn tasks__row-btn--text"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="tasks__row-btn tasks__row-btn--done"
            onClick={() => void save()}
            disabled={busy}
          >
            {current ? 'Update' : 'Schedule'}
          </button>
        </div>
        <div className="tasks__modal-hint">Task: {task.title}</div>
      </div>
    </div>
  );
}
