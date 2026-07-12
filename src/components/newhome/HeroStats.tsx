// task-cc9a4ef6f38a — HeroStats: the 4-up stat-card grid (spec §1) that
// drives the Project View's primary status filter. Each card is a toggle:
// clicking the active card resets the filter to 'all'; clicking any other
// card selects that status. Colors route through the shared --nh-* status
// vars (see .nh in NewHomePage.css) via the left-border treatment from the
// V11 design reference.
import type { NewHomeStatus } from './types';
import './HeroStats.css';

// task-c0edffef25c6 — 'cancelled' deliberately has no card here: the hero
// grid stays the 5-up done/progress/queued/needs/failed layout, and a
// cancelled task is reachable via "All" rather than its own stat/filter.
// LABELS must still be exhaustive over NewHomeStatus (the shared counts
// record carries a cancelled tally now), so it needs the entry even though
// ORDER never renders it.
const ORDER: NewHomeStatus[] = ['done', 'progress', 'queued', 'needs', 'failed'];
const LABELS: Record<NewHomeStatus, string> = {
  done: 'Done',
  progress: 'In Progress',
  queued: 'Queued',
  needs: 'Needs You',
  failed: 'Failed',
  cancelled: 'Cancelled',
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
    <div className="nh-hero-stats">
      <div className="nh-hero-stats__grid">
        {ORDER.map((s) => {
          const isActive = activeFilter === s;
          return (
            <button
              key={s}
              type="button"
              aria-pressed={isActive}
              className={`nh-hero-stats__stat nh-hero-stats__stat--${s}${
                isActive ? ' nh-hero-stats__stat--active' : ''
              }`}
              onClick={() => onFilter(isActive ? 'all' : s)}
            >
              <div className="nh-hero-stats__label">{LABELS[s]}</div>
              <div className="nh-hero-stats__value">{counts[s]}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
