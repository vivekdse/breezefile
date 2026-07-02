// task-b9cdad64ab9c — STUB. Final prop contract; body is a placeholder for a
// follow-up task to fill in (expand/collapse summary bar + per-approval cards
// + bulk-approve row, per the V11 design reference).
import type { NewHomeTask } from './types';
import './ApprovalBar.css';

export function ApprovalBar({
  approvals,
  onOpenTask,
  onResolved,
}: {
  approvals: NewHomeTask[];
  onOpenTask: (id: string) => void;
  onResolved: (id: string) => void;
}) {
  if (approvals.length === 0) return null;
  return (
    <div className="nh-approval-bar nh-stub">
      <div className="nh-stub__label">ApprovalBar (stub)</div>
      <div className="nh-approval-bar__summary">
        {approvals.length} task{approvals.length === 1 ? '' : 's'} waiting on you
      </div>
      <ul className="nh-approval-bar__list">
        {approvals.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => onOpenTask(t.id)}>
              {t.title}
            </button>
            <button type="button" onClick={() => onResolved(t.id)} title="stub — no-op">
              (resolve)
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
