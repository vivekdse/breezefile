// task-b9cdad64ab9c — STUB. Final prop contract; a follow-up task builds the
// real field/column/approval-rule/step editor UI. This stub round-trips the
// config unchanged so Save/Close are wired end-to-end (NewHomePage persists
// via newHomePrefs.setTemplateConfig on save).
import type { TemplateConfig } from './types';
import './TemplateEditor.css';

export function TemplateEditor({
  projectId,
  config,
  onSave,
  onClose,
}: {
  projectId: string;
  config: TemplateConfig;
  onSave: (cfg: TemplateConfig) => void;
  onClose: () => void;
}) {
  return (
    <div className="nh-modal-overlay" onClick={onClose}>
      <div className="nh-template-editor nh-stub" onClick={(e) => e.stopPropagation()}>
        <div className="nh-modal__head">
          <div className="nh-stub__label">
            TemplateEditor (stub) · project: {projectId || 'unscoped'}
          </div>
          <button type="button" className="nh-modal__close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="nh-modal__body">
          <p>{config.fields.length} custom fields</p>
          <p>Columns: {config.columns.join(', ') || '(none)'}</p>
          <p>{config.approvalRules.length} approval rules</p>
          <p>{config.steps.length} steps</p>
        </div>
        <div className="nh-modal__footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => onSave(config)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
