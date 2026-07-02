// task-b9cdad64ab9c — STUB. Final prop contract; a follow-up task builds the
// real 4-up stat-card grid (done/progress/needs/failed) with the V11
// left-border color treatment.
import type { NewHomeStatus } from './types';
import './HeroStats.css';

const ORDER: NewHomeStatus[] = ['done', 'progress', 'needs', 'failed'];
const LABELS: Record<NewHomeStatus, string> = {
  done: 'Done',
  progress: 'In progress',
  needs: 'Needs you',
  failed: 'Failed',
};

export function HeroStats({
  counts,
  activeFilter,
  onFilter,
}: {
  counts: Record<NewHomeStatus, number>;
  activeFilter: 'all' | NewHomeStatus;
  onFilter: (f: 'all' | NewHomeStatus) => void;
}) {
  return (
    <div className="nh-hero-stats nh-stub">
      <div className="nh-stub__label">HeroStats (stub)</div>
      <div className="nh-hero-stats__grid">
        {ORDER.map((s) => (
          <button
            key={s}
            type="button"
            className={`nh-hero-stats__stat nh-hero-stats__stat--${s}${
              activeFilter === s ? ' nh-hero-stats__stat--active' : ''
            }`}
            onClick={() => onFilter(activeFilter === s ? 'all' : s)}
          >
            <div className="nh-hero-stats__label">{LABELS[s]}</div>
            <div className="nh-hero-stats__value">{counts[s]}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
