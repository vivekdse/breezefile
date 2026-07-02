// task-b9cdad64ab9c — STUB. Final prop contract; a follow-up task builds the
// real outcomes rollup (grouped by status, short summaries per
// OutcomeSummary) per the V11 design reference's finished-work section.
import type { NewHomeTask } from './types';
import './OutcomesPanel.css';

export function OutcomesPanel({
  tasks,
  onOpenTask,
}: {
  tasks: NewHomeTask[];
  onOpenTask: (id: string) => void;
}) {
  return (
    <div className="nh-outcomes nh-stub">
      <div className="nh-stub__label">OutcomesPanel (stub)</div>
      <div className="nh-outcomes__title">Recent outcomes</div>
      {tasks.length === 0 ? (
        <div className="nh-outcomes__empty">Nothing finished yet</div>
      ) : (
        <ul className="nh-outcomes__list">
          {tasks.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => onOpenTask(t.id)}>
                <span className={`nh-outcomes__dot nh-outcomes__dot--${t.status}`} />
                {t.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
