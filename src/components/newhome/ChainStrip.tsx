// task-c60ae2a41e71 — presentational step-sequence timeline for a task chain.
// Pure/stateless: it renders whatever `steps` it's given and reports clicks
// via `onStepClick`; callers own the underlying data (today: TemplateEditor's
// chain preview: a follow-up integration task wires this into the roster/
// dialog to show a real chain's live task statuses).
import './ChainStrip.css';

export type ChainStripStatus = 'pending' | 'progress' | 'needs' | 'done' | 'skipped' | 'failed';

export type ChainStripStep = {
  id: string;
  name: string;
  status: ChainStripStatus;
  humanGate: boolean;
};

function iconFor(status: ChainStripStatus): string {
  switch (status) {
    case 'done':
      return '✓'; // ✓
    case 'needs':
      return '⚠'; // ⚠
    case 'failed':
      return '✕'; // ✕
    case 'progress':
      return '●'; // ●
    case 'skipped':
      return '↷'; // ↷
    default:
      return '○'; // ○
  }
}

export function ChainStrip({
  steps,
  activeId,
  onStepClick,
}: {
  steps: ChainStripStep[];
  activeId?: string;
  onStepClick?: (id: string) => void;
}) {
  if (!steps.length) {
    return <div className="nh-chainstrip nh-chainstrip--empty">No steps yet.</div>;
  }

  return (
    <div className="nh-chainstrip" role="list">
      {steps.map((step, i) => (
        <div className="nh-chainstrip__item" role="listitem" key={step.id}>
          {i > 0 && (
            <div
              className={
                'nh-chainstrip__connector' +
                (steps[i - 1].status === 'done' ? ' nh-chainstrip__connector--done' : '')
              }
            />
          )}
          <button
            type="button"
            className={
              'nh-chainstrip__node' +
              ` nh-chainstrip__node--${step.status}` +
              (step.id === activeId ? ' nh-chainstrip__node--active' : '') +
              (onStepClick ? '' : ' nh-chainstrip__node--static')
            }
            disabled={!onStepClick}
            title={step.name}
            onClick={() => onStepClick?.(step.id)}
          >
            <span className="nh-chainstrip__icon" aria-hidden="true">
              {iconFor(step.status)}
            </span>
            <span className="nh-chainstrip__label">{step.name}</span>
            {step.humanGate && (
              <span className="nh-chainstrip__gate" title="Requires human approval" aria-hidden="true">
                {'\u{1F512}'}
              </span>
            )}
          </button>
        </div>
      ))}
    </div>
  );
}
