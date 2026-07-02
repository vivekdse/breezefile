// task-b9cdad64ab9c — STUB. Final prop contract; a follow-up task builds the
// real centered dialog (meta grid, evidence/activity trail, pending-question
// answer form, attachments, footer actions) per the V11 design reference.
import type { NewHomeTask, TemplateConfig } from './types';
import './TaskDetailDialog.css';

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
  return (
    <div className="nh-dialog-backdrop" onClick={onClose}>
      <div className="nh-dialog nh-stub" onClick={(e) => e.stopPropagation()}>
        <div className="nh-dialog__head">
          <div>
            <div className="nh-stub__label">TaskDetailDialog (stub)</div>
            <div className="nh-dialog__title">{task?.title ?? taskId}</div>
          </div>
          <button type="button" className="nh-dialog__close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="nh-dialog__body">
          <p>Status: {task?.status ?? 'unknown'}</p>
          <p>Last action: {task?.lastAction ?? '—'}</p>
          {task?.pendingQuestion && (
            <p className="nh-dialog__question">
              Pending question: {task.pendingQuestion.text}
            </p>
          )}
          <p>Template columns: {template.columns.join(', ')}</p>
        </div>
        <div className="nh-dialog__footer">
          <button type="button" onClick={() => onResolved(taskId)}>
            Mark resolved (stub)
          </button>
        </div>
      </div>
    </div>
  );
}
