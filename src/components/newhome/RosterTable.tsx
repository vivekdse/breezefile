// task-b9cdad64ab9c — STUB. Final prop contract; a follow-up task builds the
// real dense table (status pill, who glyph, custom-field columns per
// `template.columns`, row actions) per the V11 design reference.
import type { NewHomeStatus, NewHomeTask, TemplateConfig } from './types';
import './RosterTable.css';

export function RosterTable({
  tasks,
  filter,
  template,
  onOpenTask,
  onRetry,
}: {
  tasks: NewHomeTask[];
  filter: 'all' | NewHomeStatus;
  template: TemplateConfig;
  onOpenTask: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  return (
    <div className="nh-roster nh-stub">
      <div className="nh-stub__label">
        RosterTable (stub) · filter: {filter} · columns: {template.columns.join(', ')}
      </div>
      <table className="nh-roster__table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Status</th>
            <th>Who</th>
            <th>Last action</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tasks.length === 0 && (
            <tr>
              <td colSpan={5} className="nh-roster__empty">
                No tasks
              </td>
            </tr>
          )}
          {tasks.map((t) => (
            <tr key={t.id} onClick={() => onOpenTask(t.id)}>
              <td>{t.title}</td>
              <td>
                <span className={`nh-roster__pill nh-roster__pill--${t.status}`}>
                  {t.status}
                </span>
              </td>
              <td>{t.who}</td>
              <td>{t.lastAction}</td>
              <td>
                {t.status === 'failed' && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRetry(t.id);
                    }}
                  >
                    Retry
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
